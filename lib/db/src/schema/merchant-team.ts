import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, serial, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const merchantTeamMembersTable = pgTable("greenpay_merchant_team_members", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  clerkUserId: varchar("clerk_user_id", { length: 128 }).notNull(),
  email: varchar("email", { length: 254 }).notNull(),
  role: varchar("role", { length: 16 }).$type<"finance" | "viewer">().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_merchant_team_member_user_unique_idx").on(table.merchantId, table.clerkUserId),
  uniqueIndex("greenpay_merchant_team_member_active_workspace_idx")
    .on(table.clerkUserId)
    .where(sql`${table.active} = true`),
  index("greenpay_merchant_team_member_access_idx").on(table.clerkUserId, table.active),
  index("greenpay_merchant_team_member_merchant_idx").on(table.merchantId, table.active),
]);

export const merchantTeamInvitationsTable = pgTable("greenpay_merchant_team_invitations", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").notNull(),
  email: varchar("email", { length: 254 }).notNull(),
  role: varchar("role", { length: 16 }).$type<"finance" | "viewer">().notNull(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  createdByClerkId: varchar("created_by_clerk_id", { length: 128 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("greenpay_merchant_team_invites_merchant_idx").on(table.merchantId, table.createdAt),
  index("greenpay_merchant_team_invites_email_idx").on(table.email, table.expiresAt),
]);

export const insertMerchantTeamMemberSchema = createInsertSchema(merchantTeamMembersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMerchantTeamInvitationSchema = createInsertSchema(merchantTeamInvitationsTable).omit({ id: true, createdAt: true });
export type InsertMerchantTeamMember = z.infer<typeof insertMerchantTeamMemberSchema>;
export type InsertMerchantTeamInvitation = z.infer<typeof insertMerchantTeamInvitationSchema>;
export type MerchantTeamMember = typeof merchantTeamMembersTable.$inferSelect;
export type MerchantTeamInvitation = typeof merchantTeamInvitationsTable.$inferSelect;