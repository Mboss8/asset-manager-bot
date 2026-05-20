import type { Context } from "telegraf";
import { db, usersTable, tasksTable, requirementsTable, financeRecordsTable, auditLogsTable, notDeleted } from "@workspace/db";
import type { User } from "@workspace/db";
import { eq, and, desc, count, sql } from "drizzle-orm";
import { editOrSend, buildKeyboard, EMPTY_LIST_MSG, writeAudit, formatDate } from "../helpers.js";
import { ROLE_LEVELS, type Role } from "../permissions.js";
import { updateUserRole, userDisplayName } from "../user-service.js";
import { escapeHtml, userMention, notifyUser } from "../notify.js";

const PAGE_SIZE = 8;

const ROLE_OPTIONS: Role[] = ["OWNER", "ADMIN", "PM", "FINANCE", "MEMBER", "GUEST"];

const ROLE_LABELS: Record<Role, string> = {
  OWNER: "👑 OWNER",
  ADMIN: "🛡 ADMIN",
  PM: "📋 PM",
  FINANCE: "💰 FINANCE",
  MEMBER: "👤 MEMBER",
  GUEST: "👁 GUEST",
};

function safeName(u: User): string {
  return escapeHtml(userDisplayName(u));
}

/**
 * Authorization gate for one admin acting on another user.
 * Rules:
 *  - You cannot modify yourself (no accidental self-demote / self-blacklist).
 *  - You cannot modify someone whose role is >= yours (only higher rank can act).
 *  - For role changes: you cannot promote anyone to a role >= your own rank
 *    (an ADMIN cannot crown an OWNER; an OWNER can do anything).
 */
function canActOn(actor: User, target: User, newRole?: Role): { ok: boolean; reason?: string } {
  if (actor.id === target.id) return { ok: false, reason: "不能对自己执行该操作" };
  const actorLvl = ROLE_LEVELS[actor.role as Role] ?? 0;
  const targetLvl = ROLE_LEVELS[target.role as Role] ?? 0;
  if (targetLvl >= actorLvl) return { ok: false, reason: "不能操作同级或更高权限的成员" };
  if (newRole) {
    const newLvl = ROLE_LEVELS[newRole] ?? 0;
    if (newLvl >= actorLvl) return { ok: false, reason: "不能授予同级或更高的权限" };
  }
  return { ok: true };
}

async function isLastOwner(userId: number): Promise<boolean> {
  const owners = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "OWNER"));
  return owners.length === 1 && owners[0].id === userId;
}

/**
 * Atomically demote an OWNER while ensuring at least one OWNER remains.
 * Returns true if the demotion succeeded, false if it would have left zero OWNERs
 * (or the user is no longer an OWNER).
 */
async function safeDemoteOwner(userId: number, newRole: Role): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const owners = await tx.select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.role, "OWNER"))
      .for("update");
    const isOwner = owners.some((o) => o.id === userId);
    if (!isOwner) return false;
    if (owners.length <= 1) return false;
    await tx.update(usersTable).set({ role: newRole }).where(eq(usersTable.id, userId));
    return true;
  });
}

// ---------------- Member list with filter + pagination ----------------

export async function showMemberList(ctx: Context, filter = "ALL", offset = 0): Promise<void> {
  const allUsers = await db.select().from(usersTable);
  let filtered = allUsers;
  let filterLabel = "全部";
  if (filter === "BLACK") {
    filtered = allUsers.filter((u) => u.isBlacklisted === 1);
    filterLabel = "🚫 黑名单";
  } else if (ROLE_OPTIONS.includes(filter as Role)) {
    filtered = allUsers.filter((u) => u.role === filter);
    filterLabel = ROLE_LABELS[filter as Role];
  }

  const total = filtered.length;
  const safeOff = Math.min(Math.max(0, offset), Math.max(0, total - 1));
  const page = filtered.slice(safeOff, safeOff + PAGE_SIZE);

  const lines = [
    `👥 <b>成员列表</b>（${filterLabel}：${total} 人）`,
    "",
  ];
  if (page.length === 0) {
    lines.push(EMPTY_LIST_MSG);
  } else {
    for (const u of page) {
      const blackFlag = u.isBlacklisted === 1 ? " 🚫" : "";
      lines.push(`• ${safeName(u)} <code>[${u.role}]</code>${blackFlag}`);
    }
  }

  const userBtns = page.map((u) => ({
    text: `👤 ${userDisplayName(u).slice(0, 14)}`,
    callback_data: `MEM:USER:${u.id}`,
  }));

  // filter row
  const filterRow = [
    { text: filter === "ALL" ? "✅ 全部" : "全部", callback_data: "MEM:LIST:ALL:0" },
    { text: filter === "BLACK" ? "✅ 黑名单" : "🚫 黑名单", callback_data: "MEM:LIST:BLACK:0" },
  ];

  const footer: { text: string; callback_data: string }[][] = [
    filterRow,
    [
      { text: "🔍 搜索", callback_data: "MEM:SEARCH" },
      { text: "🧩 按角色", callback_data: "MEM:ROLE" },
      { text: "🛡 权限矩阵", callback_data: "MEM:POLICY" },
    ],
  ];

  // pagination
  const pageRow: { text: string; callback_data: string }[] = [];
  if (safeOff > 0) {
    pageRow.push({ text: "⬅️ 上一页", callback_data: `MEM:LIST:${filter}:${Math.max(0, safeOff - PAGE_SIZE)}` });
  }
  if (safeOff + PAGE_SIZE < total) {
    pageRow.push({ text: "下一页 ➡️", callback_data: `MEM:LIST:${filter}:${safeOff + PAGE_SIZE}` });
  }
  if (pageRow.length > 0) footer.push(pageRow);
  footer.push([{ text: "🔙 返回", callback_data: "M:MEM" }]);

  const rows = [...chunkBtns(userBtns, 2), ...footer];
  await editOrSend(ctx, lines.join("\n"), rows);
}

function chunkBtns<T>(arr: T[], cols: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += cols) out.push(arr.slice(i, i + cols));
  return out;
}

// ---------------- By-role quick view ----------------

export async function showRoleHub(ctx: Context): Promise<void> {
  const users = await db.select().from(usersTable);
  const counts: Record<Role, number> = { OWNER: 0, ADMIN: 0, PM: 0, FINANCE: 0, MEMBER: 0, GUEST: 0 };
  for (const u of users) counts[u.role as Role] = (counts[u.role as Role] ?? 0) + 1;

  const lines = ["🧩 <b>按角色查看</b>", ""];
  for (const r of ROLE_OPTIONS) lines.push(`${ROLE_LABELS[r]}：${counts[r]} 人`);

  const btns = ROLE_OPTIONS.map((r) => ({
    text: `${ROLE_LABELS[r]} (${counts[r]})`,
    callback_data: `MEM:LIST:${r}:0`,
  }));
  await editOrSend(ctx, lines.join("\n"), [
    ...chunkBtns(btns, 2),
    [{ text: "🔙 返回", callback_data: "M:MEM" }],
  ]);
}

// ---------------- Permission policy matrix ----------------

export async function showPolicyMatrix(ctx: Context): Promise<void> {
  const lines = [
    "🛡 <b>角色权限矩阵</b>",
    "",
    "👑 <b>OWNER</b> — 全部权限，唯一可任命/撤销 ADMIN",
    "🛡 <b>ADMIN</b> — 成员/系统管理，全部业务模块",
    "📋 <b>PM</b> — 项目/任务/需求 创建与评审",
    "💰 <b>FINANCE</b> — 财务模块（收支、报销审核）",
    "👤 <b>MEMBER</b> — 提交任务/需求/报销，查看公开数据",
    "👁 <b>GUEST</b> — 只读公开看板",
    "",
    "<b>关键策略</b>",
    "• 创建项目：PM+",
    "• 创建任务：所有人（默认指派给自己）",
    "• 评审需求：PM+",
    "• 审核报销：FINANCE+",
    "• 数据看板推送：ADMIN+",
    "• 成员管理：ADMIN+（OWNER 才能任命同级）",
    "• 系统设置 / 审计日志：ADMIN+",
    "",
    "<i>说明：高级别可执行所有低级别权限。</i>",
  ];
  await editOrSend(ctx, lines.join("\n"), [
    [{ text: "👤 成员列表", callback_data: "MEM:LIST:ALL:0" }],
    [{ text: "🔙 返回", callback_data: "M:MEM" }],
  ]);
}

// ---------------- Member detail card ----------------

export async function showUserCard(ctx: Context, userId: number, actor: User): Promise<void> {
  const rows = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (rows.length === 0) {
    await ctx.reply("❌ 用户不存在");
    return;
  }
  const target = rows[0];

  // Stats
  const [taskAssigned] = await db.select({ c: count() }).from(tasksTable).where(and(eq(tasksTable.assigneeId, userId), notDeleted(tasksTable)));
  const [taskDone] = await db.select({ c: count() }).from(tasksTable)
    .where(and(eq(tasksTable.assigneeId, userId), eq(tasksTable.status, "DONE"), notDeleted(tasksTable)));
  const [reqCreated] = await db.select({ c: count() }).from(requirementsTable).where(and(eq(requirementsTable.creatorId, userId), notDeleted(requirementsTable)));
  const [finCreated] = await db.select({ c: count() }).from(financeRecordsTable).where(and(eq(financeRecordsTable.creatorId, userId), notDeleted(financeRecordsTable)));
  const lastAudit = await db.select().from(auditLogsTable)
    .where(eq(auditLogsTable.userId, userId))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(1);

  const lastActive = lastAudit[0]?.createdAt
    ? `${formatDate(lastAudit[0].createdAt)} · ${escapeHtml(lastAudit[0].action)}`
    : "—";

  const usernameLine = target.username ? `\n@${escapeHtml(target.username)}` : "";
  const text = [
    `👤 <b>成员详情</b>`,
    "",
    `姓名：${safeName(target)}${usernameLine}`,
    `TG ID：<code>${escapeHtml(target.telegramId)}</code>`,
    `角色：${ROLE_LABELS[target.role as Role] ?? target.role}`,
    `状态：${target.isBlacklisted === 1 ? "🚫 已加入黑名单" : "✅ 正常"}`,
    `注册：${formatDate(target.createdAt)}`,
    `最近活跃：${lastActive}`,
    "",
    `📊 <b>贡献</b>`,
    `任务：被指派 ${taskAssigned?.c ?? 0}（已完成 ${taskDone?.c ?? 0}）`,
    `需求：提交 ${reqCreated?.c ?? 0}`,
    `财务记录：${finCreated?.c ?? 0}`,
  ].join("\n");

  // Compute eligible role buttons (only roles strictly below actor; actor cannot self-edit anyway)
  const actorLvl = ROLE_LEVELS[actor.role as Role] ?? 0;
  const canEdit = canActOn(actor, target).ok;

  const buttons: { text: string; callback_data: string }[] = [];
  if (canEdit) {
    for (const r of ROLE_OPTIONS) {
      if ((ROLE_LEVELS[r] ?? 0) >= actorLvl) continue; // actor can't grant >= self
      if (r === target.role) {
        buttons.push({ text: `✅ ${r}`, callback_data: "MEM:NOOP" });
      } else {
        buttons.push({ text: r, callback_data: `MEM:SETROLE:${userId}:${r}` });
      }
    }
  }

  const footerRows: { text: string; callback_data: string }[][] = [];
  if (canEdit) {
    if (target.isBlacklisted === 1) {
      footerRows.push([{ text: "✅ 解除黑名单", callback_data: `MEM:UNBLACKLIST:${userId}` }]);
    } else {
      footerRows.push([{ text: "🚫 加入黑名单", callback_data: `MEM:BLACKLIST:${userId}` }]);
    }
  }
  footerRows.push([
    { text: "🔙 成员列表", callback_data: "MEM:LIST:ALL:0" },
    { text: "🏠 主菜单", callback_data: "M:HOME" },
  ]);

  const allRows = [...chunkBtns(buttons, 3), ...footerRows];
  await editOrSend(ctx, text, allRows);
}

// ---------------- Actions ----------------

export async function handleMemberAction(
  ctx: Context,
  action: string,
  userId: number,
  extra: string | undefined,
  actor: User,
): Promise<void> {
  switch (action) {
    case "USER":
      await showUserCard(ctx, userId, actor);
      return;

    case "NOOP":
      await ctx.answerCbQuery("已是当前角色");
      return;

    case "SETROLE": {
      const newRole = extra as Role;
      if (!ROLE_OPTIONS.includes(newRole)) {
        await ctx.answerCbQuery("⚠️ 未知角色", { show_alert: true });
        return;
      }
      const targetRows = await db.select().from(usersTable).where(eq(usersTable.id, userId));
      if (targetRows.length === 0) {
        await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
        return;
      }
      const target = targetRows[0];
      const guard = canActOn(actor, target, newRole);
      if (!guard.ok) {
        await ctx.answerCbQuery(`⛔ ${guard.reason}`, { show_alert: true });
        return;
      }
      if (target.role === newRole) {
        await ctx.answerCbQuery("已是该角色");
        return;
      }
      const oldRole = target.role;
      // last-OWNER guard: atomic check + update under row lock
      if (oldRole === "OWNER" && newRole !== "OWNER") {
        const ok = await safeDemoteOwner(userId, newRole);
        if (!ok) {
          await ctx.answerCbQuery("⛔ 系统至少需要一个 OWNER", { show_alert: true });
          return;
        }
      } else {
        await updateUserRole(userId, newRole);
      }
      await writeAudit(actor.id, "USER_ROLE_CHANGE", "user", userId,
        `${userDisplayName(target)}: ${oldRole} → ${newRole}`, "HIGH");
      await ctx.answerCbQuery(`✅ 角色已设为 ${newRole}`);
      // DM the affected user
      await notifyUser(
        ctx.telegram,
        target.telegramId,
        `🔔 <b>权限变更</b>\n\n你的角色已从 <code>${oldRole}</code> 调整为 <code>${newRole}</code>\n操作人：${userMention(actor)}`,
        [[{ text: "🏠 打开主菜单", callback_data: "M:HOME" }]],
      );
      await showUserCard(ctx, userId, actor);
      return;
    }

    case "BLACKLIST": {
      const targetRows = await db.select().from(usersTable).where(eq(usersTable.id, userId));
      if (targetRows.length === 0) {
        await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
        return;
      }
      const target = targetRows[0];
      const guard = canActOn(actor, target);
      if (!guard.ok) {
        await ctx.answerCbQuery(`⛔ ${guard.reason}`, { show_alert: true });
        return;
      }
      if (target.role === "OWNER") {
        await ctx.answerCbQuery("⛔ 不能拉黑 OWNER", { show_alert: true });
        return;
      }
      if (target.isBlacklisted === 1) {
        await ctx.answerCbQuery("已在黑名单中");
        return;
      }
      await db.update(usersTable).set({ isBlacklisted: 1 }).where(eq(usersTable.id, userId));
      await writeAudit(actor.id, "USER_BLACKLIST", "user", userId, userDisplayName(target), "HIGH");
      await ctx.answerCbQuery("🚫 已加入黑名单");
      await notifyUser(
        ctx.telegram,
        target.telegramId,
        `⚠️ <b>账号通知</b>\n\n你已被管理员加入黑名单，暂停使用 Bot。\n如有疑问，请联系：${userMention(actor)}`,
      );
      await showUserCard(ctx, userId, actor);
      return;
    }

    case "UNBLACKLIST": {
      const targetRows = await db.select().from(usersTable).where(eq(usersTable.id, userId));
      if (targetRows.length === 0) {
        await ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
        return;
      }
      const target = targetRows[0];
      // unblacklist still requires acting-on rights (don't allow lower-rank to release higher-rank)
      const guard = canActOn(actor, target);
      if (!guard.ok && actor.id !== target.id) {
        await ctx.answerCbQuery(`⛔ ${guard.reason}`, { show_alert: true });
        return;
      }
      if (target.isBlacklisted === 0) {
        await ctx.answerCbQuery("已不在黑名单");
        return;
      }
      await db.update(usersTable).set({ isBlacklisted: 0 }).where(eq(usersTable.id, userId));
      await writeAudit(actor.id, "USER_UNBLACKLIST", "user", userId, userDisplayName(target), "MEDIUM");
      await ctx.answerCbQuery("✅ 已解除黑名单");
      await notifyUser(
        ctx.telegram,
        target.telegramId,
        `✅ <b>账号通知</b>\n\n你已被解除黑名单，可以继续使用 Bot 了。\n操作人：${userMention(actor)}`,
        [[{ text: "🏠 打开主菜单", callback_data: "M:HOME" }]],
      );
      await showUserCard(ctx, userId, actor);
      return;
    }

    default:
      await ctx.answerCbQuery("⚠️ 未知操作");
  }
}

// ---------------- ACL panel (read-only blacklist + jump to manage) ----------------

export async function showAclPanel(ctx: Context): Promise<void> {
  const users = await db.select().from(usersTable);
  const blacklisted = users.filter((u) => u.isBlacklisted === 1);

  const lines = [`📌 <b>黑名单/白名单</b>（黑名单 ${blacklisted.length} 人）`, ""];
  if (blacklisted.length === 0) {
    lines.push("📭 暂无黑名单用户，所有成员均处于白名单状态。");
  } else {
    for (const u of blacklisted) {
      lines.push(`🚫 ${safeName(u)} <code>[${u.role}]</code>`);
    }
  }

  const btns = blacklisted.slice(0, 8).map((u) => ({
    text: `🔧 ${userDisplayName(u).slice(0, 14)}`,
    callback_data: `MEM:USER:${u.id}`,
  }));

  await editOrSend(ctx, lines.join("\n"), [
    ...chunkBtns(btns, 2),
    [{ text: "👤 全部成员", callback_data: "MEM:LIST:ALL:0" }],
    [{ text: "🔙 返回", callback_data: "M:MEM" }],
  ]);
}

// ---------------- Search by name / @username ----------------

export async function startMemberSearch(ctx: Context): Promise<void> {
  await editOrSend(
    ctx,
    `🔍 <b>搜索成员</b>\n\n请输入用户名（@xxx）或昵称关键字。\n直接发送消息即可，例如：<code>张</code> 或 <code>@alice</code>`,
    [[{ text: "🔙 返回", callback_data: "M:MEM" }]],
  );
}

export async function runMemberSearch(ctx: Context, query: string): Promise<void> {
  const q = query.trim().replace(/^@/, "");
  if (!q) {
    await ctx.reply("⚠️ 请提供搜索关键字");
    return;
  }
  const pattern = `%${q}%`;
  const rows = await db.select().from(usersTable).where(
    sql`(${usersTable.username} ILIKE ${pattern}) OR (${usersTable.firstName} ILIKE ${pattern}) OR (${usersTable.lastName} ILIKE ${pattern}) OR (${usersTable.telegramId} = ${q})`,
  ).limit(20);

  if (rows.length === 0) {
    await ctx.reply(`🔍 未找到匹配「${escapeHtml(q)}」的成员`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🔙 返回", callback_data: "M:MEM" }]] },
    });
    return;
  }

  const lines = [`🔍 <b>搜索结果</b>（${rows.length} 条）`, ""];
  for (const u of rows.slice(0, 12)) {
    const blackFlag = u.isBlacklisted === 1 ? " 🚫" : "";
    lines.push(`• ${safeName(u)} <code>[${u.role}]</code>${blackFlag}`);
  }
  const btns = rows.slice(0, 8).map((u) => ({
    text: `👤 ${userDisplayName(u).slice(0, 14)}`,
    callback_data: `MEM:USER:${u.id}`,
  }));
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [...chunkBtns(btns, 2), [{ text: "🔙 返回", callback_data: "M:MEM" }]] },
  });
}
