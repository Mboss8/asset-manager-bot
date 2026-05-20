import type { Route, RouteCtx } from "../router-table.js";

/**
 * Group admin routes (ADMIN_ONLY) — table-driven.
 *
 * Migration template for other modules. Notes:
 *   - Mutating handlers self-ack (toast feedback inside the handler), so
 *     they declare `preAck: false`. Read views default to pre-ack.
 *   - Each route's ACL defaults to `${MODULE}:${ACTION}`. Override only if
 *     the action key differs (e.g. fallback `GROUPS` → `M:GROUPS`).
 *   - Pre-flight DB checks (e.g. group exists) live inside the handler;
 *     the router stays pure pattern-match + ACL. This keeps the table data,
 *     not behavior.
 */

async function startSetChannelFlow(rctx: RouteCtx, flowKey: string): Promise<void> {
  const gid = parseInt(rctx.args.id, 10);
  if (!gid) {
    await rctx.ctx.answerCbQuery("❌ 参数错误", { show_alert: true });
    return;
  }
  // Pre-flight: group must exist + not be soft-deleted, otherwise the user
  // would be sent into a flow whose submit fails. ACL is already enforced
  // by tryDispatch; no need to re-check here.
  const { db, groupsTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  const grows = await db.select().from(groupsTable).where(eq(groupsTable.id, gid)).limit(1);
  if (grows.length === 0 || grows[0].deletedAt != null) {
    await rctx.ctx.answerCbQuery("❌ 群不存在", { show_alert: true });
    return;
  }
  await rctx.ctx.answerCbQuery();
  const { startFlow } = await import("../form-handler.js");
  await startFlow(rctx.ctx, flowKey, rctx.role, { groupId: gid });
}

async function clearChannel(rctx: RouteCtx, kind: "DEF" | "FIN"): Promise<void> {
  const gid = parseInt(rctx.args.id, 10);
  if (!gid) {
    await rctx.ctx.answerCbQuery("❌ 参数错误", { show_alert: true });
    return;
  }
  const { handleGroupClearChannel } = await import("../handlers/groups.js");
  await handleGroupClearChannel(rctx.ctx, gid, kind, rctx.telegramId);
}

async function fallbackToMenu({ ctx }: RouteCtx): Promise<void> {
  const { showGroupsMenu } = await import("../handlers/groups.js");
  await showGroupsMenu(ctx);
}

export const GROUPS_ROUTES: Route[] = [
  {
    pattern: "GROUPS:LIST:<offset:int?>",
    handler: async ({ ctx, args }) => {
      const off = args.offset ? parseInt(args.offset, 10) : 0;
      const { showGroupsList } = await import("../handlers/groups.js");
      await showGroupsList(ctx, Math.max(0, off));
    },
  },
  {
    pattern: "GROUPS:VIEW:<id:int>",
    handler: async ({ ctx, args }) => {
      const gid = parseInt(args.id, 10);
      if (!gid) { await ctx.answerCbQuery("❌ 参数错误", { show_alert: true }); return; }
      const { showGroupView } = await import("../handlers/groups.js");
      await showGroupView(ctx, gid);
    },
  },
  {
    pattern: "GROUPS:TOGGLE:<id:int>",
    preAck: false,
    handler: async ({ ctx, args, telegramId }) => {
      const gid = parseInt(args.id, 10);
      if (!gid) { await ctx.answerCbQuery("❌ 参数错误", { show_alert: true }); return; }
      const { handleGroupToggle } = await import("../handlers/groups.js");
      await handleGroupToggle(ctx, gid, telegramId);
    },
  },
  {
    pattern: "GROUPS:SETDEFCH:<id:int>",
    preAck: false, // ack inside helper after preflight
    handler: (rctx) => startSetChannelFlow(rctx, "GROUP:SETDEFCH"),
  },
  {
    pattern: "GROUPS:SETFINCH:<id:int>",
    preAck: false,
    handler: (rctx) => startSetChannelFlow(rctx, "GROUP:SETFINCH"),
  },
  {
    pattern: "GROUPS:CLRDEF:<id:int>",
    preAck: false,
    handler: (rctx) => clearChannel(rctx, "DEF"),
  },
  {
    pattern: "GROUPS:CLRFIN:<id:int>",
    preAck: false,
    handler: (rctx) => clearChannel(rctx, "FIN"),
  },
  {
    pattern: "GROUPS:PROJ:<offset:int?>",
    handler: async ({ ctx, args }) => {
      const off = args.offset ? parseInt(args.offset, 10) : 0;
      const { showProjectBindList } = await import("../handlers/project-groups.js");
      await showProjectBindList(ctx, Math.max(0, off));
    },
  },
  // Fallback for bare `GROUPS` — render submenu. Uses M:GROUPS ACL because
  // there's no specific action.
  {
    pattern: "GROUPS",
    acl: "M:GROUPS",
    handler: fallbackToMenu,
  },
  // Catch-all preserving legacy behavior: `GROUPS:<unknown>` and longer
  // unrecognized variants used to silently fall through to `showGroupsMenu`.
  // Without these the user would hit the global "⚠️ 未知操作" toast.
  // ACL = M:GROUPS to keep it admin-gated like the menu itself.
  {
    pattern: "GROUPS:<_action>",
    acl: "M:GROUPS",
    handler: fallbackToMenu,
  },
  {
    pattern: "GROUPS:<_action>:<_arg?>",
    acl: "M:GROUPS",
    handler: fallbackToMenu,
  },
];
