import { createInsertSchema } from "drizzle-zod";
import { index, integer, numeric, pgTable, serial, text, timestamp, varchar, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const sandboxTransactionsTable = pgTable("greenpay_sandbox_transactions", {
  id: serial("id").primaryKey(),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  merchantId: integer("merchant_id").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  amount: numeric("amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  paymentMethod: text("payment_method"),
  customerEmail: text("customer_email").notNull(),
  customerName: text("customer_name"),
  customerPhone: text("customer_phone"),
  description: text("description"),
  status: varchar("status", { length: 24 }).$type<"pending" | "success" | "failed">().notNull(),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  paidAt: timestamp("paid_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("greenpay_sandbox_transactions_merchant_idempotency_idx").on(table.merchantId, table.idempotencyKey),
  index("greenpay_sandbox_transactions_merchant_created_idx").on(table.merchantId, table.createdAt),
  index("greenpay_sandbox_transactions_status_idx").on(table.status),
]);

export const insertSandboxTransactionSchema = createInsertSchema(sandboxTransactionsTable)
  .omit({ id: true, createdAt: true });
export type InsertSandboxTransaction = z.infer<typeof insertSandboxTransactionSchema>;
export type SandboxTransactionRecord = typeof sandboxTransactionsTable.$inferSelect;
