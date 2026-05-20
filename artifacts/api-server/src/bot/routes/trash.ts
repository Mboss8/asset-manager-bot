import type { Route, RouteCtx } from "../router-table.js";

/**
 * Recycle bin routes (ADMIN_ONLY) — table-driven.
 *
 * Type validation lives inside the handler because the matcher has no
 * enum constraint (only `int` / `str`). On invalid type we keep the
 * legacy "⚠️ 未知回收站类型" toast for parity.
 *
 * `TRASH:PURGE` is wired but currently disabled — physical-delete is
 * routed exclusively through the DOC:PURGE form-handler flow until
 * B2.3 attaches a per-row purge button inside the bin UI.
 */

/**
 * Legacy parity: `case "TRASH"` validated `type = parts[2]` FIRST, before
 * action dispatch — so malformed callbacks distinguished:
 *   - type missing/invalid → "⚠️ 未知回收站类型"
 *   - type valid + action unknown → "⚠️ 未知回收站操作"
 * Preserve that two-tier message for users debugging stuck buttons.
 */
async function fallbackUnknown({ ctx, parts }: RouteCtx): Promise<void> {
  const { isTrashType } = await import("../handlers/trash.js");
  const maybeType = parts[2]; // TRASH:<action>:<type>:...
  if (!isTrashType(maybeType)) {
    await ctx.answerCbQuery("⚠️ 未知回收站类型", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery("⚠️ 未知回收站操作", { show_alert: true });
}

export const TRASH_ROUTES: Route[] = [
  {
    pattern: "TRASH:LIST:<type>:<offset:int?>",
    handler: async ({ ctx, args }) => {
      const { isTrashType, showTrashList } = await import("../handlers/trash.js");
      if (!isTrashType(args.type)) {
        await ctx.answerCbQuery("⚠️ 未知回收站类型", { show_alert: true });
        return;
      }
      const off = args.offset ? parseInt(args.offset, 10) : 0;
      await showTrashList(ctx, args.type, Math.max(0, off));
    },
  },
  {
    pattern: "TRASH:RESTORE:<type>:<id:int>",
    preAck: false,
    handler: async ({ ctx, args, telegramId }) => {
      const { isTrashType, handleTrashRestore } = await import(
        "../handlers/trash.js"
      );
      if (!isTrashType(args.type)) {
        await ctx.answerCbQuery("⚠️ 未知回收站类型", { show_alert: true });
        return;
      }
      const rid = parseInt(args.id, 10);
      // Legacy parity: rid=0 was rejected as "❌ 参数错误". `<id:int>` matcher
      // accepts "0" (just digits), so re-guard here. Avoids passing id=0 to
      // handleTrashRestore which would surface "记录已不在回收站" instead.
      if (!rid) {
        await ctx.answerCbQuery("❌ 参数错误", { show_alert: true });
        return;
      }
      await handleTrashRestore(ctx, args.type, rid, telegramId);
    },
  },
  {
    pattern: "TRASH:PURGE:<type>:<id:int>",
    preAck: false,
    handler: async ({ ctx }) => {
      // Stage A (B2.2): physical-delete entrypoint moved to DOC:PURGE flow;
      // TRASH:PURGE remains intentionally unimplemented until B2.3.
      await ctx.answerCbQuery("⛔ 暂不支持永久删除", { show_alert: true });
    },
  },
  // Catch-alls preserve legacy two-tier toast (see fallbackUnknown).
  // ACL = TRASH:LIST (ADMIN_ONLY) keeps them admin-gated.
  { pattern: "TRASH", acl: "TRASH:LIST", handler: fallbackUnknown },
  { pattern: "TRASH:<_action>", acl: "TRASH:LIST", handler: fallbackUnknown },
  {
    pattern: "TRASH:<_action>:<_arg?>",
    acl: "TRASH:LIST",
    handler: fallbackUnknown,
  },
  {
    pattern: "TRASH:<_action>:<_a>:<_b?>",
    acl: "TRASH:LIST",
    handler: fallbackUnknown,
  },
];
