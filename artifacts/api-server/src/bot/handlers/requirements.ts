import type { Context } from "telegraf";
import { db } from "@workspace/db";
import { requirementsTable, usersTable, tasksTable, projectsTable, notDeleted } from "@workspace/db";
import { eq, and, desc, count } from "drizzle-orm";
import {
  editOrSend, buildKeyboard, shortTitle, priorityLabel, statusLabel, formatDate,
  EMPTY_LIST_MSG, writeAudit,
} from "../helpers.js";
import type { Role } from "../permissions.js";
import { canExecuteAction } from "../permissions.js";
import { userDisplayName, getUserByTelegramId } from "../user-service.js";
import { startFlow } from "../form-handler.js";
import { generateSerialNo } from "../serial-generator.js";
import { dispatchBroadcast } from "../dispatch.js";
import { resolveGroupIdForProject } from "../group-service.js";

const PAGE_SIZE = 8;

const FILTER_LABELS: Record<string, string> = {
  PENDING: "📥 待评审",
  APPROVED: "🚀 已立项",
  REJECTED: "❌ 已驳回",
  ARCH: "🗄 已归档",
};

function pageHeader(total: number, offset: number): string {
  if (total === 0) return EMPTY_LIST_MSG;
  return `共 ${total} 条 · 第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`;
}

export async function showReqList(ctx: Context, role: Role, filter = "PENDING", offset = 0): Promise<void> {
  if (!["PENDING", "APPROVED", "REJECTED", "ARCH"].includes(filter)) filter = "PENDING";
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  const conds = filter === "ARCH"
    ? [eq(requirementsTable.isArchived, 1), notDeleted(requirementsTable)]
    : [eq(requirementsTable.isArchived, 0), eq(requirementsTable.status, filter), notDeleted(requirementsTable)];

  const whereClause = and(...conds);
  const [{ value: total } = { value: 0 }] = await db
    .select({ value: count() })
    .from(requirementsTable)
    .where(whereClause);
  const slice = await db
    .select()
    .from(requirementsTable)
    .where(whereClause)
    .orderBy(desc(requirementsTable.updatedAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const tabRow = (["PENDING", "APPROVED", "REJECTED", "ARCH"] as const).map((f) => ({
    text: filter === f ? `« ${FILTER_LABELS[f]} »` : FILTER_LABELS[f],
    callback_data: `REQ:LIST:${f}:0`,
  }));

  const itemButtons = slice.map((r) => ({
    text: `${priorityLabel(r.priority)} #${r.id} ${shortTitle(r.title, 22)}`,
    callback_data: `REQ:OPEN:${r.id}`,
  }));

  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️ 上一页", callback_data: `REQ:LIST:${filter}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "下一页 ➡️", callback_data: `REQ:LIST:${filter}:${offset + PAGE_SIZE}` });

  const out: { text: string; callback_data: string }[][] = [tabRow.slice(0, 2), tabRow.slice(2, 4)];
  for (const b of itemButtons) out.push([b]);
  if (navRow.length > 0) out.push(navRow);
  out.push([{ text: "🔙 返回", callback_data: "M:REQ" }]);

  await editOrSend(ctx, `📥 <b>需求池</b> · ${FILTER_LABELS[filter]}\n\n${pageHeader(total, offset)}`, out);
}

export async function showPendingReqs(ctx: Context, role: Role): Promise<void> {
  await showReqList(ctx, role, "PENDING", 0);
}
export async function showApprovedReqs(ctx: Context, role: Role): Promise<void> {
  await showReqList(ctx, role, "APPROVED", 0);
}
export async function showRejectedReqs(ctx: Context, role: Role): Promise<void> {
  await showReqList(ctx, role, "REJECTED", 0);
}

export async function showReqStats(ctx: Context): Promise<void> {
  const all = await db.select().from(requirementsTable).where(notDeleted(requirementsTable));
  const pending = all.filter((r) => r.status === "PENDING" && r.isArchived === 0).length;
  const approved = all.filter((r) => r.status === "APPROVED" && r.isArchived === 0).length;
  const rejected = all.filter((r) => r.status === "REJECTED" && r.isArchived === 0).length;
  const archived = all.filter((r) => r.isArchived === 1).length;
  const linked = all.filter((r) => r.projectId !== null && r.isArchived === 0).length;
  const high = all.filter((r) => r.priority === "HIGH" && r.isArchived === 0).length;

  const text = `🧾 <b>需求统计</b>

📊 <b>总计：</b>${all.length} 条
⏳ <b>待评审：</b>${pending} 条
🚀 <b>已立项：</b>${approved} 条
❌ <b>已驳回：</b>${rejected} 条
🗄 <b>已归档：</b>${archived} 条

🔥 <b>高优先级（活跃）：</b>${high} 条
📁 <b>已关联项目：</b>${linked} 条`;

  await editOrSend(ctx, text, [
    [{ text: "📥 待评审", callback_data: "REQ:LIST:PENDING:0" }, { text: "🚀 已立项", callback_data: "REQ:LIST:APPROVED:0" }],
    [{ text: "🔙 返回", callback_data: "M:REQ" }],
  ]);
}

export async function showReqCard(ctx: Context, reqId: number, role: Role): Promise<void> {
  const rows = await db.select().from(requirementsTable).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
  if (rows.length === 0) {
    await editOrSend(ctx, "❌ 需求不存在或已删除", [[{ text: "🔙 返回需求池", callback_data: "M:REQ" }]]);
    return;
  }
  const req = rows[0];

  let creatorName = "—";
  const cRows = await db.select().from(usersTable).where(eq(usersTable.id, req.creatorId));
  if (cRows.length > 0) creatorName = userDisplayName(cRows[0]);

  let projectName = "—";
  if (req.projectId) {
    const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, req.projectId), notDeleted(projectsTable)));
    if (projRows.length > 0) projectName = projRows[0].name;
  }

  const archivedTag = req.isArchived === 1 ? " 🗄 已归档" : "";
  const text = `📌 <b>需求 #${req.id}</b>${archivedTag}

📝 <b>标题：</b>${req.title}
📋 <b>背景：</b>${req.background}
✅ <b>验收标准：</b>${req.acceptance}
🎯 <b>优先级：</b>${priorityLabel(req.priority)}
📊 <b>状态：</b>${statusLabel(req.status)}
👤 <b>提交人：</b>${creatorName}
📁 <b>项目：</b>${projectName}
📅 <b>期望完成：</b>${formatDate(req.dueDate)}
📝 <b>评审备注：</b>${req.reviewNote ?? "—"}`;

  const buttons: { text: string; callback_data: string }[] = [];
  if (req.isArchived === 0) {
    if (req.status === "PENDING") {
      if (canExecuteAction(role, "REQ:APP")) buttons.push({ text: "👍 批准", callback_data: `REQ:APP:${reqId}` });
      if (canExecuteAction(role, "REQ:REJ")) buttons.push({ text: "❌ 驳回", callback_data: `REQ:REJ:${reqId}` });
    }
    if (req.status === "REJECTED" && canExecuteAction(role, "REQ:REOPEN")) {
      buttons.push({ text: "↩️ 重新评审", callback_data: `REQ:REOPEN:${reqId}` });
    }
    if (req.status === "APPROVED" && canExecuteAction(role, "REQ:TOTASK")) {
      buttons.push({ text: "📌 转任务", callback_data: `REQ:TOTASK:${reqId}` });
    }
    if (canExecuteAction(role, "REQ:CHPROJ")) {
      buttons.push({ text: "📁 改归属", callback_data: `REQ:CHPROJ:${reqId}:0` });
    }
    if (canExecuteAction(role, "REQ:ARCH")) {
      buttons.push({ text: "🗄 归档", callback_data: `REQ:ARCH:${reqId}` });
    }
  } else if (canExecuteAction(role, "REQ:UNARCH")) {
    buttons.push({ text: "♻️ 取消归档", callback_data: `REQ:UNARCH:${reqId}` });
  }
  if (canExecuteAction(role, "REQ:DEL")) {
    buttons.push({ text: "🗑 删除", callback_data: `REQ:DEL:${reqId}` });
  }

  await editOrSend(ctx, text, buildKeyboard(buttons, 2, [{ text: "🔙 返回需求池", callback_data: "M:REQ" }]));
}

export async function startReqFlow(ctx: Context, role: Role): Promise<void> {
  const projects = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))
    .orderBy(desc(projectsTable.updatedAt));
  const projectOptions = [
    { text: "（不归属）", value: "NONE" },
    ...projects.slice(0, 12).map((p) => ({ text: `📁 ${shortTitle(p.name, 20)}`, value: String(p.id) })),
  ];
  await ctx.answerCbQuery();
  await startFlow(ctx, "REQ:NEW", role, undefined, { project_id: projectOptions });
}

export async function startReqReview(ctx: Context, action: "APP" | "REJ", reqId: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, `REQ:${action}`)) {
    await ctx.answerCbQuery("⛔ 无权限", { show_alert: true });
    return;
  }
  const rows = await db.select().from(requirementsTable).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 需求不存在", { show_alert: true });
    return;
  }
  if (rows[0].status !== "PENDING") {
    await ctx.answerCbQuery("⚠️ 该需求当前状态不可评审", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();
  await startFlow(ctx, `REQ:${action}`, role, { reqId });
}

export async function showReqProjectPicker(ctx: Context, reqId: number, offset: number, role: Role): Promise<void> {
  if (!canExecuteAction(role, "REQ:CHPROJ")) {
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
    callback_data: `REQ:SETPROJ:${reqId}:${p.id}`,
  }));
  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️", callback_data: `REQ:CHPROJ:${reqId}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "➡️", callback_data: `REQ:CHPROJ:${reqId}:${offset + PAGE_SIZE}` });

  const out: { text: string; callback_data: string }[][] = [];
  for (const b of items) out.push([b]);
  if (navRow.length > 0) out.push(navRow);
  out.push([{ text: "🚫 解除归属", callback_data: `REQ:UNLINK:${reqId}` }]);
  out.push([{ text: "🔙 返回需求", callback_data: `REQ:OPEN:${reqId}` }]);

  await ctx.answerCbQuery();
  await editOrSend(ctx, `📁 <b>更改需求 #${reqId} 归属项目</b>\n\n${pageHeader(total, offset)}\n请选择项目：`, out);
}

export async function handleReqAction(ctx: Context, action: string, reqId: number, role: Role, extra?: string): Promise<void> {
  if (!canExecuteAction(role, `REQ:${action}`)) {
    await ctx.answerCbQuery("⛔ 你没有权限执行该操作", { show_alert: true });
    return;
  }

  const rows = await db.select().from(requirementsTable).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
  if (rows.length === 0) {
    await ctx.answerCbQuery("❌ 需求不存在", { show_alert: true });
    return;
  }
  const req = rows[0];
  const telegramId = String(ctx.from?.id ?? "");
  const actor = await getUserByTelegramId(telegramId);
  const actorName = actor ? (actor.username ?? actor.firstName ?? actor.telegramId) : "—";

  switch (action) {
    case "ARCH":
      await db.update(requirementsTable).set({ isArchived: 1 }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
      await ctx.answerCbQuery("🗄 需求已归档");
      if (actor) await writeAudit(actor.id, "REQUIREMENT_ARCHIVE", "requirement", reqId, req.title);
      break;
    case "DEL":
      await db.update(requirementsTable).set({ deletedAt: new Date() }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
      await ctx.answerCbQuery("🗑 已移入回收站");
      if (actor) await writeAudit(actor.id, "REQUIREMENT_DELETE", "requirement", reqId, req.title, "MEDIUM");
      await showReqList(ctx, role, "PENDING", 0);
      return;
    case "UNARCH":
      await db.update(requirementsTable).set({ isArchived: 0 }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
      await ctx.answerCbQuery("♻️ 已取消归档");
      if (actor) await writeAudit(actor.id, "REQUIREMENT_UNARCHIVE", "requirement", reqId, req.title);
      break;
    case "REOPEN":
      if (req.status !== "REJECTED") {
        await ctx.answerCbQuery("⚠️ 仅已驳回需求可重新评审", { show_alert: true });
        return;
      }
      await db.update(requirementsTable).set({ status: "PENDING", reviewNote: null }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
      await ctx.answerCbQuery("↩️ 已恢复为待评审");
      if (actor) await writeAudit(actor.id, "REQUIREMENT_REOPEN", "requirement", reqId, req.title);
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
      await db.update(requirementsTable).set({ projectId: projId }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
      await ctx.answerCbQuery(`📁 已归属到 ${projRows[0].name}`);
      if (actor) await writeAudit(actor.id, "REQUIREMENT_LINK_PROJECT", "requirement", reqId, `→ ${projRows[0].name}`);
      break;
    }
    case "UNLINK":
      await db.update(requirementsTable).set({ projectId: null }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
      await ctx.answerCbQuery("🚫 已解除归属");
      if (actor) await writeAudit(actor.id, "REQUIREMENT_UNLINK_PROJECT", "requirement", reqId, req.title);
      break;
    case "TOTASK": {
      if (req.status !== "APPROVED") {
        await ctx.answerCbQuery("⚠️ 需求需先批准立项", { show_alert: true });
        return;
      }
      const [task] = await db.insert(tasksTable).values({
        serialNo: await generateSerialNo("T"),
        title: req.title,
        description: `来自需求 #${reqId}：${req.background}\n\n验收标准：${req.acceptance}`,
        creatorId: actor?.id ?? req.creatorId,
        priority: req.priority,
        projectId: req.projectId,
        assigneeId: req.creatorId,
      }).returning();
      await ctx.answerCbQuery(`📌 已转为任务 #${task.id}`);
      if (actor) await writeAudit(actor.id, "REQUIREMENT_TO_TASK", "requirement", reqId, `→ task #${task.id}`);
      {
        const gid = await resolveGroupIdForProject(req.projectId);
        await dispatchBroadcast(
          ctx.telegram, "REQ_TO_TASK",
          { projectId: req.projectId, groupId: gid, actorId: actor?.id ?? null },
          `📌 <b>需求转任务</b>\n\n📥 需求 #${reqId} → ✅ 任务 #${task.id}\n📌 ${task.title}\n👤 操作人：${actorName}`,
        );
      }
      break;
    }
    default:
      await ctx.answerCbQuery("⚠️ 未知操作");
      return;
  }

  await showReqCard(ctx, reqId, role);
}
