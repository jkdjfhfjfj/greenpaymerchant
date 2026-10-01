import { createInsertSchema } from "drizzle-zod";
import { index, integer, numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const payoutsTable = pgTable("greenpay_payouts", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id"),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  provider: varchar("provider", { length: 24 }).notNull(),
  providerReference: varchar("provider_reference", { length: 200 }),
  amount: numeric("amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  fee: numeric("fee", { precision: 18, scale: 2, mode: "number" }),
  netAmount: numeric("net_amount", { precision: 18, scale: 2, mode: "number" }),
  currency: varchar("currency", { length: 3 }).notNull(),
  method: text("method").notNull(),
  accountName: text("account_name").notNull(),
  maskedAccount: varchar("masked_account", { length: 80 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_payouts_status_idx").on(table.status),
  index("greenpay_payouts_merchant_id_idx").on(table.merchantId),
  index("greenpay_payouts_currency_idx").on(table.currency),
  index("greenpay_payouts_created_at_idx").on(table.createdAt),
]);

export const insertPayoutSchema = createInsertSchema(payoutsTable).omit({ id: true, reference: true, createdAt: true });
export type InsertPayout = z.infer<typeof insertPayoutSchema>;
export type PayoutRecord = typeof payoutsTable.$inferSelect;