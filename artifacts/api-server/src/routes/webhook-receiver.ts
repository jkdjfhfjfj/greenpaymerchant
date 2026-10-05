import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  ReceiveDiditWebhookBody, ReceiveDiditWebhookResponse, ReceiveStatumAirtimeCallbackBody,
} from "@workspace/api-zod";
import { db, merchantsTable, payoutsTable, refundsTable, webhookEventsTable } from "@workspace/db";
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
import { payoutConfirmationTimestamp } from "../lib/payment-safety";
import { diditDecisionStatus, diditStatusNeedsRefresh } from "../lib/security-policy";
import { setWalletPayoutStatusFromProvider } from "../lib/wallet-service";
import { equalSignature } from "../lib/secure-storage";
import { statumCallbackToken, statumCallbackTokenHash } from "../lib/statum-provider";
import {
  recordAirtimeTopupReconciliationFailure,
  recordStatumCallback,
  reconcileAirtimeTopup,
} from "../lib/airtime-service";

const router: IRouter = Router();
const DIDIT_DECISION_COOLDOWN_MS = 10_000;
const recentDiditDecisionChecks = new Map<string, number>();
const inFlightDiditDecisionChecks = new Set<string>();

router.post("/statum", async (req, res): Promise<void> => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!rawBody.length) {
    res.status(400).json({ error: "Webhook body is required." });
    return;
  }
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const receivedToken = queryToken ?? req.get("x-statum-callback-token");
  if (!receivedToken || receivedToken.length < 16 || receivedToken.length > 256) {
    res.status(401).json({ error: "A valid Statum callback token is required." });
    return;
  }
  let expectedToken: string;
  try {
    expectedToken = await statumCallbackToken();
  } catch {
    res.status(503).json({ error: "Statum callback verification is not configured." });
    return;
  }
  if (!equalSignature(statumCallbackTokenHash(expectedToken), statumCallbackTokenHash(receivedToken))) {
    res.status(401).json({ error: "Invalid Statum callback token." });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(rawBody.toString("utf8"));
    payload = decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : {};
  } catch {
    res.status(400).json({ error: "Webhook body must be valid JSON." });
    return;
  }
  const parsed = ReceiveStatumAirtimeCallbackBody.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = await recordStatumCallback({
      deliveryHash: createHash("sha256").update(rawBody).digest("hex"),
      callback: parsed.data,
    });
    res.json({ received: true, status: result });
  } catch (error) {
    req.log.error({ err: error, requestId: parsed.data.request_id }, "Statum airtime callback could not be reconciled");
    res.status(503).json({ error: "Statum callback was not fully reconciled; retry the notification." });
  }
});

function claimDiditDecisionCheck(sessionId: string): boolean {
  const now = Date.now();
  const lastCheck = recentDiditDecisionChecks.get(sessionId);
  if (inFlightDiditDecisionChecks.has(sessionId) ||
      (lastCheck !== undefined && now - lastCheck < DIDIT_DECISION_COOLDOWN_MS)) {
    return false;
  }
  inFlightDiditDecisionChecks.add(sessionId);
  return true;
}

function releaseDiditDecisionCheck(sessionId: string, completed: boolean): void {
  inFlightDiditDecisionChecks.delete(sessionId);
  if (!completed) return;
  const now = Date.now();
  recentDiditDecisionChecks.set(sessionId, now);
  if (recentDiditDecisionChecks.size > 5_000) {
    for (const [checkedSessionId, checkedAt] of recentDiditDecisionChecks) {
      if (now - checkedAt > 60_000) recentDiditDecisionChecks.delete(checkedSessionId);
      if (recentDiditDecisionChecks.size <= 4_000) break;
    }
  }
}

router.post("/didit", async (req, res): Promise<void> => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (rawBody.length === 0) {
    res.status(400).json({ error: "Webhook body is required." });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = asObject(JSON.parse(rawBody.toString("utf8")));
  } catch {
    res.status(400).json({ error: "Webhook body must be valid JSON." });
    return;
  }
  const parsed = ReceiveDiditWebhookBody.safeParse(payload);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const sessionId = parsed.data.session_id;
  const event = parsed.data.webhook_type ?? "status.updated";
  if (event !== "status.updated") {
    res.json(ReceiveDiditWebhookResponse.parse({ received: true, status: "ignored" }));
    return;
  }

  const deliveryKey = `didit:${createHash("sha256").update(rawBody).digest("hex")}`;
  const [duplicate] = await db.select({
    id: webhookEventsTable.id,
    status: webhookEventsTable.status,
  }).from(webhookEventsTable).where(eq(webhookEventsTable.deliveryKey, deliveryKey)).limit(1);
  if (duplicate && duplicate.status !== "failed") {
    res.json(ReceiveDiditWebhookResponse.parse({ received: true, status: "duplicate" }));
    return;
  }

  // The unsigned notification only identifies a session. Its status is never trusted.
  let activeMerchant = await db.transaction(async (tx) => {
    const [lockedMerchant] = await tx.select().from(merchantsTable)
      .where(or(
        eq(merchantsTable.diditSessionId, sessionId),
        eq(merchantsTable.diditKybSessionId, sessionId),
      )).for("update").limit(1);
    if (!lockedMerchant) return undefined;

    let current = lockedMerchant;
    if (current.diditKind === "kyb" && !current.diditKybSessionId && current.diditSessionId === sessionId) {
      const [migrated] = await tx.update(merchantsTable).set({
        diditKybSessionId: current.diditSessionId,
        diditKybSessionUrl: current.diditSessionUrl,
        kybStatus: current.kycStatus,
        kybVerificationUpdatedAt: current.verificationUpdatedAt,
        diditSessionId: null,
        diditSessionUrl: null,
        diditKind: null,
        kycStatus: "not_started",
        verificationUpdatedAt: null,
        updatedAt: new Date(),
      }).where(and(
        eq(merchantsTable.id, current.id),
        eq(merchantsTable.diditSessionId, sessionId),
      )).returning();
      if (migrated) current = migrated;
    }
    return current;
  });

  if (!activeMerchant) {
    res.json(ReceiveDiditWebhookResponse.parse({ received: true, status: "ignored" }));
    return;
  }

  const kind = activeMerchant.diditSessionId === sessionId ? "kyc" : "kyb";
  const currentStatus = kind === "kyc" ? activeMerchant.kycStatus : activeMerchant.kybStatus;
  if (!diditStatusNeedsRefresh(currentStatus, sessionId)) {
    await recordWebhookEvent({
      deliveryKey, provider: "didit", event, reference: sessionId,
      status: "ignored", httpStatus: 200,
    });
    res.json(ReceiveDiditWebhookResponse.parse({ received: true, status: "ignored" }));
    return;
  }

  const apiKey = await providerCredential("didit", "DIDIT_API_KEY");
  if (!apiKey) {
    res.status(503).json({ error: "Didit API credentials are not configured for decision verification." });
    return;
  }
  if (!claimDiditDecisionCheck(sessionId)) {
    res.json(ReceiveDiditWebhookResponse.parse({ received: true, status: "already_processing" }));
    return;
  }

  let completed = false;
  try {
    const decisionResponse = await fetch(
      `https://verification.didit.me/v3/session/${encodeURIComponent(sessionId)}/decision/`,
      {
        headers: { "x-api-key": apiKey, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!decisionResponse.ok) throw new Error(`Didit decision endpoint returned ${decisionResponse.status}.`);
    const mapped = diditDecisionStatus(await decisionResponse.json(), sessionId);
    if (!mapped) {
      await recordWebhookEvent({
        deliveryKey, provider: "didit", event, reference: sessionId,
        status: "ignored", httpStatus: 200,
      });
      completed = true;
      res.json(ReceiveDiditWebhookResponse.parse({ received: true, status: "ignored" }));
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      const [latest] = await tx.select().from(merchantsTable)
        .where(eq(merchantsTable.id, activeMerchant.id)).for("update").limit(1);
      if (!latest) return { status: "ignored" };

      const latestSessionId = kind === "kyc" ? latest.diditSessionId : latest.diditKybSessionId;
      const latestStatus = kind === "kyc" ? latest.kycStatus : latest.kybStatus;
      if (latestSessionId !== sessionId || !diditStatusNeedsRefresh(latestStatus, latestSessionId)) {
        return { status: "ignored" };
      }
      if (latestStatus === mapped) return { status: mapped };

      const now = new Date();
      const changes = kind === "kyc"
        ? {
            kycStatus: mapped,
            verificationUpdatedAt: now,
            ...(mapped === "approved" && latest.status === "pending" &&
              ["approved", "not_submitted"].includes(latest.applicationStatus) ? { status: "active" } : {}),
            updatedAt: now,
          }
        : { kybStatus: mapped, kybVerificationUpdatedAt: now, updatedAt: now };
      await tx.update(merchantsTable).set(changes).where(and(
        eq(merchantsTable.id, latest.id),
        eq(kind === "kyc" ? merchantsTable.diditSessionId : merchantsTable.diditKybSessionId, sessionId),
      ));
      return { status: mapped };
    });

    await recordWebhookEvent({
      deliveryKey, provider: "didit", event, reference: sessionId,
      status: outcome.status === "ignored" ? "ignored" : "processed", httpStatus: 200,
    });
    completed = true;
    res.json(ReceiveDiditWebhookResponse.parse({ received: true, status: outcome.status }));
  } catch (error) {
    req.log.error({ sessionId, event, err: error }, "Didit notification could not be confirmed through the decision API");
    res.status(503).json({ error: "Didit decision could not be verified; verification state was not changed." });
  } finally {
    releaseDiditDecisionCheck(sessionId, completed);
  }
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
    } else if (provider === "payhero") {
      const airtimeTopupStatus = await reconcileAirtimeTopup(reference);
      if (airtimeTopupStatus === "not_found") {
        const transaction = await findTransaction(reference);
        if (!transaction || transaction.provider !== provider) {
          eventStatus = "ignored";
        } else {
          const verified = await verifyProviderPayment(transaction);
          await markTransactionStatus(reference, verified);
        }
      }
    } else {
      const transaction = await findTransaction(reference);
      if (!transaction || transaction.provider !== provider) {
        eventStatus = "ignored";
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
        const failureData = provider === "paystack" ? paystackData : payload;
        await markTransactionStatus(reference, {
          status: verifiedStatus,
          fee: fee === undefined ? null : fee / amountDivisor,
          netAmount: fee === undefined ? null : Math.max(0, Number(transaction.amount) - fee / amountDivisor),
          paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
          reason: stringValue(failureData.gateway_response) ?? stringValue(failureData.status_message) ??
            stringValue(failureData.message) ?? stringValue(failureData.reason) ?? null,
        });
      }
    }
  } catch (error) {
    eventStatus = "failed";
    httpStatus = 500;
    lastError = error instanceof Error ? error.message.slice(0, 500) : "Webhook processing failed.";
    if (provider === "payhero" && reference) {
      try {
        await recordAirtimeTopupReconciliationFailure(reference, error);
      } catch {
        // Preserve webhook event recording even if top-up diagnostics cannot be saved.
      }
    }
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