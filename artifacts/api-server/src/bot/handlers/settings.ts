import type { Context } from "telegraf";
import { Input } from "telegraf";
import {
  db, auditLogsTable, usersTable, tasksTable, requirementsTable,
  documentsTable, financeRecordsTable, projectsTable, notDeleted,
} from "@workspace/db";
import { desc, eq, count, sql, and, or, like } from "drizzle-orm";
import { editOrSend, formatDate } from "../helpers.js";
import { userDisplayName } from "../user-service.js";
import { escapeHtml } from "../notify.js";
import {
  getSettings, setDigestHour, setDigestMinute, toggleSkipWeekend, toggleDigestDm,
} from "../settings-store.js";

const PAGE_SIZE = 10;

// ───────────────────────────── Settings hub ─────────────────────────────

// (renders via menu) — kept for compatibility
export async function showSettingsPlaceholder(ctx: Context, label: string): Promise<void> {
  await editOrSend(
    ctx,
    `⚙️ <b>${escapeHtml(label)}</b>\n\n🚧 此功能正在建设中，敬请期待。`,
    [[{ text: "🔙 返回系统设置", callback_data: "M:SET" }]],
  );
}

// ───────────────────────────── Reminder policy ─────────────────────────────

export async function showReminderPolicy(ctx: Context): Promise<void> {
  const s = await getSettings(true);
  const hh = String(s.digestHour).padStart(2, "0");
  const mm = String(s.digestMinute).padStart(2, "0");
  const text = [
    `⏰ <b>提醒策略</b>`,
    "",
    `每日推送时间：<b>${hh}:${mm}</b>（服务器时区）`,
    `周末跳过：${s.digestSkipWeekend ? "✅ 是（周六/周日不推送）" : "❌ 否（每天推送）"}`,
    `个人私信：${s.digestDmEnabled ? "✅ 已启用" : "❌ 已关闭（仅群组播报）"}`,
    "",
    "<i>修改即时生效，下一次推送按新设置执行。</i>",
  ].join("\n");

  // Hour quick set: common slots
  const hourBtns = [7, 8, 9, 10, 12, 14, 18, 21].map((h) => ({
    text: `${h === s.digestHour ? "✅ " : ""}${String(h).padStart(2, "0")}:00`,
    callback_data: `SET:REMINDH:${h}`,
  }));
  const minuteBtns = [0, 15, 30, 45].map((m) => ({
    text: `${m === s.digestMinute ? "✅ " : ""}:${String(m).padStart(2, "0")}`,
    callback_data: `SET:REMINDM:${m}`,
  }));

  await editOrSend(ctx, text, [
    hourBtns.slice(0, 4),
    hourBtns.slice(4, 8),
    minuteBtns,
    [
      { text: s.digestSkipWeekend ? "🔕 取消周末跳过" : "🌴 周末跳过", callback_data: "SET:REMIND:WEEKEND" },
      { text: s.digestDmEnabled ? "📵 关闭私信" : "📨 启用私信", callback_data: "SET:REMIND:DM" },
    ],
    [{ text: "📅 立即推送一次", callback_data: "BI:DIGEST" }],
    [{ text: "🔙 返回", callback_data: "M:SET" }],
  ]);
}

export async function handleReminderEdit(ctx: Context, action: string, value?: string): Promise<void> {
  if (action === "REMINDH") {
    const h = parseInt(value ?? "9", 10);
    await setDigestHour(isNaN(h) ? 9 : h);
    await ctx.answerCbQuery(`✅ 已设为 ${String(h).padStart(2, "0")} 时`);
  } else if (action === "REMINDM") {
    const m = parseInt(value ?? "0", 10);
    await setDigestMinute(isNaN(m) ? 0 : m);
    await ctx.answerCbQuery(`✅ 已设为 :${String(m).padStart(2, "0")} 分`);
  } else if (action === "REMIND" && value === "WEEKEND") {
    const s = await toggleSkipWeekend();
    await ctx.answerCbQuery(s.digestSkipWeekend ? "✅ 周末已跳过" : "✅ 已恢复每天推送");
  } else if (action === "REMIND" && value === "DM") {
    const s = await toggleDigestDm();
    await ctx.answerCbQuery(s.digestDmEnabled ? "✅ 已启用私信" : "✅ 已关闭私信");
  } else {
    await ctx.answerCbQuery();
  }
  await showReminderPolicy(ctx);
}

// ───────────────────────────── Audit log with filters ─────────────────────────────

const AUDIT_LEVELS = ["ALL", "LOW", "MEDIUM", "HIGH"] as const;
type AuditLevelFilter = typeof AUDIT_LEVELS[number];

const AUDIT_MODULES: Record<string, string> = {
  ALL: "全部",
  PROJ: "项目",
  TASK: "任务",
  REQ: "需求",
  DOC: "文档",
  FIN: "财务",
  USER: "成员",
  MILE: "里程碑",
  RISK: "风险",
};

// Canonical action prefixes (full words: PROJECT_, TASK_, REQUIREMENT_, DOCUMENT_, FINANCE_, USER_, MILESTONE_, RISK_)
const MOD_PREFIX: Record<string, string[]> = {
  ALL: [],
  PROJ: ["PROJECT_"],
  TASK: ["TASK_"],
  REQ: ["REQUIREMENT_"],
  DOC: ["DOCUMENT_"],
  FIN: ["FINANCE_"],
  USER: ["USER_"],
  MILE: ["MILESTONE_"],
  RISK: ["RISK_"],
};

export async function showAuditLog(
  ctx: Context,
  offset = 0,
  level: AuditLevelFilter = "ALL",
  mod = "ALL",
): Promise<void> {
  // Build SQL filter so pagination + total are correct against the full table.
  const conds = [] as ReturnType<typeof eq>[];
  if (level !== "ALL") conds.push(eq(auditLogsTable.auditLevel, level));
  const prefixes = MOD_PREFIX[mod] ?? [];
  if (prefixes.length > 0) {
    const ors = prefixes.map((p) => like(auditLogsTable.action, `${p}%`));
    const combined = ors.length === 1 ? ors[0] : or(...ors);
    if (combined) conds.push(combined as ReturnType<typeof eq>);
  }
  const whereClause = conds.length === 0
    ? undefined
    : conds.length === 1 ? conds[0] : and(...conds);

  const totalQ = whereClause
    ? db.select({ c: count() }).from(auditLogsTable).where(whereClause)
    : db.select({ c: count() }).from(auditLogsTable);
  const pageQ = whereClause
    ? db.select().from(auditLogsTable).where(whereClause).orderBy(desc(auditLogsTable.createdAt)).limit(PAGE_SIZE).offset(offset)
    : db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(PAGE_SIZE).offset(offset);
  const [[{ c: total }], page] = await Promise.all([totalQ, pageQ]);

  const pageNum = Math.floor(offset / PAGE_SIZE) + 1;
  const lines = [`🧾 <b>审计日志</b>（${AUDIT_MODULES[mod] ?? "全部"} · ${level} · 第 ${pageNum} 页 / ${total}）`, ""];

  if (page.length === 0) {
    lines.push("📭 没有匹配的记录");
  } else {
    // resolve actor names in batch
    const userIds = Array.from(
      new Set(page.map((l) => l.userId).filter((id): id is number => id != null)),
    );
    const actors = userIds.length > 0
      ? await db.select().from(usersTable).where(sql`${usersTable.id} IN (${sql.join(userIds.map((i) => sql`${i}`), sql`,`)})`)
      : [];
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    for (const log of page) {
      const time = log.createdAt.toLocaleString("zh-CN");
      const icon = log.auditLevel === "HIGH" ? "🔴" : log.auditLevel === "MEDIUM" ? "🟡" : "🔵";
      // userId == null → system-triggered (e.g. scheduled broadcast SEND_FAIL).
      const actorName = log.userId == null
        ? "🤖 系统"
        : (() => {
            const a = actorMap.get(log.userId);
            return a ? escapeHtml(userDisplayName(a)) : `用户#${log.userId}`;
          })();
      lines.push(`${icon} <b>${escapeHtml(log.action)}</b>  <i>${escapeHtml(time)}</i>`);
      lines.push(`   👤 ${actorName}`);
      if (log.details) lines.push(`   <code>${escapeHtml(log.details)}</code>`);
    }
  }

  // Filter rows
  const levelRow = AUDIT_LEVELS.map((lv) => ({
    text: lv === level ? `✅ ${lv}` : lv,
    callback_data: `SET:AUDIT:${lv}:${mod}:0`,
  }));
  const modKeys = ["ALL", "PROJ", "TASK", "REQ", "DOC", "FIN", "USER"];
  const modRow = modKeys.map((m) => ({
    text: m === mod ? `✅ ${AUDIT_MODULES[m]}` : (AUDIT_MODULES[m] ?? m),
    callback_data: `SET:AUDIT:${level}:${m}:0`,
  }));

  const navRow: { text: string; callback_data: string }[] = [];
  if (offset > 0) navRow.push({ text: "⬅️ 上一页", callback_data: `SET:AUDIT:${level}:${mod}:${Math.max(0, offset - PAGE_SIZE)}` });
  if (offset + PAGE_SIZE < total) navRow.push({ text: "下一页 ➡️", callback_data: `SET:AUDIT:${level}:${mod}:${offset + PAGE_SIZE}` });

  const keyboard: { text: string; callback_data: string }[][] = [
    levelRow,
    modRow.slice(0, 4),
    modRow.slice(4),
  ];
  if (navRow.length > 0) keyboard.push(navRow);
  keyboard.push([
    { text: "📥 导出全部 CSV", callback_data: "SET:EXP:AUDIT" },
    { text: "🔙 返回", callback_data: "M:SET" },
  ]);

  await editOrSend(ctx, lines.join("\n"), keyboard);
}

// ───────────────────────────── Data export (CSV) ─────────────────────────────

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.join(",")];
  for (const r of rows) lines.push(r.map(csvEscape).join(","));
  // BOM so Excel opens UTF-8 correctly
  return "\uFEFF" + lines.join("\n");
}

async function sendCsv(ctx: Context, filename: string, content: string): Promise<void> {
  const buf = Buffer.from(content, "utf8");
  await ctx.replyWithDocument(Input.fromBuffer(buf, filename), {
    caption: `📎 ${filename}（${(buf.byteLength / 1024).toFixed(1)} KB）`,
  });
}

export async function showExportPanel(ctx: Context): Promise<void> {
  const [
    [{ c: taskN }],
    [{ c: projN }],
    [{ c: reqN }],
    [{ c: docN }],
    [{ c: finN }],
    [{ c: userN }],
    [{ c: auditN }],
  ] = await Promise.all([
    db.select({ c: count() }).from(tasksTable).where(notDeleted(tasksTable)),
    db.select({ c: count() }).from(projectsTable).where(notDeleted(projectsTable)),
    db.select({ c: count() }).from(requirementsTable).where(notDeleted(requirementsTable)),
    db.select({ c: count() }).from(documentsTable).where(notDeleted(documentsTable)),
    db.select({ c: count() }).from(financeRecordsTable).where(notDeleted(financeRecordsTable)),
    db.select({ c: count() }).from(usersTable),
    db.select({ c: count() }).from(auditLogsTable),
  ]);

  const text = [
    `🗃 <b>数据导出</b>`,
    "",
    "选择要导出的数据集，将以 CSV 文件发送给你。",
    "",
    `📁 项目：${projN}　✅ 任务：${taskN}　📌 需求：${reqN}`,
    `📚 文档：${docN}　💰 财务：${finN}　👥 成员：${userN}`,
    `🧾 审计：${auditN}`,
  ].join("\n");

  await editOrSend(ctx, text, [
    [
      { text: "📁 项目", callback_data: "SET:EXP:PROJ" },
      { text: "✅ 任务", callback_data: "SET:EXP:TASK" },
      { text: "📌 需求", callback_data: "SET:EXP:REQ" },
    ],
    [
      { text: "📚 文档", callback_data: "SET:EXP:DOC" },
      { text: "💰 财务", callback_data: "SET:EXP:FIN" },
      { text: "👥 成员", callback_data: "SET:EXP:USER" },
    ],
    [{ text: "🧾 审计日志", callback_data: "SET:EXP:AUDIT" }],
    [{ text: "🔙 返回", callback_data: "M:SET" }],
  ]);
}

export async function handleExport(ctx: Context, kind: string): Promise<void> {
  await ctx.answerCbQuery("⏳ 正在生成…");
  const today = new Date().toISOString().slice(0, 10);
  switch (kind) {
    case "PROJ": {
      const rows = await db.select().from(projectsTable).where(notDeleted(projectsTable));
      const csv = toCsv(
        ["id", "name", "description", "status", "isArchived", "createdAt"],
        rows.map((p) => [p.id, p.name, p.description ?? "", p.status, p.isArchived, p.createdAt.toISOString()]),
      );
      await sendCsv(ctx, `projects_${today}.csv`, csv);
      return;
    }
    case "TASK": {
      const rows = await db.select().from(tasksTable).where(notDeleted(tasksTable));
      const csv = toCsv(
        ["id", "title", "status", "priority", "progress", "assigneeId", "creatorId", "projectId", "dueDate", "isArchived", "createdAt"],
        rows.map((t) => [
          t.id, t.title, t.status, t.priority, t.progress,
          t.assigneeId ?? "", t.creatorId, t.projectId ?? "",
          t.dueDate ? t.dueDate.toISOString() : "", t.isArchived, t.createdAt.toISOString(),
        ]),
      );
      await sendCsv(ctx, `tasks_${today}.csv`, csv);
      return;
    }
    case "REQ": {
      const rows = await db.select().from(requirementsTable).where(notDeleted(requirementsTable));
      const csv = toCsv(
        ["id", "title", "background", "acceptance", "status", "priority", "creatorId", "projectId", "isArchived", "createdAt"],
        rows.map((r) => [
          r.id, r.title, r.background, r.acceptance, r.status, r.priority,
          r.creatorId, r.projectId ?? "", r.isArchived, r.createdAt.toISOString(),
        ]),
      );
      await sendCsv(ctx, `requirements_${today}.csv`, csv);
      return;
    }
    case "DOC": {
      const rows = await db.select().from(documentsTable).where(notDeleted(documentsTable));
      const csv = toCsv(
        ["id", "title", "category", "url", "tags", "creatorId", "projectId", "createdAt"],
        rows.map((d) => [
          d.id, d.title, d.category, d.url ?? "", d.tags ?? "",
          d.creatorId, d.projectId ?? "", d.createdAt.toISOString(),
        ]),
      );
      await sendCsv(ctx, `documents_${today}.csv`, csv);
      return;
    }
    case "FIN": {
      const rows = await db.select().from(financeRecordsTable).where(notDeleted(financeRecordsTable));
      const csv = toCsv(
        ["id", "type", "amount", "currency", "purpose", "status", "creatorId", "projectId", "isArchived", "createdAt"],
        rows.map((f) => [
          f.id, f.type, f.amount, f.currency, f.purpose, f.status,
          f.creatorId, f.projectId ?? "", f.isArchived, f.createdAt.toISOString(),
        ]),
      );
      await sendCsv(ctx, `finance_${today}.csv`, csv);
      return;
    }
    case "USER": {
      const rows = await db.select().from(usersTable);
      const csv = toCsv(
        ["id", "telegramId", "username", "firstName", "lastName", "role", "isBlacklisted", "createdAt"],
        rows.map((u) => [
          u.id, u.telegramId, u.username ?? "", u.firstName ?? "", u.lastName ?? "",
          u.role, u.isBlacklisted, u.createdAt.toISOString(),
        ]),
      );
      await sendCsv(ctx, `members_${today}.csv`, csv);
      return;
    }
    case "AUDIT": {
      const rows = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(5000);
      const csv = toCsv(
        ["id", "userId", "action", "targetType", "targetId", "details", "auditLevel", "createdAt"],
        rows.map((l) => [
          l.id, l.userId, l.action, l.targetType ?? "", l.targetId ?? "",
          l.details ?? "", l.auditLevel, l.createdAt.toISOString(),
        ]),
      );
      await sendCsv(ctx, `audit_${today}.csv`, csv);
      return;
    }
    default:
      await ctx.reply("⚠️ 未知导出类型");
  }
}

// ───────────────────────────── Tag system overview ─────────────────────────────

export async function showTagSystem(ctx: Context): Promise<void> {
  const taskByPriority = await db
    .select({ priority: tasksTable.priority, c: count() })
    .from(tasksTable)
    .where(notDeleted(tasksTable))
    .groupBy(tasksTable.priority);
  const taskByStatus = await db
    .select({ status: tasksTable.status, c: count() })
    .from(tasksTable)
    .where(notDeleted(tasksTable))
    .groupBy(tasksTable.status);
  const docByCategory = await db
    .select({ category: documentsTable.category, c: count() })
    .from(documentsTable)
    .where(notDeleted(documentsTable))
    .groupBy(documentsTable.category);

  const lines = [`🏷 <b>标签体系</b>`, ""];
  lines.push(`<b>任务 · 优先级</b>`);
  if (taskByPriority.length === 0) lines.push("   —");
  for (const r of taskByPriority) lines.push(`   • ${escapeHtml(r.priority)}：${r.c}`);

  lines.push("", `<b>任务 · 状态</b>`);
  if (taskByStatus.length === 0) lines.push("   —");
  for (const r of taskByStatus) lines.push(`   • ${escapeHtml(r.status)}：${r.c}`);

  lines.push("", `<b>文档 · 分类</b>`);
  if (docByCategory.length === 0) lines.push("   —");
  for (const r of docByCategory) lines.push(`   • ${escapeHtml(r.category)}：${r.c}`);

  lines.push("", "<i>当前标签由系统枚举管理，自定义标签计划在后续版本支持。</i>");

  await editOrSend(ctx, lines.join("\n"), [[{ text: "🔙 返回", callback_data: "M:SET" }]]);
}

// ───────────────────────────── Backup / system info ─────────────────────────────

export async function showBackupPanel(ctx: Context): Promise<void> {
  const [taskN, projN, reqN, docN, finN, userN, auditN] = await Promise.all([
    db.select({ c: count() }).from(tasksTable).where(notDeleted(tasksTable)),
    db.select({ c: count() }).from(projectsTable).where(notDeleted(projectsTable)),
    db.select({ c: count() }).from(requirementsTable).where(notDeleted(requirementsTable)),
    db.select({ c: count() }).from(documentsTable).where(notDeleted(documentsTable)),
    db.select({ c: count() }).from(financeRecordsTable).where(notDeleted(financeRecordsTable)),
    db.select({ c: count() }).from(usersTable),
    db.select({ c: count() }).from(auditLogsTable),
  ]);
  const lastAudit = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(1);
  const lastTime = lastAudit[0]?.createdAt ? formatDate(lastAudit[0].createdAt) : "—";

  const lines = [
    `💾 <b>备份与系统</b>`,
    "",
    `<b>数据规模</b>`,
    `项目 ${projN[0].c} · 任务 ${taskN[0].c} · 需求 ${reqN[0].c}`,
    `文档 ${docN[0].c} · 财务 ${finN[0].c} · 成员 ${userN[0].c}`,
    `审计 ${auditN[0].c} · 最近活动 ${lastTime}`,
    "",
    "<b>备份建议</b>",
    "• 数据库由 Replit 托管，自带每日自动快照",
    "• 临时备份请使用「数据导出」批量下载 CSV",
    "• 关键操作（角色变更/拉黑/删除）已记录到审计日志",
  ].join("\n");

  await editOrSend(ctx, lines, [
    [{ text: "🗃 立即导出", callback_data: "SET:EXPORT" }],
    [{ text: "🧾 查看审计", callback_data: "SET:AUDIT" }],
    [{ text: "🔙 返回", callback_data: "M:SET" }],
  ]);
}
