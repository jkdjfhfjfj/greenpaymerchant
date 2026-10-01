import { createInsertSchema } from "drizzle-zod";
import { index, numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const refundsTable = pgTable("greenpay_refunds", {
  id: serial("id").primaryKey(),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  originalReference: varchar("original_reference", { length: 100 }).notNull(),
  providerReference: varchar("provider_reference", { length: 200 }),
  amount: numeric("amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_refunds_original_reference_idx").on(table.originalReference),
  index("greenpay_refunds_created_at_idx").on(table.createdAt),
]);

export const insertRefundSchema = createInsertSchema(refundsTable).omit({ id: true, reference: true, createdAt: true });
export type InsertRefund = z.infer<typeof insertRefundSchema>;
export type RefundRecord = typeof refundsTable.$inferSelect;