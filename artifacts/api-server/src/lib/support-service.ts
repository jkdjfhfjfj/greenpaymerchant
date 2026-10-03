import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  merchantBusinessContactsTable,
  merchantsTable,
  supportDeliveryOutboxTable,
  supportMessagesTable,
  supportTicketsTable,
  platformAdminAssignmentsTable,
  userNotificationsTable,
  type SupportMessage,
  type SupportTicket,
} from "@workspace/db";
import { redactSupportText } from "./support-rules";
import { enqueueTransactionalEmail, type EmailDeliveryState } from "./mailtrap-delivery";
import { logger } from "./logger";
import { allowlistedAdminEmails, findVerifiedClerkUsersByEmail } from "./platform-admin";
import { buildMerchantAccountNotifications, type MerchantAccountNotification } from "./merchant-account-notifications";

// Contact-ticket creation is still in the legacy held queue until an admin
// explicitly reviews/requeues it. This value is an actual outbox state, not a
// statement that a message has been sent.
export const emailDeliveryState = "unconfigured" as const;

export function makeSupportReference(): string {
  return `GP-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

export async function addNotification(input: MerchantAccountNotification | {
  userId: string;
  eventKey: string;
  type: "support_reply" | "kyc_update" | "payment_confirmed" | "payment_failed" | "payout_update";
  title: string;
  body: string;
  href: string;
}): Promise<void> {
  await db.insert(userNotificationsTable).values(input).onConflictDoNothing();
}

export async function notifyMerchantAccountCreated(input: {
  merchantId: number;
  ownerUserId: string;
  businessName: string;
}): Promise<{ adminCount: number; adminLookupFailures: number }> {
  const notificationInput = { ...input, adminUserIds: [] };
  const { ownerNotification } = buildMerchantAccountNotifications(notificationInput);
  await addNotification(ownerNotification);

  const assignments = await db.select({
    userId: platformAdminAssignmentsTable.clerkUserId,
  }).from(platformAdminAssignmentsTable)
    .where(isNull(platformAdminAssignmentsTable.revokedAt));
  const lookupResults = await Promise.allSettled(
    allowlistedAdminEmails().map((email) => findVerifiedClerkUsersByEmail(email)),
  );
  const adminUserIds = new Set(assignments.map(({ userId }) => userId));
  let adminLookupFailures = 0;
  for (const result of lookupResults) {
    if (result.status === "rejected") {
      adminLookupFailures += 1;
      continue;
    }
    for (const user of result.value) adminUserIds.add(user.id);
  }

  adminUserIds.delete(input.ownerUserId);
  const { adminNotifications } = buildMerchantAccountNotifications({
    ...input,
    adminUserIds: [...adminUserIds],
  });
  if (adminNotifications.length > 0) {
    await db.insert(userNotificationsTable).values(adminNotifications).onConflictDoNothing();
  }
  return { adminCount: adminNotifications.length, adminLookupFailures };
}

export async function addSupportMessage(input: {
  ticket: SupportTicket;
  authorRole: "customer" | "admin";
  authorClerkId: string | null;
  authorName: string;
  body: string;
}): Promise<SupportMessage> {
  const safeBody = redactSupportText(input.body);
  const message = await db.transaction(async (tx) => {
    const [created] = await tx.insert(supportMessagesTable).values({
      ticketId: input.ticket.id,
      authorRole: input.authorRole,
      authorClerkId: input.authorClerkId,
      authorName: input.authorName,
      body: safeBody,
      emailDeliveryState: "unconfigured",
    }).returning();
    await tx.update(supportTicketsTable).set({
      updatedAt: created.createdAt,
      ...(input.authorRole === "customer" && input.ticket.status !== "closed" ? { status: "open" } : {}),
    }).where(eq(supportTicketsTable.id, input.ticket.id));
    await tx.insert(supportDeliveryOutboxTable).values({
      eventKey: `ticket-message:${created.id}`,
      ticketId: input.ticket.id,
      recipientEmail: input.ticket.requesterEmail,
      purpose: input.authorRole === "admin" ? "message_reply" : "message_receipt",
      deliveryState: "unconfigured",
      payload: { ticketReference: input.ticket.reference, messageId: String(created.id) },
    }).onConflictDoNothing();
    return created;
  });
  const purpose = input.authorRole === "admin" ? "support_reply" : "support_receipt";
  let deliveryState: EmailDeliveryState | "unconfigured" = "unconfigured";
  let queuedEmail: Awaited<ReturnType<typeof enqueueTransactionalEmail>> | null = null;
  try {
    queuedEmail = await enqueueTransactionalEmail({
      eventKey: `support-message:${message.id}`,
      purpose,
      recipientEmail: input.ticket.requesterEmail,
      template: purpose,
      payload: {
        ticketId: input.ticket.id,
        ticketReference: input.ticket.reference,
        messageId: message.id,
        subject: input.ticket.subject,
        body: safeBody,
      },
    });
  } catch (error) {
    logger.error({
      messageId: message.id,
      error: error instanceof Error ? error.message : "Unknown support email queue error.",
    }, "Support message was saved but its email could not be queued; the support outbox remains held for review");
  }
  if (queuedEmail) {
    deliveryState = queuedEmail.deliveryState;
    const stateUpdates = await Promise.allSettled([
      db.update(supportMessagesTable).set({ emailDeliveryState: queuedEmail.deliveryState })
        .where(eq(supportMessagesTable.id, message.id)),
      db.update(supportTicketsTable).set({ emailDeliveryState: queuedEmail.deliveryState })
        .where(eq(supportTicketsTable.id, input.ticket.id)),
      db.update(supportDeliveryOutboxTable).set({ deliveryState: queuedEmail.deliveryState })
        .where(eq(supportDeliveryOutboxTable.eventKey, `ticket-message:${message.id}`)),
    ]);
    if (stateUpdates.some((result) => result.status === "rejected")) {
      logger.warn({ messageId: message.id }, "Support email is durably queued but a support delivery status snapshot could not be updated");
    }
  }
  const messageWithDelivery = {
    ...message,
    emailDeliveryState: deliveryState,
  };
  if (input.authorRole === "admin" && input.ticket.ownerClerkId) {
    await addNotification({
      userId: input.ticket.ownerClerkId,
      eventKey: `support-reply:${message.id}`,
      type: "support_reply",
      title: "Support replied to your ticket",
      body: `${input.ticket.subject}: ${safeBody.slice(0, 180)}`,
      href: `/support?ticket=${input.ticket.id}`,
    });
  }
  return messageWithDelivery;
}

export async function supportTicketDtos(tickets: SupportTicket[]) {
  if (!tickets.length) return [];
  const ids = tickets.map((ticket) => ticket.id);
  const counts = await db.select({
    ticketId: supportMessagesTable.ticketId,
    count: sql<number>`count(*)::int`,
  }).from(supportMessagesTable)
    .where(inArray(supportMessagesTable.ticketId, ids))
    .groupBy(supportMessagesTable.ticketId);
  const countById = new Map(counts.map((item) => [item.ticketId, Number(item.count)]));
  return tickets.map((ticket) => ({
    id: ticket.id,
    reference: ticket.reference,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    requesterName: ticket.requesterName,
    requesterEmail: ticket.requesterEmail,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    messageCount: countById.get(ticket.id) ?? 0,
    delivery: ticket.emailDeliveryState as EmailDeliveryState | "unconfigured",
  }));
}

export function supportMessageDto(message: SupportMessage) {
  return {
    id: message.id,
    ticketId: message.ticketId,
    authorRole: message.authorRole,
    authorName: message.authorName,
    body: message.body,
    createdAt: message.createdAt,
    delivery: message.emailDeliveryState as EmailDeliveryState | "unconfigured",
  };
}

export async function syncAuthoritativeNotifications(_userId: string): Promise<void> {
  // Notifications are written by actual transition hooks. Reading payment,
  // payout, or profile state must never synthesize an event or email.
}

export async function unreadNotificationCount(userId: string): Promise<number> {
  const [row] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(userNotificationsTable).where(and(
    eq(userNotificationsTable.userId, userId),
    isNull(userNotificationsTable.readAt),
  ));
  return Number(row?.count ?? 0);
}

export async function getBusinessContact(merchantId: number) {
  const [merchant] = await db.select().from(merchantsTable)
    .where(eq(merchantsTable.id, merchantId)).limit(1);
  if (!merchant) return null;
  const [contact] = await db.select().from(merchantBusinessContactsTable)
    .where(eq(merchantBusinessContactsTable.merchantId, merchantId)).limit(1);
  return {
    businessName: merchant.businessName,
    contactName: contact?.contactName ?? null,
    email: contact?.email ?? null,
    phone: contact?.phone ?? null,
    merchantStatus: merchant.status,
    kycStatus: merchant.kycStatus,
  };
}