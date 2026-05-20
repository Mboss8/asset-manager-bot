import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  serialNo: text("serial_no"),
  title: text("title").notNull(),
  fileId: text("file_id"),
  fileType: text("file_type"),
  url: text("url"),
  category: text("category").notNull().default("OTHER"),
  tags: text("tags"),
  projectId: integer("project_id"),
  creatorId: integer("creator_id").notNull(),
  isPinned: integer("is_pinned").notNull().default(0),
  isArchived: integer("is_archived").notNull().default(0),
  groupId: integer("group_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => [
  // showDocList ALL/PINNED/ARCH: WHERE is_archived=? [AND is_pinned=1] ORDER BY is_pinned DESC, updated_at DESC
  index("idx_documents_arch_pinned_updated").on(t.isArchived, t.isPinned, t.updatedAt),
  // showDocsByCategory: WHERE category=? AND is_archived=0 ORDER BY is_pinned DESC, updated_at DESC
  index("idx_documents_category_arch").on(t.category, t.isArchived),
  // MINE filter: WHERE is_archived=0 AND creator_id=?
  index("idx_documents_creator").on(t.creatorId),
  uniqueIndex("documents_serial_no_unique").on(t.serialNo).where(sql`serial_no IS NOT NULL`),
  index("idx_documents_project").on(t.projectId),
]);

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
