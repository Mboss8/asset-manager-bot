import { pgTable, text, serial, timestamp, integer, bigint, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const groupsTable = pgTable("groups", {
  id: serial("id").primaryKey(),
  tgChatId: bigint("tg_chat_id", { mode: "bigint" }).notNull().unique(),
  chatType: text("chat_type").notNull(),
  title: text("title").notNull(),
  isEnabled: integer("is_enabled").notNull().default(1),
  defaultReportChannelId: bigint("default_report_channel_id", { mode: "bigint" }),
  financeReportChannelId: bigint("finance_report_channel_id", { mode: "bigint" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  index("idx_groups_enabled").on(t.isEnabled),
]);

export const insertGroupSchema = createInsertSchema(groupsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertGroup = z.infer<typeof insertGroupSchema>;
export type Group = typeof groupsTable.$inferSelect;
