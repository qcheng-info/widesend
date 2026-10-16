import type { RoomReport } from '../shared/room';
import type { CloseRecord } from '../shared/diagnostics';
import { closeColumns } from './diagnostics';

// Share-room activity for the private admin dashboard. The room writes what it
// observes; offers and deliveries arrive as validated member reports.
export async function recordRoom(
  db: D1Database,
  room: { id: string; code: string; locator?: string; created: number; expires: number },
): Promise<void> {
  await db
    .prepare(
      'INSERT OR IGNORE INTO share_rooms (id,code,locator,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?)',
    )
    .bind(room.id, room.code, room.locator ?? null, room.created, room.created, room.expires)
    .run();
}
export async function recordMember(
  db: D1Database,
  roomId: string,
  member: { id: string; name: string; role: 'owner' | 'member'; joined: number },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO share_members (room_id,member_id,name,is_owner,joined_at) VALUES (?,?,?,?,?)',
      )
      .bind(roomId, member.id, member.name, member.role === 'owner' ? 1 : 0, member.joined),
    db.prepare('UPDATE share_rooms SET updated_at=? WHERE id=?').bind(member.joined, roomId),
  ]);
}
export async function recordMemberLeft(
  db: D1Database,
  roomId: string,
  memberId: string,
  reason: 'left' | 'removed',
  at: number,
): Promise<void> {
  await db
    .prepare(
      'UPDATE share_members SET left_at=COALESCE(left_at,?),left_reason=COALESCE(left_reason,?) WHERE room_id=? AND member_id=?',
    )
    .bind(at, reason, roomId, memberId)
    .run();
}
export async function recordRoomEnded(
  db: D1Database,
  roomId: string,
  reason: 'dismissed' | 'expired',
  at: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        'UPDATE share_rooms SET ended_at=COALESCE(ended_at,?),end_reason=COALESCE(end_reason,?),updated_at=? WHERE id=?',
      )
      .bind(at, reason, at, roomId),
    db
      .prepare(
        'UPDATE share_members SET left_at=COALESCE(left_at,?),left_reason=COALESCE(left_reason,?) WHERE room_id=?',
      )
      .bind(at, reason, roomId),
  ]);
}
export async function recordRoomConnection(
  db: D1Database,
  roomId: string,
  connection: string,
  memberId: string,
  ip: string,
  country: string,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO share_connections (id,room_id,member_id,ip,country,connected_at) VALUES (?,?,?,?,?,?)',
      )
      .bind(connection, roomId, memberId, ip, country, now),
    db.prepare('UPDATE share_rooms SET updated_at=? WHERE id=?').bind(now, roomId),
  ]);
}
export async function recordRoomDisconnection(
  db: D1Database,
  connection: string,
  at: number,
  close?: CloseRecord,
): Promise<void> {
  const why = close && closeColumns(close);
  await db
    .prepare(
      `UPDATE share_connections SET disconnected_at=COALESCE(disconnected_at,?)${why ? `,${why.sql}` : ''} WHERE id=?`,
    )
    .bind(at, ...(why?.values ?? []), connection)
    .run();
}

const rank = (column: string) =>
  `CASE ${column} WHEN 'offered' THEN 0 WHEN 'accepted' THEN 1 WHEN 'transferring' THEN 2 ELSE 3 END`;
// `reporter` is the authenticated member that sent the report. Recipients report
// their own deliveries; the sender may only cancel or fail them.
export async function recordRoomReport(
  db: D1Database,
  roomId: string,
  reporter: string,
  report: RoomReport,
): Promise<void> {
  const now = Date.now();
  if (report.event === 'messages') {
    // Totals only grow, so a late or repeated report never lowers them.
    await db
      .prepare(
        'UPDATE share_members SET message_count=MAX(message_count,?),message_bytes=MAX(message_bytes,?) WHERE room_id=? AND member_id=?',
      )
      .bind(report.count, report.bytes, roomId, reporter)
      .run();
    return;
  }
  if (report.event === 'offer') {
    const statements: D1PreparedStatement[] = [
      db
        .prepare(
          'INSERT OR IGNORE INTO share_offers (room_id,offer_id,sender_id,created_at,file_count,total_size) VALUES (?,?,?,?,?,?)',
        )
        .bind(
          roomId,
          report.offer,
          reporter,
          now,
          report.files.length,
          report.files.reduce((sum, f) => sum + f.size, 0),
        ),
    ];
    // Ten rows per statement stay within D1's 100-bound-parameter limit.
    for (let start = 0; start < report.files.length; start += 10) {
      const batch = report.files.slice(start, start + 10);
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO share_offer_files (room_id,offer_id,file_id,name,size,mime_type,md5,sha256)
            SELECT ?1,?2,v.column1,v.column2,v.column3,v.column4,v.column5,v.column6
            FROM (VALUES ${batch.map((_, i) => `(${[0, 1, 2, 3, 4, 5].map((c) => `?${4 + i * 6 + c}`).join(',')})`).join(',')}) v
            WHERE EXISTS (SELECT 1 FROM share_offers WHERE room_id=?1 AND offer_id=?2 AND sender_id=?3)`,
          )
          .bind(
            roomId,
            report.offer,
            reporter,
            ...batch.flatMap((f) => [
              f.id,
              f.name,
              f.size,
              f.type,
              report.md5[f.id],
              report.sha256[f.id],
            ]),
          ),
      );
    }
    for (let start = 0; start < report.recipients.length; start += 20) {
      const batch = report.recipients.slice(start, start + 20);
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO share_deliveries (room_id,offer_id,recipient_id,updated_at)
            SELECT ?1,?2,v.column1,?4 FROM (VALUES ${batch.map((_, i) => `(?${5 + i})`).join(',')}) v
            WHERE EXISTS (SELECT 1 FROM share_offers WHERE room_id=?1 AND offer_id=?2 AND sender_id=?3)`,
          )
          .bind(roomId, report.offer, reporter, now, ...batch),
      );
    }
    await db.batch(statements);
    return;
  }
  const bySender = report.status === 'cancelled' || report.status === 'failed';
  await db
    .prepare(
      `UPDATE share_deliveries SET
      status=CASE WHEN ${rank('?1')} > ${rank('status')} THEN ?1 ELSE status END,
      route=CASE WHEN ${rank('status')}=3 OR route='relay' OR ?2='connecting' THEN route ELSE ?2 END,
      finished_at=CASE WHEN finished_at IS NULL AND ${rank('?1')}=3 AND ${rank('status')}<3 THEN ?3 ELSE finished_at END,
      updated_at=?3
      WHERE room_id=?4 AND offer_id=?5 AND recipient_id=?6 AND (
        recipient_id=?7 OR (?8 AND ?7=(SELECT sender_id FROM share_offers WHERE room_id=?4 AND offer_id=?5))
      )`,
    )
    .bind(
      report.status,
      report.route,
      now,
      roomId,
      report.offer,
      report.recipient,
      reporter,
      bySender ? 1 : 0,
    )
    .run();
}

// Bounded deletion of rooms older than the cutoff, children first. Returns what it
// wrote so the caller can keep the hourly job within its write budget.
export async function pruneRooms(
  db: D1Database,
  cutoff: number,
  budget: number,
): Promise<{ written: number; deletedRows: number; deletedRooms: number }> {
  let written = 0,
    deletedRows = 0,
    deletedRooms = 0;
  for (let round = 0; round < 6 && written < budget - 8; round++) {
    const candidates = await db
      .prepare('SELECT id FROM share_rooms WHERE created_at<? ORDER BY created_at,id LIMIT 20')
      .bind(cutoff)
      .all<{ id: string }>();
    const ids = candidates.results.map((r) => r.id);
    if (!ids.length) break;
    const slots = ids.map(() => '?').join(',');
    for (const [table, cost] of [
      ['share_offer_files', 4],
      ['share_deliveries', 2],
      ['share_offers', 2],
      ['share_connections', 4],
      ['share_members', 3],
      ['share_rooms', 4],
    ] as const) {
      const limit = Math.min(200, Math.floor((budget - written) / cost));
      if (!limit) break;
      const query =
        table === 'share_rooms'
          ? `DELETE FROM share_rooms WHERE id IN (SELECT id FROM share_rooms WHERE id IN (${slots})
              AND NOT EXISTS (SELECT 1 FROM share_members WHERE room_id=share_rooms.id)
              AND NOT EXISTS (SELECT 1 FROM share_connections WHERE room_id=share_rooms.id)
              AND NOT EXISTS (SELECT 1 FROM share_offers WHERE room_id=share_rooms.id) LIMIT ?)`
          : table === 'share_offers'
            ? `DELETE FROM share_offers WHERE rowid IN (SELECT rowid FROM share_offers o WHERE room_id IN (${slots})
                AND NOT EXISTS (SELECT 1 FROM share_offer_files f WHERE f.room_id=o.room_id AND f.offer_id=o.offer_id)
                AND NOT EXISTS (SELECT 1 FROM share_deliveries d WHERE d.room_id=o.room_id AND d.offer_id=o.offer_id) LIMIT ?)`
            : `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE room_id IN (${slots}) LIMIT ?)`;
      const result = await db
        .prepare(query)
        .bind(...ids, limit)
        .run();
      written += result.meta.rows_written;
      deletedRows += result.meta.changes;
      if (table === 'share_rooms') deletedRooms += result.meta.changes;
    }
  }
  return { written, deletedRows, deletedRooms };
}
