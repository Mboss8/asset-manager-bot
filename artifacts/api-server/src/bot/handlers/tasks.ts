import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { tasksTable, usersTable, projectsTable, notDeleted } from "@workspace/db";
import { eq, and, lte, lt, gte, isNull, or, ne, desc, count } from "drizzle-orm";
import {
  editOrSend, buildKeyboard, shortTitle, formatDate, priorityLabel, statusLabel,
  EMPTY_LIST_MSG, writeAudit,
} from "../helpers.js";
import { escapeHtml, userMention, notifyUserById } from "../notify.js";
import type { Role } from "../permissions.js";
import { canExecuteAction } from "../permissions.js";
import { getUserByTelegramId, userDisplayName, getAllUsers } from "../user-service.js";
import { startFlow } from "../form-handler.js";
import { dispatchBroadcast } from "../dispatch.js";
import { resolveGroupIdForProject } from "../group-service.js";

const PAGE_SIZE = 8;

const MY_FILTER_LABELS: Record<string, string> = {
  ALL: "📋 全部",
  TODO: "📌 待办",
  DOING: "▶️ 进行中",
  DONE: "✅ 已完成",
};

async function getUser(telegramId: string) {
  return getUserByTelegramId(telegramId);
}

function paginationButtons(prefix: string, offset: number, total: number): { text: string; callback_data: string }[] {
  const buttons: { text: string; callback_data: string }[] = [];
  if (offset > 0) buttons.push({ text: "⬅️ 上一页", callback_data: `${prefix}${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) buttons.push({ text: "下一页 ➡️", callback_data: `${prefix}${offset + PAGE_SIZE}` });
  return buttons;
}

function pageHeader(total: number, offset: number): string {
  if (total === 0) return EMPTY_LIST_MSG;
  return `共 ${total} 条 · 第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`;
}

export async function startTaskFlow(ctx: Context, role: Role): Promise<void> {
  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))
    .orderBy(desc(projectsTable.updatedAt));
  const users = await getAllUsers();

  const projectOptions = [
    { text: "（不归属）", value: "NONE" },
    ...projects.slice(0, 12).map((p) => ({ text: `📁 ${shortTitle(p.name, 20)}`, value: String(p.id) })),
  ];
  const userOptions = [
    { text: "（暂不指派）", value: "NONE" },
    ...users.filter((u) => u.isBlacklisted !== 1).slice(0, 16).map((u) => ({ text: `👤 ${shortTitle(userDisplayName(u), 20)}`, value: String(u.id) })),
  ];

  await ctx.answerCbQuery();
  await startFlow(ctx, "TASK:NEW", role, undefined, {
    project_id: projectOptions,
    assignee_id: userOptions,
  });
}

export async function showMyTasks(ctx: Context, role: Role, telegramId: string, filter = "ALL", offset = 0): Promise<void> {
  if (!["ALL", "TODO", "DOING", "DONE"].includes(filter)) filter = "ALL";
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const user = await getUser(telegramId);
  if (!user) return;

  const conds = [eq(tasksTable.assigneeId, user.id), eq(tasksTable.isArchived, 0), notDeleted(tasksTable)];
  if (filter !== "ALL") conds.push(eq(tasksTable.status, filter));

  const whereClause = and(...conds);
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(tasksTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(tasksTable)
    .where(whereClause)
    .orderBy(desc(tasksTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const tabRow = (["ALL", "TODO", "DOING", "DONE"] as const).map((f) => ({
    text: filter === f ? `« ${MY_FILTER_LABELS[f]} »` : MY_FILTER_LABELS[f],
    callback_data: `TASK:MY:${f}:0`,
  }));

  const itemButtons = slice.map((t) => ({
    text: `${statusLabel(t.status)} #${t.id} ${shortTitle(t.title, 18)}`,
    callback_data: `TASK:OPEN:${t.id}`,
  }));

  const navRow = paginationButtons(`TASK:MY:${filter}:`, offset, total);

  const rows: { text: string; callback_data: string }[][] = [tabRow];
  for (const b of itemButtons) rows.push([b]);
  if (navRow.length > 0) rows.push(navRow);
  rows.push([{ text: "🔙 返回", callback_data: "M:TASK" }]);

  await editOrSend(ctx, `👤 <b>我的任务</b> · ${MY_FILTER_LABELS[filter]}\n\n${pageHeader(total, offset)}`, rows);
}

export async function showTodayTasks(ctx: Context, role: Role, telegramId: string): Promise<void> {
  const user = await getUser(telegramId);
  if (!user) return;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const tasks = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.assigneeId, user.id),
        eq(tasksTable.isArchived, 0),
        gte(tasksTable.dueDate, todayStart),
        lt(tasksTable.dueDate, tomorrowStart),
        notDeleted(tasksTable),
      ),
    );

  if (tasks.length === 0) {
    await editOrSend(ctx, `📌 <b>今日待办</b>\n\n${EMPTY_LIST_MSG}`, [
      [{ text: "🔙 返回", callback_data: "M:TASK" }],
    ]);
    return;
  }

  const buttons = tasks.map((t) => ({
    text: `${priorityLabel(t.priority)} #${t.id} ${shortTitle(t.title)}`,
    callback_data: `TASK:OPEN:${t.id}`,
  }));

  await editOrSend(ctx, `📌 <b>今日待办</b>（共 ${tasks.length} 条）`, buildKeyboard(buttons, 1, [{ text: "🔙 返回", callback_data: "M:TASK" }]));
}

export async function showDueSoonTasks(ctx: Context, role: Role, telegramId: string): Promise<void> {
  const user = await getUser(telegramId);
  if (!user) return;

  const now = new Date();
  const threeDays = new Date();
  threeDays.setDate(threeDays.getDate() + 3);

  const tasks = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.assigneeId, user.id),
        eq(tasksTable.isArchived, 0),
        gte(tasksTable.dueDate, now),
        lte(tasksTable.dueDate, threeDays),
        notDeleted(tasksTable),
      ),
    );

  if (tasks.length === 0) {
    await editOrSend(ctx, `⏳ <b>即将到期</b>\n\n${EMPTY_LIST_MSG}`, [
      [{ text: "🔙 返回", callback_data: "M:TASK" }],
    ]);
    return;
  }

  const buttons = tasks.map((t) => ({
    text: `⏳ #${t.id} ${shortTitle(t.title)} (${formatDate(t.dueDate)})`,
    callback_data: `TASK:OPEN:${t.id}`,
  }));

  await editOrSend(ctx, `⏳ <b>即将到期</b>（3天内，共 ${tasks.length} 条）`, buildKeyboard(buttons, 1, [{ text: "🔙 返回", callback_data: "M:TASK" }]));
}

export async function showOverdueTasks(ctx: Context, role: Role, offset = 0): Promise<void> {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const now = new Date();

  const whereClause = and(
    eq(tasksTable.isArchived, 0),
    lt(tasksTable.dueDate, now),
    ne(tasksTable.status, "DONE"),
    notDeleted(tasksTable),
  );
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(tasksTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(tasksTable)
    .where(whereClause)
    .orderBy(tasksTable.dueDate)
    .limit(PAGE_SIZE)
    .offset(offset);

  const itemButtons = slice.map((t) => ({
    text: `🚨 #${t.id} ${shortTitle(t.title)} (${formatDate(t.dueDate)})`,
    callback_data: `TASK:OPEN:${t.id}`,
  }));

  const navRow = paginationButtons("TASK:OVERDUE:", offset, total);
  const rows: { text: string; callback_data: string }[][] = [];
  for (const b of itemButtons) rows.push([b]);
  if (navRow.length > 0) rows.push(navRow);
  rows.push([{ text: "🔙 返回", callback_data: "M:TASK" }]);

  await editOrSend(ctx, `🚨 <b>超期任务</b>\n\n${pageHeader(total, offset)}`, rows);
}

export async function showArchivedTasks(ctx: Context, offset = 0): Promise<void> {
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const whereClause = and(eq(tasksTable.isArchived, 1), notDeleted(tasksTable));
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(tasksTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(tasksTable)
    .where(whereClause)
    .orderBy(desc(tasksTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const itemButtons = slice.map((t) => ({
    text: `🗄 #${t.id} ${shortTitle(t.title)}`,
    callback_data: `TASK:OPEN:${t.id}`,
  }));

  const navRow = paginationButtons("TASK:ARCH:", offset, total);
  const rows: { text: string; callback_data: string }[][] = [];
  for (const b of itemButtons) rows.push([b]);
  if (navRow.length > 0) rows.push(navRow);
  rows.push([{ text: "🔙 返回", callback_data: "M:TASK" }]);

  await editOrSend(ctx, `📂 <b>已归档任务</b>\n\n${pageHeader(total, offset)}`, rows);
}

export async function showTaskCard(ctx: Context, taskId: number, role: Role): Promise<void> {
  const rows = await db.select().from(tasksTable).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
  if (rows.length === 0) {
    await editOrSend(ctx, "❌ 任务不存在或已删除", [[{ text: "🔙 返回任务中心", callback_data: "M:TASK" }]]);
    return;
  }
  const task = rows[0];

  let assigneeName = "—";
  if (task.assigneeId) {
    const assigneeRows = await db.select().from(usersTable).where(eq(usersTable.id, task.assigneeId));
    if (assigneeRows.length > 0) assigneeName = userDisplayName(assigneeRows[0]);
  }

  let projectName = "—";
  if (task.projectId) {
    const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, task.projectId), notDeleted(projectsTable)));
    if (projRows.length > 0) projectName = projRows[0].name;
  }

  const overdueTag = task.dueDate && task.dueDate < new Date() && task.status !== "DONE" ? " 🚨 已超期" : "";
  const archivedTag = task.isArchived === 1 ? " 🗄 已归档" : "";

  const text = `✅ <b>任务 #${task.id}</b>${overdueTag}${archivedTag}

📌 <b>标题：</b>${task.title}
📄 <b>描述：</b>${task.description ?? "—"}
👤 <b>负责人：</b>${assigneeName}
📁 <b>项目：</b>${projectName}
🎯 <b>优先级：</b>${priorityLabel(task.priority)}
📊 <b>状态：</b>${statusLabel(task.status)}
📈 <b>进度：</b>${task.progress}%
📅 <b>截止：</b>${formatDate(task.dueDate)}`;

  const actionButtons: { text: string; callback_data: string }[] = [];

  if (task.isArchived === 0) {
    if (task.status === "TODO" && canExecuteAction(role, "TASK:START")) {
      actionButtons.push({ text: "▶️ 开始", callback_data: `TASK:START:${taskId}` });
    }
    if (task.status === "PAUSED" && canExecuteAction(role, "TASK:RESUME")) {
      actionButtons.push({ text: "▶️ 继续", callback_data: `TASK:RESUME:${taskId}` });
    }
    if (task.status === "DOING" || task.status === "PAUSED") {
      if (canExecuteAction(role, "TASK:PROG")) actionButtons.push({ text: "📈 进度", callback_data: `TASK:PROG:${taskId}` });
    }
    if (task.status === "DOING" && canExecuteAction(role, "TASK:PAUSE")) {
      actionButtons.push({ text: "⏸ 暂停", callback_data: `TASK:PAUSE:${taskId}` });
    }
    if (canExecuteAction(role, "TASK:DONE") && task.status !== "DONE") {
      actionButtons.push({ text: "✅ 完成", callback_data: `TASK:DONE:${taskId}` });
    }
    if (canExecuteAction(role, "TASK:TRANSFER")) {
      actionButtons.push({ text: "🔄 转交", callback_data: `TASK:TRANSFER:${taskId}:0` });
    }
    if (canExecuteAction(role, "TASK:CHPROJ")) {
      actionButtons.push({ text: "📁 改归属", callback_data: `TASK:CHPROJ:${taskId}:0` });
    }
    if (canExecuteAction(role, "TASK:DELAY") && task.status !== "DONE") {
      actionButtons.push({ text: "⏳ 延期", callback_data: `TASK:DELAY:${taskId}` });
    }
    if (canExecuteAction(role, "TASK:ARCH")) {
      actionButtons.push({ text: "🗄 归档", callback_data: `TASK:ARCH:${taskId}` });
    }
    if (canExecuteAction(role, "TASK:DEL")) {
      actionButtons.push({ text: "🗑 删除", callback_data: `TASK:DEL:${taskId}` });
    }
  }

  const keyboard = buildKeyboard(actionButtons, 3, [{ text: "🔙 返回任务中心", callback_data: "M:TASK" }]);
  await editOrSend(ctx, text, keyboard);
}

export async function showProgressMenu(ctx: Context, taskId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "TASK:PROG")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(tasksTable).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 任务不存在", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  const buttons = [25, 50, 75, 100].map((p) => ({
    text: `${p === 100 ? "✅" : "📈"} ${p}%`,
    callback_data: `TASK:SETPROG:${taskId}:${p}`,
  }));
  await editOrSend(ctx, `📈 <b>更新任务 #${taskId} 进度</b>\n\n当前：${rows[0].progress}%\n请选择新进度：`, buildKeyboard(buttons, 2, [{ text: "🔙 返回任务", callback_data: `TASK:OPEN:${taskId}` }]));
}

export async function showDelayMenu(ctx: Context, taskId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "TASK:DELAY")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(tasksTable).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 任务不存在", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  const buttons = [
    { text: "+1 天", callback_data: `TASK:SETDELAY:${taskId}:1` },
    { text: "+3 天", callback_data: `TASK:SETDELAY:${taskId}:3` },
    { text: "+7 天", callback_data: `TASK:SETDELAY:${taskId}:7` },
    { text: "+14 天", callback_data: `TASK:SETDELAY:${taskId}:14` },
  ];
  await editOrSend(ctx, `⏳ <b>延期任务 #${taskId}</b>\n\n当前截止：${formatDate(rows[0].dueDate)}\n请选择延期天数：`, buildKeyboard(buttons, 2, [{ text: "🔙 返回任务", callback_data: `TASK:OPEN:${taskId}` }]));
}

export async function showAssigneePicker(ctx: Context, taskId: number, offset: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "TASK:TRANSFER")) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const allUsers = (await getAllUsers()).filter((u) => u.isBlacklisted !== 1);
  const total = allUsers.length;
  const slice = allUsers.slice(offset, offset + PAGE_SIZE);

  const itemButtons = slice.map((u) => ({
    text: `👤 ${shortTitle(userDisplayName(u), 22)}`,
    callback_data: `TASK:CHASSIGN:${taskId}:${u.id}`,
  }));

  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️", callback_data: `TASK:TRANSFER:${taskId}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "➡️", callback_data: `TASK:TRANSFER:${taskId}:${offset + PAGE_SIZE}` });

  const rows: { text: string; callback_data: string }[][] = [];
  for (const b of itemButtons) rows.push([b]);
  if (navRow.length > 0) rows.push(navRow);
  rows.push([{ text: "🚫 取消指派", callback_data: `TASK:UNASSIGN:${taskId}` }]);
  rows.push([{ text: "🔙 返回任务", callback_data: `TASK:OPEN:${taskId}` }]);

  await ctx.answerCbQuery();
  await editOrSend(ctx, `🔄 <b>转交任务 #${taskId}</b>\n\n${pageHeader(total, offset)}\n请选择新负责人：`, rows);
}

export async function showProjectPicker(ctx: Context, taskId: number, offset: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "TASK:CHPROJ")) {
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

  const itemButtons = slice.map((p) => ({
    text: `📁 ${shortTitle(p.name, 22)}`,
    callback_data: `TASK:SETPROJ:${taskId}:${p.id}`,
  }));

  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️", callback_data: `TASK:CHPROJ:${taskId}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "➡️", callback_data: `TASK:CHPROJ:${taskId}:${offset + PAGE_SIZE}` });

  const rows: { text: string; callback_data: string }[][] = [];
  for (const b of itemButtons) rows.push([b]);
  if (navRow.length > 0) rows.push(navRow);
  rows.push([{ text: "🚫 解除归属", callback_data: `TASK:UNLINK:${taskId}` }]);
  rows.push([{ text: "🔙 返回任务", callback_data: `TASK:OPEN:${taskId}` }]);

  await ctx.answerCbQuery();
  await editOrSend(ctx, `📁 <b>更改任务 #${taskId} 归属项目</b>\n\n${pageHeader(total, offset)}\n请选择项目：`, rows);
}

async function loadTaskOrError(ctx: Context, taskId: number) {
  const rows = await db.select().from(tasksTable).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 任务不存在", { show_alert: true });
    return null;
  }
  return rows[0];
}

export async function handleTaskAction(ctx: Context, action: string, taskId: number, role: Role, extra?: string): Promise<void> {
  if (!canExecuteAction(role, `TASK:${action}`)) {
    await ctx.answerCbQuery("⛔ 你没有权限执行该操作", { show_alert: true });
    return;
  }

  const task = await loadTaskOrError(ctx, taskId);
  if (!task) return;

  const telegramId = String(ctx.from?.id ?? "");
  const actor = await getUserByTelegramId(telegramId);
  const actorName = actor ? (actor.username ?? actor.firstName ?? actor.telegramId) : "—";

  switch (action) {
    case "START":
      await db.update(tasksTable).set({ status: "DOING" }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery("▶️ 任务已开始");
      if (actor) await writeAudit(actor.id, "TASK_START", "task", taskId, task.title);
      break;
    case "RESUME":
      await db.update(tasksTable).set({ status: "DOING" }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery("▶️ 任务已继续");
      if (actor) await writeAudit(actor.id, "TASK_RESUME", "task", taskId, task.title);
      break;
    case "PAUSE":
      await db.update(tasksTable).set({ status: "PAUSED" }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery("⏸ 任务已暂停");
      if (actor) await writeAudit(actor.id, "TASK_PAUSE", "task", taskId, task.title);
      break;
    case "DONE": {
      await db.update(tasksTable).set({ status: "DONE", progress: 100 }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery("✅ 任务已完成");
      if (actor) await writeAudit(actor.id, "TASK_DONE", "task", taskId, task.title);
      const safeT = escapeHtml(task.title);
      const actorMention = actor ? userMention(actor) : escapeHtml(actorName);
      {
        const gid = await resolveGroupIdForProject(task.projectId);
        await dispatchBroadcast(
          ctx.telegram, "TASK_DONE",
          { projectId: task.projectId, groupId: gid, actorId: actor?.id ?? null },
          `✅ <b>任务完成</b>\n\n📌 ${safeT}\n👤 完成人：${actorMention}\n#${taskId}`,
        );
      }
      // DM the creator (if different from completer)
      if (actor && task.creatorId !== actor.id) {
        await notifyUserById(
          ctx.telegram,
          task.creatorId,
          `✅ <b>你创建的任务已完成</b>\n\n#${taskId} ${safeT}\n👤 完成人：${actorMention}`,
          [[{ text: "🔍 查看", callback_data: `TASK:OPEN:${taskId}` }]],
        );
      }
      break;
    }
    case "ARCH":
      await db.update(tasksTable).set({ isArchived: 1 }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery("🗄 任务已归档");
      if (actor) await writeAudit(actor.id, "TASK_ARCHIVE", "task", taskId, task.title);
      break;
    case "DEL":
      await db.update(tasksTable).set({ deletedAt: new Date() }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery("🗑 已移入回收站");
      if (actor) await writeAudit(actor.id, "TASK_DELETE", "task", taskId, task.title, "MEDIUM");
      await showMyTasks(ctx, role, telegramId, "ALL", 0);
      return;
    case "SETDELAY": {
      const days = parseInt(extra ?? "0", 10);
      if (isNaN(days) || days <= 0 || days > 365) {
        await ctx.answerCbQuery("⚠️ 非法延期天数", { show_alert: true });
        return;
      }
      const newDue = new Date(task.dueDate ?? new Date());
      newDue.setDate(newDue.getDate() + days);
      await db.update(tasksTable).set({ dueDate: newDue }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery(`⏳ 延期至 ${formatDate(newDue)}`);
      if (actor) await writeAudit(actor.id, "TASK_DELAY", "task", taskId, `+${days}天 → ${formatDate(newDue)}`);
      break;
    }
    case "SETPROG": {
      const p = parseInt(extra ?? "0", 10);
      if (isNaN(p) || p < 0 || p > 100) {
        await ctx.answerCbQuery("⚠️ 非法进度", { show_alert: true });
        return;
      }
      const update: { progress: number; status?: string } = { progress: p };
      if (p === 100 && task.status !== "DONE") update.status = "DONE";
      await db.update(tasksTable).set(update).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery(`📈 进度更新至 ${p}%`);
      if (actor) await writeAudit(actor.id, "TASK_PROGRESS", "task", taskId, `${task.progress}% → ${p}%`);
      if (p === 100) {
        const safeT2 = escapeHtml(task.title);
        const actorMention2 = actor ? userMention(actor) : escapeHtml(actorName);
        {
          const gid = await resolveGroupIdForProject(task.projectId);
          await dispatchBroadcast(
            ctx.telegram, "TASK_DONE",
            { projectId: task.projectId, groupId: gid, actorId: actor?.id ?? null },
            `✅ <b>任务完成</b>\n\n📌 ${safeT2}\n👤 完成人：${actorMention2}\n#${taskId}`,
          );
        }
        if (actor && task.creatorId !== actor.id) {
          await notifyUserById(
            ctx.telegram,
            task.creatorId,
            `✅ <b>你创建的任务已完成</b>\n\n#${taskId} ${safeT2}\n👤 完成人：${actorMention2}`,
            [[{ text: "🔍 查看", callback_data: `TASK:OPEN:${taskId}` }]],
          );
        }
      }
      break;
    }
    case "CHASSIGN": {
      const userId = parseInt(extra ?? "0", 10);
      if (isNaN(userId) || userId <= 0) {
        await ctx.answerCbQuery("⚠️ 非法用户", { show_alert: true });
        return;
      }
      const userRows = await db.select().from(usersTable).where(eq(usersTable.id, userId));
      if (userRows.length === 0) {
        await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
        return;
      }
      await db.update(tasksTable).set({ assigneeId: userId }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery(`🔄 已转交给 ${userDisplayName(userRows[0])}`);
      if (actor) await writeAudit(actor.id, "TASK_TRANSFER", "task", taskId, `→ ${userDisplayName(userRows[0])}`);
      const safeTransT = escapeHtml(task.title);
      const newAssigneeMention = userMention(userRows[0]);
      {
        const gid = await resolveGroupIdForProject(task.projectId);
        await dispatchBroadcast(
          ctx.telegram, "TASK_TRANSFER",
          { projectId: task.projectId, groupId: gid, actorId: actor?.id ?? null },
          `🔄 <b>任务转交</b>\n\n📌 ${safeTransT}\n👤 新负责人：${newAssigneeMention}\n#${taskId}`,
        );
      }
      // DM the new assignee (skip if self-assigned)
      if (actor && userRows[0].id !== actor.id) {
        const dueStr = task.dueDate?.toLocaleDateString("zh-CN") ?? "—";
        await notifyUserById(
          ctx.telegram,
          userRows[0].id,
          `📌 <b>你被转交了一个任务</b>\n\n#${taskId} ${safeTransT}\n🎯 优先级：${task.priority}\n📅 截止：${dueStr}\n👤 来自：${userMention(actor)}`,
          [[{ text: "🔍 查看", callback_data: `TASK:OPEN:${taskId}` }, { text: "📋 我的任务", callback_data: "TASK:MY:ALL:0" }]],
        );
      }
      break;
    }
    case "UNASSIGN":
      await db.update(tasksTable).set({ assigneeId: null }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));
      await ctx.answerCbQuery("🚫 已取消指派");
      if (actor) await writeAudit(actor.id, "TASK_UNASSIGN", "task", taskId, task.title);
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
      await db.update(tasksTable).set({ projectId: projId }).where(eq(tasksTable.id, taskId));
      await ctx.answerCbQuery(`📁 已归属到 ${projRows[0].name}`);
      if (actor) await writeAudit(actor.id, "TASK_LINK_PROJECT", "task", taskId, `→ ${projRows[0].name}`);
      break;
    }
    case "UNLINK":
      await db.update(tasksTable).set({ projectId: null }).where(eq(tasksTable.id, taskId));
      await ctx.answerCbQuery("🚫 已解除归属");
      if (actor) await writeAudit(actor.id, "TASK_UNLINK_PROJECT", "task", taskId, task.title);
      break;
    default:
      await ctx.answerCbQuery("⚠️ 未知操作");
      return;
  }

  await showTaskCard(ctx, taskId, role);
}
