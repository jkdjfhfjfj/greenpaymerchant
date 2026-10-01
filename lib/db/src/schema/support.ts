import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const supportTicketsTable = pgTable("greenpay_support_tickets", {
  id: serial("id").primaryKey(),
  reference: varchar("reference", { length: 40 }).notNull().unique(),
  ownerClerkId: varchar("owner_clerk_id", { length: 128 }),
  requesterName: varchar("requester_name", { length: 120 }).notNull(),
  requesterEmail: varchar("requester_email", { length: 254 }).notNull(),
  subject: varchar("subject", { length: 180 }).notNull(),
  category: varchar("category", { length: 32 }).notNull().default("other"),
  status: varchar("status", { length: 24 }).notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_support_owner_idx").on(table.ownerClerkId, table.updatedAt),
  index("greenpay_support_status_idx").on(table.status, table.updatedAt),
]);

export const supportMessagesTable = pgTable("greenpay_support_messages", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull(),
  authorRole: varchar("author_role", { length: 16 }).notNull(),
  authorClerkId: varchar("author_clerk_id", { length: 128 }),
  authorName: varchar("author_name", { length: 120 }).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_support_messages_ticket_idx").on(table.ticketId, table.createdAt),
]);

export const supportDeliveryOutboxTable = pgTable("greenpay_support_delivery_outbox", {
  id: serial("id").primaryKey(),
  eventKey: varchar("event_key", { length: 200 }).notNull(),
  ticketId: integer("ticket_id").notNull(),
  recipientEmail: varchar("recipient_email", { length: 254 }).notNull(),
  purpose: varchar("purpose", { length: 32 }).notNull(),
  deliveryState: varchar("delivery_state", { length: 32 }).notNull().default("unconfigured"),
  payload: jsonb("payload").$type<Record<string, string>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_support_outbox_event_key_idx").on(table.eventKey),
  index("greenpay_support_outbox_ticket_idx").on(table.ticketId, table.createdAt),
]);

export const userNotificationsTable = pgTable("greenpay_user_notifications", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id", { length: 128 }).notNull(),
  eventKey: varchar("event_key", { length: 240 }).notNull(),
  type: varchar("type", { length: 32 }).notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  body: varchar("body", { length: 500 }).notNull(),
  href: varchar("href", { length: 300 }).notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_user_notifications_event_idx").on(table.userId, table.eventKey),
  index("greenpay_user_notifications_unread_idx").on(table.userId, table.readAt, table.createdAt),
]);

export const merchantBusinessContactsTable = pgTable("greenpay_merchant_business_contacts", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull().unique(),
  contactName: varchar("contact_name", { length: 120 }),
  email: varchar("email", { length: 254 }),
  phone: varchar("phone", { length: 40 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSupportTicketSchema = createInsertSchema(supportTicketsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertSupportMessageSchema = createInsertSchema(supportMessagesTable).omit({ id: true, createdAt: true });
export type InsertSupportTicket = z.infer<typeof insertSupportTicketSchema>;
export type InsertSupportMessage = z.infer<typeof insertSupportMessageSchema>;
export type SupportTicket = typeof supportTicketsTable.$inferSelect;
export type SupportMessage = typeof supportMessagesTable.$inferSelect;