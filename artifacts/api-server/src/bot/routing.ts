/**
 * Broadcast routing core — PURE, TESTABLE, NO IO.
 *
 * Resolves "which chat(s) should receive this event?" given:
 *   - the event type
 *   - per-event context (entity's projectId / groupId / actor)
 *   - a snapshot of enabled groups (caller loads from DB and passes in)
 *   - env fallback (TELEGRAM_GROUP_ID / TELEGRAM_CHANNEL_ID)
 *
 * Hard contracts (DO NOT BREAK):
 *   1. Pure function — no DB, no Telegram API, no clock, no env access.
 *      All inputs explicit. Easy to unit-test.
 *   2. Always returns SOMETHING when env fallback is set, even if groups[] is
 *      empty. Silently dropping a broadcast is worse than a bug.
 *   3. Every target carries a `reason` string so audit can explain *why* a
 *      message went where it went. The reason is stable & machine-readable.
 *   4. `source: "GROUP_TABLE"` vs `"ENV_FALLBACK"` lets ops monitor migration
 *      progress (when % via ENV_FALLBACK → 0, env vars can be retired).
 *
 * Routing taxonomy (3 channel kinds):
 *   - COLLAB         : day-to-day team chatter (task/project/req/doc events)
 *   - REPORT         : public-facing dashboards & reports (channel-style)
 *   - FINANCE_REPORT : finance-only reports (separate audit trail)
 */

import type { Group } from "@workspace/db";

export type BroadcastEvent =
  // collab events (per project)
  | "TASK_CREATE" | "TASK_DONE" | "TASK_TRANSFER"
  | "PROJECT_CREATE" | "PROJECT_COMPLETE" | "PROJECT_RISK"
  | "REQ_CREATE" | "REQ_REVIEW" | "REQ_TO_TASK"
  | "DOC_CREATE" | "RISK_CREATE"
  // finance events (separate report channel)
  | "FINANCE_CREATE" | "FINANCE_REVIEW"
  // ops/admin
  | "DAILY_DIGEST"
  | "DASHBOARD_PUSH_GROUP"
  | "DASHBOARD_PUSH_CHANNEL"
  // back-compat shims for un-migrated call-sites (P1 will eliminate these)
  | "LEGACY_GROUP" | "LEGACY_CHANNEL";

export type BroadcastContext = {
  /** Entity's bound projectId, used to look up project.groupId chain. */
  projectId?: number | null;
  /** Direct group binding (e.g. entity.groupId already resolved). */
  groupId?: number | null;
  /** For audit only — the user who triggered the event. */
  actorId?: number | null;
};

export type ChannelKind = "COLLAB" | "REPORT" | "FINANCE_REPORT";

export type BroadcastTarget = {
  /** Telegram chat_id — coerced to string for sendMessage compat. */
  chatId: string;
  channel: ChannelKind;
  /** Stable, machine-readable reason for audit/debug. */
  reason:
    | "ctx_group_finance_channel"
    | "any_group_finance_channel"
    | "ctx_group_default_channel"
    | "any_group_default_channel"
    | "ctx_group_chat"
    | "first_enabled_group_chat"
    | "env_group_id"
    | "env_channel_id";
  source: "GROUP_TABLE" | "ENV_FALLBACK";
  /** Group id when source=GROUP_TABLE, for audit trail. */
  groupId?: number;
};

export type RoutingResolution = {
  targets: BroadcastTarget[];
  /** True if any target came from ENV_FALLBACK (signals incomplete migration). */
  fallbackUsed: boolean;
  /** True if NO targets at all — caller must warn / audit. */
  noTargets: boolean;
};

export type EnvFallback = {
  groupId?: string | undefined;
  channelId?: string | undefined;
};

const EMPTY: RoutingResolution = { targets: [], fallbackUsed: false, noTargets: true };

/** Find an enabled, non-deleted group by id. */
function findGroup(groups: Group[], id: number | null | undefined): Group | undefined {
  if (id == null) return undefined;
  return groups.find((g) => g.id === id && g.isEnabled === 1 && g.deletedAt == null);
}

/** First enabled, non-deleted group with a finance report channel set. */
function firstFinanceGroup(groups: Group[]): Group | undefined {
  return groups.find((g) => g.isEnabled === 1 && g.deletedAt == null && g.financeReportChannelId != null);
}

/** First enabled, non-deleted group with a default report channel set. */
function firstReportGroup(groups: Group[]): Group | undefined {
  return groups.find((g) => g.isEnabled === 1 && g.deletedAt == null && g.defaultReportChannelId != null);
}

/** First enabled, non-deleted group (any). */
function firstEnabledGroup(groups: Group[]): Group | undefined {
  return groups.find((g) => g.isEnabled === 1 && g.deletedAt == null);
}

function bigintToChatId(v: bigint): string {
  return v.toString();
}

/**
 * Single, authoritative routing decision.
 * See module header for hard contracts. DO NOT add IO here.
 */
export function getBroadcastTargets(
  event: BroadcastEvent,
  ctx: BroadcastContext,
  groups: Group[],
  env: EnvFallback,
): RoutingResolution {
  // Exhaustive event → bucket mapping. Adding a new BroadcastEvent without
  // touching this switch will produce a TS2322 "string is not assignable to
  // never" compile error — the only safe way to extend.
  type Bucket = "FINANCE" | "DASHBOARD_CHANNEL" | "COLLAB_OR_GROUP";
  const bucket: Bucket = ((): Bucket => {
    switch (event) {
      case "FINANCE_CREATE":
      case "FINANCE_REVIEW":
        return "FINANCE";
      case "DASHBOARD_PUSH_CHANNEL":
      case "LEGACY_CHANNEL":
        return "DASHBOARD_CHANNEL";
      case "TASK_CREATE": case "TASK_DONE": case "TASK_TRANSFER":
      case "PROJECT_CREATE": case "PROJECT_COMPLETE": case "PROJECT_RISK":
      case "REQ_CREATE": case "REQ_REVIEW": case "REQ_TO_TASK":
      case "DOC_CREATE": case "RISK_CREATE":
      case "DAILY_DIGEST": case "DASHBOARD_PUSH_GROUP": case "LEGACY_GROUP":
        return "COLLAB_OR_GROUP";
      default: {
        const _exhaustive: never = event;
        return _exhaustive;
      }
    }
  })();
  const isFinance = bucket === "FINANCE";
  const isDashboardChannel = bucket === "DASHBOARD_CHANNEL";

  // ──────────────────────────────────────────────────────────────────────
  // FINANCE → FINANCE_REPORT channel preferred, then any report channel,
  // then env CHANNEL_ID (treated as finance channel for legacy compat),
  // then env GROUP_ID as last-resort fallback.
  // ──────────────────────────────────────────────────────────────────────
  if (isFinance) {
    const ctxGroup = findGroup(groups, ctx.groupId);
    if (ctxGroup?.financeReportChannelId != null) {
      return {
        targets: [{
          chatId: bigintToChatId(ctxGroup.financeReportChannelId),
          channel: "FINANCE_REPORT",
          reason: "ctx_group_finance_channel",
          source: "GROUP_TABLE",
          groupId: ctxGroup.id,
        }],
        fallbackUsed: false,
        noTargets: false,
      };
    }
    const anyFin = firstFinanceGroup(groups);
    if (anyFin?.financeReportChannelId != null) {
      return {
        targets: [{
          chatId: bigintToChatId(anyFin.financeReportChannelId),
          channel: "FINANCE_REPORT",
          reason: "any_group_finance_channel",
          source: "GROUP_TABLE",
          groupId: anyFin.id,
        }],
        fallbackUsed: false,
        noTargets: false,
      };
    }
    if (env.channelId) {
      return {
        targets: [{
          chatId: env.channelId,
          channel: "FINANCE_REPORT",
          reason: "env_channel_id",
          source: "ENV_FALLBACK",
        }],
        fallbackUsed: true,
        noTargets: false,
      };
    }
    // SECURITY: deliberately do NOT fall back to env.groupId for FINANCE.
    // A finance event posted to a generic collab group violates least-privilege
    // (finance numbers visible to non-finance roles). Better to drop with WARN
    // and force admins to configure a proper finance channel. Caller can detect
    // via `noTargets === true` and surface "未配置财务频道" to the operator.
    return EMPTY;
  }

  // ──────────────────────────────────────────────────────────────────────
  // DASHBOARD → CHANNEL: prefer any group's defaultReportChannelId; else env.
  // ──────────────────────────────────────────────────────────────────────
  if (isDashboardChannel) {
    const ctxGroup = findGroup(groups, ctx.groupId);
    if (ctxGroup?.defaultReportChannelId != null) {
      return {
        targets: [{
          chatId: bigintToChatId(ctxGroup.defaultReportChannelId),
          channel: "REPORT",
          reason: "ctx_group_default_channel",
          source: "GROUP_TABLE",
          groupId: ctxGroup.id,
        }],
        fallbackUsed: false,
        noTargets: false,
      };
    }
    const anyRpt = firstReportGroup(groups);
    if (anyRpt?.defaultReportChannelId != null) {
      return {
        targets: [{
          chatId: bigintToChatId(anyRpt.defaultReportChannelId),
          channel: "REPORT",
          reason: "any_group_default_channel",
          source: "GROUP_TABLE",
          groupId: anyRpt.id,
        }],
        fallbackUsed: false,
        noTargets: false,
      };
    }
    if (env.channelId) {
      return {
        targets: [{
          chatId: env.channelId,
          channel: "REPORT",
          reason: "env_channel_id",
          source: "ENV_FALLBACK",
        }],
        fallbackUsed: true,
        noTargets: false,
      };
    }
    return EMPTY;
  }

  // ──────────────────────────────────────────────────────────────────────
  // DASHBOARD → GROUP / DAILY_DIGEST / LEGACY_GROUP / all collab events:
  //   ctx.groupId → first enabled group → env GROUP_ID
  // ──────────────────────────────────────────────────────────────────────
  // (collab events fall through to the same logic as dashboard-group)
  const ctxGroup = findGroup(groups, ctx.groupId);
  if (ctxGroup) {
    return {
      targets: [{
        chatId: bigintToChatId(ctxGroup.tgChatId),
        channel: "COLLAB",
        reason: "ctx_group_chat",
        source: "GROUP_TABLE",
        groupId: ctxGroup.id,
      }],
      fallbackUsed: false,
      noTargets: false,
    };
  }
  const anyGrp = firstEnabledGroup(groups);
  if (anyGrp) {
    return {
      targets: [{
        chatId: bigintToChatId(anyGrp.tgChatId),
        channel: "COLLAB",
        reason: "first_enabled_group_chat",
        source: "GROUP_TABLE",
        groupId: anyGrp.id,
      }],
      fallbackUsed: false,
      noTargets: false,
    };
  }
  if (env.groupId) {
    return {
      targets: [{
        chatId: env.groupId,
        channel: "COLLAB",
        reason: "env_group_id",
        source: "ENV_FALLBACK",
      }],
      fallbackUsed: true,
      noTargets: false,
    };
  }
  // dashboard→group with no env? We could still try env.channelId, but that
  // would break the "group vs channel" semantic. Better to return EMPTY and
  // let caller surface "未配置" to the user.
  return EMPTY;
}
