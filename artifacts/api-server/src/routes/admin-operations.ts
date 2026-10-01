import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  CreatePaymentLinkBody,
  CreatePaymentLinkResponse,
  CreatePayoutBody,
  CreatePayoutResponse,
  DeletePaymentLinkParams,
  DeletePaymentLinkResponse,
  GetProviderStatusResponse,
  ListBanksQueryParams,
  ListBanksResponse,
  ListCustomersQueryParams,
  ListCustomersResponse,
  ListPaymentLinksQueryParams,
  ListPaymentLinksResponse,
  ListPayoutMethodsQueryParams,
  ListPayoutMethodsResponse,
  ListPayoutsQueryParams,
  ListPayoutsResponse,
  ListSettlementsQueryParams,
  ListSettlementsResponse,
  ListWebhookEventsQueryParams,
  ListWebhookEventsResponse,
  ReplayWebhookEventParams,
  ReplayWebhookEventResponse,
  UpdatePaymentLinkBody,
  UpdatePaymentLinkParams,
  UpdatePaymentLinkResponse,
} from "@workspace/api-zod";
import { db, paymentLinksTable, payoutsTable, transactionsTable, webhookEventsTable } from "@workspace/db";
import {
  ApiError,
  assertSupportedCurrency,
  asObject,
  fetchProviderJson,
  isObject,
  numberValue,
  payzaApiRequest,
  payzaPayoutMethods,
  providerConfigured,
  stringValue,
  verifyProviderPayment,
} from "../lib/greenpay-provider";
import {
  customersSummary,
  filterPayouts,
  filterSettlements,
  paymentLinkRows,
  paymentLinkDto,
  payoutDto,
  recordWebhookEvent,
  transactionDto,
  updateDueSettlements,
  webhookEventDto,
} from "../lib/greenpay-ledger";
import { markTransactionStatus } from "../lib/greenpay-ledger";

const router: IRouter = Router();

router.get("/payment-links", async (req, res): Promise<void> => {
  const parsed = ListPaymentLinksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const items = await paymentLinkRows(parsed.data.search);
  res.json(ListPaymentLinksResponse.parse({ items }));
});

router.post("/payment-links", async (req, res): Promise<void> => {
  const parsed = CreatePaymentLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  const currency = input.currency.toUpperCase();
  assertSupportedCurrency(currency);
  if (input.amountType === "fixed" && !(input.amount && input.amount > 0)) {
    res.status(400).json({ error: "A fixed-price link needs an amount greater than zero." });
    return;
  }
  if (input.amountType === "customer_choice" && input.amount !== undefined) {
    res.status(400).json({ error: "Customer-choice links cannot have a preset amount." });
    return;
  }
  const slug = randomUUID().replaceAll("-", "").slice(0, 20);
  const [link] = await db.insert(paymentLinksTable).values({
    slug,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    amountType: input.amountType,
    amount: input.amountType === "fixed" ? input.amount : null,
    currency,
    status: "active",
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  }).returning();
  res.status(201).json(CreatePaymentLinkResponse.parse(paymentLinkDto(link, 0, 0)));
});

router.patch("/payment-links/:id", async (req, res): Promise<void> => {
  const params = UpdatePaymentLinkParams.safeParse(req.params);
  const body = UpdatePaymentLinkBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: !params.success ? params.error.message : body.error.message });
    return;
  }
  const updates: Partial<typeof paymentLinksTable.$inferInsert> = {};
  if (body.data.name !== undefined) updates.name = body.data.name.trim();
  if (body.data.description !== undefined) updates.description = body.data.description.trim() || null;
  if (body.data.status !== undefined) updates.status = body.data.status;
  if (body.data.expiresAt !== undefined) updates.expiresAt = body.data.expiresAt ? new Date(body.data.expiresAt) : null;
  if (!Object.keys(updates).length) {
    res.status(400).json({ error: "Provide at least one payment-link field to update." });
    return;
  }
  const [link] = await db.update(paymentLinksTable).set(updates)
    .where(eq(paymentLinksTable.id, params.data.id)).returning();
  if (!link) {
    res.status(404).json({ error: "Payment link not found." });
    return;
  }
  const [summary] = await db.select({
    count: sql<number>`count(*) filter (where ${transactionsTable.status} in ('success', 'refunded'))::int`,
    total: sql<number>`coalesce(sum(${transactionsTable.amount}) filter (where ${transactionsTable.status} in ('success', 'refunded')), 0)::numeric`,
  }).from(transactionsTable).where(eq(transactionsTable.paymentLinkId, link.id));
  res.json(UpdatePaymentLinkResponse.parse(paymentLinkDto(
    link,
    Number(summary?.count ?? 0),
    Number(summary?.total ?? 0),
  )));
});

router.delete("/payment-links/:id", async (req, res): Promise<void> => {
  const params = DeletePaymentLinkParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [link] = await db.update(paymentLinksTable).set({ status: "archived" })
    .where(eq(paymentLinksTable.id, params.data.id)).returning({ id: paymentLinksTable.id });
  if (!link) {
    res.status(404).json({ error: "Payment link not found." });
    return;
  }
  res.status(204).send(DeletePaymentLinkResponse.parse(undefined));
});

router.get("/payouts", async (req, res): Promise<void> => {
  const parsed = ListPayoutsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(ListPayoutsResponse.parse({
    items: await filterPayouts(parsed.data.status, parsed.data.currency),
  }));
});

router.get("/payout-methods", async (req, res): Promise<void> => {
  if (!providerConfigured("payzaapi")) throw new ApiError(503, "Payzaapi is not configured.");
  const parsed = ListPayoutMethodsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const methods = await payzaPayoutMethods(parsed.data.currency ?? "KES");
  res.json(ListPayoutMethodsResponse.parse(methods));
});

router.get("/banks", async (req, res): Promise<void> => {
  if (!providerConfigured("payzaapi")) throw new ApiError(503, "Payzaapi is not configured.");
  const parsed = ListBanksQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const country = (parsed.data.country ?? "KE").toUpperCase();
  const response = await payzaApiRequest(`/banks?country=${encodeURIComponent(country)}`);
  const banks = Array.isArray(response.banks) ? response.banks : [];
  res.json(ListBanksResponse.parse({
    banks: banks.filter(isObject).map((bank) => ({
      code: stringValue(bank.code) ?? "",
      name: stringValue(bank.name) ?? "",
    })).filter((bank) => bank.code && bank.name),
  }));
});

router.post("/payouts", async (req, res): Promise<void> => {
  const parsed = CreatePayoutBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!providerConfigured("payzaapi")) throw new ApiError(503, "Payzaapi payouts are not configured.");

  const input = parsed.data;
  const accountNumber = input.accountNumber.trim();
  const currency = input.currency.toUpperCase();
  const methods = await payzaPayoutMethods(currency);
  if (!methods.available) throw new ApiError(422, `Payouts are unavailable in ${currency}.`);
  const method = methods.methods.find((candidate) => candidate.value === input.method);
  if (!method) throw new ApiError(400, "Choose a payout method returned by Payzaapi.");
  if (input.amount < methods.minimumWithdrawal) {
    throw new ApiError(400, `The minimum withdrawal for ${currency} is ${methods.minimumWithdrawal}.`);
  }
  if (method.requiresBankFields && (!input.bankCode || !input.bankName)) {
    throw new ApiError(400, "Select a bank and enter its bank code for this payout method.");
  }

  const reference = `GP-PO-${randomUUID()}`;
  const payload: Record<string, unknown> = {
    amount: input.amount,
    currency,
    method: input.method,
    account_number: accountNumber,
    account_name: input.accountName.trim(),
  };
  if (input.bankCode) payload.bank_code = input.bankCode;
  if (input.bankName) payload.bank_name = input.bankName;

  const response = await payzaApiRequest("/payout", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const payout = asObject(response.payout);
  if (response.success !== true || Object.keys(payout).length === 0) {
    throw new ApiError(502, stringValue(response.message) ?? "Payzaapi did not accept the payout.");
  }
  const rawStatus = stringValue(payout.status)?.toLowerCase();
  const allowedStatuses = ["pending", "processing", "approved", "completed", "rejected", "failed"];
  const status = allowedStatuses.includes(rawStatus ?? "") ? rawStatus! : "pending";
  const feeAmount = methods.fee.type === "flat"
    ? methods.fee.amount
    : Math.max(
      input.amount * (methods.fee.percent ?? 0) / 100,
      methods.fee.floor ?? 0,
    );
  const rawAccountDigits = accountNumber.replace(/\D/g, "");
  const maskedAccount = `${"•".repeat(Math.max(0, Math.min(8, rawAccountDigits.length - 4)))}${rawAccountDigits.slice(-4)}`;
  const [row] = await db.insert(payoutsTable).values({
    reference,
    provider: "payzaapi",
    providerReference: stringValue(payout.reference) ?? null,
    amount: input.amount,
    fee: feeAmount,
    netAmount: numberValue(payout.net_amount) ?? input.amount,
    currency,
    method: method.label,
    accountName: input.accountName.trim(),
    maskedAccount: maskedAccount || "••••",
    status,
  }).returning();
  res.status(201).json(CreatePayoutResponse.parse(payoutDto(row)));
});

router.get("/settlements", async (req, res): Promise<void> => {
  const parsed = ListSettlementsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await updateDueSettlements();
  res.json(ListSettlementsResponse.parse({
    items: await filterSettlements(parsed.data.status, parsed.data.currency),
  }));
});

router.get("/customers", async (req, res): Promise<void> => {
  const parsed = ListCustomersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(ListCustomersResponse.parse({
    items: await customersSummary(parsed.data.search),
  }));
});

router.get("/webhook-events", async (req, res): Promise<void> => {
  const parsed = ListWebhookEventsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rows = await db.select().from(webhookEventsTable)
    .where(parsed.data.status ? eq(webhookEventsTable.status, parsed.data.status) : undefined)
    .orderBy(sql`${webhookEventsTable.receivedAt} DESC`).limit(500);
  res.json(ListWebhookEventsResponse.parse({ items: rows.map(webhookEventDto) }));
});

router.post("/webhook-events/:id/replay", async (req, res): Promise<void> => {
  const params = ReplayWebhookEventParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [event] = await db.select().from(webhookEventsTable)
    .where(eq(webhookEventsTable.id, params.data.id)).limit(1);
  if (!event) {
    res.status(404).json({ error: "Webhook event not found." });
    return;
  }
  if (!event.reference) {
    res.status(409).json({ error: "This event has no payment or payout reference to verify." });
    return;
  }

  let status = "processed";
  let errorMessage: string | null = null;
  try {
    if (event.event.startsWith("payout.") && event.provider === "payzaapi") {
      const [payout] = await db.select().from(payoutsTable).where(and(
        eq(payoutsTable.provider, "payzaapi"),
        eq(payoutsTable.providerReference, event.reference),
      )).limit(1);
      if (!payout) throw new ApiError(404, "No payout matches this provider reference.");
      const response = await payzaApiRequest(`/payouts?reference=${encodeURIComponent(event.reference)}`);
      const raw = asObject(response.payout ?? (Array.isArray(response.payouts) ? response.payouts[0] : null));
      if (response.success !== true || !stringValue(raw.status)) throw new ApiError(502, "Payzaapi could not verify the payout.");
      const providerStatus = stringValue(raw.status)!.toLowerCase();
      const payoutStatus = ["pending", "processing", "approved", "completed", "rejected", "failed"].includes(providerStatus)
        ? providerStatus
        : "processing";
      await db.update(payoutsTable).set({ status: payoutStatus })
        .where(eq(payoutsTable.id, payout.id));
    } else {
      const [transaction] = await db.select().from(transactionsTable)
        .where(eq(transactionsTable.reference, event.reference)).limit(1);
      if (!transaction) throw new ApiError(404, "No payment matches this reference.");
      const verified = await verifyProviderPayment(transaction);
      await markTransactionStatus(transaction.reference, verified);
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message.slice(0, 500) : "Webhook replay failed.";
  }

  const updated = await recordWebhookEvent({
    deliveryKey: event.deliveryKey,
    provider: event.provider,
    event: event.event,
    reference: event.reference,
    status,
    httpStatus: status === "processed" ? 200 : 502,
    lastError: errorMessage,
  });
  res.json(ReplayWebhookEventResponse.parse(webhookEventDto(updated)));
});

export default router;