import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { createHmac } from "node:crypto";
import { and, eq, gte, lt, or } from "drizzle-orm";
import {
  db, merchantWebhookOutboxTable,
} from "@workspace/db";
import { logger } from "./logger";
import { decryptSecret, resolvePublicWebhookUrl } from "./secure-storage";
import { createPinnedWebhookLookup } from "./network-safety";

const CLAIM_LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 20;
let dispatching = false;
let outboxTimer: NodeJS.Timeout | undefined;

async function sendPinnedHttps(
  serializedUrl: string,
  body: string,
  event: string,
  deliveryId: string,
  encryptedSecret: string,
): Promise<number> {
  const { url, addresses } = await resolvePublicWebhookUrl(serializedUrl);
  const destinationHost = url.hostname.replace(/^\[|\]$/g, "");
  const pinnedAddress = addresses[0]!;
  const lookupPinned = createPinnedWebhookLookup(pinnedAddress);
  const signature = createHmac("sha256", decryptSecret(encryptedSecret)).update(body, "utf8").digest("hex");

  return new Promise<number>((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: destinationHost,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      agent: false,
      lookup: lookupPinned,
      ...(isIP(destinationHost) ? {} : { servername: destinationHost }),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Greenpay-Event": event,
        "X-Greenpay-Delivery": deliveryId,
        "X-Greenpay-Signature": `sha256=${signature}`,
      },
      timeout: 5_000,
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once("end", () => resolve(status));
    });
    request.once("timeout", () => request.destroy(new Error("Webhook delivery timed out.")));
    request.once("error", reject);
    request.end(body);
  });
}

export async function dispatchPendingMerchantWebhooks(): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    const now = new Date();
    const staleLock = new Date(now.getTime() - CLAIM_LEASE_MS);
    const claimed = await db.transaction(async (tx) => {
      await tx.update(merchantWebhookOutboxTable).set({
        status: "failed", lockedAt: null, updatedAt: now,
      }).where(and(
        eq(merchantWebhookOutboxTable.status, "processing"),
        gte(merchantWebhookOutboxTable.attempts, MAX_DELIVERY_ATTEMPTS),
        lt(merchantWebhookOutboxTable.lockedAt, staleLock),
      ));
      const rows = await tx.select().from(merchantWebhookOutboxTable).where(and(
        or(
          and(eq(merchantWebhookOutboxTable.status, "pending"), lt(merchantWebhookOutboxTable.nextAttemptAt, now)),
          and(eq(merchantWebhookOutboxTable.status, "processing"), lt(merchantWebhookOutboxTable.lockedAt, staleLock)),
        ),
        lt(merchantWebhookOutboxTable.attempts, MAX_DELIVERY_ATTEMPTS),
      )).for("update", { skipLocked: true }).limit(50);
      const output = [];
      for (const row of rows) {
        const [updated] = await tx.update(merchantWebhookOutboxTable).set({
          status: "processing", lockedAt: now, attempts: row.attempts + 1, updatedAt: now,
        }).where(eq(merchantWebhookOutboxTable.id, row.id)).returning();
        if (updated) output.push(updated);
      }
      return output;
    });

    await Promise.all(claimed.map(async (delivery) => {
      try {
        const statusCode = await sendPinnedHttps(
          delivery.destinationUrl, delivery.payload, delivery.event,
          delivery.deliveryId, delivery.encryptedSecret,
        );
        if (statusCode >= 200 && statusCode < 300) {
          await db.update(merchantWebhookOutboxTable).set({
            status: "delivered", lockedAt: null, lastStatusCode: statusCode,
            lastError: null, updatedAt: new Date(),
          }).where(eq(merchantWebhookOutboxTable.id, delivery.id));
        } else {
          const exhausted = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
          await db.update(merchantWebhookOutboxTable).set({
            status: exhausted ? "failed" : "pending",
            lockedAt: null,
            lastStatusCode: statusCode || null,
            lastError: `HTTP ${statusCode}`,
            nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 1000 * 2 ** Math.min(delivery.attempts, 12))),
            updatedAt: new Date(),
          }).where(eq(merchantWebhookOutboxTable.id, delivery.id));
          logger.warn({ endpointId: delivery.endpointId, statusCode }, "Merchant webhook delivery was rejected");
        }
      } catch (error) {
        const exhausted = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
        await db.update(merchantWebhookOutboxTable).set({
          status: exhausted ? "failed" : "pending",
          lockedAt: null,
          lastError: "Network or TLS delivery error.",
          nextAttemptAt: new Date(Date.now() + Math.min(60 * 60_000, 1000 * 2 ** Math.min(delivery.attempts, 12))),
          updatedAt: new Date(),
        }).where(eq(merchantWebhookOutboxTable.id, delivery.id));
        logger.warn({ endpointId: delivery.endpointId, errorKind: error instanceof Error ? error.name : "unknown" }, "Merchant webhook delivery failed");
      }
    }));
  } finally {
    dispatching = false;
  }
}

export function startMerchantWebhookOutboxWorker(): void {
  if (outboxTimer) return;
  const drain = () => {
    void dispatchPendingMerchantWebhooks().catch((error) => {
      logger.error(
        { errorKind: error instanceof Error ? error.name : "unknown" },
        "Merchant webhook outbox drain failed",
      );
    });
  };
  drain();
  outboxTimer = setInterval(drain, 5_000);
  outboxTimer.unref();
}

export function stopMerchantWebhookOutboxWorker(): void {
  if (!outboxTimer) return;
  clearInterval(outboxTimer);
  outboxTimer = undefined;
}

export async function enqueueMerchantWebhookOutbox(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  transaction: {
    id: number;
    reference: string;
    merchantId: number | null;
    amount: number;
    currency: string;
    status: string;
    paymentLinkId: number | null;
  },
  event: string,
  endpoints: Array<{ id: number; url: string; encryptedSecret: string; events: string[] }>,
): Promise<void> {
  if (transaction.merchantId === null) return;
  const matching = endpoints.filter((endpoint) => endpoint.events.includes(event));
  if (!matching.length) return;
  const createdAt = new Date().toISOString();
  const payload = JSON.stringify({
    id: `evt_${transaction.reference}_${event}`,
    type: event,
    createdAt,
    data: {
      reference: transaction.reference, amount: Number(transaction.amount),
      currency: transaction.currency, status: transaction.status,
      paymentLinkId: transaction.paymentLinkId,
    },
  });
  await tx.insert(merchantWebhookOutboxTable).values(matching.map((endpoint) => ({
    transactionId: transaction.id,
    merchantId: transaction.merchantId!,
    endpointId: endpoint.id,
    event,
    deliveryId: `evt_${transaction.reference}_${event}`,
    destinationUrl: endpoint.url,
    encryptedSecret: endpoint.encryptedSecret,
    payload,
  }))).onConflictDoNothing();
}