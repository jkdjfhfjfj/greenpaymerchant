import { sql } from "drizzle-orm";
import {
  bigint, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, varchar,
} from "drizzle-orm/pg-core";

export const merchantWalletsTable = pgTable("greenpay_merchant_wallets", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  availableMinor: bigint("available_minor", { mode: "bigint" }).notNull().default(sql`0`),
  reservedMinor: bigint("reserved_minor", { mode: "bigint" }).notNull().default(sql`0`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_merchant_wallet_currency_unique_idx").on(table.merchantId, table.currency),
  index("greenpay_merchant_wallet_currency_idx").on(table.currency),
]);

export const walletJournalsTable = pgTable("greenpay_wallet_journals", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  kind: varchar("kind", { length: 40 }).notNull(),
  reference: varchar("reference", { length: 200 }).notNull(),
  sourceReference: varchar("source_reference", { length: 200 }),
  evidenceReference: varchar("evidence_reference", { length: 200 }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull().unique(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_wallet_journals_merchant_created_idx").on(table.merchantId, table.createdAt),
  index("greenpay_wallet_journals_source_reference_idx").on(table.sourceReference),
]);

export const walletJournalEntriesTable = pgTable("greenpay_wallet_journal_entries", {
  id: serial("id").primaryKey(),
  journalId: integer("journal_id").notNull().references(() => walletJournalsTable.id),
  merchantId: integer("merchant_id"),
  currency: varchar("currency", { length: 3 }).notNull(),
  account: varchar("account", { length: 32 }).notNull(),
  direction: varchar("direction", { length: 6 }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_wallet_entries_journal_idx").on(table.journalId),
  index("greenpay_wallet_entries_merchant_idx").on(table.merchantId, table.currency),
]);

export const walletFxRatesTable = pgTable("greenpay_wallet_fx_rates", {
  id: serial("id").primaryKey(),
  fromCurrency: varchar("from_currency", { length: 3 }).notNull(),
  toCurrency: varchar("to_currency", { length: 3 }).notNull(),
  rate: numeric("rate", { precision: 24, scale: 12, mode: "number" }).notNull(),
  source: varchar("source", { length: 160 }).notNull(),
  sourceDate: varchar("source_date", { length: 10 }).notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_wallet_fx_rates_pair_source_date_unique_idx")
    .on(table.fromCurrency, table.toCurrency, table.sourceDate),
  index("greenpay_wallet_fx_rates_pair_fetched_idx").on(table.fromCurrency, table.toCurrency, table.fetchedAt),
]);

export const walletConversionsTable = pgTable("greenpay_wallet_conversions", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  fromCurrency: varchar("from_currency", { length: 3 }).notNull(),
  toCurrency: varchar("to_currency", { length: 3 }).notNull(),
  sourceMinor: bigint("source_minor", { mode: "bigint" }).notNull(),
  targetMinor: bigint("target_minor", { mode: "bigint" }).notNull(),
  feeMinor: bigint("fee_minor", { mode: "bigint" }).notNull(),
  sourceRate: numeric("source_rate", { precision: 24, scale: 12, mode: "number" }).notNull(),
  effectiveRate: numeric("effective_rate", { precision: 24, scale: 12, mode: "number" }).notNull(),
  markupBps: integer("markup_bps").notNull(),
  feeScheduleId: integer("fee_schedule_id"),
  rateSource: varchar("rate_source", { length: 160 }).notNull(),
  rateSourceDate: varchar("rate_source_date", { length: 10 }).notNull(),
  rateFetchedAt: timestamp("rate_fetched_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_wallet_conversions_merchant_key_unique_idx").on(table.merchantId, table.idempotencyKey),
  index("greenpay_wallet_conversions_merchant_created_idx").on(table.merchantId, table.createdAt),
]);

export const walletPayoutRequestsTable = pgTable("greenpay_wallet_payout_requests", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  reference: varchar("reference", { length: 100 }).notNull().unique(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  feeMinor: bigint("fee_minor", { mode: "bigint" }).notNull(),
  holdMinor: bigint("hold_minor", { mode: "bigint" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  method: varchar("method", { length: 120 }).notNull(),
  accountName: varchar("account_name", { length: 200 }).notNull(),
  maskedAccount: varchar("masked_account", { length: 80 }).notNull(),
  encryptedDestination: text("encrypted_destination").notNull(),
  status: varchar("status", { length: 24 }).notNull().default("requested"),
  provider: varchar("provider", { length: 24 }).notNull(),
  providerReference: varchar("provider_reference", { length: 200 }),
  reservationJournalId: integer("reservation_journal_id").notNull().references(() => walletJournalsTable.id),
  decisionReason: varchar("decision_reason", { length: 400 }),
  approvedBy: varchar("approved_by", { length: 128 }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_wallet_payout_merchant_key_unique_idx").on(table.merchantId, table.idempotencyKey),
  index("greenpay_wallet_payout_status_created_idx").on(table.status, table.createdAt),
  index("greenpay_wallet_payout_merchant_created_idx").on(table.merchantId, table.createdAt),
  index("greenpay_wallet_payout_provider_ref_idx").on(table.provider, table.providerReference),
]);

export const walletSettlementConfirmationsTable = pgTable("greenpay_wallet_settlement_confirmations", {
  id: serial("id").primaryKey(),
  settlementReference: varchar("settlement_reference", { length: 200 }).notNull().unique(),
  merchantId: integer("merchant_id").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  fundedMinor: bigint("funded_minor", { mode: "bigint" }).notNull(),
  evidenceReference: varchar("evidence_reference", { length: 200 }).notNull().unique(),
  journalId: integer("journal_id").notNull().references(() => walletJournalsTable.id),
  confirmedBy: varchar("confirmed_by", { length: 128 }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_wallet_confirmations_merchant_confirmed_idx").on(table.merchantId, table.confirmedAt),
]);

export const walletRefundAdjustmentsTable = pgTable("greenpay_wallet_refund_adjustments", {
  id: serial("id").primaryKey(),
  refundReference: varchar("refund_reference", { length: 120 }).notNull().unique(),
  transactionReference: varchar("transaction_reference", { length: 100 }).notNull(),
  merchantId: integer("merchant_id").notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("reserved"),
  reserveJournalId: integer("reserve_journal_id").notNull().references(() => walletJournalsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_wallet_refund_adjustments_transaction_idx").on(table.transactionReference),
  index("greenpay_wallet_refund_adjustments_merchant_idx").on(table.merchantId, table.currency),
]);

export type MerchantWalletRecord = typeof merchantWalletsTable.$inferSelect;
export type WalletJournalRecord = typeof walletJournalsTable.$inferSelect;
export type WalletPayoutRequestRecord = typeof walletPayoutRequestsTable.$inferSelect;