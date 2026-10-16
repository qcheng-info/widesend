import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { token, pairingCode, roomId } from '../../src/crypto';
import type { Limits } from '../../worker/abuse-store';
import { relayFrame, utcDay } from '../../shared/relay';
import { PAKE_SUITE } from '../../shared/key-exchange';

let script: string;
const runtimes: Miniflare[] = [];
beforeAll(async () => {
  script = (
    await build({
      entryPoints: ['worker/index.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      external: ['cloudflare:workers'],
    })
  ).outputFiles[0].text;
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((mf) => mf.dispose()));
});
async function runtime(limits: Partial<Limits> = {}, edgeLimit = 120) {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-09-01',
      script,
      scriptPath: resolve('worker/test-bundle.js'),
      durableObjects: {
        ROOMS: { className: 'TransferRoom', useSQLite: true },
        GUARD: { className: 'AbuseGuard', useSQLite: true },
      },
      bindings: { ABUSE_LIMITS: limits },
      ratelimits: {
        NETWORK_RATE: { namespace_id: '1001', simple: { limit: edgeLimit, period: 60 } },
        SITE_RATE: { namespace_id: '1002', simple: { limit: 1200, period: 60 } },
      },
      serviceBindings: { ASSETS: () => new Response('website') },
      d1Databases: ['ACTIVITY'],
    }),
  );
  runtimes.push(mf);
  const db = await mf.getD1Database('ACTIVITY');
  for (const file of (await readdir(new URL('../../migrations', import.meta.url))).sort()) {
    const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
    await db.batch(
      sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => db.prepare(s)),
    );
  }
  return { mf, db };
}
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
async function connect(
  mf: Miniflare,
  invitation: Awaited<ReturnType<typeof invitation>>,
  ip = '192.0.2.1',
  extraHeaders = {},
) {
  const auth = Buffer.from(JSON.stringify(invitation.hello)).toString('base64url');
  const response = await mf.dispatchFetch(`https://widesend.test/api/rooms/${invitation.room}`, {
    headers: {
      Origin: 'https://widesend.test',
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `widesend, ${auth}`,
      'CF-Connecting-IP': ip,
      ...extraHeaders,
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
    socket,
    messages,
    frames,
    closeCode: () => closeCode,
    async notice(type: string) {
      await expect.poll(() => messages.find((m) => m.type === type)).toBeDefined();
      return messages.find((m) => m.type === type);
    },
  };
}
describe('public Worker admission', () => {
  it('bounds key exchange messages to a fresh pairing round and two messages per device', async () => {
    const { mf } = await runtime();
    const offered = await invitation();
    const modern = { ...offered, hello: { ...offered.hello, keyExchange: 2 } };
    const sender = await connect(mf, modern);
    expect((await sender.notice('connected')).keyExchange).toBe(2);
    const receiver = await connect(mf, {
      ...modern,
      hello: { ...modern.hello, role: 'receive', credential: token(32) },
    });
    const { round } = await sender.notice('peer-online');
    expect((await receiver.notice('peer-online')).round).toBe(round);
    const share = {
      type: 'key-exchange',
      step: 'share',
      round,
      suite: PAKE_SUITE,
      point: '04' + '00'.repeat(64),
      identity: '04' + '11'.repeat(64),
    };
    sender.socket!.send(JSON.stringify({ ...share, round: crypto.randomUUID() }));
    sender.socket!.send(JSON.stringify(share));
    expect(await receiver.notice('key-exchange')).toEqual(share);
    sender.socket!.send(
      JSON.stringify({
        type: 'key-exchange',
        step: 'confirm',
        round,
        mac: '22'.repeat(32),
        signature: '33'.repeat(64),
      }),
    );
    await expect
      .poll(() => receiver.messages.filter((m) => m.type === 'key-exchange').length)
      .toBe(2);
    sender.socket!.send(JSON.stringify(share));
    await expect.poll(() => sender.closeCode()).toBe(4002);
    expect(receiver.messages.filter((m) => m.type === 'key-exchange')).toHaveLength(2);
    receiver.socket!.close();
  });
  it('advertises a legacy peer and never bridges mixed encryption versions', async () => {
    const { mf } = await runtime();
    const offered = await invitation();
    const sender = await connect(mf, {
      ...offered,
      hello: { ...offered.hello, keyExchange: 2, relayPolicy: 1 },
    });
    const receiver = await connect(mf, {
      ...offered,
      hello: { ...offered.hello, role: 'receive', credential: token(32), relayPolicy: 1 },
    });
    expect((await sender.notice('peer-online')).keyExchange).toBeUndefined();
    expect((await receiver.notice('peer-online')).keyExchange).toBe(2);
    sender.socket!.send(relayFrame(new Uint8Array(100).buffer, false));
    receiver.socket!.send(relayFrame(new Uint8Array(100).buffer, false));
    // A later handled message proves both preceding binary handlers ran.
    for (const s of [sender, receiver]) {
      s.socket!.send(JSON.stringify({ type: 'relay-request' }));
      await s.notice('relay-admitted');
      expect(s.frames).toHaveLength(0);
    }
    sender.socket!.close();
    receiver.socket!.close();
  });
  it('does not pre-approve an unpaired invitation for relay', async () => {
    const { mf } = await runtime();
    const offered = await invitation();
    const sender = await connect(mf, { ...offered, hello: { ...offered.hello, relayPolicy: 1 } });
    await sender.notice('connected');
    sender.socket!.send(JSON.stringify({ type: 'relay-request' }));
    await sender.notice('peer-offline');
    const ns = await mf.getDurableObjectNamespace('GUARD');
    const health = await (ns.get(ns.idFromName('public-admission')) as any).health();
    expect(health.relay.daily[6].admitted).toBe(0);
    sender.socket!.close();
  });
  it('declines new relay data at budget while allowing direct signaling and an admitted reconnect', async () => {
    const { mf } = await runtime();
    const first = await invitation();
    const original = { ...first, hello: { ...first.hello, relayPolicy: 1 } };
    const sender = await connect(mf, original);
    await sender.notice('connected');
    const receiver = await connect(mf, {
      ...original,
      hello: { ...original.hello, role: 'receive', credential: token(32) },
    });
    await receiver.notice('connected');
    sender.socket!.send(JSON.stringify({ type: 'relay-request' }));
    await sender.notice('relay-admitted');
    const ns = await mf.getDurableObjectNamespace('GUARD');
    const guard = ns.get(ns.idFromName('public-admission')) as any;
    const day = utcDay(Date.now());
    await guard.recordUsage('seed', [{ day, messages: 800000, bytes: 0 }]);
    const next = await invitation();
    // Reusing a browser credential in a different room must not reuse that
    // room's relay approval (the credential is caller-generated).
    const offered = {
      ...next,
      hello: { ...next.hello, credential: original.hello.credential, relayPolicy: 1 },
    };
    const newer = await connect(mf, offered);
    await newer.notice('connected');
    const peer = await connect(mf, {
      ...offered,
      hello: { ...offered.hello, role: 'receive', credential: token(32) },
    });
    await peer.notice('connected');
    newer.socket!.send(JSON.stringify({ type: 'relay-request' }));
    expect((await newer.notice('relay-limited')).retryAfter).toBeGreaterThan(0);
    expect(newer.closeCode()).toBeUndefined();
    const cipher = new Uint8Array(100).fill(7).buffer;
    // The Worker cannot decrypt these frames, but it must enforce the file
    // envelope itself, rather than trusting a browser's disabled Send button.
    newer.socket!.send(relayFrame(cipher, true));
    newer.socket!.send(relayFrame(cipher, false));
    await expect.poll(() => peer.frames.length).toBe(1);
    expect(new Uint8Array(peer.frames[0])).toEqual(new Uint8Array(cipher));
    // Mislabelled file traffic cannot use an unlimited control allowance.
    for (let i = 0; i < 4; i++)
      newer.socket!.send(relayFrame(new Uint8Array(256 * 1024).buffer, false));
    await expect.poll(() => peer.frames.length).toBe(4);
    const restored = await connect(mf, original);
    await restored.notice('connected');
    restored.socket!.send(JSON.stringify({ type: 'relay-request' }));
    await restored.notice('relay-admitted');
    restored.socket!.send(relayFrame(cipher, true));
    await expect.poll(() => receiver.frames.length).toBe(1);
    restored.socket!.close();
    newer.socket!.close();
    peer.socket!.close();
    receiver.socket!.close();
    await expect
      .poll(async () => (await guard.health()).relay.daily[6].bytes)
      .toBe(200 + 3 * 256 * 1024);
    const health = await guard.health();
    expect(health.relay.daily[6].messages).toBeGreaterThanOrEqual(800005);
    expect(health.relay.daily[6].admitted).toBe(1);
    expect(health.relay.daily[6].denied).toBe(1);
  });
  it('expires an unpaired room and releases its capacity without relying on a browser timer', async () => {
    const { mf } = await runtime({ concurrentPerNetwork: 1 });
    const offered = await invitation();
    offered.hello.pairExpires = Date.now() + 1000;
    const first = await connect(mf, offered);
    await first.notice('connected');
    // The local runtime dispatches alarms on a coarser schedule than this
    // one-second fixture deadline; don't assume an immediate callback.
    await expect.poll(first.closeCode, { timeout: 15_000 }).toBe(4001);
    const next = await connect(mf, await invitation());
    await next.notice('connected');
    next.socket?.close();
  }, 20_000);
  it('blocks repeated guesses before creating activity, while allowing a known reconnect', async () => {
    const { mf, db } = await runtime({ attemptsPerMinute: 2 });
    const original = await invitation();
    const first = await connect(mf, original);
    await first.notice('connected');
    const missing = await invitation();
    missing.hello.role = 'receive';
    expect((await connect(mf, missing)).response.status).toBe(404);
    const blocked = await connect(mf, missing);
    expect(await blocked.notice('limited')).toMatchObject({ retryAfter: 60 });
    await expect.poll(blocked.closeCode).toBe(4013);
    // Neither a caller-supplied IP header nor a new arbitrary credential helps.
    expect(
      (
        await (
          await connect(mf, missing, '192.0.2.1', {
            'X-Widesend-Network': 'different',
            'X-Widesend-IP': '198.51.100.4',
            'X-Forwarded-For': '198.51.100.4',
          })
        ).notice('limited')
      ).type,
    ).toBe('limited');
    const restored = await connect(mf, original);
    await restored.notice('connected');
    const namespace = await mf.getDurableObjectNamespace('GUARD');
    const health = await (namespace.get(namespace.idFromName('public-admission')) as any).health();
    expect(health.reservedTransfers).toBe(1);
    expect(health.blocks.reduce((n: number, b: any) => n + b.codes, 0)).toBe(2);
    await expect
      .poll(() => db.prepare('SELECT COUNT(*) AS count FROM transfers').first('count'))
      .toBe(1);
    expect(await db.prepare('SELECT DISTINCT ip FROM connections').all()).toMatchObject({
      results: [{ ip: '192.0.2.1' }],
    });
    first.socket?.close();
    restored.socket?.close();
  });
  it('denying a receiver at network capacity does not pin that receiver', async () => {
    const { mf } = await runtime({ concurrentPerNetwork: 1 });
    const occupied = await invitation();
    const host = await connect(mf, occupied, '192.0.2.1');
    await host.notice('connected');
    const offered = await invitation();
    const other = await connect(mf, offered, '198.51.100.1');
    await other.notice('connected');
    const rejected = {
      ...offered,
      hello: { ...offered.hello, role: 'receive', credential: token(32) },
    };
    await (await connect(mf, rejected, '192.0.2.1')).notice('limited');
    const receiver = await connect(
      mf,
      { ...offered, hello: { ...rejected.hello, credential: token(32) } },
      '203.0.113.1',
    );
    await receiver.notice('connected');
    await other.notice('peer-online');
    host.socket?.close();
    other.socket?.close();
    receiver.socket?.close();
  });
  it('releases closed sockets and keeps creation quotas across reconnects', async () => {
    const { mf, db } = await runtime({ concurrentPerNetwork: 1, createsPerHour: 2 });
    const first = await invitation();
    const one = await connect(mf, first);
    await one.notice('connected');
    one.socket?.close(1000, 'test complete');
    await expect
      .poll(() =>
        db.prepare('SELECT COUNT(*) FROM connections WHERE disconnected_at IS NOT NULL').first(),
      )
      .toEqual({ 'COUNT(*)': 1 });
    const second = await invitation();
    const two = await connect(mf, second);
    await two.notice('connected');
    const replacement = await connect(mf, second);
    await replacement.notice('connected');
    replacement.socket?.close(1000, 'test complete');
    await expect
      .poll(() =>
        db
          .prepare('SELECT COUNT(*) AS count FROM connections WHERE disconnected_at IS NULL')
          .first('count'),
      )
      .toBe(0);
    const blocked = await connect(mf, await invitation());
    expect((await blocked.notice('limited')).retryAfter).toBeGreaterThan(3500);
    // The previously admitted sender retains access even after the create budget is used.
    const restored = await connect(mf, first);
    await restored.notice('connected');
    restored.socket?.close();
  });
  it('rejects malformed handshakes before room creation, with an edge burst limit', async () => {
    const { mf, db } = await runtime({}, 3);
    const offered = await invitation();
    for (let n = 0; n < 3; n++)
      expect(
        (await connect(mf, offered, '192.0.2.1', { 'Sec-WebSocket-Protocol': 'widesend, invalid' }))
          .response.status,
      ).toBe(400);
    await (await connect(mf, offered)).notice('limited');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM transfers').first('count')).toBe(0);
    const otherNetwork = await connect(mf, offered, '198.51.100.2');
    await otherNetwork.notice('connected');
    otherNetwork.socket?.close();
    const namespace = await mf.getDurableObjectNamespace('GUARD');
    const guard = namespace.get(namespace.idFromName('public-admission')) as any;
    await expect
      .poll(
        async () => (await guard.health()).blocks.reduce((n: number, b: any) => n + b.burst, 0),
        { timeout: 15_000 },
      )
      .toBe(1);
    expect((await mf.dispatchFetch('https://widesend.test/api/health-overview')).status).toBe(404);
  }, 20_000);
  it('writes each logical metadata event once, including after reconnect with new report IDs', async () => {
    const { mf, db } = await runtime();
    const offered = await invitation();
    const first = await connect(mf, offered);
    await first.notice('connected');
    const report = {
      event: 'manifest',
      files: [{ id: 0, name: 'original.txt', size: 5, type: 'text/plain' }],
    };
    first.socket!.send(JSON.stringify({ type: 'audit', id: crypto.randomUUID(), report }));
    await first.notice('audit-ack');
    const second = await connect(mf, offered);
    await second.notice('connected');
    for (let n = 0; n < 25; n++)
      second.socket!.send(
        JSON.stringify({
          type: 'audit',
          id: crypto.randomUUID(),
          report: { ...report, files: [{ ...report.files[0], name: `attempt-${n}.txt` }] },
        }),
      );
    await expect.poll(() => second.messages.filter((m) => m.type === 'audit-ack').length).toBe(25);
    expect(await db.prepare('SELECT name FROM files').first('name')).toBe('original.txt');
    first.socket?.close();
    second.socket?.close();
  });
});
