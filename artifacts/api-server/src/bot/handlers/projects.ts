import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { projectsTable, tasksTable, milestonesTable, risksTable, usersTable, notDeleted } from "@workspace/db";
import { eq, and, ne, desc, count } from "drizzle-orm";
import { editOrSend, buildKeyboard, shortTitle, statusLabel, formatDate, EMPTY_LIST_MSG, writeAudit } from "../helpers.js";
import { escapeHtml } from "../notify.js";
import { dispatchBroadcast } from "../dispatch.js";
import { resolveGroupIdForProject } from "../group-service.js";
import type { Role } from "../permissions.js";
import { canExecuteAction } from "../permissions.js";
import { userDisplayName, getUserByTelegramId } from "../user-service.js";
import { startFlow } from "../form-handler.js";

const PAGE_SIZE = 8;

const FILTER_LABELS: Record<string, string> = {
  ACTIVE: "🟢 进行中",
  COMPLETED: "✅ 已完成",
  ARCH: "🗄 已归档",
};

function projectStatusLabel(s: string): string {
  if (s === "ACTIVE") return "🟢 进行中";
  if (s === "RISK") return "⚠️ 风险中";
  if (s === "COMPLETED") return "✅ 已完成";
  return statusLabel(s);
}

function mileStatusLabel(s: string): string {
  if (s === "DONE") return "✅";
  if (s === "PENDING") return "⏳";
  return s;
}

function severityLabel(s: string): string {
  if (s === "HIGH") return "🔴 高";
  if (s === "MEDIUM") return "🟡 中";
  if (s === "LOW") return "🟢 低";
  return s;
}

export async function showProjectList(ctx: Context, role: Role, filter = "ACTIVE", offset = 0): Promise<void> {
  if (!["ACTIVE", "COMPLETED", "ARCH"].includes(filter)) filter = "ACTIVE";
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const conds = filter === "ARCH"
    ? [eq(projectsTable.isArchived, 1), notDeleted(projectsTable)]
    : filter === "COMPLETED"
      ? [eq(projectsTable.isArchived, 0), eq(projectsTable.status, "COMPLETED"), notDeleted(projectsTable)]
      : [eq(projectsTable.isArchived, 0), ne(projectsTable.status, "COMPLETED"), notDeleted(projectsTable)];

  const whereClause = and(...conds);
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(projectsTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(projectsTable)
    .where(whereClause)
    .orderBy(desc(projectsTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const tabRow = (["ACTIVE", "COMPLETED", "ARCH"] as const).map((f) => ({
    text: filter === f ? `« ${FILTER_LABELS[f]} »` : FILTER_LABELS[f],
    callback_data: `PROJ:LIST:${f}:0`,
  }));

  const itemButtons = slice.map((p) => ({
    text: `📁 ${shortTitle(p.name, 18)} ${projectStatusLabel(p.status)}`,
    callback_data: `PROJ:OPEN:${p.id}`,
  }));

  const navButtons: { text: string; callback_data: string }[] = [];
  if (offset > 0) navButtons.push({ text: "⬅️ 上一页", callback_data: `PROJ:LIST:${filter}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navButtons.push({ text: "下一页 ➡️", callback_data: `PROJ:LIST:${filter}:${offset + PAGE_SIZE}` });

  const rows: { text: string; callback_data: string }[][] = [tabRow];
  for (const b of itemButtons) rows.push([b]);
  if (navButtons.length > 0) rows.push(navButtons);
  if (canExecuteAction(role, "PROJ:NEW")) rows.push([{ text: "➕ 新建项目", callback_data: "PROJ:NEW" }]);
  rows.push([{ text: "🔙 返回", callback_data: "M:PROJ" }]);

  const headerLine = total === 0
    ? EMPTY_LIST_MSG
    : `共 ${total} 个 · 第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`;
  const text = `📋 <b>项目列表</b> · ${FILTER_LABELS[filter]}\n\n${headerLine}`;

  await editOrSend(ctx, text, rows);
}

export async function showProjectCard(ctx: Context, projectId: number, role: Role): Promise<void> {
  const rows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (rows.length === 0) {
    await editOrSend(ctx, "❌ 项目不存在或已删除", [[{ text: "🔙 返回项目列表", callback_data: "PROJ:LIST:ACTIVE:0" }]]);
    return;
  }
  const proj = rows[0];

  const [taskCountRow] = await db.select({ n: count() }).from(tasksTable).where(and(eq(tasksTable.projectId, projectId), notDeleted(tasksTable)));
  const [doneCountRow] = await db.select({ n: count() }).from(tasksTable).where(and(eq(tasksTable.projectId, projectId), eq(tasksTable.status, "DONE"), notDeleted(tasksTable)));
  const [overdueCountRow] = await db
    .select({ n: count() })
    .from(tasksTable)
    .where(and(eq(tasksTable.projectId, projectId), eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));
  const allTasks = await db.select().from(tasksTable).where(and(eq(tasksTable.projectId, projectId), eq(tasksTable.isArchived, 0), notDeleted(tasksTable)));
  const overdueTasks = allTasks.filter((t) => t.dueDate && t.dueDate < new Date() && t.status !== "DONE").length;

  const [mileTotalRow] = await db.select({ n: count() }).from(milestonesTable).where(eq(milestonesTable.projectId, projectId));
  const [mileDoneRow] = await db.select({ n: count() }).from(milestonesTable).where(and(eq(milestonesTable.projectId, projectId), eq(milestonesTable.status, "DONE")));

  const [riskOpenRow] = await db.select({ n: count() }).from(risksTable).where(and(eq(risksTable.projectId, projectId), eq(risksTable.status, "OPEN")));

  let ownerName = "—";
  const ownerRows = await db.select().from(usersTable).where(eq(usersTable.id, proj.ownerId));
  if (ownerRows.length > 0) ownerName = userDisplayName(ownerRows[0]);

  const archivedTag = proj.isArchived === 1 ? " 🗄 已归档" : "";
  const text = `📁 <b>项目 #${proj.id}</b>${archivedTag}

📌 <b>名称：</b>${escapeHtml(proj.name)}
📄 <b>描述：</b>${proj.description ? escapeHtml(proj.description) : "—"}
👤 <b>负责人：</b>${escapeHtml(ownerName)}
📊 <b>状态：</b>${projectStatusLabel(proj.status)}

✅ <b>任务进度：</b>${doneCountRow?.n ?? 0}/${taskCountRow?.n ?? 0} 已完成${overdueTasks > 0 ? `（🚨 ${overdueTasks} 超期）` : ""}
🎯 <b>里程碑：</b>${mileDoneRow?.n ?? 0}/${mileTotalRow?.n ?? 0} 已达成
⚠️ <b>未关闭风险：</b>${riskOpenRow?.n ?? 0}

📡 <b>绑定群：</b>${proj.groupId ? `#${proj.groupId}` : "（未绑定）"}

📅 创建：${formatDate(proj.createdAt)} · 更新：${formatDate(proj.updatedAt)}`;

  const actions: { text: string; callback_data: string }[] = [];

  // Status workflow actions
  if (proj.isArchived === 0 && canExecuteAction(role, "PROJ:STATUS")) {
    if (proj.status === "ACTIVE") {
      actions.push({ text: "⚠️ 标记风险", callback_data: `PROJ:STATUS:${proj.id}:RISK` });
      actions.push({ text: "✅ 完结", callback_data: `PROJ:STATUS:${proj.id}:COMPLETED` });
    } else if (proj.status === "RISK") {
      actions.push({ text: "🟢 恢复进行中", callback_data: `PROJ:STATUS:${proj.id}:ACTIVE` });
      actions.push({ text: "✅ 完结", callback_data: `PROJ:STATUS:${proj.id}:COMPLETED` });
    } else if (proj.status === "COMPLETED") {
      actions.push({ text: "↩️ 重新开启", callback_data: `PROJ:STATUS:${proj.id}:ACTIVE` });
    }
  }

  // View actions (everyone)
  actions.push({ text: "✅ 任务", callback_data: `PROJ:TASKS:${proj.id}` });
  actions.push({ text: "🎯 里程碑", callback_data: `PROJ:MILE:${proj.id}` });
  actions.push({ text: "⚠️ 风险", callback_data: `PROJ:RISKS:${proj.id}` });

  // Archive / Unarchive
  if (canExecuteAction(role, "PROJ:ARCH")) {
    if (proj.isArchived === 1) {
      actions.push({ text: "♻️ 取消归档", callback_data: `PROJ:UNARCH:${proj.id}` });
    } else {
      actions.push({ text: "🗄 归档", callback_data: `PROJ:ARCH:${proj.id}` });
    }
  }
  if (canExecuteAction(role, "PROJ:CHGROUP")) {
    actions.push({ text: "📡 绑定群", callback_data: `PROJ:CHGROUP:${proj.id}:0` });
  }
  if (canExecuteAction(role, "PROJ:DEL")) {
    actions.push({ text: "🗑 删除", callback_data: `PROJ:DEL:${proj.id}` });
  }

  const backFilter = proj.isArchived === 1 ? "ARCH" : (proj.status === "COMPLETED" ? "COMPLETED" : "ACTIVE");
  const keyboard = buildKeyboard(actions, 2, [{ text: "🔙 返回项目列表", callback_data: `PROJ:LIST:${backFilter}:0` }]);
  await editOrSend(ctx, text, keyboard);
}

export async function showProjectTasks(ctx: Context, projectId: number, role: Role): Promise<void> {
  const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (projRows.length === 0) {
    await editOrSend(ctx, "❌ 项目不存在", [[{ text: "🔙 返回", callback_data: "PROJ:LIST:ACTIVE:0" }]]);
    return;
  }
  const proj = projRows[0];

  const tasks = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.projectId, projectId), eq(tasksTable.isArchived, 0), notDeleted(tasksTable)))
    .orderBy(desc(tasksTable.createdAt));

  if (tasks.length === 0) {
    await editOrSend(ctx, `✅ <b>${proj.name}</b> · 任务\n\n${EMPTY_LIST_MSG}`, [
      [{ text: "🔙 返回项目", callback_data: `PROJ:OPEN:${projectId}` }],
    ]);
    return;
  }

  const buttons = tasks.slice(0, 12).map((t) => ({
    text: `${statusLabel(t.status)} #${t.id} ${shortTitle(t.title, 16)}`,
    callback_data: `TASK:OPEN:${t.id}`,
  }));

  const keyboard = buildKeyboard(buttons, 1, [{ text: "🔙 返回项目", callback_data: `PROJ:OPEN:${projectId}` }]);
  await editOrSend(ctx, `✅ <b>${proj.name}</b> · 任务（共 ${tasks.length} 条${tasks.length > 12 ? "，仅显示前 12" : ""}）`, keyboard);
}

export async function showProjectMilestones(ctx: Context, projectId: number, role: Role): Promise<void> {
  const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (projRows.length === 0) {
    await editOrSend(ctx, "❌ 项目不存在", [[{ text: "🔙 返回", callback_data: "PROJ:LIST:ACTIVE:0" }]]);
    return;
  }
  const proj = projRows[0];

  const miles = await db
    .select()
    .from(milestonesTable)
    .where(eq(milestonesTable.projectId, projectId))
    .orderBy(milestonesTable.dueDate);

  const lines = [`🎯 <b>${proj.name}</b> · 里程碑`];
  if (miles.length === 0) {
    lines.push("", EMPTY_LIST_MSG);
  } else {
    lines.push("");
    for (const m of miles) {
      lines.push(`${mileStatusLabel(m.status)} <b>#${m.id}</b> ${m.title} · 📅 ${formatDate(m.dueDate)}`);
    }
  }

  const buttons: { text: string; callback_data: string }[] = [];
  for (const m of miles.filter((mm) => mm.status !== "DONE").slice(0, 6)) {
    if (canExecuteAction(role, "PROJ:MILEDONE")) {
      buttons.push({ text: `✅ 标记 #${m.id} 达成`, callback_data: `PROJ:MILEDONE:${m.id}` });
    }
  }
  if (canExecuteAction(role, "PROJ:NEWMILE")) {
    buttons.push({ text: "➕ 新建里程碑", callback_data: `PROJ:NEWMILE:${projectId}` });
  }

  const keyboard = buildKeyboard(buttons, 1, [{ text: "🔙 返回项目", callback_data: `PROJ:OPEN:${projectId}` }]);
  await editOrSend(ctx, lines.join("\n"), keyboard);
}

export async function showProjectRisks(ctx: Context, projectId: number, role: Role): Promise<void> {
  const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (projRows.length === 0) {
    await editOrSend(ctx, "❌ 项目不存在", [[{ text: "🔙 返回", callback_data: "PROJ:LIST:ACTIVE:0" }]]);
    return;
  }
  const proj = projRows[0];

  const risks = await db
    .select()
    .from(risksTable)
    .where(eq(risksTable.projectId, projectId))
    .orderBy(desc(risksTable.createdAt));

  const lines = [`⚠️ <b>${proj.name}</b> · 风险登记`];
  if (risks.length === 0) {
    lines.push("", EMPTY_LIST_MSG);
  } else {
    lines.push("");
    for (const r of risks.slice(0, 12)) {
      const statusIcon = r.status === "OPEN" ? "🔴" : r.status === "MITIGATED" ? "🟡" : "✅";
      lines.push(`${statusIcon} <b>#${r.id}</b> ${shortTitle(r.title, 40)} · ${severityLabel(r.severity)}`);
    }
    if (risks.length > 12) lines.push(`\n…还有 ${risks.length - 12} 条`);
  }

  const buttons: { text: string; callback_data: string }[] = [];
  if (canExecuteAction(role, "PROJ:RISK")) {
    buttons.push({ text: "⚠️ 登记新风险", callback_data: `PROJ:RISK:${projectId}` });
  }
  const keyboard = buildKeyboard(buttons, 1, [{ text: "🔙 返回项目", callback_data: `PROJ:OPEN:${projectId}` }]);
  await editOrSend(ctx, lines.join("\n"), keyboard);
}

export async function handleProjectStatus(ctx: Context, projectId: number, newStatus: string, role: Role): Promise<void> {
  if (!canExecuteAction(role, "PROJ:STATUS")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  if (!["ACTIVE", "RISK", "COMPLETED"].includes(newStatus)) {
    await ctx.answerCbQuery("⚠️ 非法状态", { show_alert: true });
    return;
  }
  const rows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 项目不存在", { show_alert: true });
    return;
  }
  await db.update(projectsTable).set({ status: newStatus }).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));

  const telegramId = String(ctx.from?.id ?? "");
  const user = await getUserByTelegramId(telegramId);
  if (user) await writeAudit(user.id, `PROJECT_STATUS_${newStatus}`, "project", projectId, rows[0].name);

  await ctx.answerCbQuery(`📊 状态已更新：${projectStatusLabel(newStatus)}`);
  if (newStatus === "COMPLETED" || newStatus === "RISK") {
    const gid = await resolveGroupIdForProject(projectId);
    const evt = newStatus === "COMPLETED" ? "PROJECT_COMPLETE" : "PROJECT_RISK";
    const text = newStatus === "COMPLETED"
      ? `✅ <b>项目完结</b>\n\n📁 ${rows[0].name}\n#${projectId}`
      : `⚠️ <b>项目已标记风险</b>\n\n📁 ${rows[0].name}\n#${projectId}`;
    await dispatchBroadcast(
      ctx.telegram, evt,
      { projectId, groupId: gid, actorId: user?.id ?? null },
      text,
    );
  }
  await showProjectCard(ctx, projectId, role);
}

export async function handleProjectArchive(ctx: Context, projectId: number, archive: boolean, role: Role): Promise<void> {
  if (!canExecuteAction(role, "PROJ:ARCH")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 项目不存在", { show_alert: true });
    return;
  }
  await db.update(projectsTable).set({ isArchived: archive ? 1 : 0 }).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));

  const telegramId = String(ctx.from?.id ?? "");
  const user = await getUserByTelegramId(telegramId);
  if (user) await writeAudit(user.id, archive ? "PROJECT_ARCHIVE" : "PROJECT_UNARCHIVE", "project", projectId, rows[0].name);

  await ctx.answerCbQuery(archive ? "🗄 已归档" : "♻️ 已取消归档");
  await showProjectCard(ctx, projectId, role);
}

export async function handleProjectDelete(ctx: Context, projectId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "PROJ:DEL")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 项目不存在", { show_alert: true });
    return;
  }
  // B2.2 不级联子任务（任务保留在原 projectId 下，因 notDeleted(projectsTable) 守卫，下游 join 自然过滤）。
  await db.update(projectsTable).set({ deletedAt: new Date() }).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));

  const telegramId = String(ctx.from?.id ?? "");
  const user = await getUserByTelegramId(telegramId);
  if (user) await writeAudit(user.id, "PROJECT_DELETE", "project", projectId, rows[0].name, "MEDIUM");

  await ctx.answerCbQuery("🗑 已移入回收站");
  await showProjectList(ctx, role, "ACTIVE", 0);
}

export async function handleMilestoneDone(ctx: Context, milestoneId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "PROJ:MILEDONE")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(milestonesTable).where(eq(milestonesTable.id, milestoneId));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 里程碑不存在", { show_alert: true });
    return;
  }
  await db.update(milestonesTable).set({ status: "DONE" }).where(eq(milestonesTable.id, milestoneId));
  const telegramId = String(ctx.from?.id ?? "");
  const user = await getUserByTelegramId(telegramId);
  if (user) await writeAudit(user.id, "MILESTONE_DONE", "milestone", milestoneId, rows[0].title);
  await ctx.answerCbQuery("✅ 里程碑已达成");
  await showProjectMilestones(ctx, rows[0].projectId, role);
}

export async function startMilestoneFlow(ctx: Context, projectId: number, role: Role): Promise<void> {
  const rows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 项目不存在", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await startFlow(ctx, "PROJ:NEWMILE", role, { projectId });
}

export async function startProjectRiskFlow(ctx: Context, projectId: number | null, role: Role): Promise<void> {
  if (projectId !== null) {
    const rows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
    if (rows.length === 0) {
      await ctx.answerCbQuery("❌ 项目不存在", { show_alert: true });
      return;
    }
  }
  await ctx.answerCbQuery();
  await startFlow(ctx, "PROJ:RISK", role, projectId !== null ? { projectId } : undefined);
}

export async function showProjectReport(ctx: Context, role: Role): Promise<void> {
  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))
    .orderBy(desc(projectsTable.updatedAt));

  if (projects.length === 0) {
    await editOrSend(ctx, `📌 <b>项目周报</b>\n\n${EMPTY_LIST_MSG}`, [[{ text: "🔙 返回", callback_data: "M:PROJ" }]]);
    return;
  }

  // Batch all task queries to avoid N+1
  const projectIds = projects.map((p) => p.id);
  const allTasks = await db.select().from(tasksTable).where(notDeleted(tasksTable));
  const tasksByProj = new Map<number, typeof allTasks>();
  for (const id of projectIds) tasksByProj.set(id, []);
  for (const t of allTasks) {
    if (t.projectId && tasksByProj.has(t.projectId)) {
      tasksByProj.get(t.projectId)!.push(t);
    }
  }

  const allMiles = await db.select().from(milestonesTable);
  const milesByProj = new Map<number, typeof allMiles>();
  for (const id of projectIds) milesByProj.set(id, []);
  for (const m of allMiles) {
    if (milesByProj.has(m.projectId)) milesByProj.get(m.projectId)!.push(m);
  }

  const lines = ["📌 <b>项目周报汇总</b>\n"];
  const now = new Date();
  for (const proj of projects.slice(0, 15)) {
    const tasks = tasksByProj.get(proj.id) ?? [];
    const done = tasks.filter((t) => t.status === "DONE").length;
    const overdue = tasks.filter((t) => t.dueDate && t.dueDate < now && t.status !== "DONE").length;
    const miles = milesByProj.get(proj.id) ?? [];
    const mDone = miles.filter((m) => m.status === "DONE").length;
    lines.push(`📁 <b>${proj.name}</b> [${projectStatusLabel(proj.status)}]`);
    lines.push(`  ✅ 任务 ${done}/${tasks.length} | 🚨 超期 ${overdue} | 🎯 里程碑 ${mDone}/${miles.length}`);
  }
  if (projects.length > 15) lines.push(`\n…还有 ${projects.length - 15} 个项目`);

  await editOrSend(ctx, lines.join("\n"), [[{ text: "🔙 返回", callback_data: "M:PROJ" }]]);
}

export async function showMilestonesEntry(ctx: Context, role: Role): Promise<void> {
  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))
    .orderBy(desc(projectsTable.updatedAt));

  if (projects.length === 0) {
    await editOrSend(ctx, `🎯 <b>里程碑管理</b>\n\n暂无可管理的项目，先去新建一个吧。`, [
      canExecuteAction(role, "PROJ:NEW") ? [{ text: "➕ 新建项目", callback_data: "PROJ:NEW" }] : [],
      [{ text: "🔙 返回", callback_data: "M:PROJ" }],
    ].filter((r) => r.length > 0));
    return;
  }

  const buttons = projects.slice(0, 10).map((p) => ({
    text: `📁 ${shortTitle(p.name, 22)}`,
    callback_data: `PROJ:MILE:${p.id}`,
  }));
  const keyboard = buildKeyboard(buttons, 1, [{ text: "🔙 返回", callback_data: "M:PROJ" }]);
  await editOrSend(ctx, `🎯 <b>里程碑管理</b>\n\n请选择要管理里程碑的项目：`, keyboard);
}
