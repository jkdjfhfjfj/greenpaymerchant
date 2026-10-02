import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  ConvertMerchantWalletFundsResponse,
  GetMerchantWalletFxQuoteResponse,
} from "@workspace/api-zod";
import {
  db, feeSchedulesTable, merchantWalletsTable, merchantsTable, pool,
  verificationTierLimitsTable, walletConversionsTable, walletFxRatesTable,
  walletJournalEntriesTable, walletJournalsTable,
} from "@workspace/db";
import { convertWalletFunds, quoteWalletConversion } from "./wallet-service";

after(async () => {
  await pool.end();
});

async function provisionConversionLimit(): Promise<() => Promise<void>> {
  const [existing] = await db.select().from(verificationTierLimitsTable).where(and(
    eq(verificationTierLimitsTable.tier, "kyb"),
    eq(verificationTierLimitsTable.currency, "USD"),
  )).limit(1);
  if (existing) {
    if (existing.conversionLimit === null || existing.conversionLimit >= 10) return async () => undefined;
    await db.update(verificationTierLimitsTable)
      .set({ conversionLimit: 100_000 })
      .where(eq(verificationTierLimitsTable.id, existing.id));
    return async () => {
      await db.update(verificationTierLimitsTable)
        .set({ conversionLimit: existing.conversionLimit })
        .where(eq(verificationTierLimitsTable.id, existing.id));
    };
  }
  const [created] = await db.insert(verificationTierLimitsTable).values({
    tier: "kyb",
    currency: "USD",
    conversionLimit: 100_000,
  }).onConflictDoNothing().returning();
  if (!created) throw new Error("Could not provision a wallet conversion verification limit.");
  return async () => {
    await db.delete(verificationTierLimitsTable)
      .where(eq(verificationTierLimitsTable.id, created.id));
  };
}

test("wallet conversion atomically updates balances and posts balanced, replay-safe journals", async () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = `wallet-conversion-test-${randomUUID()}`;
  const token = randomUUID();
  let merchantId: number | undefined;
  let restoreLimit: (() => Promise<void>) | undefined;
  let previousRate: typeof walletFxRatesTable.$inferSelect | undefined;
  let testRateId: number | undefined;
  try {
    restoreLimit = await provisionConversionLimit();
    const [merchant] = await db.insert(merchantsTable).values({
      ownerClerkId: `wallet-conversion-test-${token}`,
      businessName: "Wallet conversion fixture",
      country: "KE",
      baseCurrency: "USD",
      status: "active",
      kycStatus: "approved",
      kybStatus: "approved",
    }).returning();
    if (!merchant) throw new Error("Could not create a wallet conversion merchant fixture.");
    merchantId = merchant.id;

    const now = new Date();
    const sourceDate = now.toISOString().slice(0, 10);
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
    const [existingRate] = await db.select().from(walletFxRatesTable).where(and(
      eq(walletFxRatesTable.fromCurrency, "USD"),
      eq(walletFxRatesTable.toCurrency, "NGN"),
      eq(walletFxRatesTable.sourceDate, sourceDate),
    )).limit(1);
    previousRate = existingRate;
    const [rate] = await db.insert(walletFxRatesTable).values({
      fromCurrency: "USD",
      toCurrency: "NGN",
      rate: 2,
      source: `wallet conversion test ${token}`,
      sourceDate,
      fetchedAt: now,
      expiresAt,
    }).onConflictDoUpdate({
      target: [
        walletFxRatesTable.fromCurrency,
        walletFxRatesTable.toCurrency,
        walletFxRatesTable.sourceDate,
      ],
      set: {
        rate: 2,
        source: `wallet conversion test ${token}`,
        fetchedAt: now,
        expiresAt,
      },
    }).returning();
    if (!rate) throw new Error("Could not create a wallet conversion rate fixture.");
    testRateId = rate.id;

    await db.insert(feeSchedulesTable).values({
      merchantId,
      percentage: 1.25,
      flatAmount: 1,
      currency: "NGN",
      fxMarkupBps: 25,
    });
    await db.insert(merchantWalletsTable).values([
      { merchantId, currency: "USD", availableMinor: 1_000n, reservedMinor: 0n },
      { merchantId, currency: "NGN", availableMinor: 0n, reservedMinor: 0n },
    ]);

    const idempotencyKey = `wallet-conversion-${token}`;
    const quote = GetMerchantWalletFxQuoteResponse.parse(await quoteWalletConversion(merchantId, {
      amount: 10,
      fromCurrency: "USD",
      toCurrency: "NGN",
      idempotencyKey,
    }));
    const conversionInput = {
      amount: 10,
      fromCurrency: "USD",
      toCurrency: "NGN",
      idempotencyKey,
      quoteId: quote.quoteId,
    };
    const conversion = ConvertMerchantWalletFundsResponse.parse(
      await convertWalletFunds(merchantId, conversionInput),
    );

    assert.equal(conversion.sourceAmount, 10);
    assert.equal(
      Math.round((conversion.systemMarginAmount + conversion.scheduleMarkupAmount +
        conversion.feeAmount + conversion.targetAmount) * 100),
      Math.round(conversion.marketTargetAmount * 100),
    );

    const walletRows = await db.select().from(merchantWalletsTable)
      .where(eq(merchantWalletsTable.merchantId, merchantId));
    assert.equal(walletRows.find((wallet) => wallet.currency === "USD")?.availableMinor, 0n);
    assert.equal(
      walletRows.find((wallet) => wallet.currency === "NGN")?.availableMinor,
      BigInt(Math.round(conversion.targetAmount * 100)),
    );

    const journals = await db.select().from(walletJournalsTable).where(and(
      eq(walletJournalsTable.merchantId, merchantId),
      eq(walletJournalsTable.reference, `conversion:${conversion.id}`),
    ));
    assert.equal(journals.length, 2);
    const journalEntries = await db.select().from(walletJournalEntriesTable).where(inArray(
      walletJournalEntriesTable.journalId,
      journals.map((journal) => journal.id),
    ));
    for (const journal of journals) {
      const entries = journalEntries.filter((entry) => entry.journalId === journal.id);
      const debits = entries.filter((entry) => entry.direction === "debit")
        .reduce((sum, entry) => sum + entry.amountMinor, 0n);
      const credits = entries.filter((entry) => entry.direction === "credit")
        .reduce((sum, entry) => sum + entry.amountMinor, 0n);
      assert.equal(debits, credits);
    }
    const targetJournal = journals.find((journal) => journal.currency === "NGN");
    assert.ok(targetJournal);
    const targetEntries = journalEntries.filter((entry) => entry.journalId === targetJournal.id);
    assert.equal(
      targetEntries.find((entry) => entry.account === "platform_fx_revenue")?.amountMinor,
      BigInt(Math.round(conversion.totalMarkupAmount * 100)),
    );
    assert.equal(
      targetEntries.find((entry) => entry.account === "platform_fee_revenue")?.amountMinor,
      BigInt(Math.round(conversion.feeAmount * 100)),
    );

    const replay = ConvertMerchantWalletFundsResponse.parse(
      await convertWalletFunds(merchantId, conversionInput),
    );
    assert.equal(replay.id, conversion.id);
    assert.equal((await db.select().from(walletJournalsTable)
      .where(eq(walletJournalsTable.merchantId, merchantId))).length, 2);
  } finally {
    if (merchantId !== undefined) {
      const conversions = await db.select({ id: walletConversionsTable.id })
        .from(walletConversionsTable).where(eq(walletConversionsTable.merchantId, merchantId));
      if (conversions.length) await db.delete(walletConversionsTable)
        .where(eq(walletConversionsTable.merchantId, merchantId));
      const journals = await db.select({ id: walletJournalsTable.id })
        .from(walletJournalsTable).where(eq(walletJournalsTable.merchantId, merchantId));
      if (journals.length) {
        await db.delete(walletJournalEntriesTable).where(inArray(
          walletJournalEntriesTable.journalId,
          journals.map(({ id }) => id),
        ));
        await db.delete(walletJournalsTable).where(eq(walletJournalsTable.merchantId, merchantId));
      }
      await db.delete(merchantWalletsTable).where(eq(merchantWalletsTable.merchantId, merchantId));
      await db.delete(feeSchedulesTable).where(eq(feeSchedulesTable.merchantId, merchantId));
      await db.delete(merchantsTable).where(eq(merchantsTable.id, merchantId));
    }
    if (testRateId !== undefined) {
      if (previousRate) {
        await db.update(walletFxRatesTable).set({
          rate: previousRate.rate,
          source: previousRate.source,
          fetchedAt: previousRate.fetchedAt,
          expiresAt: previousRate.expiresAt,
        }).where(eq(walletFxRatesTable.id, testRateId));
      } else {
        await db.delete(walletFxRatesTable).where(eq(walletFxRatesTable.id, testRateId));
      }
    }
    if (restoreLimit) await restoreLimit();
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});