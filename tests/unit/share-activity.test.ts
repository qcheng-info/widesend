import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { pruneActivity } from '../../worker/activity';
import {
  recordMember,
  recordRoom,
  recordRoomConnection,
  recordRoomEnded,
  recordRoomReport,
} from '../../worker/share-activity';
import { adminAPI } from '../../admin/api';
import { RETENTION_MS } from '../../shared/audit';
import { CLOSE } from '../../shared/room';
import {
  joinHello,
  openRoom,
  ownerSetup,
  randomId,
  shareRuntime,
  type OwnerSetup,
  type TestSocket,
} from '../fixtures/share-runtime';

const runtimes: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((mf) => mf.dispose()));
});
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
function audit(socket: TestSocket, report: unknown) {
  const id = crypto.randomUUID();
  socket.send({ type: 'audit', id, report });
  return id;
}
const files = [
  { id: 0, name: 'notes.txt', size: 12, type: 'text/plain' },
  { id: 1, name: 'photo.jpg', size: 2048, type: 'image/jpeg' },
];
const md5 = ['1'.repeat(32), '2'.repeat(32)];
const sha256 = ['3'.repeat(64), '4'.repeat(64)];

describe('room activity', { timeout: 30_000 }, () => {
  it('records the room, members, connections, offers and deliveries', async () => {
    const { mf, db } = await shareRuntime();
    runtimes.push(mf);
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello, '198.51.100.1');
    const a = await admitted(mf, owner, ownerSocket, 'Alice', '198.51.100.2');
    const b = await admitted(mf, owner, ownerSocket, 'Bob', '198.51.100.3');
    const c = await admitted(mf, owner, ownerSocket, 'Carol', '198.51.100.4');
    const offer = randomId();
    const offered = audit(ownerSocket, {
      event: 'offer',
      offer,
      files,
      md5,
      sha256,
      recipients: [a.id, b.id],
    });
    await ownerSocket.next('audit-ack', (m) => m.id === offered);
    // Offers may only list current members; this one is ignored.
    const bogus = randomId();
    audit(ownerSocket, {
      event: 'offer',
      offer: bogus,
      files,
      md5,
      sha256,
      recipients: [randomId()],
    });
    const delivery = (status: string, route = 'direct', recipient = a.id) => ({
      event: 'delivery',
      offer,
      recipient,
      status,
      route,
    });
    for (const status of ['accepted', 'transferring', 'complete']) {
      const id = audit(a.socket, delivery(status));
      await a.socket.next('audit-ack', (m) => m.id === id);
    }
    // Duplicate logical reports are acknowledged without another write.
    const duplicate = audit(a.socket, delivery('complete'));
    await a.socket.next('audit-ack', (m) => m.id === duplicate);
    const declined = audit(b.socket, delivery('declined', 'connecting', b.id));
    await b.socket.next('audit-ack', (m) => m.id === declined);
    // Terminal results never revert; others can't report for a recipient; the
    // sender may only cancel or fail a delivery.
    audit(b.socket, delivery('complete', 'relay', b.id));
    audit(c.socket, delivery('failed', 'relay', a.id));
    const cancelled = audit(ownerSocket, delivery('cancelled', 'relay', a.id));
    await ownerSocket.next('audit-ack', (m) => m.id === cancelled);
    const late = audit(b.socket, delivery('accepted', 'relay', b.id));
    await b.socket.next('audit-ack', (m) => m.id === late);

    a.socket.send({ type: 'leave' });
    await a.socket.closed();
    ownerSocket.send({ type: 'remove', id: c.id });
    await c.socket.closed();
    ownerSocket.send({ type: 'dismiss' });
    expect(await ownerSocket.closed()).toBe(CLOSE.dismissed);

    const one = async (sql: string, ...args: unknown[]) =>
      db
        .prepare(sql)
        .bind(...args)
        .first<any>();
    const all = async (sql: string, ...args: unknown[]) =>
      (
        await db
          .prepare(sql)
          .bind(...args)
          .all<any>()
      ).results;
    await expect
      .poll(() => one('SELECT end_reason FROM share_rooms'))
      .toEqual({ end_reason: 'dismissed' });
    const room = await one('SELECT * FROM share_rooms');
    expect(room).toMatchObject({ code: owner.code, expires_at: owner.expires });
    expect(room.ended_at).toBeGreaterThan(0);
    const members = await all(
      'SELECT member_id,name,is_owner,left_reason FROM share_members ORDER BY joined_at',
    );
    expect(members).toEqual([
      { member_id: owner.member, name: 'Owner', is_owner: 1, left_reason: 'dismissed' },
      { member_id: a.id, name: 'Alice', is_owner: 0, left_reason: 'left' },
      { member_id: b.id, name: 'Bob', is_owner: 0, left_reason: 'dismissed' },
      { member_id: c.id, name: 'Carol', is_owner: 0, left_reason: 'removed' },
    ]);
    await expect
      .poll(() => one('SELECT COUNT(*) AS n FROM share_connections WHERE disconnected_at IS NULL'))
      .toEqual({ n: 0 });
    const ips = await all('SELECT member_id,ip FROM share_connections ORDER BY connected_at');
    expect(ips).toContainEqual({ member_id: a.id, ip: '198.51.100.2' });
    expect(ips).toContainEqual({ member_id: owner.member, ip: '198.51.100.1' });
    expect(await all('SELECT offer_id,sender_id,file_count,total_size FROM share_offers')).toEqual([
      { offer_id: offer, sender_id: owner.member, file_count: 2, total_size: 2060 },
    ]);
    expect(
      await all(
        'SELECT file_id,name,size,mime_type,md5,sha256 FROM share_offer_files ORDER BY file_id',
      ),
    ).toEqual(
      files.map((f, i) => ({
        file_id: f.id,
        name: f.name,
        size: f.size,
        mime_type: f.type,
        md5: md5[i],
        sha256: sha256[i],
      })),
    );
    const deliveries = await all(
      'SELECT recipient_id,status,route,finished_at FROM share_deliveries ORDER BY recipient_id',
    );
    const byId = Object.fromEntries(deliveries.map((d) => [d.recipient_id, d]));
    expect(byId[a.id]).toMatchObject({ status: 'complete', route: 'direct' });
    expect(byId[a.id].finished_at).toBeGreaterThan(0);
    expect(byId[b.id]).toMatchObject({ status: 'declined' });
    expect(deliveries).toHaveLength(2);
    expect(await one('SELECT COUNT(*) AS n FROM share_offers WHERE offer_id=?', bogus)).toEqual({
      n: 0,
    });
  });

  it('keeps a malformed report from reaching the database', async () => {
    const { mf, db } = await shareRuntime();
    runtimes.push(mf);
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    await ownerSocket.next('roster');
    audit(ownerSocket, {
      event: 'offer',
      offer: randomId(),
      files,
      md5: md5.slice(1),
      sha256,
      recipients: [],
    });
    expect(await ownerSocket.closed()).toBe(CLOSE.invalid);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM share_offers').first()).toEqual({ n: 0 });
  });
});

describe('room retention', { timeout: 60_000 }, () => {
  it('deletes expired rooms in bounded runs and keeps recent ones', async () => {
    const { mf, db } = await shareRuntime();
    runtimes.push(mf);
    const now = Date.now();
    const old = now - RETENTION_MS - 60_000;
    const seed = async (room: string, created: number, offers: number) => {
      await db
        .prepare(
          "INSERT INTO share_rooms(id,code,created_at,updated_at,expires_at) VALUES (?,'AB12CD',?,?,?)",
        )
        .bind(room, created, created, created + 1000)
        .run();
      const statements: D1PreparedStatement[] = [];
      for (let m = 0; m < 10; m++) {
        statements.push(
          db
            .prepare(
              'INSERT INTO share_members(room_id,member_id,name,is_owner,joined_at) VALUES (?,?,?,?,?)',
            )
            .bind(room, `m${m}`, `Member ${m}`, m === 0 ? 1 : 0, created),
        );
        for (let n = 0; n < 2; n++)
          statements.push(
            db
              .prepare(
                "INSERT INTO share_connections(id,room_id,member_id,ip,connected_at) VALUES (?,?,?,'192.0.2.1',?)",
              )
              .bind(`${room}-c${m}-${n}`, room, `m${m}`, created),
          );
      }
      for (let o = 0; o < offers; o++) {
        const offer = `${room}-o${o}`;
        statements.push(
          db
            .prepare(
              'INSERT INTO share_offers(room_id,offer_id,sender_id,created_at,file_count,total_size) VALUES (?,?,?,?,3,3)',
            )
            .bind(room, offer, 'm0', created),
        );
        for (let f = 0; f < 3; f++) {
          statements.push(
            db
              .prepare(
                "INSERT INTO share_offer_files(room_id,offer_id,file_id,name,size,mime_type) VALUES (?,?,?,'f',1,'')",
              )
              .bind(room, offer, f),
            db
              .prepare(
                'INSERT INTO share_deliveries(room_id,offer_id,recipient_id,updated_at) VALUES (?,?,?,?)',
              )
              .bind(room, offer, `m${f + 1}`, created),
          );
        }
      }
      for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    };
    await seed('old-room', old, 50);
    await seed('new-room', now, 5);
    const count = async (table: string, room: string) =>
      (await db
        .prepare(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${table === 'share_rooms' ? 'id' : 'room_id'}=?`,
        )
        .bind(room)
        .first<{ n: number }>())!.n;
    let runs = 0;
    while ((await count('share_rooms', 'old-room')) && runs < 10) {
      await pruneActivity(db, now);
      const status = await db
        .prepare('SELECT rows_written FROM activity_cleanup')
        .first<{ rows_written: number }>();
      expect(status!.rows_written).toBeLessThanOrEqual(1976);
      runs++;
    }
    expect(runs).toBeLessThan(10);
    for (const table of [
      'share_members',
      'share_connections',
      'share_offers',
      'share_offer_files',
      'share_deliveries',
    ])
      expect(await count(table, 'old-room'), table).toBe(0);
    expect(await count('share_offer_files', 'new-room')).toBe(15);
    expect(await count('share_rooms', 'new-room')).toBe(1);
  });
});

describe('admin rooms API', { timeout: 30_000 }, () => {
  async function seeded() {
    const { mf, db } = await shareRuntime();
    runtimes.push(mf);
    const now = Date.now();
    const room = (id: string, code: string, created: number) =>
      recordRoom(db, { id, code, created, expires: created + 86_400_000 });
    await room('a'.repeat(64), 'AB12CD', now - 5000);
    await room('b'.repeat(64), 'ZZ99YY', now - 1000);
    await room('c'.repeat(64), 'OLD111', now - RETENTION_MS - 1000);
    const owner = '1'.repeat(32),
      alice = '2'.repeat(32);
    await recordMember(db, 'a'.repeat(64), {
      id: owner,
      name: 'Owner',
      role: 'owner',
      joined: now - 5000,
    });
    await recordMember(db, 'a'.repeat(64), {
      id: alice,
      name: 'Alice <b>',
      role: 'member',
      joined: now - 4000,
    });
    await recordRoomConnection(db, 'a'.repeat(64), 'conn-1', alice, '203.0.113.9', 'NZ');
    await recordRoomReport(db, 'a'.repeat(64), owner, {
      event: 'offer',
      offer: 'e'.repeat(32),
      files: [{ id: 0, name: 'Quarterly report.pdf', size: 99, type: 'application/pdf' }],
      md5: ['9'.repeat(32)],
      sha256: ['8'.repeat(64)],
      recipients: [alice],
    });
    await recordRoomReport(db, 'a'.repeat(64), alice, {
      event: 'delivery',
      offer: 'e'.repeat(32),
      recipient: alice,
      status: 'complete',
      route: 'direct',
    });
    // Totals only grow: a late, smaller report doesn't lower them.
    await recordRoomReport(db, 'a'.repeat(64), alice, { event: 'messages', count: 4, bytes: 90 });
    await recordRoomReport(db, 'a'.repeat(64), alice, { event: 'messages', count: 2, bytes: 10 });
    await recordRoomEnded(db, 'b'.repeat(64), 'dismissed', now);
    return db;
  }
  const call = (db: D1Database, path: string) =>
    adminAPI(new URL(`https://admin.test${path}`), db, 'owner@example.com').then((r) =>
      r.json<any>(),
    );

  it('lists recent rooms newest first with counts and status', async () => {
    const db = await seeded();
    const { items, next } = await call(db, '/api/rooms');
    expect(items.map((r: any) => r.code)).toEqual(['ZZ99YY', 'AB12CD']);
    expect(items[1]).toMatchObject({
      member_count: 2,
      offer_count: 1,
      message_count: 4,
      owner_name: 'Owner',
      status: 'open',
    });
    expect(items[0]).toMatchObject({ status: 'dismissed' });
    expect(next).toBeNull();
  });
  it('searches by code, member name, file name, fingerprint and IP', async () => {
    const db = await seeded();
    for (const q of ['ab12cd', 'alice', 'quarterly', '8'.repeat(64), '9'.repeat(32), '203.0.113.9'])
      expect(
        (await call(db, `/api/rooms?q=${encodeURIComponent(q)}`)).items.map((r: any) => r.code),
        q,
      ).toEqual(['AB12CD']);
    expect((await call(db, '/api/rooms?q=nobody')).items).toEqual([]);
    // Longer than D1's 50-byte LIKE limit and matching nothing: empty, not an error.
    expect((await call(db, `/api/rooms?q=${'f'.repeat(64)}`)).items).toEqual([]);
    expect((await call(db, '/api/rooms?q=old111')).items).toEqual([]);
  });
  it('returns members, connections, offers, files and deliveries for one room', async () => {
    const db = await seeded();
    const detail = await call(db, `/api/rooms/${'a'.repeat(64)}`);
    expect(detail.room).toMatchObject({ code: 'AB12CD', status: 'open' });
    expect(detail.members.map((m: any) => [m.name, m.message_count, m.message_bytes])).toEqual([
      ['Owner', 0, 0],
      ['Alice <b>', 4, 90],
    ]);
    expect(detail.connections).toEqual([
      expect.objectContaining({
        member_id: '2'.repeat(32),
        member_name: 'Alice <b>',
        ip: '203.0.113.9',
        country: 'NZ',
      }),
    ]);
    expect(detail.offers).toEqual([
      expect.objectContaining({
        offer_id: 'e'.repeat(32),
        sender_name: 'Owner',
        file_count: 1,
        files: [expect.objectContaining({ name: 'Quarterly report.pdf', sha256: '8'.repeat(64) })],
        deliveries: [
          expect.objectContaining({
            recipient_name: 'Alice <b>',
            status: 'complete',
            route: 'direct',
          }),
        ],
      }),
    ]);
    const missing = await adminAPI(
      new URL(`https://admin.test/api/rooms/${'c'.repeat(64)}`),
      db,
      'x',
    );
    expect(missing.status).toBe(404);
  });
  it('pages through many rooms', async () => {
    const { mf, db } = await shareRuntime();
    runtimes.push(mf);
    const now = Date.now();
    for (let i = 0; i < 55; i++)
      await recordRoom(db, {
        id: i.toString(16).padStart(64, '0'),
        code: 'PAGE00',
        created: now - i,
        expires: now + 1000,
      });
    const first = await call(db, '/api/rooms');
    expect(first.items).toHaveLength(50);
    const second = await call(
      db,
      `/api/rooms?before=${first.next.before}&beforeId=${first.next.beforeId}`,
    );
    expect(second.items).toHaveLength(5);
    expect(second.next).toBeNull();
  });
});

describe('room activity budget', { timeout: 120_000 }, () => {
  it('caps what one room can write, even across reconnects', async () => {
    const { mf, db } = await shareRuntime();
    runtimes.push(mf);
    const owner = await ownerSetup();
    let socket = await openRoom(mf, owner.locator, owner.hello, '198.51.100.1');
    const alice = await admitted(mf, owner, socket, 'Alice', '198.51.100.2');
    const hundred = Array.from({ length: 100 }, (_, id) => ({
      id,
      name: `f${id}.txt`,
      size: 1,
      type: 'text/plain',
    }));
    const report = () => ({
      event: 'offer',
      offer: randomId(),
      files: hundred,
      md5: hundred.map(() => '1'.repeat(32)),
      sha256: hundred.map(() => '2'.repeat(64)),
      recipients: [alice.id],
    });
    const rejoin = {
      v: 1 as const,
      role: 'rejoin' as const,
      member: owner.member,
      credential: owner.credential,
    };
    for (let i = 0; i < 32; i++) {
      if (i === 16) {
        // A reconnect must not reset the budget.
        socket.socket.close(1000);
        socket = await openRoom(mf, owner.locator, rejoin, '198.51.100.1');
        await socket.next('welcome');
      }
      const id = audit(socket, report());
      await socket.next('audit-ack', (m) => m.id === id);
    }
    const count = async (table: string) =>
      (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
    expect(await count('share_offer_files')).toBe(3000);
    expect(await count('share_offers')).toBe(30);
  });
  it('caps message-count updates per room, even across reconnects', async () => {
    const { mf, db } = await shareRuntime();
    runtimes.push(mf);
    const owner = await ownerSetup();
    let socket = await openRoom(mf, owner.locator, owner.hello, '198.51.100.1');
    await socket.next('welcome');
    const rejoin = {
      v: 1 as const,
      role: 'rejoin' as const,
      member: owner.member,
      credential: owner.credential,
    };
    for (let count = 1; count <= 1010; count++) {
      // One connection may send 512 reports; reconnecting must not reset the room's budget.
      if (count % 500 === 1 && count > 1) {
        socket.socket.close(1000);
        socket = await openRoom(mf, owner.locator, rejoin, '198.51.100.1');
        await socket.next('welcome');
      }
      const id = audit(socket, { event: 'messages', count, bytes: count * 2 });
      await socket.next('audit-ack', (m) => m.id === id);
    }
    const row = await db
      .prepare('SELECT message_count, message_bytes FROM share_members WHERE member_id=?')
      .bind(owner.member)
      .first();
    expect(row).toEqual({ message_count: 1000, message_bytes: 2000 });
  });
});
