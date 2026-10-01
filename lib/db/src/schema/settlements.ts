import { createInsertSchema } from "drizzle-zod";
import { index, numeric, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const settlementsTable = pgTable("greenpay_settlements", {
  id: serial("id").primaryKey(),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  provider: varchar("provider", { length: 24 }).notNull(),
  amount: numeric("amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  netAmount: numeric("net_amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("pending"),
  expectedAt: timestamp("expected_at", { withTimezone: true }).notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  payoutMethod: text("payout_method"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_settlements_status_idx").on(table.status),
  index("greenpay_settlements_currency_idx").on(table.currency),
  index("greenpay_settlements_expected_at_idx").on(table.expectedAt),
]);

export const insertSettlementSchema = createInsertSchema(settlementsTable).omit({ id: true, createdAt: true });
export type InsertSettlement = z.infer<typeof insertSettlementSchema>;
export type SettlementRecord = typeof settlementsTable.$inferSelect;