import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { activityHealth, healthOverview } from '../../admin/health';
import { DAY, HOUR, type ProtectionHealth } from '../../shared/health';
import { BlockBuffer } from '../../worker/block-buffer';
import { PAIRING_MS } from '../../shared/protocol';
const now = Date.UTC(2026, 8, 11, 12),
  today = Date.UTC(2026, 8, 11);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("test")}}',
    d1Databases: ['ACTIVITY'],
  }),
);
let db: D1Database;
beforeAll(async () => {
  db = (await mf.getD1Database('ACTIVITY')) as unknown as D1Database;
  for (const migration of [
    '0001_activity.sql',
    '0002_transfer_code.sql',
    '0003_health_indexes.sql',
    '0004_cleanup_health.sql',
  ]) {
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
});
afterAll(async () => {
  vi.useRealTimers();
  await mf.dispose();
});
async function transfer(
  id: string,
  status = 'waiting',
  started = now - 60000,
  route = 'connecting',
) {
  await db
    .prepare(
      'INSERT INTO transfers (id,started_at,updated_at,expires_at,sender_status,receiver_status,sender_route,receiver_route) VALUES (?,?,?,?,?,?,?,?)',
    )
    .bind(
      id,
      started,
      started,
      status === 'interrupted' ? now - 1 : now + DAY,
      status === 'interrupted' ? 'transferring' : status,
      status === 'complete' ? 'complete' : 'waiting',
      route,
      'connecting',
    )
    .run();
}
async function connection(id: string, transfer: string, role: string, at: number) {
  await db
    .prepare('INSERT INTO connections (id,transfer_id,role,ip,connected_at) VALUES (?,?,?,?,?)')
    .bind(id, transfer, role, '192.0.2.1', at)
    .run();
}
describe('admin health aggregation', () => {
  it('counts transfer outcomes once, keeps unknown routes, and prioritizes relay use', async () => {
    for (const status of [
      'complete',
      'error',
      'cancelled',
      'waiting',
      'transferring',
      'interrupted',
    ]) {
      await transfer(status, status, now - 60000, status === 'complete' ? 'direct' : 'connecting');
      await connection(`${status}-send`, status, 'send', now - 60000);
      if (status === 'interrupted')
        await connection('interrupted-receive', status, 'receive', now - 50000);
    }
    await transfer('expired', 'waiting', now - PAIRING_MS - 100_000);
    await transfer('older', 'complete', today - 4 * DAY, 'direct');
    await db.prepare("UPDATE transfers SET receiver_route='relay' WHERE id='older'").run();
    for (const role of ['send', 'receive'])
      for (let id = 0; id < 3; id++)
        await db
          .prepare(
            'INSERT INTO files (transfer_id,file_id,role,name,size,mime_type,reported_at) VALUES (?,?,?,?,?,?,?)',
          )
          .bind('complete', id, role, 'file.txt', 100, 'text/plain', now)
          .run();
    const result = await activityHealth(db, now);
    expect(result.today.total).toBe(7);
    expect(result.today.outcomes).toEqual({
      waiting: 1,
      transferring: 1,
      complete: 1,
      error: 1,
      cancelled: 1,
      interrupted: 1,
      expired: 1,
    });
    expect(result.today.routes).toEqual({ direct: 1, relay: 0, unknown: 6 });
    expect(result.last7Days.total).toBe(8);
    expect(result.last7Days.routes).toEqual({ direct: 1, relay: 1, unknown: 6 });
    expect(result.daily).toHaveLength(7);
  });
  it('uses UTC calendar boundaries and excludes future and older transfers', async () => {
    for (const [id, at] of [
      ['first', today - 6 * DAY],
      ['too-old', today - 6 * DAY - 1],
      ['yesterday', today - 1],
      ['midnight', today],
      ['now', now],
      ['future', now + 1],
    ] as const)
      await transfer(id, 'complete', at);
    const result = await activityHealth(db, now);
    expect(result.today.total).toBe(2);
    expect(result.today.from).toBe(today);
    expect(result.last7Days.total).toBe(4);
    expect(result.last7Days.from).toBe(today - 6 * DAY);
  });
  it('counts reconnections by participant across period boundaries and timestamp ties', async () => {
    await transfer('before-window', 'complete', today - 8 * DAY);
    await connection('first-send', 'before-window', 'send', today - 7 * DAY);
    await connection('new-receiver', 'before-window', 'receive', now - 50000);
    await connection('a', 'before-window', 'send', now - 1000);
    await connection('b', 'before-window', 'send', now - 1000);
    await transfer('outside-retention', 'complete', now - 91 * DAY);
    await connection('old-a', 'outside-retention', 'send', now - 2000);
    await connection('old-b', 'outside-retention', 'send', now - 1000);
    expect((await activityHealth(db, now)).today.reconnections).toBe(2);
  });
  it('does not treat a sender-only completion report as receiver-confirmed', async () => {
    await transfer('sender-only', 'complete');
    await db.prepare("UPDATE transfers SET receiver_status='waiting' WHERE id='sender-only'").run();
    const result = await activityHealth(db, now);
    expect(result.today.outcomes.complete).toBe(0);
    expect(result.today.outcomes.transferring).toBe(1);
  });
  it('returns real zeroes for empty history and explicit nulls for unavailable sources', async () => {
    expect((await activityHealth(db, now)).last7Days.total).toBe(0);
    const unavailable = {
      batch: () => Promise.reject(new Error('Unavailable')),
    } as unknown as D1Database;
    const protection = {
      observedAt: now,
      recordingSince: now,
      reservedTransfers: 0,
      reservedConnections: 0,
      transferLimit: 25,
      networkLimit: 5,
      blocks: [],
    } satisfies ProtectionHealth;
    const partial = await healthOverview(unavailable, async () => protection, now);
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({ activity: null, protection });
    expect(await (await healthOverview(db, undefined, now)).json()).toMatchObject({
      protection: null,
    });
    expect(
      (
        await healthOverview(
          db,
          () => {
            throw new Error('Missing binding');
          },
          now,
        )
      ).status,
    ).toBe(200);
    expect((await healthOverview(unavailable, undefined, now)).status).toBe(503);
  });
});
describe('bounded block telemetry', () => {
  it('coalesces a burst, preserves UTC buckets, and does not lose arrivals during a flush', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const write = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(undefined);
      const buffer = new BlockBuffer(write);
      for (let n = 0; n < 1000; n++) void buffer.add('burst', today - 1);
      void buffer.add('codes', today);
      await vi.advanceTimersByTimeAsync(9999);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledWith([
        { hour: today - HOUR, burst: 1000, codes: 0, transfers: 0 },
        { hour: today, burst: 0, codes: 1, transfers: 0 },
      ]);
      const later = buffer.add('transfers', today);
      release();
      await vi.advanceTimersByTimeAsync(10000);
      await later;
      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[1][0]).toEqual([{ hour: today, burst: 0, codes: 0, transfers: 1 }]);
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not fail admission when writing monitoring data fails', async () => {
    vi.useFakeTimers();
    try {
      const buffer = new BlockBuffer(async () => {
        throw new Error('Storage unavailable');
      });
      const task = buffer.add('burst', now);
      await vi.advanceTimersByTimeAsync(10000);
      await expect(task).resolves.toBeUndefined();
      expect(buffer.snapshot()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
