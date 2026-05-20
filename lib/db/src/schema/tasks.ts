import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  serialNo: text("serial_no"),
  title: text("title").notNull(),
  description: text("description"),
  projectId: integer("project_id"),
  assigneeId: integer("assignee_id"),
  creatorId: integer("creator_id").notNull(),
  priority: text("priority").notNull().default("MEDIUM"),
  status: text("status").notNull().default("TODO"),
  progress: integer("progress").notNull().default(0),
  dueDate: timestamp("due_date", { withTimezone: true }),
  isArchived: integer("is_archived").notNull().default(0),
  groupId: integer("group_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  // showMyTasks: WHERE assignee_id=? AND is_archived=0 [AND status=?] ORDER BY updated_at DESC
  index("idx_tasks_assignee_arch_updated").on(t.assigneeId, t.isArchived, t.updatedAt),
  // showOverdueTasks / TODAY / DUESOON / reminders: WHERE is_archived=0 AND due_date <op> ?
  index("idx_tasks_arch_due").on(t.isArchived, t.dueDate),
  // showProjectTasks
  index("idx_tasks_project").on(t.projectId),
  // showArchivedTasks + global counts by archive flag w/ updated_at sort
  index("idx_tasks_arch_updated").on(t.isArchived, t.updatedAt),
  uniqueIndex("tasks_serial_no_unique").on(t.serialNo).where(sql`serial_no IS NOT NULL`),
]);

export const insertTaskSchema = createInsertSchema(tasksTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
