import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

export const botSessionsTable = pgTable("bot_sessions", {
  id: serial("id").primaryKey(),
  telegramId: text("telegram_id").notNull().unique(),
  sessionData: text("session_data").notNull().default("{}"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
