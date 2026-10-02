import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import express, { type Request } from "express";
import { clerkMiddleware } from "@clerk/express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  financialNotificationEventsTable,
  merchantInvoicesTable,
  merchantsTable,
  paymentLinksTable,
  pool,
  settlementsTable,
  transactionsTable,
  transactionalEmailOutboxTable,
} from "@workspace/db";
import merchantBusinessToolsRouter from "../routes/merchant-business-tools";
import { markTransactionStatus } from "./greenpay-ledger";

after(async () => {
  await pool.end();
});

type AuthHandler = (options?: unknown) => Record<string, unknown>;
type RequestWithAuth = Request & { auth?: AuthHandler };

function recoveryTestApp(userId: string) {
  const app = express();
  app.use(express.json());
  app.use(clerkMiddleware());
  app.use((req, _res, next) => {
    const request = req as RequestWithAuth;
    const clerkAuth = request.auth;
    if (!clerkAuth) {
      next(new Error("Clerk middleware did not attach an auth handler."));
      return;
    }
    const testAuth = Object.assign(
      (options?: unknown) => ({ ...clerkAuth(options), userId }),
      { [Symbol.for("@clerk/express.auth")]: true },
    );
    request.auth = testAuth;
    next();
  });
  app.use(merchantBusinessToolsRouter);
  app.use((error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Test API error." });
  });
  return app;
}

async function listen(app: express.Express) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Recovery test server did not bind to a TCP port.");
  return {
    server,
    request: (reference: string) => fetch(
      `http://127.0.0.1:${address.port}/merchant/transactions/${encodeURIComponent(reference)}/recovery-link`,
      { method: "POST" },
    ),
  };
}

async function createFailedTransaction(input: {
  reference: string;
  merchantId: number;
  paymentLinkId?: number;
  status?: string;
  settlementStatus?: string;
  customerEmail?: string;
}) {
  const [transaction] = await db.insert(transactionsTable).values({
    reference: input.reference,
    provider: "paystack",
    amount: 25,
    currency: "USD",
    status: input.status ?? "failed",
    settlementStatus: input.settlementStatus ?? "not_applicable",
    customerEmail: input.customerEmail ?? "buyer@example.invalid",
    customerName: "Recovery fixture",
    merchantId: input.merchantId,
    paymentLinkId: input.paymentLinkId ?? null,
  }).returning();
  if (!transaction) throw new Error("Could not create recovery transaction fixture.");
  return transaction;
}

test("recovery retries reject unsafe states, deduplicate concurrent links and email, and stop after success", async () => {
  const ownerId = `recovery-test-${randomUUID()}`;
  const [merchant] = await db.insert(merchantsTable).values({
    ownerClerkId: ownerId,
    businessName: "Payment recovery test fixture",
    country: "SL",
    baseCurrency: "USD",
    status: "active",
    kycStatus: "approved",
    kybStatus: "approved",
  }).returning();
  if (!merchant) throw new Error("Could not create recovery merchant fixture.");

  const references: string[] = [];
  const eventKeys: string[] = [];
  const linkIds: number[] = [];
  const invoiceIds: number[] = [];
  const oldPublicUrl = process.env.PUBLIC_APP_URL;
  const oldDomains = process.env.REPLIT_DOMAINS;
  const oldDevDomain = process.env.REPLIT_DEV_DOMAIN;
  process.env.PUBLIC_APP_URL = "https://payments.greenpay.example";
  let server: Awaited<ReturnType<typeof listen>>["server"] | undefined;
  let request: (reference: string) => Promise<Response>;

  try {
    const started = await listen(recoveryTestApp(ownerId));
    server = started.server;
    request = started.request;

    for (const status of ["pending", "uncertain", "success", "refunded"]) {
      const reference = `RECOVERY-BLOCK-${randomUUID()}`;
      references.push(reference);
      await createFailedTransaction({
        reference,
        merchantId: merchant.id,
        status,
        settlementStatus: status === "success" || status === "refunded" ? "settled" : "not_applicable",
      });
      const response = await request(reference);
      assert.equal(response.status, 409, `${status} payments must not be retried`);
      assert.match((await response.json() as { error: string }).error, /Only a confirmed failed or cancelled payment/);
    }

    const cancelledReference = `RECOVERY-CANCELLED-${randomUUID()}`;
    references.push(cancelledReference);
    await createFailedTransaction({
      reference: cancelledReference,
      merchantId: merchant.id,
      status: "cancelled",
    });
    const cancelledRetry = await request(cancelledReference);
    assert.equal(cancelledRetry.status, 201, "a confirmed cancelled payment may be retried");
    const [cancelled] = await db.select({ id: transactionsTable.id }).from(transactionsTable)
      .where(eq(transactionsTable.reference, cancelledReference));
    if (!cancelled) throw new Error("Cancelled transaction fixture was not persisted.");
    const [cancelledLink] = await db.select().from(paymentLinksTable).where(and(
      eq(paymentLinksTable.merchantId, merchant.id),
      eq(paymentLinksTable.recoveryForTransactionId, cancelled.id),
    ));
    if (!cancelledLink) throw new Error("Cancelled transaction recovery link was not created.");
    linkIds.push(cancelledLink.id);
    eventKeys.push(`payment-recovery:${cancelled.id}:${cancelledLink.id}`);

    const retryReference = `RECOVERY-CONCURRENT-${randomUUID()}`;
    references.push(retryReference);
    const failed = await createFailedTransaction({ reference: retryReference, merchantId: merchant.id });
    const concurrent = await Promise.all([request(retryReference), request(retryReference)]);
    const concurrentBodies = await Promise.all(concurrent.map(async (response) => {
      assert.equal(response.status, 201);
      return response.json() as Promise<{ paymentUrl: string; deliveryStatus: string }>;
    }));
    assert.equal(concurrentBodies[0]?.paymentUrl, concurrentBodies[1]?.paymentUrl);
    assert.equal(concurrentBodies[0]?.deliveryStatus, "queued");
    const recoveryLinks = await db.select().from(paymentLinksTable)
      .where(eq(paymentLinksTable.recoveryForTransactionId, failed.id));
    assert.equal(recoveryLinks.length, 1, "concurrent retries must reuse one recovery link");
    const [recoveryLink] = recoveryLinks;
    if (!recoveryLink) throw new Error("Recovery link was not created.");
    linkIds.push(recoveryLink.id);
    const eventKey = `payment-recovery:${failed.id}:${recoveryLink.id}`;
    eventKeys.push(eventKey);
    const outboxRows = await db.select().from(transactionalEmailOutboxTable)
      .where(eq(transactionalEmailOutboxTable.eventKey, eventKey));
    assert.equal(outboxRows.length, 1, "concurrent retries must enqueue one email event");

    for (const deliveryState of ["sending", "sent", "uncertain", "failed"]) {
      await db.update(transactionalEmailOutboxTable).set({
        deliveryState,
        updatedAt: new Date(),
      }).where(eq(transactionalEmailOutboxTable.eventKey, eventKey));
      const replay = await request(retryReference);
      assert.equal(replay.status, 201);
      assert.equal((await replay.json() as { deliveryStatus: string }).deliveryStatus, deliveryState);
    }

    const secondRetryReference = `RECOVERY-SUCCESS-${randomUUID()}`;
    references.push(secondRetryReference);
    const secondFailed = await createFailedTransaction({
      reference: secondRetryReference,
      merchantId: merchant.id,
    });
    const createdResponse = await request(secondRetryReference);
    assert.equal(createdResponse.status, 201);
    const createdBody = await createdResponse.json() as { deliveryStatus: string };
    assert.equal(createdBody.deliveryStatus, "queued");
    const [secondLink] = await db.select().from(paymentLinksTable)
      .where(eq(paymentLinksTable.recoveryForTransactionId, secondFailed.id));
    if (!secondLink) throw new Error("Second recovery link was not created.");
    linkIds.push(secondLink.id);
    const secondEventKey = `payment-recovery:${secondFailed.id}:${secondLink.id}`;
    eventKeys.push(secondEventKey);
    const [pendingRecoveryPayment] = await db.insert(transactionsTable).values({
      reference: `RECOVERY-PAID-${randomUUID()}`,
      provider: "paystack",
      amount: secondFailed.amount,
      currency: secondFailed.currency,
      status: "pending",
      settlementStatus: "not_applicable",
      customerEmail: secondFailed.customerEmail,
      merchantId: merchant.id,
      paymentLinkId: secondLink.id,
    }).returning();
    if (!pendingRecoveryPayment) throw new Error("Could not create recovery payment fixture.");
    references.push(pendingRecoveryPayment.reference);
    await markTransactionStatus(pendingRecoveryPayment.reference, { status: "success" });
    const [archivedRecoveryLink] = await db.select().from(paymentLinksTable)
      .where(eq(paymentLinksTable.id, secondLink.id));
    assert.equal(archivedRecoveryLink?.status, "archived");
    const blockedReplay = await request(secondRetryReference);
    assert.equal(blockedReplay.status, 409, "a successful recovery must block later retries");
    assert.match((await blockedReplay.json() as { error: string }).error, /already succeeded/);

    const invoiceLinkSlug = `invoice-retry-${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const [invoiceLink] = await db.insert(paymentLinksTable).values({
      slug: invoiceLinkSlug,
      name: "Invoice recovery fixture",
      amountType: "fixed",
      amount: 50,
      currency: "USD",
      status: "active",
      merchantId: merchant.id,
    }).returning();
    if (!invoiceLink) throw new Error("Could not create invoice payment link fixture.");
    linkIds.push(invoiceLink.id);
    const [invoice] = await db.insert(merchantInvoicesTable).values({
      merchantId: merchant.id,
      reference: `INV-RECOVERY-${randomUUID()}`,
      customerName: "Invoice recovery fixture",
      customerEmail: "invoice-buyer@example.invalid",
      currency: "USD",
      dueDate: "2030-01-01",
      lines: [{ description: "Service", quantity: 1, unitAmount: 50, total: 50 }],
      subtotal: 50,
      total: 50,
      paymentLinkAmount: 50,
      status: "sent",
      paymentLinkId: invoiceLink.id,
    }).returning();
    if (!invoice) throw new Error("Could not create invoice fixture.");
    invoiceIds.push(invoice.id);
    const invoiceFailureReference = `RECOVERY-INVOICE-${randomUUID()}`;
    references.push(invoiceFailureReference);
    await createFailedTransaction({
      reference: invoiceFailureReference,
      merchantId: merchant.id,
      paymentLinkId: invoiceLink.id,
      customerEmail: invoice.customerEmail,
    });
    const invoiceRetry = await request(invoiceFailureReference);
    assert.equal(invoiceRetry.status, 201);
    assert.equal((await invoiceRetry.json() as { paymentUrl: string }).paymentUrl,
      `https://payments.greenpay.example/pay/${invoiceLinkSlug}`,
      "invoice retries must reuse the invoice link rather than create a generic recovery link");
    const [invoiceFailure] = await db.select({ id: transactionsTable.id }).from(transactionsTable)
      .where(eq(transactionsTable.reference, invoiceFailureReference));
    if (!invoiceFailure) throw new Error("Invoice failure fixture was not persisted.");
    const invoiceEventKey = `payment-recovery:${invoiceFailure.id}:${invoiceLink.id}`;
    eventKeys.push(invoiceEventKey);
    const [invoiceEmail] = await db.select().from(transactionalEmailOutboxTable)
      .where(eq(transactionalEmailOutboxTable.eventKey, invoiceEventKey));
    assert.ok(invoiceEmail, "invoice retry must queue the customer email");

    const invoicePaymentReference = `RECOVERY-INVOICE-PAID-${randomUUID()}`;
    references.push(invoicePaymentReference);
    await db.insert(transactionsTable).values({
      reference: invoicePaymentReference,
      provider: "paystack",
      amount: 50,
      currency: "USD",
      status: "pending",
      settlementStatus: "not_applicable",
      customerEmail: invoice.customerEmail,
      merchantId: merchant.id,
      paymentLinkId: invoiceLink.id,
    });
    await markTransactionStatus(invoicePaymentReference, { status: "success" });
    const [paidInvoiceLink] = await db.select().from(paymentLinksTable)
      .where(eq(paymentLinksTable.id, invoiceLink.id));
    assert.equal(paidInvoiceLink?.status, "archived", "a fully paid invoice must invalidate its checkout link immediately");
    const blockedInvoiceRetry = await request(invoiceFailureReference);
    assert.equal(blockedInvoiceRetry.status, 409, "a fully paid invoice must not receive another retry link");

    const stateFixtureReference = `RECOVERY-UNCONFIGURED-${randomUUID()}`;
    references.push(stateFixtureReference);
    await createFailedTransaction({ reference: stateFixtureReference, merchantId: merchant.id });
    delete process.env.PUBLIC_APP_URL;
    if (!process.env.REPLIT_DOMAINS && !process.env.REPLIT_DEV_DOMAIN) {
      process.env.REPLIT_DOMAINS = "https://payments.greenpay.example";
    }
    const unconfigured = await request(stateFixtureReference);
    assert.equal(unconfigured.status, 201);
    assert.equal((await unconfigured.json() as { deliveryStatus: string }).deliveryStatus, "unconfigured");
  } finally {
    if (oldPublicUrl === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = oldPublicUrl;
    if (oldDomains === undefined) delete process.env.REPLIT_DOMAINS;
    else process.env.REPLIT_DOMAINS = oldDomains;
    if (oldDevDomain === undefined) delete process.env.REPLIT_DEV_DOMAIN;
    else process.env.REPLIT_DEV_DOMAIN = oldDevDomain;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    if (references.length) {
      await db.delete(settlementsTable).where(inArray(settlementsTable.reference, references));
      await db.delete(financialNotificationEventsTable)
        .where(inArray(financialNotificationEventsTable.reference, references));
      await db.delete(transactionsTable).where(inArray(transactionsTable.reference, references));
    }
    if (eventKeys.length) {
      await db.delete(transactionalEmailOutboxTable)
        .where(inArray(transactionalEmailOutboxTable.eventKey, eventKeys));
    }
    if (invoiceIds.length) await db.delete(merchantInvoicesTable).where(inArray(merchantInvoicesTable.id, invoiceIds));
    if (linkIds.length) await db.delete(paymentLinksTable).where(inArray(paymentLinksTable.id, linkIds));
    await db.delete(merchantsTable).where(eq(merchantsTable.id, merchant.id));
  }
});