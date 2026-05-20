import { db, groupsTable, projectsTable, notDeleted, type Group } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

/**
 * Tiny in-memory cache for the enabled-groups list.
 * Routing is invoked on every broadcast → don't hit DB each time.
 * 30 s TTL is conservative; invalidate explicitly on group writes (P2 admin UI).
 */
const TTL_MS = 30_000;
let cache: { groups: Group[]; expiresAt: number } | null = null;

export async function listEnabledGroups(): Promise<Group[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.groups;
  try {
    const rows = await db.select().from(groupsTable);
    // Filter & sort in memory: enabled, non-deleted, oldest first (stable
    // "first enabled group" tiebreak across processes).
    const groups = rows
      .filter((g) => g.isEnabled === 1 && g.deletedAt == null)
      .sort((a, b) => a.id - b.id);
    cache = { groups, expiresAt: now + TTL_MS };
    return groups;
  } catch (err) {
    logger.warn({ err }, "Failed to load groups — falling back to env-only routing");
    return [];
  }
}

/** Force a refresh on the next call. Call after any write to groupsTable. */
export function invalidateGroupsCache(): void {
  cache = null;
}

/**
 * P1 routing helper — resolves a projectId into its bound groupId, if any.
 *
 * The pure routing core (`getBroadcastTargets`) deliberately does NOT take a
 * project→group map: keeping it pure means routing logic stays unit-testable
 * without DB fixtures. The lookup lives here, in the IO layer.
 *
 * Usage in P1 call-sites:
 *   const groupId = await resolveGroupIdForProject(task.projectId);
 *   await dispatchBroadcast(tg, "TASK_CREATE", { projectId: task.projectId, groupId }, text);
 *
 * Returns null when projectId is null, project doesn't exist, project is
 * soft-deleted, or project has no groupId binding — in all cases the routing
 * core falls back to "first enabled group" or env.
 */
export async function resolveGroupIdForProject(projectId: number | null | undefined): Promise<number | null> {
  if (projectId == null) return null;
  try {
    const rows = await db
      .select({ groupId: projectsTable.groupId })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)))
      .limit(1);
    return rows[0]?.groupId ?? null;
  } catch (err) {
    logger.warn({ err, projectId }, "Failed to resolve project→group mapping");
    return null;
  }
}
