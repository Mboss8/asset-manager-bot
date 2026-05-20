import type { Route } from "../router-table.js";
import { GROUPS_ROUTES } from "./groups.js";
import { BI_ROUTES } from "./bi.js";
import { MEMBERS_ROUTES } from "./members.js";
import { TRASH_ROUTES } from "./trash.js";

/**
 * Aggregate route table.
 *
 * As modules migrate from the legacy `index.ts` switch into the table,
 * append their route arrays here. Handlers in `index.ts` fall back to
 * the legacy switch only when no table route matches — so migration is
 * incremental and per-module.
 *
 * Migrated:
 *   - GROUPS  (B3 P3,   2026-05-09) — first module on new infrastructure
 *   - MEM     (B3 P3.3, 2026-05-10)
 *   - TRASH   (B3 P3.3, 2026-05-10)
 *   - BI      (B3 P3.4, 2026-05-10)
 *
 * Not yet migrated (still in index.ts switch):
 *   PROJ, TASK, REQ, DOC, FIN, SET
 */
export const ALL_ROUTES: Route[] = [
  ...GROUPS_ROUTES,
  ...BI_ROUTES,
  ...MEMBERS_ROUTES,
  ...TRASH_ROUTES,
];
