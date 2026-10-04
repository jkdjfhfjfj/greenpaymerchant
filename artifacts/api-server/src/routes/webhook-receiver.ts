import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, payoutsTable, refundsTable, webhookEventsTable } from "@workspace/db";
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
import { payoutConfirmationTimestamp } from "../lib/payment-safety";
import { setWalletPayoutStatusFromProvider } from "../lib/wallet-service";

const router: IRouter = Router();

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