import { createInsertSchema } from "drizzle-zod";
import { index, numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
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
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_payment_links_status_idx").on(table.status),
  index("greenpay_payment_links_created_at_idx").on(table.createdAt),
]);

export const insertPaymentLinkSchema = createInsertSchema(paymentLinksTable).omit({ id: true, slug: true, createdAt: true });
export type InsertPaymentLink = z.infer<typeof insertPaymentLinkSchema>;
export type PaymentLinkRecord = typeof paymentLinksTable.$inferSelect;