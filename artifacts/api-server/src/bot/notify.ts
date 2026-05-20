import type { Telegram } from "telegraf";
import type { InlineKeyboardButton } from "telegraf/types";
import { db, usersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type Mentionable = {
  id: number;
  telegramId: string;
  username: string | null;
  firstName: string | null;
};

/** HTML-safe @mention. Falls back to tg:// deep-link mention when no @username. */
export function userMention(u: Mentionable): string {
  if (u.username) return `@${u.username}`;
  const name = escapeHtml(u.firstName ?? u.telegramId);
  return `<a href="tg://user?id=${u.telegramId}">${name}</a>`;
}

export async function notifyUser(
  tg: Telegram,
  telegramId: string,
  text: string,
  keyboard?: InlineKeyboardButton[][],
): Promise<boolean> {
  try {
    await tg.sendMessage(telegramId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      link_preview_options: { is_disabled: true },
    });
    return true;
  } catch (err: unknown) {
    const code = (err as { response?: { error_code?: number } } | null)?.response?.error_code;
    // 403 = blocked / never started chat; 400 = chat not found
    if (code === 403 || code === 400) {
      logger.debug({ telegramId, code }, "DM skipped (user blocked or no chat started)");
    } else {
      logger.warn({ err, telegramId }, "Failed to DM user");
    }
    return false;
  }
}

export async function notifyUserById(
  tg: Telegram,
  userId: number,
  text: string,
  keyboard?: InlineKeyboardButton[][],
): Promise<boolean> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (rows.length === 0) return false;
  if (rows[0].isBlacklisted === 1) return false;
  return notifyUser(tg, rows[0].telegramId, text, keyboard);
}

/** DM all users whose role is in `roles` (skips blacklisted + optional excludeUserId). Returns delivery count. */
export async function notifyByRoles(
  tg: Telegram,
  roles: string[],
  text: string,
  keyboard?: InlineKeyboardButton[][],
  excludeUserId?: number,
): Promise<number> {
  const users = await db.select().from(usersTable).where(inArray(usersTable.role, roles));
  let n = 0;
  for (const u of users) {
    if (u.isBlacklisted === 1) continue;
    if (excludeUserId && u.id === excludeUserId) continue;
    if (await notifyUser(tg, u.telegramId, text, keyboard)) n += 1;
  }
  return n;
}

export const REVIEWER_ROLES_REQ = ["OWNER", "ADMIN", "PM"];
export const REVIEWER_ROLES_FIN = ["OWNER", "ADMIN", "FINANCE"];
