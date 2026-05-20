import type { Context } from "telegraf";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db, groupsTable, projectsTable, notDeleted } from "@workspace/db";
import { editOrSend, buildKeyboard, EMPTY_LIST_MSG, writeAudit } from "../helpers.js";
import { escapeHtml } from "../notify.js";
import { getUserByTelegramId } from "../user-service.js";

const PAGE_SIZE = 8;

function chatTypeLabel(t: string): string {
  if (t === "group") return "👥 群";
  if (t === "supergroup") return "🏢 超级群";
  if (t === "channel") return "📢 频道";
  return t;
}

/** Picker for "settings → groups → 项目绑定" — list of all projects. */
export async function showProjectBindList(ctx: Context, offset = 0): Promise<void> {
  const projs = await db
    .select()
    .from(projectsTable)
    .where(notDeleted(projectsTable))
    .orderBy(desc(projectsTable.id))
    .limit(PAGE_SIZE)
    .offset(offset);

  const [totalRow] = await db
    .select({ c: count() })
    .from(projectsTable)
    .where(notDeleted(projectsTable));
  const total = totalRow?.c ?? 0;

  if (projs.length === 0) {
    await editOrSend(ctx, `📁 <b>项目绑定</b>\n\n${EMPTY_LIST_MSG}`, [[{ text: "🔙 返回", callback_data: "M:GROUPS" }]]);
    return;
  }

  const lines: string[] = [];
  lines.push(`📁 <b>项目绑定</b>（${offset + 1}-${offset + projs.length} / ${total}）`);
  lines.push("");
  lines.push("选择项目进入绑定面板：");
  lines.push("");

  const buttons: { text: string; callback_data: string }[] = [];
  for (const p of projs) {
    const mark = p.groupId ? "📡" : "—";
    const shortName = p.name.length > 20 ? p.name.slice(0, 20) + "…" : p.name;
    buttons.push({
      text: `${mark} #${p.id} ${shortName}`,
      callback_data: `PROJ:CHGROUP:${p.id}:0`,
    });
  }

  const nav: { text: string; callback_data: string }[] = [];
  if (offset > 0) nav.push({ text: "⬅️ 上一页", callback_data: `GROUPS:PROJ:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) nav.push({ text: "下一页 ➡️", callback_data: `GROUPS:PROJ:${offset + PAGE_SIZE}` });

  const kb = buildKeyboard(buttons, 1, [{ text: "🔙 返回", callback_data: "M:GROUPS" }]);
  if (nav.length > 0) kb.unshift(nav);

  await editOrSend(ctx, lines.join("\n"), kb);
}

/** Picker shown both from project card and from settings flow. */
export async function showProjectGroupPicker(
  ctx: Context,
  projectId: number,
  offset = 0,
): Promise<void> {
  const proj = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)))
    .limit(1);
  const p = proj[0];
  if (!p) {
    await ctx.answerCbQuery("❌ 项目不存在", { show_alert: true });
    return;
  }

  const groups = await db
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

  const lines: string[] = [];
  lines.push(`📁 <b>${escapeHtml(p.name)}</b>`);
  lines.push("");
  lines.push(`当前绑定：${p.groupId ? `#${p.groupId}` : "（未绑定，将走「首个启用群」或 env fallback）"}`);
  lines.push("");
  if (total === 0) {
    lines.push(EMPTY_LIST_MSG);
    lines.push("");
    lines.push("<i>请先在目标群里发送 /register 注册群组。</i>");
    await editOrSend(ctx, lines.join("\n"), [[{ text: "🔙 返回项目卡片", callback_data: `PROJ:OPEN:${projectId}` }]]);
    return;
  }
  lines.push(`选择要绑定的群（${offset + 1}-${offset + groups.length} / ${total}）：`);
  lines.push("");

  const buttons: { text: string; callback_data: string }[] = [];
  for (const g of groups) {
    const enabled = g.isEnabled === 1 ? "✅" : "⛔";
    const selected = p.groupId === g.id ? "📌 " : "";
    const shortTitle = g.title.length > 18 ? g.title.slice(0, 18) + "…" : g.title;
    buttons.push({
      text: `${selected}${enabled} #${g.id} ${shortTitle}`,
      callback_data: `PROJ:SETGROUP:${projectId}:${g.id}`,
    });
    lines.push(`${enabled} #${g.id} <b>${escapeHtml(g.title)}</b>`);
    lines.push(` • ${chatTypeLabel(g.chatType)} · <code>${g.tgChatId.toString()}</code>`);
  }

  const nav: { text: string; callback_data: string }[] = [];
  if (offset > 0) nav.push({ text: "⬅️ 上一页", callback_data: `PROJ:CHGROUP:${projectId}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) nav.push({ text: "下一页 ➡️", callback_data: `PROJ:CHGROUP:${projectId}:${offset + PAGE_SIZE}` });

  const footer: { text: string; callback_data: string }[] = [];
  if (p.groupId) footer.push({ text: "🔓 解除绑定", callback_data: `PROJ:UNBINDGROUP:${projectId}` });
  footer.push({ text: "🔙 返回项目卡片", callback_data: `PROJ:OPEN:${projectId}` });

  const kb = buildKeyboard(buttons, 1, footer);
  if (nav.length > 0) kb.unshift(nav);

  await editOrSend(ctx, lines.join("\n"), kb);
}

export async function handleProjectGroupBind(
  ctx: Context,
  projectId: number,
  groupId: number,
  telegramId: string,
): Promise<void> {
  const actor = await getUserByTelegramId(telegramId);
  if (!actor) {
    await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
    return;
  }

  const proj = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)))
    .limit(1);
  if (proj.length === 0) {
    await ctx.answerCbQuery("❌ 项目不存在或已删除", { show_alert: true });
    return;
  }

  // Validation: target group must exist, not soft-deleted, AND enabled.
  // Binding to a disabled group would silently break this project's broadcasts.
  const g = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId)).limit(1);
  if (!g[0] || g[0].deletedAt != null) {
    await ctx.answerCbQuery("❌ 群不存在", { show_alert: true });
    return;
  }
  if (g[0].isEnabled !== 1) {
    await ctx.answerCbQuery("⛔ 该群已禁用，请先到「群组列表」启用", { show_alert: true });
    return;
  }

  await db
    .update(projectsTable)
    .set({ groupId })
    .where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));

  await writeAudit(
    actor.id,
    "PROJECT_SET_GROUP",
    "project",
    projectId,
    `projectId=${projectId} groupId=${groupId} chatId=${g[0].tgChatId.toString()}`,
    "MEDIUM",
  );

  await ctx.answerCbQuery("✅ 已绑定");
  await showProjectGroupPicker(ctx, projectId, 0);
}

export async function handleProjectGroupUnbind(
  ctx: Context,
  projectId: number,
  telegramId: string,
): Promise<void> {
  const actor = await getUserByTelegramId(telegramId);
  if (!actor) {
    await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
    return;
  }

  const proj = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)))
    .limit(1);
  if (proj.length === 0) {
    await ctx.answerCbQuery("❌ 项目不存在或已删除", { show_alert: true });
    return;
  }

  await db
    .update(projectsTable)
    .set({ groupId: null })
    .where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));

  await writeAudit(
    actor.id,
    "PROJECT_UNBIND_GROUP",
    "project",
    projectId,
    `projectId=${projectId} prevGroupId=${proj[0].groupId ?? "null"}`,
    "MEDIUM",
  );

  await ctx.answerCbQuery("🔓 已解绑");
  await showProjectGroupPicker(ctx, projectId, 0);
}
