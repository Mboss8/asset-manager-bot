import { pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  // Nullable: NULL = system-triggered audit (e.g., scheduled broadcast SEND_FAIL / NO_TARGET).
  // User-triggered audits always carry a non-null userId.
  userId: integer("user_id"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: integer("target_id"),
  details: text("details"),
  auditLevel: text("audit_level").notNull().default("LOW"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // SET:AUDIT pagination: ORDER BY created_at DESC, optional WHERE level=? / action LIKE ?
  index("idx_audit_created_at").on(t.createdAt),
  index("idx_audit_action").on(t.action),
  index("idx_audit_level_created").on(t.auditLevel, t.createdAt),
  // Member detail "last activity": WHERE user_id=? ORDER BY created_at DESC LIMIT 1
  index("idx_audit_user_created").on(t.userId, t.createdAt),
]);
