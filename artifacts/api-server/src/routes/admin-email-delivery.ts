import { createHash, randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import { Router, type IRouter } from "express";
import { SendAdminEmailBroadcastBody, SendAdminEmailBroadcastResponse } from "@workspace/api-zod";
import { db, adminAuditLogTable } from "@workspace/db";
import {
  enqueueTransactionalEmailBatch,
  getEmailDeliveryCounts,
  getMailtrapDeliverySettings,
  getTransactionalEmailById,
  listTransactionalEmailOutbox,
  retryTransactionalEmail,
  reviewAndRequeueLegacySupportEmail,
  saveAdminEmailDeliverySettings,
  sendExplicitAdminEmailTest,
} from "../lib/mailtrap-delivery";
import { MailtrapConfigurationError } from "../lib/mailtrap-provider";
import { requireAdmin } from "../middlewares/requireAdmin";
import { transactionalEmailWorkerStatus } from "../lib/transactional-email-worker";
import { ClerkApiError, fetchClerkUser, listActiveClerkUsers, verifiedPrimaryEmail } from "../lib/platform-admin";

const router: IRouter = Router();
const deliveryStates = new Set(["queued", "sending", "sent", "failed", "uncertain", "unconfigured"]);
const purposes = new Set([
  "payment_receipt", "payment_success", "payment_failure", "payout_update", "invoice_reminder",
  "support_reply", "support_receipt", "team_invitation", "admin_test", "admin_broadcast",
]);

function requestActor(req: Parameters<Parameters<IRouter["get"]>[1]>[0]): string {
  return getAuth(req).userId ?? "unknown-admin";
}

async function audit(actor: string, action: string, target: string, details: string): Promise<void> {
  await db.insert(adminAuditLogTable).values({ actor, action, target, details });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Email delivery operation failed.";
}

function handleOperationError(res: Parameters<Parameters<IRouter["get"]>[1]>[1], error: unknown): void {
  if (error instanceof MailtrapConfigurationError) {
    res.status(503).json({ error: error.message });
    return;
  }
  res.status(400).json({ error: errorMessage(error) });
}

router.get("/admin/email-delivery/settings", requireAdmin, async (_req, res): Promise<void> => {
  const [settings, counts] = await Promise.all([
    getMailtrapDeliverySettings(),
    getEmailDeliveryCounts(),
  ]);
  res.json({
    provider: "mailtrap",
    enabled: settings.enabled,
    ready: settings.ready,
    fromEmail: settings.fromEmail,
    senderVerified: settings.senderVerified,
    tokenConfigured: settings.tokenConfigured,
    worker: transactionalEmailWorkerStatus(),
    counts,
  });
});

router.patch("/admin/email-delivery/settings", requireAdmin, async (req, res): Promise<void> => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  if (!body || !Object.keys(body).length ||
    (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
    (body.fromEmail !== undefined && typeof body.fromEmail !== "string") ||
    (body.senderVerified !== undefined && body.senderVerified !== true)) {
    res.status(400).json({ error: "Provide enabled and/or a sender address, and explicitly confirm a sender configured as verified in Mailtrap." });
    return;
  }
  const actor = requestActor(req);
  try {
    await saveAdminEmailDeliverySettings({
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.fromEmail === undefined ? {} : { fromEmail: body.fromEmail }),
      ...(body.senderVerified === undefined ? {} : { senderVerified: true }),
      actorId: actor,
    });
    await audit(actor, "email_delivery.settings_updated", "mailtrap", "Updated Mailtrap enablement and/or sender settings; no API token was read or changed.");
  } catch (error) {
    handleOperationError(res, error);
    return;
  }
  const [settings, counts] = await Promise.all([
    getMailtrapDeliverySettings(),
    getEmailDeliveryCounts(),
  ]);
  res.json({
    provider: "mailtrap",
    enabled: settings.enabled,
    ready: settings.ready,
    fromEmail: settings.fromEmail,
    senderVerified: settings.senderVerified,
    tokenConfigured: settings.tokenConfigured,
    worker: transactionalEmailWorkerStatus(),
    counts,
  });
});

router.post("/admin/email-delivery/test", requireAdmin, async (req, res): Promise<void> => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  const recipientEmail = typeof body?.recipientEmail === "string" ? body.recipientEmail.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 254) {
    res.status(400).json({ error: "Enter a valid test recipient email address." });
    return;
  }
  const actor = requestActor(req);
  try {
    const result = await sendExplicitAdminEmailTest({ recipientEmail, actorId: actor });
    await audit(actor, "email_delivery.test_sent", "mailtrap", `User-triggered Mailtrap test to ${recipientEmail}: ${result.deliveryState}.`);
    res.json(result);
  } catch (error) {
    handleOperationError(res, error);
  }
});

router.post("/admin/email-delivery/broadcast", requireAdmin, async (req, res): Promise<void> => {
  const parsed = SendAdminEmailBroadcastBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const subject = parsed.data.subject.trim();
  const message = parsed.data.message.trim();
  if (subject.length < 2 || message.length < 2) {
    res.status(400).json({ error: "Provide a subject and message with at least two non-space characters." });
    return;
  }
  if (parsed.data.audience === "all" && parsed.data.confirmAll !== true) {
    res.status(400).json({ error: "Confirm that this message should go to every verified account." });
    return;
  }

  const settings = await getMailtrapDeliverySettings();
  if (!settings.ready) {
    res.status(503).json({ error: "Email delivery is not configured and verified." });
    return;
  }

  let recipientEmails: string[] = [];
  let skippedUnverified = 0;
  try {
    if (parsed.data.audience === "user") {
      const userId = parsed.data.userId?.trim();
      if (!userId) { res.status(400).json({ error: "Choose a user account to receive this message." }); return; }
      const user = await fetchClerkUser(userId);
      const email = verifiedPrimaryEmail(user);
      if (!email) {
        res.status(400).json({ error: "This account does not have a verified primary email address." });
        return;
      }
      recipientEmails = [email.toLowerCase()];
    } else {
      const result = await listActiveClerkUsers();
      if (result.truncated) {
        res.status(413).json({ error: "The account directory exceeds the 10,000-recipient broadcast limit." });
        return;
      }
      const verified = result.users.flatMap((user) => {
        const email = verifiedPrimaryEmail(user);
        return email ? [email.toLowerCase()] : [];
      });
      skippedUnverified = result.users.length - verified.length;
      recipientEmails = [...new Set(verified)];
    }
  } catch (error) {
    if (error instanceof ClerkApiError && error.status === 404) {
      res.status(404).json({ error: "The selected user account was not found." });
      return;
    }
    req.log.error({ err: error }, "Could not resolve email broadcast recipients");
    res.status(503).json({ error: "Verified account email addresses could not be loaded." });
    return;
  }

  const broadcastId = randomUUID();
  try {
    const queued = await enqueueTransactionalEmailBatch(recipientEmails.map((recipientEmail) => ({
      eventKey: `admin-broadcast:${broadcastId}:${createHash("sha256").update(recipientEmail).digest("hex")}`,
      purpose: "admin_broadcast",
      recipientEmail,
      template: "admin_broadcast",
      subject,
      payload: { subject, message },
    })));
    try {
      await audit(
        requestActor(req),
        "email_delivery.broadcast_queued",
        `broadcast:${broadcastId}`,
        `Queued ${queued.queued} message(s) for ${parsed.data.audience === "all" ? "all verified users" : "one selected user"}.`,
      );
    } catch (error) {
      req.log.error({ err: error, broadcastId, queuedRecipients: queued.queued }, "Broadcast queued but audit entry failed");
    }
    res.status(202).json(SendAdminEmailBroadcastResponse.parse({
      broadcastId,
      audience: parsed.data.audience,
      queuedRecipients: queued.queued,
      skippedUnverified,
    }));
  } catch (error) {
    req.log.error({ err: error, broadcastId }, "Could not queue email broadcast");
    res.status(503).json({ error: "Email broadcast could not be queued." });
  }
});

router.get("/admin/email-delivery/outbox", requireAdmin, async (req, res): Promise<void> => {
  const page = Number(req.query.page ?? 1);
  const perPage = Number(req.query.perPage ?? 25);
  const deliveryState = typeof req.query.deliveryState === "string" ? req.query.deliveryState : undefined;
  const purpose = typeof req.query.purpose === "string" ? req.query.purpose : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100 ||
    (deliveryState && !deliveryStates.has(deliveryState)) ||
    (purpose && !purposes.has(purpose)) ||
    (search && search.length > 120)) {
    res.status(400).json({ error: "Invalid outbox filter or pagination values." });
    return;
  }
  res.json(await listTransactionalEmailOutbox({
    page,
    perPage,
    ...(deliveryState && deliveryState !== "unconfigured" ? { deliveryState } : {}),
    ...(purpose ? { purpose } : {}),
    ...(search ? { search } : {}),
  }));
});

router.post("/admin/email-delivery/outbox/:id/retry", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid transactional email id." });
    return;
  }
  const existing = await getTransactionalEmailById(id);
  if (!existing) {
    res.status(404).json({ error: "Transactional email outbox item was not found." });
    return;
  }
  if (existing.deliveryState !== "failed") {
    res.status(409).json({ error: `A ${existing.deliveryState} submission cannot be blindly retried. Uncertain submissions require reconciliation.` });
    return;
  }
  const queued = await retryTransactionalEmail(id);
  if (!queued) {
    res.status(409).json({ error: "The email outbox item changed while retrying. Refresh and review its current status." });
    return;
  }
  await audit(requestActor(req), "email_delivery.retry_queued", `email:${id}`, "Explicitly queued a failed transactional email for another safe attempt.");
  res.json({
    id: queued.id,
    eventKey: queued.eventKey,
    purpose: queued.purpose,
    recipientEmail: queued.recipientEmail,
    deliveryState: queued.deliveryState,
    attempts: queued.attempts,
    createdAt: queued.createdAt,
    updatedAt: queued.updatedAt,
    nextAttemptAt: queued.nextAttemptAt,
    lastError: queued.lastError,
    heldForReview: false,
  });
});

router.post("/admin/email-delivery/outbox/legacy/:id/review-requeue", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  if (!Number.isSafeInteger(id) || id < 1 || body?.reviewed !== true) {
    res.status(400).json({ error: "Explicitly review the selected legacy email and confirm reviewed: true." });
    return;
  }
  const actor = requestActor(req);
  try {
    const queued = await reviewAndRequeueLegacySupportEmail({ id, actorId: actor, reviewed: true });
    if (!queued) {
      res.status(409).json({ error: "Legacy item is not held for review or it has already been requeued." });
      return;
    }
    await audit(actor, "email_delivery.legacy_review_requeued", `legacy-support:${id}`, "Administrator reviewed and requeued a legacy support email; no backlog was sent automatically.");
    res.json({
      id: queued.id,
      eventKey: queued.eventKey,
      purpose: queued.purpose,
      recipientEmail: queued.recipientEmail,
      deliveryState: queued.deliveryState,
      attempts: queued.attempts,
      createdAt: queued.createdAt,
      updatedAt: queued.updatedAt,
      nextAttemptAt: queued.nextAttemptAt,
      lastError: queued.lastError,
      heldForReview: false,
    });
  } catch (error) {
    handleOperationError(res, error);
  }
});

export default router;