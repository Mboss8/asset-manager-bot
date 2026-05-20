import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Role } from "./permissions.js";
import type { User } from "@workspace/db";

export async function getOrCreateUser(
  telegramId: string,
  username?: string,
  firstName?: string,
  lastName?: string,
): Promise<User> {
  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));

  if (existing.length > 0) {
    return existing[0];
  }

  const isFirst = await db.select().from(usersTable);
  const role: Role = isFirst.length === 0 ? "OWNER" : "MEMBER";

  const [user] = await db
    .insert(usersTable)
    .values({ telegramId, username, firstName, lastName, role })
    .returning();

  return user;
}

export async function getUserByTelegramId(telegramId: string): Promise<User | null> {
  const rows = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.telegramId, telegramId));
  return rows[0] ?? null;
}

export async function getAllUsers(): Promise<User[]> {
  return db.select().from(usersTable);
}

export async function updateUserRole(userId: number, role: Role): Promise<void> {
  await db.update(usersTable).set({ role }).where(eq(usersTable.id, userId));
}

export function userDisplayName(user: User): string {
  if (user.firstName || user.lastName) {
    return [user.firstName, user.lastName].filter(Boolean).join(" ");
  }
  return user.username ? `@${user.username}` : `用户#${user.id}`;
}
