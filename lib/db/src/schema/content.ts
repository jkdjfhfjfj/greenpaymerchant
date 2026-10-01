import { createInsertSchema } from "drizzle-zod";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";

export const contentKindValues = ["guide", "article", "faq"] as const;
export const contentStatusValues = ["draft", "published"] as const;

export const publicContentTable = pgTable("greenpay_public_content", {
  id: serial("id").primaryKey(),
  kind: varchar("kind", { length: 16 }).$type<(typeof contentKindValues)[number]>().notNull(),
  status: varchar("status", { length: 16 }).$type<(typeof contentStatusValues)[number]>().notNull().default("draft"),
  title: varchar("title", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 120 }).notNull(),
  summary: varchar("summary", { length: 300 }).notNull(),
  body: text("body").notNull(),
  version: integer("version").notNull().default(1),
  createdBy: varchar("created_by", { length: 128 }),
  updatedBy: varchar("updated_by", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("greenpay_public_content_slug_unique_idx").on(table.slug),
  index("greenpay_public_content_publication_idx").on(table.status, table.kind, table.updatedAt),
  check("greenpay_public_content_kind_check", sql`${table.kind} in ('guide', 'article', 'faq')`),
  check("greenpay_public_content_status_check", sql`${table.status} in ('draft', 'published')`),
  check("greenpay_public_content_published_at_check", sql`(${table.status} = 'draft' and ${table.publishedAt} is null) or (${table.status} = 'published' and ${table.publishedAt} is not null)`),
  check("greenpay_public_content_slug_check", sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
]);

export const publicContentVersionsTable = pgTable("greenpay_public_content_versions", {
  id: serial("id").primaryKey(),
  contentId: integer("content_id").notNull(),
  version: integer("version").notNull(),
  kind: varchar("kind", { length: 16 }).$type<(typeof contentKindValues)[number]>().notNull(),
  status: varchar("status", { length: 16 }).$type<(typeof contentStatusValues)[number]>().notNull(),
  title: varchar("title", { length: 160 }).notNull(),
  slug: varchar("slug", { length: 120 }).notNull(),
  summary: varchar("summary", { length: 300 }).notNull(),
  body: text("body").notNull(),
  createdBy: varchar("created_by", { length: 128 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("greenpay_public_content_version_unique_idx").on(table.contentId, table.version),
  index("greenpay_public_content_versions_content_idx").on(table.contentId, table.createdAt),
]);

export const insertPublicContentSchema = createInsertSchema(publicContentTable).omit({
  id: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
});
export type InsertPublicContent = z.infer<typeof insertPublicContentSchema>;
export type PublicContentRecord = typeof publicContentTable.$inferSelect;
export type PublicContentVersion = typeof publicContentVersionsTable.$inferSelect;