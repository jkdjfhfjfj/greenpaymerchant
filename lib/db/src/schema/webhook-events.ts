import { createInsertSchema } from "drizzle-zod";
import { index, integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const webhookEventsTable = pgTable("greenpay_webhook_events", {
  id: serial("id").primaryKey(),
  deliveryKey: varchar("delivery_key", { length: 128 }).notNull().unique(),
  provider: varchar("provider", { length: 24 }).notNull(),
  event: varchar("event", { length: 120 }).notNull(),
  reference: varchar("reference", { length: 100 }),
  status: varchar("status", { length: 24 }).notNull(),
  httpStatus: integer("http_status"),
  attempts: integer("attempts").notNull().default(1),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
}, (table) => [
  index("greenpay_webhook_events_provider_idx").on(table.provider),
  index("greenpay_webhook_events_status_idx").on(table.status),
  index("greenpay_webhook_events_received_at_idx").on(table.receivedAt),
]);

export const insertWebhookEventSchema = createInsertSchema(webhookEventsTable).omit({ id: true, receivedAt: true });
export type InsertWebhookEvent = z.infer<typeof insertWebhookEventSchema>;
export type WebhookEventRecord = typeof webhookEventsTable.$inferSelect;