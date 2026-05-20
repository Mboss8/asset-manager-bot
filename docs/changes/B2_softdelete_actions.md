# B2 — 软删动作接入回收站

> 配套 B1 (`B1_softdelete_audit.md`) 与 B2.1 (回收站 UI)。本阶段把 5 个业务模块的"删除"语义真正接入软删 → 回收站可恢复闭环。

## 目标语义（二阶生命周期）

| 语义 | 字段 | 用户视角 | 出口 |
|---|---|---|---|
| **归档 (ARCH)** | `isArchived = 1` | 已完成入库，从待办列表淡出，仍可见于"归档"过滤 | `MOD:ARCH:<id>` (PM/Finance/Admin) |
| **删除 (DEL)** | `deletedAt = NOW()` | 移入回收站，从所有正常列表消失，可恢复 | `MOD:DEL:<id>` (PM/Finance/Admin) |
| **彻底删除 (PURGE)** | 物理 `DELETE` | 不可逆，仅 admin 操作，B2.3 才在回收站内开放入口 | `DOC:PURGE` flow (目前仅文档；TASK/REQ/FIN/PROJ 无 PURGE 出口) |
| **恢复 (RESTORE)** | `deletedAt = NULL` | 从回收站还原 | `TRASH:RESTORE:<TYPE>:<id>` (Admin) |

三条轨道互不相撞。

## 阶段 A：DOC:DEL → DOC:PURGE 命名重构

| 文件 | 改动 |
|---|---|
| `flows.ts:116` | flow key `"DOC:DEL"` → `"DOC:PURGE"`；title/prompt 改为"彻底删除 / ☠️" |
| `form-handler.ts:339` | `case "DOC:DEL"` → `case "DOC:PURGE"`；audit `DOCUMENT_DELETE` → `DOCUMENT_PURGE`；移除 `notDeleted()` 守卫（PURGE 允许对软删行执行最终清理） |
| `permissions.ts:140` | `"DOC:DEL"` → `"DOC:PURGE"` (仍 `ADMIN_ONLY`) |
| `documents.ts:340-352` | `startDocDeleteFlow` → `startDocPurgeFlow`；目前**未挂任何 UI 按钮**（B2.3 才在回收站内挂） |
| `index.ts:33,552,801` | import 更名；DOC switch `action === "DEL"` → `action === "PURGE"`；过期注释更新 |

阶段 A 行为变更：原"🗑 删除"按钮在阶段 A 期间从文档卡撤下（仅这一个文件，其他模块不变）。typecheck ✅ green。

## 阶段 B：5 模块新增 DEL 软删动作

### permissions.ts 新增 5 个 key (`permissions.ts:66-70`)

```ts
"TASK:DEL": "PM_OR_ADMIN",
"REQ:DEL": "PM_OR_ADMIN",
"FIN:DEL": "FINANCE_OR_ADMIN",
"DOC:DEL": "PM_OR_ADMIN",   // ← 重新启用为软删（与阶段 A 移除的 ADMIN_ONLY 物理删完全不同语义）
"PROJ:DEL": "PM_OR_ADMIN",
```

### handler 新增 case "DEL" / handleProjectDelete

| 文件 | 入口 | 守卫 | Audit |
|---|---|---|---|
| `handlers/tasks.ts:483` | `case "DEL"` (in `handleTaskAction`) | `and(eq(id), notDeleted(tasksTable))` | `TASK_DELETE` MEDIUM |
| `handlers/requirements.ts:256` | `case "DEL"` (in `handleReqAction`) | 同上 | `REQUIREMENT_DELETE` MEDIUM |
| `handlers/finance.ts:351` | `case "DEL"` (in `handleFinAction`) | 同上 | `FINANCE_DELETE` **HIGH** |
| `handlers/documents.ts:393` | `case "DEL"` (in `handleDocAction`) | 同上 | `DOCUMENT_DELETE` MEDIUM |
| `handlers/projects.ts:320` | 新函数 `handleProjectDelete` | 同上；**不级联子任务** | `PROJECT_DELETE` MEDIUM |

所有 DEL 写入：

```ts
.set({ deletedAt: new Date() })
.where(and(eq(table.id, X), notDeleted(table)))
```

`notDeleted()` 守卫保证幂等：对已软删行重放 DEL 影响 0 行（同 B1 风格）。

### 详情卡新增 🗑 删除 按钮 (5 处)

| 文件 | 位置 | 按钮 |
|---|---|---|
| `handlers/tasks.ts:313` | ARCH 之后 | `🗑 删除 → TASK:DEL:<id>` |
| `handlers/requirements.ts:163` | ARCH/UNARCH 之后 | `REQ:DEL:<id>` |
| `handlers/finance.ts:249` | ARCH/UNARCH 之后 | `FIN:DEL:<id>` |
| `handlers/documents.ts:264` | ARCH/UNARCH 之后 | `DOC:DEL:<id>` (重新启用，新语义=软删) |
| `handlers/projects.ts:160` | ARCH/UNARCH 之后 | `PROJ:DEL:<id>` |

### index.ts 路由 (5 处)

每个模块的 mutator 数组追加 `"DEL"`：

```diff
- ["START", "RESUME", "PAUSE", "DONE", "ARCH", "UNASSIGN", "UNLINK"]   // TASK
+ ["START", "RESUME", "PAUSE", "DONE", "ARCH", "DEL", "UNASSIGN", "UNLINK"]
- ["ARCH", "UNARCH", "REOPEN", "TOTASK", "UNLINK"]                     // REQ
+ ["ARCH", "UNARCH", "DEL", "REOPEN", "TOTASK", "UNLINK"]
- ["ARCH", "UNARCH", "UNLINK"]                                          // FIN
+ ["ARCH", "UNARCH", "DEL", "UNLINK"]
- ["PIN", "ARCH", "UNARCH", "UNLINK"]                                   // DOC
+ ["PIN", "ARCH", "UNARCH", "DEL", "UNLINK"]
```

PROJ 在 switch 中新增 `case "DEL": handleProjectDelete(ctx, id, role)`，并将 `handleProjectDelete` 加入 import。

## 阶段 C：DB-level 冒烟（psql 直接验证读写路径）

```
=== user.id=1 ===
NOTICE:  TASK:DEL → soft-deleted: 1 (expect 1)
NOTICE:  TASK list (notDeleted) sees it: 0 (expect 0)
NOTICE:  TASK restore → visible: 1 (expect 1)
NOTICE:  REQ:DEL → soft-deleted: 1 (expect 1)
NOTICE:  REQ restore OK
NOTICE:  FIN:DEL → soft-deleted: 1 (expect 1) [HIGH audit]
NOTICE:  FIN restore OK
NOTICE:  DOC:DEL → soft-deleted: 1 (expect 1)
NOTICE:  DOC restore OK
NOTICE:  DOC:PURGE → row exists: 0 (expect 0)
NOTICE:  PROJ:DEL → soft-deleted: 1 (expect 1)
NOTICE:  orphan task via notDeleted-join: 0 (expect 0)
NOTICE:  orphan task row preserved (no cascade): 1 (expect 1)
NOTICE:  PROJ restore OK
NOTICE:  PROJ re-restore (idempotent): 0 (expect 0)
=== Phase C complete: 5/5 modules verified ===
```

通过断言：
- 5/5 模块 DEL 软删生效，从读路径消失
- 5/5 模块 RESTORE 还原生效
- 幂等：对已恢复行重放 RESTORE 影响 0 行（应用层 `notDeleted()` 守卫）
- DOC:PURGE 物理删生效，仍是仓库唯一硬删出口
- PROJ:DEL 不级联子任务：行保留，但下游 join `notDeleted(projectsTable)` 自然过滤为孤儿

## Audit action 命名约定（统一）

`<MODULE>_<VERB>` 全大写下划线。本阶段新增：

| Action | Level | 触发 |
|---|---|---|
| `TASK_DELETE` | MEDIUM | TASK:DEL |
| `REQUIREMENT_DELETE` | MEDIUM | REQ:DEL |
| `FINANCE_DELETE` | HIGH | FIN:DEL（财务敏感） |
| `DOCUMENT_DELETE` | MEDIUM | DOC:DEL（重新启用，原 PURGE 语义已让出） |
| `DOCUMENT_PURGE` | HIGH | DOC:PURGE flow |
| `PROJECT_DELETE` | MEDIUM | PROJ:DEL |
| `TRASH_RESTORE` | MEDIUM | TRASH:RESTORE (B2.1) |

审计页 LEVEL=HIGH 一键看出"敏感动作"（FIN_DELETE / DOC_PURGE / 角色变更等）。

## 已知/可接受的二阶问题

1. **孤儿子任务**：项目软删后，其下任务仍持有 `projectId`，但 join `notDeleted(projects)` 会过滤掉。下游显示需要 fallback `proj?.name ?? "（项目已删除）"`。当前 `getProjectById` 的调用点已天然走 `notDeleted` 守卫，故 `proj === undefined`；所有列表卡片代码已对 `undefined` 容错（fallback "—"），不会崩。后续可在 B2.4 显式标"项目已删除"红字。
2. **PURGE 当前无 UI 入口**（除 DOC 旧 flow 路径，但按钮已撤下）。Admin 实际无法触发 PURGE，需 B2.3 在回收站接入清空按钮 (`TRASH:PURGE:<TYPE>:<id>`)。这是有意设计——B2.2 范围内回收站只读+恢复，杜绝阶段间的破坏性误操作。
3. **删除无二级确认**：软删可恢复，故未加 inline 确认按钮以保持操作流畅。如需加，统一走 `🗑 确认删除 → MOD:DEL:<id>` 二级模式。

## Typecheck

阶段 A 后：✅ libs / api-server / mockup-sandbox / scripts 全 Done
阶段 B 后：✅ libs / api-server / mockup-sandbox / scripts 全 Done

## 文件清单

| 类型 | 文件 |
|---|---|
| 改动 (8) | `flows.ts`, `form-handler.ts`, `permissions.ts`, `index.ts`, `handlers/tasks.ts`, `handlers/requirements.ts`, `handlers/finance.ts`, `handlers/documents.ts`, `handlers/projects.ts`, `replit.md` |
| 新增 (1) | `docs/changes/B2_softdelete_actions.md` (本文件) |

## 下一步：B2.3 候选

- 在回收站类型详情页给每行加 `☠️ 彻底删除 → TRASH:PURGE:<TYPE>:<id>`，唤起对应 PURGE 流程（DOC 已就绪；TASK/REQ/FIN/PROJ 需新增对称 PURGE handler）
- 或直接进入 B3：群组路由 / 多群播报
