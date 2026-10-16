import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Miniflare } from 'miniflare';
import { Room } from '../../src/room/room';
import { pairingCode } from '../../src/crypto';
import { PIECE_SIZE } from '../../shared/room';
import { CLIENT_CLOSE } from '../../shared/diagnostics';
import { inRoom, roomHarness, until, type TestEnvironment } from '../fixtures/room-harness';
import { pastTimeline } from '../../src/room/conversation';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task().catch(() => {});
});
async function harness(options?: Parameters<typeof roomHarness>[0]) {
  const h = await roomHarness(options);
  cleanup.push(() => (h.mf as Miniflare).dispose());
  return h;
}
function track(room: Room): Room {
  cleanup.push(() => room.dispose());
  return room;
}
async function created(
  env: TestEnvironment,
  settings = { join: 'auto', size: 10, send: 'everyone' } as const,
  name = 'Owner',
) {
  const room = track(Room.create(env, { name, settings: { ...settings } }));
  await room.start();
  await until(room, (s) => s.phase === 'in-room' && s.members.length === 1);
  return room;
}
async function joined(env: TestEnvironment, code: string, name: string) {
  const room = track(Room.join(env, { code, name }));
  await room.start();
  return room;
}

describe('room membership in the browser engine', { timeout: 60_000 }, () => {
  it('creates a room and lets a joiner in automatically with verified certificates', async () => {
    const { environment } = await harness();
    const ownerEnv = environment();
    const owner = await created(ownerEnv);
    expect(owner.snapshot).toMatchObject({
      isOwner: true,
      code: expect.stringMatching(/^[A-Z0-9]{6}$/),
    });
    const joinerEnv = environment();
    const joiner = await joined(joinerEnv, owner.snapshot.code, 'Blue Fox');
    const seen = await until(joiner, inRoom(2));
    expect(seen.isOwner).toBe(false);
    expect(seen.members.map((m) => [m.name, m.owner, m.me]).sort()).toEqual([
      ['Blue Fox', false, true],
      ['Owner', true, false],
    ]);
    await until(owner, inRoom(2));
    const record = await joinerEnv.store.get(joiner.snapshot.locator);
    expect(record).toMatchObject({ role: 'member', name: 'Blue Fox', code: owner.snapshot.code });
    expect((await ownerEnv.store.get(owner.snapshot.locator))?.role).toBe('owner');
  });

  const closeOf = (db: D1Database, member: string) =>
    db
      .prepare(
        'SELECT closed_by, close_code, close_reason FROM share_connections WHERE member_id=?',
      )
      .bind(member)
      .first();

  it('says why it closed when this page is finished with the room', async () => {
    const { environment, db } = await harness();
    const owner = await created(environment());
    const joiner = await joined(environment(), owner.snapshot.code, 'Blue Fox');
    await until(joiner, inRoom(2));
    const id = joiner.snapshot.me;
    await joiner.dispose();
    await expect
      .poll(() => closeOf(db, id))
      .toEqual({
        closed_by: 'browser',
        close_code: CLIENT_CLOSE.done,
        close_reason: 'Room closed on this page',
      });
  });

  it('records a failed key check as the reason a join ended', async () => {
    const { environment, db } = await harness();
    const owner = await created(environment());
    const joinerEnv = environment();
    // Corrupt the room creator's key share on its way to the joiner.
    joinerEnv.hooks.incoming = (data) => {
      if (typeof data !== 'string' || !data.includes('"join-kex"')) return data;
      const m = JSON.parse(data);
      if (m.message?.step === 'share') m.message.point = '04' + 'ff'.repeat(64);
      return JSON.stringify(m);
    };
    const joiner = await joined(joinerEnv, owner.snapshot.code, 'Blue Fox');
    expect((await until(joiner, (s) => s.phase === 'ended')).ended).toBe('failed');
    await expect
      .poll(() => closeOf(db, joiner.snapshot.me))
      .toEqual({
        closed_by: 'browser',
        close_code: CLIENT_CLOSE.done,
        close_reason: 'Key check with the room creator failed',
      });
  });

  it('asks the owner in approval mode and ends a declined joiner', async () => {
    const { environment } = await harness();
    const owner = await created(environment(), { join: 'approve', size: 10, send: 'everyone' });
    const first = await joined(environment(), owner.snapshot.code, 'Alice');
    await until(first, (s) => s.phase === 'pending' && s.pending === 'approval');
    const request = (await until(owner, (s) => s.requests.some((r) => r.verified))).requests[0];
    expect(request).toMatchObject({ name: 'Alice', verified: true });
    owner.approve(request.id);
    await until(first, inRoom(2));
    await until(owner, (s) => s.requests.length === 0);

    const second = await joined(environment(), owner.snapshot.code, 'Mallory');
    const pending = await until(owner, (s) =>
      s.requests.some((r) => r.name === 'Mallory' && r.verified),
    );
    owner.deny(pending.requests.find((r) => r.name === 'Mallory')!.id);
    expect((await until(second, (s) => s.phase === 'ended')).ended).toBe('declined');
  });

  it('hides roster entries whose certificate the owner did not sign', async () => {
    const { environment } = await harness();
    const owner = await created(environment());
    const env = environment();
    env.hooks.incoming = (data) => {
      if (typeof data !== 'string') return data;
      const message = JSON.parse(data);
      if (message.type !== 'roster') return data;
      message.members.push({
        id: 'f'.repeat(32),
        name: 'Impostor',
        key: '04' + 'ab'.repeat(64),
        cert: 'cd'.repeat(64),
        role: 'member',
        online: true,
      });
      return JSON.stringify(message);
    };
    const joiner = await joined(env, owner.snapshot.code, 'Real');
    const seen = await until(joiner, inRoom(2));
    expect(seen.members.map((m) => m.name)).not.toContain('Impostor');
  });

  it('keeps a joiner waiting while the owner is offline', async () => {
    const { environment } = await harness();
    const ownerEnv = environment();
    const owner = await created(ownerEnv);
    const code = owner.snapshot.code;
    await owner.dispose();
    const joiner = await joined(environment(), code, 'Patient');
    await until(joiner, (s) => s.phase === 'pending' && s.pending === 'owner-offline');
    const back = track((await Room.restore(ownerEnv))!);
    await back.start();
    await until(joiner, inRoom(2));
    await until(back, inRoom(2));
  });

  it('rejoins after a reload without asking the owner again', async () => {
    const { environment } = await harness();
    const owner = await created(environment(), { join: 'approve', size: 10, send: 'everyone' });
    const env = environment();
    const first = await joined(env, owner.snapshot.code, 'Returning');
    const request = (await until(owner, (s) => s.requests.some((r) => r.verified))).requests[0];
    owner.approve(request.id);
    await until(first, inRoom(2));
    await first.dispose();
    await until(owner, (s) => s.members.some((m) => !m.online));
    const again = track((await Room.restore(env))!);
    await again.start();
    await until(again, inRoom(2));
    expect(owner.snapshot.requests).toHaveLength(0);
    expect(again.snapshot.me).toBe(first.snapshot.me);
  });

  it('ends with the right reason when removed, leaving or dismissed, and forgets the room', async () => {
    const { environment } = await harness();
    const owner = await created(environment());
    const removedEnv = environment();
    const removed = await joined(removedEnv, owner.snapshot.code, 'Removed');
    const leavingEnv = environment();
    const leaving = await joined(leavingEnv, owner.snapshot.code, 'Leaving');
    const stayingEnv = environment();
    const staying = await joined(stayingEnv, owner.snapshot.code, 'Staying');
    await until(owner, inRoom(4));
    owner.remove(removed.snapshot.me);
    expect((await until(removed, (s) => s.phase === 'ended')).ended).toBe('removed');
    expect(await removedEnv.store.latest()).toBeUndefined();
    await leaving.leave();
    expect((await until(leaving, (s) => s.phase === 'ended')).ended).toBe('left');
    expect(await leavingEnv.store.latest()).toBeUndefined();
    await until(owner, inRoom(2));
    await owner.dismiss();
    expect((await until(staying, (s) => s.phase === 'ended')).ended).toBe('dismissed');
    expect((await until(owner, (s) => s.phase === 'ended')).ended).toBe('dismissed');
    expect(await stayingEnv.store.latest()).toBeUndefined();
  });

  it('does not pretend to close or leave the room while disconnected', async () => {
    const { environment } = await harness();
    const ownerEnv = environment();
    const owner = await created(ownerEnv);
    const memberEnv = environment();
    const member = await joined(memberEnv, owner.snapshot.code, 'Member');
    await until(member, inRoom(2));
    ownerEnv.sockets.at(-1)!.drop();
    memberEnv.sockets.at(-1)!.drop();
    await owner.dismiss();
    await member.leave();
    expect(owner.snapshot.phase).toBe('in-room');
    expect(member.snapshot.phase).toBe('in-room');
    expect(owner.snapshot.message).toBe('You’re offline. Try again when you’re connected.');
    expect(await ownerEnv.store.latest()).toBeDefined();
    // Once connected again, closing the room works for everyone.
    await until(owner, (s) => s.connection === 'online');
    await until(member, (s) => s.connection === 'online');
    await owner.dismiss();
    expect((await until(member, (s) => s.phase === 'ended')).ended).toBe('dismissed');
    expect((await until(owner, (s) => s.phase === 'ended')).ended).toBe('dismissed');
  });

  it('reports a full room and an unknown code', async () => {
    const { environment } = await harness();
    const owner = await created(environment(), { join: 'auto', size: 2, send: 'everyone' });
    const first = await joined(environment(), owner.snapshot.code, 'First');
    await until(first, inRoom(2));
    const late = await joined(environment(), owner.snapshot.code, 'Late');
    expect((await until(late, (s) => s.phase === 'ended')).ended).toBe('full');
    let code = pairingCode();
    while (code === owner.snapshot.code) code = pairingCode();
    const lost = await joined(environment(), code, 'Lost');
    expect((await until(lost, (s) => s.phase === 'ended')).ended).toBe('not-found');
  });

  it('stops retrying when the server keeps refusing the handshake', async () => {
    // The operator allows fewer members than this page offers: every attempt is refused.
    const { environment } = await harness({ roomLimits: { maxMembers: 5 } });
    const room = track(
      Room.create(environment(), {
        name: 'Owner',
        settings: { join: 'auto', size: 10, send: 'everyone' },
      }),
    );
    await room.start();
    expect((await until(room, (s) => s.phase === 'ended', 20_000)).ended).toBe('failed');
  });

  it('lets the owner change settings, which members see', async () => {
    const { environment } = await harness();
    const owner = await created(environment());
    const member = await joined(environment(), owner.snapshot.code, 'Member');
    await until(member, inRoom(2));
    owner.updateSettings({ join: 'approve', size: 5, send: 'to-owner' });
    await until(member, (s) => s.settings?.send === 'to-owner' && s.settings.size === 5);
  });
});

describe('room transfers in the browser engine', { timeout: 90_000 }, () => {
  const bytes = (size: number, seed = 1) => {
    const data = new Uint8Array(size);
    let x = seed;
    for (let i = 0; i < size; i++) data[i] = (x = (x * 1103515245 + 12345) >>> 0) >>> 24;
    return data;
  };
  // Byte-exact comparison; deep equality on megabyte arrays is very slow.
  const same = (actual: Uint8Array | undefined, expected: Uint8Array) =>
    expect(!!actual && Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  const file = (name: string, data: Uint8Array) =>
    new File([data], name, { type: 'application/octet-stream' });
  async function room(
    members: number,
    settings = { join: 'auto', size: 10, send: 'everyone' } as const,
  ) {
    const { environment, mf } = await harness();
    // These tests answer every offer themselves: nothing is accepted automatically.
    const manual = () => Object.assign(environment(), { autoAcceptBytes: -1 });
    const envs = [manual()];
    const owner = await created(envs[0], settings);
    const rooms = [owner];
    for (let i = 1; i < members; i++) {
      envs.push(manual());
      rooms.push(await joined(envs[i], owner.snapshot.code, `Member ${i}`));
    }
    for (const r of rooms) await until(r, inRoom(members));
    return { mf, envs, rooms, environment };
  }
  const incoming = (r: Room) => r.snapshot.incoming[0];
  const outgoing = (r: Room) => r.snapshot.outgoing[0];
  const recipient = (r: Room, id: string) => outgoing(r)?.recipients.find((x) => x.id === id);
  const kinds = (env: TestEnvironment) => {
    const counts = { fanout: 0, targets: 0 };
    env.hooks.outgoing = (data) => {
      if (typeof data === 'string') return;
      const view = new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data));
      if (view[0] === 1) {
        counts.fanout++;
        counts.targets += view[1];
      }
    };
    return counts;
  };

  it('offers to two members; one accepts and gets exact bytes, one declines', async () => {
    const { envs, rooms } = await room(3);
    const [owner, a, b] = rooms;
    const data = bytes(1_300_000);
    const offerId = await owner.send([file('report.bin', data)], [a.snapshot.me, b.snapshot.me]);
    expect(offerId).toMatch(/^[0-9a-f]{32}$/);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    expect(incoming(a)).toMatchObject({
      from: owner.snapshot.me,
      fromName: 'Owner',
      total: data.length,
      files: [{ name: 'report.bin', size: data.length }],
    });
    b.decline(incoming(b).id);
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    same(envs[1].sinks[0].files.get(0), data);
    expect(incoming(a).saved.map((d) => d.name)).toEqual(['report.bin']);
    expect(incoming(a).transferred).toBe(data.length);
    await until(owner, (s) => recipient(owner, a.snapshot.me)?.status === 'complete');
    await until(owner, (s) => recipient(owner, b.snapshot.me)?.status === 'declined');
    expect(recipient(owner, a.snapshot.me)?.route).toBe('relay');
    // The declining member received no file data and never opened a destination.
    expect(envs[2].sinks).toHaveLength(0);
  });

  it('delivers several files including an empty one and an exact multiple of the piece size', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const files = [bytes(0), bytes(2 * PIECE_SIZE, 7), bytes(700_001, 9)];
    await owner.send(
      files.map((d, i) => file(`f${i}.bin`, d)),
      [a.snapshot.me],
    );
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    files.forEach((d, i) => expect(envs[1].sinks[0].files.get(i), `file ${i}`).toEqual(d));
    expect(incoming(a).saved).toHaveLength(3);
    expect(incoming(a).transferred).toBe(files.reduce((n, d) => n + d.length, 0));
  });

  it('fans relay pieces out so two recipients cost less than two uploads', async () => {
    const { envs, rooms } = await room(3);
    const [owner, a, b] = rooms;
    const counts = kinds(envs[0]);
    const data = bytes(8 * PIECE_SIZE + 123, 3);
    await owner.send([file('movie.bin', data)], [a.snapshot.me, b.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    await Promise.all([a.accept(incoming(a).id), b.accept(incoming(b).id)]);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    await until(b, (s) => s.incoming[0]?.status === 'complete');
    same(envs[1].sinks[0].files.get(0), data);
    same(envs[2].sinks[0].files.get(0), data);
    const pieces = 9;
    expect(counts.targets).toBeGreaterThanOrEqual(2 * pieces);
    expect(counts.fanout).toBeLessThan(2 * pieces);
  });

  it('rejects a tampered piece, asks again and still completes', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    let flipped = 0;
    envs[1].hooks.incoming = (data) => {
      if (flipped || !(data instanceof ArrayBuffer) || new Uint8Array(data)[0] !== 1) return data;
      flipped++;
      const copy = new Uint8Array(data.slice(0));
      copy[copy.length - 20] ^= 0xff;
      return copy.buffer;
    };
    const data = bytes(3 * PIECE_SIZE, 5);
    await owner.send([file('x.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete', 40_000);
    expect(flipped).toBe(1);
    same(envs[1].sinks[0].files.get(0), data);
  });

  it('ignores a duplicated piece and counts progress exactly once', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    let copy: ArrayBuffer | undefined;
    envs[1].hooks.incoming = (data) => {
      if (!copy && data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1) {
        copy = data.slice(0);
        const socket = envs[1].sockets.at(-1)!;
        setTimeout(() => socket.onmessage?.({ data: copy!.slice(0) }), 30);
      }
      return data;
    };
    const data = bytes(2 * PIECE_SIZE + 10, 11);
    await owner.send([file('d.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    expect(copy).toBeDefined();
    expect(incoming(a).transferred).toBe(data.length);
    expect(envs[1].sinks[0].writes).toBe(3);
    same(envs[1].sinks[0].files.get(0), data);
  });

  it('continues after the receiver’s connection drops mid-transfer', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    let dropped = false;
    envs[1].hooks.incoming = (data) => {
      if (!dropped && data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1) {
        dropped = true;
        envs[1].sockets.at(-1)!.drop();
        return undefined;
      }
      return data;
    };
    const data = bytes(6 * PIECE_SIZE + 5, 13);
    await owner.send([file('blip.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete', 8_000);
    expect(dropped).toBe(true);
    expect(envs[1].sockets.length).toBeGreaterThan(1);
    same(envs[1].sinks[0].files.get(0), data);
  });

  it('fails only the removed recipient’s delivery', async () => {
    const { envs, rooms } = await room(3);
    const [owner, a, b] = rooms;
    // Hold b's pieces so its delivery is still in progress when it is removed.
    envs[2].hooks.incoming = (data) =>
      data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1 ? undefined : data;
    const data = bytes(3 * PIECE_SIZE, 17);
    await owner.send([file('r.bin', data)], [a.snapshot.me, b.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    await b.accept(incoming(b).id);
    await until(owner, () => recipient(owner, b.snapshot.me)?.status === 'transferring');
    owner.remove(b.snapshot.me);
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    await until(owner, () => recipient(owner, b.snapshot.me)?.status === 'failed');
    // a's completion reaches the owner in its own message; wait for it, don't race it.
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'complete');
    expect((await until(b, (s) => s.phase === 'ended')).ended).toBe('removed');
    expect(envs[2].sinks[0].disposed).toBe(true);
  });

  it('shows a delivery failed once its only recipient has been offline for a minute', async () => {
    const { envs, rooms } = await room(2);
    const [owner, b] = rooms;
    // Hold b's pieces so its delivery is still in progress when its page closes.
    // With no other delivery active, nothing else refreshes the sender's view.
    envs[1].hooks.incoming = (data) =>
      data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1 ? undefined : data;
    const gone = b.snapshot.me;
    await owner.send([file('o.bin', bytes(3 * PIECE_SIZE, 5))], [gone]);
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    await b.accept(incoming(b).id);
    await until(owner, () => recipient(owner, gone)?.status === 'transferring');
    await b.dispose();
    await until(owner, (s) => s.members.find((m) => m.id === gone)?.online === false);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      await until(owner, () => recipient(owner, gone)?.status === 'failed');
    } finally {
      vi.useRealTimers();
    }
    expect(recipient(owner, gone)?.message).toBe('The recipient went offline.');
  });

  it('keeps the screen awake only while a transfer is moving', async () => {
    const { envs, rooms } = await room(2);
    const [owner, b] = rooms;
    await owner.send([file('w.bin', bytes(2 * PIECE_SIZE, 9))], [b.snapshot.me]);
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    // An unanswered offer is not a transfer yet.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(envs[0].awake).toEqual([]);
    expect(envs[1].awake).toEqual([]);
    await b.accept(incoming(b).id);
    await until(b, (s) => s.incoming[0]?.status === 'complete');
    await until(owner, () => recipient(owner, b.snapshot.me)?.status === 'complete');
    for (const env of envs) await expect.poll(() => env.awake).toEqual([true, false]);
  });

  it('still names people in offers after they leave the room', async () => {
    const { rooms } = await room(3);
    const [owner, a, b] = rooms;
    const leaver = a.snapshot.me;
    await owner.send([file('to-a.bin', bytes(1000))], [leaver]);
    await a.send([file('from-a.bin', bytes(1000, 3))], [b.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    await a.leave();
    await until(owner, () => recipient(owner, leaver)?.status === 'failed');
    await until(b, (s) => s.incoming[0]?.status === 'failed');
    expect(recipient(owner, leaver)?.name).toBe('Member 1');
    expect(incoming(b).fromName).toBe('Member 1');
  });

  it('keeps accepted deliveries when sending is restricted, and refuses new member offers', async () => {
    const { envs, rooms } = await room(3);
    const [owner, a, b] = rooms;
    let held: ArrayBuffer[] = [];
    let holding = true;
    envs[2].hooks.incoming = (data) => {
      if (holding && data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1) {
        held.push(data);
        return undefined;
      }
      return data;
    };
    const data = bytes(2 * PIECE_SIZE + 1, 19);
    await a.send([file('member.bin', data)], [b.snapshot.me]);
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    await b.accept(incoming(b).id);
    await until(a, () => recipient(a, b.snapshot.me)?.status === 'transferring');
    owner.updateSettings({ join: 'auto', size: 10, send: 'owner' });
    await until(b, (s) => s.settings?.send === 'owner');
    holding = false;
    const socket = envs[2].sockets.at(-1)!;
    for (const frame of held.splice(0)) socket.onmessage?.({ data: frame });
    await until(b, (s) => s.incoming[0]?.status === 'complete', 40_000);
    same(envs[2].sinks[0].files.get(0), data);
    await expect(a.send([file('late.bin', bytes(10))], [b.snapshot.me])).rejects.toThrow();
  });

  it('only lets members hand in to the owner in to-owner mode', async () => {
    const { rooms } = await room(3, { join: 'auto', size: 10, send: 'to-owner' });
    const [owner, a, b] = rooms;
    await expect(a.send([file('x.bin', bytes(5))], [b.snapshot.me])).rejects.toThrow();
    await a.send([file('homework.bin', bytes(5))], [owner.snapshot.me]);
    await until(owner, (s) => s.incoming[0]?.status === 'offered');
    await owner.send([file('handout.bin', bytes(5))], [a.snapshot.me, b.snapshot.me]);
    await until(b, (s) => s.incoming[0]?.status === 'offered');
  });

  it('fails the sender’s delivery when the recipient reloads mid-transfer', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    // Hold a's pieces so the delivery is still in progress when a reloads.
    envs[1].hooks.incoming = (data) =>
      data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1 ? undefined : data;
    await owner.send([file('big.bin', bytes(4 * PIECE_SIZE, 29))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'transferring');
    await a.dispose();
    envs[1].hooks.incoming = undefined;
    const reloaded = track((await Room.restore(envs[1]))!);
    await reloaded.start();
    await until(reloaded, inRoom(2));
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'failed');
    expect(recipient(owner, a.snapshot.me)?.message).toBe(
      'The recipient reloaded or closed the page.',
    );
    expect(reloaded.snapshot.incoming).toHaveLength(0);
  });

  it('fails the recipient’s offer when the sender reloads mid-transfer', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    envs[1].hooks.incoming = (data) =>
      data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1 ? undefined : data;
    await owner.send([file('big.bin', bytes(4 * PIECE_SIZE, 31))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'transferring');
    await owner.dispose();
    const back = track((await Room.restore(envs[0]))!);
    await back.start();
    await until(a, (s) => s.incoming[0]?.status === 'failed');
    expect(incoming(a).message).toBe('The sender stopped sending.');
    expect(envs[1].sinks[0].disposed).toBe(true);
  });

  it('switches to the relay at once when the other side cannot connect directly', async () => {
    const { environment } = await harness();
    // A browser whose WebRTC fails to start, on both sides.
    const broken = class {
      constructor() {
        throw new Error('Direct network unavailable');
      }
    } as unknown as typeof RTCPeerConnection;
    const envs = [environment(), environment()];
    for (const env of envs) Object.assign(env, { rtc: broken, autoAcceptBytes: -1 });
    const owner = await created(envs[0]);
    const other = await joined(envs[1], owner.snapshot.code, 'Other');
    await until(other, inRoom(2));
    // The higher member ID asks the lower one to open the connection; make it the sender.
    const [sender, receiver, receiverEnv] =
      owner.snapshot.me > other.snapshot.me ? [owner, other, envs[1]] : [other, owner, envs[0]];
    await sender.send([file('quick.bin', bytes(PIECE_SIZE + 3, 37))], [receiver.snapshot.me]);
    await until(receiver, (s) => s.incoming[0]?.status === 'offered');
    const started = Date.now();
    await receiver.accept(incoming(receiver).id);
    await until(receiver, (s) => s.incoming[0]?.status === 'complete');
    expect(Date.now() - started).toBeLessThan(3000);
    same(receiverEnv.sinks[0].files.get(0), bytes(PIECE_SIZE + 3, 37));
  });

  it('never fans a piece out again to a recipient that already got it', async () => {
    const { envs, rooms } = await room(3);
    const [owner, a, b] = rooms;
    envs[1].sinkDelay = 130; // a is a slower device, still receiving when b accepts
    const seen = new Map<string, number>();
    envs[1].hooks.incoming = (data) => {
      if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1) {
        const view = new DataView(data);
        const key = `${view.getUint16(17 + 17)}:${view.getUint32(17 + 19)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      return data;
    };
    const pieces = 50;
    const data = bytes(pieces * PIECE_SIZE, 41);
    await owner.send([file('stagger.bin', data)], [a.snapshot.me, b.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await until(b, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    // b accepts more than 5 s after a received the first pieces.
    await until(a, (s) => (s.incoming[0]?.transferred ?? 0) >= 42 * PIECE_SIZE, 20_000);
    await b.accept(incoming(b).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete', 30_000);
    await until(b, (s) => s.incoming[0]?.status === 'complete', 30_000);
    same(envs[1].sinks[0].files.get(0), data);
    same(envs[2].sinks[0].files.get(0), data);
    expect(seen.size).toBe(pieces);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it('delivers after Accept is pressed while the connection is down', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const data = bytes(PIECE_SIZE + 9, 43);
    await owner.send([file('late.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    envs[1].sockets.at(-1)!.drop();
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete', 15_000);
    same(envs[1].sinks[0].files.get(0), data);
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'complete');
  });

  it('recovers when the content key is lost on the way', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const data = bytes(PIECE_SIZE + 11, 47);
    await owner.send([file('key.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    let dropped = 0;
    // The first link frame after accepting is the key: lose it.
    envs[1].hooks.incoming = (frame) => {
      if (!dropped && frame instanceof ArrayBuffer && new Uint8Array(frame)[0] === 0) {
        dropped++;
        return undefined;
      }
      return frame;
    };
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete', 15_000);
    expect(dropped).toBe(1);
    same(envs[1].sinks[0].files.get(0), data);
  });

  it('recovers when the completion notice is lost on the way', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const data = bytes(2 * PIECE_SIZE, 53);
    await owner.send([file('done.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    let dropped = 0;
    // After the last piece is written, the next link frame a sends is "done": lose it.
    envs[1].hooks.outgoing = (frame) => {
      if (
        !dropped &&
        typeof frame !== 'string' &&
        new Uint8Array(frame as ArrayBuffer)[0] === 0 &&
        envs[1].sinks[0]?.writes === 2
      ) {
        dropped++;
        return false;
      }
    };
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'complete', 15_000);
    expect(dropped).toBe(1);
  });

  it('returns relay credit in batches rather than one message per piece', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    let drains = 0;
    envs[1].hooks.outgoing = (frame) => {
      if (typeof frame === 'string' && frame.includes('"type":"drain"')) drains++;
    };
    const pieces = 16;
    await owner.send([file('batch.bin', bytes(pieces * PIECE_SIZE, 59))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    // Each drain is a billed message: well under one per relayed piece.
    expect(drains).toBeGreaterThan(0);
    expect(drains).toBeLessThanOrEqual(pieces / 2);
  });

  it('stops rather than encrypt different bytes when a file changes after checking', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const original = bytes(2 * PIECE_SIZE, 61);
    // A file whose contents change on disk after "Checking files…" finished.
    class ChangingFile extends File {
      reads = 0;
      slice(start?: number, end?: number, type?: string): Blob {
        const piece = super.slice(start, end, type);
        return ++this.reads > 2 ? new Blob([new Uint8Array(piece.size).fill(0xee)]) : piece;
      }
    }
    const changing = new ChangingFile([original], 'changing.bin');
    let pieces = 0;
    envs[1].hooks.incoming = (frame) => {
      if (frame instanceof ArrayBuffer && new Uint8Array(frame)[0] === 1) pieces++;
      return frame;
    };
    await owner.send([changing], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'failed');
    expect(recipient(owner, a.snapshot.me)?.message).toBe(
      'A file changed after it was checked. Send it again.',
    );
    await until(a, (s) => s.incoming[0]?.status === 'cancelled');
    expect(pieces).toBe(0);
  });

  it('stops a delivery when the sender cancels and discards partial data', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    envs[1].hooks.incoming = (data) =>
      data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1 ? undefined : data;
    await owner.send([file('big.bin', bytes(4 * PIECE_SIZE, 23))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'transferring');
    owner.cancelOutgoing(outgoing(owner).id);
    await until(a, (s) => s.incoming[0]?.status === 'cancelled');
    expect(envs[1].sinks[0].disposed).toBe(true);
    expect(recipient(owner, a.snapshot.me)?.status).toBe('cancelled');
  });

  it('accepts a send at or below the limit by itself and keeps it without downloading', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    envs[1].autoAcceptBytes = 4;
    const id = await owner.send([file('small.bin', bytes(4))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    // Named for this member too: tabs of one browser share its storage.
    const folder = `widesend-room-${id}-${a.snapshot.me}`;
    expect(incoming(a).folder).toBe(folder);
    expect(envs[1].sinks.map((sink) => sink.folder)).toEqual([folder]);
    expect(incoming(a).saved.map((f) => f.name)).toEqual(['small.bin']);
    await until(owner, () => recipient(owner, a.snapshot.me)?.status === 'complete');
  });

  it('asks before accepting a send above the limit', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    envs[1].autoAcceptBytes = 4;
    await owner.send([file('big.bin', bytes(5))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(incoming(a).status).toBe('offered');
    expect(envs[1].sinks).toHaveLength(0);
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
  });

  it('keeps an offer to someone who is away and delivers it when they return', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    envs[1].autoAcceptBytes = undefined;
    const away = a.snapshot.me;
    await a.dispose();
    await until(owner, (s) => s.members.find((m) => m.id === away)?.online === false);
    const data = bytes(PIECE_SIZE + 5, 67);
    await owner.send([file('later.bin', data)], [away]);
    // Longer than both the old ten-minute offer expiry and the one-minute offline limit.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(recipient(owner, away)?.status).toBe('offered');
    } finally {
      vi.useRealTimers();
    }
    const back = track((await Room.restore(envs[1]))!);
    await back.start();
    await until(back, (s) => s.incoming[0]?.status === 'complete', 20_000);
    same(envs[1].sinks.at(-1)!.files.get(0), data);
    await until(owner, () => recipient(owner, away)?.status === 'complete');
  });

  it('completes a send accepted while the sender was away, once the sender is back', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const data = bytes(PIECE_SIZE + 7, 71);
    await owner.send([file('patient.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    envs[0].offline();
    await until(a, (s) => s.members.find((m) => m.owner)?.online === false);
    await a.accept(incoming(a).id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(incoming(a).status).toBe('accepted');
    } finally {
      vi.useRealTimers();
    }
    envs[0].online();
    await until(a, (s) => s.incoming[0]?.status === 'complete', 20_000);
    same(envs[1].sinks[0].files.get(0), data);
  });

  it('lets the screen sleep while an accepted send waits for a sender who is away', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    await owner.send([file('wait.bin', bytes(PIECE_SIZE + 3, 73))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    envs[0].offline();
    await until(a, (s) => s.members.find((m) => m.owner)?.online === false);
    await a.accept(incoming(a).id);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(incoming(a).status).toBe('accepted');
    expect(envs[1].awake.at(-1) ?? false).toBe(false);
  });

  it('does not redraw every second while a send only waits for an answer', async () => {
    const { rooms } = await room(2);
    const [owner, a] = rooms;
    await owner.send([file('ask.bin', bytes(10, 79))], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await new Promise((resolve) => setTimeout(resolve, 500));
    let updates = 0;
    const stop = [owner.subscribe(() => updates++), a.subscribe(() => updates++)];
    await new Promise((resolve) => setTimeout(resolve, 3500));
    stop.forEach((unsubscribe) => unsubscribe());
    expect(updates).toBeLessThan(3);
  });

  it('closes a finished send’s storage but keeps its files', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const data = bytes(1000, 83);
    await owner.send([file('done.bin', data)], [a.snapshot.me]);
    await until(a, (s) => s.incoming[0]?.status === 'offered');
    await a.accept(incoming(a).id);
    await until(a, (s) => s.incoming[0]?.status === 'complete');
    await expect.poll(() => envs[1].sinks[0].disposed).toBe(true);
    same(envs[1].sinks[0].files.get(0), data);
  });
});

describe('room conversations', { timeout: 120_000 }, () => {
  async function room(
    members: number,
    settings = { join: 'auto', size: 10, send: 'everyone' } as const,
  ) {
    const { environment, db } = await harness();
    const envs = [environment()];
    const owner = await created(envs[0], settings);
    const rooms = [owner];
    for (let i = 1; i < members; i++) {
      envs.push(environment());
      rooms.push(await joined(envs[i], owner.snapshot.code, `Member ${i}`));
    }
    for (const r of rooms) await until(r, inRoom(members));
    return { db, envs, rooms };
  }
  const entry = (r: Room, id: string) => r.snapshot.timeline.find((e) => e.id === id);
  const status = (r: Room, id: string, to: string) =>
    entry(r, id)?.deliveries.find((d) => d.id === to)?.status;
  const awayFrom = (r: Room, id: string) =>
    until(r, (s) => s.members.find((m) => m.id === id)?.online === false);
  // Unicast frames carry link messages; dropping them loses messages and answers.
  const linkFrame = (frame: string | ArrayBuffer | Uint8Array) =>
    typeof frame !== 'string' && new Uint8Array(frame as ArrayBuffer)[0] === 0;

  it('delivers a text to two members once and shows it delivered', async () => {
    const { rooms } = await room(3);
    const [owner, a, b] = rooms;
    const to = [a.snapshot.me, b.snapshot.me];
    const id = await owner.sendMessage('  hello there\nsecond line  ', to);
    for (const r of [a, b]) {
      await until(r, (s) => s.timeline.some((e) => e.id === id));
      expect(r.snapshot.timeline).toEqual([
        expect.objectContaining({
          id,
          kind: 'text',
          text: 'hello there\nsecond line',
          mine: false,
          from: owner.snapshot.me,
          fromName: 'Owner',
          to,
        }),
      ]);
    }
    await until(owner, () => to.every((m) => status(owner, id, m) === 'delivered'));
    expect(entry(owner, id)).toMatchObject({ mine: true, text: 'hello there\nsecond line' });
  });

  it('refuses empty and over-long messages and recipients the room does not allow', async () => {
    const { rooms } = await room(2);
    const [owner, a] = rooms;
    await expect(owner.sendMessage(' \n ', [a.snapshot.me])).rejects.toThrow(
      'Write a message first.',
    );
    await expect(owner.sendMessage('x'.repeat(10_001), [a.snapshot.me])).rejects.toThrow(
      'Messages can be up to 10,000 characters.',
    );
    await expect(owner.sendMessage('hi', ['f'.repeat(32)])).rejects.toThrow(
      'This room does not allow sending to the selected members.',
    );
    expect(owner.snapshot.timeline).toEqual([]);
  });

  it('shows a message once even when its acknowledgement is lost', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const first = await owner.sendMessage('warm up', [a.snapshot.me]);
    await until(owner, () => status(owner, first, a.snapshot.me) === 'delivered');
    // a hears the next message but its acknowledgements are lost for a while.
    let lost = 0;
    envs[1].hooks.outgoing = (frame) => {
      if (linkFrame(frame) && lost < 2) {
        lost++;
        return false;
      }
    };
    const id = await owner.sendMessage('say it again', [a.snapshot.me]);
    await until(owner, () => status(owner, id, a.snapshot.me) === 'delivered', 30_000);
    expect(lost).toBe(2);
    expect(a.snapshot.timeline.filter((e) => e.id === id)).toHaveLength(1);
  });

  it('keeps a message for someone who is away and delivers it when they return', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const away = a.snapshot.me;
    await a.dispose();
    await awayFrom(owner, away);
    const id = await owner.sendMessage('see you later', [away]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(entry(owner, id)?.deliveries).toEqual([
      { id: away, name: 'Member 1', status: 'sending', online: false },
    ]);
    const back = track((await Room.restore(envs[1]))!);
    await back.start();
    await until(back, (s) => s.timeline.some((e) => e.id === id && e.text === 'see you later'));
    await until(owner, () => status(owner, id, away) === 'delivered');
  });

  it('delivers a pending message after the sender reloads, but not its unfinished file', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const away = a.snapshot.me;
    await a.dispose();
    await awayFrom(owner, away);
    const id = await owner.sendMessage('written before reloading', [away]);
    const fileId = await owner.send([new File(['abc'], 'gone.txt')], [away]);
    await owner.dispose();
    const reloaded = track((await Room.restore(envs[0]))!);
    await reloaded.start();
    await until(reloaded, (s) => !!entry(reloaded, id) && !!entry(reloaded, fileId));
    expect(status(reloaded, fileId, away)).toBe('failed');
    const back = track((await Room.restore(envs[1]))!);
    await back.start();
    await until(back, (s) => s.timeline.some((e) => e.id === id));
    await until(reloaded, () => status(reloaded, id, away) === 'delivered');
    expect(back.snapshot.timeline.map((e) => e.id)).toEqual([id]);
  });

  it('refuses a message the room no longer allows when it arrives', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const first = await a.sendMessage('warm up', [owner.snapshot.me]);
    await until(a, () => status(a, first, owner.snapshot.me) === 'delivered');
    // a's next message is held up until the owner has made the room owner-only.
    let holding = true;
    envs[1].hooks.outgoing = (frame) => (holding && linkFrame(frame) ? false : undefined);
    const id = await a.sendMessage('too late', [owner.snapshot.me]);
    owner.updateSettings({ join: 'auto', size: 10, send: 'owner' });
    await until(a, (s) => s.settings?.send === 'owner');
    holding = false;
    await until(a, () => status(a, id, owner.snapshot.me) === 'refused', 20_000);
    expect(entry(owner, id)).toBeUndefined();
  });

  it('follows the room’s rule on who can send', async () => {
    const owners = await room(3, { join: 'auto', size: 10, send: 'owner' });
    const [owner, a, b] = owners.rooms;
    await expect(a.sendMessage('hi', [owner.snapshot.me])).rejects.toThrow();
    await owner.sendMessage('handout', [a.snapshot.me, b.snapshot.me]);
    const handIn = await room(3, { join: 'auto', size: 10, send: 'to-owner' });
    const [teacher, c, d] = handIn.rooms;
    await expect(c.sendMessage('psst', [d.snapshot.me])).rejects.toThrow();
    const id = await c.sendMessage('homework', [teacher.snapshot.me]);
    await until(teacher, () => !!entry(teacher, id));
  });

  it('keeps history: texts, kept files, the end of the room, and deletion', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const textId = await owner.sendMessage('notes', [a.snapshot.me]);
    const image = new File([new Uint8Array([1, 2, 3, 4, 5])], 'pic.png', { type: 'image/png' });
    const fileId = await owner.send([image], [a.snapshot.me]);
    await until(a, () => entry(a, fileId)?.status === 'complete');
    await until(a, () => entry(a, fileId)?.kept[0]?.url !== undefined);
    const locator = a.snapshot.locator;
    const items = await envs[1].history.items(locator);
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      [textId, 'text'],
      [fileId, 'files'],
    ]);
    expect(items[1]).toMatchObject({
      folder: `widesend-room-${fileId}-${a.snapshot.me}`,
      kept: [0],
      status: 'complete',
    });
    // The sender keeps its own image too.
    await until(owner, () => entry(owner, fileId)?.kept.length === 1);
    await expect
      .poll(async () => (await envs[0].history.items(locator)).find((i) => i.id === fileId))
      .toMatchObject({
        folder: `widesend-room-${fileId}-${owner.snapshot.me}`,
        kept: [0],
        sent: { [a.snapshot.me]: 'complete' },
      });
    await owner.dismiss();
    await until(a, (s) => s.phase === 'ended');
    await expect.poll(async () => (await envs[1].history.room(locator))?.ended).toBe('dismissed');
    const past = (await pastTimeline(envs[1].history, locator))!;
    expect(past.room.names[owner.snapshot.me]).toBe('Owner');
    expect(past.entries.map((e) => [e.id, e.fromName])).toEqual([
      [textId, 'Owner'],
      [fileId, 'Owner'],
    ]);
    expect(past.entries[1].kept).toEqual([
      expect.objectContaining({ id: 0, name: 'pic.png', url: expect.any(String) }),
    ]);
    past.release();
    await envs[1].history.deleteRoom(locator);
    expect(await envs[1].history.items(locator)).toEqual([]);
    expect(envs[1].history.deleted).toEqual([`widesend-room-${fileId}-${a.snapshot.me}`]);
  });

  it('reports message totals to the activity log at most every 30 seconds', async () => {
    const { db, rooms } = await room(2);
    const [owner, a] = rooms;
    const totals = () =>
      db
        .prepare('SELECT message_count, message_bytes FROM share_members WHERE member_id=?')
        .bind(owner.snapshot.me)
        .first();
    await owner.sendMessage('héllo', [a.snapshot.me]);
    await expect.poll(totals).toEqual({ message_count: 1, message_bytes: 6 });
    await owner.sendMessage('again', [a.snapshot.me]);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await totals()).toEqual({ message_count: 1, message_bytes: 6 });
  });

  it('fails a waiting message once its recipient has left, even after the sender reloads', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const away = a.snapshot.me;
    await a.dispose();
    await awayFrom(owner, away);
    const id = await owner.sendMessage('you won’t get this', [away]);
    await owner.dispose();
    // The recipient comes back only to leave, while the sender's page is closed.
    const back = track((await Room.restore(envs[1]))!);
    await back.start();
    await until(back, (s) => s.phase === 'in-room');
    await back.leave();
    await until(back, (s) => s.phase === 'ended');
    const reloaded = track((await Room.restore(envs[0]))!);
    await reloaded.start();
    await until(reloaded, (s) => s.phase === 'in-room' && !!entry(reloaded, id));
    await until(reloaded, () => status(reloaded, id, away) === 'failed');
  });

  it('keeps my earlier messages mine after I leave and join the same room again', async () => {
    const { envs, rooms } = await room(2);
    const [owner, a] = rooms;
    const id = await a.sendMessage('before I left', [owner.snapshot.me]);
    await until(a, () => status(a, id, owner.snapshot.me) === 'delivered');
    const reply = await owner.sendMessage('see you', [a.snapshot.me]);
    await until(a, () => !!entry(a, reply));
    await a.leave();
    await until(a, (s) => s.phase === 'ended');
    const again = await joined(envs[1], owner.snapshot.code, 'Member 1');
    await until(again, inRoom(2));
    await until(again, () => !!entry(again, id));
    expect(entry(again, id)).toMatchObject({ mine: true, from: again.snapshot.me });
    expect(entry(again, reply)).toMatchObject({ mine: false, to: [again.snapshot.me] });
    expect((await envs[1].history.room(again.snapshot.locator))?.me).toBe(again.snapshot.me);
  });
});
