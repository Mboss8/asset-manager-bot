import type { Route, RouteCtx } from "../router-table.js";

/**
 * BI dashboard routes — table-driven.
 *
 * Notes:
 *   - `BI:FIN:<offset>` accepts NEGATIVE monthOffset (`BI:FIN:-1` to navigate
 *     to last month), so the placeholder is plain `<str>`, not `<int>`. The
 *     handler clamps with `parseInt` + `isNaN` like the legacy switch.
 *   - `BI:RISK:<offset:int?>` is non-negative only (page offset, clamped
 *     `Math.max(0, ...)` upstream), so `:int` is safe.
 *   - `BI:DIGEST` has a self-ack toast ("📅 推送中…") + multi-step async
 *     work, so it declares `preAck: false`.
 *   - `BI:PUSH` has three forms: bare (submenu), `:CH`, `:GR`. Three explicit
 *     routes keep ACL/ack semantics uniform; CH/GR self-ack inside push
 *     handlers, the bare submenu pre-acks.
 */

async function fallbackToMenu({ ctx, role }: RouteCtx): Promise<void> {
  const { showMenu } = await import("../menus.js");
  await showMenu(ctx, "M:BI", role);
}

export const BI_ROUTES: Route[] = [
  {
    pattern: "BI:DAILY",
    handler: async ({ ctx }) => {
      const { showDailyOverview } = await import("../handlers/bi.js");
      await showDailyOverview(ctx);
    },
  },
  {
    pattern: "BI:MINE",
    handler: async ({ ctx }) => {
      const { showMyDashboard } = await import("../handlers/bi.js");
      await showMyDashboard(ctx);
    },
  },
  {
    pattern: "BI:WEEKLY",
    handler: async ({ ctx }) => {
      const { showWeeklyProgress } = await import("../handlers/bi.js");
      await showWeeklyProgress(ctx);
    },
  },
  {
    pattern: "BI:HEALTH",
    handler: async ({ ctx }) => {
      const { showProjectHealth } = await import("../handlers/bi.js");
      await showProjectHealth(ctx);
    },
  },
  {
    pattern: "BI:RISK:<offset:int?>",
    handler: async ({ ctx, args }) => {
      const off = args.offset ? parseInt(args.offset, 10) : 0;
      const { showRiskAlert } = await import("../handlers/bi.js");
      await showRiskAlert(ctx, isNaN(off) ? 0 : off);
    },
  },
  {
    pattern: "BI:FIN:<offset?>",
    handler: async ({ ctx, args }) => {
      // Accept negative monthOffset; legacy parses with parseInt which handles `-1`.
      const mo = args.offset ? parseInt(args.offset, 10) : 0;
      const { showMonthlyFinBI } = await import("../handlers/bi.js");
      await showMonthlyFinBI(ctx, isNaN(mo) ? 0 : mo);
    },
  },
  {
    pattern: "BI:REPORT",
    handler: async ({ ctx, role }) => {
      const { generateWeeklyReport } = await import("../handlers/bi.js");
      await generateWeeklyReport(ctx, role);
    },
  },
  {
    pattern: "BI:PUSH",
    handler: async ({ ctx }) => {
      const { showPushMenu } = await import("../handlers/bi.js");
      await showPushMenu(ctx);
    },
  },
  {
    pattern: "BI:PUSH:CH",
    acl: "BI:PUSH",
    preAck: false,
    handler: async ({ ctx }) => {
      const { pushDashboardToChannel } = await import("../handlers/bi.js");
      await pushDashboardToChannel(ctx);
    },
  },
  {
    pattern: "BI:PUSH:GR",
    acl: "BI:PUSH",
    preAck: false,
    handler: async ({ ctx }) => {
      const { pushDashboardToGroup } = await import("../handlers/bi.js");
      await pushDashboardToGroup(ctx);
    },
  },
  {
    pattern: "BI:DIGEST",
    preAck: false,
    handler: async ({ ctx, telegramId }) => {
      await ctx.answerCbQuery("📅 推送中…");
      const { sendDailyDigest, buildDailyDigest } = await import("../reminders.js");
      const { writeAudit } = await import("../helpers.js");
      const { getUserByTelegramId } = await import("../user-service.js");
      const preview = await buildDailyDigest();
      if (!preview) {
        await ctx.reply("✅ 当前无逾期 / 今日截止 / 待审事项，无需推送。");
        return;
      }
      const result = await sendDailyDigest(ctx.telegram);
      const me = await getUserByTelegramId(telegramId);
      if (me) {
        await writeAudit(
          me.id,
          "REMINDER_MANUAL_DISPATCH",
          "digest",
          null,
          `group=${result.groupSent} dm=${result.dmCount}`,
          "MEDIUM",
        );
      }
      const groupLine = result.groupSent ? "📣 已推送到协作群" : "⚠️ 协作群未配置或推送失败";
      const dmLine = `📨 个人推送：${result.dmCount} 人${result.dmSkipped > 0 ? `（${result.dmSkipped} 人未触达）` : ""}`;
      await ctx.reply(
        `${groupLine}\n${dmLine}\n\n👁 <b>预览</b>\n\n${preview}`,
        { parse_mode: "HTML" },
      );
    },
  },
  // Catch-all preserving legacy `default` fallback to BI submenu — covers
  // up to 4 segments (callback discipline cap) so unknown `BI:*:*:*` still
  // hits the submenu instead of the global "⚠️ 未知操作" toast.
  // ACL = M:BI (ALL_USERS) matches legacy: any role landing on BI fallback
  // sees the role-filtered submenu.
  { pattern: "BI", acl: "M:BI", handler: fallbackToMenu },
  { pattern: "BI:<_action>", acl: "M:BI", handler: fallbackToMenu },
  { pattern: "BI:<_action>:<_arg?>", acl: "M:BI", handler: fallbackToMenu },
  { pattern: "BI:<_action>:<_a>:<_b?>", acl: "M:BI", handler: fallbackToMenu },
];
