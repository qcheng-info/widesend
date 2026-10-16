import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DEFAULT_LIMITS, LEASE_MS, readLimits } from '../../worker/abuse-store';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DAY, HOUR } from '../../shared/health';

let mf: Miniflare;
let config: Parameters<typeof convertV4MiniflareOptions>[0];
let directory: string;
const now = 1_000_000;
// The stricter limits a site open to everyone sets; these tests count against them.
const PUBLIC_LIMITS = {
  attemptsPerMinute: 20,
  attemptsPerHour: 250,
  createsPerHour: 20,
  createsPerDay: 100,
  createsGlobalPerDay: 500,
  concurrentPerNetwork: 5,
  concurrentGlobal: 25,
  roomsPerNetwork: 3,
  roomsGlobal: 25,
};
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ['tests/fixtures/protection-worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    external: ['cloudflare:workers'],
  });
  directory = await mkdtemp(`${tmpdir()}/widesend-protection-`);
  config = {
    name: 'protection-test',
    resourcePersistencePath: directory,
    modules: true,
    compatibilityDate: '2026-09-01',
    script: bundle.outputFiles[0].text,
    scriptPath: resolve('tests/fixtures/protection-bundle.js'),
    durableObjects: { STORE: { className: 'StoreFixture', useSQLite: true } },
    bindings: { ABUSE_LIMITS: PUBLIC_LIMITS },
  };
  mf = new Miniflare(convertV4MiniflareOptions(config));
});
afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function call(id: string, action: string, input: object = {}, time = now): Promise<any> {
  return (
    await mf.dispatchFetch(`https://test/${id}`, {
      method: 'POST',
      body: JSON.stringify({ action, now: time, ...input }),
    })
  ).json();
}
const participant = (room = 'room', role = 'send', credential = 'owner') => ({
  room,
  role,
  credential,
});
const reservation = (room = 'room', network = 'network', connection = 'conn') => ({
  ...participant(room),
  owner: 'owner',
  network,
  connection,
  expires: now + 86_400_000,
  newSession: true,
});
describe('persisted admission budgets', () => {
  it('keeps relay usage idempotent, applies the UTC admission threshold, and preserves admitted sessions', async () => {
    const time = Date.UTC(2026, 8, 11, 23),
      day = Math.floor(time / DAY) * DAY;
    const budget = { dailyRequestUnits: 100, stopNewAtPercent: 80 };
    const oldId = 'a'.repeat(64),
      newId = 'b'.repeat(64);
    const admit = (id: string, t = time) =>
      call('relay-budget', 'relay-admit', { budget, id, expires: time + DAY }, t);
    expect(await admit(oldId)).toEqual({ allowed: true });
    await call(
      'relay-budget',
      'relay-record',
      { connection: 'conn', snapshots: [{ day, messages: 1600, bytes: 4096 }] },
      time,
    );
    await Promise.all(
      [1200, 1600, 1000].map((messages) =>
        call(
          'relay-budget',
          'relay-record',
          { connection: 'conn', snapshots: [{ day, messages, bytes: 1024 }] },
          time,
        ),
      ),
    );
    let health = await call('relay-budget', 'relay-health', { budget }, time);
    expect(health.daily[6]).toMatchObject({ messages: 1600, bytes: 4096, admitted: 1, denied: 0 });
    expect(health.acceptingNew).toBe(false);
    expect(await admit(newId)).toEqual({ allowed: false, retryAfter: 3600 });
    expect(await admit(newId)).toEqual({ allowed: false, retryAfter: 3600 });
    expect(await admit(oldId)).toEqual({ allowed: true });
    health = await call('relay-budget', 'relay-health', { budget }, time);
    expect(health.daily[6]).toMatchObject({ admitted: 1, denied: 1 });
    // Crossing UTC midnight doesn't extend the existing session's expiry or
    // count it as another admission. New sessions can start again.
    expect(await admit(oldId, day + DAY)).toEqual({ allowed: true });
    expect(await admit(newId, day + DAY)).toEqual({ allowed: true });
    await call(
      'relay-budget',
      'relay-record',
      {
        connection: 'conn',
        snapshots: [
          { day, messages: 1700, bytes: 8192 },
          { day: day + DAY, messages: 10, bytes: 100 },
        ],
      },
      day + DAY,
    );
    health = await call('relay-budget', 'relay-health', { budget }, day + DAY);
    expect(health.daily[5]).toMatchObject({ messages: 1700, bytes: 8192 });
    expect(health.daily[6]).toMatchObject({ messages: 10, bytes: 100, admitted: 1 });
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(config));
    expect(
      (await call('relay-budget', 'relay-health', { budget }, day + DAY)).daily[6].messages,
    ).toBe(10);
    expect(await admit(oldId, day + DAY)).toEqual({ allowed: true });
    await call('relay-budget', 'relay-prune', {}, time + 92 * DAY);
    expect(
      (await call('relay-budget', 'relay-health', {}, time + 92 * DAY)).daily.every(
        (d: any) => d.messages === 0,
      ),
    ).toBe(true);
  });
  it('retains bounded health counters and reports reservations without exposing identities', async () => {
    const time = Date.UTC(2026, 8, 11, 12);
    const hour = Math.floor(time / HOUR) * HOUR;
    await call(
      'health',
      'reserve',
      { reservation: { ...reservation(), expires: time + DAY } },
      time,
    );
    await call(
      'health',
      'reserve',
      {
        reservation: {
          ...reservation(),
          role: 'receive',
          credential: 'receiver',
          expires: time + DAY,
          newSession: false,
        },
      },
      time,
    );
    await call(
      'health',
      'health-write',
      { batch: [{ hour, burst: 500, codes: 10, transfers: 1 }] },
      time,
    );
    await call(
      'health',
      'health-write',
      { batch: [{ hour, burst: 4, codes: 2, transfers: 3 }] },
      time,
    );
    let health = await call('health', 'health', {}, time);
    expect(health).toMatchObject({
      recordingSince: time,
      reservedTransfers: 1,
      reservedConnections: 2,
      transferLimit: 25,
      blocks: [{ hour, burst: 504, codes: 12, transfers: 4 }],
    });
    expect(JSON.stringify(health)).not.toContain('credential');
    expect(JSON.stringify(health)).not.toContain('owner');
    await call('health', 'health-prune', {}, time + 91 * DAY);
    health = await call('health', 'health', {}, time + 91 * DAY);
    expect(health.reservedTransfers).toBe(0);
    expect(health.blocks).toEqual([]);
  });
  it('caps attempts atomically, resets windows, and isolates networks', async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        call('attempts', 'attempt', { network: 'one', participant: participant() }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.find((r) => !r.allowed).retryAfter).toBe(60);
    expect(
      await call('attempts', 'attempt', { network: 'two', participant: participant() }),
    ).toEqual({ allowed: true });
    expect(
      await call(
        'attempts',
        'attempt',
        { network: 'one', participant: participant() },
        now + 60_000,
      ),
    ).toEqual({ allowed: true });
    for (let minute = 1; minute <= 13; minute++)
      for (let n = 0; n < 20; n++)
        await call(
          'attempts',
          'attempt',
          { network: 'one', participant: participant() },
          now + minute * 60_000,
        );
    expect(
      await call(
        'attempts',
        'attempt',
        { network: 'one', participant: participant() },
        now + 14 * 60_000,
      ),
    ).toEqual({ allowed: false, retryAfter: 2760 });
    expect(
      await call(
        'attempts',
        'attempt',
        { network: 'one', participant: participant() },
        now + 3_600_000,
      ),
    ).toEqual({ allowed: true });
  });
  it('exempts only admitted credentials from repeated code-attempt checks', async () => {
    await call('credentials', 'reserve', { reservation: reservation() });
    for (let i = 0; i < 20; i++)
      await call('credentials', 'attempt', { network: 'one', participant: participant('missing') });
    expect(
      await call('credentials', 'attempt', { network: 'one', participant: participant() }),
    ).toEqual({ allowed: true });
    for (const p of [participant('room', 'send', 'forged'), participant('different')])
      expect(
        (await call('credentials', 'attempt', { network: 'one', participant: p })).allowed,
      ).toBe(false);
  });
  it('lets a credential admitted to a receiver slot reconnect without spending attempts', async () => {
    await call('slots', 'reserve', {
      reservation: { ...reservation(), role: 'receive:2', credential: 'slot-two' },
    });
    // A receiver learns its slot only after admission, so it reconnects as plain 'receive'.
    for (let i = 0; i < PUBLIC_LIMITS.attemptsPerMinute + 5; i++)
      expect(
        (
          await call('slots', 'attempt', {
            network: 'one',
            participant: participant('room', 'receive', 'slot-two'),
          })
        ).allowed,
      ).toBe(true);
    const unknown = [];
    for (let i = 0; i <= PUBLIC_LIMITS.attemptsPerMinute; i++)
      unknown.push(
        (
          await call('slots', 'attempt', {
            network: 'one',
            participant: participant('room', 'receive', `stranger-${i}`),
          })
        ).allowed,
      );
    expect(unknown.slice(0, -1).every(Boolean)).toBe(true);
    expect(unknown.at(-1)).toBe(false);
  });
  it('counts distinct active rooms, admits a peer at capacity, and rejects a sixth room', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        call('concurrent', 'reserve', { reservation: reservation(`room${n}`) }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const active = (await call('concurrent', 'inspect')).sessions[0].room;
    expect(
      await call('concurrent', 'reserve', {
        reservation: {
          ...reservation(active),
          role: 'receive',
          credential: 'receiver',
          newSession: false,
        },
      }),
    ).toEqual({ allowed: true });
    expect(
      (await call('concurrent', 'reserve', { reservation: reservation('extra') })).allowed,
    ).toBe(false);
    // Replacing a connection doesn't add a sixth transfer or let a stale close release it.
    expect(
      (
        await call('concurrent', 'reserve', {
          reservation: reservation(active, 'network', 'replacement'),
        })
      ).allowed,
    ).toBe(true);
    await call('concurrent', 'release', { room: active, role: 'send', connection: 'conn' });
    expect(
      (await call('concurrent', 'inspect')).leases.find(
        (l: any) => l.role === 'send' && l.room === active,
      ).connection,
    ).toBe('replacement');
    await call('concurrent', 'release', { room: active, role: 'send', connection: 'replacement' });
    expect(
      (await call('concurrent', 'reserve', { reservation: reservation('extra') })).allowed,
    ).toBe(false);
    await call('concurrent', 'release', { room: active, role: 'receive', connection: 'conn' });
    expect(
      (await call('concurrent', 'reserve', { reservation: reservation('extra') })).allowed,
    ).toBe(true);
  });
  it('enforces the site-wide capacity across different networks', async () => {
    for (let n = 0; n < 25; n++)
      expect(
        (await call('global', 'reserve', { reservation: reservation(`room${n}`, `network${n}`) }))
          .allowed,
      ).toBe(true);
    expect(await call('global', 'reserve', { reservation: reservation('extra', 'extra') })).toEqual(
      { allowed: false, retryAfter: 30 },
    );
    expect(
      (
        await call('global', 'reserve', {
          reservation: {
            ...reservation('room0', 'new-network'),
            role: 'receive',
            credential: 'receiver',
            newSession: false,
          },
        })
      ).allowed,
    ).toBe(true);
  });
  it('enforces hourly, daily, and global creation budgets without charging a reconnect', async () => {
    for (let n = 0; n < 20; n++) {
      expect(
        (await call('create', 'reserve', { reservation: reservation(`room${n}`) })).allowed,
      ).toBe(true);
      await call('create', 'release', { room: `room${n}`, role: 'send', connection: 'conn' });
    }
    expect(await call('create', 'reserve', { reservation: reservation('blocked') })).toEqual({
      allowed: false,
      retryAfter: 3600,
    });
    expect(
      (
        await call('create', 'reserve', {
          reservation: { ...reservation('room0'), newSession: false },
        })
      ).allowed,
    ).toBe(true);
    for (let hour = 1; hour < 5; hour++)
      for (let n = 0; n < 20; n++) {
        const r = reservation(`room-${hour}-${n}`);
        expect(
          (await call('create', 'reserve', { reservation: r }, now + hour * 3_600_000)).allowed,
        ).toBe(true);
        await call('create', 'release', { room: r.room, role: r.role, connection: r.connection });
      }
    expect(
      await call(
        'create',
        'reserve',
        { reservation: reservation('day-blocked') },
        now + 5 * 3_600_000,
      ),
    ).toEqual({ allowed: false, retryAfter: 68_400 });
    for (let n = 0; n < 500; n++) {
      const r = reservation(`room${n}`, `network${n}`);
      expect((await call('global-create', 'reserve', { reservation: r })).allowed).toBe(true);
      await call('global-create', 'release', {
        room: r.room,
        role: r.role,
        connection: r.connection,
      });
    }
    expect(
      await call('global-create', 'reserve', { reservation: reservation('blocked', 'unused') }),
    ).toEqual({ allowed: false, retryAfter: 86_400 });
  });
  it('renews long transfers, expires abandoned leases, and keeps the original session deadline', async () => {
    await call('leases', 'reserve', { reservation: reservation() });
    await call(
      'leases',
      'reserve',
      { reservation: { ...reservation(), newSession: false, expires: now + 2 * 86_400_000 } },
      now + 600_000,
    );
    let state = await call('leases', 'inspect');
    expect(state.sessions[0].expires).toBe(now + 86_400_000);
    expect(state.leases[0].expires).toBe(now + 600_000 + LEASE_MS);
    await call('leases', 'prune', {}, now + LEASE_MS + 1);
    expect((await call('leases', 'inspect')).leases).toHaveLength(1);
    await call('leases', 'prune', {}, now + LEASE_MS + 600_001);
    state = await call('leases', 'inspect');
    expect(state.leases).toHaveLength(0);
    expect(state.participants).toHaveLength(1);
    expect(
      (
        await call(
          'leases',
          'reserve',
          { reservation: { ...reservation(), newSession: false } },
          now + 4_000_000,
        )
      ).allowed,
    ).toBe(true);
    await call('leases', 'prune', {}, now + 86_400_001);
    state = await call('leases', 'inspect');
    expect(Object.values(state).every((rows: any) => rows.length === 0)).toBe(true);
  });
  it('moves a recovered participant to its current network without retaining a ghost slot', async () => {
    await call('move', 'reserve', { reservation: reservation() });
    expect(
      (
        await call('move', 'reserve', {
          reservation: { ...reservation('room', 'new'), newSession: false },
        })
      ).allowed,
    ).toBe(true);
    expect((await call('move', 'inspect')).leases.map((l: any) => l.network)).toEqual(['new']);
    expect(
      (await call('move', 'reserve', { reservation: { ...reservation(), credential: 'attacker' } }))
        .allowed,
    ).toBe(false);
  });
  it('normalizes authoritative IPv4 and IPv6 networks, including mapped IPv4', async () => {
    for (const [ip, expected] of [
      ['192.0.2.9', '192.0.2.9'],
      ['2001:db8:1:2::3', '2001:db8:1:2::/64'],
      ['2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
      ['::ffff:192.0.2.9', '192.0.2.9'],
      ['garbage', 'unknown'],
    ])
      expect(await call('network', 'network', { ip }), ip).toBe(expected);
    expect(readLimits()).toEqual(DEFAULT_LIMITS);
    expect(() => readLimits({ concurrentGlobal: 0 })).toThrow();
    expect(() => readLimits({ concurrentGlobal: 2.5 })).toThrow();
  });
  it('limits admin sign-in attempts per network, so nobody can lock others out', async () => {
    const login = (network: string, time = now) =>
      call('admin-login', 'admin-login', { network }, time);
    for (let i = 0; i < 10; i++) expect(await login('one')).toEqual({ allowed: true });
    const refused = await login('one');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(await login('two')).toEqual({ allowed: true });
    expect(await login('one', now + 15 * 60_000 + 1)).toEqual({ allowed: true });
    // Many networks guessing together never stop someone else from signing in.
    for (let i = 0; i < 300; i++) await login(`many-${i}`, now + DAY / 2);
    expect(await login('owner', now + DAY / 2)).toEqual({ allowed: true });
    // One network gets 100 attempts a day, however it spaces them.
    let allowed = 0;
    for (let i = 0; i < 120; i++)
      if ((await login('patient', now + 2 * DAY + Math.floor(i / 10) * (15 * 60_000 + 1))).allowed)
        allowed++;
    expect(allowed).toBe(100);
  });
  it('defaults suit a team behind one address', () => {
    expect(DEFAULT_LIMITS).toEqual({
      attemptsPerMinute: 60,
      attemptsPerHour: 1000,
      createsPerHour: 200,
      createsPerDay: 1000,
      createsGlobalPerDay: 2000,
      concurrentPerNetwork: 20,
      concurrentGlobal: 50,
      roomsPerNetwork: 10,
      roomsGlobal: 50,
    });
  });
  it('keeps exhausted counters and admitted credentials through a runtime restart', async () => {
    await call('persist', 'reserve', { reservation: reservation() });
    for (let n = 0; n < 20; n++)
      await call('persist', 'attempt', { network: 'one', participant: participant('missing') });
    await call('persist', 'health-write', {
      batch: [{ hour: Math.floor(now / HOUR) * HOUR, burst: 3, codes: 2, transfers: 1 }],
    });
    await mf.dispose();
    mf = new Miniflare(convertV4MiniflareOptions(config));
    expect(
      await call('persist', 'attempt', { network: 'one', participant: participant('missing') }),
    ).toEqual({ allowed: false, retryAfter: 60 });
    expect(
      await call('persist', 'attempt', { network: 'one', participant: participant() }),
    ).toEqual({ allowed: true });
    expect((await call('persist', 'inspect')).leases).toHaveLength(1);
    expect((await call('persist', 'health')).blocks).toEqual([
      { hour: Math.floor(now / HOUR) * HOUR, burst: 3, codes: 2, transfers: 1 },
    ]);
  });
});
