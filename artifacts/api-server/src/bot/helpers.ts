import type { Context } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import { logger } from "../lib/logger.js";

import { db, auditLogsTable } from "@workspace/db";

/**
 * Legacy env constants — kept ONLY for UI display in the BI menu
 * ("已配置 / 未配置" indicator). All actual routing is done by
 * `dispatchBroadcast()` which consults the `groups` table first and falls
 * back to these env vars automatically.
 *
 * After B3 P1: the legacy `notifyGroup` / `notifyChannel` shims are GONE.
 * All call-sites use `dispatchBroadcast(event, ctx, text)` directly with
 * proper event semantics + projectId/groupId for per-project routing.
 */
export const GROUP_ID = process.env["TELEGRAM_GROUP_ID"];
export const CHANNEL_ID = process.env["TELEGRAM_CHANNEL_ID"];

export async function writeAudit(
  userId: number,
  action: string,
  targetType: string | null,
  targetId: number | null,
  details: string | null,
  level: "LOW" | "MEDIUM" | "HIGH" = "LOW",
): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      userId,
      action,
      targetType,
      targetId,
      details,
      auditLevel: level,
    });
  } catch (err) {
    logger.warn({ err }, "Failed to write audit log");
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export function buildKeyboard(
  buttons: { text: string; callback_data: string }[],
  columns = 2,
  footer: { text: string; callback_data: string }[] = [],
): InlineKeyboardButton[][] {
  const rows = chunk(buttons, columns);
  for (const btn of footer) {
    rows.push([btn]);
  }
  return rows;
}

export async function editOrSend(
  ctx: Context,
  text: string,
  keyboard: InlineKeyboardButton[][],
): Promise<void> {
  try {
    if (ctx.callbackQuery && "message" in ctx.callbackQuery) {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
    }
  } catch {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
  }
}

export function shortTitle(s: string, max = 14): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function priorityLabel(p: string): string {
  if (p === "HIGH") return "🔥 高";
  if (p === "MEDIUM") return "⚡ 中";
  if (p === "LOW") return "🌿 低";
  return p;
}

export function statusLabel(s: string): string {
  const map: Record<string, string> = {
    TODO: "📋 待办",
    DOING: "▶️ 进行中",
    PAUSED: "⏸ 已暂停",
    VERIFY: "🔍 待验收",
    DONE: "✅ 已完成",
    ARCHIVED: "🗄 已归档",
    PENDING: "⏳ 待评审",
    APPROVED: "🚀 已立项",
    REJECTED: "❌ 已驳回",
    PENDING_APPROVAL: "⏳ 待审核",
    PASSED: "✅ 审核通过",
    FAILED: "❌ 已驳回",
    ACTIVE: "🟢 进行中",
    RISK: "⚠️ 风险中",
    COMPLETED: "✅ 已完成",
    OPEN: "🔴 开放中",
  };
  return map[s] ?? s;
}

export const NO_PERMISSION_MSG = "⛔ 你没有权限执行该操作。";
export const EMPTY_LIST_MSG = "📭 当前暂无数据。";
