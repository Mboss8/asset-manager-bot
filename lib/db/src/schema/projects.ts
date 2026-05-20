import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("ACTIVE"),
  isArchived: integer("is_archived").notNull().default(0),
  ownerId: integer("owner_id").notNull(),
  groupId: integer("group_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  // showProjectList: WHERE is_archived=? [AND status=?] ORDER BY updated_at DESC
  index("idx_projects_arch_updated").on(t.isArchived, t.updatedAt),
]);

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;

export const milestonesTable = pgTable("milestones", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  title: text("title").notNull(),
  dueDate: timestamp("due_date", { withTimezone: true }),
  status: text("status").notNull().default("PENDING"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // milestones list per project ORDER BY due_date
  index("idx_milestones_project_due").on(t.projectId, t.dueDate),
]);

export const risksTable = pgTable("risks", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id"),
  title: text("title").notNull(),
  description: text("description"),
  severity: text("severity").notNull().default("MEDIUM"),
  reporterId: integer("reporter_id").notNull(),
  status: text("status").notNull().default("OPEN"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("idx_risks_project").on(t.projectId),
  index("idx_risks_status").on(t.status),
]);
