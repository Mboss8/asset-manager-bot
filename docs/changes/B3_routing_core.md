# B3 P0 — 播报路由内核 (routing core + groups 语义落地)

> 目标：把"散落在 14 个文件里的 `bot.telegram.sendMessage(GROUP_ID, ...)`" 升级为"统一事件总线 + 可治理的目标解析"。
> 范围：仅 P0（核心 + 内部接入），P1（call-site 迁移）/ P2（管理 UI）后续。

## 北极星

```
caller ── event + ctx ──► [getBroadcastTargets] ── BroadcastTarget[] ──► dispatch (sendMessage fan-out)
                                  ▲
                                  │
                          ┌───────┴───────┐
                       groups DB         env fallback
                    (P2 admin UI)     (TELEGRAM_GROUP_ID
                                       TELEGRAM_CHANNEL_ID)
```

## 三个新模块

### 1. `bot/routing.ts` — 纯函数路由内核

**硬契约（DO NOT BREAK）**：

1. **纯函数** — 无 IO、无时钟、无 env 读取，所有输入显式参数，单元可测
2. **永不静默丢消息** — 只要 env fallback 存在，无论 groups 表是否为空都返回 ≥1 个 target
3. **每个 target 携带 `reason`** — 稳定字符串枚举，audit 可追溯"为什么这条消息去了那个群"
4. **`source: GROUP_TABLE | ENV_FALLBACK`** — 让运维监控迁移进度，等比例归零后可下线 env 变量

**签名**：

```ts
function getBroadcastTargets(
  event: BroadcastEvent,    // 17 个事件，覆盖所有现存广播点
  ctx: BroadcastContext,    // { projectId?, groupId?, actorId? }
  groups: Group[],          // 调用方注入快照，pure
  env: { groupId?, channelId? },
): RoutingResolution        // { targets, fallbackUsed, noTargets }
```

**事件分类（17 个）**：

| 类别 | 事件 |
|---|---|
| 协作 (COLLAB) | TASK_CREATE / TASK_DONE / TASK_TRANSFER / PROJECT_CREATE / PROJECT_COMPLETE / PROJECT_RISK / REQ_CREATE / REQ_REVIEW / REQ_TO_TASK / DOC_CREATE / RISK_CREATE |
| 财务 (FINANCE_REPORT) | FINANCE_CREATE / FINANCE_REVIEW |
| 运维 | DAILY_DIGEST / DASHBOARD_PUSH_GROUP / DASHBOARD_PUSH_CHANNEL |
| 兼容 shim | LEGACY_GROUP / LEGACY_CHANNEL（P1 阶段消除） |

**路由优先级（自上而下，命中即停）**：

| 事件类 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| FINANCE_* | `groups[ctx.groupId].financeReportChannelId` | 任意 enabled 组的 `financeReportChannelId` | env CHANNEL_ID（视作 FINANCE_REPORT） | env GROUP_ID（last resort） |
| DASHBOARD_PUSH_CHANNEL / LEGACY_CHANNEL | `groups[ctx.groupId].defaultReportChannelId` | 任意 enabled 组的 `defaultReportChannelId` | env CHANNEL_ID | — |
| 其他（COLLAB / DAILY_DIGEST / LEGACY_GROUP） | `groups[ctx.groupId].tgChatId` | 第一个 enabled 组的 `tgChatId` | env GROUP_ID | — |

### 2. `bot/group-service.ts` — DB 加载层（30 s TTL 缓存）

```ts
listEnabledGroups(): Promise<Group[]>   // cached, sorted by id ASC
invalidateGroupsCache(): void           // 调用方在 groups 写入后必须调用（P2 admin UI）
```

排序按 `id ASC` 保证"第一个 enabled 组"在多进程间稳定。

### 3. `bot/dispatch.ts` — 运行时分发器

```ts
dispatchBroadcast(tg, event, ctx, text): Promise<DispatchResult>
// = await listEnabledGroups()
// → getBroadcastTargets(event, ctx, groups, env)
// → 遍历 targets fan-out sendMessage
// → 返回 { ok, attempted, delivered, resolution }
```

- `noTargets === true` 时输出 WARN 日志（不抛错，广播是 fire-and-forget 副作用）
- `fallbackUsed === true` 时输出 DEBUG 日志（迁移可见性）
- 每个失败 target 单独 WARN，包含 `{ event, target.reason }`

## 接入策略：零改动 call-site，立即生效

`helpers.ts` 的 `notifyGroup` / `notifyChannel` 改为 thin shim：

```ts
export async function notifyGroup(tg, text) {
  return (await dispatchBroadcast(tg, "LEGACY_GROUP", {}, text)).ok;
}
export async function notifyChannel(tg, text) {
  return (await dispatchBroadcast(tg, "LEGACY_CHANNEL", {}, text)).ok;
}
```

**效果**：

- 14 个 `notifyGroup` + 2 个 `notifyChannel` 调用点**零改动**
- 行为不变（groups 表空 → 走 env fallback，与 B3 之前完全一致）
- 一旦运维向 groups 表插入一条 enabled 行，所有广播立即开始用新群（无需重启、无需改代码）
- `BI:PUSH:CH/GR` 按钮、5 模块创建广播、reminders、project status 全部受益

P1 会逐个把 `notifyGroup(tg, text)` 升级为 `dispatchBroadcast(tg, "TASK_CREATE", { projectId, groupId }, text)`，从而启用 per-project 路由。

## 验证：14 场景 routing 纯函数烟测

通过 esbuild 临时打包 + node 直接 import `routing.ts`，对 `getBroadcastTargets` 进行黑盒断言：

```
✅ [1] empty+no-env → noTargets
✅ [2] empty+env → ENV_FALLBACK GROUP_ID
✅ [3] ctx.groupId → groups[].tgChatId (GROUP_TABLE)
✅ [4] no ctx → first enabled group chat
✅ [5] disabled & soft-deleted groups skipped → ENV_FALLBACK
✅ [6] FINANCE+ctx → ctx_group_finance_channel
✅ [7] FINANCE+no-ctx → any_group_finance_channel
✅ [8] FINANCE+no-finance-chan → ENV channelId as FINANCE_REPORT
✅ [9] FINANCE no-finance+no-env-channel → env_group_id last resort
✅ [10] DASHBOARD→CHANNEL → any_group_default_channel
✅ [11] DASHBOARD→CHANNEL no-group → env_channel_id
✅ [12] LEGACY_GROUP → groups table when present
✅ [13] LEGACY_CHANNEL → env channel when no groups
✅ [14] 9 events × empty groups + env → 0 silent drops (降级兜底 OK)

=== Routing smoke: 14/14 scenarios PASS ===
```

场景 [14] 是用户钉死的硬约束——"无 groups 表时的降级兜底"——已显式覆盖 9 个事件类别，确保新部署/迁移环境零静默丢播报。

## 文件清单

| 类型 | 文件 | 行数 |
|---|---|---|
| 新增 | `artifacts/api-server/src/bot/routing.ts` | 218 |
| 新增 | `artifacts/api-server/src/bot/group-service.ts` | 33 |
| 新增 | `artifacts/api-server/src/bot/dispatch.ts` | 73 |
| 改 | `artifacts/api-server/src/bot/helpers.ts` | -19/+22（shim 化） |
| 新增 | `docs/changes/B3_routing_core.md` | 本文件 |

## Typecheck & 启动

```
> tsc --build           Done   (libs)
> artifacts/api-server  Done
> artifacts/mockup-sandbox  Done
> scripts               Done

[INFO] Server listening port: 8080
[INFO] Telegram bot started (long polling)
[INFO] Reminder scheduler started
```

## Architect Code Review — 4 个 finding 全部当轮修复

| # | Finding | 修复 |
|---|---|---|
| 1 | **🔒 安全漏洞**：FINANCE 事件在无 finance channel + 无 env channel 时降级到 env GROUP_ID（普通协作群）→ 财务数字泄漏给非财务角色 | `routing.ts` 删除 FINANCE 分支的 env.groupId 兜底；返回 `noTargets=true` 强制运维配置专属财务频道 |
| 2 | **BI 短路 bug**：`pushDashboardToGroup/Channel` 在 dispatch 之前用 `if (!GROUP_ID)` 硬挡，导致 groups 表配置但 env 未设的部署无法手动推送 | `bi.ts` 移除 env 预检；改用 `dispatchBroadcast` 结果的 `noTargets` 判断；新增 `BI_PUSH_*_NO_TARGET` MEDIUM audit |
| 3 | **缺乏 exhaustive 检查**：未来新增 BroadcastEvent 可能静默落入 COLLAB 默认分支 | `routing.ts` 改用 `switch` + `const _exhaustive: never = event` —— 漏写 case 直接 TS2322 编译失败 |
| 4 | **P1 阻塞**：`projectId` 未被路由使用，call-site 无法做 per-project 路由 | 新增 `group-service.ts::resolveGroupIdForProject(projectId)` IO helper —— 保持 routing 纯函数 + 把 DB 查询挪到调用层；P1 模式：`const groupId = await resolveGroupIdForProject(t.projectId); dispatch(..., { projectId, groupId }, ...)` |

修复后烟测扩展到 **18 场景**（原 14 + FINANCE 安全 3 + 全 18 事件 exhaustive 验证）：

```
✅ [1-8] original scenarios still pass
✅ [9-FIX] FINANCE no-channel + only env.groupId → noTargets (security: no leak)
✅ [9b] FINANCE still uses env.channelId (proper finance destination)
✅ [9c] FINANCE no env at all → noTargets
✅ [10-13] dashboard + legacy shims unchanged
✅ [14] 8 non-finance events × empty groups + env → 0 silent drops
✅ [15] 18 events × fully-configured group → all routed via GROUP_TABLE
=== Routing smoke v2: ALL scenarios PASS ===
```

## 已知边界 / 留给后续

1. **per-project routing 未启用** — 所有 call-site 仍传 `LEGACY_GROUP` shim，等 P1 逐模块迁移后才能利用 `ctx.projectId` 走项目专属群
2. **缓存失效仅手动** — `invalidateGroupsCache()` 需在 P2 admin UI 写入 groups 表时显式调用；未调用则最多 30 s 延迟生效
3. **多 target fan-out 未启用** — 当前每个事件最多解析 1 target，但 `targets: BroadcastTarget[]` 已支持数组，未来"项目群 + 公告频道双发"可零改动启用
4. **audit 未接入** — `BROADCAST_DISPATCH` / `BROADCAST_FALLBACK_USED` 等审计事件留给 P2，避免 14 站点 × 每次广播刷屏

## P1 候选（下一轮）

按风险从低到高分批迁移 14 站点：

1. **第 1 批 — form-handler.ts 8 处**（创建类，最易补 ctx）
2. **第 2 批 — handlers/{tasks,projects,requirements}.ts 6 处**（含状态变更）
3. **第 3 批 — bi.ts 2 处 + reminders.ts 1 处**（含 LEGACY shim 移除）
4. **shim 卸载 + 旧 env 变量降级为兜底警告**
