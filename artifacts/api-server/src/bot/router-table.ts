import type { Role } from "./permissions.js";
import { canExecuteAction } from "./permissions.js";
import { logger } from "../lib/logger.js";

/**
 * Table-driven callback router.
 *
 * Replaces the per-module `if (action === "X") ... if (action === "Y") ...`
 * cascade in `index.ts` with declarative routes. Each route declares:
 *   - a callback pattern (literal segments + named placeholders)
 *   - the ACL key to enforce (defaults to `MODULE:ACTION`)
 *   - whether to pre-ack the callback query
 *   - the handler to run
 *
 * Routes are tried in order; first match wins. List most-specific patterns
 * first when two patterns can both match.
 */

export type RouteCtx = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
  parts: string[];
  args: Record<string, string>;
  role: Role;
  telegramId: string;
};

export type Route = {
  /**
   * Pattern grammar (segments split by `:`):
   *   `FOO`            — literal segment, must match exactly
   *   `<name>`         — required placeholder, captures any non-empty string
   *   `<name?>`        — optional trailing placeholder; defaults to `""`
   *   `<name:int>`     — required, must match `/^\d+$/`
   *   `<name:int?>`    — optional trailing, must be digits or absent
   *
   * Optional placeholders may appear only at the tail of the pattern.
   * Use `:int` for ids/offsets so the matcher rejects malformed input
   * (e.g. `GROUPS:VIEW:1abc`) before the handler ever sees it — defense
   * in depth on top of `parseInt` inside handlers.
   *
   * Examples:
   *   `GROUPS:LIST:<offset:int?>`   matches `GROUPS:LIST` or `GROUPS:LIST:20`
   *   `GROUPS:VIEW:<id:int>`        matches `GROUPS:VIEW:5` (rejects `5x`)
   *   `TASK:MY:<filter?>:<off:int?>` matches `TASK:MY`, `TASK:MY:ALL`, `TASK:MY:ALL:20`
   */
  pattern: string;
  /** ACL key looked up in `ACTION_PERMISSIONS`. Defaults to `${parts[0]}:${parts[1]}`. */
  acl?: string;
  /** Call `ctx.answerCbQuery()` before the handler. Default true. */
  preAck?: boolean;
  /** Skip ACL enforcement entirely (e.g. for FORM:CANCEL). Default false. */
  noAcl?: boolean;
  handler: (rctx: RouteCtx) => Promise<void>;
};

type ParsedSeg =
  | { kind: "lit"; value: string }
  | { kind: "ph"; name: string; optional: boolean; type: "str" | "int" };

const DIGIT_RE = /^\d+$/;

function parseSeg(seg: string): ParsedSeg {
  if (!(seg.startsWith("<") && seg.endsWith(">"))) {
    return { kind: "lit", value: seg };
  }
  const inner = seg.slice(1, -1); // strip < >
  const optional = inner.endsWith("?");
  const core = optional ? inner.slice(0, -1) : inner;
  const colonIdx = core.indexOf(":");
  const name = colonIdx === -1 ? core : core.slice(0, colonIdx);
  const typeTag = colonIdx === -1 ? "str" : core.slice(colonIdx + 1);
  const type: "str" | "int" = typeTag === "int" ? "int" : "str";
  return { kind: "ph", name, optional, type };
}

function matchPattern(pattern: string, parts: string[]): Record<string, string> | null {
  const pp = pattern.split(":").map(parseSeg);
  // Defensive: optional placeholders must all be trailing.
  let sawOpt = false;
  for (const seg of pp) {
    if (seg.kind === "ph" && seg.optional) sawOpt = true;
    else if (sawOpt) return null;
  }
  if (parts.length > pp.length) return null;

  const args: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i];
    const v = parts[i];
    if (seg.kind === "lit") {
      if (v !== seg.value) return null;
      continue;
    }
    if (v === undefined) {
      if (seg.optional) { args[seg.name] = ""; continue; }
      return null;
    }
    if (v === "") {
      // Empty segment from `FOO::` is rejected — surprising and almost always a bug.
      return null;
    }
    if (seg.type === "int" && !DIGIT_RE.test(v)) return null;
    args[seg.name] = v;
  }
  return args;
}

/**
 * Try to dispatch `data` against `routes` in order.
 *
 * Returns `true` if a route matched (handler ran, or ACL denied with toast).
 * Returns `false` if no route matched — caller may fall back to legacy switch.
 *
 * Centralized ACL: each matching route enforces its `acl` (or default
 * `MODULE:ACTION`) before invoking the handler. Handlers therefore never
 * need to repeat `canExecuteAction()`. The same enforcement model is used
 * by `submitForm` via `FlowDef.acl` — so privileged operations have one
 * declarative source of truth at every entry point.
 */
export async function tryDispatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  data: string,
  role: Role,
  telegramId: string,
  routes: Route[],
): Promise<boolean> {
  const parts = data.split(":");
  for (const r of routes) {
    const args = matchPattern(r.pattern, parts);
    if (args === null) continue;
    if (!r.noAcl) {
      // Fail closed: a route without an explicit `acl` and without a 2nd
      // segment would derive `MODULE:undefined`, which `canExecuteAction`
      // treats as unknown → allow. That silently bypasses authz on any
      // future single-segment route. Force operators to declare intent.
      if (!r.acl && parts.length < 2) {
        await ctx.answerCbQuery("⛔ 操作未授权（缺少 ACL 声明）", { show_alert: true });
        logger.error({ pattern: r.pattern, data }, "Single-segment route missing explicit acl");
        return true;
      }
      const aclKey = r.acl ?? `${parts[0]}:${parts[1]}`;
      if (!canExecuteAction(role, aclKey)) {
        await ctx.answerCbQuery("⛔ 你没有权限执行该操作", { show_alert: true });
        logger.warn({ telegramId, role, aclKey, data }, "Authz blocked callback (table)");
        return true;
      }
    }
    if (r.preAck !== false) {
      try { await ctx.answerCbQuery(); } catch { /* expired query */ }
    }
    try {
      await r.handler({ ctx, parts, args, role, telegramId });
    } catch (err) {
      logger.error({ err, data, pattern: r.pattern }, "Route handler error");
      try { await ctx.answerCbQuery("❌ 操作失败，请重试", { show_alert: true }); } catch { /* ignore */ }
    }
    return true;
  }
  return false;
}
