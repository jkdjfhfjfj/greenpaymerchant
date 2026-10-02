import { createInsertSchema } from "drizzle-zod";
import { index, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const paymentLinksTable = pgTable("greenpay_payment_links", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  amountType: varchar("amount_type", { length: 24 }).notNull(),
  amount: numeric("amount", { precision: 18, scale: 2, mode: "number" }),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("active"),
  merchantId: integer("merchant_id"),
  recoveryForTransactionId: integer("recovery_for_transaction_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_payment_links_status_idx").on(table.status),
  index("greenpay_payment_links_created_at_idx").on(table.createdAt),
  index("greenpay_payment_links_merchant_id_idx").on(table.merchantId),
  uniqueIndex("greenpay_payment_links_recovery_transaction_unique_idx").on(table.recoveryForTransactionId),
]);

export const insertPaymentLinkSchema = createInsertSchema(paymentLinksTable).omit({ id: true, slug: true, createdAt: true });
export type InsertPaymentLink = z.infer<typeof insertPaymentLinkSchema>;
export type PaymentLinkRecord = typeof paymentLinksTable.$inferSelect;