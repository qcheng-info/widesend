import { RETENTION_MS } from '../shared/audit';

// Share-room activity for the admin dashboard. Reads only; the ShareRoom and
// member reports write these tables (see worker/share-activity.ts).
const roomStatusSQL = `CASE WHEN r.end_reason IS NOT NULL THEN r.end_reason
  WHEN r.expires_at < ? THEN 'expired' ELSE 'open' END`;

export async function roomsAPI(url: URL, db: D1Database): Promise<Response> {
  const now = Date.now(),
    cutoff = now - RETENTION_MS;
  const detail = /^\/api\/rooms\/([a-f0-9]{64})$/.exec(url.pathname);
  if (detail) return roomDetail(db, detail[1], now, cutoff);
  if (url.pathname !== '/api/rooms') return Response.json({ error: 'Not found' }, { status: 404 });
  const clauses = ['r.created_at>=?'];
  const args: (string | number)[] = [cutoff];
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > 200) return Response.json({ error: 'Search is too long' }, { status: 400 });
  if (q) {
    // D1 rejects LIKE patterns over 50 bytes; longer searches match exactly only.
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const named = new TextEncoder().encode(like).length <= 50;
    clauses.push(`(r.id=? OR r.code=?
      ${named ? "OR EXISTS (SELECT 1 FROM share_members m WHERE m.room_id=r.id AND m.name LIKE ? ESCAPE '\\')" : ''}
      OR EXISTS (SELECT 1 FROM share_connections c WHERE c.room_id=r.id AND c.ip=?)
      OR EXISTS (SELECT 1 FROM share_offer_files f WHERE f.room_id=r.id
        AND (f.md5=? OR f.sha256=?${named ? " OR f.name LIKE ? ESCAPE '\\'" : ''})))`);
    args.push(q, q.toUpperCase());
    if (named) args.push(like);
    args.push(q, q.toLowerCase(), q.toLowerCase());
    if (named) args.push(like);
  }
  const before = url.searchParams.get('before');
  if (before) {
    const id = url.searchParams.get('beforeId') || '';
    if (!/^\d{1,16}$/.test(before) || !/^[a-f0-9]{64}$/.test(id))
      return Response.json({ error: 'Invalid page' }, { status: 400 });
    clauses.push('(r.created_at<? OR (r.created_at=? AND r.id<?))');
    args.push(Number(before), Number(before), id);
  }
  const rows = await db
    .prepare(
      `SELECT r.*, ${roomStatusSQL} AS status,
      (SELECT COUNT(*) FROM share_members m WHERE m.room_id=r.id) AS member_count,
      (SELECT COUNT(*) FROM share_offers o WHERE o.room_id=r.id) AS offer_count,
      (SELECT COALESCE(SUM(m.message_count),0) FROM share_members m WHERE m.room_id=r.id) AS message_count,
      (SELECT name FROM share_members m WHERE m.room_id=r.id AND m.is_owner=1) AS owner_name
      FROM share_rooms r WHERE ${clauses.join(' AND ')}
      ORDER BY r.created_at DESC, r.id DESC LIMIT 51`,
    )
    .bind(now, ...args)
    .all<{ id: string; created_at: number }>();
  const items = rows.results.slice(0, 50),
    last = items.at(-1);
  return Response.json({
    items,
    next: rows.results.length > 50 && last ? { before: last.created_at, beforeId: last.id } : null,
    retentionDays: 90,
  });
}

async function roomDetail(db: D1Database, id: string, now: number, cutoff: number) {
  const room = await db
    .prepare(
      `SELECT r.*, ${roomStatusSQL} AS status FROM share_rooms r WHERE r.id=? AND r.created_at>=?`,
    )
    .bind(now, id, cutoff)
    .first();
  if (!room) return Response.json({ error: 'Not found' }, { status: 404 });
  const locator = (room as { locator?: string | null }).locator ?? '';
  const [members, connections, offers, files, deliveries, refusals] = await db.batch([
    db
      .prepare(
        'SELECT member_id,name,is_owner,joined_at,left_at,left_reason,message_count,message_bytes FROM share_members WHERE room_id=? ORDER BY joined_at,member_id',
      )
      .bind(id),
    db
      .prepare(
        `SELECT c.member_id, COALESCE(m.name,'') AS member_name, c.ip, c.country, c.connected_at, c.disconnected_at,
          c.closed_by, c.close_code, c.close_reason
        FROM share_connections c LEFT JOIN share_members m ON m.room_id=c.room_id AND m.member_id=c.member_id
        WHERE c.room_id=? ORDER BY c.connected_at DESC LIMIT 200`,
      )
      .bind(id),
    db
      .prepare(
        `SELECT o.offer_id, o.sender_id, COALESCE(m.name,'') AS sender_name, o.created_at, o.file_count, o.total_size
        FROM share_offers o LEFT JOIN share_members m ON m.room_id=o.room_id AND m.member_id=o.sender_id
        WHERE o.room_id=? ORDER BY o.created_at DESC LIMIT 200`,
      )
      .bind(id),
    db
      .prepare(
        'SELECT offer_id,file_id,name,size,mime_type,md5,sha256 FROM share_offer_files WHERE room_id=? ORDER BY offer_id,file_id LIMIT 5000',
      )
      .bind(id),
    db
      .prepare(
        `SELECT d.offer_id, d.recipient_id, COALESCE(m.name,'') AS recipient_name, d.status, d.route, d.updated_at, d.finished_at
        FROM share_deliveries d LEFT JOIN share_members m ON m.room_id=d.room_id AND m.member_id=d.recipient_id
        WHERE d.room_id=? ORDER BY d.offer_id, recipient_name LIMIT 5000`,
      )
      .bind(id),
    // Attempts turned away: by this room, or before reaching it (same lookup hash).
    db
      .prepare(
        `SELECT at, role, ip, country, code, reason FROM refusals
        WHERE kind='room' AND (room_id=? OR target=?) AND at>=? ORDER BY at DESC LIMIT 100`,
      )
      .bind(id, locator, cutoff),
  ]);
  const group = <T extends { offer_id: string }>(rows: T[]) => {
    const map = new Map<string, Omit<T, 'offer_id'>[]>();
    for (const { offer_id, ...row } of rows) map.set(offer_id, [...(map.get(offer_id) ?? []), row]);
    return map;
  };
  const filesBy = group(files.results as { offer_id: string }[]);
  const deliveriesBy = group(deliveries.results as { offer_id: string }[]);
  return Response.json({
    room,
    members: members.results,
    connections: connections.results,
    refusals: refusals.results,
    offers: (offers.results as { offer_id: string }[]).map((o) => ({
      ...o,
      files: filesBy.get(o.offer_id) ?? [],
      deliveries: deliveriesBy.get(o.offer_id) ?? [],
    })),
  });
}
