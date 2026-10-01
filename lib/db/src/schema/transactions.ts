import { createInsertSchema } from "drizzle-zod";
import { index, integer, numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const transactionsTable = pgTable("greenpay_transactions", {
  id: serial("id").primaryKey(),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  provider: varchar("provider", { length: 24 }).notNull(),
  providerReference: varchar("provider_reference", { length: 200 }),
  amount: numeric("amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  fee: numeric("fee", { precision: 18, scale: 2, mode: "number" }),
  netAmount: numeric("net_amount", { precision: 18, scale: 2, mode: "number" }),
  platformFee: numeric("platform_fee", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  platformNetAmount: numeric("platform_net_amount", { precision: 18, scale: 2, mode: "number" }),
  platformFeePercent: numeric("platform_fee_percent", { precision: 8, scale: 4, mode: "number" }).notNull().default(0),
  platformFlatFee: numeric("platform_flat_fee", { precision: 18, scale: 2, mode: "number" }).notNull().default(0),
  platformFeeCurrency: varchar("platform_fee_currency", { length: 3 }),
  platformFeeScheduleId: integer("platform_fee_schedule_id"),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("pending"),
  paymentMethod: text("payment_method"),
  customerEmail: text("customer_email").notNull(),
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),
  description: text("description"),
  paymentUrl: text("payment_url"),
  paymentLinkId: integer("payment_link_id"),
  merchantId: integer("merchant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  settlementAt: timestamp("settlement_at", { withTimezone: true }),
  settlementStatus: varchar("settlement_status", { length: 24 }).notNull().default("not_applicable"),
}, (table) => [
  index("greenpay_transactions_created_at_idx").on(table.createdAt),
  index("greenpay_transactions_status_idx").on(table.status),
  index("greenpay_transactions_currency_idx").on(table.currency),
  index("greenpay_transactions_customer_email_idx").on(table.customerEmail),
  index("greenpay_transactions_merchant_id_idx").on(table.merchantId),
]);

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({ id: true, createdAt: true });
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type TransactionRecord = typeof transactionsTable.$inferSelect;