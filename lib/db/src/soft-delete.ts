import { isNull, isNotNull } from "drizzle-orm";

export type SoftDeleteMode = "active" | "all" | "deleted";

/**
 * Default predicate: rows that have NOT been soft-deleted.
 * Use in WHERE clauses: where(and(eq(t.id, id), notDeleted(t)))
 */
export function notDeleted<T extends { deletedAt: unknown }>(table: T) {
  return isNull(table.deletedAt as never);
}

/**
 * Predicate: only rows that HAVE been soft-deleted (recycle-bin views).
 */
export function onlyDeleted<T extends { deletedAt: unknown }>(table: T) {
  return isNotNull(table.deletedAt as never);
}

/**
 * Mode-driven predicate. Returns `undefined` for "all" (caller should
 * conditionally append it).
 */
export function softDeleteWhere<T extends { deletedAt: unknown }>(
  table: T,
  mode: SoftDeleteMode = "active",
) {
  if (mode === "all") return undefined;
  if (mode === "deleted") return onlyDeleted(table);
  return notDeleted(table);
}
