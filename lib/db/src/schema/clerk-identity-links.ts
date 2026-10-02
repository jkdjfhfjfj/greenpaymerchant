import { index, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";

export const clerkIdentityLinksTable = pgTable("greenpay_clerk_identity_links", {
  externalClerkUserId: varchar("external_clerk_user_id", { length: 128 }).primaryKey(),
  legacyClerkUserId: varchar("legacy_clerk_user_id", { length: 128 }),
  resolution: varchar("resolution", { length: 16 })
    .$type<"linked" | "unmatched" | "ambiguous" | "conflict">()
    .notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_clerk_identity_links_legacy_unique_idx").on(table.legacyClerkUserId),
  index("greenpay_clerk_identity_links_resolution_idx").on(table.resolution, table.resolvedAt),
]);

export type ClerkIdentityLink = typeof clerkIdentityLinksTable.$inferSelect;