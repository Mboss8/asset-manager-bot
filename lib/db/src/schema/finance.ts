import { pgTable, text, serial, timestamp, integer, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const financeRecordsTable = pgTable("finance_records", {
  id: serial("id").primaryKey(),
  serialNo: text("serial_no"),
  ledgerSerial: text("ledger_serial"),
  type: text("type").notNull(),
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("CNY"),
  purpose: text("purpose").notNull(),
  projectId: integer("project_id"),
  creatorId: integer("creator_id").notNull(),
  status: text("status").notNull().default("PENDING_APPROVAL"),
  proofFileId: text("proof_file_id"),
  reviewNote: text("review_note"),
  reviewerId: integer("reviewer_id"),
  occurDate: timestamp("occur_date", { withTimezone: true }).notNull().defaultNow(),
  isArchived: integer("is_archived").notNull().default(0),
  groupId: integer("group_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  // showFinList: WHERE is_archived=0 AND status=? ORDER BY updated_at DESC, or WHERE is_archived=1 ORDER BY updated_at DESC
  index("idx_finance_arch_status_updated").on(t.isArchived, t.status, t.updatedAt),
  index("idx_finance_project").on(t.projectId),
  // monthly report: WHERE is_archived=0 AND occur_date BETWEEN ?
  index("idx_finance_arch_occur").on(t.isArchived, t.occurDate),
  uniqueIndex("finance_records_serial_no_unique").on(t.serialNo).where(sql`serial_no IS NOT NULL`),
  uniqueIndex("finance_records_ledger_serial_unique").on(t.ledgerSerial).where(sql`ledger_serial IS NOT NULL`),
]);

export const insertFinanceRecordSchema = createInsertSchema(financeRecordsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFinanceRecord = z.infer<typeof insertFinanceRecordSchema>;
export type FinanceRecord = typeof financeRecordsTable.$inferSelect;
