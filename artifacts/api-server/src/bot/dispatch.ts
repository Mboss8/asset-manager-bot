import type { Telegram } from "telegraf";
import { db, auditLogsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import {
  getBroadcastTargets,
  type BroadcastEvent,
  type BroadcastContext,
  type RoutingResolution,
} from "./routing.js";
import { listEnabledGroups } from "./group-service.js";

const ENV = {
  groupId: process.env["TELEGRAM_GROUP_ID"],
  channelId: process.env["TELEGRAM_CHANNEL_ID"],
};

export type DispatchResult = {
  /** True if at least one target was successfully reached. */
  ok: boolean;
  /** Number of targets attempted. */
  attempted: number;
  /** Number of targets that succeeded. */
  delivered: number;
  /** Routing diagnosis — exposed for debugging / future audit. */
  resolution: RoutingResolution;
};

/**
 * Inline audit writer — intentionally NOT importing `writeAudit` from
 * helpers.ts to avoid a circular import (helpers.ts → dispatch.ts).
 *
 * Audit policy (designed to be informative without flooding audit_logs):
 *   - GROUP_TABLE success      → NO audit (happy path; pino DEBUG only)
 *   - ENV_FALLBACK success     → LOW   "BROADCAST_FALLBACK"   (signals
 *                                       env vars still in use; lets ops
 *                                       monitor when migration is complete)
 *   - noTargets                → MEDIUM "BROADCAST_NO_TARGET"  (something
 *                                       was dropped — must alert)
 *   - send fail (all)          → MEDIUM "BROADCAST_SEND_FAIL"  (Telegram
 *                                       rejected — bot kicked / wrong id)
 *
 * System events (`actorId == null`, e.g. DAILY_DIGEST):
 *   - Happy path / FALLBACK    → skip (pino covers; would flood audit_logs)
 *   - NO_TARGET / SEND_FAIL    → WRITE with userId=NULL (compliance: ops
 *                                       must see scheduled-broadcast failures)
 * `audit_logs.userId` is nullable; settings.ts renders NULL as "🤖 系统".
 */
async function auditDispatch(
  event: BroadcastEvent,
  ctx: BroadcastContext,
  resolution: RoutingResolution,
  delivered: number,
  attempted: number,
): Promise<void> {
  const reasons = resolution.targets.map((t) => `${t.reason}@${t.source}`).join(",");
  const ctxStr = `proj=${ctx.projectId ?? "-"};grp=${ctx.groupId ?? "-"};actor=${ctx.actorId ?? "system"}`;

  let action: string | null = null;
  let level: "LOW" | "MEDIUM" | "HIGH" = "LOW";
  let details: string | null = null;

  if (resolution.noTargets) {
    action = "BROADCAST_NO_TARGET";
    level = "MEDIUM";
    details = `event=${event};${ctxStr};targets=NONE`;
  } else if (delivered === 0) {
    action = "BROADCAST_SEND_FAIL";
    level = "MEDIUM";
    details = `event=${event};${ctxStr};attempted=${attempted};delivered=0;targets=${reasons}`;
  } else if (resolution.fallbackUsed) {
    if (ctx.actorId == null) return; // system + happy-ish FALLBACK → pino only (no flood)
    action = "BROADCAST_FALLBACK";
    level = "LOW";
    details = `event=${event};${ctxStr};delivered=${delivered}/${attempted};targets=${reasons}`;
  }
  if (action == null) return; // GROUP_TABLE clean success — skip.

  try {
    await db.insert(auditLogsTable).values({
      userId: ctx.actorId ?? null,
      action,
      targetType: "broadcast",
      targetId: null,
      details,
      auditLevel: level,
    });
  } catch (err) {
    logger.warn({ err, event }, "Failed to write broadcast audit");
  }
}

/**
 * Resolve targets via routing core, then fan out via Telegram API.
 * Failures are logged with context but don't throw — broadcasts are
 * fire-and-forget side effects, never on the critical user path.
 *
 * Auto-writes audit_logs for non-happy-path outcomes (see auditDispatch).
 */
export async function dispatchBroadcast(
  tg: Telegram,
  event: BroadcastEvent,
  ctx: BroadcastContext,
  text: string,
): Promise<DispatchResult> {
  const groups = await listEnabledGroups();
  const resolution = getBroadcastTargets(event, ctx, groups, ENV);
  if (resolution.noTargets) {
    logger.warn({ event, ctx }, "Broadcast skipped: no targets resolved (groups empty + no env fallback)");
    await auditDispatch(event, ctx, resolution, 0, 0);
    return { ok: false, attempted: 0, delivered: 0, resolution };
  }

  let delivered = 0;
  for (const target of resolution.targets) {
    try {
      await tg.sendMessage(target.chatId, text, { parse_mode: "HTML" });
      delivered += 1;
    } catch (err) {
      logger.warn(
        { err, event, target: { chatId: target.chatId, channel: target.channel, reason: target.reason, source: target.source } },
        "Broadcast send failed",
      );
    }
  }

  if (resolution.fallbackUsed) {
    logger.debug({ event, targets: resolution.targets.map((t) => `${t.reason}@${t.source}`) }, "Broadcast used ENV_FALLBACK");
  }

  const result = {
    ok: delivered > 0,
    attempted: resolution.targets.length,
    delivered,
    resolution,
  };
  await auditDispatch(event, ctx, resolution, delivered, result.attempted);
  return result;
}
