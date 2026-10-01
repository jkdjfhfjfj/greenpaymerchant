import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  merchantBusinessContactsTable,
  merchantsTable,
  payoutsTable,
  supportDeliveryOutboxTable,
  supportMessagesTable,
  supportTicketsTable,
  transactionsTable,
  userNotificationsTable,
  type SupportMessage,
  type SupportTicket,
} from "@workspace/db";
import { redactSupportText } from "./support-rules";

export const emailDeliveryState = "in_app_recorded_email_unconfigured" as const;

export function makeSupportReference(): string {
  return `GP-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

export async function addNotification(input: {
  userId: string;
  eventKey: string;
  type: "support_reply" | "kyc_update" | "payment_confirmed" | "payout_update";
  title: string;
  body: string;
  href: string;
}): Promise<void> {
  await db.insert(userNotificationsTable).values(input).onConflictDoNothing();
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
  return message;
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
    delivery: emailDeliveryState,
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
    delivery: emailDeliveryState,
  };
}

export async function syncAuthoritativeNotifications(userId: string): Promise<void> {
  const [merchant] = await db.select().from(merchantsTable)
    .where(eq(merchantsTable.ownerClerkId, userId)).limit(1);
  if (!merchant) return;

  if (merchant.kycStatus !== "not_started" || merchant.verificationUpdatedAt) {
    const kycEvent = merchant.verificationUpdatedAt?.toISOString() ?? merchant.kycStatus;
    await addNotification({
      userId,
      eventKey: `kyc:${merchant.id}:${merchant.kycStatus}:${kycEvent}`,
      type: "kyc_update",
      title: "Business verification status updated",
      body: `Your verification status is ${merchant.kycStatus.replaceAll("_", " ")}.`,
      href: "/merchant/kyc",
    });
  }

  const paidTransactions = await db.select({
    reference: transactionsTable.reference,
    paidAt: transactionsTable.paidAt,
    createdAt: transactionsTable.createdAt,
  }).from(transactionsTable).where(and(
    eq(transactionsTable.merchantId, merchant.id),
    eq(transactionsTable.status, "success"),
  )).orderBy(sql`${transactionsTable.paidAt} desc nulls last`).limit(100);
  for (const payment of paidTransactions) {
    await addNotification({
      userId,
      eventKey: `payment-confirmed:${payment.reference}`,
      type: "payment_confirmed",
      title: "Payment confirmed",
      body: `Payment ${payment.reference} has been confirmed.`,
      href: `/status/${encodeURIComponent(payment.reference)}`,
    });
  }

  const payoutEvents = await db.select({
    reference: payoutsTable.reference,
    status: payoutsTable.status,
  }).from(payoutsTable).where(and(
    eq(payoutsTable.merchantId, merchant.id),
    sql`${payoutsTable.status} <> 'pending' AND ${payoutsTable.status} <> 'processing'`,
  )).orderBy(sql`${payoutsTable.createdAt} desc`).limit(100);
  for (const payout of payoutEvents) {
    await addNotification({
      userId,
      eventKey: `payout:${payout.reference}:${payout.status}`,
      type: "payout_update",
      title: "Payout status updated",
      body: `Payout ${payout.reference} is ${payout.status}.`,
      href: "/merchant/payouts",
    });
  }
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