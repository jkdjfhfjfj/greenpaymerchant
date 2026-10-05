import { sql } from "drizzle-orm";
import {
  bigint, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar,
} from "drizzle-orm/pg-core";

export const airtimeWalletsTable = pgTable("greenpay_airtime_wallets", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  availableMinor: bigint("available_minor", { mode: "bigint" }).notNull().default(sql`0`),
  reservedMinor: bigint("reserved_minor", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_airtime_wallet_merchant_unique_idx").on(table.merchantId),
]);

export const airtimeWalletEntriesTable = pgTable("greenpay_airtime_wallet_entries", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  reference: varchar("reference", { length: 100 }).notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  availableDeltaMinor: bigint("available_delta_minor", { mode: "bigint" }).notNull(),
  reservedDeltaMinor: bigint("reserved_delta_minor", { mode: "bigint" }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_airtime_wallet_entry_key_unique_idx").on(table.merchantId, table.idempotencyKey),
  index("greenpay_airtime_wallet_entries_merchant_created_idx").on(table.merchantId, table.createdAt),
  index("greenpay_airtime_wallet_entries_reference_idx").on(table.reference),
]);

export const airtimeTopupsTable = pgTable("greenpay_airtime_topups", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  providerReference: varchar("provider_reference", { length: 200 }),
  status: varchar("status", { length: 24 }).notNull().default("initiating"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_airtime_topups_merchant_key_unique_idx").on(table.merchantId, table.idempotencyKey),
  index("greenpay_airtime_topups_status_created_idx").on(table.status, table.createdAt),
  index("greenpay_airtime_topups_provider_reference_idx").on(table.providerReference),
]);

export const airtimePurchasesTable = pgTable("greenpay_airtime_purchases", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  chargeMinor: bigint("charge_minor", { mode: "bigint" }),
  providerRequestId: varchar("provider_request_id", { length: 128 }),
  resultCode: integer("result_code"),
  resultDescription: text("result_description"),
  status: varchar("status", { length: 24 }).notNull().default("submitting"),
  lastCallbackAt: timestamp("last_callback_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_airtime_purchases_merchant_key_unique_idx").on(table.merchantId, table.idempotencyKey),
  uniqueIndex("greenpay_airtime_purchases_provider_request_unique_idx").on(table.providerRequestId),
  index("greenpay_airtime_purchases_merchant_created_idx").on(table.merchantId, table.createdAt),
  index("greenpay_airtime_purchases_status_created_idx").on(table.status, table.createdAt),
]);

export const airtimeStatumCallbacksTable = pgTable("greenpay_airtime_statum_callbacks", {
  id: serial("id").primaryKey(),
  deliveryHash: varchar("delivery_hash", { length: 64 }).notNull().unique(),
  providerRequestId: varchar("provider_request_id", { length: 128 }).notNull(),
  chargeMinor: bigint("charge_minor", { mode: "bigint" }).notNull(),
  accountBalanceMinor: bigint("account_balance_minor", { mode: "bigint" }),
  resultCode: integer("result_code").notNull(),
  resultDescription: text("result_description").notNull(),
  purchaseReference: varchar("purchase_reference", { length: 100 }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_airtime_statum_callbacks_request_idx").on(table.providerRequestId),
  index("greenpay_airtime_statum_callbacks_pending_idx").on(table.processedAt, table.receivedAt),
]);
