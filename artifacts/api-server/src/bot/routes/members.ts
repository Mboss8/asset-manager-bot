import type { Route, RouteCtx } from "../router-table.js";

/**
 * Member admin routes (ADMIN_ONLY) — table-driven.
 *
 * Notes:
 *   - Mutating actions (NOOP/SETROLE/BLACKLIST/UNBLACKLIST) self-ack with
 *     toast feedback inside the handler, so they declare `preAck: false`.
 *     Read views default to pre-ack.
 *   - `actor` (the caller's User row) is required by user-card and member
 *     mutation handlers for self-action guards. Loaded lazily per route
 *     instead of once at module entry — admins always exist (ACL gate
 *     already passed), so this is defense in depth, not hot-path cost.
 */

async function loadActor(rctx: RouteCtx) {
  const { getUserByTelegramId } = await import("../user-service.js");
  const actor = await getUserByTelegramId(rctx.telegramId);
  if (!actor) {
    await rctx.ctx.answerCbQuery("❌ 用户不存在", { show_alert: true });
    return null;
  }
  return actor;
}

async function fallbackToMenu({ ctx }: RouteCtx): Promise<void> {
  await ctx.answerCbQuery("⚠️ 按钮版本过旧，请返回成员菜单重新进入", { show_alert: true });
}

export const MEMBERS_ROUTES: Route[] = [
  {
    pattern: "MEM:LIST:<filter?>:<offset:int?>",
    handler: async ({ ctx, args }) => {
      const filter = args.filter || "ALL";
      const off = args.offset ? parseInt(args.offset, 10) : 0;
      const { showMemberList } = await import("../handlers/members.js");
      await showMemberList(ctx, filter, Math.max(0, off));
    },
  },
  {
    pattern: "MEM:ACL",
    handler: async ({ ctx }) => {
      const { showAclPanel } = await import("../handlers/members.js");
      await showAclPanel(ctx);
    },
  },
  {
    pattern: "MEM:ROLE",
    handler: async ({ ctx }) => {
      const { showRoleHub } = await import("../handlers/members.js");
      await showRoleHub(ctx);
    },
  },
  {
    pattern: "MEM:POLICY",
    handler: async ({ ctx }) => {
      const { showPolicyMatrix } = await import("../handlers/members.js");
      await showPolicyMatrix(ctx);
    },
  },
  {
    pattern: "MEM:SEARCH",
    handler: async ({ ctx, telegramId }) => {
      const { saveSession } = await import("../session.js");
      const { startMemberSearch } = await import("../handlers/members.js");
      await saveSession(telegramId, {
        state: "form",
        flow: "MEM:SEARCH",
        step: 0,
        formData: {},
        steps: [],
      });
      await startMemberSearch(ctx);
    },
  },
  {
    pattern: "MEM:USER:<id:int>",
    handler: async (rctx) => {
      const actor = await loadActor(rctx);
      if (!actor) return;
      const { showUserCard } = await import("../handlers/members.js");
      await showUserCard(rctx.ctx, parseInt(rctx.args.id, 10), actor);
    },
  },
  {
    pattern: "MEM:NOOP",
    preAck: false,
    handler: async ({ ctx }) => {
      await ctx.answerCbQuery("已是当前角色");
    },
  },
  {
    pattern: "MEM:SETROLE:<id:int>:<newRole>",
    preAck: false,
    handler: async (rctx) => {
      const actor = await loadActor(rctx);
      if (!actor) return;
      const { handleMemberAction } = await import("../handlers/members.js");
      await handleMemberAction(
        rctx.ctx,
        "SETROLE",
        parseInt(rctx.args.id, 10),
        rctx.args.newRole,
        actor,
      );
    },
  },
  {
    pattern: "MEM:SET_ROLE:<id:int>:<newRole>",
    acl: "MEM:SETROLE",
    preAck: false,
    handler: async (rctx) => {
      const actor = await loadActor(rctx);
      if (!actor) return;
      const { handleMemberAction } = await import("../handlers/members.js");
      await handleMemberAction(
        rctx.ctx,
        "SETROLE",
        parseInt(rctx.args.id, 10),
        rctx.args.newRole,
        actor,
      );
    },
  },
  {
    pattern: "MEM:BLACK:<id:int>",
    acl: "MEM:BLACKLIST",
    preAck: false,
    handler: async (rctx) => {
      const actor = await loadActor(rctx);
      if (!actor) return;
      const { handleMemberAction } = await import("../handlers/members.js");
      await handleMemberAction(
        rctx.ctx,
        "BLACKLIST",
        parseInt(rctx.args.id, 10),
        undefined,
        actor,
      );
    },
  },
  {
    pattern: "MEM:BLACKLIST:<id:int>",
    preAck: false,
    handler: async (rctx) => {
      const actor = await loadActor(rctx);
      if (!actor) return;
      const { handleMemberAction } = await import("../handlers/members.js");
      await handleMemberAction(
        rctx.ctx,
        "BLACKLIST",
        parseInt(rctx.args.id, 10),
        undefined,
        actor,
      );
    },
  },
  {
    pattern: "MEM:WHITE:<id:int>",
    acl: "MEM:UNBLACKLIST",
    preAck: false,
    handler: async (rctx) => {
      const actor = await loadActor(rctx);
      if (!actor) return;
      const { handleMemberAction } = await import("../handlers/members.js");
      await handleMemberAction(
        rctx.ctx,
        "UNBLACKLIST",
        parseInt(rctx.args.id, 10),
        undefined,
        actor,
      );
    },
  },
  {
    pattern: "MEM:UNBLACKLIST:<id:int>",
    preAck: false,
    handler: async (rctx) => {
      const actor = await loadActor(rctx);
      if (!actor) return;
      const { handleMemberAction } = await import("../handlers/members.js");
      await handleMemberAction(
        rctx.ctx,
        "UNBLACKLIST",
        parseInt(rctx.args.id, 10),
        undefined,
        actor,
      );
    },
  },
  // Catch-all preserving legacy fallback to MEM submenu — covers up to
  // 4 segments (callback discipline cap) so unknown `MEM:*:*:*` still
  // hits the submenu instead of the global "⚠️ 未知操作" toast.
  { pattern: "MEM", acl: "M:MEM", handler: fallbackToMenu },
  { pattern: "MEM:<_action>", acl: "M:MEM", handler: fallbackToMenu },
  { pattern: "MEM:<_action>:<_arg?>", acl: "M:MEM", handler: fallbackToMenu },
  { pattern: "MEM:<_action>:<_a>:<_b?>", acl: "M:MEM", handler: fallbackToMenu },
];
