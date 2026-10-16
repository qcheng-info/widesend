import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { token, pairingCode, roomId } from '../../src/crypto';
import { adminAPI } from '../../admin/api';
import { CLOSE, ROOM_PROTOCOL, encodeHello } from '../../shared/room';
import { CLIENT_CLOSE, browserClose } from '../../shared/diagnostics';
import { errorText, recordRefusal } from '../../worker/diagnostics';
import { pruneActivity } from '../../worker/activity';
import { RETENTION_MS } from '../../shared/audit';
import {
  ORIGIN,
  joinHello,
  openRoom,
  ownerSetup,
  shareRuntime,
  type OwnerSetup,
  type TestSocket,
} from '../fixtures/share-runtime';

const runtimes: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((mf) => mf.dispose()));
});
async function runtime(options: Parameters<typeof shareRuntime>[0] = {}) {
  const result = await shareRuntime(options);
  runtimes.push(result.mf);
  return result;
}
const key = '04' + 'ab'.repeat(64);
const cert = 'cd'.repeat(64);
async function admitted(
  mf: Miniflare,
  owner: OwnerSetup,
  ownerSocket: TestSocket,
  name: string,
  ip: string,
) {
  const hello = joinHello(owner.code, name);
  const socket = await openRoom(mf, owner.locator, hello, ip);
  await ownerSocket.next('join-request', (m) => m.id === hello.member);
  ownerSocket.send({ type: 'admit', id: hello.member, key, cert });
  await socket.next('admitted');
  return { id: hello.member, socket };
}
const admin = async (db: D1Database, path: string) =>
  (await (
    await adminAPI(new URL(`https://admin.example${path}`), db, 'owner@example.com')
  ).json()) as any;
type Row = Record<string, unknown>;
const rows = async (db: D1Database, sql: string, ...args: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...args)
      .all<Row>()
  ).results;

// One-to-one transfer sockets, as in admission.test.ts.
async function invitation() {
  const code = pairingCode();
  return {
    room: await roomId(code),
    hello: {
      code,
      role: 'send',
      credential: token(32),
      expires: Date.now() + 86_399_000,
      pairExpires: Date.now() + 599_000,
    },
  };
}
async function transfer(
  mf: Miniflare,
  invite: Awaited<ReturnType<typeof invitation>>,
  hello: Record<string, unknown>,
  ip: string,
) {
  const auth = Buffer.from(JSON.stringify(hello)).toString('base64url');
  const response = await mf.dispatchFetch(`${ORIGIN}/api/rooms/${invite.room}`, {
    headers: {
      Origin: ORIGIN,
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `widesend, ${auth}`,
      'CF-Connecting-IP': ip,
    },
  });
  const socket = response.webSocket;
  const messages: any[] = [];
  socket?.addEventListener('message', (event) => {
    if (typeof event.data === 'string') messages.push(JSON.parse(event.data));
  });
  socket?.accept();
  return {
    response,
    socket: socket!,
    async notice(type: string) {
      await expect.poll(() => messages.find((m) => m.type === type)).toBeDefined();
    },
  };
}

describe('close classification', () => {
  it('tells a lost connection from a page that closed and a browser that said why', () => {
    expect(browserClose(1006, '')).toEqual({ by: 'lost', code: 1006, reason: 'Connection lost' });
    expect(browserClose(1011, '')).toEqual({ by: 'lost', code: 1011, reason: 'Connection lost' });
    // A close frame with no code is still the page closing on purpose.
    expect(browserClose(1005, '')).toEqual({
      by: 'browser',
      code: 1005,
      reason: 'Closed without a code',
    });
    expect(browserClose(1001, '')).toEqual({
      by: 'browser',
      code: 1001,
      reason: 'Page closed or went to the background',
    });
    expect(browserClose(CLIENT_CLOSE.reconnect, 'no reply for 45 s')).toEqual({
      by: 'browser',
      code: 4101,
      reason: 'no reply for 45 s',
    });
    // Browsers choose the text: keep it short and printable.
    expect(browserClose(1000, `bad\u0000${'x'.repeat(300)}`).reason).toMatch(/^bad x{96}$/);
  });
});

describe('error log lines', () => {
  it('never quote message content from a parse error', () => {
    let parseError: unknown;
    try {
      JSON.parse('{"type":"audit","name":"secret plan.pdf"');
    } catch (error) {
      parseError = error;
    }
    expect(errorText(parseError)).toBe('Not valid JSON');
    expect(errorText(new Error('Not allowed'))).toBe('Not allowed');
  });
});

describe('refused attempts', { timeout: 30_000 }, () => {
  it('caps records per network address and per day', async () => {
    const { db } = await runtime();
    const refusal = (ip: string) => ({
      kind: 'room' as const,
      target: 'f'.repeat(64),
      role: 'join',
      ip,
      country: 'CA',
      code: CLOSE.notFound,
      reason: 'Room not found',
    });
    const caps = { perDay: 3, perIp: 2 };
    const written = [];
    for (const ip of ['192.0.2.1', '192.0.2.1', '192.0.2.1', '192.0.2.2', '192.0.2.3'])
      written.push(await recordRefusal(db, refusal(ip), caps));
    expect(written).toEqual([true, true, false, true, false]);
    expect(await rows(db, 'SELECT ip FROM refusals ORDER BY ip')).toEqual([
      { ip: '192.0.2.1' },
      { ip: '192.0.2.1' },
      { ip: '192.0.2.2' },
    ]);
  });

  it('deletes refusals with the rest of the activity after 90 days', async () => {
    const { db } = await runtime();
    const insert = (id: string, at: number) =>
      db
        .prepare(
          "INSERT INTO refusals (id,at,kind,ip,country,code,reason) VALUES (?,?,'room','192.0.2.1','CA',4014,'Room not found')",
        )
        .bind(id, at)
        .run();
    await insert('old', Date.now() - RETENTION_MS - 60_000);
    await insert('recent', Date.now() - 60_000);
    await pruneActivity(db);
    expect(await rows(db, 'SELECT id FROM refusals')).toEqual([{ id: 'recent' }]);
  });

  it('records refused room joins, linked to the room when it exists', async () => {
    const { mf, db } = await runtime();
    const owner = await ownerSetup({ join: 'auto', size: 2, send: 'everyone' });
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    await admitted(mf, owner, ownerSocket, 'Alice', '192.0.2.10');
    const late = await openRoom(mf, owner.locator, joinHello(owner.code, 'Late'), '192.0.2.20');
    expect(await late.closed()).toBe(CLOSE.full);
    const elsewhere = await ownerSetup();
    const lost = await openRoom(mf, elsewhere.locator, joinHello(elsewhere.code), '192.0.2.21');
    expect(await lost.closed()).toBe(CLOSE.notFound);
    const mismatch = await mf.dispatchFetch(`${ORIGIN}/api/share/${owner.locator}`, {
      headers: {
        Origin: ORIGIN,
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `${ROOM_PROTOCOL}, ${encodeHello(joinHello(elsewhere.code))}`,
        'CF-Connecting-IP': '192.0.2.22',
      },
    });
    expect(mismatch.status).toBe(400);

    const [room] = await rows(db, 'SELECT id, locator FROM share_rooms WHERE code=?', owner.code);
    expect(room.locator).toBe(owner.locator);
    const select = 'SELECT kind, room_id, target, role, ip, code, reason FROM refusals ORDER BY ip';
    await expect.poll(() => rows(db, select)).toHaveLength(3);
    expect(await rows(db, select)).toEqual([
      {
        kind: 'room',
        room_id: room.id,
        target: owner.locator,
        role: 'join',
        ip: '192.0.2.20',
        code: CLOSE.full,
        reason: 'Room full',
      },
      {
        kind: 'room',
        room_id: null,
        target: elsewhere.locator,
        role: 'join',
        ip: '192.0.2.21',
        code: CLOSE.notFound,
        reason: 'Room not found',
      },
      {
        kind: 'room',
        room_id: null,
        target: owner.locator,
        role: null,
        ip: '192.0.2.22',
        code: 400,
        reason: 'Invalid handshake',
      },
    ]);
    // The admin shows a room's refusals, including those turned away before reaching it.
    const detail = await admin(db, `/api/rooms/${room.id}`);
    expect(detail.refusals.map((r: Row) => r.reason).sort()).toEqual([
      'Invalid handshake',
      'Room full',
    ]);
  });

  it('records attempts refused by the rate limit', async () => {
    const { mf, db } = await runtime({ limits: { attemptsPerMinute: 1 } });
    const owner = await ownerSetup();
    await openRoom(mf, owner.locator, owner.hello, '192.0.2.40');
    const second = await openRoom(mf, owner.locator, joinHello(owner.code), '192.0.2.40');
    expect(await second.closed()).toBe(CLOSE.limited);
    await expect
      .poll(() => rows(db, 'SELECT target, code, reason FROM refusals'))
      .toEqual([{ target: owner.locator, code: CLOSE.limited, reason: 'Please wait' }]);
  });
});

describe('why connections closed', { timeout: 30_000 }, () => {
  it('records who closed each room connection and why', async () => {
    const { mf, db } = await runtime();
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    const alice = await admitted(mf, owner, ownerSocket, 'Alice', '192.0.2.10');
    const bob = await admitted(mf, owner, ownerSocket, 'Bob', '192.0.2.11');
    const carol = await admitted(mf, owner, ownerSocket, 'Carol', '192.0.2.12');
    ownerSocket.send({ type: 'remove', id: alice.id });
    await alice.socket.closed();
    bob.socket.socket.close(CLIENT_CLOSE.reconnect, 'no reply for 45 s');
    carol.socket.socket.close(1001);
    const closes = () =>
      rows(
        db,
        'SELECT ip, closed_by, close_code, close_reason FROM share_connections WHERE ip<>? ORDER BY ip',
        '192.0.2.1',
      );
    await expect.poll(closes).toEqual([
      { ip: '192.0.2.10', closed_by: 'server', close_code: CLOSE.removed, close_reason: 'Removed' },
      {
        ip: '192.0.2.11',
        closed_by: 'browser',
        close_code: CLIENT_CLOSE.reconnect,
        close_reason: 'no reply for 45 s',
      },
      {
        ip: '192.0.2.12',
        closed_by: 'browser',
        close_code: 1001,
        close_reason: 'Page closed or went to the background',
      },
    ]);
    const [room] = await rows(db, 'SELECT id FROM share_rooms WHERE code=?', owner.code);
    const detail = await admin(db, `/api/rooms/${room.id}`);
    expect(detail.connections.find((c: Row) => c.ip === '192.0.2.10')).toMatchObject({
      closed_by: 'server',
      close_code: CLOSE.removed,
      close_reason: 'Removed',
    });
  });

  it('records who closed a transfer connection, and refused transfer attempts', async () => {
    const { mf, db } = await runtime();
    const invite = await invitation();
    const early = await transfer(
      mf,
      invite,
      { ...invite.hello, role: 'receive', credential: token(32) },
      '192.0.2.30',
    );
    expect(early.response.status).toBe(404);
    const first = await transfer(mf, invite, invite.hello, '192.0.2.31');
    await first.notice('connected');
    const second = await transfer(mf, invite, invite.hello, '192.0.2.32');
    await second.notice('connected');
    second.socket.close(CLIENT_CLOSE.done, 'Transfer cancelled.');
    const closes = () =>
      rows(db, 'SELECT ip, closed_by, close_code, close_reason FROM connections ORDER BY ip');
    await expect.poll(closes).toEqual([
      {
        ip: '192.0.2.31',
        closed_by: 'server',
        close_code: 4000,
        close_reason: 'Connection replaced',
      },
      {
        ip: '192.0.2.32',
        closed_by: 'browser',
        close_code: CLIENT_CLOSE.done,
        close_reason: 'Transfer cancelled.',
      },
    ]);
    await expect
      .poll(() => rows(db, 'SELECT kind, room_id, target, role, ip, code, reason FROM refusals'))
      .toEqual([
        {
          kind: 'transfer',
          room_id: null,
          target: invite.room,
          role: 'receive',
          ip: '192.0.2.30',
          code: 404,
          reason: 'Sender is offline',
        },
      ]);
    const [record] = await rows(db, 'SELECT id FROM transfers');
    const detail = await admin(db, `/api/transfers/${record.id}`);
    expect(detail.connections.map((c: Row) => c.close_reason).sort()).toEqual([
      'Connection replaced',
      'Transfer cancelled.',
    ]);
    expect(detail.refusals).toEqual([]);
  });
});
