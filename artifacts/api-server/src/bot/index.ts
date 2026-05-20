import { Telegraf } from "telegraf";
import { logger } from "../lib/logger.js";
import { getOrCreateUser, getUserByTelegramId } from "./user-service.js";
import { getSession, clearSession } from "./session.js";
import { showMenu } from "./menus.js";
import { startFlow, handleFormText, handleFormSelect } from "./form-handler.js";
import { startSearch, handleSearch } from "./search.js";
import type { Role } from "./permissions.js";
import { canExecuteAction } from "./permissions.js";

import {
  showMyTasks, showTodayTasks, showDueSoonTasks, showOverdueTasks, showArchivedTasks,
  showTaskCard, handleTaskAction, startTaskFlow,
  showProgressMenu, showDelayMenu, showAssigneePicker, showProjectPicker,
} from "./handlers/tasks.js";
import {
  showProjectList, showProjectCard, showProjectReport,
  showProjectTasks, showProjectMilestones, showProjectRisks,
  handleProjectStatus, handleProjectArchive, handleProjectDelete, handleMilestoneDone,
  startMilestoneFlow, startProjectRiskFlow, showMilestonesEntry,
} from "./handlers/projects.js";
import {
  showPendingReqs, showApprovedReqs, showRejectedReqs, showReqStats, showReqCard, handleReqAction,
  showReqList, startReqFlow, startReqReview, showReqProjectPicker,
} from "./handlers/requirements.js";
import {
  showPendingApprovals, showMonthlyReport, showByProject, showFinCard, handleFinAction,
  showFinList, startFinFlow, startFinReview, showFinProjectPicker,
} from "./handlers/finance.js";
import {
  showDocCategories, showDocsByCategory, showMeetingMinutes, showArchivedDocs, showDocCard, handleDocAction,
  showDocList, showDocsByProjectPicker, showDocsByProject, showDocCategoryPicker, showDocProjectPicker,
  startDocAddFlow, startDocTagsFlow, startDocPurgeFlow,
} from "./handlers/documents.js";
// BI handlers all migrated to routes/bi.ts (lazy-imported there).
import { runMemberSearch, showMemberList, showUserCard } from "./handlers/members.js";
import {
  showAuditLog, showReminderPolicy, handleReminderEdit,
  showExportPanel, handleExport, showTagSystem, showBackupPanel,
} from "./handlers/settings.js";
import { tryDispatch } from "./router-table.js";
import { ALL_ROUTES } from "./routes/index.js";
import { assertInvariants } from "./invariants.js";
import { installCustomEmojiWrapper } from "../lib/custom-emoji.js";

export function createBot(token: string): Telegraf {
  // Boot-time policy enforcement (R1/R2/R3). Hard-fails on ACL drift,
  // warns on switch growth (throws in CI). See bot/invariants.ts.
  assertInvariants();

  const bot = new Telegraf(token);

  // Bot API 9.4+ — auto-inject custom_emoji entities on outbound text/caption
  // and icon_custom_emoji_id on inline buttons, drawn from the iOS pack
  // `tgiosicons`. Premium owners → fancy iOS icons; non-Premium owner case
  // self-degrades to Unicode-only on first API rejection. Zero handler
  // changes required. See lib/custom-emoji.ts.
  installCustomEmojiWrapper(bot);

  // Top-level error guard — surface handler exceptions instead of letting
  // Telegraf swallow them silently into debug-only logs. Kept as a thin
  // safety net even after debugging concluded.
  bot.catch((err, ctx) => {
    logger.error(
      { err, updateType: ctx.updateType, from: ctx.from?.id },
      "[bot.catch] unhandled handler error",
    );
  });

  async function getRole(telegramId: string): Promise<Role> {
    const user = await getUserByTelegramId(telegramId);
    return (user?.role as Role) ?? "GUEST";
  }

  async function isBlacklisted(telegramId: string): Promise<boolean> {
    const user = await getUserByTelegramId(telegramId);
    return user?.isBlacklisted === 1;
  }


  // Global blacklist gate: one lock for every command, message and button.
  // This keeps blacklisted users from bypassing module checks via old callbacks.
  bot.use(async (ctx, next) => {
    const telegramId = String(ctx.from?.id ?? "");
    if (!telegramId) return next();

    if (await isBlacklisted(telegramId)) {
      try {
        if (ctx.updateType === "callback_query") {
          await ctx.answerCbQuery("🚫 你已被列入黑名单，无法使用此系统。", { show_alert: true });
        } else if (ctx.chat?.type === "private") {
          await ctx.reply("🚫 你已被列入黑名单，无法使用此系统。");
        }
      } catch (err) {
        logger.warn({ err, telegramId }, "Failed to notify blacklisted user");
      }
      return;
    }

    return next();
  });

  const HELP_TEXT = `🤖 <b>得力助手 命令说明</b>

/menu - 打开主控面板（仅私聊）
/help - 查看帮助
/cancel - 取消当前操作
/chatid - 查看当前会话 ID（用于配置群组/频道）

💡 <b>使用建议</b>
• 私聊机器人进行所有操作（创建任务、查看数据等）
• 把机器人加入团队群，新建任务/项目/财务记录会自动播报到群
• 数据看板可以一键推送到频道做对外公告`;

  bot.start(async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const telegramId = String(from.id);

    if (await isBlacklisted(telegramId)) {
      if (ctx.chat.type === "private") await ctx.reply("🚫 你已被列入黑名单，无法使用此系统。");
      return;
    }

    if (ctx.chat.type !== "private") {
      const username = ctx.botInfo?.username;
      const link = username ? `https://t.me/${username}` : "私聊我";
      await ctx.reply(`👋 你好！请<a href="${link}">私聊我</a>使用完整功能。`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }

    await getOrCreateUser(telegramId, from.username, from.first_name, from.last_name);
    const role = await getRole(telegramId);
    await showMenu(ctx, "M:HOME", role);
  });

  bot.command("menu", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("👋 请私聊我使用菜单功能");
      return;
    }
    const telegramId = String(ctx.from?.id ?? "");
    if (await isBlacklisted(telegramId)) {
      await ctx.reply("🚫 你已被列入黑名单，无法使用此系统。");
      return;
    }
    await getOrCreateUser(telegramId, ctx.from?.username, ctx.from?.first_name, ctx.from?.last_name);
    const role = await getRole(telegramId);
    await showMenu(ctx, "M:HOME", role);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
  });

  bot.command("register", async (ctx) => {
    const telegramId = String(ctx.from?.id ?? "");
    if (await isBlacklisted(telegramId)) return;
    const { handleRegisterCommand } = await import("./handlers/groups.js");
    await handleRegisterCommand(ctx, telegramId);
  });

  bot.command("chatid", async (ctx) => {
    const chat = ctx.chat;
    if (!chat) return;
    await ctx.reply(`Chat ID: <code>${chat.id}</code>\nType: ${chat.type}`, { parse_mode: "HTML" });
    logger.info({ chatId: chat.id, type: chat.type, title: "title" in chat ? chat.title : null }, "chatid command");
  });

  bot.on("my_chat_member", async (ctx) => {
    const chat = ctx.chat;
    logger.info({ chatId: chat.id, type: chat.type, title: "title" in chat ? chat.title : null, status: ctx.myChatMember.new_chat_member.status }, "Bot membership changed");
  });

  bot.command("digest", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("⚠️ 请私聊机器人使用 /digest。");
      return;
    }
    const telegramId = String(ctx.from?.id ?? "");
    if (await isBlacklisted(telegramId)) {
      await ctx.reply("🚫 你已被列入黑名单，无法使用此系统。");
      return;
    }
    const role = await getRole(telegramId);
    if (role !== "OWNER" && role !== "ADMIN") {
      await ctx.reply("⛔ 仅 OWNER / ADMIN 可手动触发每日提醒。");
      return;
    }
    const { sendDailyDigest, buildDailyDigest } = await import("./reminders.js");
    const text = await buildDailyDigest();
    if (!text) {
      await ctx.reply("✅ 当前无逾期 / 今日截止 / 待审事项，无需推送。");
      return;
    }
    await ctx.reply(`👁 <b>预览</b>（仅你可见）\n\n${text}`, { parse_mode: "HTML" });
    const result = await sendDailyDigest(ctx.telegram);
    const groupLine = result.groupSent ? "📣 已推送到协作群" : "⚠️ 协作群未配置或推送失败";
    const dmLine = `📨 个人推送：${result.dmCount} 人${result.dmSkipped > 0 ? `（${result.dmSkipped} 人未触达，可能未启动 Bot）` : ""}`;
    await ctx.reply(`${groupLine}\n${dmLine}`);
  });

  bot.command("cancel", async (ctx) => {
    const telegramId = String(ctx.from?.id ?? "");
    await clearSession(telegramId);
    await ctx.reply("❌ 已取消当前操作");
    if (ctx.chat.type === "private") {
      const role = await getRole(telegramId);
      await showMenu(ctx, "M:HOME", role);
    }
  });

  bot.on("text", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const telegramId = String(ctx.from?.id ?? "");
    if (await isBlacklisted(telegramId)) return;
    await getOrCreateUser(telegramId, ctx.from?.username, ctx.from?.first_name, ctx.from?.last_name);

    const session = await getSession(telegramId);
    const role = await getRole(telegramId);
    const text = ctx.message.text;

    if (session.state === "form") {
      if (session.flow === "SEARCH") {
        await handleSearch(ctx, text);
        return;
      }
      if (session.flow === "MEM:SEARCH") {
        await clearSession(telegramId);
        await runMemberSearch(ctx, text);
        return;
      }
      const handled = await handleFormText(ctx, text, role);
      if (!handled) {
        await ctx.reply("⚠️ 请通过按钮选择，或发送 /cancel 取消");
      }
      return;
    }

    await ctx.reply("💡 发送 /menu 打开主控面板，/help 查看帮助");
  });

  bot.on("callback_query", async (ctx) => {
    if (!("data" in ctx.callbackQuery)) return;
    const data = ctx.callbackQuery.data;
    const telegramId = String(ctx.from?.id ?? "");

    if (await isBlacklisted(telegramId)) {
      await ctx.answerCbQuery("🚫 你已被列入黑名单", { show_alert: true });
      return;
    }

    await getOrCreateUser(telegramId, ctx.from?.username, ctx.from?.first_name, ctx.from?.last_name);
    const role = await getRole(telegramId);

    // If the user had a pending free-text search session (e.g. MEM:SEARCH) but
    // chose to navigate via buttons instead, drop it so later random text
    // isn't accidentally consumed as a search query.
    const sess = await getSession(telegramId);
    if (sess.state === "form" && (sess.flow === "MEM:SEARCH" || sess.flow === "SEARCH") && data !== "FORM:CANCEL") {
      await clearSession(telegramId);
    }

    try {
      await routeCallback(ctx, data, role, telegramId);
    } catch (err) {
      logger.error({ err, data }, "Callback query error");
      await ctx.answerCbQuery("❌ 操作失败，请重试", { show_alert: true });
    }
  });

  return bot;
}

async function routeCallback(ctx: any, data: string, role: Role, telegramId: string): Promise<void> {
  if (data === "FORM:CANCEL") {
    await clearSession(telegramId);
    await ctx.answerCbQuery("❌ 已取消");
    await showMenu(ctx, "M:HOME", role);
    return;
  }

  if (data.startsWith("FORM:SELECT:")) {
    const parts = data.split(":");
    const key = parts[2];
    const value = parts.slice(3).join(":");
    await handleFormSelect(ctx, key, value, role);
    return;
  }

  if (data.startsWith("PAGE:")) {
    const pageParts = data.split(":");
    if (pageParts[1] === "AUDIT") {
      if (!canExecuteAction(role, "M:SET")) {
        await ctx.answerCbQuery("⛔ 你没有权限查看审计日志", { show_alert: true });
        return;
      }
      const offset = parseInt(pageParts[2] ?? "0", 10);
      await ctx.answerCbQuery();
      await showAuditLog(ctx, isNaN(offset) ? 0 : Math.max(0, offset));
      return;
    }
    await ctx.answerCbQuery("📄");
    return;
  }

  const parts = data.split(":");

  if (parts[0] === "SELECT") {
    await ctx.answerCbQuery("✅ 已选择");
    return;
  }


  // Hard route for member list — avoids MEM catch-all fallback.
  if (data === "MEM:LIST" || data.startsWith("MEM:LIST:")) {
    if (!canExecuteAction(role, "MEM:LIST")) {
      await ctx.answerCbQuery("⛔ 你没有权限查看成员列表", { show_alert: true });
      return;
    }
    const filter = parts[2] || "ALL";
    const off = parseInt(parts[3] || "0", 10);
    await ctx.answerCbQuery();
    await showMemberList(ctx, filter, isNaN(off) ? 0 : Math.max(0, off));
    return;
  }


  // Member module hard routes.
  // Keep specific routes before MEM catch-all, otherwise buttons will loop back.

  if (data.startsWith("MEM:USER:")) {
    if (!canExecuteAction(role, "MEM:USER")) {
      await ctx.answerCbQuery("⛔ 你没有权限查看成员详情", { show_alert: true });
      return;
    }

    const userId = Number(parts[2]);
    if (!Number.isInteger(userId) || userId <= 0) {
      await ctx.answerCbQuery("⚠️ 成员 ID 异常", { show_alert: true });
      return;
    }

    const actor = await getUserByTelegramId(telegramId);
    if (!actor) {
      await ctx.answerCbQuery("❌ 当前用户不存在，请重新发送 /menu", { show_alert: true });
      return;
    }

    await ctx.answerCbQuery();
    await showUserCard(ctx, userId, actor);
    return;
  }

  if (data === "MEM:LIST" || data.startsWith("MEM:LIST:")) {
    if (!canExecuteAction(role, "MEM:LIST")) {
      await ctx.answerCbQuery("⛔ 你没有权限查看成员列表", { show_alert: true });
      return;
    }

    const filter = parts[2] || "ALL";
    const off = Number.parseInt(parts[3] || "0", 10);

    await ctx.answerCbQuery();
    await showMemberList(ctx, filter, Number.isNaN(off) ? 0 : Math.max(0, off));
    return;
  }

  // Table-driven dispatch (Phase 2 of the if-else → rule-driven refactor).
  // ALL_ROUTES owns ACL enforcement, ack semantics, and pattern matching for
  // migrated modules. Non-migrated modules fall through to the legacy switch
  // below — migration is incremental, one module at a time.
  if (await tryDispatch(ctx, data, role, telegramId, ALL_ROUTES)) return;

  // Centralized authz: derive an action key for the callback and verify role.
  // Unknown keys default to allow (canExecuteAction returns true), so detail
  // views like TASK:OPEN/PROJ:OPEN that aren't listed remain accessible.
  let authKey: string;
  if (parts[0] === "M") {
    authKey = `M:${parts[1]}`;
  } else if (data.startsWith("DOC:CATE:OPEN:")) {
    authKey = "DOC:CATE";
  } else if (data.startsWith("DOC:LIST:")) {
    authKey = "DOC:LIST";
  } else if (data.startsWith("DOC:LINKPROJ:")) {
    authKey = "DOC:LINKPROJ";
  } else if (data.startsWith("DOC:BYPROJ:")) {
    authKey = "DOC:LINKPROJ";
  } else if (data.startsWith("PROJ:LIST:")) {
    authKey = "PROJ:LIST";
  } else if (data.startsWith("TASK:MY:")) {
    authKey = "TASK:MY";
  } else if (data.startsWith("REQ:LIST:")) {
    authKey = "REQ:LIST";
  } else if (data.startsWith("FIN:LIST:")) {
    authKey = "FIN:LIST";
  } else if (data.startsWith("FIN:MONTHLY:")) {
    authKey = "FIN:MONTHLY";
  } else {
    authKey = `${parts[0]}:${parts[1]}`;
  }
  if (!canExecuteAction(role, authKey)) {
    await ctx.answerCbQuery("⛔ 你没有权限执行该操作", { show_alert: true });
    logger.warn({ telegramId, role, authKey }, "Authz blocked callback");
    return;
  }

  if (parts[0] === "M") {
    const menuKey = `M:${parts[1]}`;
    await ctx.answerCbQuery();
    if (menuKey === "M:SEARCH") {
      await startSearch(ctx);
    } else {
      await showMenu(ctx, menuKey, role);
    }
    return;
  }

  // Handle DOC:CATE:OPEN:CATEGORY[:offset] (4/5-part route)
  if (data.startsWith("DOC:CATE:OPEN:")) {
    await ctx.answerCbQuery();
    const tail = data.replace("DOC:CATE:OPEN:", "");
    const segs = tail.split(":");
    const category = segs[0] ?? "OTHER";
    const off = segs[1] ? parseInt(segs[1], 10) : 0;
    await showDocsByCategory(ctx, category, isNaN(off) ? 0 : off);
    return;
  }

  const module = parts[0];
  const action = parts[1];
  const idStr = parts[2];
  const extra = parts[3];
  const id = parseInt(idStr ?? "0", 10);

  switch (module) {
    case "PROJ":
      switch (action) {
        case "NEW":
          await ctx.answerCbQuery();
          await startFlow(ctx, "PROJ:NEW", role);
          break;
        case "LIST": {
          await ctx.answerCbQuery();
          // PROJ:LIST or PROJ:LIST:<filter>:<offset>
          const filter = idStr || "ACTIVE";
          const off = parseInt(extra ?? "0", 10);
          await showProjectList(ctx, role, filter, isNaN(off) ? 0 : Math.max(0, off));
          break;
        }
        case "OPEN":
          await ctx.answerCbQuery();
          await showProjectCard(ctx, id, role);
          break;
        case "REPORT":
          await ctx.answerCbQuery();
          await showProjectReport(ctx, role);
          break;
        case "RISK":
          // PROJ:RISK (global) or PROJ:RISK:<projectId>
          await startProjectRiskFlow(ctx, idStr ? id : null, role);
          break;
        case "MILE":
          await ctx.answerCbQuery();
          if (idStr) {
            await showProjectMilestones(ctx, id, role);
          } else {
            await showMilestonesEntry(ctx, role);
          }
          break;
        case "TASKS":
          await ctx.answerCbQuery();
          await showProjectTasks(ctx, id, role);
          break;
        case "RISKS":
          await ctx.answerCbQuery();
          await showProjectRisks(ctx, id, role);
          break;
        case "STATUS":
          await handleProjectStatus(ctx, id, extra ?? "", role);
          break;
        case "ARCH":
          await handleProjectArchive(ctx, id, true, role);
          break;
        case "UNARCH":
          await handleProjectArchive(ctx, id, false, role);
          break;
        case "DEL":
          await handleProjectDelete(ctx, id, role);
          break;
        case "NEWMILE":
          await startMilestoneFlow(ctx, id, role);
          break;
        case "MILEDONE":
          await handleMilestoneDone(ctx, id, role);
          break;
        case "CHGROUP": {
          await ctx.answerCbQuery();
          const off = parseInt(extra ?? "0", 10);
          const { showProjectGroupPicker } = await import("./handlers/project-groups.js");
          await showProjectGroupPicker(ctx, id, isNaN(off) ? 0 : Math.max(0, off));
          break;
        }
        case "SETGROUP": {
          const gid = parseInt(extra ?? "0", 10);
          if (!gid) { await ctx.answerCbQuery("❌ 参数错误", { show_alert: true }); break; }
          const { handleProjectGroupBind } = await import("./handlers/project-groups.js");
          await handleProjectGroupBind(ctx, id, gid, telegramId);
          break;
        }
        case "UNBINDGROUP": {
          const { handleProjectGroupUnbind } = await import("./handlers/project-groups.js");
          await handleProjectGroupUnbind(ctx, id, telegramId);
          break;
        }
        default:
          await ctx.answerCbQuery();
          await showMenu(ctx, "M:PROJ", role);
      }
      break;

    case "TASK":
      // Mutating actions that take an extra arg (require taskId)
      if (idStr && ["SETPROG", "SETDELAY", "CHASSIGN", "SETPROJ"].includes(action)) {
        await handleTaskAction(ctx, action, id, role, extra);
        break;
      }
      // Simple mutating actions (require taskId — distinguishes TASK:ARCH:<id> from TASK:ARCH menu entry)
      if (idStr && ["START", "RESUME", "PAUSE", "DONE", "ARCH", "DEL", "UNASSIGN", "UNLINK"].includes(action)) {
        await handleTaskAction(ctx, action, id, role);
        break;
      }
      // Interactive submenus / pickers
      if (action === "PROG") {
        await showProgressMenu(ctx, id, role);
        break;
      }
      if (action === "DELAY") {
        await showDelayMenu(ctx, id, role);
        break;
      }
      if (action === "TRANSFER") {
        const off = parseInt(extra ?? "0", 10);
        await showAssigneePicker(ctx, id, isNaN(off) ? 0 : Math.max(0, off), role);
        break;
      }
      if (action === "CHPROJ") {
        const off = parseInt(extra ?? "0", 10);
        await showProjectPicker(ctx, id, isNaN(off) ? 0 : Math.max(0, off), role);
        break;
      }
      // Navigation / lists
      switch (action) {
        case "NEW":
          await startTaskFlow(ctx, role);
          break;
        case "MY": {
          await ctx.answerCbQuery();
          // TASK:MY or TASK:MY:<filter>:<offset>
          const filter = idStr || "ALL";
          const off = parseInt(extra ?? "0", 10);
          await showMyTasks(ctx, role, telegramId, filter, isNaN(off) ? 0 : Math.max(0, off));
          break;
        }
        case "TODAY":
          await ctx.answerCbQuery();
          await showTodayTasks(ctx, role, telegramId);
          break;
        case "DUESOON":
          await ctx.answerCbQuery();
          await showDueSoonTasks(ctx, role, telegramId);
          break;
        case "OVERDUE": {
          await ctx.answerCbQuery();
          const off = parseInt(idStr ?? "0", 10);
          await showOverdueTasks(ctx, role, isNaN(off) ? 0 : Math.max(0, off));
          break;
        }
        case "ARCH": {
          await ctx.answerCbQuery();
          const off = parseInt(idStr ?? "0", 10);
          await showArchivedTasks(ctx, isNaN(off) ? 0 : Math.max(0, off));
          break;
        }
        case "OPEN":
          await ctx.answerCbQuery();
          await showTaskCard(ctx, id, role);
          break;
        default:
          await ctx.answerCbQuery();
          await showMenu(ctx, "M:TASK", role);
      }
      break;

    case "REQ":
      // APP/REJ now start flows for review note
      if (idStr && (action === "APP" || action === "REJ")) {
        await startReqReview(ctx, action, id, role);
        break;
      }
      // SETPROJ takes extra arg
      if (idStr && action === "SETPROJ") {
        await handleReqAction(ctx, action, id, role, extra);
        break;
      }
      // Mutating actions requiring reqId
      if (idStr && ["ARCH", "UNARCH", "DEL", "REOPEN", "TOTASK", "UNLINK"].includes(action)) {
        await handleReqAction(ctx, action, id, role);
        break;
      }
      // Project picker
      if (idStr && action === "CHPROJ") {
        const off = parseInt(extra ?? "0", 10);
        await showReqProjectPicker(ctx, id, isNaN(off) ? 0 : Math.max(0, off), role);
        break;
      }
      // Navigation / lists
      switch (action) {
        case "NEW":
          await startReqFlow(ctx, role);
          break;
        case "LIST": {
          await ctx.answerCbQuery();
          const filter = idStr || "PENDING";
          const off = parseInt(extra ?? "0", 10);
          await showReqList(ctx, role, filter, isNaN(off) ? 0 : Math.max(0, off));
          break;
        }
        case "PENDING":
          await ctx.answerCbQuery();
          await showPendingReqs(ctx, role);
          break;
        case "APPROVED":
          await ctx.answerCbQuery();
          await showApprovedReqs(ctx, role);
          break;
        case "REJECTED":
          await ctx.answerCbQuery();
          await showRejectedReqs(ctx, role);
          break;
        case "STATS":
          await ctx.answerCbQuery();
          await showReqStats(ctx);
          break;
        case "OPEN":
          await ctx.answerCbQuery();
          await showReqCard(ctx, id, role);
          break;
        default:
          await ctx.answerCbQuery();
          await showMenu(ctx, "M:REQ", role);
      }
      break;

    case "DOC": {
      // Mutators / detail actions that REQUIRE an id — guard against menu collision (DOC:ARCH menu vs DOC:ARCH:<id>)
      if (idStr !== undefined && ["PIN", "ARCH", "UNARCH", "DEL", "UNLINK"].includes(action)) {
        await handleDocAction(ctx, action, id, role);
        break;
      }
      if (idStr !== undefined && action === "SETCAT") {
        await handleDocAction(ctx, action, id, role, extra);
        break;
      }
      if (idStr !== undefined && action === "SETPROJ") {
        await handleDocAction(ctx, action, id, role, extra);
        break;
      }
      if (idStr !== undefined && action === "CHCAT") {
        await showDocCategoryPicker(ctx, id, role);
        break;
      }
      if (idStr !== undefined && action === "CHPROJ") {
        const off = extra ? parseInt(extra, 10) : 0;
        await showDocProjectPicker(ctx, id, isNaN(off) ? 0 : off, role);
        break;
      }
      if (idStr !== undefined && action === "EDITTAGS") {
        await startDocTagsFlow(ctx, id, role);
        break;
      }
      if (idStr !== undefined && action === "PURGE") {
        await startDocPurgeFlow(ctx, id, role);
        break;
      }
      if (idStr !== undefined && action === "OPEN") {
        await ctx.answerCbQuery();
        await showDocCard(ctx, id, role);
        break;
      }
      if (action === "LIST") {
        await ctx.answerCbQuery();
        const filter = parts[2] ?? "ALL";
        const off = parts[3] ? parseInt(parts[3], 10) : 0;
        await showDocList(ctx, role, filter, isNaN(off) ? 0 : off);
        break;
      }
      if (action === "LINKPROJ") {
        await ctx.answerCbQuery();
        const off = parts[2] ? parseInt(parts[2], 10) : 0;
        await showDocsByProjectPicker(ctx, role, isNaN(off) ? 0 : off);
        break;
      }
      if (action === "BYPROJ") {
        await ctx.answerCbQuery();
        const off = parts[3] ? parseInt(parts[3], 10) : 0;
        await showDocsByProject(ctx, id, isNaN(off) ? 0 : off);
        break;
      }
      switch (action) {
        case "ADD": await startDocAddFlow(ctx, role); break;
        case "MINUTES": await ctx.answerCbQuery(); await showMeetingMinutes(ctx); break;
        case "CATE": await ctx.answerCbQuery(); await showDocCategories(ctx); break;
        case "SEARCH": await ctx.answerCbQuery(); await startSearch(ctx); break;
        default: await ctx.answerCbQuery(); await showMenu(ctx, "M:DOC", role);
      }
      break;
    }

    case "FIN": {
      const idStr = parts[2];
      // Mutators / detail actions that REQUIRE an id — guard against menu collision
      if (idStr !== undefined && ["PASS", "FAIL"].includes(action)) {
        await startFinReview(ctx, action as "PASS" | "FAIL", id, role);
        break;
      }
      if (idStr !== undefined && ["ARCH", "UNARCH", "DEL", "UNLINK"].includes(action)) {
        await handleFinAction(ctx, action, id, role);
        break;
      }
      if (idStr !== undefined && action === "SETPROJ") {
        await handleFinAction(ctx, action, id, role, parts[3]);
        break;
      }
      if (idStr !== undefined && action === "CHPROJ") {
        const off = parts[3] ? parseInt(parts[3], 10) : 0;
        await showFinProjectPicker(ctx, id, isNaN(off) ? 0 : off, role);
        break;
      }
      if (idStr !== undefined && action === "DETAIL") {
        await ctx.answerCbQuery();
        await showFinCard(ctx, id, role);
        break;
      }
      if (action === "LIST") {
        await ctx.answerCbQuery();
        const filter = parts[2] ?? "PENDING";
        const off = parts[3] ? parseInt(parts[3], 10) : 0;
        await showFinList(ctx, role, filter, isNaN(off) ? 0 : off);
        break;
      }
      if (action === "MONTHLY") {
        await ctx.answerCbQuery();
        const off = parts[2] ? parseInt(parts[2], 10) : 0;
        await showMonthlyReport(ctx, isNaN(off) ? 0 : off);
        break;
      }
      switch (action) {
        case "IN": await startFinFlow(ctx, "FIN:IN", role); break;
        case "OUT": await startFinFlow(ctx, "FIN:OUT", role); break;
        case "REIMB": await startFinFlow(ctx, "FIN:REIMB", role); break;
        case "APPROVALS": await ctx.answerCbQuery(); await showPendingApprovals(ctx, role); break;
        case "BYPROJ": await ctx.answerCbQuery(); await showByProject(ctx); break;
        default: await ctx.answerCbQuery(); await showMenu(ctx, "M:FIN", role);
      }
      break;
    }

    // BI: migrated to table dispatch (see routes/bi.ts).

    // MEM: migrated to table dispatch (see routes/members.ts).

    case "SET": {
      // Mutating sub-actions self-ack with toast feedback; others pre-ack.
      const setMutating = action === "REMINDH" || action === "REMINDM"
        || (action === "REMIND" && (extra === "WEEKEND" || extra === "DM"))
        || action === "EXP";
      if (!setMutating) await ctx.answerCbQuery();
      switch (action) {
        case "AUDIT": {
          // SET:AUDIT or SET:AUDIT:<level>:<mod>:<offset>
          const level = (idStr ?? "ALL") as "ALL" | "LOW" | "MEDIUM" | "HIGH";
          const mod = parts[3] ?? "ALL";
          const off = parseInt(parts[4] ?? "0", 10);
          await showAuditLog(ctx, isNaN(off) ? 0 : Math.max(0, off), level, mod);
          break;
        }
        case "REMIND": {
          if (extra === "WEEKEND" || extra === "DM") {
            await handleReminderEdit(ctx, "REMIND", extra);
          } else {
            await showReminderPolicy(ctx);
          }
          break;
        }
        case "REMINDH":
          await handleReminderEdit(ctx, "REMINDH", idStr);
          break;
        case "REMINDM":
          await handleReminderEdit(ctx, "REMINDM", idStr);
          break;
        case "EXPORT":
          await showExportPanel(ctx);
          break;
        case "EXP":
          await handleExport(ctx, idStr ?? "");
          break;
        case "TAGS":
          await showTagSystem(ctx);
          break;
        case "TEMPLATE": {
          // Lightweight placeholder — templates are baked into flow definitions for now.
          const { showSettingsPlaceholder } = await import("./handlers/settings.js");
          await showSettingsPlaceholder(ctx, "默认模板");
          break;
        }
        case "BACKUP":
          await showBackupPanel(ctx);
          break;
        default:
          await showMenu(ctx, "M:SET", role);
      }
      break;
    }

    // GROUPS: migrated to table dispatch (see routes/groups.ts).

    // TRASH: migrated to table dispatch (see routes/trash.ts).

    default:
      await ctx.answerCbQuery("⚠️ 未知操作");
  }
}
