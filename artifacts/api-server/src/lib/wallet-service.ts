import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  adminAuditLogTable, db, feeSchedulesTable, merchantsTable, merchantWalletsTable,
  refundsTable, settlementsTable, transactionsTable, walletConversionsTable,
  walletFxRatesTable, walletJournalEntriesTable, walletJournalsTable,
  walletPayoutRequestsTable, walletSettlementConfirmationsTable, walletRefundAdjustmentsTable,
  type MerchantWalletRecord, type WalletPayoutRequestRecord,
} from "@workspace/db";
import {
  ApiError, asObject, assertSupportedCurrency, numberValue, payzaApiRequest,
  payzaPayoutMethods, providerIsConfigured, stringValue,
} from "./greenpay-provider";
import { assertMerchantMayPayout, assertPlatformEnabled, enforceVerificationLimit } from "./platform";
import { CUSTOMER_REIMBURSED_REFUND_STATUSES, OPEN_REFUND_RESERVATION_STATUSES } from "./payment-safety";
import {
  calculateWalletConversion, canApplyWalletRefundAdjustment, canReserveWalletFunds,
  decimalToMinor, eligibleSettlementFunding, minorToDecimal, minorToNumber,
  payoutProviderOutcome, proportionalNetRefundReversal, shouldReleasePayoutHold,
} from "./wallet-math";

const RATE_SOURCE = "Fawaz Ahmed currency-api daily ISO-currency reference rates (jsDelivr/GitHub mirrors; target units per one source unit)";
const FX_CACHE_MS = 6 * 60 * 60 * 1000;
const FX_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const SLL_FX_UNSUPPORTED_ERROR =
  "FX quotes involving SLL are disabled until Payzaapi's legacy SLL amount scale is verified; Greenpay keeps SLL balances and payment-link amounts unchanged and never substitutes SLE rates.";

type FinancialTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function cryptoKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) throw new ApiError(503, "Secure wallet destination storage is unavailable until SESSION_SECRET is configured.");
  return Buffer.from(hkdfSync(
    "sha256", Buffer.from(secret, "utf8"),
    Buffer.from("greenpay-wallet-destination"),
    Buffer.from("AES-256-GCM"), 32,
  ));
}

function encryptDestination(value: Record<string, string | null>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptDestination(value: string): Record<string, string> {
  const [iv, tag, ciphertext] = value.split(".");
  if (!iv || !tag || !ciphertext) throw new ApiError(503, "Stored payout destination is invalid.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", cryptoKey(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const decoded: unknown = JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final(),
    ]).toString("utf8"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid destination");
    return decoded as Record<string, string>;
  } catch {
    throw new ApiError(503, "Stored payout destination could not be decrypted with SESSION_SECRET.");
  }
}

function destinationFingerprint(value: Record<string, string | null>): string {
  return createHmac("sha256", cryptoKey()).update(JSON.stringify(value)).digest("hex");
}

function maskDestinationName(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.map((word) => `${word[0]}${"•".repeat(Math.max(2, Math.min(6, word.length - 1)))}`).join(" ");
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourcePublicationDateIsFresh(sourceDate: string | undefined, now: Date): boolean {
  if (!sourceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) return false;
  const sourceDay = new Date(`${sourceDate}T00:00:00.000Z`);
  return !Number.isNaN(sourceDay.getTime()) &&
    sourceDay.toISOString().slice(0, 10) === sourceDate &&
    sourceDay.getTime() <= now.getTime() + 60_000 &&
    now.getTime() - sourceDay.getTime() <= FX_MAX_AGE_MS;
}

function userAmountToMinor(value: number): bigint {
  try {
    return decimalToMinor(value);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Enter a valid amount with up to two decimal places.");
  }
}

function assertWalletFxPairAllowed(fromCurrency: string, toCurrency: string): void {
  assertSupportedCurrency(fromCurrency);
  assertSupportedCurrency(toCurrency);
  if (fromCurrency === "SLL" || toCurrency === "SLL") {
    throw new ApiError(422, SLL_FX_UNSUPPORTED_ERROR);
  }
  if (fromCurrency === toCurrency) {
    throw new ApiError(400, "Choose two different currencies for an internal conversion.");
  }
}

function walletAccountDto(row: MerchantWalletRecord) {
  return {
    currency: row.currency,
    availableBalance: minorToNumber(row.availableMinor),
    reservedBalance: minorToNumber(row.reservedMinor),
    updatedAt: row.updatedAt,
  };
}

export function walletPayoutRequestDto(row: WalletPayoutRequestRecord) {
  return {
    id: row.id,
    reference: row.reference,
    merchantId: row.merchantId,
    amount: minorToNumber(row.amountMinor),
    fee: minorToNumber(row.feeMinor),
    netAmount: minorToNumber(row.amountMinor),
    currency: row.currency,
    method: row.method,
    accountName: row.accountName,
    maskedAccount: row.maskedAccount,
    status: row.status,
    providerReference: row.providerReference,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function lockWallet(tx: FinancialTx, merchantId: number, currency: string) {
  const normalized = currency.toUpperCase();
  await tx.insert(merchantWalletsTable).values({
    merchantId, currency: normalized,
  }).onConflictDoNothing();
  const [wallet] = await tx.select().from(merchantWalletsTable).where(and(
    eq(merchantWalletsTable.merchantId, merchantId),
    eq(merchantWalletsTable.currency, normalized),
  )).for("update").limit(1);
  if (!wallet) throw new ApiError(503, "Merchant wallet could not be locked safely.");
  return wallet;
}

async function postJournal(tx: FinancialTx, input: {
  merchantId: number;
  currency: string;
  kind: string;
  reference: string;
  sourceReference?: string | null;
  evidenceReference?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  merchantAccount: "merchant_available" | "merchant_reserved";
  merchantDirection: "debit" | "credit";
  externalAccount?: "platform_settlement" | "platform_payout" | "fx_clearing";
  secondMerchantAccount?: "merchant_available" | "merchant_reserved";
}) {
  const [journal] = await tx.insert(walletJournalsTable).values({
    merchantId: input.merchantId,
    currency: input.currency.toUpperCase(),
    kind: input.kind,
    reference: input.reference,
    sourceReference: input.sourceReference ?? null,
    evidenceReference: input.evidenceReference ?? null,
    idempotencyKey: input.idempotencyKey,
    requestHash: requestHash({
      merchantId: input.merchantId, currency: input.currency.toUpperCase(), kind: input.kind,
      reference: input.reference, sourceReference: input.sourceReference ?? null,
      evidenceReference: input.evidenceReference ?? null, metadata: input.metadata ?? {},
      merchantAccount: input.merchantAccount, merchantDirection: input.merchantDirection,
      externalAccount: input.externalAccount, secondMerchantAccount: input.secondMerchantAccount,
    }),
    metadata: input.metadata ?? {},
  }).onConflictDoNothing().returning();
  if (!journal) throw new ApiError(409, "This wallet journal action has already been posted.");
  const amountMinor = BigInt(String(input.metadata?.amountMinor ?? "0"));
  if (amountMinor <= 0n) throw new ApiError(500, "Wallet journal amount must be positive.");
  const otherDirection = input.merchantDirection === "credit" ? "debit" : "credit";
  const entries: (typeof walletJournalEntriesTable.$inferInsert)[] = [{
    journalId: journal.id,
    merchantId: input.merchantId,
    currency: input.currency.toUpperCase(),
    account: input.merchantAccount,
    direction: input.merchantDirection,
    amountMinor,
  }];
  if (input.secondMerchantAccount) {
    entries.push({
      journalId: journal.id,
      merchantId: input.merchantId,
      currency: input.currency.toUpperCase(),
      account: input.secondMerchantAccount,
      direction: otherDirection,
      amountMinor,
    });
  } else if (input.externalAccount) {
    entries.push({
      journalId: journal.id,
      merchantId: null,
      currency: input.currency.toUpperCase(),
      account: input.externalAccount,
      direction: otherDirection,
      amountMinor,
    });
  } else {
    throw new ApiError(500, "Wallet journal counter-account is required.");
  }
  await tx.insert(walletJournalEntriesTable).values(entries);
  return journal;
}

export async function listMerchantWallets(merchantId: number) {
  const [merchant] = await db.select({ baseCurrency: merchantsTable.baseCurrency }).from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) throw new ApiError(404, "Merchant account not found.");
  await db.insert(merchantWalletsTable).values({
    merchantId, currency: merchant.baseCurrency,
  }).onConflictDoNothing();
  const rows = await db.select().from(merchantWalletsTable)
    .where(eq(merchantWalletsTable.merchantId, merchantId))
    .orderBy(merchantWalletsTable.currency);
  return rows.map(walletAccountDto);
}

export async function listAdminWallets() {
  const rows = await db.select({
    merchantId: merchantWalletsTable.merchantId,
    businessName: merchantsTable.businessName,
    currency: merchantWalletsTable.currency,
    availableMinor: merchantWalletsTable.availableMinor,
    reservedMinor: merchantWalletsTable.reservedMinor,
    updatedAt: merchantWalletsTable.updatedAt,
  }).from(merchantWalletsTable)
    .innerJoin(merchantsTable, eq(merchantWalletsTable.merchantId, merchantsTable.id))
    .orderBy(merchantWalletsTable.merchantId, merchantWalletsTable.currency);
  return rows.map((row) => ({
    merchantId: row.merchantId,
    businessName: row.businessName,
    currency: row.currency,
    availableBalance: minorToNumber(row.availableMinor),
    reservedBalance: minorToNumber(row.reservedMinor),
    updatedAt: row.updatedAt,
  }));
}

export async function listWalletLedger(merchantId: number, currency?: string) {
  const conditions = [eq(walletJournalsTable.merchantId, merchantId)];
  if (currency) conditions.push(eq(walletJournalsTable.currency, currency.toUpperCase()));
  const journals = await db.select().from(walletJournalsTable)
    .where(and(...conditions)).orderBy(desc(walletJournalsTable.createdAt)).limit(500);
  const result = [];
  for (const journal of journals) {
    const entries = await db.select().from(walletJournalEntriesTable).where(and(
      eq(walletJournalEntriesTable.journalId, journal.id),
      eq(walletJournalEntriesTable.merchantId, merchantId),
    ));
    for (const entry of entries) {
      result.push({
        id: entry.id,
        currency: entry.currency,
        amount: minorToNumber(entry.amountMinor),
        direction: entry.direction,
        kind: journal.kind,
        reference: journal.reference,
        evidenceReference: journal.evidenceReference,
        createdAt: journal.createdAt,
      });
    }
  }
  return result;
}

async function getMarketRate(fromCurrency: string, toCurrency: string) {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  assertWalletFxPairAllowed(from, to);
  const now = new Date();
  const [cached] = await db.select().from(walletFxRatesTable).where(and(
    eq(walletFxRatesTable.fromCurrency, from),
    eq(walletFxRatesTable.toCurrency, to),
    gte(walletFxRatesTable.expiresAt, now),
  )).orderBy(desc(walletFxRatesTable.fetchedAt)).limit(1);
  if (cached && sourcePublicationDateIsFresh(cached.sourceDate, now)) return {
    rate: String(cached.rate), source: cached.source, sourceDate: cached.sourceDate,
    fetchedAt: cached.fetchedAt, expiresAt: cached.expiresAt,
  };

  try {
    const baseCode = from.toLowerCase();
    const targetCode = to.toLowerCase();
    const endpoints = [
      `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${baseCode}.json`,
      `https://raw.githubusercontent.com/fawazahmed0/currency-api/latest/v1/currencies/${baseCode}.json`,
    ];
    let body: Record<string, unknown> | undefined;
    let lastFailure: unknown;
    for (const url of endpoints) {
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) throw new Error(`Currency reference source responded with ${response.status}.`);
        body = asObject(await response.json());
        break;
      } catch (error) {
        lastFailure = error;
      }
    }
    if (!body) throw lastFailure ?? new Error("Currency reference sources are unavailable.");
    const sourceDate = stringValue(body.date);
    const rates = asObject(body[baseCode]);
    const rawRate = numberValue(rates[targetCode]);
    if (!sourceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) {
      throw new Error("Currency reference source returned a missing or invalid publication date.");
    }
    const sourceDay = new Date(`${sourceDate}T00:00:00.000Z`);
    if (Number.isNaN(sourceDay.getTime()) || sourceDay.toISOString().slice(0, 10) !== sourceDate ||
        sourceDay.getTime() > now.getTime() + 60_000) {
      throw new Error("Currency reference source returned an invalid or future publication date.");
    }
    if (now.getTime() - sourceDay.getTime() > FX_MAX_AGE_MS) {
      throw new Error("Currency reference rate publication date is stale.");
    }
    if (rawRate === undefined || !Number.isFinite(rawRate) || rawRate <= 0) {
      throw new Error("Currency reference source returned an invalid ISO-currency unit rate.");
    }
    const fetchedAt = now;
    const expiresAt = new Date(now.getTime() + FX_CACHE_MS);
    await db.insert(walletFxRatesTable).values({
      fromCurrency: from, toCurrency: to, rate: rawRate, source: RATE_SOURCE,
      sourceDate, fetchedAt, expiresAt,
    }).onConflictDoUpdate({
      target: [
        walletFxRatesTable.fromCurrency,
        walletFxRatesTable.toCurrency,
        walletFxRatesTable.sourceDate,
      ],
      set: { rate: rawRate, source: RATE_SOURCE, fetchedAt, expiresAt },
    });
    const [rateRow] = await db.select().from(walletFxRatesTable).where(and(
      eq(walletFxRatesTable.fromCurrency, from),
      eq(walletFxRatesTable.toCurrency, to),
      eq(walletFxRatesTable.sourceDate, sourceDate),
    )).limit(1);
    if (!rateRow || rateRow.expiresAt < now) throw new Error("Frankfurter rate cache did not persist.");
    return {
      rate: String(rateRow.rate), source: rateRow.source, sourceDate: rateRow.sourceDate,
      fetchedAt: rateRow.fetchedAt, expiresAt: rateRow.expiresAt,
    };
  } catch (error) {
    throw new ApiError(503, error instanceof Error && error.message.includes("stale")
      ? "The public currency-reference rate is stale. Wallet conversion is unavailable until a fresh rate is published."
      : "The public currency-reference API is unavailable or returned an invalid rate, and no fresh cached rate can be used.");
  }
}

async function getWalletFeeSchedule(merchantId: number) {
  const [specific] = await db.select().from(feeSchedulesTable)
    .where(eq(feeSchedulesTable.merchantId, merchantId)).limit(1);
  const [global] = specific ? [] : await db.select().from(feeSchedulesTable)
    .where(isNull(feeSchedulesTable.merchantId)).limit(1);
  return specific ?? global ?? null;
}

export async function quoteWalletConversion(merchantId: number, input: {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
}) {
  const fromCurrency = input.fromCurrency.toUpperCase();
  const toCurrency = input.toCurrency.toUpperCase();
  const sourceMinor = userAmountToMinor(input.amount);
  assertWalletFxPairAllowed(fromCurrency, toCurrency);
  if (sourceMinor <= 0n) throw new ApiError(400, "Enter an amount greater than zero.");
  const rate = await getMarketRate(fromCurrency, toCurrency);
  const schedule = await getWalletFeeSchedule(merchantId);
  const flatCurrency = schedule?.currency.toUpperCase();
  if (schedule && Number(schedule.flatAmount) > 0 && flatCurrency !== toCurrency) {
    throw new ApiError(409, `The active fee schedule flat fee is denominated in ${flatCurrency}; this quote cannot safely apply it.`);
  }
  const flatFeeMinor = schedule ? decimalToMinor(schedule.flatAmount) : 0n;
  const calculation = calculateWalletConversion({
    sourceMinor, sourceRate: rate.rate, markupBps: schedule?.fxMarkupBps ?? 0,
    feePercentage: schedule ? String(schedule.percentage) : "0", flatFeeMinor,
  });
  const now = new Date();
  if (rate.expiresAt <= now) throw new ApiError(503, "The public market rate expired before a quote could be issued.");
  return {
    quoteId: randomUUID(),
    fromCurrency,
    toCurrency,
    sourceAmount: minorToNumber(sourceMinor),
    sourceRate: Number(rate.rate),
    effectiveRate: Number(calculation.effectiveRateScaled) / 1_000_000_000_000,
    feeAmount: minorToNumber(calculation.feeMinor),
    targetAmount: minorToNumber(calculation.targetMinor),
    markupBps: schedule?.fxMarkupBps ?? 0,
    source: rate.source,
    quotedAt: rate.fetchedAt,
    expiresAt: rate.expiresAt,
    note: "Internal wallet allocation only. This does not execute external bank FX or represent provider liquidity.",
    sourceMinor,
    targetMinor: calculation.targetMinor,
    feeMinor: calculation.feeMinor,
    schedule,
    rateSourceDate: rate.sourceDate,
  };
}

export async function convertWalletFunds(merchantId: number, input: {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  idempotencyKey: string;
}) {
  const fromCurrency = input.fromCurrency.toUpperCase();
  const toCurrency = input.toCurrency.toUpperCase();
  assertWalletFxPairAllowed(fromCurrency, toCurrency);
  const sourceMinor = userAmountToMinor(input.amount);
  const fingerprint = requestHash({ amountMinor: sourceMinor.toString(), fromCurrency, toCurrency });
  const [prior] = await db.select().from(walletConversionsTable).where(and(
    eq(walletConversionsTable.merchantId, merchantId),
    eq(walletConversionsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.requestHash !== fingerprint) {
      throw new ApiError(409, "This wallet conversion idempotency key was used for different conversion details.");
    }
    return walletConversionDto(prior);
  }
  const quote = await quoteWalletConversion(merchantId, input);
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(walletConversionsTable).where(and(
      eq(walletConversionsTable.merchantId, merchantId),
      eq(walletConversionsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (existing) {
      if (existing.requestHash !== fingerprint) throw new ApiError(409, "This wallet conversion idempotency key was used for different conversion details.");
      return walletConversionDto(existing);
    }
    const currencies = [fromCurrency, toCurrency].sort();
    const wallets = new Map<string, MerchantWalletRecord>();
    for (const currency of currencies) wallets.set(currency, await lockWallet(tx, merchantId, currency));
    const [concurrent] = await tx.select().from(walletConversionsTable).where(and(
      eq(walletConversionsTable.merchantId, merchantId),
      eq(walletConversionsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (concurrent) {
      if (concurrent.requestHash !== fingerprint) {
        throw new ApiError(409, "This wallet conversion idempotency key was used for different conversion details.");
      }
      return walletConversionDto(concurrent);
    }
    const sourceWallet = wallets.get(fromCurrency)!;
    const targetWallet = wallets.get(toCurrency)!;
    await enforceVerificationLimit(
      tx, merchantId, "conversion", minorToNumber(quote.sourceMinor), fromCurrency,
    );
    if (!canReserveWalletFunds(sourceWallet.availableMinor, quote.sourceMinor)) {
      throw new ApiError(409, `Available ${fromCurrency} wallet funds are insufficient for this conversion.`);
    }
    const [conversion] = await tx.insert(walletConversionsTable).values({
      merchantId,
      idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint,
      fromCurrency,
      toCurrency,
      sourceMinor: quote.sourceMinor,
      targetMinor: quote.targetMinor,
      feeMinor: quote.feeMinor,
      sourceRate: Number(quote.sourceRate),
      effectiveRate: Number(quote.effectiveRate),
      markupBps: quote.markupBps,
      feeScheduleId: quote.schedule?.id ?? null,
      rateSource: quote.source,
      rateSourceDate: quote.rateSourceDate,
      rateFetchedAt: quote.quotedAt,
    }).returning();
    if (!conversion) throw new ApiError(503, "Wallet conversion could not be persisted.");

    await tx.update(merchantWalletsTable).set({
      availableMinor: sourceWallet.availableMinor - quote.sourceMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, sourceWallet.id));
    await tx.update(merchantWalletsTable).set({
      availableMinor: targetWallet.availableMinor + quote.targetMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, targetWallet.id));
    await postJournal(tx, {
      merchantId, currency: fromCurrency, kind: "conversion", reference: `conversion:${conversion.id}`,
      sourceReference: String(conversion.id), idempotencyKey: `conversion:${conversion.id}:debit`,
      metadata: { amountMinor: quote.sourceMinor.toString(), allocationType: "internal_wallet_allocation" },
      merchantAccount: "merchant_available", merchantDirection: "debit", externalAccount: "fx_clearing",
    });
    await postJournal(tx, {
      merchantId, currency: toCurrency, kind: "conversion", reference: `conversion:${conversion.id}`,
      sourceReference: String(conversion.id), idempotencyKey: `conversion:${conversion.id}:credit`,
      metadata: { amountMinor: quote.targetMinor.toString(), allocationType: "internal_wallet_allocation" },
      merchantAccount: "merchant_available", merchantDirection: "credit", externalAccount: "fx_clearing",
    });
    return walletConversionDto(conversion);
  });
}

function walletConversionDto(row: typeof walletConversionsTable.$inferSelect) {
  return {
    id: row.id,
    quoteId: `conversion:${row.id}`,
    fromCurrency: row.fromCurrency,
    toCurrency: row.toCurrency,
    sourceAmount: minorToNumber(row.sourceMinor),
    sourceRate: Number(row.sourceRate),
    effectiveRate: Number(row.effectiveRate),
    feeAmount: minorToNumber(row.feeMinor),
    targetAmount: minorToNumber(row.targetMinor),
    markupBps: row.markupBps,
    source: row.rateSource,
    quotedAt: row.rateFetchedAt,
    expiresAt: row.rateFetchedAt,
    note: "Internal wallet allocation only. This does not execute external bank FX or represent provider liquidity.",
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt,
    allocationType: "internal_wallet_allocation" as const,
  };
}

export async function listMerchantPayoutRequests(merchantId: number) {
  const rows = await db.select().from(walletPayoutRequestsTable)
    .where(eq(walletPayoutRequestsTable.merchantId, merchantId))
    .orderBy(desc(walletPayoutRequestsTable.createdAt)).limit(500);
  return rows.map(walletPayoutRequestDto);
}

export async function listAdminPayoutRequests(status?: string) {
  const rows = await db.select().from(walletPayoutRequestsTable)
    .where(status ? eq(walletPayoutRequestsTable.status, status) : undefined)
    .orderBy(desc(walletPayoutRequestsTable.createdAt)).limit(1000);
  return rows.map(walletPayoutRequestDto);
}

export async function walletPayoutMethods(currency: string) {
  const normalized = currency.toUpperCase();
  assertSupportedCurrency(normalized);
  if (!await providerIsConfigured("payzaapi")) throw new ApiError(503, "Payzaapi payout credentials are not configured.");
  const methods = await payzaPayoutMethods(normalized);
  return {
    currency: methods.currency,
    available: methods.available,
    minimumWithdrawal: methods.minimumWithdrawal,
    fee: methods.fee,
    methods: methods.methods.map((item) => ({
      value: item.value,
      label: item.label,
      requiresBankFields: item.requiresBankFields,
    })),
  };
}

function payoutFeeMinor(amountMinor: bigint, methods: Awaited<ReturnType<typeof payzaPayoutMethods>>) {
  if (methods.fee.type === "flat") return decimalToMinor(methods.fee.amount);
  const percentScaled = BigInt(Math.round((methods.fee.percent ?? 0) * 10_000));
  const percentFee = (amountMinor * percentScaled + 500_000n) / 1_000_000n;
  const floorMinor = decimalToMinor(methods.fee.floor ?? 0);
  return percentFee > floorMinor ? percentFee : floorMinor;
}

type WalletPayoutRequestDependencies = {
  assertPayoutsEnabled?: () => Promise<void>;
  assertMerchantMayPayout?: (merchant: typeof merchantsTable.$inferSelect) => Promise<void>;
  providerIsConfigured?: () => Promise<boolean>;
  payoutMethods?: (currency: string) => ReturnType<typeof payzaPayoutMethods>;
};

export async function createWalletPayoutRequest(merchant: typeof merchantsTable.$inferSelect, input: {
  amount: number;
  currency: string;
  method: string;
  accountName: string;
  accountNumber: string;
  bankCode?: string;
  bankName?: string;
  idempotencyKey: string;
}, dependencies: WalletPayoutRequestDependencies = {}) {
  const currency = input.currency.toUpperCase();
  assertSupportedCurrency(currency);
  const amountMinor = userAmountToMinor(input.amount);
  if (amountMinor <= 0n) throw new ApiError(400, "Enter a payout amount greater than zero.");
  const methodValue = input.method.trim();
  const destination = {
    accountName: input.accountName.trim().replace(/\s+/g, " "),
    accountNumber: input.accountNumber.trim().replace(/\s+/g, ""),
    bankCode: input.bankCode?.trim() || null,
    bankName: input.bankName?.trim().replace(/\s+/g, " ") || null,
    method: methodValue,
  };
  if (!destination.accountName || destination.accountNumber.length < 3 || !methodValue) {
    throw new ApiError(400, "Enter a beneficiary name, destination, and payout method.");
  }
  const destinationHash = destinationFingerprint(destination);
  const fingerprint = requestHash({
    amountMinor: amountMinor.toString(), currency, method: methodValue,
    destinationHash,
  });
  const [prior] = await db.select().from(walletPayoutRequestsTable).where(and(
    eq(walletPayoutRequestsTable.merchantId, merchant.id),
    eq(walletPayoutRequestsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (prior) {
    if (prior.requestHash !== fingerprint) {
      throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
    }
    return walletPayoutRequestDto(prior);
  }

  await (dependencies.assertPayoutsEnabled ?? (() => assertPlatformEnabled("payoutsEnabled")))();
  await (dependencies.assertMerchantMayPayout ?? assertMerchantMayPayout)(merchant);
  if (!await (dependencies.providerIsConfigured ?? (() => providerIsConfigured("payzaapi")))) {
    throw new ApiError(503, "Payzaapi payouts are not configured.");
  }
  const methods = await (dependencies.payoutMethods ?? payzaPayoutMethods)(currency);
  if (!methods.available) throw new ApiError(422, `Payout requests are unavailable in ${currency}.`);
  const method = methods.methods.find((candidate) => candidate.value === methodValue);
  if (!method) throw new ApiError(400, "Choose a payout method returned by Payzaapi.");
  if (amountMinor < decimalToMinor(methods.minimumWithdrawal)) {
    throw new ApiError(400, `The minimum withdrawal for ${currency} is ${methods.minimumWithdrawal}.`);
  }
  if (method.requiresBankFields && (!destination.bankCode || !destination.bankName)) {
    throw new ApiError(400, "Select a bank and enter its bank code for this payout method.");
  }
  const encryptedDestination = encryptDestination(destination);
  const feeMinor = payoutFeeMinor(amountMinor, methods);
  const holdMinor = amountMinor + feeMinor;
  const rawDigits = destination.accountNumber.replace(/\D/g, "");
  const maskedAccount = `${"•".repeat(Math.max(0, Math.min(8, rawDigits.length - 4)))}${rawDigits.slice(-4)}`;
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(walletPayoutRequestsTable).where(and(
      eq(walletPayoutRequestsTable.merchantId, merchant.id),
      eq(walletPayoutRequestsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (existing) {
      if (existing.requestHash !== fingerprint) {
        throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
      }
      return walletPayoutRequestDto(existing);
    }
    const wallet = await lockWallet(tx, merchant.id, currency);
    const [concurrent] = await tx.select().from(walletPayoutRequestsTable).where(and(
      eq(walletPayoutRequestsTable.merchantId, merchant.id),
      eq(walletPayoutRequestsTable.idempotencyKey, input.idempotencyKey),
    )).for("update").limit(1);
    if (concurrent) {
      if (concurrent.requestHash !== fingerprint) {
        throw new ApiError(409, "This payout idempotency key was already used with different payout details.");
      }
      return walletPayoutRequestDto(concurrent);
    }
    await enforceVerificationLimit(tx, merchant.id, "payout", minorToNumber(holdMinor), currency);
    if (!canReserveWalletFunds(wallet.availableMinor, holdMinor)) {
      throw new ApiError(409, `Available ${currency} wallet funds do not cover the payout and fee.`);
    }
    const reference = `GP-WP-${randomUUID()}`;
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor - holdMinor,
      reservedMinor: wallet.reservedMinor + holdMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    const journal = await postJournal(tx, {
      merchantId: merchant.id,
      currency,
      kind: "payout_reserve",
      reference,
      sourceReference: reference,
      idempotencyKey: `payout:${merchant.id}:${input.idempotencyKey}:reserve`,
      metadata: { amountMinor: holdMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "debit",
      secondMerchantAccount: "merchant_reserved",
    });
    const [created] = await tx.insert(walletPayoutRequestsTable).values({
      merchantId: merchant.id,
      reference,
      idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint,
      amountMinor,
      feeMinor,
      holdMinor,
      currency,
      method: method.label,
      accountName: maskDestinationName(destination.accountName),
      maskedAccount: maskedAccount || "••••",
      encryptedDestination,
      status: "requested",
      provider: "payzaapi",
      reservationJournalId: journal.id,
    }).returning();
    if (!created) throw new ApiError(503, "Payout reservation could not be recorded.");
    return walletPayoutRequestDto(created);
  });
}

async function applyPayoutFinalState(
  tx: FinancialTx,
  request: WalletPayoutRequestRecord,
  finalStatus: "completed" | "rejected" | "failed",
  providerReference?: string | null,
) {
  if (request.status === "completed" || request.status === "rejected" || request.status === "failed") return request;
  const wallet = await lockWallet(tx, request.merchantId, request.currency);
  if (finalStatus === "completed") {
    if (wallet.reservedMinor < request.holdMinor) throw new ApiError(409, "Payout reservation is inconsistent; manual reconciliation is required.");
    await tx.update(merchantWalletsTable).set({
      reservedMinor: wallet.reservedMinor - request.holdMinor, updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: request.merchantId,
      currency: request.currency,
      kind: "payout_complete",
      reference: request.reference,
      sourceReference: providerReference ?? request.reference,
      idempotencyKey: `payout:${request.reference}:complete`,
      metadata: { amountMinor: request.holdMinor.toString() },
      merchantAccount: "merchant_reserved",
      merchantDirection: "debit",
      externalAccount: "platform_payout",
    });
  } else if (shouldReleasePayoutHold(finalStatus)) {
    if (wallet.reservedMinor < request.holdMinor) throw new ApiError(409, "Payout reservation is inconsistent; manual reconciliation is required.");
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor + request.holdMinor,
      reservedMinor: wallet.reservedMinor - request.holdMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: request.merchantId,
      currency: request.currency,
      kind: "payout_release",
      reference: request.reference,
      sourceReference: request.reference,
      idempotencyKey: `payout:${request.reference}:release`,
      metadata: { amountMinor: request.holdMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "credit",
      secondMerchantAccount: "merchant_reserved",
    });
  }
  const [updated] = await tx.update(walletPayoutRequestsTable).set({
    status: finalStatus,
    providerReference: providerReference ?? request.providerReference,
    completedAt: finalStatus === "completed" ? new Date() : request.completedAt,
    updatedAt: new Date(),
  }).where(eq(walletPayoutRequestsTable.id, request.id)).returning();
  return updated ?? request;
}

export async function recordMerchantPayoutProviderOutcome(requestId: number, input: {
  status: "uncertain" | "processing" | "completed" | "rejected" | "failed";
  providerReference?: string | null;
}) {
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout request not found.");
    if (request.status === "completed" || request.status === "rejected" || request.status === "failed") {
      if (!input.providerReference || input.providerReference === request.providerReference) return request;
      const [updated] = await tx.update(walletPayoutRequestsTable).set({
        providerReference: input.providerReference,
        updatedAt: new Date(),
      }).where(eq(walletPayoutRequestsTable.id, request.id)).returning();
      return updated ?? request;
    }
    if (input.status === "completed" || input.status === "rejected" || input.status === "failed") {
      return applyPayoutFinalState(tx, request, input.status, input.providerReference);
    }
    const [updated] = await tx.update(walletPayoutRequestsTable).set({
      status: input.status,
      providerReference: input.providerReference ?? request.providerReference,
      updatedAt: new Date(),
    }).where(eq(walletPayoutRequestsTable.id, request.id)).returning();
    return updated ?? request;
  });
}

export async function rejectMerchantPayoutRequest(requestId: number, actor: string, reason: string) {
  return db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout request not found.");
    if (request.status !== "requested") throw new ApiError(409, "Only an unsubmitted payout request can be rejected.");
    const updated = await applyPayoutFinalState(tx, request, "rejected");
    await tx.update(walletPayoutRequestsTable).set({ decisionReason: reason }).where(eq(walletPayoutRequestsTable.id, request.id));
    await tx.insert(adminAuditLogTable).values({
      actor, action: "wallet.payout.rejected", target: `wallet-payout:${request.reference}`,
      details: `Merchant payout request rejected. ${reason}`,
    });
    return updated;
  });
}

export async function approveAndSubmitMerchantPayout(requestId: number, actor: string) {
  await assertPlatformEnabled("payoutsEnabled");
  const approved = await db.transaction(async (tx) => {
    const [request] = await tx.select().from(walletPayoutRequestsTable)
      .where(eq(walletPayoutRequestsTable.id, requestId)).for("update").limit(1);
    if (!request) throw new ApiError(404, "Payout request not found.");
    if (request.status !== "requested") {
      throw new ApiError(409, "This request has already been approved, submitted, or reached a terminal outcome.");
    }
    const [merchant] = await tx.select().from(merchantsTable).where(eq(merchantsTable.id, request.merchantId)).limit(1);
    if (!merchant) throw new ApiError(409, "Payout merchant account no longer exists.");
    await enforceVerificationLimit(tx, merchant.id, "payout", minorToNumber(request.holdMinor), request.currency);
    await assertMerchantMayPayout(merchant);
    const [updated] = await tx.update(walletPayoutRequestsTable).set({
      status: "approved", approvedBy: actor, submittedAt: new Date(), updatedAt: new Date(),
    }).where(and(
      eq(walletPayoutRequestsTable.id, request.id),
      eq(walletPayoutRequestsTable.status, "requested"),
    )).returning();
    if (!updated) throw new ApiError(409, "Payout approval was concurrently processed.");
    await tx.insert(adminAuditLogTable).values({
      actor, action: "wallet.payout.approved", target: `wallet-payout:${request.reference}`,
      details: "Merchant payout approved for one provider submission; destination is stored encrypted.",
    });
    return updated;
  });

  if (!await providerIsConfigured("payzaapi")) {
    await recordMerchantPayoutProviderOutcome(requestId, { status: "uncertain" });
    throw new ApiError(503, "Payzaapi is not configured. The payout remains reserved for administrator reconciliation and will not be auto-submitted.");
  }
  let response: Record<string, unknown>;
  try {
    const destination = decryptDestination(approved.encryptedDestination);
    const payload: Record<string, unknown> = {
      amount: minorToNumber(approved.amountMinor),
      currency: approved.currency,
      method: destination.method,
      account_number: destination.accountNumber,
      account_name: destination.accountName,
      reference: approved.reference,
    };
    if (destination.bankCode) payload.bank_code = destination.bankCode;
    if (destination.bankName) payload.bank_name = destination.bankName;
    response = await payzaApiRequest("/payout", {
      method: "POST",
      headers: { "Idempotency-Key": approved.reference },
      body: JSON.stringify(payload),
    });
  } catch {
    await recordMerchantPayoutProviderOutcome(requestId, { status: "uncertain" });
    throw new ApiError(503, `Payzaapi payout outcome is uncertain. Request ${approved.reference} remains reserved and cannot be re-submitted.`);
  }
  const payout = asObject(response.payout);
  const providerReference = stringValue(payout.reference) ?? stringValue(payout.id);
  const outcome = payoutProviderOutcome({
    accepted: typeof response.success === "boolean" ? response.success : undefined,
    providerReference,
    providerStatus: stringValue(payout.status),
  });
  const result = await recordMerchantPayoutProviderOutcome(requestId, {
    status: outcome, providerReference,
  });
  return walletPayoutRequestDto(result);
}

export async function reconcileMerchantPayoutRequest(requestId: number) {
  const [request] = await db.select().from(walletPayoutRequestsTable)
    .where(eq(walletPayoutRequestsTable.id, requestId)).limit(1);
  if (!request) throw new ApiError(404, "Payout request not found.");
  if (!["approved", "uncertain", "processing"].includes(request.status)) {
    throw new ApiError(409, "Only an approved, processing, or uncertain payout can be reconciled.");
  }
  if (!await providerIsConfigured("payzaapi")) throw new ApiError(503, "Payzaapi is not configured for payout reconciliation.");
  const response = await payzaApiRequest(`/payouts?reference=${encodeURIComponent(request.providerReference ?? request.reference)}`);
  const payout = asObject(response.payout ?? (Array.isArray(response.payouts) ? response.payouts[0] : null));
  const status = stringValue(payout.status)?.toLowerCase();
  if (response.success !== true || !status) {
    throw new ApiError(503, "Payzaapi could not authoritatively verify this payout; its funds remain reserved.");
  }
  const providerReference = stringValue(payout.reference) ?? stringValue(payout.id) ?? request.providerReference;
  const normalized = payoutProviderOutcome({
    accepted: true, providerReference, providerStatus: status,
  });
  const updated = await recordMerchantPayoutProviderOutcome(request.id, {
    status: normalized, providerReference,
  });
  return walletPayoutRequestDto(updated);
}

export async function confirmWalletSettlement(input: {
  settlementReference: string;
  evidenceReference: string;
  actor: string;
}) {
  return db.transaction(async (tx) => {
    const [transaction] = await tx.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, input.settlementReference)).for("update").limit(1);
    const [settlement] = await tx.select().from(settlementsTable)
      .where(eq(settlementsTable.reference, input.settlementReference)).for("update").limit(1);
    if (!transaction || !settlement) throw new ApiError(404, "Settlement or source collection was not found.");
    if (transaction.status !== "success" || !transaction.merchantId) {
      throw new ApiError(409, "Only a confirmed successful merchant collection can fund a wallet.");
    }
    if (!["pending", "due"].includes(settlement.status)) {
      throw new ApiError(409, "This settlement is not eligible for wallet reconciliation.");
    }
    if (settlement.currency !== transaction.currency) {
      throw new ApiError(409, "The settlement currency does not match the source collection.");
    }
    const [alreadyConfirmed] = await tx.select().from(walletSettlementConfirmationsTable)
      .where(eq(walletSettlementConfirmationsTable.settlementReference, settlement.reference)).limit(1);
    if (alreadyConfirmed) throw new ApiError(409, "This settlement has already been confirmed and credited.");
    const [openRefund] = await tx.select({ id: refundsTable.id }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, transaction.reference),
      inArray(refundsTable.status, [...OPEN_REFUND_RESERVATION_STATUSES]),
    )).limit(1);
    if (openRefund) {
      throw new ApiError(409, "This collection has a pending or unresolved customer refund; reconcile it before wallet funding.");
    }
    const [refundSum] = await tx.select({
      total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
    }).from(refundsTable).where(and(
      eq(refundsTable.originalReference, transaction.reference),
      inArray(refundsTable.status, [...CUSTOMER_REIMBURSED_REFUND_STATUSES]),
    ));
    const confirmedNetMinor = decimalToMinor(
      Math.min(Number(transaction.platformNetAmount ?? transaction.netAmount ?? transaction.amount), Number(settlement.netAmount)),
    );
    const confirmedRefundMinor = decimalToMinor(Number(refundSum?.total ?? 0));
    const previousSource = await tx.select({ fundedMinor: walletSettlementConfirmationsTable.fundedMinor })
      .from(walletSettlementConfirmationsTable).where(eq(
        walletSettlementConfirmationsTable.settlementReference, transaction.reference,
      ));
    const previouslyFundedMinor = previousSource.reduce((total, row) => total + row.fundedMinor, 0n);
    const fundableMinor = eligibleSettlementFunding({
      confirmedNetMinor,
      confirmedRefundMinor,
      originalAmountMinor: decimalToMinor(Number(transaction.amount)),
      previouslyFundedMinor,
    });
    if (fundableMinor <= 0n) throw new ApiError(409, "Confirmed refunds leave no net collection available for wallet funding.");
    const wallet = await lockWallet(tx, transaction.merchantId, transaction.currency);
    const reference = `settlement:${settlement.reference}`;
    const journal = await postJournal(tx, {
      merchantId: transaction.merchantId,
      currency: transaction.currency,
      kind: "settlement_funding",
      reference,
      sourceReference: settlement.reference,
      evidenceReference: input.evidenceReference,
      idempotencyKey: `settlement:${settlement.reference}:funding`,
      metadata: { amountMinor: fundableMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "credit",
      externalAccount: "platform_settlement",
    });
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor + fundableMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await tx.insert(walletSettlementConfirmationsTable).values({
      settlementReference: settlement.reference,
      merchantId: transaction.merchantId,
      currency: transaction.currency,
      fundedMinor: fundableMinor,
      evidenceReference: input.evidenceReference,
      journalId: journal.id,
      confirmedBy: input.actor,
    });
    await tx.update(settlementsTable).set({ status: "settled", settledAt: new Date() })
      .where(eq(settlementsTable.id, settlement.id));
    await tx.update(transactionsTable).set({ settlementStatus: "settled" })
      .where(eq(transactionsTable.id, transaction.id));
    await tx.insert(adminAuditLogTable).values({
      actor: input.actor,
      action: "wallet.settlement.confirmed",
      target: `settlement:${settlement.reference}`,
      details: `Confirmed ${minorToDecimal(fundableMinor)} ${settlement.currency} with evidence reference ${input.evidenceReference}.`,
    });
    return {
      settlementReference: settlement.reference,
      merchantId: transaction.merchantId,
      currency: settlement.currency,
      fundedAmount: minorToNumber(fundableMinor),
      evidenceReference: input.evidenceReference,
      confirmedAt: new Date(),
    };
  });
}

export async function reserveWalletRefundFunds(
  tx: FinancialTx,
  transaction: typeof transactionsTable.$inferSelect,
  refund: typeof refundsTable.$inferSelect,
): Promise<void> {
  if (!transaction.merchantId || ![
    ...CUSTOMER_REIMBURSED_REFUND_STATUSES,
    ...OPEN_REFUND_RESERVATION_STATUSES,
  ].includes(refund.status as never)) return;
  const [funding] = await tx.select().from(walletSettlementConfirmationsTable)
    .where(eq(walletSettlementConfirmationsTable.settlementReference, transaction.reference))
    .for("update").limit(1);
  if (!funding) return;
  const [settlement] = await tx.select().from(settlementsTable)
    .where(eq(settlementsTable.reference, transaction.reference)).for("update").limit(1);
  if (!settlement || settlement.currency !== transaction.currency) {
    throw new ApiError(409, "Wallet-funded settlement source is inconsistent; manual reconciliation is required.");
  }
  const [existing] = await tx.select().from(walletRefundAdjustmentsTable)
    .where(eq(walletRefundAdjustmentsTable.refundReference, refund.reference)).for("update").limit(1);
  if (existing) return;
  const [refundTotal] = await tx.select({
    total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
  }).from(refundsTable).where(and(
    eq(refundsTable.originalReference, transaction.reference),
    inArray(refundsTable.status, [
      ...CUSTOMER_REIMBURSED_REFUND_STATUSES,
      ...OPEN_REFUND_RESERVATION_STATUSES,
    ]),
  ));
  const totalRefundMinor = decimalToMinor(Number(refundTotal?.total ?? 0));
  const originalMinor = decimalToMinor(Number(transaction.amount));
  const eligibleNetMinor = decimalToMinor(
    Math.min(Number(transaction.platformNetAmount ?? transaction.netAmount ?? transaction.amount), Number(settlement.netAmount)),
  );
  const targetReversalMinor = proportionalNetRefundReversal(eligibleNetMinor, totalRefundMinor, originalMinor);
  const preFundingReversalMinor = eligibleNetMinor > funding.fundedMinor
    ? eligibleNetMinor - funding.fundedMinor
    : 0n;
  const [previous] = await tx.select({
    total: sql<string>`coalesce(sum(${walletRefundAdjustmentsTable.amountMinor}), 0)::text`,
  }).from(walletRefundAdjustmentsTable).where(and(
    eq(walletRefundAdjustmentsTable.transactionReference, transaction.reference),
    inArray(walletRefundAdjustmentsTable.status, ["reserved", "committed"]),
  ));
  const previousMinor = preFundingReversalMinor + BigInt(previous?.total ?? "0");
  const adjustmentMinor = targetReversalMinor - previousMinor;
  if (adjustmentMinor <= 0n) return;
  const wallet = await lockWallet(tx, transaction.merchantId, transaction.currency);
  if (!canApplyWalletRefundAdjustment(wallet.availableMinor, adjustmentMinor)) {
    throw new ApiError(409, "Refund cannot be recorded because wallet-funded proceeds for this collection have already been reserved or spent.");
  }
  await tx.update(merchantWalletsTable).set({
    availableMinor: wallet.availableMinor - adjustmentMinor,
    reservedMinor: wallet.reservedMinor + adjustmentMinor,
    updatedAt: new Date(),
  }).where(eq(merchantWalletsTable.id, wallet.id));
  const journal = await postJournal(tx, {
    merchantId: transaction.merchantId,
    currency: transaction.currency,
    kind: "refund_adjustment",
    reference: `refund:${refund.reference}`,
    sourceReference: transaction.reference,
    idempotencyKey: `refund:${refund.reference}:reserve`,
    metadata: { amountMinor: adjustmentMinor.toString() },
    merchantAccount: "merchant_available",
    merchantDirection: "debit",
    secondMerchantAccount: "merchant_reserved",
  });
  await tx.insert(walletRefundAdjustmentsTable).values({
    refundReference: refund.reference,
    transactionReference: transaction.reference,
    merchantId: transaction.merchantId,
    currency: transaction.currency,
    amountMinor: adjustmentMinor,
    reserveJournalId: journal.id,
  });
}

export async function settleWalletRefundFunds(
  tx: FinancialTx,
  transaction: typeof transactionsTable.$inferSelect,
  refund: typeof refundsTable.$inferSelect,
): Promise<void> {
  if (CUSTOMER_REIMBURSED_REFUND_STATUSES.includes(refund.status as never)) {
    await reserveWalletRefundFunds(tx, transaction, refund);
  }
  const [adjustment] = await tx.select().from(walletRefundAdjustmentsTable)
    .where(eq(walletRefundAdjustmentsTable.refundReference, refund.reference)).for("update").limit(1);
  if (!adjustment || adjustment.status !== "reserved") return;
  const isConfirmed = CUSTOMER_REIMBURSED_REFUND_STATUSES.includes(refund.status as never);
  const isDefinitiveFailure = ["failed", "reversed", "rejected", "cancelled"].includes(refund.status);
  if (!isConfirmed && !isDefinitiveFailure) return;
  const wallet = await lockWallet(tx, adjustment.merchantId, adjustment.currency);
  if (wallet.reservedMinor < adjustment.amountMinor) {
    throw new ApiError(409, "Refund wallet reservation is inconsistent; manual reconciliation is required.");
  }
  if (isConfirmed) {
    await tx.update(merchantWalletsTable).set({
      reservedMinor: wallet.reservedMinor - adjustment.amountMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: adjustment.merchantId,
      currency: adjustment.currency,
      kind: "refund_adjustment",
      reference: refund.reference,
      sourceReference: transaction.reference,
      idempotencyKey: `refund:${refund.reference}:commit`,
      metadata: { amountMinor: adjustment.amountMinor.toString() },
      merchantAccount: "merchant_reserved",
      merchantDirection: "debit",
      externalAccount: "platform_settlement",
    });
    await tx.update(walletRefundAdjustmentsTable).set({
      status: "committed", updatedAt: new Date(),
    }).where(eq(walletRefundAdjustmentsTable.id, adjustment.id));
  } else {
    await tx.update(merchantWalletsTable).set({
      availableMinor: wallet.availableMinor + adjustment.amountMinor,
      reservedMinor: wallet.reservedMinor - adjustment.amountMinor,
      updatedAt: new Date(),
    }).where(eq(merchantWalletsTable.id, wallet.id));
    await postJournal(tx, {
      merchantId: adjustment.merchantId,
      currency: adjustment.currency,
      kind: "refund_adjustment",
      reference: refund.reference,
      sourceReference: transaction.reference,
      idempotencyKey: `refund:${refund.reference}:release`,
      metadata: { amountMinor: adjustment.amountMinor.toString() },
      merchantAccount: "merchant_available",
      merchantDirection: "credit",
      secondMerchantAccount: "merchant_reserved",
    });
    await tx.update(walletRefundAdjustmentsTable).set({
      status: "released", updatedAt: new Date(),
    }).where(eq(walletRefundAdjustmentsTable.id, adjustment.id));
  }
}

export async function setWalletPayoutStatusFromProvider(
  provider: string,
  providerReference: string,
  status: "processing" | "completed" | "rejected" | "failed",
): Promise<boolean> {
  const [request] = await db.select().from(walletPayoutRequestsTable).where(and(
    eq(walletPayoutRequestsTable.provider, provider),
    or(
      eq(walletPayoutRequestsTable.providerReference, providerReference),
      eq(walletPayoutRequestsTable.reference, providerReference),
    ),
  )).limit(1);
  if (!request) return false;
  await recordMerchantPayoutProviderOutcome(request.id, {
    status,
    providerReference: request.reference === providerReference ? request.providerReference : providerReference,
  });
  return true;
}

export async function reconcileMerchantPayoutByReference(reference: string): Promise<boolean> {
  const [request] = await db.select({ id: walletPayoutRequestsTable.id }).from(walletPayoutRequestsTable).where(and(
    eq(walletPayoutRequestsTable.provider, "payzaapi"),
    or(
      eq(walletPayoutRequestsTable.providerReference, reference),
      eq(walletPayoutRequestsTable.reference, reference),
    ),
  )).limit(1);
  if (!request) return false;
  await reconcileMerchantPayoutRequest(request.id);
  return true;
}