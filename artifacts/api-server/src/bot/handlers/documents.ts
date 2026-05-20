import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { documentsTable, usersTable, projectsTable, notDeleted } from "@workspace/db";
import { eq, and, desc, inArray, count } from "drizzle-orm";
import { editOrSend, buildKeyboard, shortTitle, EMPTY_LIST_MSG, writeAudit } from "../helpers.js";
import type { Role } from "../permissions.js";
import { canExecuteAction } from "../permissions.js";
import { userDisplayName, getUserByTelegramId } from "../user-service.js";
import { startFlow } from "../form-handler.js";

const PAGE_SIZE = 8;

const CATEGORY_LABELS: Record<string, string> = {
  POLICY: "📌 制度流程",
  PROJECT: "📁 项目资料",
  MINUTES: "📝 会议纪要",
  KNOWLEDGE: "📚 知识沉淀",
  FINANCE: "💰 财务凭证",
  OTHER: "📎 其他",
};

const FILTER_LABELS: Record<string, string> = {
  ALL: "📋 全部",
  PINNED: "📌 置顶",
  MINE: "👤 我的",
  ARCH: "🗄 已归档",
};

function pageHeader(total: number, offset: number): string {
  if (total === 0) return EMPTY_LIST_MSG;
  return `共 ${total} 篇 · 第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`;
}

function docButtonText(d: { id: number; title: string; isPinned: number; isArchived: number }): string {
  const prefix = d.isArchived === 1 ? "🗄" : (d.isPinned === 1 ? "📌" : "📄");
  return `${prefix} #${d.id} ${shortTitle(d.title, 28)}`;
}

export async function showDocCategories(ctx: Context): Promise<void> {
  const categories = Object.entries(CATEGORY_LABELS).map(([val, label]) => ({
    text: label,
    callback_data: `DOC:CATE:OPEN:${val}`,
  }));
  await editOrSend(ctx, "📂 <b>文档分类目录</b>\n\n选择一个分类查看文档：", buildKeyboard(categories, 2, [{ text: "🔙 返回", callback_data: "M:DOC" }]));
}

export async function showDocsByCategory(ctx: Context, category: string, offset = 0): Promise<void> {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const whereClause = and(eq(documentsTable.category, category), eq(documentsTable.isArchived, 0), notDeleted(documentsTable));
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(documentsTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(documentsTable)
    .where(whereClause)
    .orderBy(desc(documentsTable.isPinned), desc(documentsTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const label = CATEGORY_LABELS[category] ?? category;

  const items = slice.map((d) => ({ text: docButtonText(d), callback_data: `DOC:OPEN:${d.id}` }));
  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️ 上一页", callback_data: `DOC:CATE:OPEN:${category}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "下一页 ➡️", callback_data: `DOC:CATE:OPEN:${category}:${offset + PAGE_SIZE}` });

  const kb: { text: string; callback_data: string }[][] = [];
  for (const b of items) kb.push([b]);
  if (navRow.length > 0) kb.push(navRow);
  kb.push([{ text: "🔙 返回分类", callback_data: "DOC:CATE" }]);

  await editOrSend(ctx, `${label}\n\n${pageHeader(total, offset)}`, kb);
}

export async function showMeetingMinutes(ctx: Context): Promise<void> {
  await showDocsByCategory(ctx, "MINUTES", 0);
}

export async function showDocList(ctx: Context, role: Role, filter = "ALL", offset = 0): Promise<void> {
  if (!["ALL", "PINNED", "MINE", "ARCH"].includes(filter)) filter = "ALL";
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const conds = [notDeleted(documentsTable)];
  if (filter === "ARCH") {
    conds.push(eq(documentsTable.isArchived, 1));
  } else {
    conds.push(eq(documentsTable.isArchived, 0));
    if (filter === "PINNED") conds.push(eq(documentsTable.isPinned, 1));
    if (filter === "MINE") {
      const telegramId = String(ctx.from?.id ?? "");
      const actor = await getUserByTelegramId(telegramId);
      if (!actor) {
        await editOrSend(ctx, "❌ 用户身份未识别", [[{ text: "🔙 返回", callback_data: "M:DOC" }]]);
        return;
      }
      conds.push(eq(documentsTable.creatorId, actor.id));
    }
  }

  const whereClause = and(...conds);
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(documentsTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(documentsTable)
    .where(whereClause)
    .orderBy(desc(documentsTable.isPinned), desc(documentsTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const tabs = (["ALL", "PINNED", "MINE"] as const).map((f) => ({
    text: filter === f ? `« ${FILTER_LABELS[f]} »` : FILTER_LABELS[f],
    callback_data: `DOC:LIST:${f}:0`,
  }));
  const archTab = canExecuteAction(role, "DOC:UNARCH") || filter === "ARCH"
    ? [{ text: filter === "ARCH" ? `« ${FILTER_LABELS.ARCH} »` : FILTER_LABELS.ARCH, callback_data: "DOC:LIST:ARCH:0" }]
    : [];

  const items = slice.map((d) => ({ text: docButtonText(d), callback_data: `DOC:OPEN:${d.id}` }));
  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️ 上一页", callback_data: `DOC:LIST:${filter}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "下一页 ➡️", callback_data: `DOC:LIST:${filter}:${offset + PAGE_SIZE}` });

  const kb: { text: string; callback_data: string }[][] = [tabs, archTab].filter((r) => r.length > 0);
  for (const b of items) kb.push([b]);
  if (navRow.length > 0) kb.push(navRow);
  kb.push([{ text: "🔙 返回", callback_data: "M:DOC" }]);

  await editOrSend(ctx, `📚 <b>文档库</b> · ${FILTER_LABELS[filter]}\n\n${pageHeader(total, offset)}`, kb);
}

export async function showArchivedDocs(ctx: Context, role: Role): Promise<void> {
  await showDocList(ctx, role, "ARCH", 0);
}

export async function showDocsByProjectPicker(ctx: Context, role: Role, offset = 0): Promise<void> {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  // Get projects that actually have docs (left-join in memory)
  const allDocs = await db.select().from(documentsTable).where(and(eq(documentsTable.isArchived, 0), notDeleted(documentsTable)));
  const counts = new Map<number | "NONE", number>();
  for (const d of allDocs) {
    const k = d.projectId ?? "NONE";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const projIds = [...counts.keys()].filter((k): k is number => typeof k === "number");
  const projects = projIds.length > 0
    ? await db.select().from(projectsTable).where(and(inArray(projectsTable.id, projIds), notDeleted(projectsTable)))
    : [];
  const projMap = new Map(projects.map((p) => [p.id, p.name]));

  const entries = [...counts.entries()]
    .map(([k, n]) => ({ key: k, name: k === "NONE" ? "（未关联）" : (projMap.get(k) ?? `项目#${k}`), n }))
    .sort((a, b) => b.n - a.n);

  const total = entries.length;
  const slice = entries.slice(offset, offset + PAGE_SIZE);

  const items = slice.map((e) => ({
    text: `📁 ${shortTitle(e.name, 22)} (${e.n})`,
    callback_data: e.key === "NONE" ? "DOC:LIST:ALL:0" : `DOC:BYPROJ:${e.key}:0`,
  }));
  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️", callback_data: `DOC:LINKPROJ:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "➡️", callback_data: `DOC:LINKPROJ:${offset + PAGE_SIZE}` });

  const kb: { text: string; callback_data: string }[][] = [];
  for (const b of items) kb.push([b]);
  if (navRow.length > 0) kb.push(navRow);
  kb.push([{ text: "🔙 返回", callback_data: "M:DOC" }]);

  if (total === 0) {
    await editOrSend(ctx, `📁 <b>按项目浏览</b>\n\n${EMPTY_LIST_MSG}`, [[{ text: "🔙 返回", callback_data: "M:DOC" }]]);
    return;
  }
  await editOrSend(ctx, `📁 <b>按项目浏览</b>\n\n${pageHeader(total, offset)}`, kb);
}

export async function showDocsByProject(ctx: Context, projId: number, offset = 0): Promise<void> {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const whereClause = and(eq(documentsTable.projectId, projId), eq(documentsTable.isArchived, 0), notDeleted(documentsTable));
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(documentsTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(documentsTable)
    .where(whereClause)
    .orderBy(desc(documentsTable.isPinned), desc(documentsTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);
  const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projId), notDeleted(projectsTable)));
  const projName = projRows.length > 0 ? projRows[0].name : `项目#${projId}`;
  const items = slice.map((d) => ({ text: docButtonText(d), callback_data: `DOC:OPEN:${d.id}` }));
  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️", callback_data: `DOC:BYPROJ:${projId}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "➡️", callback_data: `DOC:BYPROJ:${projId}:${offset + PAGE_SIZE}` });

  const kb: { text: string; callback_data: string }[][] = [];
  for (const b of items) kb.push([b]);
  if (navRow.length > 0) kb.push(navRow);
  kb.push([{ text: "🔙 项目列表", callback_data: "DOC:LINKPROJ:0" }]);

  await editOrSend(ctx, `📁 <b>${projName}</b> 的文档\n\n${pageHeader(total, offset)}`, kb);
}

export async function showDocCard(ctx: Context, docId: number, role: Role): Promise<void> {
  const rows = await db.select().from(documentsTable).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
  if (rows.length === 0) {
    await editOrSend(ctx, "❌ 文档不存在或已删除", [[{ text: "🔙 返回文档库", callback_data: "M:DOC" }]]);
    return;
  }
  const doc = rows[0];

  let creatorName = "—";
  const cRows = await db.select().from(usersTable).where(eq(usersTable.id, doc.creatorId));
  if (cRows.length > 0) creatorName = userDisplayName(cRows[0]);

  let projectName = "—";
  if (doc.projectId) {
    const pRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, doc.projectId), notDeleted(projectsTable)));
    if (pRows.length > 0) projectName = pRows[0].name;
  }

  const archivedTag = doc.isArchived === 1 ? " 🗄 已归档" : "";
  const pinTag = doc.isPinned === 1 ? " 📌" : "";
  const text = `📚 <b>文档 #${doc.id}</b>${pinTag}${archivedTag}

📝 <b>标题：</b>${doc.title}
📂 <b>分类：</b>${CATEGORY_LABELS[doc.category] ?? doc.category}
🏷 <b>标签：</b>${doc.tags ?? "—"}
📁 <b>关联项目：</b>${projectName}
👤 <b>上传人：</b>${creatorName}
🔗 <b>链接/内容：</b>${doc.url ?? "—"}`;

  const buttons: { text: string; callback_data: string }[] = [];
  if (doc.isArchived === 0) {
    if (canExecuteAction(role, "DOC:PIN")) {
      buttons.push({ text: doc.isPinned === 1 ? "📌 取消置顶" : "📌 置顶", callback_data: `DOC:PIN:${docId}` });
    }
    if (canExecuteAction(role, "DOC:CHCAT")) {
      buttons.push({ text: "📂 改分类", callback_data: `DOC:CHCAT:${docId}` });
    }
    if (canExecuteAction(role, "DOC:CHPROJ")) {
      buttons.push({ text: "📁 改项目", callback_data: `DOC:CHPROJ:${docId}:0` });
    }
    if (canExecuteAction(role, "DOC:EDITTAGS")) {
      buttons.push({ text: "🏷 改标签", callback_data: `DOC:EDITTAGS:${docId}` });
    }
    if (canExecuteAction(role, "DOC:ARCH")) {
      buttons.push({ text: "🗄 归档", callback_data: `DOC:ARCH:${docId}` });
    }
  } else if (canExecuteAction(role, "DOC:UNARCH")) {
    buttons.push({ text: "♻️ 取消归档", callback_data: `DOC:UNARCH:${docId}` });
  }
  // B2.2 阶段 B：🗑 删除 = 软删（移入回收站）；物理删除走 DOC:PURGE，目前仅 admin 通过回收站后续 B2.3 触发。
  if (canExecuteAction(role, "DOC:DEL")) {
    buttons.push({ text: "🗑 删除", callback_data: `DOC:DEL:${docId}` });
  }

  await editOrSend(ctx, text, buildKeyboard(buttons, 2, [{ text: "🔙 返回文档库", callback_data: "M:DOC" }]));
}

export async function showDocCategoryPicker(ctx: Context, docId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "DOC:CHCAT")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const items = Object.entries(CATEGORY_LABELS).map(([val, label]) => ({
    text: label,
    callback_data: `DOC:SETCAT:${docId}:${val}`,
  }));
  await ctx.answerCbQuery();
  await editOrSend(ctx, `📂 <b>更改文档 #${docId} 分类</b>\n\n请选择新分类：`, buildKeyboard(items, 2, [{ text: "🔙 返回", callback_data: `DOC:OPEN:${docId}` }]));
}

export async function showDocProjectPicker(ctx: Context, docId: number, offset: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "DOC:CHPROJ")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))
    .orderBy(desc(projectsTable.updatedAt));
  const total = projects.length;
  const slice = projects.slice(offset, offset + PAGE_SIZE);

  const items = slice.map((p) => ({
    text: `📁 ${shortTitle(p.name, 22)}`,
    callback_data: `DOC:SETPROJ:${docId}:${p.id}`,
  }));
  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️", callback_data: `DOC:CHPROJ:${docId}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "➡️", callback_data: `DOC:CHPROJ:${docId}:${offset + PAGE_SIZE}` });

  const kb: { text: string; callback_data: string }[][] = [];
  for (const b of items) kb.push([b]);
  if (navRow.length > 0) kb.push(navRow);
  kb.push([{ text: "🚫 解除关联", callback_data: `DOC:UNLINK:${docId}` }]);
  kb.push([{ text: "🔙 返回", callback_data: `DOC:OPEN:${docId}` }]);

  await ctx.answerCbQuery();
  await editOrSend(ctx, `📁 <b>更改文档 #${docId} 关联项目</b>\n\n${pageHeader(total, offset)}\n请选择项目：`, kb);
}

export async function startDocAddFlow(ctx: Context, role: Role): Promise<void> {
  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))
    .orderBy(desc(projectsTable.updatedAt));
  const projectOptions = [
    { text: "（不关联）", value: "NONE" },
    ...projects.slice(0, 12).map((p) => ({ text: `📁 ${shortTitle(p.name, 20)}`, value: String(p.id) })),
  ];
  await ctx.answerCbQuery();
  await startFlow(ctx, "DOC:ADD", role, undefined, { project_id: projectOptions });
}

export async function startDocTagsFlow(ctx: Context, docId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "DOC:EDITTAGS")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(documentsTable).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 文档不存在", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await startFlow(ctx, "DOC:EDITTAGS", role, { docId });
}

// B2.2 阶段 A：原 startDocDeleteFlow 重命名为 startDocPurgeFlow（物理删除 = 彻底删）。
// 当前无 UI 入口暴露；待 B2.3 接入回收站清空按钮 (TRASH:PURGE:DOC:<id>) 时再唤起。
// PURGE 允许对已软删的文档执行（最终清理），故不带 notDeleted() 守卫。
export async function startDocPurgeFlow(ctx: Context, docId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "DOC:PURGE")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(documentsTable).where(eq(documentsTable.id, docId));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 文档不存在", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await startFlow(ctx, "DOC:PURGE", role, { docId });
}

export async function handleDocAction(ctx: Context, action: string, docId: number, role: Role, extra?: string): Promise<void> {
  if (!canExecuteAction(role, `DOC:${action}`)) {
    await ctx.answerCbQuery("⛔ 你没有权限执行该操作", { show_alert: true });
    return;
  }
  const rows = await db.select().from(documentsTable).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 文档不存在", { show_alert: true });
    return;
  }
  const doc = rows[0];
  const telegramId = String(ctx.from?.id ?? "");
  const actor = await getUserByTelegramId(telegramId);

  switch (action) {
    case "PIN": {
      const newPin = doc.isPinned === 1 ? 0 : 1;
      await db.update(documentsTable).set({ isPinned: newPin }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
      await ctx.answerCbQuery(newPin === 1 ? "📌 已置顶" : "✅ 已取消置顶");
      if (actor) await writeAudit(actor.id, newPin === 1 ? "DOCUMENT_PIN" : "DOCUMENT_UNPIN", "document", docId, doc.title);
      break;
    }
    case "ARCH":
      await db.update(documentsTable).set({ isArchived: 1 }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
      await ctx.answerCbQuery("🗄 文档已归档");
      if (actor) await writeAudit(actor.id, "DOCUMENT_ARCHIVE", "document", docId, doc.title);
      break;
    case "UNARCH":
      await db.update(documentsTable).set({ isArchived: 0 }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
      await ctx.answerCbQuery("♻️ 已取消归档");
      if (actor) await writeAudit(actor.id, "DOCUMENT_UNARCHIVE", "document", docId, doc.title);
      break;
    case "DEL":
      await db.update(documentsTable).set({ deletedAt: new Date() }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
      await ctx.answerCbQuery("🗑 已移入回收站");
      if (actor) await writeAudit(actor.id, "DOCUMENT_DELETE", "document", docId, doc.title, "MEDIUM");
      await showDocList(ctx, role, "ALL", 0);
      return;
    case "SETCAT": {
      const cat = extra ?? "OTHER";
      if (!CATEGORY_LABELS[cat]) {
        await ctx.answerCbQuery("⚠️ 非法分类", { show_alert: true });
        return;
      }
      await db.update(documentsTable).set({ category: cat }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
      await ctx.answerCbQuery(`📂 已改为 ${CATEGORY_LABELS[cat]}`);
      if (actor) await writeAudit(actor.id, "DOCUMENT_SETCAT", "document", docId, `${doc.category} → ${cat}`);
      break;
    }
    case "SETPROJ": {
      const projId = parseInt(extra ?? "0", 10);
      if (isNaN(projId) || projId <= 0) {
        await ctx.answerCbQuery("⚠️ 非法项目", { show_alert: true });
        return;
      }
      const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projId), notDeleted(projectsTable)));
      if (projRows.length === 0) {
        await ctx.answerCbQuery("❌ 项目不存在", { show_alert: true });
        return;
      }
      await db.update(documentsTable).set({ projectId: projId }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
      await ctx.answerCbQuery(`📁 已关联到 ${projRows[0].name}`);
      if (actor) await writeAudit(actor.id, "DOCUMENT_LINK_PROJECT", "document", docId, `→ ${projRows[0].name}`);
      break;
    }
    case "UNLINK":
      await db.update(documentsTable).set({ projectId: null }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
      await ctx.answerCbQuery("🚫 已解除关联");
      if (actor) await writeAudit(actor.id, "DOCUMENT_UNLINK_PROJECT", "document", docId, doc.title);
      break;
    default:
      await ctx.answerCbQuery("⚠️ 未知操作");
      return;
  }

  await showDocCard(ctx, docId, role);
}
