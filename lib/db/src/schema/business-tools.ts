import { createInsertSchema } from "drizzle-zod";
import { date, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export type InvoiceLineRecord = { description: string; quantity: number; unitAmount: number; total: number };

export const merchantInvoicesTable = pgTable("greenpay_merchant_invoices", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  reference: varchar("reference", { length: 80 }).notNull().unique(),
  customerName: varchar("customer_name", { length: 150 }).notNull(),
  customerEmail: varchar("customer_email", { length: 254 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  lines: jsonb("lines").$type<InvoiceLineRecord[]>().notNull(),
  subtotal: numeric("subtotal", { precision: 18, scale: 2, mode: "number" }).notNull(),
  total: numeric("total", { precision: 18, scale: 2, mode: "number" }).notNull(),
  paidAmount: numeric("paid_amount", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  paymentLinkAmount: numeric("payment_link_amount", { precision: 18, scale: 2, mode: "number" }),
  status: varchar("status", { length: 24 }).notNull().default("draft"),
  note: text("note"),
  paymentLinkId: integer("payment_link_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_merchant_invoices_merchant_idx").on(table.merchantId),
  index("greenpay_merchant_invoices_status_idx").on(table.status),
]);

export const merchantInvoiceRemindersTable = pgTable("greenpay_merchant_invoice_reminders", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  invoiceId: integer("invoice_id").notNull(),
  deliveryStatus: varchar("delivery_status", { length: 24 }).notNull().default("unconfigured"),
  message: text("message").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  eventKey: varchar("event_key", { length: 200 }),
  deliveryId: integer("delivery_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
}, (table) => [
  index("greenpay_invoice_reminders_merchant_invoice_idx").on(table.merchantId, table.invoiceId),
  uniqueIndex("greenpay_invoice_reminders_event_key_unique_idx").on(table.eventKey),
]);

export type CaseMessageRecord = {
  id: string;
  authorRole: "merchant" | "admin";
  message: string;
  evidenceUrl: string | null;
  attachmentIds?: number[];
  createdAt: string;
};

export const merchantSupportCasesTable = pgTable("greenpay_merchant_support_cases", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  kind: varchar("kind", { length: 16 }).notNull(),
  transactionReference: varchar("transaction_reference", { length: 100 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("requested"),
  financialMovement: varchar("financial_movement", { length: 24 }).notNull().default("requested"),
  messages: jsonb("messages").$type<CaseMessageRecord[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_support_cases_merchant_idx").on(table.merchantId),
  index("greenpay_support_cases_status_idx").on(table.status),
  index("greenpay_support_cases_reference_idx").on(table.transactionReference),
]);

export const merchantCaseAttachmentsTable = pgTable("greenpay_case_attachments", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  caseId: integer("case_id").notNull(),
  messageId: varchar("message_id", { length: 36 }).notNull(),
  objectPath: text("object_path").notNull(),
  name: varchar("name", { length: 180 }).notNull(),
  contentType: varchar("content_type", { length: 40 }).notNull(),
  size: integer("size").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_case_attachments_object_path_unique_idx").on(table.objectPath),
  index("greenpay_case_attachments_case_created_idx").on(table.caseId, table.createdAt),
]);

export const merchantCaseUploadIntentsTable = pgTable("greenpay_case_upload_intents", {
  id: serial("id").primaryKey(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  merchantId: integer("merchant_id").notNull(),
  caseId: integer("case_id").notNull(),
  objectPath: text("object_path").notNull().unique(),
  name: varchar("name", { length: 180 }).notNull(),
  contentType: varchar("content_type", { length: 40 }).notNull(),
  size: integer("size").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_case_upload_intents_case_idx").on(table.merchantId, table.caseId, table.expiresAt),
]);

export const merchantCaseRefundsTable = pgTable("greenpay_case_refunds", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  caseId: integer("case_id").notNull(),
  transactionReference: varchar("transaction_reference", { length: 100 }).notNull(),
  refundId: integer("refund_id").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  providerReference: varchar("provider_reference", { length: 200 }).notNull(),
  evidenceReference: varchar("evidence_reference", { length: 200 }).notNull(),
  createdBy: varchar("created_by", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_case_refunds_case_key_unique_idx").on(table.caseId, table.idempotencyKey),
  uniqueIndex("greenpay_case_refunds_refund_unique_idx").on(table.refundId),
  uniqueIndex("greenpay_case_refunds_provider_reference_unique_idx").on(table.providerReference),
  uniqueIndex("greenpay_case_refunds_evidence_reference_unique_idx").on(table.evidenceReference),
  index("greenpay_case_refunds_merchant_case_idx").on(table.merchantId, table.caseId),
]);

export const insertMerchantInvoiceSchema = createInsertSchema(merchantInvoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMerchantInvoiceReminderSchema = createInsertSchema(merchantInvoiceRemindersTable).omit({ id: true, createdAt: true });
export const insertMerchantSupportCaseSchema = createInsertSchema(merchantSupportCasesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMerchantInvoice = z.infer<typeof insertMerchantInvoiceSchema>;
export type MerchantInvoiceRecord = typeof merchantInvoicesTable.$inferSelect;
export type MerchantInvoiceReminderRecord = typeof merchantInvoiceRemindersTable.$inferSelect;
export type MerchantSupportCaseRecord = typeof merchantSupportCasesTable.$inferSelect;