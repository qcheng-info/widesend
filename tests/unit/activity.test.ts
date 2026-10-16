import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { recordConnection, recordReport, pruneActivity, activityId } from '../../worker/activity';
import { adminAPI } from '../../admin/api';
import { validateAudit, RETENTION_MS } from '../../shared/audit';
import { cleanupHealth } from '../../admin/health';
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    d1Databases: ['ACTIVITY'],
  }),
);
let db: D1Database;
const id = 'a'.repeat(64),
  owner = 'owner@example.com';
const file = { id: 0, name: 'budget.csv', size: 3, type: 'text/csv' };
const md5 = '900150983cd24fb0d6963f7d28e17f72',
  sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
beforeAll(async () => {
  db = (await mf.getD1Database('ACTIVITY')) as unknown as D1Database;
  for (const migration of (await readdir(new URL('../../migrations', import.meta.url))).sort()) {
    const sql = await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8');
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
});
beforeEach(async () => {
  await db.prepare('DELETE FROM transfers').run();
  await db
    .prepare(
      'UPDATE activity_cleanup SET run_id=NULL,lease_until=0,last_started_at=NULL,last_finished_at=NULL,last_success_at=NULL,last_error_at=NULL,deleted_transfers=0,deleted_rows=0,rows_written=0',
    )
    .run();
});
afterAll(async () => {
  await mf.dispose();
});
async function create() {
  await recordConnection(
    db,
    id,
    crypto.randomUUID(),
    'send',
    '192.0.2.1',
    'CA',
    Date.now() + 86_400_000,
  );
}
async function get(path = '/api/transfers') {
  const response = await adminAPI(new URL('https://admin.example' + path), db, owner);
  return { status: response.status, body: (await response.json()) as any };
}
describe('activity records', () => {
  it('cleans a 500-transfer backlog over bounded hourly runs without deleting recent activity', async () => {
    const now = Date.now(),
      old = now - RETENTION_MS - 1000;
    await create();
    for (let start = 0; start < 500; start += 50) {
      await db.batch(
        Array.from({ length: 50 }, (_, i) =>
          db
            .prepare('INSERT INTO transfers(id,started_at,updated_at,expires_at) VALUES (?,?,?,?)')
            .bind(`expired-${start + i}`, old, old, old + 86400000),
        ),
      );
      await db.batch(
        Array.from({ length: 50 }, (_, i) =>
          db
            .prepare(
              "INSERT INTO files(transfer_id,file_id,role,name,size,mime_type,reported_at) VALUES (?,0,'send','old.bin',10,'',?)",
            )
            .bind(`expired-${start + i}`, old),
        ),
      );
      await db.batch(
        Array.from({ length: 50 }, (_, i) =>
          db
            .prepare(
              "INSERT INTO connections(id,transfer_id,role,ip,connected_at) VALUES (?,?,'send','192.0.2.1',?)",
            )
            .bind(`conn-${start + i}`, `expired-${start + i}`, old),
        ),
      );
    }
    let runs = 0;
    while ((await cleanupHealth(db, now)).overdueTransfers && runs < 24) {
      await pruneActivity(db, now);
      const status = await cleanupHealth(db, now);
      expect(status.rowsWritten).toBeLessThanOrEqual(1976);
      expect(status.lastSuccessAt).not.toBeNull();
      runs++;
    }
    expect(runs).toBeLessThan(24);
    expect((await cleanupHealth(db, now)).overdueTransfers).toBe(0);
    expect(await db.prepare('SELECT id FROM transfers').all()).toMatchObject({ results: [{ id }] });
    expect(await db.prepare('SELECT COUNT(*) FROM files').first('COUNT(*)')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) FROM connections').first('COUNT(*)')).toBe(1);
  }, 30_000);
  it('bounds deletion of a transfer with many child rows and resumes after a partial run', async () => {
    await create();
    const now = Date.now();
    await db
      .prepare('UPDATE transfers SET started_at=?')
      .bind(now - RETENTION_MS - 1000)
      .run();
    for (let start = 0; start < 1200; start += 50)
      await db.batch(
        Array.from({ length: 50 }, (_, n) =>
          db
            .prepare(
              "INSERT INTO connections(id,transfer_id,role,ip,connected_at) VALUES (?,?,'send','192.0.2.1',?)",
            )
            .bind(`extra-${start + n}`, id, now),
        ),
      );
    await pruneActivity(db, now);
    let status = await cleanupHealth(db, now);
    expect(status.overdueTransfers).toBe(1);
    expect(status.deletedRows).toBeGreaterThan(0);
    expect(status.rowsWritten).toBeLessThanOrEqual(1976);
    for (let i = 0; i < 5 && status.overdueTransfers; i++) {
      await pruneActivity(db, now);
      status = await cleanupHealth(db, now);
    }
    expect(status.overdueTransfers).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) FROM connections').first('COUNT(*)')).toBe(0);
  }, 20_000);
  it('does not overlap a running cleanup, and reports a failed run', async () => {
    const now = Date.now();
    await db
      .prepare('UPDATE activity_cleanup SET lease_until=?,last_started_at=?')
      .bind(now + 60000, now)
      .run();
    await pruneActivity(db, now);
    expect((await cleanupHealth(db, now)).running).toBe(true);
    await db.prepare('UPDATE activity_cleanup SET lease_until=0').run();
    const failing = {
      prepare(sql: string) {
        if (sql.startsWith('SELECT id FROM transfers'))
          throw new Error('Temporary database failure');
        return db.prepare(sql);
      },
    } as unknown as D1Database;
    await expect(pruneActivity(failing, now)).rejects.toThrow('Temporary database failure');
    expect((await cleanupHealth(db, now)).lastErrorAt).not.toBeNull();
    await pruneActivity(db, now);
    expect((await cleanupHealth(db, now)).lastSuccessAt).not.toBeNull();
  });
  it('retains a code for active and completed transfers and does not replace it on reconnect', async () => {
    await create();
    expect((await get('/api/transfers/' + id)).body.transfer.code).toBeNull();
    // A newer receiver can fill a code missing from a legacy sender's handshake.
    await recordConnection(
      db,
      id,
      crypto.randomUUID(),
      'receive',
      '198.51.100.2',
      'US',
      Date.now() + 86400000,
      'A1B2C3',
    );
    expect((await get('/api/transfers?q=a1b2c3')).body.items[0]).toMatchObject({
      id,
      code: 'A1B2C3',
    });
    await recordReport(db, id, 'send', {
      event: 'status',
      status: 'transferring',
      route: 'direct',
    });
    expect((await get('/api/transfers?q=A1B2C3&status=transferring')).body.items).toHaveLength(1);
    await recordConnection(
      db,
      id,
      crypto.randomUUID(),
      'send',
      '192.0.2.1',
      'CA',
      Date.now() + 86400000,
    );
    await recordConnection(
      db,
      id,
      crypto.randomUUID(),
      'send',
      '192.0.2.1',
      'CA',
      Date.now() + 86400000,
      'Z9Y8X7',
    );
    await recordReport(db, id, 'receive', { event: 'status', status: 'complete', route: 'direct' });
    expect((await get('/api/transfers/' + id)).body.transfer).toMatchObject({
      code: 'A1B2C3',
      status: 'complete',
    });
    expect((await get('/api/transfers?q=Z9Y8X7')).body.items).toHaveLength(0);
    // Reusing a short code later must create another history entry, not overwrite one.
    await recordConnection(
      db,
      'b'.repeat(64),
      crypto.randomUUID(),
      'send',
      '192.0.2.1',
      'CA',
      Date.now() + 86400000,
      'A1B2C3',
    );
    expect((await get('/api/transfers?q=A1B2C3')).body.items).toHaveLength(2);
  });
  it('links both participants and independent fingerprints, with stable terminal results', async () => {
    await create();
    await recordConnection(
      db,
      id,
      crypto.randomUUID(),
      'receive',
      '198.51.100.2',
      'US',
      Date.now() + 86_400_000,
    );
    for (const role of ['send', 'receive'] as const) {
      await recordReport(db, id, role, { event: 'manifest', files: [file] });
      await recordReport(db, id, role, { event: 'file', file, md5, sha256 });
      await recordReport(db, id, role, { event: 'status', status: 'complete', route: 'relay' });
      await recordReport(db, id, role, {
        event: 'status',
        status: 'transferring',
        route: 'direct',
      });
    }
    const result = await get('/api/transfers/' + id);
    expect(result.body.transfer.status).toBe('complete');
    expect(result.body.transfer.receiver_route).toBe('relay');
    expect(result.body.connections).toHaveLength(2);
    expect(result.body.files).toHaveLength(2);
    expect(result.body.files[0]).toMatchObject({ name: file.name, size: 3, md5, sha256 });
    for (const query of ['192.0.2.1', md5, sha256, 'budget'])
      expect((await get('/api/transfers?q=' + query)).body.items).toHaveLength(1);
    expect(
      (await get('/api/transfers?q=' + encodeURIComponent("' OR 1=1 --"))).body.items,
    ).toHaveLength(0);
    expect((await get('/api/transfers?q=%25')).body.items).toHaveLength(0);
  });
  it('supports 100 files, repeated manifests, and missing or differing reports', async () => {
    await create();
    const files = Array.from({ length: 100 }, (_, id) => ({ ...file, id }));
    await recordReport(db, id, 'send', { event: 'manifest', files });
    await recordReport(db, id, 'send', { event: 'manifest', files });
    await recordReport(db, id, 'send', { event: 'file', file, md5, sha256 });
    await recordReport(db, id, 'receive', {
      event: 'file',
      file,
      md5: 'b'.repeat(32),
      sha256: 'b'.repeat(64),
    });
    const result = await get('/api/transfers/' + id);
    expect(result.body.files).toHaveLength(101);
    expect(
      result.body.files
        .filter((f: any) => f.file_id === 0)
        .map((f: any) => f.md5)
        .sort(),
    ).toEqual([md5, 'b'.repeat(32)].sort());
    expect(result.body.files.find((f: any) => f.file_id === 1).md5).toBeNull();
  });
  it('hides old records before cleanup and cascades deletion after 90 days', async () => {
    await create();
    await db.prepare('UPDATE transfers SET code=? WHERE id=?').bind('A1B2C3', id).run();
    await recordReport(db, id, 'send', { event: 'manifest', files: [file] });
    await db
      .prepare('UPDATE transfers SET started_at=? WHERE id=?')
      .bind(Date.now() - RETENTION_MS - 1000, id)
      .run();
    expect((await get()).body.items).toHaveLength(0);
    expect((await get('/api/transfers?q=A1B2C3')).body.items).toHaveLength(0);
    expect((await get('/api/transfers/' + id)).status).toBe(404);
    await pruneActivity(db);
    expect(
      await db
        .prepare('SELECT COUNT(*) AS count FROM transfers WHERE code=?')
        .bind('A1B2C3')
        .first('count'),
    ).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM files').first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM connections').first('count')).toBe(0);
  });
  it('paginates without duplicates and rejects malformed filters', async () => {
    const now = Date.now();
    await db.batch(
      Array.from({ length: 55 }, (_, n) =>
        db
          .prepare('INSERT INTO transfers (id,started_at,updated_at,expires_at) VALUES (?,?,?,?)')
          .bind(n.toString(16).padStart(64, '0'), now, now, now + 86_400_000),
      ),
    );
    const first = (await get()).body;
    expect(first.items).toHaveLength(50);
    const second = (await get('/api/transfers?' + new URLSearchParams(first.next))).body;
    expect(second.items).toHaveLength(5);
    expect(new Set([...first.items, ...second.items].map((t: any) => t.id)).size).toBe(55);
    for (const query of ['before=x', 'from=garbage', 'status=anything'])
      expect((await get('/api/transfers?' + query)).status).toBe(400);
  });
  it('lists each receiver of a shared code with its slot', async () => {
    await recordConnection(
      db,
      id,
      crypto.randomUUID(),
      'send',
      '192.0.2.1',
      'CA',
      Date.now() + 86_400_000,
      'A1B2C3',
      1,
      3,
    );
    const { body } = await get();
    expect(body.items[0]).toMatchObject({ id, code: 'A1B2C3', slot: 1, uses: 3 });
    expect((await get(`/api/transfers/${id}`)).body.transfer).toMatchObject({ slot: 1, uses: 3 });
  });
  it('keeps waiting for a receiver through the twenty-minute code window', async () => {
    const waiting = 'c'.repeat(64),
      lapsed = 'd'.repeat(64);
    for (const [transfer, minutes] of [
      [waiting, 19],
      [lapsed, 21],
    ] as const) {
      const started = Date.now() - minutes * 60_000;
      await db
        .prepare('INSERT INTO transfers(id,started_at,updated_at,expires_at) VALUES (?,?,?,?)')
        .bind(transfer, started, started, started + 86_400_000)
        .run();
    }
    expect((await get(`/api/transfers/${waiting}`)).body.transfer.status).toBe('waiting');
    expect((await get(`/api/transfers/${lapsed}`)).body.transfer.status).toBe('expired');
  });
  it('validates report bounds and strips arbitrary extra data', async () => {
    const message = {
      type: 'audit',
      id: crypto.randomUUID(),
      report: { event: 'file', file, md5, sha256, secret: 'never store' },
    };
    expect(validateAudit(message).report).not.toHaveProperty('secret');
    expect(() =>
      validateAudit({ ...message, report: { ...message.report, md5: 'invalid' } }),
    ).toThrow();
    expect(() =>
      validateAudit({ ...message, report: { ...message.report, file: { ...file, id: 100 } } }),
    ).toThrow();
    expect(await activityId('credential-one')).not.toBe(await activityId('credential-two'));
  });
});
