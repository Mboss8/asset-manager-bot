# Historical Changelog

已稳定、不再活跃迭代的历史条目归档。最近 3-5 条仍在 `replit.md` 顶层 Changelog 里，便于 session 启动时快速定位上下文。

> **B3 P3.x 系列（路由表化 / invariants / custom emoji）保留在 `replit.md`，作为当前活跃的架构演进锚点。**

---

- **B3 P2.1 — 报告频道绑定** (2026-05-09)
  - 复用 `flows.ts` + `form-handler.ts` 单字段编辑模板（仿 DOC:EDITTAGS）
  - 新增 2 个 flow：`GROUP:SETDEFCH`（默认报告频道）/ `GROUP:SETFINCH`（财务频道），单步 text → confirm
  - 群组列表改版：每行一个 `👁 详情 #id` 按钮（更干净），TOGGLE 移到详情页
  - 新增 `showGroupView`：展示 chat_id + 启用状态 + 两个频道当前绑定，4 个动作按钮（启停 / 设置或清除两频道）
  - 新增 `handleGroupClearChannel(kind: "DEF"|"FIN")`：清除单个频道绑定
  - 新增 5 个 permissions key（全 ADMIN_ONLY）+ 5 个 index.ts 路由分支
  - 4 条新 audit：`GROUP_SET_DEFAULT_CHANNEL` / `GROUP_CLEAR_DEFAULT_CHANNEL` / `GROUP_SET_FINANCE_CHANNEL` / `GROUP_CLEAR_FINANCE_CHANNEL`，全 MEDIUM
  - **AppSec 4 finding 当轮全修**：
    - HIGH — flow 完成时**重检角色**（`canExecuteAction(role, aclKey)`），堵 stale-session 提权（router 网关只在入口拦，FORM:SELECT 提交路径绕过路由 ACL）
    - MEDIUM — channel_id 校验加 PG bigint 范围（`>= -2^63`）+ 强制 `-100` 前缀（Telegram 频道/超级群规范）
    - LOW-1 — 拒绝绑定到任何已注册群的 `tg_chat_id`（含自身），堵广播泄漏到协作群
    - LOW-2 — SET 用 conditional UPDATE `WHERE isEnabled=1` + 检查 returning 行数，并发 disable 不会留下"禁用群仍挂着活频道"
  - typecheck 全绿 + 启动干净；3 角色全程：dev 写 / QA 跑通 / AppSec 审；1 HIGH + 1 MEDIUM + 2 LOW 当轮全修

- **B3 P2 — 群组绑定管理 UI（disable-only）** (2026-05-09)
  - 新增 `handlers/groups.ts`（群注册/列表/启停）+ `handlers/project-groups.ts`（项目↔群绑定 picker）
  - 入口：⚙️ 系统设置 → 📡 群组绑定（ADMIN_ONLY），下设 📋 群组列表 / 📁 项目绑定
  - **`/register` 命令**：必须在目标群里发，私聊会被引导拒绝；OWNER/ADMIN 鉴权先于 upsert；用 `onConflictDoUpdate(target=tgChatId)` 重启用并清 `deletedAt`，无需 schema 改动
  - **disable-only 策略**：无 DEL 出口；禁用走 `is_enabled=0`，立即 invalidate 30s 缓存 → routing.ts 自动停发
  - **HIGH-1 修复（AppSec）**：`handleGroupToggle` 禁用走原子 conditional UPDATE（`WHERE NOT EXISTS (SELECT 1 FROM projects WHERE group_id=? AND deleted_at IS NULL)`）+ 检查 `returning().length`，杜绝 check-then-update 间被 PROJ:SETGROUP 抢先绑定的 TOCTOU
  - **HIGH-2 修复(AppSec)**：`showProjectCard` 渲染 `proj.name` / `proj.description` / `ownerName` 全部 `escapeHtml()`（pre-existing 漏洞，借此 P2 一并修）
  - **绑定校验**：`handleProjectGroupBind` 拒绝绑到 `isEnabled !== 1` 的群（避免立刻退化到 fallback）
  - 5 条 audit：`GROUP_REGISTER` / `GROUP_ENABLE` / `GROUP_DISABLE` / `PROJECT_SET_GROUP` / `PROJECT_UNBIND_GROUP`，全 MEDIUM
  - 新增 7 个 permissions key：`M:GROUPS` / `GROUPS:LIST/TOGGLE/PROJ` ADMIN_ONLY；`PROJ:CHGROUP/SETGROUP/UNBINDGROUP` PM_OR_ADMIN
  - 项目卡片新增 📡 绑定群按钮（PM_OR_ADMIN 守卫）+ 显示当前绑定 group_id
  - typecheck 全绿 + 启动干净；DB schema 已就位（无需 push）；3 角色流程：dev 写 / QA 跑通 / AppSec 审；2 HIGH 当轮全修

- **B3 P1 — 调用点全量迁移到强类型 dispatchBroadcast** (2026-05-09)
  - 17 处广播调用全部迁移：form-handler 8 + tasks 3 + projects 1 + requirements 1 + bi 2 + reminders 1 = 16 emission sites（projects 双分支合并 1 处）
  - 每个 user-triggered 广播现在携带 `{ projectId, groupId: await resolveGroupIdForProject(projectId), actorId }` —— **per-project 路由能力激活**：项目 X 绑定 group Y 后，X 的 TASK_CREATE/REQ_CREATE/FINANCE_CREATE 等事件自动播到 Y
  - `dispatch.ts` 新增**分级自动审计**：GROUP_TABLE 成功不写 audit（防泛滥）；ENV_FALLBACK 写 `BROADCAST_FALLBACK` LOW（监控 env 退场进度）；`noTargets` 写 `BROADCAST_NO_TARGET` MEDIUM；全部 send 失败写 `BROADCAST_SEND_FAIL` MEDIUM。details 字段含 `event;proj;grp;targets=reason@source` 全要素
  - DAILY_DIGEST 系统事件传 `actorId: null`：happy-path/FALLBACK 跳过审计（防泛滥），但 **NO_TARGET / SEND_FAIL 仍写审计**（`userId = NULL`，settings.ts 渲染为 "🤖 系统"）—— 调度广播失败比用户广播失败更需要被看见
  - **`audit_logs.userId` 改为可空**（schema push），settings.ts 阅读器同步 null-safe
  - **架构师当轮 review 2 个 finding 全修**：(1) BI 推送预取 `me` → 操作员触发的广播也带 actorId；(2) 系统事件失败路径写审计而非全跳
  - **`helpers.ts::notifyGroup` / `notifyChannel` shim 物理删除**；finance.ts 残留未用 import 也清掉
  - LEGACY_GROUP/LEGACY_CHANNEL 仅保留为 BroadcastEvent 类型成员（exhaustive switch 防遗漏）；P2 admin UI 上线后退役 env fallback 时一并删
  - 6 场景 P1 smoke 全过：empty-env 兜底 / 项目群路由 / FINANCE 不串到 collab 群 / FINANCE 项目专属 / DAILY_DIGEST 无审计 / noTargets 触发审计
  - 详见 `docs/changes/B3_P1_callsite_migration.md`

- **B3 P0 — 播报路由内核** (2026-05-09)
  - 新增 `bot/routing.ts` 纯函数路由内核（pure / no-IO / 单元可测）：`getBroadcastTargets(event, ctx, groups, env)` 返回 `{ targets, fallbackUsed, noTargets }`
  - 新增 `bot/group-service.ts`（30 s TTL 缓存）+ `bot/dispatch.ts` 运行时分发器
  - 17 个事件类别：COLLAB / FINANCE_REPORT / 运维 / LEGACY shim
  - **零改动** 14 个 `notifyGroup` + 2 个 `notifyChannel` 调用点 — 通过 `helpers.ts` shim 自动接入；groups 表空时走 env fallback，行为完全不变
  - 一旦 groups 表注册一条 enabled 行，所有广播立即切换到新群（无需重启、无需改代码）
  - 18 场景 routing 烟测全过（降级兜底硬约束 + 全事件 exhaustive 覆盖）；详见 `docs/changes/B3_routing_core.md`
  - **架构师 review 4 个 finding 当轮全修**：FINANCE 安全漏洞（不再降级到 collab 群）、BI 短路 bug、exhaustive switch、P1 助手 `resolveGroupIdForProject()`
  - P1（call-site 升级到强类型 event/ctx）+ P2（管理 UI）后续

- **B2.2 — 软删动作全模块接入** (2026-05-09)
  - 5 模块新增 `MOD:DEL` 软删入口（TASK / REQ / FIN / DOC / PROJ），详情卡 🗑 按钮 + index.ts 路由 + permissions.ts 5 keys（FIN=`FINANCE_OR_ADMIN`，余 `PM_OR_ADMIN`）
  - 文档原 `DOC:DEL` 物理删重命名为 `DOC:PURGE`（ADMIN_ONLY，audit `DOCUMENT_PURGE` HIGH），让出 DEL 名给软删
  - 三轨道语义定型：ARCH（业务归档）/ DEL（回收站软删）/ PURGE（永久删除）
  - 所有 DEL 写入 `where(and(eq(id), notDeleted(table)))` → 应用层幂等
  - PROJ:DEL 不级联子任务；下游 `notDeleted(projects)` join 自然过滤孤儿
  - 详细审计文档：`docs/changes/B2_softdelete_actions.md`
  - DB 冒烟 5/5 模块通过 + typecheck 全绿

- **B2.1 — 回收站 UI** — 列表 + 恢复（ADMIN_ONLY，audit `TRASH_RESTORE` MEDIUM）

- **B1 — 软删基建** — `deletedAt` 字段 + `notDeleted()` / `onlyDeleted()` 守卫；详见 `docs/changes/B1_softdelete_audit.md`
