import { and, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import {
  db,
  paymentLinksTable,
  payoutsTable,
  refundsTable,
  settlementsTable,
  transactionsTable,
  webhookEventsTable,
  type PaymentLinkRecord,
  type PayoutRecord,
  type SettlementRecord,
  type TransactionRecord,
  type WebhookEventRecord,
} from "@workspace/db";
import type { PaymentStatus } from "./greenpay-provider";
import { getPublicAppUrl } from "./greenpay-provider";

export function transactionDto(row: TransactionRecord) {
  return {
    id: row.id,
    reference: row.reference,
    amount: Number(row.amount),
    fee: row.fee === null ? null : Number(row.fee),
    netAmount: row.netAmount === null ? null : Number(row.netAmount),
    currency: row.currency,
    status: row.status,
    provider: row.provider,
    paymentMethod: row.paymentMethod,
    customerEmail: row.customerEmail,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    description: row.description,
    providerReference: row.providerReference,
    paymentUrl: row.paymentUrl,
    paymentLinkId: row.paymentLinkId,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    settlementAt: row.settlementAt,
    settlementStatus: row.settlementStatus,
  };
}

export function paymentLinkDto(row: PaymentLinkRecord, paidCount: number, totalPaid: number) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    amountType: row.amountType,
    amount: row.amount === null ? null : Number(row.amount),
    currency: row.currency,
    status: row.status,
    url: `${getPublicAppUrl()}/pay/${encodeURIComponent(row.slug)}`,
    paidCount,
    totalPaid,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export function payoutDto(row: PayoutRecord) {
  return {
    id: row.id,
    reference: row.reference,
    amount: Number(row.amount),
    fee: row.fee === null ? null : Number(row.fee),
    netAmount: row.netAmount === null ? null : Number(row.netAmount),
    currency: row.currency,
    method: row.method,
    accountName: row.accountName,
    maskedAccount: row.maskedAccount,
    status: row.status,
    provider: row.provider,
    createdAt: row.createdAt,
  };
}

export function settlementDto(row: SettlementRecord) {
  return {
    id: row.id,
    reference: row.reference,
    provider: row.provider,
    amount: Number(row.amount),
    netAmount: Number(row.netAmount),
    currency: row.currency,
    status: row.status,
    expectedAt: row.expectedAt,
    settledAt: row.settledAt,
    payoutMethod: row.payoutMethod,
  };
}

export function webhookEventDto(row: WebhookEventRecord) {
  return {
    id: row.id,
    provider: row.provider,
    event: row.event,
    reference: row.reference,
    status: row.status,
    httpStatus: row.httpStatus,
    attempts: row.attempts,
    receivedAt: row.receivedAt,
    lastError: row.lastError,
  };
}

export async function markTransactionStatus(
  reference: string,
  result: { status: PaymentStatus; fee?: number | null; netAmount?: number | null; paidAt?: Date | null },
): Promise<TransactionRecord | undefined> {
  const [current] = await db.select().from(transactionsTable).where(eq(transactionsTable.reference, reference)).limit(1);
  if (!current) return undefined;
  if (current.status === "refunded" || current.status === "success") return current;

  if (result.status === "success") {
    const paidAt = result.paidAt ?? new Date();
    const expectedAt = new Date(paidAt.getTime() + 3 * 24 * 60 * 60 * 1000);
    const netAmount = result.netAmount ?? Number(current.amount);
    await db.insert(settlementsTable).values({
      reference: current.reference,
      provider: current.provider,
      amount: Number(current.amount),
      netAmount,
      currency: current.currency,
      status: "pending",
      expectedAt,
    }).onConflictDoNothing();
    const [updated] = await db.update(transactionsTable).set({
      status: "success",
      fee: result.fee ?? current.fee,
      netAmount,
      paidAt,
      settlementAt: expectedAt,
      settlementStatus: "pending",
    }).where(eq(transactionsTable.reference, reference)).returning();
    return updated;
  }

  if (current.status !== "pending") return current;
  const [updated] = await db.update(transactionsTable).set({
    status: result.status,
    settlementStatus: "not_applicable",
  }).where(eq(transactionsTable.reference, reference)).returning();
  return updated;
}

export async function listTransactions(filters: {
  search?: string;
  status?: string;
  currency?: string;
  page: number;
  perPage: number;
}) {
  const conditions = [];
  if (filters.status) conditions.push(eq(transactionsTable.status, filters.status));
  if (filters.currency) conditions.push(eq(transactionsTable.currency, filters.currency.toUpperCase()));
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(or(
      ilike(transactionsTable.reference, pattern),
      ilike(transactionsTable.customerEmail, pattern),
      ilike(transactionsTable.customerName, pattern),
    )!);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(transactionsTable).where(where);
  const items = await db.select().from(transactionsTable).where(where)
    .orderBy(sql`${transactionsTable.createdAt} DESC`)
    .limit(filters.perPage).offset((filters.page - 1) * filters.perPage);
  return { items: items.map(transactionDto), total: Number(countRow?.count ?? 0), page: filters.page, perPage: filters.perPage };
}

export async function updateDueSettlements(now = new Date()): Promise<void> {
  await db.update(settlementsTable).set({ status: "due" }).where(and(
    eq(settlementsTable.status, "pending"),
    lte(settlementsTable.expectedAt, now),
  ));
  await db.update(transactionsTable).set({ settlementStatus: "due" }).where(and(
    eq(transactionsTable.settlementStatus, "pending"),
    lte(transactionsTable.settlementAt, now),
  ));
}

export async function filterSettlements(status?: string, currency?: string) {
  const conditions = [];
  if (status) conditions.push(eq(settlementsTable.status, status));
  if (currency) conditions.push(eq(settlementsTable.currency, currency.toUpperCase()));
  const rows = await db.select().from(settlementsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${settlementsTable.expectedAt} ASC`)
    .limit(1000);
  return rows.map(settlementDto);
}

export async function recordWebhookEvent(input: {
  deliveryKey: string;
  provider: string;
  event: string;
  reference?: string | null;
  status: string;
  httpStatus: number;
  lastError?: string | null;
}) {
  const [existing] = await db.select().from(webhookEventsTable)
    .where(eq(webhookEventsTable.deliveryKey, input.deliveryKey)).limit(1);
  if (existing) {
    const [updated] = await db.update(webhookEventsTable).set({
      attempts: existing.attempts + 1,
      status: input.status,
      httpStatus: input.httpStatus,
      lastError: input.lastError ?? null,
    }).where(eq(webhookEventsTable.id, existing.id)).returning();
    return updated;
  }
  const [created] = await db.insert(webhookEventsTable).values({
    deliveryKey: input.deliveryKey,
    provider: input.provider,
    event: input.event,
    reference: input.reference ?? null,
    status: input.status,
    httpStatus: input.httpStatus,
    attempts: 1,
    lastError: input.lastError ?? null,
  }).returning();
  return created;
}

export async function recordRefund(input: {
  originalReference: string;
  providerReference?: string | null;
  amount: number;
  currency: string;
  status: string;
  reason?: string | null;
}) {
  const [refund] = await db.insert(refundsTable).values({
    reference: `GP-RF-${crypto.randomUUID()}`,
    originalReference: input.originalReference,
    providerReference: input.providerReference ?? null,
    amount: input.amount,
    currency: input.currency,
    status: input.status,
    reason: input.reason ?? null,
  }).returning();

  if (["success", "recorded", "completed", "processed"].includes(input.status)) {
    const [transaction] = await db.select().from(transactionsTable)
      .where(eq(transactionsTable.reference, input.originalReference)).limit(1);
    if (transaction) {
      const [sumRow] = await db.select({
        total: sql<number>`coalesce(sum(${refundsTable.amount}), 0)::numeric`,
      }).from(refundsTable).where(and(
        eq(refundsTable.originalReference, input.originalReference),
        inArray(refundsTable.status, ["success", "recorded", "completed", "processed"]),
      ));
      const refundableAmount = Number(transaction.netAmount ?? transaction.amount);
      if (Number(sumRow?.total ?? 0) + 0.001 >= refundableAmount) {
        await db.update(transactionsTable).set({ status: "refunded" })
          .where(eq(transactionsTable.reference, input.originalReference));
        await db.update(settlementsTable).set({ status: "held" })
          .where(and(
            eq(settlementsTable.reference, input.originalReference),
            inArray(settlementsTable.status, ["pending", "due"]),
          ));
      }
    }
  }
  return refund;
}

export async function dashboardSummary() {
  const now = new Date();
  const dateInNairobi = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(now);
  const startOfDay = new Date(`${dateInNairobi}T00:00:00+03:00`);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const todayTransactions = await db.select().from(transactionsTable).where(and(
    gte(transactionsTable.createdAt, startOfDay),
    lte(transactionsTable.createdAt, endOfDay),
  ));
  const successfulToday = todayTransactions.filter((row) => row.status === "success" || row.status === "refunded");
  const volume = new Map<string, { amount: number; count: number }>();
  for (const row of successfulToday) {
    const current = volume.get(row.currency) ?? { amount: 0, count: 0 };
    current.amount += Number(row.amount);
    current.count += 1;
    volume.set(row.currency, current);
  }
  const recentRows = await db.select().from(transactionsTable)
    .orderBy(sql`${transactionsTable.createdAt} DESC`).limit(8);
  const [settlementCounts] = await db.select({
    pending: sql<number>`count(*) filter (where ${settlementsTable.status} in ('pending', 'due'))::int`,
    due: sql<number>`count(*) filter (where ${settlementsTable.status} = 'due')::int`,
  }).from(settlementsTable);
  const attempts = todayTransactions.length;
  const successes = successfulToday.length;
  return {
    paymentsToday: attempts,
    successRate: attempts === 0 ? 0 : (successes / attempts) * 100,
    pendingSettlements: Number(settlementCounts?.pending ?? 0),
    settlementsDue: Number(settlementCounts?.due ?? 0),
    volumeByCurrency: [...volume.entries()].map(([currency, value]) => ({ currency, ...value })),
    recentTransactions: recentRows.map(transactionDto),
  };
}

export async function paymentLinkRows(search?: string) {
  const links = await db.select().from(paymentLinksTable)
    .where(search ? ilike(paymentLinksTable.name, `%${search}%`) : undefined)
    .orderBy(sql`${paymentLinksTable.createdAt} DESC`).limit(500);
  const results = [];
  for (const link of links) {
    const [payments] = await db.select({
      count: sql<number>`count(*) filter (where ${transactionsTable.status} in ('success', 'refunded'))::int`,
      total: sql<number>`coalesce(sum(${transactionsTable.amount}) filter (where ${transactionsTable.status} in ('success', 'refunded')), 0)::numeric`,
    }).from(transactionsTable).where(eq(transactionsTable.paymentLinkId, link.id));
    results.push(paymentLinkDto(link, Number(payments?.count ?? 0), Number(payments?.total ?? 0)));
  }
  return results;
}

export async function filterPayouts(status?: string, currency?: string) {
  const conditions = [];
  if (status) conditions.push(eq(payoutsTable.status, status));
  if (currency) conditions.push(eq(payoutsTable.currency, currency.toUpperCase()));
  const rows = await db.select().from(payoutsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${payoutsTable.createdAt} DESC`).limit(1000);
  return rows.map(payoutDto);
}

export async function customersSummary(search?: string) {
  const rows = await db.select({
    id: sql<number>`min(${transactionsTable.id})::int`,
    email: transactionsTable.customerEmail,
    name: sql<string>`max(coalesce(${transactionsTable.customerName}, ${transactionsTable.customerEmail}))`,
    phone: sql<string | null>`max(${transactionsTable.customerPhone})`,
    currency: transactionsTable.currency,
    orders: sql<number>`count(*)::int`,
    volume: sql<number>`sum(${transactionsTable.amount})::numeric`,
    lastPaymentAt: sql<Date | null>`max(${transactionsTable.paidAt})`,
  }).from(transactionsTable).where(inArray(transactionsTable.status, ["success", "refunded"]))
    .groupBy(transactionsTable.customerEmail, transactionsTable.currency);

  const groups = new Map<string, {
    id: number; name: string; email: string; phone: string | null; orderCount: number;
    currencies: Map<string, number>; lastPaymentAt: Date | null;
  }>();
  for (const row of rows) {
    if (search && !`${row.name} ${row.email} ${row.phone ?? ""}`.toLowerCase().includes(search.toLowerCase())) continue;
    const existing = groups.get(row.email) ?? {
      id: Number(row.id),
      name: row.name || row.email,
      email: row.email,
      phone: row.phone,
      orderCount: 0,
      currencies: new Map<string, number>(),
      lastPaymentAt: row.lastPaymentAt ?? null,
    };
    existing.id = Math.min(existing.id, Number(row.id));
    existing.orderCount += Number(row.orders);
    existing.currencies.set(row.currency, Number(row.volume));
    if (row.lastPaymentAt && (!existing.lastPaymentAt || row.lastPaymentAt > existing.lastPaymentAt)) {
      existing.lastPaymentAt = row.lastPaymentAt;
    }
    groups.set(row.email, existing);
  }
  return [...groups.values()].sort((a, b) => (b.lastPaymentAt?.getTime() ?? 0) - (a.lastPaymentAt?.getTime() ?? 0))
    .slice(0, 500).map((customer) => ({
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      orderCount: customer.orderCount,
      currencySummary: [...customer.currencies.entries()]
        .map(([currency, amount]) => `${currency} ${new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(amount)}`)
        .join(" · "),
      lastPaymentAt: customer.lastPaymentAt,
    }));
}

export async function findTransaction(reference: string) {
  const [transaction] = await db.select().from(transactionsTable)
    .where(eq(transactionsTable.reference, reference)).limit(1);
  return transaction;
}

export async function getTransactionById(id: number) {
  const [transaction] = await db.select().from(transactionsTable)
    .where(eq(transactionsTable.id, id)).limit(1);
  return transaction;
}

export async function getPaymentLinkBySlug(slug: string) {
  const [link] = await db.select().from(paymentLinksTable)
    .where(and(eq(paymentLinksTable.slug, slug), eq(paymentLinksTable.status, "active"))).limit(1);
  return link;
}

export async function insertPendingTransaction(input: {
  reference: string;
  provider: string;
  amount: number;
  currency: string;
  customerEmail: string;
  customerName?: string | null;
  customerPhone?: string | null;
  description?: string | null;
  paymentLinkId?: number | null;
}) {
  const [row] = await db.insert(transactionsTable).values({
    ...input,
    currency: input.currency.toUpperCase(),
    status: "pending",
    settlementStatus: "not_applicable",
  }).returning();
  return row;
}