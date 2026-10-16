import { DAY, type ProtectionHealth } from '../shared/health';
import { RETENTION_MS } from '../shared/audit';
import { statusSQL } from './status';
import type { CleanupHealth } from '../shared/cleanup';
import { PAIRING_MS } from '../shared/protocol';

export async function cleanupHealth(db: D1Database, now = Date.now()): Promise<CleanupHealth> {
  const [state, overdue] = await db.batch([
    db.prepare('SELECT * FROM activity_cleanup WHERE id=1'),
    db
      .prepare(
        'SELECT COUNT(*) AS count,MIN(started_at) AS oldest FROM transfers WHERE started_at<?',
      )
      .bind(now - RETENTION_MS),
  ]);
  const s = state.results[0] as {
    last_started_at: number | null;
    last_finished_at: number | null;
    last_success_at: number | null;
    last_error_at: number | null;
    lease_until: number;
    deleted_transfers: number;
    deleted_rows: number;
    rows_written: number;
  };
  if (!s) throw new Error('Cleanup status unavailable');
  const remaining = overdue.results[0] as { count: number; oldest: number | null };
  return {
    observedAt: now,
    lastStartedAt: s.last_started_at,
    lastFinishedAt: s.last_finished_at,
    lastSuccessAt: s.last_success_at,
    lastErrorAt: s.last_error_at,
    running: s.lease_until > now,
    deletedTransfers: s.deleted_transfers,
    deletedRows: s.deleted_rows,
    rowsWritten: s.rows_written,
    overdueTransfers: remaining.count,
    oldestExpiredAt: remaining.oldest,
  };
}

const statuses = [
  'waiting',
  'transferring',
  'complete',
  'error',
  'cancelled',
  'interrupted',
  'expired',
] as const;
type Status = (typeof statuses)[number];
type Route = 'direct' | 'relay' | 'unknown';
type Cohort = { day: number; status: Status; route: Route; count: number };
const summary = () => ({
  total: 0,
  outcomes: Object.fromEntries(statuses.map((s) => [s, 0])) as Record<Status, number>,
  routes: { direct: 0, relay: 0, unknown: 0 },
  reconnections: 0,
});

export async function activityHealth(db: D1Database, now = Date.now()) {
  const today = Math.floor(now / DAY) * DAY,
    from = today - 6 * DAY;
  const [cohorts, reconnects] = await db.batch([
    db
      .prepare(
        `SELECT day,status,route,COUNT(*) AS count FROM (
      SELECT CAST(t.started_at/${DAY} AS INTEGER)*${DAY} AS day,
      ${statusSQL} AS status,
      CASE WHEN t.sender_route='relay' OR t.receiver_route='relay' THEN 'relay'
      WHEN t.sender_route='direct' OR t.receiver_route='direct' THEN 'direct' ELSE 'unknown' END AS route
      FROM transfers t WHERE t.started_at>=? AND t.started_at<=?
    ) GROUP BY day,status,route`,
      )
      .bind(now, now - PAIRING_MS, from, now),
    db
      .prepare(
        `SELECT CAST(c.connected_at/${DAY} AS INTEGER)*${DAY} AS day,COUNT(*) AS count
      FROM connections c JOIN transfers t ON t.id=c.transfer_id
      WHERE c.connected_at>=? AND c.connected_at<=? AND t.started_at>=?
      AND EXISTS (SELECT 1 FROM connections earlier
        WHERE earlier.transfer_id=c.transfer_id AND earlier.role=c.role
        AND (earlier.connected_at<c.connected_at OR (earlier.connected_at=c.connected_at AND earlier.id<c.id)))
      GROUP BY day`,
      )
      .bind(from, now, now - RETENTION_MS),
  ]);
  const daily = Array.from({ length: 7 }, (_, n) => ({ from: from + n * DAY, ...summary() }));
  for (const row of cohorts.results as Cohort[]) {
    const day = daily.find((d) => d.from === row.day)!;
    day.total += row.count;
    day.outcomes[row.status] += row.count;
    day.routes[row.route] += row.count;
  }
  for (const row of reconnects.results as { day: number; count: number }[])
    daily.find((d) => d.from === row.day)!.reconnections = row.count;
  const last7Days = summary();
  for (const day of daily) {
    last7Days.total += day.total;
    last7Days.reconnections += day.reconnections;
    for (const key of statuses) last7Days.outcomes[key] += day.outcomes[key];
    for (const key of ['direct', 'relay', 'unknown'] as const)
      last7Days.routes[key] += day.routes[key];
  }
  return { today: { ...daily[6], to: now }, last7Days: { ...last7Days, from, to: now }, daily };
}

export async function healthOverview(
  db: D1Database,
  protection?: () => Promise<ProtectionHealth>,
  now = Date.now(),
): Promise<Response> {
  const [activity, guard, cleanup] = await Promise.allSettled([
    activityHealth(db, now),
    protection
      ? Promise.resolve().then(protection)
      : Promise.reject(new Error('Protection unavailable')),
    cleanupHealth(db, now),
  ]);
  if (activity.status === 'rejected' && guard.status === 'rejected')
    return Response.json({ error: 'Health overview is temporarily unavailable.' }, { status: 503 });
  return Response.json({
    generatedAt: now,
    activity: activity.status === 'fulfilled' ? activity.value : null,
    protection: guard.status === 'fulfilled' ? guard.value : null,
    cleanup: cleanup.status === 'fulfilled' ? cleanup.value : null,
  });
}
