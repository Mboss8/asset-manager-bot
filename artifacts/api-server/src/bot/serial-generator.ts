import { db, tasksTable, requirementsTable, financeRecordsTable, documentsTable } from "@workspace/db";
import { desc, like } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type SerialPrefix = "T" | "R" | "F" | "D" | "LEDGER";

const TABLE_MAP: Record<SerialPrefix, { table: PgTable; column: PgColumn }> = {
  T: { table: tasksTable, column: tasksTable.serialNo },
  R: { table: requirementsTable, column: requirementsTable.serialNo },
  F: { table: financeRecordsTable, column: financeRecordsTable.serialNo },
  D: { table: documentsTable, column: documentsTable.serialNo },
  LEDGER: { table: financeRecordsTable, column: financeRecordsTable.ledgerSerial },
};

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function nextSerial(prefix: SerialPrefix, offset: number): Promise<string> {
  const month = currentMonth();
  const { table, column } = TABLE_MAP[prefix];
  const pattern = `${prefix}-${month}-%`;

  const [row] = await db
    .select({ serial: column })
    .from(table)
    .where(like(column as PgColumn, pattern))
    .orderBy(desc(column as PgColumn))
    .limit(1);

  let next = 1;
  const existing = row?.serial as string | null | undefined;
  if (existing) {
    const tail = existing.split("-").pop();
    const n = tail ? parseInt(tail, 10) : NaN;
    if (!isNaN(n)) next = n + 1;
  }
  return `${prefix}-${month}-${String(next + offset).padStart(4, "0")}`;
}

/**
 * Generate a monthly-incrementing business serial number.
 * Format: PREFIX-YYYYMM-XXXX  e.g. T-202605-0001
 *
 * Caller should insert immediately. On UNIQUE collision (concurrent inserts),
 * call generateSerialNo again with retry — see helper `withSerialRetry`.
 */
export async function generateSerialNo(prefix: SerialPrefix): Promise<string> {
  return nextSerial(prefix, 0);
}

/**
 * Run an insert that needs a fresh serial_no, retrying on unique-constraint
 * collisions caused by concurrent inserts. Returns the inserted row.
 */
export async function withSerialRetry<T>(
  prefix: SerialPrefix,
  insert: (serialNo: string) => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const serial = await nextSerial(prefix, i);
    try {
      return await insert(serial);
    } catch (err) {
      lastErr = err;
      const code = (err as { code?: string })?.code;
      if (code !== "23505") throw err;
    }
  }
  throw lastErr;
}
