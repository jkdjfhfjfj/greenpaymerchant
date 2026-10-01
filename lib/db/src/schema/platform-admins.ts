import { index, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const platformAdminAssignmentsTable = pgTable("greenpay_platform_admin_assignments", {
  clerkUserId: varchar("clerk_user_id", { length: 128 }).primaryKey(),
  verifiedEmailSnapshot: varchar("verified_email_snapshot", { length: 254 }).notNull(),
  assignedByClerkUserId: varchar("assigned_by_clerk_user_id", { length: 128 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("greenpay_platform_admin_assignments_active_idx").on(table.revokedAt),
  index("greenpay_platform_admin_assignments_assigned_by_idx").on(table.assignedByClerkUserId),
]);

export type PlatformAdminAssignment = typeof platformAdminAssignmentsTable.$inferSelect;