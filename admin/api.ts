import { RETENTION_MS } from '../shared/audit';
import { statusSQL } from './status';
import { healthOverview } from './health';
import { roomsAPI } from './rooms';
import type { ProtectionHealth } from '../shared/health';
import { PAIRING_MS } from '../shared/protocol';
export async function adminAPI(
  url: URL,
  db: D1Database,
  email: string,
  protection?: () => Promise<ProtectionHealth>,
  // Where Sign out goes: Cloudflare Access, or the password sign-in's /logout.
  signOut = '/cdn-cgi/access/logout',
): Promise<Response> {
  const now = Date.now(),
    cutoff = now - RETENTION_MS;
  if (url.pathname === '/api/me') return Response.json({ email, signOut, retentionDays: 90 });
  if (url.pathname === '/api/health-overview') return healthOverview(db, protection);
  if (url.pathname === '/api/rooms' || url.pathname.startsWith('/api/rooms/'))
    return roomsAPI(url, db);
  const detail = /^\/api\/transfers\/([a-f0-9]{64})$/.exec(url.pathname);
  if (detail) {
    const transfer = await db
      .prepare(
        `SELECT t.*, ${statusSQL} AS status FROM transfers t WHERE t.id=? AND t.started_at>=?`,
      )
      .bind(now, now - PAIRING_MS, detail[1], cutoff)
      .first();
    if (!transfer) return Response.json({ error: 'Not found' }, { status: 404 });
    const [connections, files, refusals] = await Promise.all([
      db
        .prepare(
          'SELECT role,ip,country,connected_at,disconnected_at,closed_by,close_code,close_reason FROM connections WHERE transfer_id=? ORDER BY connected_at DESC LIMIT 200',
        )
        .bind(detail[1])
        .all(),
      db
        .prepare(
          'SELECT file_id,role,name,size,mime_type,md5,sha256,reported_at,completed_at FROM files WHERE transfer_id=? ORDER BY file_id,role',
        )
        .bind(detail[1])
        .all(),
      db
        .prepare(
          "SELECT at,role,ip,country,code,reason FROM refusals WHERE kind='transfer' AND room_id=? AND at>=? ORDER BY at DESC LIMIT 100",
        )
        .bind(detail[1], cutoff)
        .all(),
    ]);
    return Response.json({
      transfer,
      connections: connections.results,
      files: files.results,
      refusals: refusals.results,
    });
  }
  if (url.pathname !== '/api/transfers')
    return Response.json({ error: 'Not found' }, { status: 404 });
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length > 200) return Response.json({ error: 'Search is too long' }, { status: 400 });
  const clauses = ['t.started_at>=?'];
  const args: (string | number)[] = [cutoff];
  for (const key of ['from', 'to'] as const) {
    const raw = url.searchParams.get(key);
    if (!raw) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw)))
      return Response.json({ error: 'Invalid date' }, { status: 400 });
    clauses.push(`t.started_at${key === 'from' ? '>=' : '<'}?`);
    args.push(Date.parse(raw) + (key === 'to' ? 86_400_000 : 0));
  }
  if (q) {
    clauses.push(
      `(t.id=? OR t.code=? OR EXISTS (SELECT 1 FROM connections c WHERE c.transfer_id=t.id AND c.ip=?) OR EXISTS (SELECT 1 FROM files f WHERE f.transfer_id=t.id AND (f.md5=? OR f.sha256=? OR f.name LIKE ? ESCAPE '\\')))`,
    );
    args.push(
      q,
      q.toUpperCase(),
      q,
      q.toLowerCase(),
      q.toLowerCase(),
      `%${q.replace(/[\\%_]/g, '\\$&')}%`,
    );
  }
  const status = url.searchParams.get('status');
  if (status) {
    if (
      ![
        'waiting',
        'transferring',
        'complete',
        'error',
        'cancelled',
        'interrupted',
        'expired',
      ].includes(status)
    )
      return Response.json({ error: 'Invalid status' }, { status: 400 });
    clauses.push(`(${statusSQL})=?`);
    args.push(now, now - PAIRING_MS, status);
  }
  const before = url.searchParams.get('before');
  if (before) {
    const id = url.searchParams.get('beforeId') || '';
    if (
      !/^\d{1,16}$/.test(before) ||
      !Number.isSafeInteger(Number(before)) ||
      !/^[a-f0-9]{64}$/.test(id)
    )
      return Response.json({ error: 'Invalid page' }, { status: 400 });
    clauses.push('(t.started_at<? OR (t.started_at=? AND t.id<?))');
    args.push(Number(before), Number(before), id);
  }
  const rows = await db
    .prepare(
      `SELECT t.*, ${statusSQL} AS status,
    (SELECT COUNT(*) FROM files f WHERE f.transfer_id=t.id AND f.role='send') AS file_count,
    (SELECT SUM(size) FROM files f WHERE f.transfer_id=t.id AND f.role='send') AS total_size,
    (SELECT ip FROM connections c WHERE c.transfer_id=t.id AND c.role='send' ORDER BY connected_at DESC LIMIT 1) AS sender_ip,
    (SELECT ip FROM connections c WHERE c.transfer_id=t.id AND c.role='receive' ORDER BY connected_at DESC LIMIT 1) AS receiver_ip
    FROM transfers t WHERE ${clauses.join(' AND ')} ORDER BY t.started_at DESC,t.id DESC LIMIT 51`,
    )
    .bind(now, now - PAIRING_MS, ...args)
    .all<{ id: string; started_at: number }>();
  const items = rows.results.slice(0, 50),
    last = items.at(-1);
  return Response.json({
    items,
    next: rows.results.length > 50 && last ? { before: last.started_at, beforeId: last.id } : null,
    retentionDays: 90,
  });
}
