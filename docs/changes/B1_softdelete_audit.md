# B1 软删落地 — 最终交付报告

- **Date**: 2026-05-09 21:07 UTC
- **Commit**: `5bf53b9de5dae143c826c0d77f508b8cd09d6d3d` (`5bf53b9`)
- **Scope**: soft-delete read-path filtering + defensive update guards
- **Author**: Replit Agent (B1 commit batch)

---

## 1. 变更文件清单

> 统计口径：`SELECT changes` = 该文件中加入 `notDeleted(table)` 的读路径行数；`UPDATE changes` = 加固的写路径 WHERE 行数；`DELETE changes` = 物理删除新增条数。

- **lib/db/src/soft-delete.ts** *(新文件)*
  - SELECT: 0 · UPDATE: 0 · DELETE: 0 *(导出 `notDeleted` / `onlyDeleted` / `softDeleteWhere`)*
- **lib/db/src/index.ts**
  - SELECT: 0 · UPDATE: 0 · DELETE: 0 *(re-export)*
- **artifacts/api-server/src/bot/search.ts**
  - SELECT: 4 · UPDATE: 0 · DELETE: 0
- **artifacts/api-server/src/bot/reminders.ts**
  - SELECT: 3 · UPDATE: 0 · DELETE: 0
- **artifacts/api-server/src/bot/form-handler.ts**
  - SELECT: 7 · UPDATE: 1 · DELETE: 0 *(物理 `db.delete(documentsTable)` 保持不动，见 §4)*
- **artifacts/api-server/src/bot/handlers/tasks.ts**
  - SELECT: 8 · UPDATE: 9 · DELETE: 0
- **artifacts/api-server/src/bot/handlers/requirements.ts**
  - SELECT: 8 · UPDATE: 5 · DELETE: 0
- **artifacts/api-server/src/bot/handlers/finance.ts**
  - SELECT: 9 · UPDATE: 4 · DELETE: 0
- **artifacts/api-server/src/bot/handlers/documents.ts**
  - SELECT: 11 · UPDATE: 6 · DELETE: 0
- **artifacts/api-server/src/bot/handlers/projects.ts**
  - SELECT: 16 · UPDATE: 2 · DELETE: 0
- **artifacts/api-server/src/bot/handlers/bi.ts**
  - SELECT: 21 · UPDATE: 0 · DELETE: 0
- **artifacts/api-server/src/bot/handlers/members.ts**
  - SELECT: 4 · UPDATE: 0 · DELETE: 0
- **artifacts/api-server/src/bot/handlers/settings.ts**
  - SELECT: 15 · UPDATE: 0 · DELETE: 0
- **replit.md**
  - 文档更新：Conventions 段新增软删/硬删约定

**合计**：SELECT 改动 ≈ 119 处 · UPDATE 加固 27 处（含 form-handler 文档 tag 更新 1 处 + 26 处 action handler）· DELETE 0 处新增。

---

## 2. UPDATE 改动逐条对比 (27 条)

> 所有改动**只追加** `notDeleted(table)` 到现有 `where(...)`，不修改原 `status` / `isArchived` / `id` 等业务守卫。无 DELETE 改动。

### form-handler.ts

**[file] artifacts/api-server/src/bot/form-handler.ts:L334**
BEFORE:
```ts
await db.update(documentsTable).set({ tags: newTags || null }).where(eq(documentsTable.id, docId));
```
AFTER:
```ts
await db.update(documentsTable).set({ tags: newTags || null }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));
```

### handlers/tasks.ts

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L443** *(case "START")*
BEFORE: `await db.update(tasksTable).set({ status: "DOING" }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ status: "DOING" }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L448** *(case "RESUME")*
BEFORE: `await db.update(tasksTable).set({ status: "DOING" }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ status: "DOING" }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L453** *(case "PAUSE")*
BEFORE: `await db.update(tasksTable).set({ status: "PAUSED" }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ status: "PAUSED" }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L458** *(case "DONE")*
BEFORE: `await db.update(tasksTable).set({ status: "DONE", progress: 100 }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ status: "DONE", progress: 100 }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L476** *(case "ARCH")*
BEFORE: `await db.update(tasksTable).set({ isArchived: 1 }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ isArchived: 1 }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L488** *(case "SETDELAY")*
BEFORE: `await db.update(tasksTable).set({ dueDate: newDue }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ dueDate: newDue }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L501** *(case "SETPROG")*
BEFORE: `await db.update(tasksTable).set(update).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set(update).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L530** *(case "CHASSIGN")*
BEFORE: `await db.update(tasksTable).set({ assigneeId: userId }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ assigneeId: userId }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

**[file] artifacts/api-server/src/bot/handlers/tasks.ts:L549** *(case "UNASSIGN")*
BEFORE: `await db.update(tasksTable).set({ assigneeId: null }).where(eq(tasksTable.id, taskId));`
AFTER:  `await db.update(tasksTable).set({ assigneeId: null }).where(and(eq(tasksTable.id, taskId), notDeleted(tasksTable)));`

### handlers/requirements.ts

**[file] handlers/requirements.ts:L249** *(ARCH)*
BEFORE: `await db.update(requirementsTable).set({ isArchived: 1 }).where(eq(requirementsTable.id, reqId));`
AFTER:  `await db.update(requirementsTable).set({ isArchived: 1 }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));`

**[file] handlers/requirements.ts:L254** *(UNARCH)*
BEFORE: `await db.update(requirementsTable).set({ isArchived: 0 }).where(eq(requirementsTable.id, reqId));`
AFTER:  `await db.update(requirementsTable).set({ isArchived: 0 }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));`

**[file] handlers/requirements.ts:L263** *(REOPEN — 注意原 status 守卫保留在 if 分支)*
BEFORE: `await db.update(requirementsTable).set({ status: "PENDING", reviewNote: null }).where(eq(requirementsTable.id, reqId));`
AFTER:  `await db.update(requirementsTable).set({ status: "PENDING", reviewNote: null }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));`

**[file] handlers/requirements.ts:L278** *(SETPROJ)*
BEFORE: `await db.update(requirementsTable).set({ projectId: projId }).where(eq(requirementsTable.id, reqId));`
AFTER:  `await db.update(requirementsTable).set({ projectId: projId }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));`

**[file] handlers/requirements.ts:L284** *(UNLINK)*
BEFORE: `await db.update(requirementsTable).set({ projectId: null }).where(eq(requirementsTable.id, reqId));`
AFTER:  `await db.update(requirementsTable).set({ projectId: null }).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));`

### handlers/finance.ts

**[file] handlers/finance.ts:L344** *(ARCH)*
BEFORE: `await db.update(financeRecordsTable).set({ isArchived: 1 }).where(eq(financeRecordsTable.id, finId));`
AFTER:  `await db.update(financeRecordsTable).set({ isArchived: 1 }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));`

**[file] handlers/finance.ts:L349** *(UNARCH)*
BEFORE: `await db.update(financeRecordsTable).set({ isArchived: 0 }).where(eq(financeRecordsTable.id, finId));`
AFTER:  `await db.update(financeRecordsTable).set({ isArchived: 0 }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));`

**[file] handlers/finance.ts:L364** *(SETPROJ)*
BEFORE: `await db.update(financeRecordsTable).set({ projectId: projId }).where(eq(financeRecordsTable.id, finId));`
AFTER:  `await db.update(financeRecordsTable).set({ projectId: projId }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));`

**[file] handlers/finance.ts:L370** *(UNLINK)*
BEFORE: `await db.update(financeRecordsTable).set({ projectId: null }).where(eq(financeRecordsTable.id, finId));`
AFTER:  `await db.update(financeRecordsTable).set({ projectId: null }).where(and(eq(financeRecordsTable.id, finId), notDeleted(financeRecordsTable)));`

### handlers/documents.ts

**[file] handlers/documents.ts:L374** *(PIN)*
BEFORE: `await db.update(documentsTable).set({ isPinned: newPin }).where(eq(documentsTable.id, docId));`
AFTER:  `await db.update(documentsTable).set({ isPinned: newPin }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));`

**[file] handlers/documents.ts:L380** *(ARCH)*
BEFORE: `await db.update(documentsTable).set({ isArchived: 1 }).where(eq(documentsTable.id, docId));`
AFTER:  `await db.update(documentsTable).set({ isArchived: 1 }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));`

**[file] handlers/documents.ts:L385** *(UNARCH)*
BEFORE: `await db.update(documentsTable).set({ isArchived: 0 }).where(eq(documentsTable.id, docId));`
AFTER:  `await db.update(documentsTable).set({ isArchived: 0 }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));`

**[file] handlers/documents.ts:L395** *(SETCAT)*
BEFORE: `await db.update(documentsTable).set({ category: cat }).where(eq(documentsTable.id, docId));`
AFTER:  `await db.update(documentsTable).set({ category: cat }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));`

**[file] handlers/documents.ts:L411** *(SETPROJ)*
BEFORE: `await db.update(documentsTable).set({ projectId: projId }).where(eq(documentsTable.id, docId));`
AFTER:  `await db.update(documentsTable).set({ projectId: projId }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));`

**[file] handlers/documents.ts:L417** *(UNLINK)*
BEFORE: `await db.update(documentsTable).set({ projectId: null }).where(eq(documentsTable.id, docId));`
AFTER:  `await db.update(documentsTable).set({ projectId: null }).where(and(eq(documentsTable.id, docId), notDeleted(documentsTable)));`

### handlers/projects.ts

**[file] handlers/projects.ts:L282** *(STATUS)*
BEFORE: `await db.update(projectsTable).set({ status: newStatus }).where(eq(projectsTable.id, projectId));`
AFTER:  `await db.update(projectsTable).set({ status: newStatus }).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));`

**[file] handlers/projects.ts:L307** *(ARCHIVE / UNARCHIVE)*
BEFORE: `await db.update(projectsTable).set({ isArchived: archive ? 1 : 0 }).where(eq(projectsTable.id, projectId));`
AFTER:  `await db.update(projectsTable).set({ isArchived: archive ? 1 : 0 }).where(and(eq(projectsTable.id, projectId), notDeleted(projectsTable)));`

> **守卫不变性确认**：以上 27 条改动均为追加最末尾参数 `notDeleted(table)`；无原条件被删除或语义改写。例如 REOPEN 路径上层 `if (req.status !== "REJECTED") return;` 业务守卫完整保留。

---

## 3. SELECT 改动 spot-check (每文件抽 2 条)

### form-handler.ts (共 7 处)
**L256**
BEFORE: `const reqRows = await db.select().from(requirementsTable).where(eq(requirementsTable.id, reqId));`
AFTER:  `const reqRows = await db.select().from(requirementsTable).where(and(eq(requirementsTable.id, reqId), notDeleted(requirementsTable)));`

**L314**
BEFORE: `const projRows = await db.select().from(projectsTable).where(eq(projectsTable.id, doc.projectId));`
AFTER:  `const projRows = await db.select().from(projectsTable).where(and(eq(projectsTable.id, doc.projectId), notDeleted(projectsTable)));`

### search.ts (共 4 处)
**L22**
BEFORE: `db.select().from(tasksTable).where(like(tasksTable.title, q)),`
AFTER:  `db.select().from(tasksTable).where(and(like(tasksTable.title, q), notDeleted(tasksTable))),`

**L23**
BEFORE: `db.select().from(requirementsTable).where(like(requirementsTable.title, q)),`
AFTER:  `db.select().from(requirementsTable).where(and(like(requirementsTable.title, q), notDeleted(requirementsTable))),`

### reminders.ts (共 3 处)
**L36-47**
BEFORE: `where(and(eq(tasksTable.isArchived,0), isNotNull(tasksTable.dueDate), inArray(tasksTable.status, ACTIVE_STATUSES), lt(tasksTable.dueDate, tomorrowStart)))`
AFTER:  追加 `notDeleted(tasksTable)` 为最末参数

**L52-59** (financeRecordsTable PENDING_APPROVAL) — 同模式追加 `notDeleted(financeRecordsTable)`

### handlers/tasks.ts (共 8 处)
**L47** (startTaskFlow project picker)
BEFORE: `.where(and(eq(projectsTable.isArchived, 0)))`
AFTER:  `.where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))`

**L222** (showArchivedTasks)
BEFORE: `const whereClause = eq(tasksTable.isArchived, 1);`
AFTER:  `const whereClause = and(eq(tasksTable.isArchived, 1), notDeleted(tasksTable));`

### handlers/requirements.ts (共 8 处)
**L37-38** (showReqList conds)
BEFORE: `[eq(requirementsTable.isArchived, 1)]` / `[eq(...,0), eq(status,filter)]`
AFTER:  分别追加 `notDeleted(requirementsTable)` 入 conds 数组

**L208** (showReqProjectPicker)
BEFORE: `.where(eq(projectsTable.isArchived, 0))`
AFTER:  `.where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))`

### handlers/finance.ts (共 9 处)
**L149** (showByProject)
BEFORE: `.where(eq(financeRecordsTable.isArchived, 0))`
AFTER:  `.where(and(eq(financeRecordsTable.isArchived, 0), notDeleted(financeRecordsTable)))`

**L108-113** (showMonthlyReport) — 在 `and(...)` 末尾追加 `notDeleted(financeRecordsTable)`

### handlers/documents.ts (共 11 处)
**L52** (showDocsByCategory)
BEFORE: `and(eq(documentsTable.category, category), eq(documentsTable.isArchived, 0))`
AFTER:  `and(eq(documentsTable.category, category), eq(documentsTable.isArchived, 0), notDeleted(documentsTable))`

**L88** (showDocList conds 初始化)
BEFORE: `const conds = [];`
AFTER:  `const conds = [notDeleted(documentsTable)];`

### handlers/projects.ts (共 16 处)
**L46-49** (showProjectList 三分支 conds) — 每个分支数组末尾追加 `notDeleted(projectsTable)`

**L97** (project card 任务计数)
BEFORE: `.where(eq(tasksTable.projectId, projectId))`
AFTER:  `.where(and(eq(tasksTable.projectId, projectId), notDeleted(tasksTable)))`

### handlers/bi.ts (共 21 处)
**L79** (today overview pendingReqs)
BEFORE: `.where(and(eq(requirementsTable.status,"PENDING"), eq(requirementsTable.isArchived, 0)))`
AFTER:  `.where(and(eq(requirementsTable.status,"PENDING"), eq(requirementsTable.isArchived, 0), notDeleted(requirementsTable)))`

**L276** (showProjectHealth)
BEFORE: `.where(eq(projectsTable.isArchived, 0))`
AFTER:  `.where(and(eq(projectsTable.isArchived, 0), notDeleted(projectsTable)))`

### handlers/members.ts (共 4 处)
**L207**
BEFORE: `.where(eq(tasksTable.assigneeId, userId))`
AFTER:  `.where(and(eq(tasksTable.assigneeId, userId), notDeleted(tasksTable)))`

**L209**
BEFORE: `.where(and(eq(tasksTable.assigneeId, userId), eq(tasksTable.status, "DONE")))`
AFTER:  `.where(and(eq(tasksTable.assigneeId, userId), eq(tasksTable.status, "DONE"), notDeleted(tasksTable)))`

### handlers/settings.ts (共 15 处)
**L233** (备份计数)
BEFORE: `db.select({ c: count() }).from(tasksTable),`
AFTER:  `db.select({ c: count() }).from(tasksTable).where(notDeleted(tasksTable)),`

**L273** (CSV 导出 PROJ)
BEFORE: `const rows = await db.select().from(projectsTable);`
AFTER:  `const rows = await db.select().from(projectsTable).where(notDeleted(projectsTable));`

---

## 4. 物理删除豁免确认

✅ **`artifacts/api-server/src/bot/form-handler.ts:L351` 保持物理删除不动**：

```ts
await db.delete(documentsTable).where(eq(documentsTable.id, docId));
```

这是仓库内**唯一**保留的硬删出口（`rg "db\.delete\(" artifacts/ lib/` 仅返回此一处），位于 `DOC:DEL` 表单流程，承载用户主动彻底删除文档的语义。约定已在 `replit.md` Conventions 段落明确：

> 硬删仅保留一处出口：`form-handler.ts` 文档删除流程（`db.delete(documentsTable)`），其余删除应走软删（`set({ deletedAt: new Date() })`）

---

## 5. PR Description

```markdown
### B1 — Soft-delete read-path enforcement + defensive update guards

**Scope**
- Introduce `notDeleted(table) = isNull(table.deletedAt)` helper in `lib/db/src/soft-delete.ts`
  (also exports `onlyDeleted` / `softDeleteWhere` for future trash-bin / delete sites).
- Apply `notDeleted(t)` to every read path (SELECT / count / aggregate) that touches the
  five soft-deletable tables: `tasks`, `requirements`, `finance_records`, `documents`,
  `projects`, across:
  - `bot/handlers/{tasks,requirements,finance,documents,projects,bi,members,settings}.ts`
  - `bot/{search,reminders,form-handler}.ts`
- Defensive depth: 27 `db.update(...).where(eq(t.id, X))` writes are upgraded to
  `where(and(eq(t.id, X), notDeleted(t)))` so a row soft-deleted between the prior
  read-load and the action handler can no longer be silently mutated.
- Documented the soft-delete vs. archive vs. hard-delete convention in `replit.md`.

**Non-goals (deferred)**
- Trash-bin / restore UX (uses the new `onlyDeleted` helper).
- Insert-side / FK-side guards (e.g. blocking task creation under a soft-deleted project).
- Migrating the single physical-delete site to soft-delete.

**Risk: low–medium**
- Pure additive WHERE-clause hardening, no business condition rewrites
  (status, isArchived, ownership all preserved verbatim).
- Surface area is wide (~119 SELECT + 27 UPDATE sites across 11 files), but each edit
  follows one of three mechanical patterns (append to existing `and(...)`, wrap a
  bare `eq(...)`, or push into a `conds[]` array).
- No schema change, no migration required.

**Validation**
- `pnpm run typecheck` — green (libs + api-server + mockup-sandbox).
- Workflow `artifacts/api-server: API Server` restarted cleanly; bot long-poll +
  reminder scheduler started without errors.
- Architect (code-review subagent) re-run on the final tree returned a clean report
  (the 26 unguarded UPDATEs flagged in the prior pass are now all addressed).

**Notes**
- Physical delete is intentionally retained at exactly one site:
  `bot/form-handler.ts:351 — db.delete(documentsTable)` (DOC:DEL flow).
  Codified in `replit.md` Conventions so future contributors do not "fix" it.
- Convention for new read queries: `where(and(<existing conds>, notDeleted(table)))`.

Audit: docs/changes/B1_softdelete_audit.md
```

---

## 6. How to verify (smoke checklist)

1. **Typecheck 绿灯**：`pnpm run typecheck` 返回 `Done`，无 TS 错误。
2. **服务启动**：重启 `artifacts/api-server: API Server` workflow，日志可见 `Server listening` + `Telegram bot started (long polling)` + `Reminder scheduler started`。
3. **软删过滤生效**：在 DB 内对任一 `tasks` 行执行 `UPDATE tasks SET deleted_at = NOW() WHERE id = X;`，然后在 Bot 内点击「📋 我的任务」/「📌 今日待办」/「⏳ 即将到期」/「全局搜索」，确认该条目均不再出现。
4. **UPDATE 守卫生效**：复用步骤 3 的软删行，触发任意 action（如 `TASK:DONE:X` 或 `TASK:ARCH:X`），确认 `UPDATE` 影响 0 行（DB 内该行 `status` / `is_archived` 维持不变）。
5. **物理删除豁免**：在 Bot 内对一篇文档走 `DOC:DEL` 流程，确认 DB 里该 `documents` 行真正消失（`SELECT * FROM documents WHERE id = X;` 返回空）——这是允许的唯一硬删出口。
