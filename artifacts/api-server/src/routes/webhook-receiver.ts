import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { db, payoutsTable, refundsTable } from "@workspace/db";
import {
  asObject,
  numberValue,
  stringValue,
  verifyProviderPayment,
  verifyWebhookSignature,
  type PaymentStatus,
} from "../lib/greenpay-provider";
import { findTransaction, markTransactionStatus, recordWebhookEvent } from "../lib/greenpay-ledger";

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

  if (provider === "paystack" && !verifyWebhookSignature("paystack", rawBody, req.get("x-paystack-signature"))) {
    res.status(401).json({ error: "Invalid Paystack signature." });
    return;
  }
  if (provider === "payzaapi" && !verifyWebhookSignature("payzaapi", rawBody, req.get("x-payza-signature"))) {
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
    if (provider === "payzaapi" && event === "payment.refunded") {
      const originalReference = stringValue(payzaMetadata.original_reference);
      if (originalReference && reference) {
        await db.update(refundsTable).set({ status: "recorded" })
          .where(eq(refundsTable.providerReference, reference));
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