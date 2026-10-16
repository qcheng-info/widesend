import { utcDay } from '../shared/relay';
import type { CloseRecord } from '../shared/diagnostics';

// Attempts turned away before a connection started. `room` is the activity ID
// when the room or transfer exists; `target` is the opaque hash from the URL.
export type Refusal = {
  kind: 'room' | 'transfer';
  room?: string | null;
  target?: string | null;
  role?: string | null;
  ip: string;
  country: string;
  code: number;
  reason: string;
};
// Floods are already stopped by the admission limits; these caps keep one
// network, or everyone together, from spending the database's daily writes.
export const REFUSAL_CAPS = { perDay: 2000, perIp: 50 };

/** Records a refusal unless a cap is reached; returns whether it was written. */
export async function recordRefusal(
  db: D1Database,
  r: Refusal,
  caps = REFUSAL_CAPS,
): Promise<boolean> {
  const now = Date.now(),
    day = utcDay(now);
  const result = await db
    .prepare(
      `INSERT INTO refusals (id,at,kind,room_id,target,role,ip,country,code,reason)
       SELECT ?,?,?,?,?,?,?,?,?,?
       WHERE (SELECT COUNT(*) FROM refusals WHERE at>=?)<?
         AND (SELECT COUNT(*) FROM refusals WHERE ip=? AND at>=?)<?`,
    )
    .bind(
      crypto.randomUUID(),
      now,
      r.kind,
      r.room ?? null,
      r.target ?? null,
      r.role ?? null,
      r.ip,
      r.country,
      r.code,
      r.reason,
      day,
      caps.perDay,
      r.ip,
      day,
      caps.perIp,
    )
    .run();
  return result.meta.changes === 1;
}

/** SQL fragment and values that record why a connection ended; the first record wins. */
export function closeColumns(close: CloseRecord) {
  return {
    sql: `closed_by=COALESCE(closed_by,?),
      close_code=CASE WHEN closed_by IS NULL THEN ? ELSE close_code END,
      close_reason=CASE WHEN closed_by IS NULL THEN ? ELSE close_reason END`,
    values: [close.by, close.code, close.reason],
  };
}

/**
 * Unexpected failures go to Workers Logs (errors only; invocation logs are off).
 * Never pass IP addresses, names or file details here.
 */
export function logError(event: string, fields: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ event, ...fields }));
}
export const short = (id: string | undefined | null) => (id ? id.slice(0, 8) : undefined);
// JSON parse errors quote the start of the input, so they are never logged verbatim.
export const errorText = (error: unknown) =>
  error instanceof SyntaxError
    ? 'Not valid JSON'
    : error instanceof Error
      ? error.message
      : String(error);
