import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { Router, type IRouter } from "express";
import {
  db,
  merchantBusinessContactsTable,
  supportDeliveryOutboxTable,
  supportMessagesTable,
  supportTicketsTable,
  userNotificationsTable,
} from "@workspace/db";
import { requireAdmin, requireSignedIn, verifiedClerkEmail } from "../middlewares/requireAdmin";
import {
  addSupportMessage,
  emailDeliveryState,
  getBusinessContact,
  makeSupportReference,
  supportMessageDto,
  supportTicketDtos,
  syncAuthoritativeNotifications,
  unreadNotificationCount,
} from "../lib/support-service";
import { allowContactSubmission, boundedText, categoryOf, redactSupportText, validEmail } from "../lib/support-rules";
import { resolveMerchantAccess } from "../lib/merchant-access";

const router: IRouter = Router();
const statuses = new Set(["open", "in_progress", "waiting", "resolved", "closed"]);

type JsonObject = Record<string, unknown>;

function bodyObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

async function loadTicket(id: number, ownerId?: string) {
  const predicates = [eq(supportTicketsTable.id, id)];
  if (ownerId) predicates.push(eq(supportTicketsTable.ownerClerkId, ownerId));
  const [ticket] = await db.select().from(supportTicketsTable)
    .where(and(...predicates)).limit(1);
  return ticket;
}

async function detailResponse(ticket: NonNullable<Awaited<ReturnType<typeof loadTicket>>>) {
  const [dto] = await supportTicketDtos([ticket]);
  const messages = await db.select().from(supportMessagesTable)
    .where(eq(supportMessagesTable.ticketId, ticket.id))
    .orderBy(supportMessagesTable.createdAt);
  return { ticket: dto, messages: messages.map(supportMessageDto) };
}

async function createTicket(input: {
  ownerId: string | null;
  name: string;
  email: string;
  subject: string;
  message: string;
  category: string;
}) {
  return await db.transaction(async (tx) => {
    const [ticket] = await tx.insert(supportTicketsTable).values({
      reference: makeSupportReference(),
      ownerClerkId: input.ownerId,
      requesterName: input.name,
      requesterEmail: input.email,
      subject: redactSupportText(input.subject),
      category: input.category,
    }).returning();
    const [message] = await tx.insert(supportMessagesTable).values({
      ticketId: ticket.id,
      authorRole: "customer",
      authorClerkId: input.ownerId,
      authorName: input.name,
      body: redactSupportText(input.message),
    }).returning();
    await tx.insert(supportDeliveryOutboxTable).values({
      eventKey: `ticket-created:${ticket.id}`,
      ticketId: ticket.id,
      recipientEmail: ticket.requesterEmail,
      purpose: "ticket_receipt",
      deliveryState: "unconfigured",
      payload: { ticketReference: ticket.reference, messageId: String(message.id) },
    }).onConflictDoNothing();
    return ticket;
  });
}

router.post("/contact/tickets", async (req, res): Promise<void> => {
  if (!allowContactSubmission(req.ip || "unknown")) {
    res.status(429).json({ error: "Too many support requests. Please try again later." });
    return;
  }
  const input = bodyObject(req.body);
  const name = boundedText(input?.name, 1, 120);
  const email = validEmail(input?.email);
  const subject = boundedText(input?.subject, 3, 180);
  const message = boundedText(input?.message, 10, 8000);
  const category = categoryOf(input?.category);
  if (!name || !email || !subject || !message || !category) {
    res.status(400).json({ error: "Enter a valid name, email, subject, category, and message within the stated limits." });
    return;
  }
  const ticket = await createTicket({ ownerId: null, name, email, subject, message, category });
  res.status(201).json({ reference: ticket.reference, delivery: emailDeliveryState });
});

router.get("/support/tickets", requireSignedIn, async (_req, res): Promise<void> => {
  const ownerId = res.locals.clerkUserId as string;
  const tickets = await db.select().from(supportTicketsTable)
    .where(eq(supportTicketsTable.ownerClerkId, ownerId))
    .orderBy(desc(supportTicketsTable.updatedAt)).limit(100);
  res.json({ items: await supportTicketDtos(tickets) });
});

router.post("/support/tickets", requireSignedIn, async (req, res): Promise<void> => {
  const input = bodyObject(req.body);
  const subject = boundedText(input?.subject, 3, 180);
  const message = boundedText(input?.message, 10, 8000);
  const category = categoryOf(input?.category);
  if (!subject || !message || !category) {
    res.status(400).json({ error: "Enter a valid subject, category, and message within the stated limits." });
    return;
  }
  const ownerId = res.locals.clerkUserId as string;
  const email = await verifiedClerkEmail(ownerId);
  if (!email) {
    res.status(403).json({ error: "A verified email address is required to open a support request." });
    return;
  }
  const ticket = await createTicket({
    ownerId,
    name: email,
    email,
    subject,
    message,
    category,
  });
  const [dto] = await supportTicketDtos([ticket]);
  res.status(201).json(dto);
});

router.get("/support/tickets/:id", requireSignedIn, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid support ticket id." });
    return;
  }
  const ticket = await loadTicket(id, res.locals.clerkUserId as string);
  if (!ticket) {
    res.status(404).json({ error: "Support ticket not found." });
    return;
  }
  res.json(await detailResponse(ticket));
});

router.post("/support/tickets/:id/messages", requireSignedIn, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = boundedText(bodyObject(req.body)?.body, 1, 8000);
  if (!Number.isSafeInteger(id) || id < 1 || !body) {
    res.status(400).json({ error: "Enter a valid message and support ticket id." });
    return;
  }
  const ownerId = res.locals.clerkUserId as string;
  const ticket = await loadTicket(id, ownerId);
  if (!ticket) {
    res.status(404).json({ error: "Support ticket not found." });
    return;
  }
  if (ticket.status === "closed") {
    res.status(409).json({ error: "This ticket is closed. Open a new support request to continue." });
    return;
  }
  const email = await verifiedClerkEmail(ownerId);
  const message = await addSupportMessage({
    ticket,
    authorRole: "customer",
    authorClerkId: ownerId,
    authorName: email ?? ticket.requesterName,
    body,
  });
  res.status(201).json(supportMessageDto(message));
});

router.get("/admin/support/tickets", requireAdmin, async (req, res): Promise<void> => {
  const conditions = [];
  if (typeof req.query.status === "string" && statuses.has(req.query.status)) {
    conditions.push(eq(supportTicketsTable.status, req.query.status));
  } else if (req.query.status !== undefined) {
    res.status(400).json({ error: "Invalid support status filter." });
    return;
  }
  if (typeof req.query.search === "string" && req.query.search.trim()) {
    const search = req.query.search.trim().slice(0, 120).replace(/[\\%_]/g, "\\$&");
    conditions.push(or(
      ilike(supportTicketsTable.subject, `%${search}%`),
      ilike(supportTicketsTable.requesterEmail, `%${search}%`),
      ilike(supportTicketsTable.reference, `%${search}%`),
    )!);
  }
  const tickets = await db.select().from(supportTicketsTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(supportTicketsTable.updatedAt)).limit(200);
  res.json({ items: await supportTicketDtos(tickets) });
});

router.get("/admin/support/tickets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid support ticket id." });
    return;
  }
  const ticket = await loadTicket(id);
  if (!ticket) {
    res.status(404).json({ error: "Support ticket not found." });
    return;
  }
  res.json(await detailResponse(ticket));
});

router.patch("/admin/support/tickets/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const status = bodyObject(req.body)?.status;
  if (!Number.isSafeInteger(id) || id < 1 || typeof status !== "string" || !statuses.has(status)) {
    res.status(400).json({ error: "Invalid ticket id or status." });
    return;
  }
  const [ticket] = await db.update(supportTicketsTable)
    .set({ status, updatedAt: new Date() })
    .where(eq(supportTicketsTable.id, id)).returning();
  if (!ticket) {
    res.status(404).json({ error: "Support ticket not found." });
    return;
  }
  const [dto] = await supportTicketDtos([ticket]);
  res.json(dto);
});

router.post("/admin/support/tickets/:id/messages", requireAdmin, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  const body = boundedText(bodyObject(req.body)?.body, 1, 8000);
  if (!Number.isSafeInteger(id) || id < 1 || !body) {
    res.status(400).json({ error: "Enter a valid message and support ticket id." });
    return;
  }
  const ticket = await loadTicket(id);
  if (!ticket) {
    res.status(404).json({ error: "Support ticket not found." });
    return;
  }
  const message = await addSupportMessage({
    ticket,
    authorRole: "admin",
    authorClerkId: res.locals.clerkUserId as string,
    authorName: "Greenpay Support",
    body,
  });
  res.status(201).json(supportMessageDto(message));
});

router.get("/notifications", requireSignedIn, async (_req, res): Promise<void> => {
  const userId = res.locals.clerkUserId as string;
  await syncAuthoritativeNotifications(userId);
  const items = await db.select().from(userNotificationsTable)
    .where(eq(userNotificationsTable.userId, userId))
    .orderBy(desc(userNotificationsTable.createdAt)).limit(100);
  res.json({
    items: items.map(({ id, type, title, body, href, createdAt, readAt }) => ({
      id, type, title, body, href, createdAt, readAt,
    })),
    unreadCount: await unreadNotificationCount(userId),
  });
});

router.patch("/notifications/:id/read", requireSignedIn, async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid notification id." });
    return;
  }
  const [notification] = await db.update(userNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(
      eq(userNotificationsTable.id, id),
      eq(userNotificationsTable.userId, res.locals.clerkUserId as string),
    )).returning();
  if (!notification) {
    res.status(404).json({ error: "Notification not found." });
    return;
  }
  res.json({
    id: notification.id, type: notification.type, title: notification.title,
    body: notification.body, href: notification.href,
    createdAt: notification.createdAt, readAt: notification.readAt,
  });
});

router.post("/notifications/read-all", requireSignedIn, async (_req, res): Promise<void> => {
  const userId = res.locals.clerkUserId as string;
  await db.update(userNotificationsTable).set({ readAt: new Date() })
    .where(and(eq(userNotificationsTable.userId, userId), isNull(userNotificationsTable.readAt)));
  res.json({ unreadCount: 0 });
});

router.get("/profile/business-contact", requireSignedIn, async (req, res): Promise<void> => {
  const merchant = await resolveMerchantAccess(req, res, "owner");
  if (!merchant) {
    res.status(404).json({ error: "Complete merchant onboarding before editing business contact details." });
    return;
  }
  res.json(await getBusinessContact(merchant.id));
});

router.put("/profile/business-contact", requireSignedIn, async (req, res): Promise<void> => {
  const input = bodyObject(req.body);
  const merchant = await resolveMerchantAccess(req, res, "owner");
  if (!merchant) {
    res.status(404).json({ error: "Complete merchant onboarding before editing business contact details." });
    return;
  }
  const contactName = input?.contactName === null ? null : boundedText(input?.contactName, 1, 120);
  const email = input?.email === null ? null : validEmail(input?.email);
  const phone = input?.phone === null ? null : boundedText(input?.phone, 1, 40);
  if (!input || contactName === null && input.contactName !== null ||
    email === null && input.email !== null || phone === null && input.phone !== null ||
    !Object.hasOwn(input, "contactName") || !Object.hasOwn(input, "email") || !Object.hasOwn(input, "phone")) {
    res.status(400).json({ error: "Enter valid business contact name, email, and phone values." });
    return;
  }
  const values = { merchantId: merchant.id, contactName, email, phone, updatedAt: new Date() };
  await db.insert(merchantBusinessContactsTable).values(values).onConflictDoUpdate({
    target: merchantBusinessContactsTable.merchantId,
    set: { contactName, email, phone, updatedAt: values.updatedAt },
  });
  res.json(await getBusinessContact(merchant.id));
});

export default router;