import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FLOWS } from "./flows.js";
import { ACTION_PERMISSIONS } from "./permissions.js";
import { ALL_ROUTES } from "./routes/index.js";
import { logger } from "../lib/logger.js";

/**
 * Boot-time architectural invariant enforcement (R1/R2/R3 from replit.md).
 *
 * Runs once at bot startup. Hard-fails the process on R1 violations
 * (security-relevant ACL drift). Soft-warns on R2 (switch growth) unless
 * `CI=true`, where it also fails — preventing rule drift from sneaking
 * past local dev into prod.
 *
 * Philosophy: "policy enforcement at boot boundary". Replaces tribal
 * knowledge / chat-thread agreements with executable assertions. Future
 * sessions inherit the rules whether they read replit.md or not.
 */

/**
 * Total `case "..."` count in `bot/index.ts` (legacy callback switch).
 *
 * **Update this DOWN — never up.** Each module migration out of the switch
 * shrinks this number; bump it down by the lines removed in the same PR.
 *
 * History:
 *   77 — B3 P3 (2026-05-10) — after GROUPS migration to router-table
 */
const SWITCH_CASE_BASELINE = 55;

function assertFlowAclExists(): void {
  const missing: string[] = [];
  for (const [key, def] of Object.entries(FLOWS)) {
    // TS marks `acl` required, but defensively check at runtime too —
    // covers cases where a JS-shaped object slips into the registry.
    if (!def.acl || typeof def.acl !== "string") missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `[INVARIANT R1] FLOW ACL missing on: ${missing.join(", ")}. ` +
        `Every flow must declare \`acl\` (use canonical action key for ALL_USERS flows).`,
    );
  }
}

function assertNoOrphanFlowAcl(): void {
  const orphans: { flow: string; acl: string }[] = [];
  for (const [key, def] of Object.entries(FLOWS)) {
    if (!(def.acl in ACTION_PERMISSIONS)) {
      orphans.push({ flow: key, acl: def.acl });
    }
  }
  if (orphans.length > 0) {
    for (const o of orphans) {
      logger.error({ flow: o.flow, missingKey: o.acl }, "FLOW ACL ORPHAN DETECTED");
    }
    throw new Error(
      `[INVARIANT R1] FLOW ACL orphan(s) — keys not in ACTION_PERMISSIONS: ` +
        orphans.map((o) => `${o.flow} → ${o.acl}`).join(", "),
    );
  }
}

function assertRouteAclResolvable(): void {
  const orphans: { pattern: string; acl: string }[] = [];
  for (const r of ALL_ROUTES) {
    if (r.noAcl) continue;
    // Mirror tryDispatch's resolution: explicit `r.acl`, else default
    // `${parts[0]}:${parts[1]}` derived from the literal pattern prefix.
    const segs = r.pattern.split(":");
    const effective = r.acl ?? `${segs[0]}:${segs[1]}`;
    if (!(effective in ACTION_PERMISSIONS)) {
      orphans.push({ pattern: r.pattern, acl: effective });
    }
  }
  if (orphans.length > 0) {
    for (const o of orphans) {
      logger.error({ pattern: o.pattern, missingKey: o.acl }, "ROUTE ACL ORPHAN DETECTED");
    }
    throw new Error(
      `[INVARIANT R1] ROUTE ACL orphan(s) — keys not in ACTION_PERMISSIONS: ` +
        orphans.map((o) => `${o.pattern} → ${o.acl}`).join(", "),
    );
  }
}

/**
 * Locate `src/bot/index.ts` cwd-agnostically. The api-server is bundled
 * via esbuild into `dist/index.mjs`, so `import.meta.url` at runtime is
 * `.../artifacts/api-server/dist/index.mjs` regardless of where the process
 * was launched from. We probe a few candidate paths off that anchor +
 * cwd as a final fallback.
 */
function findSwitchSource(): string | null {
  const candidates: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // bundled: dist/ → ../src/bot/index.ts
    candidates.push(resolve(here, "..", "src", "bot", "index.ts"));
    // dev (tsx, unbundled): src/bot/ → index.ts in same dir
    candidates.push(resolve(here, "index.ts"));
  } catch {
    // import.meta.url unavailable — fall through to cwd probe
  }
  // cwd-relative — covers `pnpm --filter ... dev` (cwd = artifacts/api-server)
  candidates.push(resolve(process.cwd(), "src", "bot", "index.ts"));
  // cwd-relative — covers running from repo root
  candidates.push(resolve(process.cwd(), "artifacts", "api-server", "src", "bot", "index.ts"));
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      // try next
    }
  }
  return null;
}

function assertSwitchShrinkage(): { ran: boolean; count?: number } {
  const src = findSwitchSource();
  if (src === null) {
    const msg =
      "[INVARIANT R2] switch-shrinkage check could not locate src/bot/index.ts " +
      "(tried import.meta.url-anchored + cwd-relative paths). Guardrail effectively disabled.";
    if (process.env.CI === "true") throw new Error(msg);
    logger.warn(msg);
    return { ran: false };
  }
  const matches = src.match(/^\s*case\s+["']/gm);
  const count = matches?.length ?? 0;
  if (count > SWITCH_CASE_BASELINE) {
    const msg =
      `[INVARIANT R2] Legacy switch grew: ${count} > baseline ${SWITCH_CASE_BASELINE}. ` +
      `R2 violation — every round must shrink, never grow. ` +
      `Either migrate the new module to router-table or update the baseline DOWN in invariants.ts.`;
    if (process.env.CI === "true") throw new Error(msg);
    logger.warn({ count, baseline: SWITCH_CASE_BASELINE }, msg);
  } else if (count < SWITCH_CASE_BASELINE) {
    logger.info(
      { count, baseline: SWITCH_CASE_BASELINE },
      `[INVARIANT R2] Switch shrunk ${SWITCH_CASE_BASELINE} → ${count}. ` +
        `Update SWITCH_CASE_BASELINE in invariants.ts to lock the new floor.`,
    );
  }
  return { ran: true, count };
}

export function assertInvariants(): void {
  assertFlowAclExists();
  assertNoOrphanFlowAcl();
  assertRouteAclResolvable();
  const r2 = assertSwitchShrinkage();
  // Per-invariant status field so operators can see at a glance whether R2
  // actually ran (vs silently skipped due to source not being on disk).
  // R1-A/B/C either pass or throw — no skip path — so they're implicitly OK
  // by the time we reach this log line.
  logger.info(
    {
      flows: Object.keys(FLOWS).length,
      routes: ALL_ROUTES.length,
      r1a: "ok",
      r1b: "ok",
      r1c: "ok",
      r2: r2.ran ? `ok(${r2.count})` : "skipped",
    },
    "[INVARIANT] Architectural invariants checked",
  );
}
