import type { Context } from "telegraf";
import { db } from "@workspace/db";
import {
  tasksTable, projectsTable, requirementsTable,
  documentsTable, financeRecordsTable, risksTable, milestonesTable,
  notDeleted,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getSession, saveSession, clearSession } from "./session.js";
import { FLOWS, resolveDueDate } from "./flows.js";
import { getUserByTelegramId } from "./user-service.js";
import { showMenu } from "./menus.js";
import type { Role } from "./permissions.js";
import { canExecuteAction } from "./permissions.js";
import { logger } from "../lib/logger.js";
import { generateSerialNo } from "./serial-generator.js";
import { writeAudit } from "./helpers.js";
import { dispatchBroadcast } from "./dispatch.js";
import { resolveGroupIdForProject } from "./group-service.js";
import { escapeHtml, userMention, notifyUserById, notifyByRoles, REVIEWER_ROLES_REQ, REVIEWER_ROLES_FIN } from "./notify.js";

export async function startFlow(
  ctx: Context,
  flowKey: string,
  role: Role,
  context?: Record<string, unknown>,
  stepOverrides?: Record<string, { text: string; value: string | boolean }[]>,
): Promise<void> {
  const flow = FLOWS[flowKey];
  if (!flow) {
    await ctx.reply(`⚠️ 暂不支持此操作（${flowKey}）`);
    return;
  }

  // Inject dynamic options into matching steps
  const steps = stepOverrides
    ? flow.steps.map((s) => stepOverrides[s.key] ? { ...s, options: stepOverrides[s.key] } : s)
    : flow.steps;

  const telegramId = String(ctx.from?.id ?? "");
  await saveSession(telegramId, {
    state: "form",
    flow: flowKey,
    step: 0,
    formData: {},
    steps,
    context,
  });

  await sendCurrentStep(ctx, telegramId);
}

/**
 * Send/edit the current form step prompt.
 *
 * `viaCallback=true` → edit the message that owned the just-clicked button
 * (anchors the entire multi-step flow to a single chat message, no scroll
 * bloat). On edit failure (message too old, identical content, etc.) we
 * fall back to a fresh reply so the user never gets stuck.
 *
 * `viaCallback=false` (text-input transitions, /start of flow) → send a
 * fresh message; user-typed answers naturally interleave below.
 */
export async function sendCurrentStep(ctx: Context, telegramId: string, viaCallback = false): Promise<void> {
  const session = await getSession(telegramId);
  if (session.state !== "form" || !session.steps) return;

  const step = session.steps[session.step ?? 0];
  if (!step) return;

  let text: string;
  let keyboard: { text: string; callback_data: string }[][];

  if (step.type === "select" || step.type === "date_quick") {
    keyboard = (step.options ?? []).map((opt) => [
      { text: opt.text, callback_data: `FORM:SELECT:${step.key}:${opt.value}` },
    ]);
    keyboard.push([{ text: "❌ 取消", callback_data: "FORM:CANCEL" }]);
    text = step.prompt;
  } else if (step.type === "confirm") {
    // Confirm steps already include an explicit cancel option (value=false);
    // do NOT append a second FORM:CANCEL button.
    keyboard = (step.options ?? []).map((opt) => [
      { text: opt.text, callback_data: `FORM:SELECT:${step.key}:${opt.value}` },
    ]);
    text = step.prompt;
  } else {
    // Text/number input: no inline button (user is already typing). Hint
    // /skip and /cancel inline so the prompt is self-explanatory.
    const hints: string[] = [];
    if (!step.required) hints.push("/skip 跳过");
    hints.push("/cancel 取消");
    keyboard = [];
    text = step.prompt + `\n<i>（${hints.join(" · ")}）</i>`;
  }

  const extra = keyboard.length
    ? { parse_mode: "HTML" as const, reply_markup: { inline_keyboard: keyboard } }
    : { parse_mode: "HTML" as const };

  if (viaCallback) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch (err) {
      // Message gone / too old / identical content — fall through to reply.
      logger.debug({ err: (err as Error).message }, "[form] editMessageText failed, falling back to reply");
    }
  }
  await ctx.reply(text, extra);
}

export async function handleFormText(ctx: Context, text: string, role: Role): Promise<boolean> {
  const telegramId = String(ctx.from?.id ?? "");
  const session = await getSession(telegramId);
  if (session.state !== "form" || !session.steps) return false;

  const stepIdx = session.step ?? 0;
  const step = session.steps[stepIdx];
  if (!step) return false;

  if (step.type === "select" || step.type === "confirm" || step.type === "date_quick") return false;

  // /cancel — abort the flow from any text-input step.
  if (text.trim() === "/cancel") {
    await clearSession(telegramId);
    await ctx.reply("❌ 已取消");
    await showMenu(ctx, "M:HOME", role);
    return true;
  }

  const isSkip = text.trim() === "/skip";

  if (!step.required && isSkip) {
    session.formData = session.formData ?? {};
    session.step = stepIdx + 1;
    await saveSession(telegramId, session);
    if (session.step >= session.steps.length) {
      await submitForm(ctx, session.flow!, session.formData, role, session.context);
      await clearSession(telegramId);
    } else {
      await sendCurrentStep(ctx, telegramId);
    }
    return true;
  }

  if (step.type === "number") {
    const num = parseFloat(text.trim());
    if (isNaN(num) || (step.min !== undefined && num < step.min)) {
      await ctx.reply(`⚠️ 请输入有效数字${step.min !== undefined ? `（最小 ${step.min}）` : ""}：`);
      return true;
    }
    session.formData = { ...session.formData, [step.key]: num };
  } else {
    if (step.required && !text.trim()) {
      await ctx.reply("⚠️ 此字段为必填，请输入内容：");
      return true;
    }
    session.formData = { ...session.formData, [step.key]: text.trim() };
  }

  session.step = stepIdx + 1;
  await saveSession(telegramId, session);

  if (session.step >= session.steps.length) {
    await submitForm(ctx, session.flow!, session.formData!, role, session.context);
    await clearSession(telegramId);
  } else {
    await sendCurrentStep(ctx, telegramId);
  }
  return true;
}

export async function handleFormSelect(ctx: Context, key: string, value: string, role: Role): Promise<void> {
  const telegramId = String(ctx.from?.id ?? "");
  const session = await getSession(telegramId);
  if (session.state !== "form" || !session.steps) return;

  const stepIdx = session.step ?? 0;
  const step = session.steps[stepIdx];
  if (!step || step.key !== key) return;

  if (step.type === "confirm") {
    if (value === "false") {
      await clearSession(telegramId);
      await ctx.answerCbQuery("❌ 已取消");
      // Strip the keyboard from the anchored confirm message so it can't be
      // re-clicked and reads as terminal in chat history.
      try { await ctx.editMessageText("❌ 已取消"); } catch { /* swallow */ }
      await showMenu(ctx, "M:HOME", role);
      return;
    }
    session.formData = { ...session.formData, [key]: true };
  } else {
    session.formData = { ...session.formData, [key]: value };
  }

  session.step = stepIdx + 1;
  await saveSession(telegramId, session);

  if (session.step >= session.steps.length) {
    await ctx.answerCbQuery("✅ 正在提交…");
    // Anchor message becomes a "submitted" record; success notification
    // posts as a fresh message below.
    try { await ctx.editMessageText("✅ 已提交，正在处理…"); } catch { /* swallow */ }
    await submitForm(ctx, session.flow!, session.formData!, role, session.context);
    await clearSession(telegramId);
  } else {
    await ctx.answerCbQuery("✅");
    await sendCurrentStep(ctx, telegramId, true);
  }
}

async function submitForm(ctx: Context, flow: string, data: Record<string, unknown>, role: Role, context?: Record<string, unknown>): Promise<void> {
  const telegramId = String(ctx.from?.id ?? "");
  const user = await getUserByTelegramId(telegramId);
  if (!user) return;

  // Table-driven flow ACL enforcement.
  // Router gates the flow's *entry* callback, but FORM:SELECT confirm path
  // bypasses router-level ACL — so every flow declares its ACL on FlowDef
  // and we re-check here. Defends against stale-session privilege escalation
  // (admin → demoted mid-flow → confirm). Per R1, every FlowDef has `acl`
  // (boot invariant `assertFlowAclExists` enforces) so no `?.` needed.
  const flowDef = FLOWS[flow];
  if (flowDef && !canExecuteAction(role, flowDef.acl)) {
    await ctx.reply("⛔ 你没有权限完成此操作");
    await clearSession(telegramId);
    return;
  }

  try {
    switch (flow) {
      case "TASK:NEW": {
        const dueDate = data.due_date ? resolveDueDate(String(data.due_date)) : undefined;
        const projRaw = data.project_id ? String(data.project_id) : "NONE";
        const assignRaw = data.assignee_id ? String(data.assignee_id) : "NONE";
        const projectId = projRaw && projRaw !== "NONE" ? parseInt(projRaw, 10) : null;
        const assigneeId = assignRaw && assignRaw !== "NONE" ? parseInt(assignRaw, 10) : null;
        const [task] = await db.insert(tasksTable).values({
          serialNo: await generateSerialNo("T"),
          title: String(data.title ?? ""),
          description: data.description ? String(data.description) : null,
          creatorId: user.id,
          priority: String(data.priority ?? "MEDIUM"),
          dueDate: dueDate ?? null,
          projectId: projectId && !isNaN(projectId) ? projectId : null,
          assigneeId: assigneeId && !isNaN(assigneeId) ? assigneeId : null,
        }).returning();
        const safeTitle = escapeHtml(task.title);
        const dueStr = task.dueDate?.toLocaleDateString("zh-CN") ?? "—";
        await ctx.reply(`✅ <b>任务已创建</b>\n\n📌 标题：${safeTitle}\n🎯 优先级：${task.priority}\n📅 截止：${dueStr}\n\n任务编号：#${task.id}`, { parse_mode: "HTML" });
        {
          const gid = await resolveGroupIdForProject(task.projectId);
          await dispatchBroadcast(
            ctx.telegram, "TASK_CREATE",
            { projectId: task.projectId, groupId: gid, actorId: user.id },
            `🆕 <b>新任务</b>\n\n📌 ${safeTitle}\n🎯 优先级：${task.priority}\n📅 截止：${dueStr}\n👤 创建人：${userMention(user)}\n#${task.id}`,
          );
        }
        // DM the assignee (skip if assigning to self)
        if (task.assigneeId && task.assigneeId !== user.id) {
          await notifyUserById(
            ctx.telegram,
            task.assigneeId,
            `📌 <b>你被指派了一个新任务</b>\n\n#${task.id} ${safeTitle}\n🎯 优先级：${task.priority}\n📅 截止：${dueStr}\n👤 来自：${userMention(user)}`,
            [[{ text: "🔍 查看", callback_data: `TASK:OPEN:${task.id}` }, { text: "📋 我的任务", callback_data: "TASK:MY:ALL:0" }]],
          );
        }
        await writeAudit(user.id, "TASK_CREATE", "task", task.id, task.title);
        break;
      }
      case "PROJ:NEW": {
        const [proj] = await db.insert(projectsTable).values({
          name: String(data.name ?? ""),
          description: data.description ? String(data.description) : null,
          ownerId: user.id,
        }).returning();
        const safeName = escapeHtml(proj.name);
        await ctx.reply(`✅ <b>项目已创建</b>\n\n📁 名称：${safeName}\n编号：#${proj.id}`, { parse_mode: "HTML" });
        await dispatchBroadcast(
          ctx.telegram, "PROJECT_CREATE",
          { projectId: proj.id, groupId: null, actorId: user.id },
          `🆕 <b>新项目</b>\n\n📁 ${safeName}\n👤 负责人：${userMention(user)}\n#${proj.id}`,
        );
        await writeAudit(user.id, "PROJECT_CREATE", "project", proj.id, proj.name, "MEDIUM");
        break;
      }
      case "REQ:NEW": {
        const projRaw = data.project_id ? String(data.project_id) : "NONE";
        const projectId = projRaw && projRaw !== "NONE" ? parseInt(projRaw, 10) : null;
        const [req] = await db.insert(requirementsTable).values({
          serialNo: await generateSerialNo("R"),
          title: String(data.title ?? ""),
          background: String(data.background ?? ""),
          acceptance: String(data.acceptance ?? ""),
          priority: String(data.priority ?? "MEDIUM"),
          creatorId: user.id,
          projectId: projectId && !isNaN(projectId) ? projectId : null,
        }).returning();
        const safeReqTitle = escapeHtml(req.title);
        await ctx.reply(`✅ <b>需求已提交</b>\n\n📌 标题：${safeReqTitle}\n🎯 优先级：${req.priority}\n编号：#${req.id}\n\n⏳ 等待管理员评审`, { parse_mode: "HTML" });
        {
          const gid = await resolveGroupIdForProject(req.projectId);
          await dispatchBroadcast(
            ctx.telegram, "REQ_CREATE",
            { projectId: req.projectId, groupId: gid, actorId: user.id },
            `📥 <b>新需求待评审</b>\n\n📌 ${safeReqTitle}\n🎯 优先级：${req.priority}\n👤 提交人：${userMention(user)}\n#${req.id}`,
          );
        }
        // DM all PM/ADMIN reviewers (excluding submitter)
        await notifyByRoles(
          ctx.telegram,
          REVIEWER_ROLES_REQ,
          `📥 <b>新需求待评审</b>\n\n#${req.id} ${safeReqTitle}\n🎯 优先级：${req.priority}\n👤 提交人：${userMention(user)}`,
          [[{ text: "🔍 评审", callback_data: `REQ:OPEN:${req.id}` }, { text: "📋 待评审列表", callback_data: "REQ:PENDING" }]],
          user.id,
        );
        await writeAudit(user.id, "REQUIREMENT_CREATE", "requirement", req.id, req.title);
        break;
      }
      case "REQ:APP":
      case "REQ:REJ": {
        const reqId = context?.reqId ? Number(context.reqId) : 0;
        if (!reqId) {
          await ctx.reply("⚠️ 缺少需求上下文，操作失败");
          break;
        }
        const reqRows = await db.select().from(requirementsTable).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));
        if (reqRows.length === 0) {
          await ctx.reply("❌ 需求不存在");
          break;
        }
        const req = reqRows[0];
        const newStatus = flow === "REQ:APP" ? "APPROVED" : "REJECTED";
        const note = data.review_note ? String(data.review_note).trim() : null;
        const updated = await db.update(requirementsTable).set({
          status: newStatus,
          reviewNote: note,
        }).where(and(
          eq(requirementsTable.id, reqId),
          eq(requirementsTable.status, "PENDING"),
          eq(requirementsTable.isArchived, 0),
          notDeleted(requirementsTable),
        )).returning();
        if (updated.length === 0) {
          await ctx.reply("⚠️ 该需求状态已变更（可能已被其他人评审或已归档），请刷新后重试");
          break;
        }
        const verb = flow === "REQ:APP" ? "👍 已批准立项" : "❌ 已驳回";
        const groupVerb = flow === "REQ:APP" ? "🚀 <b>需求已立项</b>" : "❌ <b>需求被驳回</b>";
        const safeReqTitle2 = escapeHtml(req.title);
        const safeNote = note ? escapeHtml(note) : "";
        const noteLine = note ? `\n📝 ${flow === "REQ:APP" ? "审核意见" : "驳回理由"}：${safeNote}` : "";
        await ctx.reply(`${verb}\n\n📌 ${safeReqTitle2}\n#${reqId}${noteLine}`, { parse_mode: "HTML" });
        {
          const gid = await resolveGroupIdForProject(req.projectId);
          await dispatchBroadcast(
            ctx.telegram, "REQ_REVIEW",
            { projectId: req.projectId, groupId: gid, actorId: user.id },
            `${groupVerb}\n\n📌 ${safeReqTitle2}${noteLine}\n👤 评审人：${userMention(user)}\n#${reqId}`,
          );
        }
        // DM the requirement creator
        if (req.creatorId !== user.id) {
          const dmHead = flow === "REQ:APP" ? "🚀 <b>你的需求已立项</b>" : "❌ <b>你的需求被驳回</b>";
          await notifyUserById(
            ctx.telegram,
            req.creatorId,
            `${dmHead}\n\n#${reqId} ${safeReqTitle2}${noteLine}\n👤 评审人：${userMention(user)}`,
            [[{ text: "🔍 查看", callback_data: `REQ:OPEN:${reqId}` }]],
          );
        }
        await writeAudit(user.id, flow === "REQ:APP" ? "REQUIREMENT_APPROVE" : "REQUIREMENT_REJECT", "requirement", reqId, req.title);
        break;
      }
      case "DOC:ADD": {
        const projRaw = data.project_id ? String(data.project_id) : "NONE";
        const projectId = projRaw && projRaw !== "NONE" ? parseInt(projRaw, 10) : null;
        const [doc] = await db.insert(documentsTable).values({
          serialNo: await generateSerialNo("D"),
          title: String(data.doc_title ?? ""),
          category: String(data.category ?? "OTHER"),
          url: data.url ? String(data.url) : null,
          tags: data.tags ? String(data.tags) : null,
          projectId: projectId && !isNaN(projectId) ? projectId : null,
          creatorId: user.id,
        }).returning();
        let projTag = "";
        if (doc.projectId) {
          const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, doc.projectId), notDeleted(projectsTable)));
          if (projRows.length > 0) projTag = `\n📁 项目：${escapeHtml(projRows[0].name)}`;
        }
        const safeDocTitle = escapeHtml(doc.title);
        const safeDocCat = escapeHtml(doc.category);
        const safeDocUrl = doc.url ? escapeHtml(doc.url) : "";
        await ctx.reply(`✅ <b>文档已归档</b>\n\n📚 标题：${safeDocTitle}\n📂 分类：${safeDocCat}${projTag}\n编号：#${doc.id}`, { parse_mode: "HTML" });
        {
          const gid = await resolveGroupIdForProject(doc.projectId);
          await dispatchBroadcast(
            ctx.telegram, "DOC_CREATE",
            { projectId: doc.projectId, groupId: gid, actorId: user.id },
            `📚 <b>新文档</b>\n\n${safeDocTitle}\n📂 ${safeDocCat}${projTag}${doc.url ? `\n🔗 ${safeDocUrl}` : ""}\n👤 ${userMention(user)}`,
          );
        }
        await writeAudit(user.id, "DOCUMENT_CREATE", "document", doc.id, doc.title);
        break;
      }
      case "DOC:EDITTAGS": {
        const docId = context?.docId ? Number(context.docId) : 0;
        if (!docId) {
          await ctx.reply("⚠️ 缺少文档上下文，操作失败");
          break;
        }
        const docRows = await db.select().from(documentsTable).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
        if (docRows.length === 0) {
          await ctx.reply("❌ 文档不存在");
          break;
        }
        const newTags = data.tags ? String(data.tags).trim() : null;
        await db.update(documentsTable).set({ tags: newTags || null }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
        await ctx.reply(`✅ <b>标签已更新</b>\n\n📚 ${docRows[0].title}\n🏷 ${newTags || "（已清空）"}`, { parse_mode: "HTML" });
        await writeAudit(user.id, "DOCUMENT_EDIT_TAGS", "document", docId, newTags ?? "(cleared)");
        break;
      }
      case "DOC:PURGE": {
        const docId = context?.docId ? Number(context.docId) : 0;
        if (!docId) {
          await ctx.reply("⚠️ 缺少文档上下文，操作失败");
          break;
        }
        // PURGE 允许对软删/未软删文档都执行物理删除（最终清理出口）
        const docRows = await db.select().from(documentsTable).where(eq(documentsTable.id, docId));
        if (docRows.length === 0) {
          await ctx.reply("❌ 文档不存在");
          break;
        }
        const title = docRows[0].title;
        await db.delete(documentsTable).where(eq(documentsTable.id, docId));
        await ctx.reply(`☠️ <b>文档已彻底删除</b>\n\n📚 ${title}\n#${docId}`, { parse_mode: "HTML" });
        await writeAudit(user.id, "DOCUMENT_PURGE", "document", docId, title, "HIGH");
        break;
      }
      case "FIN:REIMB":
      case "FIN:IN":
      case "FIN:OUT": {
        const typeMap: Record<string, string> = { "FIN:REIMB": "REIMB", "FIN:IN": "INCOME", "FIN:OUT": "EXPENSE" };
        const labelMap: Record<string, string> = { "FIN:REIMB": "🧾 报销申请", "FIN:IN": "➕ 收入登记", "FIN:OUT": "➖ 支出登记" };
        const projRaw = data.project_id ? String(data.project_id) : "NONE";
        const projectId = projRaw && projRaw !== "NONE" ? parseInt(projRaw, 10) : null;
        const [rec] = await db.insert(financeRecordsTable).values({
          serialNo: await generateSerialNo("F"),
          type: typeMap[flow],
          amount: String(data.amount ?? "0"),
          currency: String(data.currency ?? "CNY"),
          purpose: String(data.purpose ?? ""),
          creatorId: user.id,
          projectId: projectId && !isNaN(projectId) ? projectId : null,
          status: flow === "FIN:REIMB" ? "PENDING_APPROVAL" : "PASSED",
        }).returning();
        let projTag = "";
        if (rec.projectId) {
          const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, rec.projectId), notDeleted(projectsTable)));
          if (projRows.length > 0) projTag = `\n📁 项目：${escapeHtml(projRows[0].name)}`;
        }
        const safePurpose = escapeHtml(rec.purpose);
        await ctx.reply(`✅ <b>财务记录已提交</b>\n\n💰 金额：${rec.amount} ${rec.currency}\n📋 用途：${safePurpose}${projTag}\n编号：#${rec.id}${flow === "FIN:REIMB" ? "\n\n⏳ 等待财务审核" : ""}`, { parse_mode: "HTML" });
        {
          const gid = await resolveGroupIdForProject(rec.projectId);
          await dispatchBroadcast(
            ctx.telegram, "FINANCE_CREATE",
            { projectId: rec.projectId, groupId: gid, actorId: user.id },
            `${labelMap[flow]}\n\n💰 ${rec.amount} ${rec.currency}\n📋 ${safePurpose}${projTag}\n👤 ${userMention(user)}${flow === "FIN:REIMB" ? "\n⏳ 待审核" : ""}\n#${rec.id}`,
          );
        }
        // DM finance reviewers when there's something to approve
        if (flow === "FIN:REIMB") {
          await notifyByRoles(
            ctx.telegram,
            REVIEWER_ROLES_FIN,
            `🧾 <b>新报销待审</b>\n\n#${rec.id} ${safePurpose}\n💰 ${rec.amount} ${rec.currency}${projTag}\n👤 提交人：${userMention(user)}`,
            [[{ text: "🔍 审核", callback_data: `FIN:DETAIL:${rec.id}` }, { text: "📋 待审核", callback_data: "FIN:APPROVALS" }]],
            user.id,
          );
        }
        await writeAudit(user.id, `FINANCE_${typeMap[flow]}`, "finance", rec.id, `${rec.amount} ${rec.currency} - ${rec.purpose}`, "MEDIUM");
        break;
      }
      case "FIN:PASS":
      case "FIN:FAIL": {
        const finId = context?.finId ? Number(context.finId) : 0;
        if (!finId) {
          await ctx.reply("⚠️ 缺少财务记录上下文，操作失败");
          break;
        }
        const recRows = await db.select().from(financeRecordsTable).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));
        if (recRows.length === 0) {
          await ctx.reply("❌ 财务记录不存在");
          break;
        }
        const rec = recRows[0];
        if (rec.creatorId === user.id) {
          await ctx.reply("⚠️ 不能审核自己提交的财务记录");
          break;
        }
        const newStatus = flow === "FIN:PASS" ? "PASSED" : "FAILED";
        const note = data.review_note ? String(data.review_note).trim() : null;
        const updated = await db.update(financeRecordsTable).set({
          status: newStatus,
          reviewNote: note,
          reviewerId: user.id,
        }).where(and(
          eq(financeRecordsTable.id, finId),
          eq(financeRecordsTable.status, "PENDING_APPROVAL"),
          eq(financeRecordsTable.isArchived, 0),
          notDeleted(financeRecordsTable),
        )).returning();
        if (updated.length === 0) {
          await ctx.reply("⚠️ 该记录状态已变更（可能已被其他人审核或已归档），请刷新后重试");
          break;
        }
        const verb = flow === "FIN:PASS" ? "✅ 已审核通过" : "❌ 已驳回";
        const groupVerb = flow === "FIN:PASS" ? "✅ <b>财务审核通过</b>" : "❌ <b>财务审核驳回</b>";
        const safeFinPurpose = escapeHtml(rec.purpose);
        const safeFinNote = note ? escapeHtml(note) : "";
        const noteLine = note ? `\n📝 ${flow === "FIN:PASS" ? "审核意见" : "驳回理由"}：${safeFinNote}` : "";
        await ctx.reply(`${verb}\n\n💰 ${rec.amount} ${rec.currency}\n📋 ${safeFinPurpose}\n#${finId}${noteLine}`, { parse_mode: "HTML" });
        {
          const gid = await resolveGroupIdForProject(rec.projectId);
          await dispatchBroadcast(
            ctx.telegram, "FINANCE_REVIEW",
            { projectId: rec.projectId, groupId: gid, actorId: user.id },
            `${groupVerb}\n\n💰 ${rec.amount} ${rec.currency}\n📋 ${safeFinPurpose}${noteLine}\n👤 审核人：${userMention(user)}\n#${finId}`,
          );
        }
        // DM the submitter
        if (rec.creatorId !== user.id) {
          const dmHead = flow === "FIN:PASS" ? "✅ <b>你的财务记录已通过</b>" : "❌ <b>你的财务记录被驳回</b>";
          await notifyUserById(
            ctx.telegram,
            rec.creatorId,
            `${dmHead}\n\n#${finId} ${safeFinPurpose}\n💰 ${rec.amount} ${rec.currency}${noteLine}\n👤 审核人：${userMention(user)}`,
            [[{ text: "🔍 查看", callback_data: `FIN:DETAIL:${finId}` }]],
          );
        }
        await writeAudit(user.id, flow === "FIN:PASS" ? "FINANCE_APPROVE" : "FINANCE_REJECT", "finance", finId, `${rec.amount} ${rec.currency} - ${rec.purpose}`, "MEDIUM");
        break;
      }
      case "GROUP:SETDEFCH":
      case "GROUP:SETFINCH": {
        // ACL re-check now centralized at top of submitForm via FLOWS[flow].acl.
        const isFin = flow === "GROUP:SETFINCH";
        const groupId = context?.groupId ? Number(context.groupId) : 0;
        if (!groupId) {
          await ctx.reply("⚠️ 缺少群组上下文，操作失败");
          break;
        }
        const raw = String(data.channel_id ?? "").trim();
        // Telegram channel/supergroup IDs are negative bigints, conventionally
        // prefixed -100. Reject anything that doesn't parse as a negative int
        // (positive ids belong to private chats / regular users — never report
        // channels).
        if (!/^-?\d+$/.test(raw)) {
          await ctx.reply("❌ 格式错误：请输入纯数字 chat_id（如 -1001234567890）");
          break;
        }
        let chatIdBig: bigint;
        try { chatIdBig = BigInt(raw); } catch { await ctx.reply("❌ chat_id 解析失败"); break; }
        if (chatIdBig >= 0n) {
          await ctx.reply("❌ 频道 chat_id 必须为负数（如 -1001234567890）。正数 id 属于用户私聊，不可作为报告频道。");
          break;
        }
        // FIX (MEDIUM/AppSec) — bound-check to PostgreSQL bigint range
        // ([-2^63, 2^63-1]). Without this an oversize BigInt parses fine in JS
        // but throws at DB write time. Also enforce Telegram channel/supergroup
        // -100 prefix to prevent persisting ids that will fail at send-time.
        const PG_BIGINT_MIN = -9223372036854775808n;
        if (chatIdBig < PG_BIGINT_MIN) {
          await ctx.reply("❌ chat_id 超出 64 位整数范围");
          break;
        }
        if (!raw.startsWith("-100")) {
          await ctx.reply("❌ 仅接受 Telegram 频道/超级群 chat_id（必须以 <code>-100</code> 开头）", { parse_mode: "HTML" });
          break;
        }
        const { groupsTable } = await import("@workspace/db");
        const existing = await db.select().from(groupsTable).where(eq(groupsTable.id, groupId)).limit(1);
        if (existing.length === 0 || existing[0].deletedAt != null) {
          await ctx.reply("❌ 群组不存在或已删除");
          break;
        }
        // FIX (LOW-1/AppSec) — reject if chat_id collides with any registered
        // group's tg_chat_id. Binding a "report channel" to a collab group's
        // chat_id silently leaks reports into the wrong audience.
        const { ne } = await import("drizzle-orm");
        const collision = await db
          .select({ id: groupsTable.id, title: groupsTable.title })
          .from(groupsTable)
          .where(and(eq(groupsTable.tgChatId, chatIdBig), ne(groupsTable.id, groupId)))
          .limit(1);
        if (collision.length > 0) {
          await ctx.reply(`❌ 该 chat_id 已被群「${escapeHtml(collision[0].title)}」占用（#${collision[0].id}），不可用作报告频道`, { parse_mode: "HTML" });
          break;
        }
        if (existing[0].tgChatId === chatIdBig) {
          await ctx.reply("❌ 不能把当前群自身的 chat_id 当成它的报告频道");
          break;
        }
        // FIX (LOW-2/AppSec) — set conditional on isEnabled=1 so a concurrent
        // disable doesn't leave a freshly-bound channel attached to a disabled
        // group (operator surprise, not a routing break).
        const updated = await db.update(groupsTable)
          .set(isFin
            ? { financeReportChannelId: chatIdBig, updatedAt: new Date() }
            : { defaultReportChannelId: chatIdBig, updatedAt: new Date() })
          .where(and(eq(groupsTable.id, groupId), eq(groupsTable.isEnabled, 1)))
          .returning({ id: groupsTable.id });
        if (updated.length === 0) {
          await ctx.reply("⛔ 群已被禁用，请先启用后再绑定频道");
          break;
        }
        const { invalidateGroupsCache } = await import("./group-service.js");
        invalidateGroupsCache();
        await writeAudit(
          user.id,
          isFin ? "GROUP_SET_FINANCE_CHANNEL" : "GROUP_SET_DEFAULT_CHANNEL",
          "group",
          groupId,
          `chatId=${chatIdBig.toString()} title=${existing[0].title}`,
          "MEDIUM",
        );
        const label = isFin ? "💰 财务频道" : "📊 默认报告频道";
        await ctx.reply(`✅ <b>已绑定 ${label}</b>\n\n群：${escapeHtml(existing[0].title)}\n频道 chat_id：<code>${chatIdBig.toString()}</code>`, { parse_mode: "HTML" });
        break;
      }
      case "PROJ:RISK": {
        const projectId = context?.projectId ? Number(context.projectId) : null;
        let projectName = "";
        if (projectId) {
          const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));
          if (projRows.length > 0) projectName = projRows[0].name;
        }
        await db.insert(risksTable).values({
          title: String(data.title ?? ""),
          description: data.description ? String(data.description) : null,
          severity: String(data.severity ?? "MEDIUM"),
          reporterId: user.id,
          projectId,
        });
        const projTag = projectName ? `\n📁 关联项目：${escapeHtml(projectName)}` : "";
        const safeRiskTitle = escapeHtml(String(data.title ?? ""));
        await ctx.reply(`✅ <b>风险已登记</b>\n\n⚠️ ${safeRiskTitle}\n严重程度：${data.severity}${projTag}`, { parse_mode: "HTML" });
        {
          const gid = await resolveGroupIdForProject(projectId);
          await dispatchBroadcast(
            ctx.telegram, "RISK_CREATE",
            { projectId, groupId: gid, actorId: user.id },
            `⚠️ <b>新风险登记</b>\n\n${safeRiskTitle}\n严重程度：${data.severity}${projTag}\n👤 ${userMention(user)}`,
          );
        }
        await writeAudit(user.id, "RISK_CREATE", "risk", 0, String(data.title ?? ""), "MEDIUM");
        break;
      }
      case "PROJ:NEWMILE": {
        const projectId = context?.projectId ? Number(context.projectId) : 0;
        if (!projectId) {
          await ctx.reply("⚠️ 缺少关联项目，里程碑创建失败");
          break;
        }
        const dueDate = data.due_date ? resolveDueDate(String(data.due_date)) : null;
        const [mile] = await db.insert(milestonesTable).values({
          projectId,
          title: String(data.title ?? ""),
          dueDate,
        }).returning();
        await ctx.reply(`✅ <b>里程碑已创建</b>\n\n🎯 ${escapeHtml(mile.title)}\n📅 ${mile.dueDate?.toLocaleDateString("zh-CN") ?? "—"}`, { parse_mode: "HTML" });
        await writeAudit(user.id, "MILESTONE_CREATE", "milestone", mile.id, mile.title);
        break;
      }
      default:
        await ctx.reply("⚠️ 提交完成，但无对应处理器");
    }
  } catch (err) {
    logger.error({ err, flow }, "Form submission failed");
    await ctx.reply("❌ 提交失败，请稍后重试");
  }
}
