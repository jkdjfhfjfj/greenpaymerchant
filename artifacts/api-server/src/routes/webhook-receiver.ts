import { createHash, createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, payoutsTable, refundsTable, merchantsTable, webhookEventsTable } from "@workspace/db";
import {
  asObject,
  numberValue,
  stringValue,
  verifyProviderPayment,
  verifyWebhookSignature,
  type PaymentStatus,
} from "../lib/greenpay-provider";
import {
  findTransaction, markTransactionStatus, reconcilePaystackRefund, recordWebhookEvent,
} from "../lib/greenpay-ledger";
import { providerCredential } from "../lib/credential-runtime";
import { equalSignature } from "../lib/secure-storage";
import { diditDecisionStatus, timestampIsFresh } from "../lib/security-policy";

const router: IRouter = Router();

router.post("/didit", async (req, res): Promise<void> => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const timestamp = req.get("x-timestamp") ?? undefined;
  const received = req.get("x-signature") ?? undefined;
  const secret = await providerCredential("didit", "DIDIT_WEBHOOK_SECRET");
  if (!secret || !timestampIsFresh(timestamp) || !received) {
    res.status(401).json({ error: "Invalid or expired Didit webhook signature." });
    return;
  }
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!equalSignature(expected, received)) {
    res.status(401).json({ error: "Invalid or expired Didit webhook signature." });
    return;
  }
  let payload: Record<string, unknown>;
  try { payload = asObject(JSON.parse(rawBody.toString("utf8"))); }
  catch { res.status(400).json({ error: "Webhook body must be valid JSON." }); return; }

  const sessionId = stringValue(payload.session_id);
  const event = stringValue(payload.webhook_type) ?? "status.updated";
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const deliveryKey = `didit:${bodyHash}`;
  const [duplicate] = await db.select({ id: webhookEventsTable.id }).from(webhookEventsTable)
    .where(eq(webhookEventsTable.deliveryKey, deliveryKey)).limit(1);
  if (duplicate) {
    res.json({ received: true, status: "duplicate" });
    return;
  }
  if (!sessionId || event !== "status.updated") {
    await recordWebhookEvent({
      deliveryKey, provider: "didit", event,
      reference: sessionId, status: "ignored", httpStatus: 200,
    });
    res.json({ received: true, status: "ignored" });
    return;
  }
  const apiKey = await providerCredential("didit", "DIDIT_API_KEY");
  if (!apiKey) { res.status(503).json({ error: "Didit API credentials are not configured for authoritative decision verification." }); return; }
  let outcome: { status: string };
  try {
    outcome = await db.transaction(async (tx) => {
      const [lockedMerchant] = await tx.select().from(merchantsTable)
        .where(eq(merchantsTable.diditSessionId, sessionId)).for("update").limit(1);
      if (!lockedMerchant) {
        await tx.insert(webhookEventsTable).values({
          deliveryKey, provider: "didit", event, reference: sessionId,
          status: "ignored", httpStatus: 200,
        }).onConflictDoNothing();
        return { status: "ignored" };
      }
      const [existingEvent] = await tx.select({ id: webhookEventsTable.id }).from(webhookEventsTable)
        .where(eq(webhookEventsTable.deliveryKey, deliveryKey)).limit(1);
      if (existingEvent) return { status: "duplicate" };

      const decisionResponse = await fetch(`https://verification.didit.me/v3/session/${encodeURIComponent(sessionId)}/decision/`, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(10_000),
      });
      if (!decisionResponse.ok) throw new Error("Didit decision service could not confirm the session.");
      const mapped = diditDecisionStatus(await decisionResponse.json(), sessionId);
      if (!mapped) {
        await tx.insert(webhookEventsTable).values({
          deliveryKey, provider: "didit", event, reference: sessionId,
          status: "ignored", httpStatus: 200,
        }).onConflictDoNothing();
        return { status: "ignored" };
      }
      if (lockedMerchant.kycStatus !== mapped) {
        await tx.update(merchantsTable).set({
          kycStatus: mapped, verificationUpdatedAt: new Date(), updatedAt: new Date(),
        }).where(and(eq(merchantsTable.id, lockedMerchant.id), eq(merchantsTable.diditSessionId, sessionId)));
      }
      await tx.insert(webhookEventsTable).values({
        deliveryKey, provider: "didit", event, reference: sessionId,
        status: "processed", httpStatus: 200,
      }).onConflictDoNothing();
      return { status: mapped };
    });
  } catch {
    res.status(503).json({ error: "Didit decision could not be verified; verification state was not changed." });
    return;
  }
  res.json({ received: true, status: outcome.status });
});

function mapPaymentStatus(value: unknown): PaymentStatus {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["success", "successful", "paid", "completed"].includes(status)) return "success";
  if (["failed", "failure", "declined"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  return "pending";
}

function verifyWebhookAmount(body: Record<string, unknown>, amountDivisor: number, expectedAmount: number, expectedCurrency: string): void {
  const actualAmount = numberValue(body.amount);
  const actualCurrency = stringValue(body.currency)?.toUpperCase();
  if (actualAmount === undefined || actualCurrency !== expectedCurrency.toUpperCase()) {
    throw new Error("Webhook amount or currency is missing.");
  }
  if (Math.abs(actualAmount / amountDivisor - expectedAmount) > 0.011) {
    throw new Error("Webhook amount does not match the Greenpay transaction.");
  }
}

function normalizePayoutStatus(value: unknown): string {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (["pending", "processing", "approved", "completed", "rejected", "failed"].includes(status)) return status;
  return "processing";
}

router.post("/:provider", async (req, res): Promise<void> => {
  const provider = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
  if (!["paystack", "payhero", "payzaapi"].includes(provider)) {
    res.status(404).json({ error: "Unknown provider." });
    return;
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (rawBody.length === 0) {
    res.status(400).json({ error: "Webhook body is required." });
    return;
  }

  if (provider === "paystack" && !await verifyWebhookSignature("paystack", rawBody, req.get("x-paystack-signature"))) {
    res.status(401).json({ error: "Invalid Paystack signature." });
    return;
  }
  if (provider === "payzaapi" && !await verifyWebhookSignature("payzaapi", rawBody, req.get("x-payza-signature"))) {
    res.status(401).json({ error: "Invalid Payzaapi signature." });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = asObject(JSON.parse(rawBody.toString("utf8")));
  } catch {
    res.status(400).json({ error: "Webhook body must be valid JSON." });
    return;
  }

  const paystackData = asObject(payload.data);
  const payzaMetadata = asObject(payload.metadata);
  const payheroResponse = asObject(payload.response);
  const event = stringValue(payload.event) ?? "provider.callback";
  const reference = provider === "paystack"
    ? stringValue(paystackData.reference)
    : provider === "payhero"
      ? stringValue(payheroResponse.ExternalReference) ?? stringValue(payload.ExternalReference)
      : stringValue(payload.reference);
  const deliveryKey = createHash("sha256").update(rawBody).digest("hex");
  let eventStatus = "processed";
  let httpStatus = 200;
  let lastError: string | null = null;

  try {
    if (provider === "paystack" && event.startsWith("refund.")) {
      const refundId = paystackData.id === undefined ? undefined : String(paystackData.id);
      if (!refundId) {
        eventStatus = "ignored";
      } else {
        const result = await reconcilePaystackRefund(refundId, paystackData);
        if (result === "unmatched") {
          eventStatus = "failed";
          httpStatus = 503;
          lastError = "Paystack refund does not match a pending Greenpay refund reservation.";
        } else if (result === "ignored") {
          eventStatus = "ignored";
        }
      }
    } else if (provider === "payzaapi" && event === "payment.refunded") {
      const originalReference = stringValue(payzaMetadata.original_reference);
      if (originalReference && reference) {
        await db.update(refundsTable).set({ status: "recorded" })
          .where(and(
            eq(refundsTable.provider, "payzaapi"),
            eq(refundsTable.providerReference, reference),
            eq(refundsTable.originalReference, originalReference),
          ));
      }
    } else if (provider === "payzaapi" && event.startsWith("payout.")) {
      if (!reference) {
        eventStatus = "ignored";
      } else {
        const [payout] = await db.select().from(payoutsTable).where(and(
          eq(payoutsTable.provider, "payzaapi"),
          eq(payoutsTable.providerReference, reference),
        )).limit(1);
        if (!payout) {
          eventStatus = "ignored";
        } else {
          await db.update(payoutsTable).set({ status: normalizePayoutStatus(payload.status) })
            .where(eq(payoutsTable.id, payout.id));
        }
      }
    } else if (!reference) {
      eventStatus = "ignored";
    } else {
      const transaction = await findTransaction(reference);
      if (!transaction || transaction.provider !== provider) {
        eventStatus = "ignored";
      } else if (provider === "payhero") {
        const verified = await verifyProviderPayment(transaction);
        await markTransactionStatus(reference, verified);
      } else {
        const data = provider === "paystack" ? paystackData : payload;
        const amountDivisor = provider === "paystack" ? 100 : 1;
        verifyWebhookAmount(data, amountDivisor, Number(transaction.amount), transaction.currency);
        const verifiedStatus = mapPaymentStatus(
          provider === "paystack" ? paystackData.status : payload.status,
        );
        const fee = numberValue(provider === "paystack" ? paystackData.fees : payload.fee);
        const dateValue = stringValue(provider === "paystack" ? paystackData.paid_at : payload.paid_at);
        const paidAt = dateValue ? new Date(dateValue) : null;
        await markTransactionStatus(reference, {
          status: verifiedStatus,
          fee: fee === undefined ? null : fee / amountDivisor,
          netAmount: fee === undefined ? null : Math.max(0, Number(transaction.amount) - fee / amountDivisor),
          paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
        });
      }
    }
  } catch (error) {
    eventStatus = "failed";
    httpStatus = 500;
    lastError = error instanceof Error ? error.message.slice(0, 500) : "Webhook processing failed.";
    req.log.error({ provider, event, reference, err: error }, "Provider webhook processing failed");
  }

  await recordWebhookEvent({
    deliveryKey,
    provider,
    event,
    reference,
    status: eventStatus,
    httpStatus,
    lastError,
  });
  res.status(httpStatus).json({ received: eventStatus !== "failed", status: eventStatus });
});

export default router;