import type { Context } from "telegraf";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { db, groupsTable, projectsTable, notDeleted } from "@workspace/db";
import { editOrSend, buildKeyboard, EMPTY_LIST_MSG, writeAudit } from "../helpers.js";
import { invalidateGroupsCache } from "../group-service.js";
import { escapeHtml } from "../notify.js";
import { getUserByTelegramId } from "../user-service.js";
import { logger } from "../../lib/logger.js";

const PAGE_SIZE = 8;

function chatTypeLabel(t: string): string {
  if (t === "group") return "👥 群";
  if (t === "supergroup") return "🏢 超级群";
  if (t === "channel") return "📢 频道";
  return t;
}

export async function showGroupsMenu(ctx: Context): Promise<void> {
  await editOrSend(
    ctx,
    [
      "📡 <b>群组绑定</b>",
      "",
      "广播路由中心。把群/频道纳入系统后，",
      "任务、项目、需求、财务事件会按项目绑定自动分流。",
      "",
      "<i>💡 注册新群：在目标群里发送 /register</i>",
    ].join("\n"),
    buildKeyboard(
      [
        { text: "📋 群组列表", callback_data: "GROUPS:LIST:0" },
        { text: "📁 项目绑定", callback_data: "GROUPS:PROJ:0" },
      ],
      2,
      [
        { text: "🔙 返回系统设置", callback_data: "M:SET" },
        { text: "🏠 返回主页", callback_data: "M:HOME" },
      ],
    ),
  );
}

export async function showGroupsList(ctx: Context, offset = 0): Promise<void> {
  const rows = await db
    .select()
    .from(groupsTable)
    .where(isNull(groupsTable.deletedAt))
    .orderBy(desc(groupsTable.id))
    .limit(PAGE_SIZE)
    .offset(offset);

  const [totalRow] = await db
    .select({ c: count() })
    .from(groupsTable)
    .where(isNull(groupsTable.deletedAt));
  const total = totalRow?.c ?? 0;

  if (rows.length === 0) {
    await editOrSend(
      ctx,
      `📡 <b>群组列表</b>\n\n${EMPTY_LIST_MSG}\n\n<i>在目标群里发送 /register 即可纳入。</i>`,
      [[{ text: "🔙 返回", callback_data: "M:GROUPS" }]],
    );
    return;
  }

  const lines: string[] = [];
  lines.push(`📡 <b>群组列表</b>（${offset + 1}-${offset + rows.length} / ${total}）`);
  lines.push("");

  const buttons: { text: string; callback_data: string }[] = [];

  for (const g of rows) {
    const enabled = g.isEnabled === 1 ? "✅" : "⛔";
    const chMarks = [
      g.defaultReportChannelId ? "📊" : "",
      g.financeReportChannelId ? "💰" : "",
    ].filter(Boolean).join("");
    lines.push(`${enabled} <b>#${g.id} ${escapeHtml(g.title)}</b> ${chMarks}`);
    lines.push(` • ${chatTypeLabel(g.chatType)} · <code>${g.tgChatId.toString()}</code>`);
    lines.push("");

    buttons.push({
      text: `👁 详情 #${g.id}`,
      callback_data: `GROUPS:VIEW:${g.id}`,
    });
  }

  const nav: { text: string; callback_data: string }[] = [];
  if (offset > 0) nav.push({ text: "⬅️ 上一页", callback_data: `GROUPS:LIST:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) nav.push({ text: "下一页 ➡️", callback_data: `GROUPS:LIST:${offset + PAGE_SIZE}` });

  const kb = buildKeyboard(buttons, 2, [{ text: "🔙 返回", callback_data: "M:GROUPS" }]);
  if (nav.length > 0) kb.unshift(nav);

  await editOrSend(ctx, lines.join("\n").trimEnd(), kb);
}

/**
 * `/register` command handler — must run inside the target group, NOT in DM.
 *
 * Strategy:
 *   - DM in private chat is rejected with guidance.
 *   - In group/supergroup/channel: upsert (onConflictDoUpdate) on tgChatId.
 *     If an existing row was disabled or soft-deleted, this re-enables it
 *     and clears deletedAt — the only safe way to re-register past the
 *     `tgChatId UNIQUE` constraint without a schema change.
 *   - Caller must already have verified actor is OWNER/ADMIN.
 */
export async function handleRegisterCommand(ctx: Context, telegramId: string): Promise<void> {
  const chat = ctx.chat;
  if (!chat || !("id" in chat)) {
    await ctx.reply("❌ 无法识别当前会话");
    return;
  }
  if (chat.type === "private") {
    await ctx.reply(
      "⚠️ 请在<b>目标群组</b>里发送 /register（不要在私聊里发）。\n\n" +
        "用法：\n" +
        "1. 把机器人拉进目标群\n" +
        "2. 在群里发送 <code>/register</code>\n" +
        "3. 回到 ⚙️ 系统设置 → 📡 群组绑定 → 📋 群组列表 即可看到该群",
      { parse_mode: "HTML" },
    );
    return;
  }

  const actor = await getUserByTelegramId(telegramId);
  if (!actor) {
    await ctx.reply("❌ 用户未注册，请先私聊机器人发送 /start");
    return;
  }
  if (actor.role !== "OWNER" && actor.role !== "ADMIN") {
    await ctx.reply("⛔ 仅 OWNER / ADMIN 可注册群组");
    return;
  }

  const chatId = BigInt(chat.id);
  const title = "title" in chat && chat.title ? chat.title : `(${chat.type})`;
  const chatType = chat.type;

  try {
    // Look up first so we can distinguish "new" vs "re-enabled" for the audit
    // trail and the user-facing message.
    const existing = await db
      .select()
      .from(groupsTable)
      .where(eq(groupsTable.tgChatId, chatId))
      .limit(1);
    const wasPresent = existing.length > 0;
    const wasEnabled = wasPresent && existing[0].isEnabled === 1 && existing[0].deletedAt == null;

    await db
      .insert(groupsTable)
      .values({
        tgChatId: chatId,
        title,
        chatType,
        isEnabled: 1,
      })
      .onConflictDoUpdate({
        target: groupsTable.tgChatId,
        set: {
          title,
          chatType,
          isEnabled: 1,
          deletedAt: null,
          updatedAt: new Date(),
        },
      });
    invalidateGroupsCache();

    await writeAudit(
      actor.id,
      "GROUP_REGISTER",
      "group",
      null,
      `chatId=${chatId.toString()} title=${title} type=${chatType} re_enabled=${wasPresent && !wasEnabled}`,
      "MEDIUM",
    );

    if (wasEnabled) {
      await ctx.reply(`ℹ️ 此群已注册（已是启用状态）：<code>${chatId.toString()}</code>`, { parse_mode: "HTML" });
    } else if (wasPresent) {
      await ctx.reply(`✅ 已重新启用此群：<code>${chatId.toString()}</code>`, { parse_mode: "HTML" });
    } else {
      await ctx.reply(`✅ 已注册：<b>${escapeHtml(title)}</b>\n<code>${chatId.toString()}</code>`, { parse_mode: "HTML" });
    }
  } catch (err) {
    logger.error({ err, chatId: chatId.toString() }, "Failed to register group");
    await ctx.reply("❌ 注册失败，请查看日志或重试");
  }
}

/** Group detail page — show all 3 channels with set / clear buttons. */
export async function showGroupView(ctx: Context, groupId: number): Promise<void> {
  const rows = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId)).limit(1);
  const g = rows[0];
  if (!g || g.deletedAt != null) {
    await editOrSend(ctx, "❌ 群不存在或已删除", [[{ text: "🔙 返回", callback_data: "GROUPS:LIST:0" }]]);
    return;
  }

  const enabled = g.isEnabled === 1 ? "✅ 已启用" : "⛔ 已禁用";
  const lines: string[] = [];
  lines.push(`📡 <b>群组 #${g.id}</b> · ${enabled}`);
  lines.push("");
  lines.push(`📌 <b>名称：</b>${escapeHtml(g.title)}`);
  lines.push(`📋 <b>类型：</b>${chatTypeLabel(g.chatType)}`);
  lines.push(`🆔 <b>chat_id：</b><code>${g.tgChatId.toString()}</code>`);
  lines.push("");
  lines.push("<b>📺 报告频道绑定</b>");
  lines.push(
    g.defaultReportChannelId
      ? `📊 默认报告频道：<code>${g.defaultReportChannelId.toString()}</code>`
      : `📊 默认报告频道：<i>（未绑定，走 env CHANNEL_ID 兜底）</i>`,
  );
  lines.push(
    g.financeReportChannelId
      ? `💰 财务频道：<code>${g.financeReportChannelId.toString()}</code>`
      : `💰 财务频道：<i>（未绑定，财务事件可能 noTargets）</i>`,
  );
  lines.push("");
  lines.push("<i>💡 提示：在目标频道里发送 /chatid 可获取频道 chat_id（需先把机器人加入并设为管理员）</i>");

  const actions: { text: string; callback_data: string }[] = [];
  // Toggle
  actions.push({
    text: g.isEnabled === 1 ? "🔕 禁用" : "🔔 启用",
    callback_data: `GROUPS:TOGGLE:${g.id}`,
  });
  // Default report channel
  if (g.defaultReportChannelId) {
    actions.push({ text: "🧹 清除默认频道", callback_data: `GROUPS:CLRDEF:${g.id}` });
  } else {
    actions.push({ text: "📊 设置默认频道", callback_data: `GROUPS:SETDEFCH:${g.id}` });
  }
  // Finance channel
  if (g.financeReportChannelId) {
    actions.push({ text: "🧹 清除财务频道", callback_data: `GROUPS:CLRFIN:${g.id}` });
  } else {
    actions.push({ text: "💰 设置财务频道", callback_data: `GROUPS:SETFINCH:${g.id}` });
  }

  const kb = buildKeyboard(actions, 2, [
    { text: "🔙 返回列表", callback_data: "GROUPS:LIST:0" },
    { text: "🏠 主页", callback_data: "M:HOME" },
  ]);
  await editOrSend(ctx, lines.join("\n"), kb);
}

/** Clear one of the two report-channel bindings on a group. */
export async function handleGroupClearChannel(
  ctx: Context,
  groupId: number,
  kind: "DEF" | "FIN",
  telegramId: string,
): Promise<void> {
  const actor = await getUserByTelegramId(telegramId);
  if (!actor) {
    await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
    return;
  }
  const rows = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId)).limit(1);
  const g = rows[0];
  if (!g || g.deletedAt != null) {
    await ctx.answerCbQuery("❌ 群不存在", { show_alert: true });
    return;
  }
  const isFin = kind === "FIN";
  const prev = isFin ? g.financeReportChannelId : g.defaultReportChannelId;
  if (prev == null) {
    await ctx.answerCbQuery("ℹ️ 该频道本就未绑定");
    await showGroupView(ctx, groupId);
    return;
  }
  await db.update(groupsTable)
    .set(isFin
      ? { financeReportChannelId: null, updatedAt: new Date() }
      : { defaultReportChannelId: null, updatedAt: new Date() })
    .where(eq(groupsTable.id, groupId));
  invalidateGroupsCache();
  await writeAudit(
    actor.id,
    isFin ? "GROUP_CLEAR_FINANCE_CHANNEL" : "GROUP_CLEAR_DEFAULT_CHANNEL",
    "group",
    groupId,
    `prevChatId=${prev.toString()} title=${g.title}`,
    "MEDIUM",
  );
  await ctx.answerCbQuery("🧹 已清除");
  await showGroupView(ctx, groupId);
}

export async function handleGroupToggle(ctx: Context, groupId: number, telegramId: string): Promise<void> {
  const actor = await getUserByTelegramId(telegramId);
  if (!actor) {
    await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
    return;
  }

  const rows = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId)).limit(1);
  const g = rows[0];
  if (!g || g.deletedAt != null) {
    await ctx.answerCbQuery("❌ 群不存在", { show_alert: true });
    return;
  }

  const next = g.isEnabled === 1 ? 0 : 1;

  if (next === 0) {
    // Atomic disable: conditional UPDATE that rejects if any project is still
    // bound. Closes a TOCTOU race where a concurrent PROJ:SETGROUP binds a
    // project between check and update, leaving a disabled group bound to
    // active projects (would silently break their broadcasts).
    const updated = await db
      .update(groupsTable)
      .set({ isEnabled: 0, updatedAt: new Date() })
      .where(and(
        eq(groupsTable.id, groupId),
        eq(groupsTable.isEnabled, 1),
        isNull(groupsTable.deletedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${projectsTable} WHERE ${projectsTable.groupId} = ${groupId} AND ${projectsTable.deletedAt} IS NULL)`,
      ))
      .returning({ id: groupsTable.id });

    if (updated.length === 0) {
      await ctx.answerCbQuery("⛔ 仍有项目绑定此群（或状态已变），请先解绑后重试", { show_alert: true });
      await showGroupsList(ctx, 0);
      return;
    }
  } else {
    await db.update(groupsTable).set({ isEnabled: 1, updatedAt: new Date() }).where(eq(groupsTable.id, groupId));
  }
  invalidateGroupsCache();

  await writeAudit(
    actor.id,
    next === 1 ? "GROUP_ENABLE" : "GROUP_DISABLE",
    "group",
    groupId,
    `chatId=${g.tgChatId.toString()} title=${g.title}`,
    "MEDIUM",
  );

  await ctx.answerCbQuery(next === 1 ? "✅ 已启用" : "🔕 已禁用");
  await showGroupView(ctx, groupId);
}
