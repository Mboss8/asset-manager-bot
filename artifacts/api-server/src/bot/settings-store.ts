import { db, appSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export type AppSettings = {
  digestHour: number;        // 0-23
  digestMinute: number;      // 0-59
  digestSkipWeekend: boolean;
  digestDmEnabled: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  digestHour: parseInt(process.env["DIGEST_HOUR"] ?? "9", 10),
  digestMinute: parseInt(process.env["DIGEST_MINUTE"] ?? "0", 10),
  digestSkipWeekend: false,
  digestDmEnabled: true,
};

let cache: AppSettings | null = null;
let cacheLoadedAt = 0;
const TTL_MS = 30_000;

async function loadFromDb(): Promise<AppSettings> {
  const rows = await db.select().from(appSettingsTable);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const parseInt0 = (v: string | undefined, def: number): number => {
    if (v == null) return def;
    const n = parseInt(v, 10);
    return isNaN(n) ? def : n;
  };
  const parseBool = (v: string | undefined, def: boolean): boolean => {
    if (v == null) return def;
    return v === "1" || v === "true";
  };
  return {
    digestHour: clampInt(parseInt0(map.get("digest_hour"), DEFAULT_SETTINGS.digestHour), 0, 23),
    digestMinute: clampInt(parseInt0(map.get("digest_minute"), DEFAULT_SETTINGS.digestMinute), 0, 59),
    digestSkipWeekend: parseBool(map.get("digest_skip_weekend"), DEFAULT_SETTINGS.digestSkipWeekend),
    digestDmEnabled: parseBool(map.get("digest_dm_enabled"), DEFAULT_SETTINGS.digestDmEnabled),
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

export async function getSettings(force = false): Promise<AppSettings> {
  const now = Date.now();
  if (!force && cache && now - cacheLoadedAt < TTL_MS) return cache;
  try {
    cache = await loadFromDb();
    cacheLoadedAt = now;
  } catch (err) {
    logger.warn({ err }, "Failed to load app_settings; using defaults");
    cache = { ...DEFAULT_SETTINGS };
    cacheLoadedAt = now;
  }
  return cache;
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await db.insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

export async function setDigestHour(h: number): Promise<AppSettings> {
  await upsertSetting("digest_hour", String(clampInt(h, 0, 23)));
  return getSettings(true);
}

export async function setDigestMinute(m: number): Promise<AppSettings> {
  await upsertSetting("digest_minute", String(clampInt(m, 0, 59)));
  return getSettings(true);
}

/** Atomic flip: single SQL statement so concurrent toggles can't lose updates. */
async function atomicToggle(key: string, defaultIfMissing: string): Promise<void> {
  await db.insert(appSettingsTable)
    .values({ key, value: defaultIfMissing })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: {
        value: sql`CASE WHEN ${appSettingsTable.value} = '1' THEN '0' ELSE '1' END`,
        updatedAt: new Date(),
      },
    });
}

export async function toggleSkipWeekend(): Promise<AppSettings> {
  await atomicToggle("digest_skip_weekend", DEFAULT_SETTINGS.digestSkipWeekend ? "0" : "1");
  return getSettings(true);
}

export async function toggleDigestDm(): Promise<AppSettings> {
  await atomicToggle("digest_dm_enabled", DEFAULT_SETTINGS.digestDmEnabled ? "0" : "1");
  return getSettings(true);
}

// ───────── Persistent idempotency key for daily auto-digest ─────────

export async function getLastDigestAutoDate(): Promise<string | null> {
  const rows = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "last_digest_auto_date"));
  return rows[0]?.value ?? null;
}

export async function setLastDigestAutoDate(dateKey: string): Promise<void> {
  await upsertSetting("last_digest_auto_date", dateKey);
}
