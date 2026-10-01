import { index, integer, numeric, pgTable, serial, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const verificationTierLimitsTable = pgTable("greenpay_verification_tier_limits", {
  id: serial("id").primaryKey(),
  tier: varchar("tier", { length: 16 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  collectionPerTransactionLimit: numeric("collection_per_transaction_limit", { precision: 20, scale: 2, mode: "number" }),
  collectionDailyLimit: numeric("collection_daily_limit", { precision: 20, scale: 2, mode: "number" }),
  collectionMonthlyLimit: numeric("collection_monthly_limit", { precision: 20, scale: 2, mode: "number" }),
  payoutLimit: numeric("payout_limit", { precision: 20, scale: 2, mode: "number" }),
  conversionLimit: numeric("conversion_limit", { precision: 20, scale: 2, mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_verification_tier_currency_unique_idx").on(table.tier, table.currency),
]);

export const verificationUsageReservationsTable = pgTable("greenpay_verification_usage_reservations", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  transactionId: integer("transaction_id"),
  action: varchar("action", { length: 16 }).notNull(),
  amount: numeric("amount", { precision: 20, scale: 2, mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("reserved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_verification_usage_window_idx").on(table.merchantId, table.action, table.currency, table.status, table.createdAt),
  index("greenpay_verification_usage_transaction_idx").on(table.transactionId, table.action),
]);

export const insertVerificationTierLimitSchema = createInsertSchema(verificationTierLimitsTable)
  .omit({ id: true, updatedAt: true });
export type InsertVerificationTierLimit = z.infer<typeof insertVerificationTierLimitSchema>;
export type VerificationTierLimitRecord = typeof verificationTierLimitsTable.$inferSelect;
export type VerificationUsageReservationRecord = typeof verificationUsageReservationsTable.$inferSelect;