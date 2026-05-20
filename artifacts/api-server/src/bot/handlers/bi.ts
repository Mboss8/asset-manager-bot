import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { tasksTable, requirementsTable, financeRecordsTable, projectsTable, risksTable, usersTable, notDeleted } from "@workspace/db";
import { eq, and, gte, lte, lt, inArray } from "drizzle-orm";
import { editOrSend, CHANNEL_ID, GROUP_ID, writeAudit, shortTitle, formatDate, EMPTY_LIST_MSG } from "../helpers.js";
import { dispatchBroadcast } from "../dispatch.js";
import type { Role } from "../permissions.js";
import { canExecuteAction } from "../permissions.js";
import { getUserByTelegramId, userDisplayName } from "../user-service.js";

const PAGE_SIZE = 8;

// ---------- date helpers ----------
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
/** ISO week start (Monday 00:00). On Sundays, returns last Monday — fixes the "future weekStart" bug. */
function startOfIsoWeek(d: Date): Date {
  const s = startOfDay(d);
  const dow = (s.getDay() + 6) % 7; // Mon=0 ... Sun=6
  s.setDate(s.getDate() - dow);
  return s;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function fmtMoney(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function progressBar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.floor((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function deltaStr(curr: number, prev: number, unit = ""): string {
  const d = curr - prev;
  if (d === 0) return ` (持平${unit ? "" : ""})`;
  const sign = d > 0 ? "▲" : "▼";
  return ` (${sign}${Math.abs(d)}${unit} vs 上期)`;
}
function pctDeltaStr(curr: number, prev: number): string {
  if (prev === 0 && curr === 0) return " (持平)";
  if (prev === 0) return " (新增)";
  const pct = Math.round(((curr - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return " (持平)";
  return ` (${pct > 0 ? "▲" : "▼"}${Math.abs(pct)}%)`;
}

// ---------- shared backs ----------
const BACK_ROW = [{ text: "🔙 返回", callback_data: "M:BI" }];

// ===========================================================================
// 📌 今日概览
// ===========================================================================
export async function showDailyOverview(ctx: Context): Promise<void> {
  const now = new Date();
  const todayStart = startOfDay(now);
  const yesterdayStart = addDays(todayStart, -1);
  const tomorrow = addDays(todayStart, 1);

  const allTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));
  const todoDoing = allTasks.filter((t) => t.status === "TODO" || t.status === "DOING").length;
  const doneToday = allTasks.filter((t) => t.status === "DONE" && t.updatedAt >= todayStart).length;
  const doneYesterday = allTasks.filter((t) => t.status === "DONE" && t.updatedAt >= yesterdayStart && t.updatedAt < todayStart).length;
  const overdue = allTasks.filter((t) => t.dueDate && t.dueDate < now && t.status !== "DONE").length;
  const dueTodayList = allTasks.filter((t) => t.dueDate && t.dueDate >= todayStart && t.dueDate < tomorrow && t.status !== "DONE");
  const dueTodayTodo = dueTodayList.filter((t) => t.status === "TODO").length;
  const dueTodayDoing = dueTodayList.filter((t) => t.status === "DOING").length;

  const pendingReqs = await db.select().from(requirementsTable).where(and(eq(requirementsTable.status, "PENDING"), eq(requirementsTable.isArchived, 0), notDeleted(requirementsTable)));
  const pendingFin = await db.select().from(financeRecordsTable).where(and(eq(financeRecordsTable.status, "PENDING_APPROVAL"), eq(financeRecordsTable.isArchived, 0), notDeleted(financeRecordsTable)));
  const activeProjects = await db.select().from(projectsTable).where(and(eq(projectsTable.status, "ACTIVE"), eq(projectsTable.isArchived, 0), notDeleted(projectsTable)));
  const riskProjects = await db.select().from(projectsTable).where(and(eq(projectsTable.status, "RISK"), eq(projectsTable.isArchived, 0), notDeleted(projectsTable)));

  const text = `📌 <b>今日概览</b> — ${now.toLocaleDateString("zh-CN")}

📁 活跃项目：<b>${activeProjects.length}</b> 个${riskProjects.length > 0 ? `（其中 <b>${riskProjects.length}</b> 个风险中 ⚠️）` : ""}
✅ 进行中任务：<b>${todoDoing}</b> 条
🎉 今日完成：<b>${doneToday}</b> 条${deltaStr(doneToday, doneYesterday, " 条")}
🗓 今日截止：<b>${dueTodayList.length}</b> 条${dueTodayList.length > 0 ? ` (📋待办 ${dueTodayTodo} · ▶️进行 ${dueTodayDoing})` : ""}
🚨 超期任务：<b>${overdue}</b> 条

📥 待评审需求：<b>${pendingReqs.length}</b> 条
⏳ 待审核财务：<b>${pendingFin.length}</b> 条`;

  const kb = [
    [{ text: "🔄 刷新", callback_data: "BI:DAILY" }, { text: "👤 我的看板", callback_data: "BI:MINE" }],
    BACK_ROW,
  ];
  await editOrSend(ctx, text, kb);
}

// ===========================================================================
// 👤 我的看板
// ===========================================================================
export async function showMyDashboard(ctx: Context): Promise<void> {
  const telegramId = String(ctx.from?.id ?? "");
  const me = await getUserByTelegramId(telegramId);
  if (!me) {
    await editOrSend(ctx, "❌ 用户身份未识别", [BACK_ROW]);
    return;
  }
  const now = new Date();
  const todayStart = startOfDay(now);
  const weekStart = startOfIsoWeek(now);
  const tomorrow = addDays(todayStart, 1);

  const myTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.assigneeId, me.id), eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));
  const open = myTasks.filter((t) => t.status === "TODO" || t.status === "DOING");
  const overdue = open.filter((t) => t.dueDate && t.dueDate < now);
  const dueToday = open.filter((t) => t.dueDate && t.dueDate >= todayStart && t.dueDate < tomorrow);
  const doneToday = myTasks.filter((t) => t.status === "DONE" && t.updatedAt >= todayStart).length;
  const doneThisWeek = myTasks.filter((t) => t.status === "DONE" && t.updatedAt >= weekStart).length;

  const myReqs = await db.select().from(requirementsTable).where(and(eq(requirementsTable.creatorId, me.id), eq(requirementsTable.isArchived, 0), notDeleted(requirementsTable)));
  const myReqPending = myReqs.filter((r) => r.status === "PENDING").length;

  const myFin = await db.select().from(financeRecordsTable).where(and(eq(financeRecordsTable.creatorId, me.id), eq(financeRecordsTable.isArchived, 0), notDeleted(financeRecordsTable)));
  const myFinPending = myFin.filter((r) => r.status === "PENDING_APPROVAL").length;

  const lines = [`👤 <b>${userDisplayName(me)} 的看板</b>`, ""];
  lines.push(`📋 我的进行中任务：<b>${open.length}</b> 条`);
  lines.push(`🚨 我的超期任务：<b>${overdue.length}</b> 条`);
  lines.push(`🗓 今日到期：<b>${dueToday.length}</b> 条`);
  lines.push(`🎉 今日完成：<b>${doneToday}</b> 条 / 本周 <b>${doneThisWeek}</b> 条`);
  lines.push("");
  lines.push(`📥 我提交的需求待评审：<b>${myReqPending}</b> 条`);
  lines.push(`⏳ 我提交的报销/财务待审：<b>${myFinPending}</b> 条`);

  if (overdue.length > 0) {
    lines.push("\n<b>🚨 超期任务（前 5）：</b>");
    for (const t of overdue.slice(0, 5)) {
      lines.push(`  · #${t.id} ${shortTitle(t.title, 22)} · 截 ${formatDate(t.dueDate)}`);
    }
  } else if (dueToday.length > 0) {
    lines.push("\n<b>🗓 今日到期：</b>");
    for (const t of dueToday.slice(0, 5)) {
      lines.push(`  · #${t.id} ${shortTitle(t.title, 22)}`);
    }
  }

  const kb = [
    [{ text: "🔄 刷新", callback_data: "BI:MINE" }, { text: "📋 我的任务", callback_data: "TASK:MY:ALL:0" }],
    BACK_ROW,
  ];
  await editOrSend(ctx, lines.join("\n"), kb);
}

// ===========================================================================
// 📅 本周进度
// ===========================================================================
export async function showWeeklyProgress(ctx: Context): Promise<void> {
  const now = new Date();
  const weekStart = startOfIsoWeek(now);
  const weekEnd = addDays(weekStart, 7);
  const lastWeekStart = addDays(weekStart, -7);

  const allTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));

  // tasks completed this week (by updatedAt + status DONE)
  const doneThisWeek = allTasks.filter((t) => t.status === "DONE" && t.updatedAt >= weekStart && t.updatedAt < weekEnd);
  const doneLastWeek = allTasks.filter((t) => t.status === "DONE" && t.updatedAt >= lastWeekStart && t.updatedAt < weekStart);

  // tasks due this week
  const dueThisWeek = allTasks.filter((t) => t.dueDate && t.dueDate >= weekStart && t.dueDate < weekEnd);
  const dueDone = dueThisWeek.filter((t) => t.status === "DONE").length;
  const dueDoing = dueThisWeek.filter((t) => t.status === "DOING").length;
  const dueTodo = dueThisWeek.filter((t) => t.status === "TODO").length;
  const progress = dueThisWeek.length > 0 ? Math.round((dueDone / dueThisWeek.length) * 100) : 0;

  // top contributors (by completed tasks this week)
  const counts = new Map<number, number>();
  for (const t of doneThisWeek) {
    if (t.assigneeId) counts.set(t.assigneeId, (counts.get(t.assigneeId) ?? 0) + 1);
  }
  const topIds = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  let topLines = "";
  if (topIds.length > 0) {
    const users = await db.select().from(usersTable).where(inArray(usersTable.id, topIds.map(([id]) => id)));
    const userMap = new Map(users.map((u) => [u.id, userDisplayName(u)]));
    topLines = "\n<b>🏆 本周完成榜：</b>\n" + topIds.map(([id, n], i) => `  ${["🥇", "🥈", "🥉", " 4.", " 5."][i]} ${userMap.get(id) ?? `#${id}`} · ${n} 条`).join("\n");
  }

  const text = `📅 <b>本周进度</b>（${weekStart.toLocaleDateString("zh-CN")} ~ ${addDays(weekEnd, -1).toLocaleDateString("zh-CN")}）

🎉 本周已完成：<b>${doneThisWeek.length}</b> 条${deltaStr(doneThisWeek.length, doneLastWeek.length, " 条")}

<b>📊 本周到期任务：</b>${dueThisWeek.length} 条
  ✅ 已完成 ${dueDone} · ▶️ 进行中 ${dueDoing} · 📋 待开始 ${dueTodo}
[${progressBar(progress)}] <b>${progress}%</b>${topLines}`;

  const kb = [
    [{ text: "🔄 刷新", callback_data: "BI:WEEKLY" }, { text: "🧾 生成周报", callback_data: "BI:REPORT" }],
    BACK_ROW,
  ];
  await editOrSend(ctx, text, kb);
}

// ===========================================================================
// ⚠️ 风险预警
// ===========================================================================
export async function showRiskAlert(ctx: Context, offset = 0): Promise<void> {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const now = new Date();

  const risks = await db.select().from(risksTable).where(eq(risksTable.status, "OPEN"));
  // clamp offset to last valid page (in case of stale callback after data shrunk)
  if (risks.length > 0 && offset >= risks.length) {
    offset = Math.floor((risks.length - 1) / PAGE_SIZE) * PAGE_SIZE;
  } else if (risks.length === 0) {
    offset = 0;
  }
  const overdueAll = await db.select().from(tasksTable).where(and(eq(tasksTable.isArchived, 0), lt(tasksTable.dueDate, now), notDeleted(tasksTable)));
  const overdueActive = overdueAll.filter((t) => t.status !== "DONE");

  const high = risks.filter((r) => r.severity === "HIGH");
  const med = risks.filter((r) => r.severity === "MEDIUM");
  const low = risks.filter((r) => r.severity === "LOW");
  const sortedRisks = [...high, ...med, ...low];

  // overdue task ranking by project
  const projCount = new Map<number, number>();
  for (const t of overdueActive) {
    if (t.projectId) projCount.set(t.projectId, (projCount.get(t.projectId) ?? 0) + 1);
  }
  const topProjIds = [...projCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  let topProjLines = "";
  if (topProjIds.length > 0) {
    const projects = await db.select().from(projectsTable).where(and(inArray(projectsTable.id, topProjIds.map(([id]) => id)), notDeleted(projectsTable)));
    const pMap = new Map(projects.map((p) => [p.id, p.name]));
    topProjLines = "\n<b>📁 超期最多的项目：</b>\n" + topProjIds.map(([id, n]) => `  · ${pMap.get(id) ?? `项目#${id}`} · ${n} 条`).join("\n");
  }

  const lines = [`⚠️ <b>风险预警</b> — ${now.toLocaleDateString("zh-CN")}`, ""];
  lines.push(`🔴 高风险：<b>${high.length}</b> · 🟡 中风险：<b>${med.length}</b> · 🟢 低风险：<b>${low.length}</b>`);
  lines.push(`🚨 超期任务：<b>${overdueActive.length}</b> 条`);
  if (topProjLines) lines.push(topProjLines);

  const total = sortedRisks.length;
  const slice = sortedRisks.slice(offset, offset + PAGE_SIZE);
  if (slice.length > 0) {
    lines.push(`\n<b>📋 开放风险（第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页）：</b>`);
    for (const r of slice) {
      const tag = r.severity === "HIGH" ? "🔴" : r.severity === "MEDIUM" ? "🟡" : "🟢";
      lines.push(`  ${tag} #${r.id} ${shortTitle(r.title, 30)}`);
    }
  } else if (total === 0) {
    lines.push(`\n${EMPTY_LIST_MSG}`);
  }

  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️ 上一页", callback_data: `BI:RISK:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "下一页 ➡️", callback_data: `BI:RISK:${offset + PAGE_SIZE}` });

  const kb: { text: string; callback_data: string }[][] = [];
  if (navRow.length > 0) kb.push(navRow);
  kb.push([{ text: "🔄 刷新", callback_data: "BI:RISK:0" }, { text: "📊 项目健康", callback_data: "BI:HEALTH" }]);
  kb.push(BACK_ROW);
  await editOrSend(ctx, lines.join("\n"), kb);
}

// ===========================================================================
// 📊 项目健康度
// ===========================================================================
export async function showProjectHealth(ctx: Context): Promise<void> {
  const now = new Date();
  const projects = await db.select().from(projectsTable).where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)));
  if (projects.length === 0) {
    await editOrSend(ctx, `📊 <b>项目健康度</b>\n\n${EMPTY_LIST_MSG}`, [BACK_ROW]);
    return;
  }
  const allTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));
  const allRisks = await db.select().from(risksTable).where(eq(risksTable.status, "OPEN"));

  type Row = { id: number; name: string; status: string; total: number; done: number; overdue: number; risks: number; score: number };
  const rows: Row[] = projects.map((p) => {
    const ts = allTasks.filter((t) => t.projectId === p.id);
    const total = ts.length;
    const done = ts.filter((t) => t.status === "DONE").length;
    const overdue = ts.filter((t) => t.dueDate && t.dueDate < now && t.status !== "DONE").length;
    const risks = allRisks.filter((r) => r.projectId === p.id).length;
    // health score: 100 - 8*overdue - 12*risks; floor at 0; bonus for completion
    const completionPct = total > 0 ? (done / total) * 100 : 0;
    let score = 100 - overdue * 8 - risks * 12 + (completionPct - 50) * 0.2;
    if (p.status === "RISK") score -= 15;
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { id: p.id, name: p.name, status: p.status, total, done, overdue, risks, score };
  });
  rows.sort((a, b) => a.score - b.score);

  const lines = [`📊 <b>项目健康度排行</b> · 共 ${rows.length} 个`, ""];
  for (const r of rows.slice(0, 12)) {
    const icon = r.score >= 80 ? "🟢" : r.score >= 50 ? "🟡" : "🔴";
    lines.push(`${icon} <b>${shortTitle(r.name, 18)}</b> · ${r.score}分`);
    lines.push(`   ✅ ${r.done}/${r.total} · 🚨${r.overdue} · ⚠️${r.risks}`);
  }
  if (rows.length > 12) lines.push(`\n…共 ${rows.length} 个，仅显示前 12`);

  const kb = [
    [{ text: "🔄 刷新", callback_data: "BI:HEALTH" }, { text: "⚠️ 风险预警", callback_data: "BI:RISK:0" }],
    BACK_ROW,
  ];
  await editOrSend(ctx, lines.join("\n"), kb);
}

// ===========================================================================
// 💰 月度资金流（含上月对比 + 上月偏移）
// ===========================================================================
export async function showMonthlyFinBI(ctx: Context, monthOffset = 0): Promise<void> {
  if (!Number.isFinite(monthOffset)) monthOffset = 0;
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
  const prev = new Date(target.getFullYear(), target.getMonth() - 1, 1);

  const targetStart = startOfMonth(target);
  const targetEnd = endOfMonth(target);
  const prevStart = startOfMonth(prev);
  const prevEnd = endOfMonth(prev);

  const [currRows, prevRows] = await Promise.all([
    db.select().from(financeRecordsTable).where(and(gte(financeRecordsTable.occurDate, targetStart), lte(financeRecordsTable.occurDate, targetEnd), eq(financeRecordsTable.isArchived, 0), notDeleted(financeRecordsTable))),
    db.select().from(financeRecordsTable).where(and(gte(financeRecordsTable.occurDate, prevStart), lte(financeRecordsTable.occurDate, prevEnd), eq(financeRecordsTable.isArchived, 0), notDeleted(financeRecordsTable))),
  ]);

  const sum = (rs: typeof currRows, type: string) => rs.filter((r) => r.type === type && r.status === "PASSED").reduce((s, r) => s + Number(r.amount), 0);
  const income = sum(currRows, "INCOME");
  const expense = sum(currRows, "EXPENSE");
  const reimb = sum(currRows, "REIMB");
  const incomePrev = sum(prevRows, "INCOME");
  const expensePrev = sum(prevRows, "EXPENSE");
  const reimbPrev = sum(prevRows, "REIMB");

  const pending = currRows.filter((r) => r.status === "PENDING_APPROVAL");
  const pendingAmount = pending.reduce((s, r) => s + Number(r.amount), 0);

  // top expense purposes
  const expenseRows = currRows.filter((r) => (r.type === "EXPENSE" || r.type === "REIMB") && r.status === "PASSED");
  const purposeMap = new Map<string, number>();
  for (const r of expenseRows) {
    const k = r.purpose.length > 16 ? r.purpose.slice(0, 16) + "…" : r.purpose;
    purposeMap.set(k, (purposeMap.get(k) ?? 0) + Number(r.amount));
  }
  const topPurposes = [...purposeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  const monthLabel = `${target.getFullYear()}年${target.getMonth() + 1}月`;
  const lines = [`💰 <b>${monthLabel} 资金流</b>${monthOffset === 0 ? "（本月）" : ""}`, ""];
  lines.push(`➕ 收入 <b>${fmtMoney(income)}</b> CNY${pctDeltaStr(income, incomePrev)}`);
  lines.push(`➖ 支出 <b>${fmtMoney(expense)}</b> CNY${pctDeltaStr(expense, expensePrev)}`);
  lines.push(`🧾 报销 <b>${fmtMoney(reimb)}</b> CNY${pctDeltaStr(reimb, reimbPrev)}`);
  lines.push(`──────────────`);
  lines.push(`💰 净额 <b>${fmtMoney(income - expense - reimb)}</b> CNY`);
  if (pending.length > 0) {
    lines.push(`\n⏳ <b>待审核</b>：${pending.length} 笔 · 涉及 ${fmtMoney(pendingAmount)} CNY`);
  }
  if (topPurposes.length > 0) {
    lines.push(`\n<b>📌 主要支出用途：</b>`);
    for (const [p, a] of topPurposes) {
      lines.push(`  · ${p} — ${fmtMoney(a)} CNY`);
    }
  }

  const kb: { text: string; callback_data: string }[][] = [
    [
      { text: "⬅️ 上一月", callback_data: `BI:FIN:${monthOffset - 1}` },
      ...(monthOffset < 0 ? [{ text: "下一月 ➡️", callback_data: `BI:FIN:${monthOffset + 1}` }] : []),
    ],
    [{ text: "🔄 本月", callback_data: "BI:FIN:0" }, { text: "📊 待审核", callback_data: "FIN:APPROVALS" }],
    BACK_ROW,
  ];
  await editOrSend(ctx, lines.join("\n"), kb);
}

// ===========================================================================
// 🧾 周报
// ===========================================================================
export async function generateWeeklyReport(ctx: Context, role: Role): Promise<void> {
  const now = new Date();
  const weekStart = startOfIsoWeek(now);
  const weekEnd = addDays(weekStart, 7);
  const lastWeekStart = addDays(weekStart, -7);

  const allTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));
  const doneThisWeek = allTasks.filter((t) => t.status === "DONE" && t.updatedAt >= weekStart && t.updatedAt < weekEnd);
  const doneLastWeek = allTasks.filter((t) => t.status === "DONE" && t.updatedAt >= lastWeekStart && t.updatedAt < weekStart);
  const overdueAll = allTasks.filter((t) => t.dueDate && t.dueDate < now && t.status !== "DONE");
  const projects = await db.select().from(projectsTable).where(and(eq(projectsTable.status, "ACTIVE"), eq(projectsTable.isArchived, 0), notDeleted(projectsTable)));

  // contributors
  const counts = new Map<number, number>();
  for (const t of doneThisWeek) {
    if (t.assigneeId) counts.set(t.assigneeId, (counts.get(t.assigneeId) ?? 0) + 1);
  }
  const topIds = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const userMap = new Map<number, string>();
  if (topIds.length > 0) {
    const users = await db.select().from(usersTable).where(inArray(usersTable.id, topIds.map(([id]) => id)));
    for (const u of users) userMap.set(u.id, userDisplayName(u));
  }

  const lines = [
    `🧾 <b>周报</b> — ${weekStart.toLocaleDateString("zh-CN")} ~ ${addDays(weekEnd, -1).toLocaleDateString("zh-CN")}`,
    "",
    `📁 活跃项目：<b>${projects.length}</b> 个`,
    `✅ 本周完成：<b>${doneThisWeek.length}</b> 条${deltaStr(doneThisWeek.length, doneLastWeek.length, " 条")}`,
    `🚨 当前超期：<b>${overdueAll.length}</b> 条`,
  ];
  if (topIds.length > 0) {
    lines.push("\n<b>🏆 本周完成榜：</b>");
    for (let i = 0; i < topIds.length; i++) {
      const [id, n] = topIds[i];
      lines.push(`  ${["🥇", "🥈", "🥉", " 4.", " 5."][i]} ${userMap.get(id) ?? `#${id}`} · ${n} 条`);
    }
  }
  if (doneThisWeek.length > 0) {
    lines.push("\n<b>📊 本周亮点：</b>");
    for (const t of doneThisWeek.slice(0, 5)) {
      lines.push(`  ✅ #${t.id} ${shortTitle(t.title, 28)}`);
    }
  }
  if (overdueAll.length > 0) {
    lines.push("\n<b>⚠️ 需关注：</b>");
    for (const t of overdueAll.slice(0, 3)) {
      lines.push(`  🚨 #${t.id} ${shortTitle(t.title, 28)} · 截 ${formatDate(t.dueDate)}`);
    }
  }

  const text = lines.join("\n");
  const kb: { text: string; callback_data: string }[][] = [];
  if (canExecuteAction(role, "BI:PUSH")) {
    kb.push([{ text: "📢 推送看板", callback_data: "BI:PUSH" }]);
  }
  kb.push(BACK_ROW);
  await editOrSend(ctx, text, kb);
}

// ===========================================================================
// 📢 推送
// ===========================================================================
export async function showPushMenu(ctx: Context): Promise<void> {
  const lines = [
    `📢 <b>推送看板</b>`,
    "",
    `选择推送目标：`,
    `· 频道：${CHANNEL_ID ? "✅ 已配置" : "⚠️ 未配置 TELEGRAM_CHANNEL_ID"}`,
    `· 群组：${GROUP_ID ? "✅ 已配置" : "⚠️ 未配置 TELEGRAM_GROUP_ID"}`,
  ];
  const kb = [
    [
      { text: CHANNEL_ID ? "📡 推送到频道" : "📡 频道（未配置）", callback_data: "BI:PUSH:CH" },
      { text: GROUP_ID ? "👥 推送到群组" : "👥 群组（未配置）", callback_data: "BI:PUSH:GR" },
    ],
    BACK_ROW,
  ];
  await editOrSend(ctx, lines.join("\n"), kb);
}

async function buildDashboardText(): Promise<string> {
  const now = new Date();
  const todayStart = startOfDay(now);
  const targetStart = startOfMonth(now);
  const targetEnd = endOfMonth(now);

  const allTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));
  const todoDoing = allTasks.filter((t) => t.status === "TODO" || t.status === "DOING").length;
  const doneToday = allTasks.filter((t) => t.status === "DONE" && t.updatedAt >= todayStart).length;
  const overdue = allTasks.filter((t) => t.dueDate && t.dueDate < now && t.status !== "DONE").length;

  const activeProjects = await db.select().from(projectsTable).where(and(eq(projectsTable.status, "ACTIVE"), eq(projectsTable.isArchived, 0), notDeleted(projectsTable)));
  const pendingReqs = await db.select().from(requirementsTable).where(and(eq(requirementsTable.status, "PENDING"), eq(requirementsTable.isArchived, 0), notDeleted(requirementsTable)));
  const openRisks = await db.select().from(risksTable).where(eq(risksTable.status, "OPEN"));

  const finRows = await db.select().from(financeRecordsTable).where(and(gte(financeRecordsTable.occurDate, targetStart), lte(financeRecordsTable.occurDate, targetEnd), eq(financeRecordsTable.isArchived, 0), eq(financeRecordsTable.status, "PASSED"), notDeleted(financeRecordsTable)));
  const income = finRows.filter((r) => r.type === "INCOME").reduce((s, r) => s + Number(r.amount), 0);
  const expense = finRows.filter((r) => r.type === "EXPENSE").reduce((s, r) => s + Number(r.amount), 0);
  const reimb = finRows.filter((r) => r.type === "REIMB").reduce((s, r) => s + Number(r.amount), 0);

  return `📊 <b>团队数据看板</b> — ${now.toLocaleDateString("zh-CN")}

📁 活跃项目：<b>${activeProjects.length}</b> 个
✅ 进行中任务：<b>${todoDoing}</b> 条
🎉 今日完成：<b>${doneToday}</b> 条
🚨 超期任务：<b>${overdue}</b> 条
📥 待评审需求：<b>${pendingReqs.length}</b> 条
⚠️ 开放风险：<b>${openRisks.length}</b> 个

💰 <b>${now.getMonth() + 1} 月资金</b>
➕ 收入 ${fmtMoney(income)} CNY
➖ 支出 ${fmtMoney(expense)} CNY
🧾 报销 ${fmtMoney(reimb)} CNY
净额 <b>${fmtMoney(income - expense - reimb)}</b> CNY`;
}

export async function pushDashboardToChannel(ctx: Context): Promise<void> {
  // No env pre-check: routing core consults groups table first, falls back to
  // env CHANNEL_ID, and returns noTargets only when BOTH paths are empty.
  // This lets a deployment with a registered group (defaultReportChannelId set)
  // push BI even if env CHANNEL_ID is unset.
  await ctx.answerCbQuery("📡 推送中…");
  const text = await buildDashboardText();
  // Pre-fetch operator BEFORE dispatch so dispatch-level audit (BROADCAST_*)
  // captures the actor — these are operator-driven broadcasts, not system events.
  const me = await getUserByTelegramId(String(ctx.from?.id ?? ""));
  const r = await dispatchBroadcast(ctx.telegram, "DASHBOARD_PUSH_CHANNEL", { actorId: me?.id ?? null }, text);
  if (r.resolution.noTargets) {
    if (me) await writeAudit(me.id, "BI_PUSH_CHANNEL_NO_TARGET", "channel", null, "no_target", "MEDIUM");
    await editOrSend(ctx, "⚠️ 未配置任何报告频道（请在 groups 表设置 defaultReportChannelId 或配置 TELEGRAM_CHANNEL_ID）", [BACK_ROW]);
    return;
  }
  if (me) await writeAudit(me.id, r.ok ? "BI_PUSH_CHANNEL" : "BI_PUSH_CHANNEL_FAIL", "channel", null, r.ok ? "ok" : "fail");
  await editOrSend(ctx, r.ok ? "✅ 已推送到频道\n\n" + text : "❌ 推送失败：请确认机器人已加入频道并具有发布权限", [BACK_ROW]);
}

export async function pushDashboardToGroup(ctx: Context): Promise<void> {
  await ctx.answerCbQuery("📡 推送中…");
  const text = await buildDashboardText();
  const me = await getUserByTelegramId(String(ctx.from?.id ?? ""));
  const r = await dispatchBroadcast(ctx.telegram, "DASHBOARD_PUSH_GROUP", { actorId: me?.id ?? null }, text);
  if (r.resolution.noTargets) {
    if (me) await writeAudit(me.id, "BI_PUSH_GROUP_NO_TARGET", "group", null, "no_target", "MEDIUM");
    await editOrSend(ctx, "⚠️ 未配置任何协作群（请在 groups 表注册或配置 TELEGRAM_GROUP_ID）", [BACK_ROW]);
    return;
  }
  if (me) await writeAudit(me.id, r.ok ? "BI_PUSH_GROUP" : "BI_PUSH_GROUP_FAIL", "group", null, r.ok ? "ok" : "fail");
  await editOrSend(ctx, r.ok ? "✅ 已推送到群组\n\n" + text : "❌ 推送失败：请确认机器人已加入群组", [BACK_ROW]);
}
