import { index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const legalPolicyTypes = ["privacy_policy", "terms_of_service"] as const;
export type LegalPolicyType = (typeof legalPolicyTypes)[number];

export const legalPoliciesTable = pgTable("greenpay_legal_policies", {
  policyType: varchar("policy_type", { length: 24 }).$type<LegalPolicyType>().primaryKey(),
  slug: varchar("slug", { length: 40 }).notNull().unique(),
  draftTitle: varchar("draft_title", { length: 160 }).notNull(),
  draftContent: text("draft_content").notNull().default(""),
  publishedTitle: varchar("published_title", { length: 160 }),
  publishedContent: text("published_content"),
  publishedVersion: integer("published_version").notNull().default(0),
  draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  updatedBy: varchar("updated_by", { length: 128 }),
});

export const legalPolicyVersionsTable = pgTable("greenpay_legal_policy_versions", {
  id: serial("id").primaryKey(),
  policyType: varchar("policy_type", { length: 24 }).$type<LegalPolicyType>().notNull(),
  version: integer("version").notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  content: text("content").notNull(),
  publishedBy: varchar("published_by", { length: 128 }).notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_legal_policy_version_unique_idx").on(table.policyType, table.version),
  index("greenpay_legal_policy_versions_history_idx").on(table.policyType, table.publishedAt),
]);

export const legalPolicyAcceptancesTable = pgTable("greenpay_legal_policy_acceptances", {
  id: serial("id").primaryKey(),
  clerkUserId: varchar("clerk_user_id", { length: 128 }).notNull(),
  policyType: varchar("policy_type", { length: 24 }).$type<LegalPolicyType>().notNull(),
  version: integer("version").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_legal_policy_acceptance_unique_idx").on(table.clerkUserId, table.policyType, table.version),
  index("greenpay_legal_policy_acceptance_user_idx").on(table.clerkUserId, table.acceptedAt),
]);