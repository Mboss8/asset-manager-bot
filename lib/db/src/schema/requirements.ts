import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const requirementsTable = pgTable("requirements", {
  id: serial("id").primaryKey(),
  serialNo: text("serial_no"),
  title: text("title").notNull(),
  background: text("background").notNull(),
  acceptance: text("acceptance").notNull(),
  priority: text("priority").notNull().default("MEDIUM"),
  status: text("status").notNull().default("PENDING"),
  projectId: integer("project_id"),
  creatorId: integer("creator_id").notNull(),
  reviewNote: text("review_note"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  isArchived: integer("is_archived").notNull().default(0),
  groupId: integer("group_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  // showReqList: WHERE is_archived=0 AND status=? ORDER BY updated_at DESC, or WHERE is_archived=1 ...
  index("idx_requirements_arch_status_updated").on(t.isArchived, t.status, t.updatedAt),
  index("idx_requirements_project").on(t.projectId),
  uniqueIndex("requirements_serial_no_unique").on(t.serialNo).where(sql`serial_no IS NOT NULL`),
]);

export const insertRequirementSchema = createInsertSchema(requirementsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRequirement = z.infer<typeof insertRequirementSchema>;
export type Requirement = typeof requirementsTable.$inferSelect;
