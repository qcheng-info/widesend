import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { pairingCode, roomId, token } from '../../src/crypto';
import { PAKE_SUITE } from '../../shared/key-exchange';
import {
  CLOSE,
  CONTROL_ALLOWANCE,
  DESTINATION_BACKLOG,
  MAX_UNICAST,
  PIECE_HEADER,
  PIECE_SIZE,
  ROOM_MS,
  decodeForward,
  encodeFanout,
  encodeUnicast,
  idBytes,
} from '../../shared/room';
import {
  ORIGIN,
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
async function runtime(options: Parameters<typeof shareRuntime>[0] = {}) {
  const result = await shareRuntime(options);
  runtimes.push(result.mf);
  return result;
}
const key = '04' + 'ab'.repeat(64);
const cert = 'cd'.repeat(64);
const share = (round: string) => ({
  type: 'key-exchange',
  step: 'share',
  round,
  suite: PAKE_SUITE,
  point: '04' + '00'.repeat(64),
  identity: '04' + '11'.repeat(64),
});
async function admitted(
  mf: Miniflare,
  owner: OwnerSetup,
  ownerSocket: TestSocket,
  name = 'Member',
  ip = '192.0.2.1',
) {
  const hello = joinHello(owner.code, name);
  const socket = await openRoom(mf, owner.locator, hello, ip);
  await ownerSocket.next('join-request', (m) => m.id === hello.member);
  ownerSocket.send({ type: 'admit', id: hello.member, key, cert });
  await socket.next('admitted');
  return { hello, socket };
}

describe('ShareRoom membership', { timeout: 20_000 }, () => {
  it('creates a room and refuses a second create on the same code', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const socket = await openRoom(mf, owner.locator, owner.hello);
    expect(await socket.next('welcome')).toMatchObject({ you: owner.member, status: 'owner' });
    const roster = await socket.next('roster');
    expect(roster).toMatchObject({
      owner: owner.member,
      ownerKey: owner.identity.publicKey,
      settings: { join: 'auto', size: 10, send: 'everyone' },
      pending: 0,
      expires: owner.expires,
    });
    expect(roster.members).toEqual([
      expect.objectContaining({ id: owner.member, name: 'Owner', role: 'owner', online: true }),
    ]);
    const again = await openRoom(mf, owner.locator, { ...owner.hello, member: randomId() });
    expect(await again.closed()).toBe(CLOSE.exists);
  });

  it('rejects a join code that does not match the room', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    await openRoom(mf, owner.locator, owner.hello);
    const other = await ownerSetup();
    const socket = await openRoom(mf, owner.locator, joinHello(other.code));
    expect(socket.response.status).toBe(400);
  });

  it('forwards at most two SPAKE2 messages per side per round and admits on the owner’s word', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    await ownerSocket.next('roster');
    const hello = joinHello(owner.code, '小明');
    const joiner = await openRoom(mf, owner.locator, hello);
    expect(await joiner.next('welcome')).toMatchObject({ you: hello.member, status: 'pending' });
    const { round } = await joiner.next('pending', (m) => m.ownerOnline);
    const request = await ownerSocket.next('join-request');
    expect(request).toMatchObject({ id: hello.member, name: '小明', round });

    joiner.send({ type: 'join-kex', message: share(crypto.randomUUID()) }); // stale round: dropped
    joiner.send({ type: 'join-kex', message: share(round) });
    const forwarded = await ownerSocket.next('join-kex');
    expect(forwarded).toEqual({ type: 'join-kex', from: hello.member, message: share(round) });
    ownerSocket.send({ type: 'join-kex', to: hello.member, message: share(round) });
    expect((await joiner.next('join-kex')).message).toEqual(share(round));

    // A pending joiner can't admit itself or send anything but key messages.
    joiner.send({ type: 'admit', id: hello.member, key, cert });
    expect(await joiner.closed()).toBe(CLOSE.invalid);
    expect(ownerSocket.messages.filter((m) => m.type === 'join-kex')).toHaveLength(1);

    const second = await openRoom(mf, owner.locator, joinHello(owner.code));
    const { round: r2 } = await second.next('pending', (m) => m.ownerOnline);
    second.send({ type: 'join-kex', message: share(r2) });
    second.send({ type: 'join-kex', message: share(r2) });
    second.send({ type: 'join-kex', message: share(r2) });
    expect(await second.closed()).toBe(CLOSE.invalid);
    await expect
      .poll(() => ownerSocket.messages.filter((m) => m.type === 'join-kex').length)
      .toBe(3);
  });

  it('admits members into every roster and lets the owner deny others', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    const { hello, socket } = await admitted(mf, owner, ownerSocket, 'Blue Fox');
    const roster = await socket.next('roster', (m) => m.members.length === 2);
    expect(roster.members).toContainEqual({
      id: hello.member,
      name: 'Blue Fox',
      key,
      cert,
      role: 'member',
      online: true,
    });
    await ownerSocket.next('roster', (m) => m.members.length === 2);

    // An admitted member can't admit anyone either.
    const pending = joinHello(owner.code);
    const waiting = await openRoom(mf, owner.locator, pending);
    await waiting.next('pending', (m) => m.ownerOnline);
    socket.send({ type: 'admit', id: pending.member, key, cert });
    expect(await socket.closed()).toBe(CLOSE.invalid);

    ownerSocket.send({ type: 'deny', id: pending.member });
    expect(await waiting.closed()).toBe(CLOSE.declined);
  });

  it('refuses joins once the room is full and limits pending requests', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup({ join: 'approve', size: 2, send: 'everyone' });
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    await admitted(mf, owner, ownerSocket);
    const late = await openRoom(mf, owner.locator, joinHello(owner.code));
    expect(await late.closed()).toBe(CLOSE.full);

    const roomy = await ownerSetup({ join: 'approve', size: 20, send: 'everyone' });
    await openRoom(mf, roomy.locator, roomy.hello);
    const waiting: TestSocket[] = [];
    for (let i = 0; i < 8; i++) {
      const socket = await openRoom(mf, roomy.locator, joinHello(roomy.code), `198.51.100.${i}`);
      await socket.next('welcome');
      waiting.push(socket);
    }
    const ninth = await openRoom(mf, roomy.locator, joinHello(roomy.code), '198.51.100.99');
    expect(await ninth.closed()).toBe(CLOSE.limited);
    expect(waiting.every((s) => s.closeCode() === undefined)).toBe(true);
  });

  it('keeps joiners waiting for an offline owner and restarts rounds when the owner returns', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const first = await openRoom(mf, owner.locator, owner.hello);
    await first.next('roster');
    const hello = joinHello(owner.code);
    const joiner = await openRoom(mf, owner.locator, hello);
    const { round: before } = await joiner.next('pending', (m) => m.ownerOnline);
    first.socket.close(1000);
    await joiner.next('pending', (m) => m.ownerOnline === false);

    const late = joinHello(owner.code);
    const lateSocket = await openRoom(mf, owner.locator, late);
    expect(await lateSocket.next('pending')).toMatchObject({ ownerOnline: false });

    const mark = joiner.mark();
    const back = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: owner.member,
      credential: owner.credential,
    });
    expect(await back.next('welcome')).toMatchObject({ status: 'owner' });
    const { round: after } = await joiner.next('pending', (m) => m.ownerOnline, mark);
    expect(after).not.toBe(before);
    expect(await back.next('join-request', (m) => m.id === hello.member)).toMatchObject({
      round: after,
    });
    await back.next('join-request', (m) => m.id === late.member);
    // The old round is no longer forwarded.
    joiner.send({ type: 'join-kex', message: share(before) });
    joiner.send({ type: 'join-kex', message: share(after) });
    const forwarded = await back.next('join-kex');
    expect(forwarded.message.round).toBe(after);
  });

  it('restores members by credential and refuses strangers', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    const { hello, socket } = await admitted(mf, owner, ownerSocket);
    socket.socket.close(1000);
    await ownerSocket.next(
      'roster',
      (m) => m.members.find((x: any) => x.id === hello.member)?.online === false,
    );
    const back = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: hello.member,
      credential: hello.credential,
    });
    expect(await back.next('welcome')).toMatchObject({ status: 'member' });
    await ownerSocket.next(
      'roster',
      (m) => m.members.find((x: any) => x.id === hello.member)?.online === true,
    );
    const wrong = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: hello.member,
      credential: token(32),
    });
    expect(await wrong.closed()).toBe(CLOSE.notFound);
    const stranger = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: randomId(),
      credential: token(32),
    });
    expect(await stranger.closed()).toBe(CLOSE.notFound);
    const missing = await ownerSetup();
    const nowhere = await openRoom(mf, missing.locator, joinHello(missing.code));
    expect(await nowhere.closed()).toBe(CLOSE.notFound);
  });

  it('replaces an older connection of the same member', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const first = await openRoom(mf, owner.locator, owner.hello);
    await first.next('roster');
    const rejoin = {
      v: 1 as const,
      role: 'rejoin' as const,
      member: owner.member,
      credential: owner.credential,
    };
    const second = await openRoom(mf, owner.locator, rejoin);
    await second.next('welcome');
    expect(await first.closed()).toBe(CLOSE.replaced);
  });

  it('removes members so they cannot come back', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    const { hello, socket } = await admitted(mf, owner, ownerSocket);
    ownerSocket.send({ type: 'remove', id: hello.member });
    expect(await socket.closed()).toBe(CLOSE.removed);
    await ownerSocket.next('roster', (m) => m.members.length === 1);
    const back = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: hello.member,
      credential: hello.credential,
    });
    expect(await back.closed()).toBe(CLOSE.removed);
    const again = await openRoom(mf, owner.locator, { ...hello, credential: token(32) });
    expect(await again.closed()).toBe(CLOSE.removed);
    // The owner can't remove itself.
    ownerSocket.send({ type: 'remove', id: owner.member });
    expect(await ownerSocket.closed()).toBe(CLOSE.invalid);
  });

  it('validates settings, which only the owner may change', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    const { socket } = await admitted(mf, owner, ownerSocket);
    await admitted(mf, owner, ownerSocket, 'Third');
    ownerSocket.send({ type: 'settings', settings: { join: 'approve', size: 3, send: 'owner' } });
    await socket.next('roster', (m) => m.settings.send === 'owner' && m.settings.size === 3);
    const mark = ownerSocket.mark();
    ownerSocket.send({ type: 'settings', settings: { join: 'approve', size: 2, send: 'owner' } });
    await ownerSocket.next('settings-rejected', undefined, mark);
    socket.send({ type: 'settings', settings: { join: 'auto', size: 5, send: 'everyone' } });
    expect(await socket.closed()).toBe(CLOSE.invalid);
  });

  it('lets members leave and the owner dismiss the room', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    const first = await admitted(mf, owner, ownerSocket, 'First');
    const second = await admitted(mf, owner, ownerSocket, 'Second');
    first.socket.send({ type: 'leave' });
    expect(await first.socket.closed()).toBe(CLOSE.left);
    await ownerSocket.next(
      'roster',
      (m) => m.members.length === 2 && !m.members.some((x: any) => x.id === first.hello.member),
    );
    const back = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: first.hello.member,
      credential: first.hello.credential,
    });
    expect(await back.closed()).toBe(CLOSE.notFound);
    // The owner can't leave, only dismiss.
    const pending = await openRoom(mf, owner.locator, joinHello(owner.code));
    await pending.next('pending');
    ownerSocket.send({ type: 'dismiss' });
    expect(await ownerSocket.closed()).toBe(CLOSE.dismissed);
    expect(await second.socket.closed()).toBe(CLOSE.dismissed);
    expect(await pending.closed()).toBe(CLOSE.dismissed);
    const later = await openRoom(mf, owner.locator, joinHello(owner.code));
    expect(await later.closed()).toBe(CLOSE.dismissed);
    const rejoin = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: second.hello.member,
      credential: second.hello.credential,
    });
    expect(await rejoin.closed()).toBe(CLOSE.dismissed);
  });

  it('expires with the room', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup(undefined, Date.now() + 1500);
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    await ownerSocket.next('roster');
    await expect.poll(() => ownerSocket.closeCode(), { timeout: 8000 }).toBe(CLOSE.expired);
    const back = await openRoom(mf, owner.locator, {
      v: 1,
      role: 'rejoin',
      member: owner.member,
      credential: owner.credential,
    });
    expect(await back.closed()).toBe(CLOSE.notFound);
  });

  it('counts a room once per network and only creation spends the creation budget', async () => {
    const { mf } = await runtime({ limits: { roomsPerNetwork: 1, createsPerHour: 1000 } });
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello, '203.0.113.5');
    for (let i = 0; i < 3; i++) await admitted(mf, owner, ownerSocket, `M${i}`, '203.0.113.5');
    const other = await ownerSetup();
    const blocked = await openRoom(mf, other.locator, other.hello, '203.0.113.5');
    expect(await blocked.closed()).toBe(CLOSE.limited);
    expect(blocked.messages[0]).toMatchObject({ type: 'limited' });
    // A different network may still create.
    const elsewhere = await openRoom(mf, other.locator, other.hello, '203.0.113.99');
    expect(await elsewhere.next('welcome')).toMatchObject({ status: 'owner' });
  });

  it('rejects room lifetimes over 24 hours at the edge', async () => {
    const { mf } = await runtime();
    const owner = await ownerSetup(undefined, Date.now() + ROOM_MS + 60_000);
    const socket = await openRoom(mf, owner.locator, owner.hello);
    expect(socket.response.status).toBe(400);
  });
});

describe('ShareRoom relay', { timeout: 30_000 }, () => {
  const piece = (offer: string, size = 1024, index = 0) => {
    const bytes = new Uint8Array(PIECE_HEADER + size);
    bytes[0] = 1;
    bytes.set(idBytes(offer), 1);
    new DataView(bytes.buffer).setUint32(19, index);
    bytes.fill(7, PIECE_HEADER);
    return bytes;
  };
  async function room(mf: Miniflare) {
    const owner = await ownerSetup();
    const ownerSocket = await openRoom(mf, owner.locator, owner.hello);
    const a = await admitted(mf, owner, ownerSocket, 'A');
    const b = await admitted(mf, owner, ownerSocket, 'B');
    return { owner, ownerSocket, a, b };
  }
  const forwarded = (socket: TestSocket) => socket.frames.map((f) => decodeForward(f));

  it('forwards unicast frames only between admitted members, prefixed with the sender', async () => {
    const { mf } = await runtime();
    const { owner, ownerSocket, a, b } = await room(mf);
    const payload = new Uint8Array([0x11, 1, 2, 3]);
    a.socket.sendBinary(encodeUnicast(b.hello.member, payload));
    await expect.poll(() => b.socket.frames.length).toBe(1);
    expect(forwarded(b.socket)[0]).toEqual({ kind: 0, from: a.hello.member, payload });
    // Unknown and pending destinations drop silently.
    const pending = joinHello(owner.code);
    const waiting = await openRoom(mf, owner.locator, pending);
    await waiting.next('pending');
    a.socket.sendBinary(encodeUnicast(pending.member, payload));
    a.socket.sendBinary(encodeUnicast(randomId(), payload));
    a.socket.sendBinary(encodeUnicast(ownerSocket.messages[0].you, payload));
    await expect.poll(() => ownerSocket.frames.length).toBe(1);
    expect(waiting.frames).toHaveLength(0);
    expect(a.socket.closeCode()).toBeUndefined();
    // Pending joiners can't send frames; oversized unicast closes the sender.
    waiting.sendBinary(encodeUnicast(a.hello.member, payload));
    expect(await waiting.closed()).toBe(CLOSE.invalid);
    const oversized = new Uint8Array(17 + MAX_UNICAST + 1);
    oversized.set(idBytes(b.hello.member), 1);
    a.socket.sendBinary(oversized);
    expect(await a.socket.closed()).toBe(CLOSE.invalid);
  });

  it('requires relay admission per offer and fans one upload out to every listed member', async () => {
    const { mf } = await runtime();
    const { owner, ownerSocket, a, b } = await room(mf);
    const offer = randomId();
    ownerSocket.sendBinary(encodeFanout([a.hello.member, b.hello.member], piece(offer)));
    expect(await ownerSocket.next('relay-limited', (m) => m.offer === offer)).toBeDefined();
    ownerSocket.send({ type: 'relay-request', offer });
    await ownerSocket.next('relay-admitted', (m) => m.offer === offer);
    const pending = joinHello(owner.code);
    const waiting = await openRoom(mf, owner.locator, pending);
    await waiting.next('pending');
    ownerSocket.sendBinary(
      encodeFanout([a.hello.member, b.hello.member, pending.member, randomId()], piece(offer)),
    );
    await expect.poll(() => a.socket.frames.length).toBe(1);
    await expect.poll(() => b.socket.frames.length).toBe(1);
    expect(forwarded(a.socket)[0]).toEqual({
      kind: 1,
      from: ownerSocket.messages[0].you,
      payload: piece(offer),
    });
    expect(waiting.frames).toHaveLength(0);
    // Admission is bound to this room.
    const other = await ownerSetup();
    const otherSocket = await openRoom(mf, other.locator, other.hello);
    const c = await admitted(mf, other, otherSocket, 'C');
    otherSocket.sendBinary(encodeFanout([c.hello.member], piece(offer)));
    await otherSocket.next('relay-limited', (m) => m.offer === offer);
    expect(c.socket.frames).toHaveLength(0);
  });

  it('skips a destination with more than 8 MiB undrained and resumes after it drains', async () => {
    const { mf } = await runtime();
    const { ownerSocket, a, b } = await room(mf);
    const offer = randomId();
    ownerSocket.send({ type: 'relay-request', offer });
    await ownerSocket.next('relay-admitted');
    const size = PIECE_SIZE;
    const count = Math.floor(DESTINATION_BACKLOG / (size + PIECE_HEADER + 17)) + 1;
    for (let i = 0; i <= count; i++)
      ownerSocket.sendBinary(encodeFanout([a.hello.member, b.hello.member], piece(offer, size, i)));
    const skipped = await ownerSocket.next('relay-skipped');
    expect(skipped).toMatchObject({ offer, file: 0, to: [a.hello.member, b.hello.member] });
    expect(skipped.piece).toBeGreaterThan(0);
    await expect.poll(() => a.socket.frames.length).toBe(skipped.piece);
    a.socket.send({ type: 'drain', bytes: a.socket.frames.reduce((n, f) => n + f.byteLength, 0) });
    await new Promise((resolve) => setTimeout(resolve, 200));
    ownerSocket.sendBinary(encodeFanout([a.hello.member, b.hello.member], piece(offer, size, 999)));
    await expect
      .poll(() =>
        forwarded(a.socket).some(
          (f) => new DataView(f.payload.buffer, f.payload.byteOffset).getUint32(19) === 999,
        ),
      )
      .toBe(true);
    expect(
      forwarded(b.socket).some(
        (f) => new DataView(f.payload.buffer, f.payload.byteOffset).getUint32(19) === 999,
      ),
    ).toBe(false);
  });

  it('still delivers small control frames to a member whose piece backlog is full', async () => {
    const { mf } = await runtime();
    const { ownerSocket, a, b } = await room(mf);
    const offer = randomId();
    ownerSocket.send({ type: 'relay-request', offer });
    await ownerSocket.next('relay-admitted');
    // Fill a's undrained backlog to within 100 KB of the limit.
    const frame = PIECE_SIZE + PIECE_HEADER + 17;
    const full = Math.floor(DESTINATION_BACKLOG / frame);
    for (let i = 0; i < full; i++)
      ownerSocket.sendBinary(encodeFanout([a.hello.member], piece(offer, PIECE_SIZE, i)));
    const rest = DESTINATION_BACKLOG - full * frame - 100_000 - PIECE_HEADER - 17;
    ownerSocket.sendBinary(encodeFanout([a.hello.member], piece(offer, rest, full)));
    await expect.poll(() => a.socket.frames.length).toBe(full + 1);
    const control = new Uint8Array(110_000).fill(0x11);
    b.socket.sendBinary(encodeUnicast(a.hello.member, control));
    await expect.poll(() => a.socket.frames.length).toBe(full + 2);
    expect(forwarded(a.socket).at(-1)).toMatchObject({ kind: 0, from: b.hello.member });
  });

  it('refuses relay admission when the daily budget is closed', async () => {
    const { mf } = await runtime();
    const { ownerSocket } = await room(mf);
    const ns = await mf.getDurableObjectNamespace('GUARD');
    const guard = ns.get(ns.idFromName('public-admission')) as any;
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await guard.recordUsage('seed', [{ day, messages: 900_000, bytes: 0 }]);
    const offer = randomId();
    ownerSocket.send({ type: 'relay-request', offer });
    expect(
      (await ownerSocket.next('relay-limited', (m) => m.offer === offer)).retryAfter,
    ).toBeGreaterThan(0);
  });

  it('records relayed usage once per incoming frame, including fan-out', async () => {
    const { mf } = await runtime();
    const { ownerSocket, a, b } = await room(mf);
    const ns = await mf.getDurableObjectNamespace('GUARD');
    const guard = ns.get(ns.idFromName('public-admission')) as any;
    const before = (await guard.health()).relay.daily[6];
    const offer = randomId();
    ownerSocket.send({ type: 'relay-request', offer });
    await ownerSocket.next('relay-admitted');
    const body = piece(offer, 100_000);
    ownerSocket.sendBinary(encodeFanout([a.hello.member, b.hello.member], body));
    await expect.poll(() => b.socket.frames.length).toBe(1);
    a.socket.sendBinary(encodeUnicast(b.hello.member, new Uint8Array(50).fill(0x11)));
    await expect.poll(() => b.socket.frames.length).toBe(2);
    // Leaving flushes usage for these connections.
    a.socket.send({ type: 'leave' });
    await a.socket.closed();
    ownerSocket.send({ type: 'dismiss' });
    await ownerSocket.closed();
    await expect
      .poll(async () => (await guard.health()).relay.daily[6].bytes - before.bytes, {
        timeout: 8000,
      })
      .toBe(body.length + 50);
    const after = (await guard.health()).relay.daily[6];
    // relay-request, fan-out, unicast, leave, dismiss, plus the owner's second setup
    // admit (and the first, if its flush landed after the baseline): one per frame.
    expect(after.messages - before.messages).toBeGreaterThanOrEqual(6);
    expect(after.messages - before.messages).toBeLessThanOrEqual(7);
  });

  it('needs a room-level admission after 16 MiB of unicast traffic from one connection', async () => {
    const { mf } = await runtime();
    const { a, b } = await room(mf);
    const chunk = new Uint8Array(MAX_UNICAST).fill(0x11);
    const count = CONTROL_ALLOWANCE / MAX_UNICAST;
    // Like a real browser, b drains what it has processed as it goes.
    for (let sent = 0; sent < count; sent += 32) {
      for (let i = 0; i < 32; i++) a.socket.sendBinary(encodeUnicast(b.hello.member, chunk));
      await expect.poll(() => b.socket.frames.length, { timeout: 15_000 }).toBe(sent + 32);
      b.socket.send({ type: 'drain', bytes: 32 * (MAX_UNICAST + 17) });
    }
    const ns = await mf.getDurableObjectNamespace('GUARD');
    const guard = ns.get(ns.idFromName('public-admission')) as any;
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await guard.recordUsage('seed', [{ day, messages: 900_000, bytes: 0 }]);
    a.socket.sendBinary(encodeUnicast(b.hello.member, chunk));
    await a.socket.next('relay-limited', (m) => m.offer === null);
    expect(b.socket.frames.length).toBe(count);
  });
});

describe('ShareRoom concurrency budget', { timeout: 30_000 }, () => {
  async function transfer(mf: Miniflare, ip: string) {
    const code = pairingCode();
    const hello = {
      code,
      role: 'send',
      credential: token(32),
      expires: Date.now() + 86_399_000,
      pairExpires: Date.now() + 599_000,
      keyExchange: 2,
    };
    const response = await mf.dispatchFetch(`${ORIGIN}/api/rooms/${await roomId(code)}`, {
      headers: {
        Origin: ORIGIN,
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `widesend, ${Buffer.from(JSON.stringify(hello)).toString('base64url')}`,
        'CF-Connecting-IP': ip,
      },
    });
    const socket = response.webSocket!;
    const messages: any[] = [];
    socket.addEventListener('message', (e) => messages.push(JSON.parse(e.data as string)));
    socket.accept();
    await expect
      .poll(() => messages.find((m) => ['connected', 'limited'].includes(m.type)))
      .toBeDefined();
    return messages.find((m) => ['connected', 'limited'].includes(m.type)).type;
  }
  it('keeps long-lived rooms from using up one-to-one transfer slots, and the reverse', async () => {
    const { mf } = await runtime({ limits: { concurrentGlobal: 1, roomsGlobal: 1 } });
    const first = await ownerSetup();
    const room = await openRoom(mf, first.locator, first.hello, '203.0.113.1');
    await room.next('welcome');
    // The room holds the only room slot, but not the only transfer slot.
    expect(await transfer(mf, '203.0.113.2')).toBe('connected');
    expect(await transfer(mf, '203.0.113.3')).toBe('limited');
    const second = await ownerSetup();
    const blocked = await openRoom(mf, second.locator, second.hello, '203.0.113.4');
    expect(await blocked.closed()).toBe(CLOSE.limited);
  });
});
