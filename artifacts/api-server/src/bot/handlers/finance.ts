import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { financeRecordsTable, usersTable, projectsTable, notDeleted } from "@workspace/db";
import { eq, and, gte, lte, desc, inArray, count } from "drizzle-orm";
import {
  editOrSend, buildKeyboard, shortTitle, statusLabel, formatDate,
  EMPTY_LIST_MSG, writeAudit,
} from "../helpers.js";
import type { Role } from "../permissions.js";
import { canExecuteAction } from "../permissions.js";
import { userDisplayName, getUserByTelegramId } from "../user-service.js";
import { startFlow } from "../form-handler.js";

const PAGE_SIZE = 8;

const FILTER_LABELS: Record<string, string> = {
  PENDING: "⏳ 待审核",
  PASSED: "✅ 已通过",
  FAILED: "❌ 已驳回",
  ARCH: "🗄 已归档",
};

const TYPE_LABELS: Record<string, string> = {
  INCOME: "➕ 收入",
  EXPENSE: "➖ 支出",
  REIMB: "🧾 报销",
};

function pageHeader(total: number, offset: number): string {
  if (total === 0) return EMPTY_LIST_MSG;
  return `共 ${total} 条 · 第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`;
}

function bucketByCurrency(rows: { amount: string | number; currency: string; type: string }[]): Record<string, { income: number; expense: number; reimb: number }> {
  const out: Record<string, { income: number; expense: number; reimb: number }> = {};
  for (const r of rows) {
    const cur = r.currency || "CNY";
    if (!out[cur]) out[cur] = { income: 0, expense: 0, reimb: 0 };
    const amt = Number(r.amount);
    if (r.type === "INCOME") out[cur].income += amt;
    else if (r.type === "EXPENSE") out[cur].expense += amt;
    else if (r.type === "REIMB") out[cur].reimb += amt;
  }
  return out;
}

export async function showFinList(ctx: Context, role: Role, filter = "PENDING", offset = 0): Promise<void> {
  if (!["PENDING", "PASSED", "FAILED", "ARCH"].includes(filter)) filter = "PENDING";
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const conds = filter === "ARCH"
    ? [eq(financeRecordsTable.isArchived, 1), notDeleted(financeRecordsTable)]
    : filter === "PENDING"
      ? [eq(financeRecordsTable.isArchived, 0), eq(financeRecordsTable.status, "PENDING_APPROVAL"), notDeleted(financeRecordsTable)]
      : [eq(financeRecordsTable.isArchived, 0), eq(financeRecordsTable.status, filter), notDeleted(financeRecordsTable)];

  const whereClause = and(...conds);
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(financeRecordsTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(financeRecordsTable)
    .where(whereClause)
    .orderBy(desc(financeRecordsTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const tabRow = (["PENDING", "PASSED", "FAILED", "ARCH"] as const).map((f) => ({
    text: filter === f ? `« ${FILTER_LABELS[f]} »` : FILTER_LABELS[f],
    callback_data: `FIN:LIST:${f}:0`,
  }));

  const itemButtons = slice.map((r) => ({
    text: `${TYPE_LABELS[r.type] ?? "💰"} #${r.id} ${r.amount}${r.currency} ${shortTitle(r.purpose, 14)}`,
    callback_data: `FIN:DETAIL:${r.id}`,
  }));

  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️ 上一页", callback_data: `FIN:LIST:${filter}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "下一页 ➡️", callback_data: `FIN:LIST:${filter}:${offset + PAGE_SIZE}` });

  const out: { text: string; callback_data: string }[][] = [tabRow.slice(0, 2), tabRow.slice(2, 4)];
  for (const b of itemButtons) out.push([b]);
  if (navRow.length > 0) out.push(navRow);
  out.push([{ text: "🔙 返回", callback_data: "M:FIN" }]);

  await editOrSend(ctx, `💰 <b>资金动向</b> · ${FILTER_LABELS[filter]}\n\n${pageHeader(total, offset)}`, out);
}

export async function showPendingApprovals(ctx: Context, role: Role): Promise<void> {
  await showFinList(ctx, role, "PENDING", 0);
}

export async function showMonthlyReport(ctx: Context, monthOffset = 0): Promise<void> {
  if (!Number.isFinite(monthOffset)) monthOffset = 0;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0, 23, 59, 59);

  const rows = await db
    .select()
    .from(financeRecordsTable)
    .where(and(
      eq(financeRecordsTable.isArchived, 0),
      gte(financeRecordsTable.occurDate, startOfMonth),
      lte(financeRecordsTable.occurDate, endOfMonth),
      notDeleted(financeRecordsTable),
    ));

  // Only count PASSED for IN/OUT/REIMB; PENDING_APPROVAL/FAILED excluded
  const counted = rows.filter((r) => r.status === "PASSED");
  const buckets = bucketByCurrency(counted);

  const lines = [`📊 <b>${startOfMonth.getFullYear()}年${startOfMonth.getMonth() + 1}月财务报表</b>`, ""];
  if (Object.keys(buckets).length === 0) {
    lines.push("（本月暂无已通过的财务记录）");
  } else {
    for (const [cur, b] of Object.entries(buckets)) {
      const net = b.income - b.expense - b.reimb;
      lines.push(`💱 <b>${cur}</b>`);
      lines.push(`  ➕ 收入：${b.income.toFixed(2)}`);
      lines.push(`  ➖ 支出：${b.expense.toFixed(2)}`);
      lines.push(`  🧾 报销：${b.reimb.toFixed(2)}`);
      lines.push(`  💰 净额：<b>${net.toFixed(2)}</b>`);
      lines.push("");
    }
  }
  lines.push(`📋 <b>本月记录：</b>${rows.length} 条（已通过 ${counted.length} / 待审 ${rows.filter((r) => r.status === "PENDING_APPROVAL").length}）`);

  const navRow = [
    { text: "⬅️ 上月", callback_data: `FIN:MONTHLY:${monthOffset - 1}` },
    { text: "今月 📅", callback_data: "FIN:MONTHLY:0" },
  ];
  if (monthOffset < 0) navRow.push({ text: "下月 ➡️", callback_data: `FIN:MONTHLY:${monthOffset + 1}` });

  await editOrSend(ctx, lines.join("\n"), [navRow, [{ text: "🔙 返回", callback_data: "M:FIN" }]]);
}

export async function showByProject(ctx: Context): Promise<void> {
  // Single batched query: get all non-archived records with projectId then group in memory
  const rows = await db
    .select()
    .from(financeRecordsTable)
    .where(and(eq(financeRecordsTable.isArchived, 0), notDeleted(financeRecordsTable)));

  if (rows.length === 0) {
    await editOrSend(ctx, `📂 <b>按项目资金统计</b>\n\n${EMPTY_LIST_MSG}`, [[{ text: "🔙 返回", callback_data: "M:FIN" }]]);
    return;
  }

  // Group: projectId → currency → {income, expense, reimb}
  const byProject = new Map<number | "NONE", { count: number; cur: Record<string, { income: number; expense: number; reimb: number }> }>();
  for (const r of rows) {
    if (r.status !== "PASSED") continue;
    const key = r.projectId ?? "NONE";
    if (!byProject.has(key)) byProject.set(key, { count: 0, cur: {} });
    const e = byProject.get(key)!;
    e.count++;
    const cur = r.currency || "CNY";
    if (!e.cur[cur]) e.cur[cur] = { income: 0, expense: 0, reimb: 0 };
    const amt = Number(r.amount);
    if (r.type === "INCOME") e.cur[cur].income += amt;
    else if (r.type === "EXPENSE") e.cur[cur].expense += amt;
    else if (r.type === "REIMB") e.cur[cur].reimb += amt;
  }

  // Batch fetch projects
  const projIds = [...byProject.keys()].filter((k): k is number => typeof k === "number");
  const projects = projIds.length > 0
    ? await db.select().from(projectsTable).where(and(inArray(projectsTable.id, projIds), notDeleted(projectsTable)))
    : [];
  const projMap = new Map(projects.map((p) => [p.id, p.name]));

  const lines = ["📂 <b>按项目资金统计</b>（仅含已通过）", ""];
  let printed = 0;
  for (const [key, e] of byProject.entries()) {
    const name = key === "NONE" ? "（未关联项目）" : (projMap.get(key) ?? `项目#${key}`);
    const curParts = Object.entries(e.cur).map(([cur, b]) => {
      const net = b.income - b.expense - b.reimb;
      return `${net.toFixed(2)} ${cur}`;
    });
    if (curParts.length > 0) {
      lines.push(`📁 <b>${name}</b>: ${curParts.join(" · ")} (${e.count} 条)`);
      printed++;
    }
  }
  if (printed === 0) lines.push(EMPTY_LIST_MSG);

  await editOrSend(ctx, lines.join("\n"), [[{ text: "🔙 返回", callback_data: "M:FIN" }]]);
}

export async function showFinCard(ctx: Context, finId: number, role: Role): Promise<void> {
  const rows = await db.select().from(financeRecordsTable).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
  if (rows.length === 0) {
    await editOrSend(ctx, "❌ 财务记录不存在或已删除", [[{ text: "🔙 返回", callback_data: "M:FIN" }]]);
    return;
  }
  const rec = rows[0];

  let creatorName = "—";
  const cRows = await db.select().from(usersTable).where(eq(usersTable.id, rec.creatorId));
  if (cRows.length > 0) creatorName = userDisplayName(cRows[0]);

  let reviewerName = "—";
  if (rec.reviewerId) {
    const rRows = await db.select().from(usersTable).where(eq(usersTable.id, rec.reviewerId));
    if (rRows.length > 0) reviewerName = userDisplayName(rRows[0]);
  }

  let projectName = "—";
  if (rec.projectId) {
    const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, rec.projectId), notDeleted(projectsTable)));
    if (projRows.length > 0) projectName = projRows[0].name;
  }

  const archivedTag = rec.isArchived === 1 ? " 🗄 已归档" : "";
  const text = `💰 <b>流水 #${rec.id}</b>${archivedTag}

📌 <b>类型：</b>${TYPE_LABELS[rec.type] ?? rec.type}
💰 <b>金额：</b>${rec.amount} ${rec.currency}
📋 <b>用途：</b>${rec.purpose}
📁 <b>项目：</b>${projectName}
📊 <b>状态：</b>${statusLabel(rec.status)}
👤 <b>提交人：</b>${creatorName}
🔍 <b>审核人：</b>${reviewerName}
📅 <b>发生日期：</b>${formatDate(rec.occurDate)}
📝 <b>审核备注：</b>${rec.reviewNote ?? "—"}`;

  const buttons: { text: string; callback_data: string }[] = [];
  if (rec.isArchived === 0) {
    if (rec.status === "PENDING_APPROVAL") {
      if (canExecuteAction(role, "FIN:PASS")) buttons.push({ text: "✅ 通过", callback_data: `FIN:PASS:${finId}` });
      if (canExecuteAction(role, "FIN:FAIL")) buttons.push({ text: "❌ 驳回", callback_data: `FIN:FAIL:${finId}` });
    }
    if (canExecuteAction(role, "FIN:CHPROJ")) {
      buttons.push({ text: "📁 改归属", callback_data: `FIN:CHPROJ:${finId}:0` });
    }
    if (canExecuteAction(role, "FIN:ARCH")) {
      buttons.push({ text: "🗄 归档", callback_data: `FIN:ARCH:${finId}` });
    }
  } else if (canExecuteAction(role, "FIN:UNARCH")) {
    buttons.push({ text: "♻️ 取消归档", callback_data: `FIN:UNARCH:${finId}` });
  }
  if (canExecuteAction(role, "FIN:DEL")) {
    buttons.push({ text: "🗑 删除", callback_data: `FIN:DEL:${finId}` });
  }

  await editOrSend(ctx, text, buildKeyboard(buttons, 2, [{ text: "🔙 返回", callback_data: "M:FIN" }]));
}

export async function startFinFlow(ctx: Context, flowKey: "FIN:IN" | "FIN:OUT" | "FIN:REIMB", role: Role): Promise<void> {
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
  await startFlow(ctx, flowKey, role, undefined, { project_id: projectOptions });
}

export async function startFinReview(ctx: Context, action: "PASS" | "FAIL", finId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, `FIN:${action}`)) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(financeRecordsTable).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 记录不存在", { show_alert: true });
    return;
  }
  if (rows[0].isArchived === 1) {
    await ctx.answerCbQuery("⚠️ 已归档的记录不可审核", { show_alert: true });
    return;
  }
  if (rows[0].status !== "PENDING_APPROVAL") {
    await ctx.answerCbQuery("⚠️ 当前状态不可审核", { show_alert: true });
    return;
  }
  const telegramId = String(ctx.from?.id ?? "");
  const actor = await getUserByTelegramId(telegramId);
  if (actor && rows[0].creatorId === actor.id) {
    await ctx.answerCbQuery("⚠️ 不能审核自己提交的记录", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await startFlow(ctx, `FIN:${action}`, role, { finId });
}

export async function showFinProjectPicker(ctx: Context, finId: number, offset: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "FIN:CHPROJ")) {
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
    callback_data: `FIN:SETPROJ:${finId}:${p.id}`,
  }));
  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️", callback_data: `FIN:CHPROJ:${finId}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "➡️", callback_data: `FIN:CHPROJ:${finId}:${offset + PAGE_SIZE}` });

  const out: { text: string; callback_data: string }[][] = [];
  for (const b of items) out.push([b]);
  if (navRow.length > 0) out.push(navRow);
  out.push([{ text: "🚫 解除关联", callback_data: `FIN:UNLINK:${finId}` }]);
  out.push([{ text: "🔙 返回", callback_data: `FIN:DETAIL:${finId}` }]);

  await ctx.answerCbQuery();
  await editOrSend(ctx, `📁 <b>更改流水 #${finId} 关联项目</b>\n\n${pageHeader(total, offset)}\n请选择项目：`, out);
}

export async function handleFinAction(ctx: Context, action: string, finId: number, role: Role, extra?: string): Promise<void> {
  if (!canExecuteAction(role, `FIN:${action}`)) {
    await ctx.answerCbQuery("⛔ 你没有权限执行该操作", { show_alert: true });
    return;
  }

  const rows = await db.select().from(financeRecordsTable).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 记录不存在", { show_alert: true });
    return;
  }
  const rec = rows[0];
  const telegramId = String(ctx.from?.id ?? "");
  const actor = await getUserByTelegramId(telegramId);

  switch (action) {
    case "ARCH":
      await db.update(financeRecordsTable).set({ isArchived: 1 }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
      await ctx.answerCbQuery("🗄 已归档");
      if (actor) await writeAudit(actor.id, "FINANCE_ARCHIVE", "finance", finId, rec.purpose);
      break;
    case "DEL":
      await db.update(financeRecordsTable).set({ deletedAt: new Date() }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
      await ctx.answerCbQuery("🗑 已移入回收站");
      if (actor) await writeAudit(actor.id, "FINANCE_DELETE", "finance", finId, rec.purpose, "HIGH");
      return;
    case "UNARCH":
      await db.update(financeRecordsTable).set({ isArchived: 0 }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
      await ctx.answerCbQuery("♻️ 已取消归档");
      if (actor) await writeAudit(actor.id, "FINANCE_UNARCHIVE", "finance", finId, rec.purpose);
      break;
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
      await db.update(financeRecordsTable).set({ projectId: projId }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
      await ctx.answerCbQuery(`📁 已关联到 ${projRows[0].name}`);
      if (actor) await writeAudit(actor.id, "FINANCE_LINK_PROJECT", "finance", finId, `→ ${projRows[0].name}`);
      break;
    }
    case "UNLINK":
      await db.update(financeRecordsTable).set({ projectId: null }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
      await ctx.answerCbQuery("🚫 已解除关联");
      if (actor) await writeAudit(actor.id, "FINANCE_UNLINK_PROJECT", "finance", finId, rec.purpose);
      break;
    default:
      await ctx.answerCbQuery("⚠️ 未知操作");
      return;
  }

  await showFinCard(ctx, finId, role);
}
