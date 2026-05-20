import { db } from "@workspace/db";
import { botSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface FormStep {
  key: string;
  type: string;
  prompt: string;
  required: boolean;
  options?: { text: string; value: string | boolean }[];
  max_length?: number;
  min?: number;
}

export interface BotSession {
  state: "idle" | "form";
  flow?: string;
  step?: number;
  formData?: Record<string, unknown>;
  steps?: FormStep[];
  context?: Record<string, unknown>;
  listPage?: Record<string, number>;
  searchMode?: boolean;
}

export async function getSession(telegramId: string): Promise<BotSession> {
  const rows = await db
    .select()
    .from(botSessionsTable)
    .where(eq(botSessionsTable.telegramId, telegramId));
  if (rows.length === 0) return { state: "idle" };
  try {
    return JSON.parse(rows[0].sessionData) as BotSession;
  } catch {
    return { state: "idle" };
  }
}

export async function saveSession(telegramId: string, session: BotSession): Promise<void> {
  const data = JSON.stringify(session);
  await db
    .insert(botSessionsTable)
    .values({ telegramId, sessionData: data })
    .onConflictDoUpdate({
      target: botSessionsTable.telegramId,
      set: { sessionData: data },
    });
}

export async function clearSession(telegramId: string): Promise<void> {
  await saveSession(telegramId, { state: "idle" });
}
