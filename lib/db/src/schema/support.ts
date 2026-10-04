import { createInsertSchema } from "drizzle-zod";
import { boolean, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
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
  emailDeliveryState: varchar("email_delivery_state", { length: 24 }).notNull().default("unconfigured"),
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
  emailDeliveryState: varchar("email_delivery_state", { length: 24 }).notNull().default("unconfigured"),
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
  reviewedBy: varchar("reviewed_by", { length: 128 }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_support_outbox_event_key_idx").on(table.eventKey),
  index("greenpay_support_outbox_ticket_idx").on(table.ticketId, table.createdAt),
]);

export const transactionalEmailOutboxTable = pgTable("greenpay_transactional_email_outbox", {
  id: serial("id").primaryKey(),
  eventKey: varchar("event_key", { length: 240 }).notNull(),
  purpose: varchar("purpose", { length: 32 }).notNull(),
  recipientEmail: varchar("recipient_email", { length: 254 }).notNull(),
  template: varchar("template", { length: 40 }).notNull(),
  subject: varchar("subject", { length: 200 }).notNull(),
  payload: jsonb("payload").$type<Record<string, string | number | null>>().notNull(),
  deliveryState: varchar("delivery_state", { length: 24 }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  retryable: boolean("retryable").notNull().default(true),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseOwner: varchar("lease_owner", { length: 128 }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastError: text("last_error"),
  providerMessageId: varchar("provider_message_id", { length: 200 }),
  reviewedBy: varchar("reviewed_by", { length: 128 }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("greenpay_transactional_email_event_key_idx").on(table.eventKey),
  index("greenpay_transactional_email_claim_idx").on(table.deliveryState, table.nextAttemptAt, table.createdAt),
  index("greenpay_transactional_email_recipient_idx").on(table.recipientEmail, table.createdAt),
]);

export const emailDeliverySettingsTable = pgTable("greenpay_email_delivery_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  fromEmail: varchar("from_email", { length: 254 }),
  encryptedMailtrapToken: text("encrypted_mailtrap_token"),
  senderVerifiedAt: timestamp("sender_verified_at", { withTimezone: true }),
  senderVerifiedBy: varchar("sender_verified_by", { length: 128 }),
  updatedBy: varchar("updated_by", { length: 128 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const financialNotificationEventsTable = pgTable("greenpay_financial_notification_events", {
  id: serial("id").primaryKey(),
  eventKey: varchar("event_key", { length: 240 }).notNull(),
  eventType: varchar("event_type", { length: 32 }).notNull(),
  transactionId: integer("transaction_id"),
  payoutId: integer("payout_id"),
  walletPayoutRequestId: integer("wallet_payout_request_id"),
  reference: varchar("reference", { length: 100 }).notNull(),
  previousStatus: varchar("previous_status", { length: 32 }),
  status: varchar("status", { length: 32 }).notNull(),
  amount: numeric("amount", { precision: 18, scale: 2, mode: "string" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  deliveryState: varchar("delivery_state", { length: 24 }).notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseOwner: varchar("lease_owner", { length: 128 }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastError: text("last_error"),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_financial_notification_event_key_idx").on(table.eventKey),
  index("greenpay_financial_notification_claim_idx").on(table.deliveryState, table.nextAttemptAt, table.createdAt),
  index("greenpay_financial_notification_transaction_idx").on(table.transactionId),
  index("greenpay_financial_notification_payout_idx").on(table.payoutId),
  index("greenpay_financial_notification_wallet_payout_idx").on(table.walletPayoutRequestId),
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
export type TransactionalEmailOutbox = typeof transactionalEmailOutboxTable.$inferSelect;
export type EmailDeliverySettings = typeof emailDeliverySettingsTable.$inferSelect;