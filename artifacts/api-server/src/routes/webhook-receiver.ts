import { createHash, createHmac } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
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
  findTransaction, markTransactionStatus, reconcilePaystackRefund, recordRefund, recordWebhookEvent,
} from "../lib/greenpay-ledger";
import { providerCredential } from "../lib/credential-runtime";
import { equalSignature } from "../lib/secure-storage";
import { diditDecisionStatus, diditStatusNeedsRefresh, timestampIsFresh } from "../lib/security-policy";
import { payoutConfirmationTimestamp } from "../lib/payment-safety";
import { setWalletPayoutStatusFromProvider } from "../lib/wallet-service";

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
        .where(or(
          eq(merchantsTable.diditSessionId, sessionId),
          eq(merchantsTable.diditKybSessionId, sessionId),
        )).for("update").limit(1);
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

      let activeMerchant = lockedMerchant;
      if (activeMerchant.diditKind === "kyb" && !activeMerchant.diditKybSessionId && activeMerchant.diditSessionId === sessionId) {
        const [migrated] = await tx.update(merchantsTable).set({
          diditKybSessionId: activeMerchant.diditSessionId,
          diditKybSessionUrl: activeMerchant.diditSessionUrl,
          kybStatus: activeMerchant.kycStatus,
          kybVerificationUpdatedAt: activeMerchant.verificationUpdatedAt,
          diditSessionId: null,
          diditSessionUrl: null,
          diditKind: null,
          kycStatus: "not_started",
          verificationUpdatedAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(merchantsTable.id, activeMerchant.id),
          eq(merchantsTable.diditSessionId, sessionId),
        )).returning();
        if (migrated) activeMerchant = migrated;
      }
      const kind = activeMerchant.diditSessionId === sessionId ? "kyc" : "kyb";
      const currentStatus = kind === "kyc" ? activeMerchant.kycStatus : activeMerchant.kybStatus;
      if (!diditStatusNeedsRefresh(currentStatus, sessionId)) {
        await tx.insert(webhookEventsTable).values({
          deliveryKey, provider: "didit", event, reference: sessionId,
          status: "ignored", httpStatus: 200,
        }).onConflictDoNothing();
        return { status: "ignored" };
      }

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
      if (currentStatus !== mapped) {
        const now = new Date();
        const changes = kind === "kyc"
          ? {
              kycStatus: mapped, verificationUpdatedAt: now,
              ...(mapped === "approved" && activeMerchant.status === "pending" ? { status: "active" } : {}),
              updatedAt: now,
            }
          : { kybStatus: mapped, kybVerificationUpdatedAt: now, updatedAt: now };
        await tx.update(merchantsTable).set(changes).where(and(
          eq(merchantsTable.id, activeMerchant.id),
          kind === "kyc"
            ? eq(merchantsTable.diditSessionId, sessionId)
            : eq(merchantsTable.diditKybSessionId, sessionId),
        ));
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
  const payzaPayout = asObject(payload.payout ?? payload.data);
  const payheroResponse = asObject(payload.response);
  const event = stringValue(payload.event) ?? "provider.callback";
  const reference = provider === "paystack"
    ? stringValue(paystackData.reference)
    : provider === "payhero"
      ? stringValue(payheroResponse.ExternalReference) ?? stringValue(payload.ExternalReference)
      : stringValue(payload.client_reference) ??
        stringValue(payload.merchant_reference) ??
        stringValue(payload.external_reference) ??
        stringValue(payzaPayout.client_reference) ??
        stringValue(payzaPayout.merchant_reference) ??
        stringValue(payzaPayout.external_reference) ??
        stringValue(payload.reference) ??
        stringValue(payzaPayout.reference) ??
        stringValue(payzaPayout.id);
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
        const matchingRefunds = await db.select().from(refundsTable).where(and(
          eq(refundsTable.provider, "payzaapi"),
          eq(refundsTable.providerReference, reference),
          eq(refundsTable.originalReference, originalReference),
        ));
        for (const refund of matchingRefunds) {
          await recordRefund({
            originalReference,
            reservationId: refund.id,
            provider: "payzaapi",
            providerReference: reference,
            source: "reconciliation",
            amount: Number(refund.amount),
            currency: refund.currency,
            status: "recorded",
            reason: refund.reason,
          });
        }
      }
    } else if (provider === "payzaapi" && event.startsWith("payout.")) {
      if (!reference) {
        eventStatus = "failed";
        httpStatus = 503;
        lastError = "Payout callback has no client or provider reference; the event is retained for manual reconciliation.";
      } else {
        const normalizedStatus = normalizePayoutStatus(payload.status ?? payzaPayout.status);
        const merchantStatus = ["completed", "rejected", "failed"].includes(normalizedStatus)
          ? normalizedStatus as "completed" | "rejected" | "failed"
          : "processing";
        const matchedWalletRequest = await setWalletPayoutStatusFromProvider("payzaapi", reference, merchantStatus);
        if (!matchedWalletRequest) {
          const [payout] = await db.select().from(payoutsTable).where(and(
            eq(payoutsTable.provider, "payzaapi"),
            or(
              eq(payoutsTable.providerReference, reference),
              eq(payoutsTable.reference, reference),
            ),
          )).limit(1);
          if (!payout) {
            eventStatus = "failed";
            httpStatus = 503;
            lastError = "Payout callback did not match a persisted wallet or platform payout; the event is retained for reconciliation.";
          } else {
            await db.transaction(async (tx) => {
              const [current] = await tx.select().from(payoutsTable)
                .where(eq(payoutsTable.id, payout.id)).for("update").limit(1);
              if (!current || ["completed", "rejected", "failed"].includes(current.status)) return;
              await tx.update(payoutsTable).set({
                providerReference: current.reference === reference
                  ? current.providerReference
                  : reference,
                status: normalizedStatus,
                confirmedAt: payoutConfirmationTimestamp(current.status, current.confirmedAt, normalizedStatus),
              }).where(eq(payoutsTable.id, current.id));
            });
          }
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