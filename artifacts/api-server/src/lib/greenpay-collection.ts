import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, transactionsTable } from "@workspace/db";
import { assertSupportedCurrency, providerConfigured, providerForCurrency, startProviderPayment, type ProviderName } from "./greenpay-provider";
import { insertPendingTransaction } from "./greenpay-ledger";

export interface CreateCollectionInput {
  amount: number;
  currency: string;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  description?: string;
  paymentLinkId?: number;
  paymentLinkSlug?: string;
}

export async function createCollection(input: CreateCollectionInput) {
  const currency = input.currency.toUpperCase();
  assertSupportedCurrency(currency);
  const provider: ProviderName = providerForCurrency(currency);
  if (!providerConfigured(provider)) {
    throw new Error(`${provider} is not configured.`);
  }
  if (provider === "payhero" && !Number.isInteger(input.amount)) {
    throw new Error("KES M-Pesa collections must use whole shillings.");
  }
  if (provider === "payhero" && !input.customerPhone?.trim()) {
    throw new Error("A phone number is required for a KES M-Pesa prompt.");
  }

  const reference = `GP-${randomUUID()}`;
  const row = await insertPendingTransaction({
    reference,
    provider,
    amount: Math.round(input.amount * 100) / 100,
    currency,
    customerEmail: input.customerEmail.trim().toLowerCase(),
    customerName: input.customerName?.trim() || null,
    customerPhone: input.customerPhone?.trim() || null,
    description: input.description?.trim() || null,
    paymentLinkId: input.paymentLinkId ?? null,
  });

  try {
    const payment = await startProviderPayment({
      reference,
      provider,
      amount: Number(row.amount),
      currency,
      customerEmail: row.customerEmail,
      customerName: row.customerName,
      customerPhone: row.customerPhone,
      description: row.description,
      paymentLinkSlug: input.paymentLinkSlug ?? null,
    });
    const [updated] = await db.update(transactionsTable).set({
      providerReference: payment.providerReference,
      paymentUrl: payment.paymentUrl,
    }).where(eq(transactionsTable.id, row.id)).returning();
    return { transaction: updated, checkoutUrl: payment.paymentUrl };
  } catch (error) {
    const [current] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.id, row.id)).limit(1);
    if (current?.status === "pending") {
      await db.update(transactionsTable).set({ status: "failed" })
        .where(eq(transactionsTable.id, row.id));
    }
    throw error;
  }
}