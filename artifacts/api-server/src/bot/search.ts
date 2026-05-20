import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { tasksTable, requirementsTable, documentsTable, projectsTable, notDeleted } from "@workspace/db";
import { like, or, and } from "drizzle-orm";
import { editOrSend, buildKeyboard } from "./helpers.js";
import { getSession, saveSession, clearSession } from "./session.js";

export async function startSearch(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id ?? "");
  await saveSession(telegramId, { state: "form", flow: "SEARCH", step: 0, formData: {}, steps: [] });
  await ctx.reply("🔍 请输入搜索关键词（最少2个字符）：");
}

export async function handleSearch(ctx: Context, query: string): Promise<void> {
  if (query.length < 2) {
    await ctx.reply("⚠️ 请至少输入2个字符进行搜索");
    return;
  }

  const q = `%${query}%`;
  const [tasks, reqs, docs, projects] = await Promise.all([
    db.select().from(tasksTable).where(and(like(tasksTable.title, q), notDeleted(tasksTable))),
    db.select().from(requirementsTable).where(and(like(requirementsTable.title, q), notDeleted(requirementsTable))),
    db.select().from(documentsTable).where(and(or(like(documentsTable.title, q), like(documentsTable.tags, q)), notDeleted(documentsTable))),
    db.select().from(projectsTable).where(and(like(projectsTable.name, q), notDeleted(projectsTable))),
  ]);

  const lines = [`🔍 <b>搜索结果：「${query}」</b>\n`];
  const buttons: { text: string; callback_data: string }[] = [];

  const SHOW = 3;
  const truncate = (s: string, n = 14) => (s.length > n ? s.slice(0, n) + "…" : s);

  if (projects.length > 0) {
    lines.push(`📁 <b>项目</b>（${projects.length} 个${projects.length > SHOW ? `，显示前 ${SHOW}` : ""}）`);
    for (const p of projects.slice(0, SHOW)) {
      lines.push(`  • #${p.id} ${p.name}`);
      buttons.push({ text: `📁 #${p.id} ${truncate(p.name)}`, callback_data: `PROJ:OPEN:${p.id}` });
    }
    if (projects.length > SHOW) buttons.push({ text: `📁 查看全部项目（${projects.length}）`, callback_data: "M:PROJ" });
  }

  if (tasks.length > 0) {
    lines.push(`✅ <b>任务</b>（${tasks.length} 条${tasks.length > SHOW ? `，显示前 ${SHOW}` : ""}）`);
    for (const t of tasks.slice(0, SHOW)) {
      lines.push(`  • #${t.id} ${t.title}`);
      buttons.push({ text: `✅ #${t.id} ${truncate(t.title)}`, callback_data: `TASK:OPEN:${t.id}` });
    }
    if (tasks.length > SHOW) buttons.push({ text: `✅ 查看全部任务（${tasks.length}）`, callback_data: "M:TASK" });
  }

  if (reqs.length > 0) {
    lines.push(`📌 <b>需求</b>（${reqs.length} 条${reqs.length > SHOW ? `，显示前 ${SHOW}` : ""}）`);
    for (const r of reqs.slice(0, SHOW)) {
      lines.push(`  • #${r.id} ${r.title}`);
      buttons.push({ text: `📌 #${r.id} ${truncate(r.title)}`, callback_data: `REQ:OPEN:${r.id}` });
    }
    if (reqs.length > SHOW) buttons.push({ text: `📌 查看全部需求（${reqs.length}）`, callback_data: "M:REQ" });
  }

  if (docs.length > 0) {
    lines.push(`📚 <b>文档</b>（${docs.length} 篇${docs.length > SHOW ? `，显示前 ${SHOW}` : ""}）`);
    for (const d of docs.slice(0, SHOW)) {
      lines.push(`  • #${d.id} ${d.title}`);
      buttons.push({ text: `📚 #${d.id} ${truncate(d.title)}`, callback_data: `DOC:OPEN:${d.id}` });
    }
    if (docs.length > SHOW) buttons.push({ text: `📚 查看全部文档（${docs.length}）`, callback_data: "M:DOC" });
  }

  if (tasks.length === 0 && reqs.length === 0 && docs.length === 0 && projects.length === 0) {
    lines.push("📭 未找到相关内容");
  }

  const telegramId = String(ctx.from?.id ?? "");
  await clearSession(telegramId);

  await editOrSend(ctx, lines.join("\n"), buildKeyboard(buttons, 2, [{ text: "🔙 返回主页", callback_data: "M:HOME" }]));
}
