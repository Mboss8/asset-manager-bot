import type { Context } from "telegraf";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  tasksTable,
  requirementsTable,
  financeRecordsTable,
  documentsTable,
  projectsTable,
  onlyDeleted,
} from "@workspace/db";
import { editOrSend, buildKeyboard, writeAudit } from "../helpers.js";
import { getUserByTelegramId } from "../user-service.js";

const PAGE_SIZE = 10;

export type TrashType = "TASK" | "REQ" | "FIN" | "DOC" | "PROJ";

const VALID_TYPES: readonly TrashType[] = ["TASK", "REQ", "FIN", "DOC", "PROJ"] as const;

export function isTrashType(s: string | undefined): s is TrashType {
  return !!s && (VALID_TYPES as readonly string[]).includes(s);
}

function getTable(type: TrashType) {
  switch (type) {
    case "TASK": return tasksTable;
    case "REQ": return requirementsTable;
    case "FIN": return financeRecordsTable;
    case "DOC": return documentsTable;
    case "PROJ": return projectsTable;
  }
}

function typeLabel(type: TrashType): string {
  switch (type) {
    case "TASK": return "任务";
    case "REQ": return "需求";
    case "FIN": return "财务";
    case "DOC": return "文档";
    case "PROJ": return "项目";
  }
}

function typeAuditTarget(type: TrashType): string {
  switch (type) {
    case "TASK": return "task";
    case "REQ": return "requirement";
    case "FIN": return "finance";
    case "DOC": return "document";
    case "PROJ": return "project";
  }
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

function getRowTitle(row: Record<string, unknown>): string {
  const title = row["title"] ?? row["name"] ?? row["serialNo"];
  if (typeof title === "string" && title.length > 0) return title;
  return `#${row["id"]}`;
}

async function fetchTrashRows(type: TrashType, offset: number) {
  const table = getTable(type) as any;
  return db
    .select()
    .from(table)
    .where(onlyDeleted(table))
    .orderBy(desc(table.deletedAt))
    .limit(PAGE_SIZE + 1) // +1 to detect "has next page"
    .offset(offset);
}

async function restoreTrashRow(type: TrashType, id: number) {
  const table = getTable(type) as any;
  const rows = await db
    .update(table)
    .set({ deletedAt: null })
    .where(and(eq(table.id, id), onlyDeleted(table)))
    .returning();
  return rows[0] ?? null;
}

function buildListText(type: TrashType, offset: number, rows: any[]): string {
  const header = `🗑 <b>回收站 / ${typeLabel(type)}</b>\n<i>已软删的 ${typeLabel(type)} 记录，可恢复。</i>\n`;
  if (rows.length === 0) {
    return header + "\n📭 当前回收站为空。";
  }
  const body = rows
    .map((r) => `• #${r.id} · ${getRowTitle(r)}\n  软删于 ${fmtDate(r.deletedAt)}`)
    .join("\n");
  return `${header}\n${body}\n\n第 ${Math.floor(offset / PAGE_SIZE) + 1} 页`;
}

function buildListKeyboard(type: TrashType, offset: number, rows: any[], hasNext: boolean) {
  const buttons: { text: string; callback_data: string }[] = [];
  for (const r of rows) {
    buttons.push({
      text: `♻️ 恢复 #${r.id}`,
      callback_data: `TRASH:RESTORE:${type}:${r.id}`,
    });
  }

  const nav: { text: string; callback_data: string }[] = [];
  if (offset > 0) {
    const prev = Math.max(0, offset - PAGE_SIZE);
    nav.push({ text: "⬅️ 上一页", callback_data: `TRASH:LIST:${type}:${prev}` });
  }
  if (hasNext) {
    nav.push({ text: "➡️ 下一页", callback_data: `TRASH:LIST:${type}:${offset + PAGE_SIZE}` });
  }

  const footer = [
    ...nav,
    { text: "🔙 类型选择", callback_data: "M:TRASH" },
  ];

  // 1 列展开 restore 按钮，最后追加导航 + 返回
  return buildKeyboard(buttons, 1, footer);
}

/**
 * TRASH:LIST:<TYPE>:<OFFSET>
 */
export async function showTrashList(ctx: Context, type: TrashType, offset: number): Promise<void> {
  const all = await fetchTrashRows(type, offset);
  const hasNext = all.length > PAGE_SIZE;
  const rows = hasNext ? all.slice(0, PAGE_SIZE) : all;
  const text = buildListText(type, offset, rows);
  const keyboard = buildListKeyboard(type, offset, rows, hasNext);
  await editOrSend(ctx, text, keyboard);
}

/**
 * TRASH:RESTORE:<TYPE>:<ID>
 * 恢复后回到列表第一页（避免翻页错位）
 */
export async function handleTrashRestore(
  ctx: Context,
  type: TrashType,
  id: number,
  telegramId: string,
): Promise<void> {
  const restored = await restoreTrashRow(type, id);

  if (!restored) {
    await ctx.answerCbQuery("⚠️ 该记录已不在回收站", { show_alert: true });
  } else {
    await ctx.answerCbQuery("♻️ 已恢复");
    const actor = await getUserByTelegramId(telegramId);
    if (actor) {
      await writeAudit(
        actor.id,
        "TRASH_RESTORE",
        typeAuditTarget(type),
        id,
        `${typeLabel(type)} #${id} 已从回收站恢复`,
        "MEDIUM",
      );
    }
  }

  // 刷新列表（回到第一页）
  await showTrashList(ctx, type, 0);
}
