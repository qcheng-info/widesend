import { afterEach, describe, expect, it } from 'vitest';
import type { Miniflare } from 'miniflare';
import { pairingCode, roomId, token } from '../../src/crypto';
import { ORIGIN, shareRuntime } from '../fixtures/share-runtime';
import { PAKE_SUITE } from '../../shared/key-exchange';

// Several receivers of one Send-files code, through the real Worker and TransferRoom.
const runtimes: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((mf) => mf.dispose()));
});
async function runtime() {
  const result = await shareRuntime();
  runtimes.push(result.mf);
  return result;
}
type Offer = { code: string; room: string; owner: string; expires: number; pairExpires: number };
async function offer(): Promise<Offer> {
  const code = pairingCode();
  return {
    code,
    room: await roomId(code),
    owner: token(32),
    expires: Date.now() + 86_399_000,
    pairExpires: Date.now() + 1_199_000,
  };
}
async function open(mf: Miniflare, o: Offer, hello: Record<string, unknown>) {
  const auth = Buffer.from(JSON.stringify({ code: o.code, ...hello })).toString('base64url');
  const response = await mf.dispatchFetch(`${ORIGIN}/api/rooms/${o.room}`, {
    headers: {
      Origin: ORIGIN,
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `widesend, ${auth}`,
      'CF-Connecting-IP': '192.0.2.1',
    },
  });
  const socket = response.webSocket;
  const messages: any[] = [];
  const frames: ArrayBuffer[] = [];
  let closeCode: number | undefined;
  socket?.addEventListener('message', (event) => {
    if (typeof event.data === 'string') messages.push(JSON.parse(event.data));
    else frames.push(event.data as ArrayBuffer);
  });
  socket?.addEventListener('close', (event) => {
    closeCode = event.code;
  });
  socket?.accept();
  return {
    response,
    socket: socket!,
    messages,
    frames,
    credential: hello.credential as string,
    closeCode: () => closeCode,
    async notice(type: string) {
      await expect.poll(() => messages.find((m) => m.type === type)).toBeDefined();
      return messages.find((m) => m.type === type);
    },
  };
}
const sender = (mf: Miniflare, o: Offer, uses: number, slot: number) =>
  open(mf, o, {
    role: 'send',
    credential: o.owner,
    expires: o.expires,
    pairExpires: o.pairExpires,
    ...(uses > 1 ? { uses, slot } : {}),
  });
const receiver = (mf: Miniflare, o: Offer) =>
  open(mf, o, { role: 'receive', credential: token(32) });

describe('several receivers of one code', () => {
  it('gives each receiver its own slot and keeps frames within it', async () => {
    const { mf } = await runtime();
    const o = await offer();
    const s0 = await sender(mf, o, 3, 0);
    await s0.notice('connected');
    const r0 = await receiver(mf, o);
    await r0.notice('peer-online');
    // The second receiver arrives before the sender opened slot 1, then pairs.
    const r1 = await receiver(mf, o);
    await r1.notice('connected');
    const s1 = await sender(mf, o, 3, 1);
    expect((await s1.notice('connected')).receiver).toBe(r1.credential);
    await s1.notice('peer-online');
    await r1.notice('peer-online');
    s1.socket.send(new Uint8Array(64));
    await expect.poll(() => r1.frames.length).toBe(1);
    s0.socket.send(new Uint8Array(48));
    await expect.poll(() => r0.frames.length).toBe(1);
    expect(r0.frames[0].byteLength).toBe(48);
    expect(r1.frames).toHaveLength(1);
    expect(r1.frames[0].byteLength).toBe(64);
  });
  it('tells a receiver at once when every use is taken', async () => {
    const { mf } = await runtime();
    const o = await offer();
    await (await sender(mf, o, 2, 0)).notice('connected');
    await (await receiver(mf, o)).notice('connected');
    await (await receiver(mf, o)).notice('connected');
    const late = await receiver(mf, o);
    await expect.poll(() => late.closeCode()).toBe(4005);
  });
  it('tells a second receiver of a one-receiver code at once', async () => {
    const { mf } = await runtime();
    const o = await offer();
    await (await sender(mf, o, 1, 0)).notice('connected');
    await (await receiver(mf, o)).notice('connected');
    const late = await receiver(mf, o);
    await expect.poll(() => late.closeCode()).toBe(4005);
  });
  it('lets a receiver return to its own slot', async () => {
    const { mf } = await runtime();
    const o = await offer();
    await sender(mf, o, 2, 0);
    const first = await receiver(mf, o);
    await first.notice('connected');
    const second = await receiver(mf, o);
    await second.notice('connected');
    const s1 = await sender(mf, o, 2, 1);
    await s1.notice('peer-online');
    second.socket.close(1000);
    const back = await open(mf, o, { role: 'receive', credential: second.credential });
    await back.notice('peer-online');
    s1.socket.send(new Uint8Array(30));
    await expect.poll(() => back.frames.length).toBe(1);
  });
  it('ends one receiver without ending the others', async () => {
    const { mf } = await runtime();
    const o = await offer();
    const s0 = await sender(mf, o, 2, 0);
    const r0 = await receiver(mf, o);
    await r0.notice('peer-online');
    const s1 = await sender(mf, o, 2, 1);
    const r1 = await receiver(mf, o);
    await r1.notice('peer-online');
    r0.socket.send(JSON.stringify({ type: 'end' }));
    await expect.poll(() => r0.closeCode()).toBe(4004);
    s1.socket.send(new Uint8Array(40));
    await expect.poll(() => r1.frames.length).toBe(1);
    expect(s1.closeCode()).toBeUndefined();
    // The ended slot stays ended for both of its devices. (Miniflare doesn't deliver
    // a close the server makes from another socket's handler; browsers test that live.)
    const again = await open(mf, o, { role: 'receive', credential: r0.credential });
    await expect.poll(() => again.closeCode()).toBe(4004);
    const sender0 = await sender(mf, o, 2, 0);
    await expect.poll(() => sender0.closeCode()).toBe(4004);
    expect(s0.frames).toHaveLength(0);
  });
  it('seals the unclaimed uses when the sender stops sharing', async () => {
    const { mf } = await runtime();
    const o = await offer();
    const s0 = await sender(mf, o, 3, 0);
    await (await receiver(mf, o)).notice('peer-online');
    const s1 = await sender(mf, o, 3, 1);
    await s1.notice('connected');
    s0.socket.send(JSON.stringify({ type: 'seal' }));
    await s0.notice('sealed');
    expect(s0.closeCode()).toBeUndefined();
    const late = await receiver(mf, o);
    await expect.poll(() => late.closeCode()).toBe(4005);
    // The waiting slot is ended: its sender can't reopen it.
    const reopened = await sender(mf, o, 3, 1);
    await expect.poll(() => reopened.closeCode()).toBe(4004);
    expect(s1.frames).toHaveLength(0);
  });
  it('refuses sealing from a receiver', async () => {
    const { mf } = await runtime();
    const o = await offer();
    await (await sender(mf, o, 2, 0)).notice('connected');
    const r = await receiver(mf, o);
    await r.notice('connected');
    r.socket.send(JSON.stringify({ type: 'seal' }));
    await expect.poll(() => r.closeCode()).toBe(4002);
  });
  it('refuses a sender slot beyond the code’s uses', async () => {
    const { mf } = await runtime();
    const o = await offer();
    await (await sender(mf, o, 2, 0)).notice('connected');
    const beyond = await open(mf, o, {
      role: 'send',
      credential: o.owner,
      expires: o.expires,
      pairExpires: o.pairExpires,
      uses: 3,
      slot: 2,
    });
    expect(beyond.response.status).toBe(400);
  });
  it('records each receiver as its own transfer row with the shared code', async () => {
    const { mf, db } = await runtime();
    const o = await offer();
    await (await sender(mf, o, 2, 0)).notice('connected');
    await (await receiver(mf, o)).notice('connected');
    await (await sender(mf, o, 2, 1)).notice('connected');
    await expect
      .poll(
        async () =>
          (await db.prepare('SELECT code,slot,uses FROM transfers ORDER BY slot').all()).results,
      )
      .toEqual([
        { code: o.code, slot: 0, uses: 2 },
        { code: o.code, slot: 1, uses: 2 },
      ]);
  });
});

describe('frames across a re-pairing', () => {
  it('drops frames a device sends before its key exchange in the current round', async () => {
    const { mf } = await runtime();
    const o = await offer();
    const s = await open(mf, o, {
      role: 'send',
      credential: o.owner,
      expires: o.expires,
      pairExpires: o.pairExpires,
      keyExchange: 2,
    });
    const r = await open(mf, o, { role: 'receive', credential: token(32), keyExchange: 2 });
    const { round } = await r.notice('peer-online');
    // A frame still encrypted for the previous pairing arrives first: never forwarded.
    r.socket.send(new Uint8Array(69));
    const share = {
      type: 'key-exchange',
      step: 'share',
      round,
      suite: PAKE_SUITE,
      point: '04' + '00'.repeat(64),
      identity: '04' + '11'.repeat(64),
    };
    r.socket.send(JSON.stringify(share));
    r.socket.send(
      JSON.stringify({
        type: 'key-exchange',
        step: 'confirm',
        round,
        mac: '22'.repeat(32),
        signature: '33'.repeat(64),
      }),
    );
    await expect.poll(() => s.messages.filter((m) => m.type === 'key-exchange').length).toBe(2);
    r.socket.send(new Uint8Array(70));
    await expect.poll(() => s.frames.length).toBe(1);
    expect(s.frames[0].byteLength).toBe(70);
  });
});
