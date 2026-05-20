import type { Telegram } from "telegraf";
import { db, tasksTable, usersTable, requirementsTable, financeRecordsTable, notDeleted } from "@workspace/db";
import { and, eq, lt, isNotNull, inArray } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { dispatchBroadcast } from "./dispatch.js";
import { escapeHtml, notifyUser, REVIEWER_ROLES_REQ, REVIEWER_ROLES_FIN } from "./notify.js";
import { getSettings, getLastDigestAutoDate, setLastDigestAutoDate } from "./settings-store.js";

const ACTIVE_STATUSES = ["TODO", "DOING", "PAUSED", "VERIFY"];

function startOfTomorrow(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

type DigestData = {
  overdue: typeof tasksTable.$inferSelect[];
  dueToday: typeof tasksTable.$inferSelect[];
  pendingReqs: typeof requirementsTable.$inferSelect[];
  pendingReimb: typeof financeRecordsTable.$inferSelect[];
  userMap: Map<number, typeof usersTable.$inferSelect>;
};

async function loadDigestData(): Promise<DigestData> {
  const tomorrowStart = startOfTomorrow();
  const todayStart = startOfToday();

  const dueOrOverdue = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.isArchived, 0),
        isNotNull(tasksTable.dueDate),
        inArray(tasksTable.status, ACTIVE_STATUSES),
        lt(tasksTable.dueDate, tomorrowStart),
        notDeleted(tasksTable),
      ),
    );

  const overdue = dueOrOverdue.filter((t) => t.dueDate! < todayStart);
  const dueToday = dueOrOverdue.filter((t) => t.dueDate! >= todayStart && t.dueDate! < tomorrowStart);

  const pendingReimb = await db
    .select()
    .from(financeRecordsTable)
    .where(and(
      eq(financeRecordsTable.status, "PENDING_APPROVAL"),
      eq(financeRecordsTable.isArchived, 0),
      notDeleted(financeRecordsTable),
    ));

  const pendingReqs = await db
    .select()
    .from(requirementsTable)
    .where(and(
      eq(requirementsTable.status, "PENDING"),
      eq(requirementsTable.isArchived, 0),
      notDeleted(requirementsTable),
    ));

  const userIds = Array.from(new Set([
    ...overdue.map((t) => t.assigneeId).filter((x): x is number => x != null),
    ...dueToday.map((t) => t.assigneeId).filter((x): x is number => x != null),
  ]));
  const users = userIds.length > 0
    ? await db.select().from(usersTable).where(inArray(usersTable.id, userIds))
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  return { overdue, dueToday, pendingReqs, pendingReimb, userMap };
}

function nameForGroup(u: { username: string | null; firstName: string | null; telegramId: string }): string {
  if (u.username) return `@${u.username}`;
  return escapeHtml(u.firstName ?? u.telegramId);
}

function buildGroupDigest(data: DigestData): string | null {
  const { overdue, dueToday, pendingReqs, pendingReimb, userMap } = data;
  if (overdue.length === 0 && dueToday.length === 0 && pendingReimb.length === 0 && pendingReqs.length === 0) {
    return null;
  }

  const todayStart = startOfToday();
  const dateStr = new Date().toLocaleDateString("zh-CN");
  const lines: string[] = [`📅 <b>每日提醒  ${dateStr}</b>\n`];

  if (overdue.length > 0) {
    lines.push(`🔴 <b>已逾期任务（${overdue.length}）</b>`);
    for (const t of overdue.slice(0, 10)) {
      const owner = t.assigneeId ? userMap.get(t.assigneeId) : null;
      const ownerName = owner ? nameForGroup(owner) : "未指派";
      const days = Math.floor((todayStart.getTime() - t.dueDate!.getTime()) / 86400000);
      lines.push(`  • #${t.id} ${escapeHtml(t.title)} — ${ownerName}  <i>逾期 ${days} 天</i>`);
    }
    if (overdue.length > 10) lines.push(`  … 另有 ${overdue.length - 10} 条`);
    lines.push("");
  }

  if (dueToday.length > 0) {
    lines.push(`🟡 <b>今日截止任务（${dueToday.length}）</b>`);
    for (const t of dueToday.slice(0, 10)) {
      const owner = t.assigneeId ? userMap.get(t.assigneeId) : null;
      const ownerName = owner ? nameForGroup(owner) : "未指派";
      lines.push(`  • #${t.id} ${escapeHtml(t.title)} — ${ownerName}`);
    }
    if (dueToday.length > 10) lines.push(`  … 另有 ${dueToday.length - 10} 条`);
    lines.push("");
  }

  if (pendingReqs.length > 0) {
    lines.push(`📌 <b>待评审需求（${pendingReqs.length}）</b>`);
    for (const r of pendingReqs.slice(0, 5)) {
      lines.push(`  • #${r.id} ${escapeHtml(r.title)}`);
    }
    if (pendingReqs.length > 5) lines.push(`  … 另有 ${pendingReqs.length - 5} 条`);
    lines.push("");
  }

  if (pendingReimb.length > 0) {
    lines.push(`💰 <b>待审报销（${pendingReimb.length}）</b>`);
    for (const f of pendingReimb.slice(0, 5)) {
      lines.push(`  • #${f.id} ${f.amount} ${f.currency} — ${escapeHtml(f.purpose)}`);
    }
    if (pendingReimb.length > 5) lines.push(`  … 另有 ${pendingReimb.length - 5} 条`);
  }

  return lines.join("\n").trimEnd();
}

/** Build a personalised DM digest for a specific user, or null if they have nothing pending. */
function buildPersonalDigest(
  user: typeof usersTable.$inferSelect,
  data: DigestData,
): string | null {
  const todayStart = startOfToday();
  const myOverdue = data.overdue.filter((t) => t.assigneeId === user.id);
  const myDueToday = data.dueToday.filter((t) => t.assigneeId === user.id);

  const isReqReviewer = REVIEWER_ROLES_REQ.includes(user.role);
  const isFinReviewer = REVIEWER_ROLES_FIN.includes(user.role);
  const reviewerReqs = isReqReviewer ? data.pendingReqs : [];
  const reviewerReimb = isFinReviewer ? data.pendingReimb : [];

  if (
    myOverdue.length === 0 &&
    myDueToday.length === 0 &&
    reviewerReqs.length === 0 &&
    reviewerReimb.length === 0
  ) {
    return null;
  }

  const dateStr = new Date().toLocaleDateString("zh-CN");
  const greet = user.firstName ? `${escapeHtml(user.firstName)}，` : "";
  const lines: string[] = [`👋 ${greet}<b>今日待办  ${dateStr}</b>\n`];

  if (myOverdue.length > 0) {
    lines.push(`🔴 <b>你的逾期任务（${myOverdue.length}）</b>`);
    for (const t of myOverdue.slice(0, 8)) {
      const days = Math.floor((todayStart.getTime() - t.dueDate!.getTime()) / 86400000);
      lines.push(`  • #${t.id} ${escapeHtml(t.title)}  <i>逾期 ${days} 天</i>`);
    }
    if (myOverdue.length > 8) lines.push(`  … 另有 ${myOverdue.length - 8} 条`);
    lines.push("");
  }

  if (myDueToday.length > 0) {
    lines.push(`🟡 <b>今日截止任务（${myDueToday.length}）</b>`);
    for (const t of myDueToday.slice(0, 8)) {
      lines.push(`  • #${t.id} ${escapeHtml(t.title)}`);
    }
    if (myDueToday.length > 8) lines.push(`  … 另有 ${myDueToday.length - 8} 条`);
    lines.push("");
  }

  if (reviewerReqs.length > 0) {
    lines.push(`📌 <b>待你评审的需求（${reviewerReqs.length}）</b>`);
    for (const r of reviewerReqs.slice(0, 5)) {
      lines.push(`  • #${r.id} ${escapeHtml(r.title)}`);
    }
    if (reviewerReqs.length > 5) lines.push(`  … 另有 ${reviewerReqs.length - 5} 条`);
    lines.push("");
  }

  if (reviewerReimb.length > 0) {
    lines.push(`💰 <b>待你审核的报销（${reviewerReimb.length}）</b>`);
    for (const f of reviewerReimb.slice(0, 5)) {
      lines.push(`  • #${f.id} ${f.amount} ${f.currency} — ${escapeHtml(f.purpose)}`);
    }
    if (reviewerReimb.length > 5) lines.push(`  … 另有 ${reviewerReimb.length - 5} 条`);
  }

  return lines.join("\n").trimEnd();
}

/** Backward-compat: used by /digest preview command. */
export async function buildDailyDigest(): Promise<string | null> {
  const data = await loadDigestData();
  return buildGroupDigest(data);
}

// Idempotency: persisted in app_settings so process restarts (incl. inside the
// catch-up window) do not re-send the same-day digest.
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export type DigestResult = {
  groupSent: boolean;
  dmCount: number;
  dmSkipped: number;
  empty: boolean;
};

export async function sendDailyDigest(tg: Telegram, opts: { auto?: boolean } = {}): Promise<DigestResult> {
  const empty: DigestResult = { groupSent: false, dmCount: 0, dmSkipped: 0, empty: true };
  const today = todayKey();
  if (opts.auto) {
    const last = await getLastDigestAutoDate();
    if (last === today) {
      logger.info("Daily digest already sent today — skipping auto dispatch");
      return empty;
    }
  }
  const settings = await getSettings();
  // Weekend skip applies only to scheduled auto runs, not manual triggers.
  if (opts.auto && settings.digestSkipWeekend) {
    const dow = new Date().getDay();
    if (dow === 0 || dow === 6) {
      logger.info("Daily digest: weekend skip enabled");
      await setLastDigestAutoDate(today);
      return empty;
    }
  }
  try {
    const data = await loadDigestData();
    const groupText = buildGroupDigest(data);
    if (!groupText) {
      logger.info("Daily digest: nothing to report");
      // Mark "nothing to report" as a successful auto-dispatch — no need to retry today.
      if (opts.auto) await setLastDigestAutoDate(today);
      return empty;
    }

    // 1) Group summary (all-hands view)
    // System-triggered scheduler — no actor; per-broadcast audit suppressed
    // (pino still logs route reason/source for forensics).
    const dispatchResult = await dispatchBroadcast(tg, "DAILY_DIGEST", { actorId: null }, groupText);
    const groupSent = dispatchResult.ok;

    // 2) Per-user DMs (personal slice). Includes assignees + all reviewers
    //    so PM/ADMIN/FINANCE see pending review queues even if they have no tasks.
    if (!settings.digestDmEnabled) {
      logger.info({ groupSent }, "Personal DMs disabled by settings");
      if (opts.auto && groupSent) await setLastDigestAutoDate(today);
      return { groupSent, dmCount: 0, dmSkipped: 0, empty: false };
    }
    const reviewerRoles = Array.from(new Set([...REVIEWER_ROLES_REQ, ...REVIEWER_ROLES_FIN]));
    const reviewers = await db.select().from(usersTable).where(inArray(usersTable.role, reviewerRoles));
    const candidates = new Map<number, typeof usersTable.$inferSelect>();
    for (const u of data.userMap.values()) candidates.set(u.id, u);
    for (const u of reviewers) candidates.set(u.id, u);

    let dmCount = 0;
    let dmSkipped = 0;
    for (const u of candidates.values()) {
      if (u.isBlacklisted === 1) continue;
      const personal = buildPersonalDigest(u, data);
      if (!personal) continue;
      const ok = await notifyUser(tg, u.telegramId, personal);
      if (ok) dmCount += 1;
      else dmSkipped += 1;
    }

    logger.info({ groupSent, dmCount, dmSkipped, auto: opts.auto ?? false }, "Daily digest dispatched");
    // Only mark idempotency if we successfully reached at least one channel
    // (group post or any DM). If everything failed, allow another auto attempt.
    if (opts.auto && (groupSent || dmCount > 0)) await setLastDigestAutoDate(today);
    return { groupSent, dmCount, dmSkipped, empty: false };
  } catch (err) {
    logger.error({ err }, "Failed to build/send daily digest");
    return empty;
  }
}

async function msUntilNextRun(): Promise<number> {
  const s = await getSettings();
  const now = new Date();
  const next = new Date();
  next.setHours(s.digestHour, s.digestMinute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// If the scheduled time is within the past `CATCHUP_WINDOW_MS` ago and we're
// starting up after a restart, fire once immediately so we don't skip today.
const CATCHUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function shouldCatchUpOnStartup(): Promise<boolean> {
  const s = await getSettings();
  const now = new Date();
  const todayScheduled = new Date();
  todayScheduled.setHours(s.digestHour, s.digestMinute, 0, 0);
  const elapsed = now.getTime() - todayScheduled.getTime();
  return elapsed > 0 && elapsed <= CATCHUP_WINDOW_MS;
}

let scheduled = false;

export async function startReminderScheduler(tg: Telegram): Promise<void> {
  if (scheduled) return;
  scheduled = true;
  // Re-evaluate the schedule on every tick so live edits to digest_hour/minute
  // are picked up the very next cycle without a process restart.
  const tick = async (): Promise<void> => {
    await sendDailyDigest(tg, { auto: true });
    const delay = await msUntilNextRun();
    setTimeout(() => void tick(), delay);
  };
  const settings = await getSettings();
  const initialDelay = await msUntilNextRun();
  logger.info(
    {
      hour: settings.digestHour,
      minute: settings.digestMinute,
      skipWeekend: settings.digestSkipWeekend,
      dmEnabled: settings.digestDmEnabled,
      firstRunInMinutes: Math.round(initialDelay / 60000),
    },
    "Reminder scheduler started",
  );
  if (await shouldCatchUpOnStartup()) {
    logger.info("Restarted shortly after scheduled digest time — running catch-up now");
    setTimeout(() => void sendDailyDigest(tg, { auto: true }), 5_000);
  }
  setTimeout(() => void tick(), initialDelay);
}
