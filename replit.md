# TG Internal Ops Bot

内部协作 Telegram 机器人，集成项目管理、任务中心、需求池、文档沉淀、资金动向、数据看板、成员权限管理等功能。

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — 运行 API 服务器（端口 5000），同时启动 Telegram Bot
- `pnpm run typecheck` — 全量类型检查
- `pnpm run build` — 类型检查 + 构建所有包
- `pnpm --filter @workspace/db run push` — 推送 DB Schema（开发用）
- Required env: `DATABASE_URL` — Postgres 连接字符串
- Required secret: `TELEGRAM_BOT_TOKEN` — Telegram Bot Token（从 @BotFather 获取）
- Optional env: `TELEGRAM_GROUP_ID` — 协作群组 ID（创建任务/项目/需求/财务时自动播报；每日提醒推送目标）
- Optional env: `TELEGRAM_CHANNEL_ID` — 公告频道 ID（数据看板"📢 推送到频道"按钮）
- Optional env: `DIGEST_HOUR` / `DIGEST_MINUTE` — 每日提醒推送时间（默认 09:00，服务器时区）

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot: Telegraf 4 (long-polling)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/` — 机器人核心逻辑
  - `index.ts` — 主入口，callback_data 路由
  - `menus.ts` — 所有菜单定义（含权限过滤）
  - `flows.ts` — 多步表单流程定义
  - `form-handler.ts` — 表单状态机处理
  - `permissions.ts` — RBAC 权限系统
  - `session.ts` — 会话管理（存 DB）
  - `helpers.ts` — 公共工具函数
  - `user-service.ts` — 用户 CRUD
  - `search.ts` — 全局搜索
  - `reminders.ts` — 每日提醒调度器（逾期/今日截止任务、待评审需求、待审报销）
  - `handlers/` — 各模块处理器（tasks/projects/requirements/finance/documents/bi/members/settings）
- `lib/db/src/schema/` — 数据库表结构
  - `users.ts`, `groups.ts`, `projects.ts`, `tasks.ts`, `requirements.ts`, `documents.ts`, `finance.ts`, `audit_logs.ts`, `bot_sessions.ts`
- `artifacts/api-server/src/bot/serial-generator.ts` — 业务流水号生成器（T/R/F/D/LEDGER 前缀，按月递增）

## Architecture decisions

- 使用 Telegraf long-polling（无需公网 webhook URL），适合 Replit 开发环境
- 会话状态（多步表单）存 PostgreSQL，支持重启后恢复
- 第一个注册的用户自动成为 OWNER
- callback_data 遵循 `模块:动作:ID` 格式，最多4段
- RBAC 权限分 6 级：OWNER > ADMIN > PM > FINANCE > MEMBER > GUEST

## Product

- `/start` 或 `/menu` 进入主控面板
- 8 大模块：项目管理、任务中心、需求池、文档沉淀、资金动向、数据看板、成员/权限、系统设置
- 多步表单创建任务/项目/需求/财务记录
- 角色权限控制，不同角色看到不同按钮
- 全局搜索（任务/项目/需求/文档）

## User preferences

- 界面语言：中文
- 权限模型：RBAC，6 级角色

## Routing discipline (B3 P3+)

系统已分三层（Flow / Route / Permission），未来 session 严守以下铁律，违反必须在 PR 描述里显式说明：

- **R1 — ACL 职责不重叠**：`FlowDef.acl` = 提交闸门（防 stale-session 提权）；`Route.acl` = 入口闸门（防越权调用）；`ACTION_PERMISSIONS` = 唯一权限语义来源。**禁止**在 handler 里再手写 `canExecuteAction()`（已被 router/submitForm 统一接管）。新增特权流/路由 = 加一行声明，不是加一段判断。
- **R2 — switch 单调收缩**：`index.ts` 的遗留 `switch(module)` 行数**每轮必须递减**（不是稳定，是递减）。新模块**禁止**写进 switch；遗留模块每轮迁出 ≥1 个。Phase 3 入口判据：`switch < 200 行` AND `ROUTE_TABLE 覆盖 > 60%`。
- **R3 — guard 不可分散**：preflight（DB 存在性 / 业务前置校验）当前临时写在 route handler 内是允许的；但**禁止引入第三种 routing 抽象**。未来若收口为 `guard: { acl, preflight?, validate? }`，必须在 router-table.ts 一处实现，不再开新文件/新机制。
- **Phase 2 边界冻结**：`router-table.ts` / `routes/*` 的 DSL 形态在 Phase 3 全模块迁移完成前**不再扩展**（不加 `route.add()` 流式 API、不加事件总线、不加类型推导 DSL）。先把 if-else 收完，再谈框架化。
- **R4 — 启动期不变量是唯一守门狗**：`bot/invariants.ts::assertInvariants()` 在 `createBot()` 顶部跑，违反 R1（ACL 漂移）直接崩；违反 R2（switch 增长）CI 崩、本地 warn。新增第 5/6/N 条断言**只允许加在 `invariants.ts`**，不开新文件、不加新 lint 框架。**禁止**绕过断言（如把 `assertInvariants()` 注释掉、加 `if (process.env.SKIP_INVARIANTS)` 之类的开关）。每次模块从 switch 迁出后必须同步**降低** `SWITCH_CASE_BASELINE`（INFO 日志会提示具体数字）。

## Conventions

- **流水号**：tasks/requirements/finance/documents 创建时会自动写入 `serial_no`（如 `T-202605-0001`），通过 `generateSerialNo(prefix)` 生成
- **三条删除轨道**（B2.2 起）：
  - **归档 (ARCH)** — `isArchived = 1`，从待办淡出，仍在归档列表可见。callback `MOD:ARCH:<id>`，权限 `PM_OR_ADMIN`/`FINANCE_OR_ADMIN`。
  - **删除 (DEL)** — `deletedAt = NOW()`，移入回收站可恢复。callback `MOD:DEL:<id>`，权限同 ARCH。所有 DEL 写入必须 `where(and(eq(id), notDeleted(table)))` 以保证幂等。
  - **彻底删除 (PURGE)** — 物理 `db.delete(table)`。仓库唯一硬删出口：`form-handler.ts` 的 `case "DOC:PURGE"` 流程（callback `DOC:PURGE:<id>`，权限 `ADMIN_ONLY`）。其他模块当前**无 PURGE 出口**，待 B2.3 在回收站内挂载。
- **读路径 `notDeleted()` 强制约定**：所有读查询必须 `where(and(..., notDeleted(table)))`（见 `lib/db/src/soft-delete.ts`）。`onlyDeleted(table)` 用于回收站列表。
- **Audit action 命名**：`<MODULE>_<VERB>` 全大写下划线（如 `TASK_DELETE` / `FINANCE_DELETE` / `DOCUMENT_PURGE` / `TRASH_RESTORE`）。Level：MEDIUM 软删/恢复，HIGH 财务敏感+物理删。
- **群组路由**：`groups` 表已就位，可承载"项目专属播报群/财务专用频道"等多群路由能力（当前仍走单一 `TELEGRAM_GROUP_ID` env）

## Gotchas

- 构建后重启才能生效：修改代码后需重新 build + restart workflow
- Bot 使用 long-polling，不需要配置 webhook
- 第一个 /start 的用户获得 OWNER 权限

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

## Changelog

- **B3 P3.4 — switch 收敛续：BI 模块迁出到路由表（11 条路由 + 4 条 catch-all）** (2026-05-10)
  - **switch shrinkage（R2 推进）**：`index.ts` 的 `case "BI"`（10 个内层 case + default：DAILY/MINE/WEEKLY/HEALTH/RISK/FIN/REPORT/PUSH/PUSH:CH/PUSH:GR/DIGEST）整体迁出到 `routes/bi.ts`（11 条业务路由 + 4 条 catch-all = 15 条）。`index.ts` switch case 数 **65 → 55**（-10），`SWITCH_CASE_BASELINE` 同步压到 55；`ALL_ROUTES` 总数 32 → 47。覆盖率 4/10 模块（GROUPS + BI + MEM + TRASH），下一轮挑 SET（量级类似 ~8 case）继续推
  - **BI 迁移要点**：
    - **`BI:FIN:<offset?>` 用 str 不用 int** —— 月度资金流允许负 offset（`BI:FIN:-1` 看上月），router `<int>` matcher 严格 `/^\d+$/` 会拒掉负数；改用 `<str>` 占位 + handler 内 `parseInt`/`isNaN` 兜底，保留 legacy 行为
    - **`BI:RISK:<offset:int?>`** —— 风险预警分页 offset 上游 `Math.max(0, ...)` 钳过，安全用 `:int`
    - **`BI:PUSH` 三态拆三路由** —— bare（submenu，pre-ack）/ `:CH`（推频道，self-ack）/ `:GR`（推群组，self-ack），CH/GR 显式 `acl: "BI:PUSH"` + `preAck: false`，与 legacy `if/else if/else` 三段语义一一对应
    - **`BI:DIGEST` 自 toast** —— `preAck: false` + 内部 `ctx.answerCbQuery("📅 推送中…")`，多步异步保留 inline（reminders/helpers/user-service 全 lazy import）
    - **catch-all 4 段全覆盖** —— `BI` / `BI:<a>` / `BI:<a>:<b?>` / `BI:<a>:<b>:<c?>` 全部 `acl: "M:BI"`（ALL_USERS），匹配 legacy `default: showMenu(ctx, "M:BI", role)` 的角色过滤 submenu 行为
  - **import 清理**：`index.ts` 顶部 10 个 BI handler 名（showDailyOverview / showMyDashboard / showWeeklyProgress / showProjectHealth / showRiskAlert / showMonthlyFinBI / generateWeeklyReport / showPushMenu / pushDashboardToChannel / pushDashboardToGroup）全部删除（已下沉到 routes/bi.ts lazy import）；`getUserByTelegramId` 仍在其他路径用，保留
  - **架构师 review PASS**：3 项 parity（FIN 负 offset / PUSH 三态 / DIGEST self-ack）+ ACL 全部对得上；建议（未做）下一轮加 BI 回调 smoke test 矩阵锁回归
  - **R1/R2/R3/R4 守边界冻结**：纯增量 `routes/bi.ts` + 1 行 `ALL_ROUTES` 聚合；`router-table.ts` DSL 不动；invariants/FLOWS/ACL 表零改动；`SWITCH_CASE_BASELINE` 按 R4 纪律同步压到 55
  - 启动确认：`r1a/r1b/r1c:"ok" r2:"ok(55)" flows:17 routes:47 mappedEmojis:84`；typecheck 全绿

- **B3 P3.3 — switch 收敛续：MEM + TRASH 迁出到路由表 + Android pack 主导 custom-emoji** (2026-05-10)
  - **switch shrinkage（R2 推进）**：`index.ts` 的 `case "MEM"`（10 个内层 case，actor 预取 + 8 个 sub-action handler）+ `case "TRASH"`（if/else 三段，type/RESTORE/PURGE）整体迁出到 `routes/members.ts`（13 条路由）+ `routes/trash.ts`（7 条路由）。`index.ts` switch case 数 **77 → 65**（-12），`SWITCH_CASE_BASELINE` 同步压到 65；`ALL_ROUTES` 总数 11 → 31。Phase 3 入口判据（switch < 200 行 AND ROUTE_TABLE 覆盖 > 60%）：switch 行数尚可、覆盖率 3/10 模块（GROUPS + MEM + TRASH），下一轮挑 BI 或 SET（量级类似）继续推
  - **MEM 迁移要点**：`actor` 预取从模块入口下沉到 `loadActor()` helper，按需在 USER/SETROLE/BLACKLIST/UNBLACKLIST 4 个真用 actor 的 handler 内 lazy 加载（admin 已过 ACL 闸门，找不到 actor 是防御性兜底而非热路径）。`MEM:NOOP` 走 `preAck:false` 自带 toast 文案；`MEM:SETROLE` 用 `<id:int>:<newRole>` 双段占位严格匹配。三条 catch-all 保留遗留 `MEM:<unknown>` → submenu 回退语义
  - **TRASH 迁移要点**：`isTrashType()` enum 校验留 handler 内（router 模式语法只有 `int`/`str` 两种类型约束，无 enum）；`TRASH:PURGE` 路由声明但 stub 返回"暂不支持永久删除" toast，与 B2.2 阶段 A 决策一致（物理删唯一出口仍是 `DOC:PURGE` flow）。4 条 catch-all 覆盖 `TRASH` / `TRASH:<a>` / `TRASH:<a>:<b?>` / `TRASH:<a>:<b>:<c?>`，全部用 `acl: "TRASH:LIST"`（ADMIN_ONLY）防 fail-open
  - **import 清理**：`index.ts` 顶部 `showMemberList` / `showAclPanel` / `handleMemberAction` / `showUserCard` / `showRoleHub` / `showPolicyMatrix` / `startMemberSearch` / `saveSession` / `showTrashList` / `handleTrashRestore` / `isTrashType` 全部删除（已下沉到 routes 内 lazy import），仅留 `runMemberSearch`（仍在 form 文本路径用）
  - **R1/R2/R3/R4 守边界冻结**：纯增量 routes/* + 1 行 `ALL_ROUTES` 聚合；`router-table.ts` DSL 不动；invariants/FLOWS/ACL 表零改动
  - **custom-emoji 同步换主力 pack**：从 `tgiosicons` (iOS) 切到 `TgAndroidIcons` (Android) 为主，48 直接命中 + 24 视觉等价（🚫 forbidden 收 ⛔📵☠️；🔄 cycle 收 ♻️💱；📅 calendar 收 📆🗓；🥇 medal 收 🏆🥈🥉；➕/➖ pair 取 pack 内 ➕ 同 key 的两个 sticker 变体）；11 个跨 pack 回落 iOS（↩️ ⏳ ⏸ ▶️ 🌴 🎯 💡 📣 🧩 + 🔴/🔵/🟡 trio 因 Android 只有 🔴 单切会破坏色彩信号一致性故全留 iOS）；🌿 herb 继续 Unicode（两 pack 都没收）。`mappedEmojis: 84`
  - 启动确认：`r1a/r1b/r1c:"ok" r2:"ok(65)" flows:17 routes:31 mappedEmojis:84`；typecheck 全绿

- **B3 P3.2.1 — custom-emoji follow-up：prototype patch 修复 + 视觉等价覆盖到 82/84** (2026-05-10)
  - **BLOCKER bug 修复（用户实测发现）**：P3.2 的 `bot.telegram.callApi` **实例**级 patch 完全不生效 —— Telegraf 4.16.3 `handleUpdate` (telegraf.js:228) 对每条 update 都 `new Telegram(token, options, webhookResponse)` 起一个全新实例传给 Context，`ctx.reply` / `ctx.editMessageText` 走的全是没打 patch 的 callApi。表现：bot 收到 update 但不发任何回复（`[DIAG] handler completed cleanly` 但 0 次 callApi 出口）。修法：把 patch 从实例搬到 prototype（`Object.getPrototypeOf(bot.telegram).callApi`），所有 Telegram 实例共享。`__customEmojiInstalled` marker 同步搬到 prototype 保持幂等
  - **iOS 图标覆盖率 47 → 82/84（96%）**：原方案只匹配 pack 里 emoji 字段精确等于 bot emoji 的条目，185 个 pack 键 ∩ 84 个 bot emoji 只交出 47 个；新方案两步走：(1) 把 pack 键和 bot emoji 都做 VS-16 (U+FE0F) 归一化，自动救回 `ℹ️` 等 1 个；(2) 手工建 32 条**视觉等价覆盖表** —— Telegram 渲染按 custom_emoji_id 取图标、不看原始 emoji 是什么，所以可以让多个语义相近的 Unicode emoji 共用同一个 id：🥈🥉→🥇 medal、🔴🔵🟡→⭕ outline circle、⛔📵☠️→🚫 forbidden、⚠️🚨→❗️、♻️💱🔄→cycle、📅📆🗓→calendar、🔙→⬅️、🔍→🔎、🌴→⛱️、🚀→✈️、🚧→🪧、💾→📦、📚→📖、📡→🛜、📨→📤、📭→📥、🆔→👤、🏆→🥇、🏢→🏠、📋🗃→🗂、🗄→📁、🔥→⚡、⏳→⌛️、🔧 等。3 个真无解（⏸ pause、➖ minus、🌿 herb）继续 Unicode 兜底
  - **按钮 text 剥前缀 emoji（v2b 落地）**：`enhanceButton` 在挂上 `icon_custom_emoji_id` 后，把 text 前导的 emoji + 可选 VS-16 + 可选单空格剥掉，避免 `[iOS-icon][unicode-emoji][label]` 三件套视觉重复。用户原话："好丑"。剥的是 send-time payload，原始 menus.ts 字符串没动，每次 fresh markup 重建，无跨发泄漏
  - **DIAG 临时日志清理**：`[DIAG] callApi entry` / `[DIAG] button enhancement applied` / `[DIAG] incoming update` / `[DIAG] handler completed cleanly` 全部移除；`bot.catch` 顶层错误 guard 保留（Telegraf 默认把 handler 异常吞进 debug-only 日志，留个网兜后悔药）
  - **R1/R2/R3/R4 守边界冻结**：纯 lib + index.ts 1 行接入；invariants/FLOWS/ROUTES/ACL/switch baseline 全零改动
  - 启动确认：`mappedEmojis: 82` + `r1a/r1b/r1c:"ok" r2:"ok(77)" flows:17 routes:11`；typecheck 全绿；用户端实战验证
  - **遗留**：(v2a) HTML→entities mini-parser 让消息体也享受 iOS 化（按钮已全覆盖）；(v3) `scripts/refresh-emoji-pack.mjs` 把 pack 拉取脚本化（当前手工跑 getStickerSet）

- **B3 P3.2 — Telegram custom emoji 注入层（Bot API 9.4 / pack `tgiosicons`）** (2026-05-10)
  - 新建 `lib/custom-emoji.ts`（~330 行）：单点 monkey-patch `bot.telegram.callApi`，对所有出站消息透明注入 iOS 风格 custom emoji，**0 处 handler 改动**
  - 47/85 emoji 覆盖率（55%）—— pack `tgiosicons` 含 185 个 fallback emoji，与 bot 在用 85 个交集 47 个；缺的 38 个（🔙 ⚠️ ⛔ 🚨 🔴 🟡 🟢 等）多为颜色信号灯/方向键，pack 没收，落回 Unicode
  - **两面注入**：
    - **按钮（icon_custom_emoji_id，Bot API 9.4 新增）**：扫 `reply_markup.inline_keyboard`，按钮 text 以映射 emoji 起始 → 自动加 `icon_custom_emoji_id`。Premium owner 看到 iOS 风格按钮图标，非 Premium 客户端忽略该字段，零损耗
    - **消息体（custom_emoji entities）**：扫 `text` / `caption`，按 UTF-16 code unit 计算 offset/length（JS string 索引天然吻合），按 offset 升序排序后下发
  - **三层防御**：
    - **parse_mode 互斥守卫**（架构师 review 1 BLOCKER 当轮全修）：bot 几乎全用 `parse_mode: "HTML"`，spec 上 `entities` 与 `parse_mode` 互斥，同时塞会被 Telegram 丢弃或拒收。修法：`payload.parse_mode` 在场时**跳过** text/caption entity 注入（按钮独立，照常注入）。代价：HTML 消息体的 emoji 暂不享受 iOS 化，留给 v2 写 HTML→entities 解析器；收益：按钮全覆盖 + 不破现有消息
    - **Premium 缺失自降级**：catch API error → `PREMIUM_ERR` 正则匹配（`/premium|custom.?emoji|EMOJI_INVALID|BOT_LACKS|FORBIDDEN.*emoji/i`）→ `disableEnhancements()` + `stripEnhancements()` 剥离后**重试一次**，进程内永久切纯 Unicode；owner Premium 过期不会让用户看到崩溃
    - **idempotent install**：`tg.__customEmojiInstalled` 标记，重复调用安全跳过
  - **架构师 review 3 finding 当轮处理**：BLOCKER #1 parse_mode 冲突已修；MEDIUM #2 entity offset 排序已加 `out.sort((a,b)=>a.offset-b.offset||b.length-a.length)`；LOW #3 不深拷贝 payload（已加注释说明：handlers 每次构 fresh markup，无跨发泄漏风险）
  - **R1/R2/R3/R4 守 Phase 2 边界冻结**：纯增量 lib + 1 行 `installCustomEmojiWrapper(bot)` 接入；`assertInvariants()` / FLOWS / ALL_ROUTES / ACTION_PERMISSIONS 全部零改动；switch baseline 仍 77；不引入新 routing 抽象、不开 event bus、不动 ACL 表
  - **Telegraf 4.16.3（npm latest）typings 没跟 9.4**：HTTP 透传层接受未知字段，通过 `as any` cast 直接塞 `icon_custom_emoji_id` / `custom_emoji` entity type；Telegraf 升级后去 cast 即可
  - 启动日志确认：`r1a/r1b/r1c:"ok" r2:"ok(77)" flows:17 routes:11` + `[custom-emoji] wrapper installed mappedEmojis:47`；typecheck 全绿；Premium owner 端实战验证 by user
  - **后续路径**：(v2a) 写 HTML→entities mini-parser 让 HTML 消息体也能注入 custom_emoji；(v2b) 按钮 text 剥离前缀 emoji 避免 [icon][emoji][text] 视觉重复；(v3) `scripts/refresh-emoji-pack.mjs` 自动化 pack 拉取脚本

- **B3 P3.1 — 启动期不变量守卫（policy enforcement at boot boundary）** (2026-05-10)
  - 新建 `bot/invariants.ts`（116 行）：`assertInvariants()` 在 `createBot()` 顶部一次性运行 4 条架构断言，把 R1/R2/R3 从 chat 共识压成 runtime guardrail
    - **R1-A** `assertFlowAclExists` — `FLOWS` 中每条流必须显式声明 `acl`（即使 ALL_USERS 流也要写出对应 action key，禁止隐式白名单）。**强化做法**：`FlowDef.acl` 由 `string?` 改为 `string` 必填，5 个 ALL_USERS 流（TASK:NEW / REQ:NEW / DOC:ADD / FIN:REIMB / PROJ:RISK）补上 `acl: "<canonical key>"`，TS 编译期 + 运行期双重把关
    - **R1-B** `assertNoOrphanFlowAcl` — `FlowDef.acl` 引用的 key 必须存在于 `ACTION_PERMISSIONS`，防 typo / ghost flow / 漂移；orphan 时 `logger.error({ flow, missingKey })` 结构化日志后 throw
    - **R1-C** `assertRouteAclResolvable` — `ALL_ROUTES` 每条路由的有效 ACL（声明 `r.acl` 或派生 `parts[0]:parts[1]`）必须在 `ACTION_PERMISSIONS`；orphan 同 R1-B 写 ERROR 日志后 throw
    - **R2** `assertSwitchShrinkage` — 读 `src/bot/index.ts` 统计 `case "..."` 数量，与 `SWITCH_CASE_BASELINE = 77` 比较：增长 → CI 模式 throw（`process.env.CI === "true"`），本地 warn；递减 → INFO 提示更新 baseline。源码不可达时静默跳过（兜底生产环境只发 dist 的场景）
  - **架构意义**："共识写进系统，不写进记忆" —— 未来 session 不读 replit.md 也会被启动期断言拦下；R1/R2/R3 从纸上规则升级为不可违反的物理定律
  - `form-handler.ts::submitForm` 的 ACL 检查从 `flowDef?.acl && ...` 简化为 `flowDef && ...`（`acl` 已强制必填，optional chaining 是 dead code）
  - **刻意未做**（守 Phase 2 边界冻结）：(1) 不引入 `route.add()` 流式 DSL；(2) 不引入 event bus；(3) 不把 invariant 失败写 `audit_logs`（架构师建议下一步做，但本轮只压最小可用面）
  - **架构师 review 1 MEDIUM 当轮全修**：R2 源文件路径原本是 `process.cwd()/src/bot/index.ts`，从 repo root 启动会静默跳过 → guardrail 失活。修法：抽 `findSwitchSource()` 按优先级探 4 条候选路径（`import.meta.url` 锚定的 `dist/../src/bot/index.ts` 优先 → cwd 兜底两条），全失败时 CI 模式 throw、本地 warn；同时把每个 invariant 的执行状态写进启动日志（`r1a/r1b/r1c/r2: "ok(77)" | "skipped"`），让操作者一眼看见 R2 是真跑了还是跳过了
  - 启动日志确认：`r1a:"ok" r1b:"ok" r1c:"ok" r2:"ok(77)" flows:17 routes:11`
  - typecheck 全绿；boot smoke 2 次通过；下一轮迁出任一模块时同步把 `SWITCH_CASE_BASELINE` 改小

- **B3 P3 — if-else → 规则驱动 收敛（Phase 1 + Phase 2 样板）** (2026-05-10)
  - **Phase 1（FLOW.acl 表驱动 stale-session 防护）**：`flows.ts` 新增 `FlowDef.acl?: string`；为 12 个特权流挂上 ACL key（`PROJ:NEW` / `REQ:APP/REJ` / `DOC:EDITTAGS/PURGE` / `FIN:IN/OUT/PASS/FAIL` / `PROJ:NEWMILE` / `GROUPS:SETDEFCH/SETFINCH`）；ALL_USERS 流（`TASK:NEW` / `REQ:NEW` / `DOC:ADD` / `FIN:REIMB` / `PROJ:RISK`）显式留空。`form-handler.ts::submitForm` 顶部统一 `canExecuteAction(role, flowDef.acl)` 复检 + `clearSession` + 拒绝；**删除 P2.1 那段 `case "GROUP:SETDEFCH/SETFINCH"` 内手写的 HIGH 修复**（彻底泛化为数据驱动）
  - **Phase 2（callback 路由表化 — 基础设施 + GROUPS 样板）**：
    - 新建 `bot/router-table.ts`（76 行）：`Route` 类型 + 模式语法（字面段 / `<name>` / `<name?>` / `<name:int>` / `<name:int?>`）+ `tryDispatch()` 统一 ACL 闸门 + ack 语义 + 错误捕获
    - 新建 `bot/routes/groups.ts`（10 条路由数据，含 2 条 catch-all 保留遗留 `GROUPS:<unknown>` → 菜单回退语义）+ `bot/routes/index.ts`（`ALL_ROUTES` 聚合）
    - `index.ts` 在 `SELECT` 短路后插一行 `if (await tryDispatch(...)) return;`，**删除整个 `case "GROUPS"`**（59 行 → 0 行）；其它 9 个模块继续走遗留 switch，下一轮增量迁移
  - **AppSec architect 一轮 review 4 LOW 当轮全修**：
    - LOW-1 — `GROUPS:<unknown>` 回退语义丢失：补 2 条 catch-all 路由（`GROUPS:<_action>` / `GROUPS:<_action>:<_arg?>`）→ `showGroupsMenu`，与遗留行为一致
    - LOW-2 — `parseInt` 过于宽松：路由模式引入 `:int` 后缀，matcher 在握把字符串前置 `/^\d+$/` 校验，`GROUPS:VIEW:1abc` 这类畸形回调到 handler 之前就被拒；GROUPS 全部 id/offset 占位升级到 `:int`
    - LOW-3 — `tryDispatch` 单段路由 ACL 缺省 fail-open：`!r.acl && parts.length < 2` 时强制拒绝并写 ERROR 审计，逼操作者显式声明 ACL（防未来路由静默绕权）
    - LOW-4 — 流 ACL 覆盖完整性：交叉核对 `FLOWS` × `ACTION_PERMISSIONS`，无遗漏；建议（未做）后续加单元测试断言"非 ALL_USERS 流必须有 acl"
  - **架构收益**：新增特权流只需在 `FLOWS` 上加 `acl:` 字段；新增回调路由只需在 `routes/<module>.ts` 加一行数据；不再需要在 `index.ts` 大 switch / 大 ACL key 派生块里手写 if-else
  - **遗留 switch 待迁移清单**（下一轮）：PROJ / TASK / REQ / DOC / FIN / BI / MEM / SET / TRASH —— 路径已通，每个模块照 GROUPS 套路写一份 `routes/<mod>.ts`，删 `case`
  - typecheck 全绿 + 启动干净；3 角色全程：dev 写 / QA 跑通（依赖现有 GROUPS smoke）/ AppSec 审；4 LOW 当轮全修


> **更早的稳定条目**（B1 / B2.1 / B2.2 / B3 P0 / P1 / P2 / P2.1）已归档至 [`docs/CHANGELOG.md`](./docs/CHANGELOG.md)。
