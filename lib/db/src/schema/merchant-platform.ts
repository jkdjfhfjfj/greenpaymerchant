import { boolean, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const merchantsTable = pgTable("greenpay_merchants", {
  id: serial("id").primaryKey(),
  ownerClerkId: varchar("owner_clerk_id", { length: 128 }).notNull().unique(),
  businessName: varchar("business_name", { length: 150 }).notNull(),
  country: varchar("country", { length: 2 }).notNull(),
  baseCurrency: varchar("base_currency", { length: 3 }).notNull(),
  registrationNumber: varchar("registration_number", { length: 150 }),
  status: varchar("status", { length: 24 }).notNull().default("pending"),
  paymentsEnabled: boolean("payments_enabled").notNull().default(true),
  apiAccessEnabled: boolean("api_access_enabled").notNull().default(true),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(true),
  refundsEnabled: boolean("refunds_enabled").notNull().default(true),
  kycStatus: varchar("kyc_status", { length: 24 }).notNull().default("not_started"),
  diditSessionId: varchar("didit_session_id", { length: 200 }),
  diditSessionUrl: text("didit_session_url"),
  diditKind: varchar("didit_kind", { length: 8 }),
  riskNote: varchar("risk_note", { length: 1000 }),
  verificationUpdatedAt: timestamp("verification_updated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_merchants_status_idx").on(table.status),
  index("greenpay_merchants_kyc_status_idx").on(table.kycStatus),
]);

export const merchantApiKeysTable = pgTable("greenpay_merchant_api_keys", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  prefix: varchar("prefix", { length: 20 }).notNull(),
  secretHash: varchar("secret_hash", { length: 64 }).notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("greenpay_api_keys_merchant_id_idx").on(table.merchantId),
  index("greenpay_api_keys_active_idx").on(table.revokedAt),
]);

export const merchantWebhookEndpointsTable = pgTable("greenpay_merchant_webhook_endpoints", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  url: text("url").notNull(),
  events: jsonb("events").$type<string[]>().notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_webhook_endpoints_merchant_id_idx").on(table.merchantId),
]);

export const feeSchedulesTable = pgTable("greenpay_fee_schedules", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id"),
  percentage: numeric("percentage", { precision: 8, scale: 4, mode: "number" }).notNull(),
  flatAmount: numeric("flat_amount", { precision: 18, scale: 2, mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  fxMarkupBps: integer("fx_markup_bps").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_fee_schedules_merchant_unique_idx").on(table.merchantId),
]);

export const fxRatesTable = pgTable("greenpay_fx_rates", {
  id: serial("id").primaryKey(),
  fromCurrency: varchar("from_currency", { length: 3 }).notNull(),
  toCurrency: varchar("to_currency", { length: 3 }).notNull(),
  rate: numeric("rate", { precision: 20, scale: 10, mode: "number" }).notNull(),
  active: boolean("active").notNull().default(true),
  source: varchar("source", { length: 150 }).notNull(),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_fx_rates_pair_idx").on(table.fromCurrency, table.toCurrency),
  index("greenpay_fx_rates_active_idx").on(table.active),
]);

export const platformSettingsTable = pgTable("greenpay_platform_settings", {
  id: integer("id").primaryKey().default(1),
  newMerchantSignups: boolean("new_merchant_signups").notNull().default(true),
  paymentsEnabled: boolean("payments_enabled").notNull().default(true),
  payoutsEnabled: boolean("payouts_enabled").notNull().default(true),
  refundsEnabled: boolean("refunds_enabled").notNull().default(true),
  apiAccessEnabled: boolean("api_access_enabled").notNull().default(true),
  kycRequired: boolean("kyc_required").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const developerIdempotencyTable = pgTable("greenpay_developer_idempotency", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("in_flight"),
  response: jsonb("response").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_developer_idempotency_merchant_key_idx").on(table.merchantId, table.idempotencyKey),
  index("greenpay_developer_idempotency_status_idx").on(table.status),
]);

export const payoutIdempotencyTable = pgTable("greenpay_payout_idempotency", {
  id: serial("id").primaryKey(),
  idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull().unique(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  payoutId: integer("payout_id"),
  status: varchar("status", { length: 20 }).notNull().default("in_flight"),
  response: jsonb("response").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_payout_idempotency_status_idx").on(table.status),
]);

export const merchantWebhookOutboxTable = pgTable("greenpay_merchant_webhook_outbox", {
  id: serial("id").primaryKey(),
  transactionId: integer("transaction_id").notNull(),
  merchantId: integer("merchant_id").notNull(),
  endpointId: integer("endpoint_id").notNull(),
  event: varchar("event", { length: 100 }).notNull(),
  deliveryId: varchar("delivery_id", { length: 250 }).notNull(),
  destinationUrl: text("destination_url").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  payload: text("payload").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastStatusCode: integer("last_status_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_merchant_webhook_outbox_delivery_idx").on(table.transactionId, table.endpointId, table.event),
  index("greenpay_merchant_webhook_outbox_status_idx").on(table.status, table.nextAttemptAt),
]);

export const providerCredentialsTable = pgTable("greenpay_provider_credentials", {
  id: serial("id").primaryKey(),
  provider: varchar("provider", { length: 24 }).notNull().unique(),
  encryptedCredentials: text("encrypted_credentials").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminAuditLogTable = pgTable("greenpay_admin_audit_log", {
  id: serial("id").primaryKey(),
  actor: varchar("actor", { length: 128 }).notNull(),
  action: varchar("action", { length: 100 }).notNull(),
  target: varchar("target", { length: 200 }).notNull(),
  details: text("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_admin_audit_log_created_at_idx").on(table.createdAt),
  index("greenpay_admin_audit_log_actor_idx").on(table.actor),
]);

export type MerchantRecord = typeof merchantsTable.$inferSelect;
export type MerchantApiKeyRecord = typeof merchantApiKeysTable.$inferSelect;