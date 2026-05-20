# B3 P1 — Call-site Migration to Strongly-typed `dispatchBroadcast`

**Date**: 2026-05-09  
**Predecessor**: B3 P0 (`docs/changes/B3_routing_core.md`) — pure routing core + dispatcher + 30s cache + `resolveGroupIdForProject` helper, with all 14 legacy call-sites zero-changed via `LEGACY_*` shims.  
**Successor**: B3 P2 — admin UI to manage `groups` table (register chats, set defaultReportChannelId / financeReportChannelId, enable/disable). After P2, `LEGACY_*` event types and env-fallback paths can be retired.

## Goal (user's success criteria, all met)

| # | Criterion | Status |
|---|---|---|
| 1 | All broadcasts go through `dispatchBroadcast(...)` | ✅ — 0 `notifyGroup` / `notifyChannel` calls left in src; both shims physically deleted from `helpers.ts` |
| 2 | `ctx` carries `projectId` + `groupId` (resolved via `resolveGroupIdForProject`) + `actorId` | ✅ — every user-triggered broadcast resolves project→group; system events pass `actorId: null` |
| 3 | Audit captures route reason/source for ops forensics | ✅ — `dispatch.ts::auditDispatch` writes 3 audit kinds (FALLBACK / NO_TARGET / SEND_FAIL) with `event;proj;grp;targets=reason@source` details |

## What changed

### Migrated call-sites (17 → 16 emissions)

> Note: `projects.ts::handleProjectStatus` previously emitted twice (one `notifyGroup` per branch); merged into one branch-aware `dispatchBroadcast` call. Net broadcast emissions are unchanged (still one per status transition).

| Batch | File | Sites | Events emitted |
|---|---|---|---|
| **B1: form-handler** | `form-handler.ts` | 8 | TASK_CREATE · PROJECT_CREATE · REQ_CREATE · REQ_REVIEW · DOC_CREATE · FINANCE_CREATE · FINANCE_REVIEW · RISK_CREATE |
| **B2: action handlers** | `handlers/tasks.ts` | 3 | TASK_DONE (×2: DONE button + 100% progress) · TASK_TRANSFER |
| **B2: action handlers** | `handlers/projects.ts` | 1 (was 2) | PROJECT_COMPLETE · PROJECT_RISK (branched) |
| **B2: action handlers** | `handlers/requirements.ts` | 1 | REQ_TO_TASK |
| **B3: aggregate / system** | `handlers/bi.ts` | 2 | DASHBOARD_PUSH_GROUP · DASHBOARD_PUSH_CHANNEL (P1-fix: pre-fetch `me` BEFORE dispatch so dispatch-level audit captures actor — these are operator-driven broadcasts, not system events) |
| **B3: aggregate / system** | `reminders.ts` | 1 | DAILY_DIGEST (system actor=null) |

### `dispatch.ts` — new auto-audit policy

To meet criterion #3 without flooding `audit_logs`, a tiered policy:

| Outcome | User-triggered (actorId set) | System-triggered (actorId=null) | Level |
|---|---|---|---|
| GROUP_TABLE clean success | — (pino DEBUG only) | — | — |
| ENV_FALLBACK clean success | `BROADCAST_FALLBACK` | — (pino only — would flood) | LOW |
| `noTargets` (silent drop) | `BROADCAST_NO_TARGET` | `BROADCAST_NO_TARGET` (userId=NULL) | MEDIUM |
| All targets failed (`delivered=0`, attempted>0) | `BROADCAST_SEND_FAIL` | `BROADCAST_SEND_FAIL` (userId=NULL) | MEDIUM |

**Schema change**: `audit_logs.userId` is now nullable. NULL = system-triggered audit (e.g. scheduled `DAILY_DIGEST` failures). `settings.ts` renders NULL as **"🤖 系统"** in the audit log viewer.

**Why audit system failures**: a scheduled broadcast that silently drops or fails is *more* operationally critical than a user-triggered one — there's no human to notice the missing message. This was an architect-fix on the original P1 design.

Rationale: production day-to-day broadcasts on a fully-configured system produce ZERO new audit rows. The moment env fallback or a delivery failure happens, ops gets a row with `event=...;proj=...;grp=...;targets=ctx_group_chat@GROUP_TABLE,...` for instant root-cause.

### `helpers.ts` — legacy shims removed

```diff
-import type { Context, Telegram } from "telegraf";
+import type { Context } from "telegraf";
-import { dispatchBroadcast } from "./dispatch.js";
-
-export async function notifyGroup(tg, text) { ... }
-export async function notifyChannel(tg, text) { ... }
```

### Migration pattern (canonical)

```ts
// before (P0):
await notifyGroup(ctx.telegram, text);

// after (P1):
const gid = await resolveGroupIdForProject(entity.projectId);
await dispatchBroadcast(
  ctx.telegram, "TASK_CREATE",
  { projectId: entity.projectId, groupId: gid, actorId: user.id },
  text,
);
```

For system-triggered events (no actor):

```ts
await dispatchBroadcast(tg, "DAILY_DIGEST", { actorId: null }, text);
```

## Verification

### Migration completeness audit (rg)

```
=== Residual notifyGroup/notifyChannel ===
artifacts/api-server/src/bot/helpers.ts
13: * After B3 P1: the legacy `notifyGroup` / `notifyChannel` shims are GONE.   ← comment only

=== LEGACY_GROUP/LEGACY_CHANNEL ===
artifacts/api-server/src/bot/routing.ts                                          ← type def kept
41:  | "LEGACY_GROUP" | "LEGACY_CHANNEL";
133: case "LEGACY_CHANNEL":                                                       ← exhaustive switch case
139: case "DAILY_DIGEST": case "DASHBOARD_PUSH_GROUP": case "LEGACY_GROUP":      ← exhaustive switch case

=== dispatchBroadcast call-sites ===
form-handler.ts: 8 · tasks.ts: 3 · projects.ts: 1 · requirements.ts: 1
bi.ts: 2 · reminders.ts: 1   →  total 16 emission sites
```

### P1 smoke (`routing-smoke-p1.mjs`, 6 scenarios)

```
✅ [S1] empty groups + env both: all 14 P1 events route correctly with fallbackUsed=true
✅ [S2] project→group binding: 5 events use ctx_group_chat (no fallback, no audit flood)
✅ [S3] FINANCE bypasses project group (no finance channel) → env_channel_id (stays in finance lane)
✅ [S4] FINANCE + project's financeReportChannelId set → ctx_group_finance_channel
✅ [S5] DAILY_DIGEST (system, no actor) → first_enabled_group_chat, audit auto-suppressed
✅ [S6] noTargets=true when groups[] + env both empty (audit writes BROADCAST_NO_TARGET MEDIUM)
```

### Bot health

```
[INFO] Server listening port: 8080
[INFO] Telegram bot started (long polling)
[INFO] Reminder scheduler started
```

## Behavior comparison: P0 vs P1

| Scenario | P0 behavior | P1 behavior |
|---|---|---|
| Empty groups table, env set | Routes via env (LEGACY_* shim) — no audit | **Same** routing, BUT every broadcast writes `BROADCAST_FALLBACK` LOW audit so ops can see env-fallback usage % trend |
| Group registered, no project binding | Routes to first enabled group | **Same** — `resolveGroupIdForProject(null)` returns null, falls through to `first_enabled_group_chat` |
| Group registered + `projects.groupId = X` | Still routed to first enabled group (LEGACY_* ignored projectId) | **Per-project routing now active** — TASK_CREATE for project X goes to project X's bound group |
| FINANCE_CREATE, only env GROUP_ID set | Already fixed in P0 architect patch — returns noTargets | **Same**, plus now writes `BROADCAST_NO_TARGET` MEDIUM audit |
| DAILY_DIGEST | Routes via env GROUP_ID (LEGACY shim) | Routes via DAILY_DIGEST event semantics; audit suppressed (system actor) |

## Design choices worth flagging

1. **`LEGACY_GROUP` / `LEGACY_CHANNEL` events kept in the union** — even though no call-site emits them anymore. Removing them now would force a coordinated drop with the comment in `routing.ts` that documents the migration arc. Cheaper to keep until P2 ships and we decide to retire env-fallback entirely.

2. **`projects.ts` two-sites-into-one** — slight readability tradeoff for cleaner audit (single dispatch call regardless of branch).

3. **`PROJECT_CREATE` always passes `groupId: null`** — the project was just inserted with no group binding; routing falls to `first_enabled_group_chat` or env. Correct: a brand-new project doesn't yet belong to any group; first enabled group is the right default.

4. **Audit-only on interesting outcomes** — chose this over per-broadcast audit to prevent `audit_logs` bloat. A team firing 50 task events / day on a fully-configured system gets 0 new audit rows; one misconfigured deployment instantly surfaces 50 `BROADCAST_FALLBACK` rows for diagnosis.

5. **Inline audit in `dispatch.ts`** instead of importing `writeAudit` from `helpers.ts` — avoids circular import (`helpers.ts` no longer imports from `dispatch.ts`, but inline insert is the cleaner direction).

## Architect-fix patch (same-batch)

P1's first architect review surfaced 2 enterprise-compliance gaps; both fixed in-batch:

| # | Gap | Fix |
|---|---|---|
| 1 | BI push call-sites passed `{}` ctx → `actorId` missing → dispatch-level audit skipped on operator-driven broadcasts | Pre-fetch `me` BEFORE `dispatchBroadcast` in `pushDashboardToGroup` / `pushDashboardToChannel`; pass `{ actorId: me?.id ?? null }`. Existing manual `BI_PUSH_*` audits remain (semantic UX events); now also get `BROADCAST_FALLBACK/NO_TARGET/SEND_FAIL` route forensics. |
| 2 | System events (`actorId=null`) skipped audit on ALL outcomes — including operationally-critical `NO_TARGET` / `SEND_FAIL` | Schema: `audit_logs.userId` → nullable. Dispatch policy: still skip audit for system happy-path/FALLBACK (would flood), but WRITE for NO_TARGET/SEND_FAIL with `userId=NULL`. `settings.ts` renders NULL actor as "🤖 系统". |

**P1-fix smoke (live DB)** — `audit-smoke-p1fix.mjs`:
```
✅ [1] audit_logs.userId accepts NULL — schema migration applied
✅ [2] Read path returns userId=null cleanly (settings.ts will render '🤖 系统')
✅ [3] settings.ts render: '🤖 系统'
✅ [4] cleanup ok
✅ [5] post-cleanup system-actor audit rows in DB: 0
```

## Pointers to next phase (P2)

- Build `MENU:GROUPS` admin UI: list groups, register new group via `tgChatId` + `chatType`, set `defaultReportChannelId` / `financeReportChannelId`, enable/disable, soft-delete.
- Wire `projects.ts::SETGROUP` to bind a project to a group (`projects.groupId = X`).
- After P2 deploys and ops validate `BROADCAST_FALLBACK` audit count = 0 for N days, env vars `TELEGRAM_GROUP_ID` / `TELEGRAM_CHANNEL_ID` can be removed (delete env-fallback branches in `routing.ts`).
- `LEGACY_GROUP` / `LEGACY_CHANNEL` event types can also be removed at that point (exhaustive switch will remind us).
