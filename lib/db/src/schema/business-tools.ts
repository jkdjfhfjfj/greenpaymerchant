import { createInsertSchema } from "drizzle-zod";
import { date, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
}, (table) => [
  index("greenpay_invoice_reminders_merchant_invoice_idx").on(table.merchantId, table.invoiceId),
]);

export type CaseMessageRecord = {
  id: string;
  authorRole: "merchant" | "admin";
  message: string;
  evidenceUrl: string | null;
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

export const insertMerchantInvoiceSchema = createInsertSchema(merchantInvoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMerchantInvoiceReminderSchema = createInsertSchema(merchantInvoiceRemindersTable).omit({ id: true, createdAt: true });
export const insertMerchantSupportCaseSchema = createInsertSchema(merchantSupportCasesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertMerchantInvoice = z.infer<typeof insertMerchantInvoiceSchema>;
export type MerchantInvoiceRecord = typeof merchantInvoicesTable.$inferSelect;
export type MerchantInvoiceReminderRecord = typeof merchantInvoiceRemindersTable.$inferSelect;
export type MerchantSupportCaseRecord = typeof merchantSupportCasesTable.$inferSelect;