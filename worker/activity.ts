import { RETENTION_MS, type AuditReport } from '../shared/audit';
import { pruneRooms } from './share-activity';
import type { Role } from '../shared/protocol';
import type { CloseRecord } from '../shared/diagnostics';
import { closeColumns } from './diagnostics';

export async function activityId(owner: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`widesend-activity:${owner}`),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function recordConnection(
  db: D1Database,
  id: string,
  connection: string,
  role: Role,
  ip: string,
  country: string,
  expires: number,
  code: string | null = null,
  slot = 0,
  uses = 1,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO transfers (id,started_at,updated_at,expires_at,code,slot,uses) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(id, now, now, expires, code, slot, uses),
    db
      .prepare(
        'INSERT OR IGNORE INTO connections (id,transfer_id,role,ip,country,connected_at) VALUES (?,?,?,?,?,?)',
      )
      .bind(connection, id, role, ip, country, now),
    db
      .prepare('UPDATE transfers SET updated_at=?,code=COALESCE(code,?) WHERE id=?')
      .bind(now, code, id),
  ]);
}
export async function recordDisconnection(
  db: D1Database,
  connection: string,
  at: number,
  close: CloseRecord,
): Promise<void> {
  const why = closeColumns(close);
  await db
    .prepare(
      `UPDATE connections SET disconnected_at=COALESCE(disconnected_at,?),${why.sql} WHERE id=?`,
    )
    .bind(at, ...why.values, connection)
    .run();
}
export async function recordReport(
  db: D1Database,
  id: string,
  role: Role,
  report: AuditReport,
): Promise<void> {
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (report.event === 'status') {
    const side = role === 'send' ? 'sender' : 'receiver';
    // Side names are constants, never client-supplied SQL. Late retries cannot
    // change a terminal result back into an in-progress transfer.
    statements.push(
      db
        .prepare(
          `UPDATE transfers SET
      ${side}_status=CASE WHEN ${side}_status IN ('complete','error','cancelled') THEN ${side}_status ELSE ? END,
      ${side}_route=CASE WHEN ${side}_route='relay' THEN 'relay' WHEN ?='connecting' THEN ${side}_route ELSE ? END,
      ${side}_finished_at=CASE WHEN ? IN ('complete','error','cancelled') THEN COALESCE(${side}_finished_at,?) ELSE ${side}_finished_at END,
      updated_at=? WHERE id=?`,
        )
        .bind(report.status, report.route, report.route, report.status, now, now, id),
    );
  } else {
    const files = report.event === 'manifest' ? report.files : [report.file];
    // Ten rows per statement stay within D1's 100-bound-parameter limit,
    // including a 100-file manifest, without one query per file.
    for (let start = 0; start < files.length; start += 10) {
      const batch = files.slice(start, start + 10);
      const values: (string | number | null)[] = [];
      for (const f of batch)
        values.push(
          id,
          f.id,
          role,
          f.name,
          f.size,
          f.type,
          report.event === 'file' ? report.md5 : null,
          report.event === 'file' ? report.sha256 : null,
          now,
          report.event === 'file' ? now : null,
        );
      statements.push(
        db
          .prepare(
            `INSERT INTO files (transfer_id,file_id,role,name,size,mime_type,md5,sha256,reported_at,completed_at)
        VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')}
        ON CONFLICT(transfer_id,file_id,role) DO UPDATE SET
        md5=COALESCE(files.md5,excluded.md5),sha256=COALESCE(files.sha256,excluded.sha256),completed_at=COALESCE(files.completed_at,excluded.completed_at)`,
          )
          .bind(...values),
      );
    }
    statements.push(db.prepare('UPDATE transfers SET updated_at=? WHERE id=?').bind(now, id));
  }
  await db.batch(statements);
}
export async function pruneActivity(db: D1Database, now = Date.now()): Promise<void> {
  const run = crypto.randomUUID(),
    cutoff = now - RETENTION_MS;
  // Hourly, single-run lease. State writes and at most 40 deletion/selection
  // statements stay within the free Worker's subrequest allowance.
  const lock = await db
    .prepare(
      'UPDATE activity_cleanup SET run_id=?,lease_until=?,last_started_at=? WHERE id=1 AND lease_until<=? RETURNING id',
    )
    .bind(run, now + 15 * 60_000, now, now)
    .first();
  if (!lock) return;
  let written = 0,
    deletedRows = 0,
    deletedTransfers = 0;
  const budget = 1976; // Leave room for maintenance status writes (<2,000/run).
  try {
    for (let round = 0; round < 10 && written < budget - 6; round++) {
      const candidates = await db
        .prepare('SELECT id FROM transfers WHERE started_at<? ORDER BY started_at,id LIMIT 50')
        .bind(cutoff)
        .all<{ id: string }>();
      const ids = candidates.results.map((r) => r.id);
      if (!ids.length) break;
      const slots = ids.map(() => '?').join(',');
      // Delete children in bounded pieces. Cascading an entire transfer could
      // otherwise delete thousands of reconnection/file rows in one statement.
      for (const [table, cost] of [
        ['files', 4],
        ['connections', 6],
        ['transfers', 4],
      ] as const) {
        const limit = Math.min(100, Math.floor((budget - written) / cost));
        if (!limit) break;
        const query =
          table === 'transfers'
            ? `DELETE FROM transfers WHERE id IN (SELECT id FROM transfers WHERE id IN (${slots}) AND NOT EXISTS (SELECT 1 FROM files WHERE transfer_id=transfers.id) AND NOT EXISTS (SELECT 1 FROM connections WHERE transfer_id=transfers.id) LIMIT ?)`
            : `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE transfer_id IN (${slots}) LIMIT ?)`;
        const result = await db
          .prepare(query)
          .bind(...ids, limit)
          .run();
        written += result.meta.rows_written;
        deletedRows += result.meta.changes;
        if (table === 'transfers') deletedTransfers += result.meta.changes;
      }
    }
    // Share rooms use whatever budget the one-to-one transfers left this hour.
    if (written < budget - 8) {
      const rooms = await pruneRooms(db, cutoff, budget - written);
      written += rooms.written;
      deletedRows += rooms.deletedRows;
    }
    // Refused attempts: each row has four indexes, so about five writes apiece.
    const refusals = Math.min(500, Math.floor((budget - written) / 5));
    if (refusals > 0) {
      const result = await db
        .prepare(
          'DELETE FROM refusals WHERE rowid IN (SELECT rowid FROM refusals WHERE at<? LIMIT ?)',
        )
        .bind(cutoff, refusals)
        .run();
      written += result.meta.rows_written;
      deletedRows += result.meta.changes;
    }
    await db
      .prepare(
        'UPDATE activity_cleanup SET lease_until=0,last_finished_at=?,last_success_at=?,deleted_transfers=?,deleted_rows=?,rows_written=? WHERE id=1 AND run_id=?',
      )
      .bind(Date.now(), Date.now(), deletedTransfers, deletedRows, written, run)
      .run();
  } catch (error) {
    try {
      await db
        .prepare(
          'UPDATE activity_cleanup SET lease_until=0,last_finished_at=?,last_error_at=?,deleted_transfers=?,deleted_rows=?,rows_written=? WHERE id=1 AND run_id=?',
        )
        .bind(Date.now(), Date.now(), deletedTransfers, deletedRows, written, run)
        .run();
    } catch {
      /* An unfinished/stale run remains visible if D1 is unavailable. */
    }
    throw error;
  }
}
