import { expect } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { token, pairingCode } from '../../src/crypto';
import { createIdentity, type DeviceIdentity } from '../../src/key-session';
import { signCertificate } from '../../src/room/identity';
import {
  ROOM_MS,
  ROOM_PROTOCOL,
  encodeHello,
  shareLocator,
  type RoomHello,
  type RoomSettings,
} from '../../shared/room';
import type { Limits } from '../../worker/abuse-store';

// Test-only runtime: the real Worker, ShareRoom, AbuseGuard and D1 in Miniflare.
let script: Promise<string> | undefined;
function bundle(): Promise<string> {
  return (script ??= build({
    entryPoints: ['worker/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    external: ['cloudflare:workers'],
  }).then((result) => result.outputFiles[0].text));
}
export const ORIGIN = 'https://widesend.test';

export async function shareRuntime(
  options: {
    limits?: Partial<Limits>;
    roomLimits?: { maxMembers?: number };
    relayBudget?: { dailyRequestUnits?: number; stopNewAtPercent?: number };
    // Other Worker settings, e.g. SITE, API_HOSTS or RECORD_FILE_NAMES.
    vars?: Record<string, unknown>;
    // false: no ACTIVITY database, like a site without the admin dashboard.
    activity?: boolean;
  } = {},
): Promise<{ mf: Miniflare; db: D1Database }> {
  const activity = options.activity !== false;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: '2026-09-01',
      script: await bundle(),
      scriptPath: resolve('worker/test-bundle.js'),
      durableObjects: {
        ROOMS: { className: 'TransferRoom', useSQLite: true },
        GUARD: { className: 'AbuseGuard', useSQLite: true },
        SHARE: { className: 'ShareRoom', useSQLite: true },
      },
      bindings: {
        ABUSE_LIMITS: { attemptsPerMinute: 1000, attemptsPerHour: 1000, ...options.limits },
        ROOM_LIMITS: options.roomLimits ?? {},
        ...(options.relayBudget ? { RELAY_BUDGET: options.relayBudget } : {}),
        ...options.vars,
      },
      ratelimits: {
        NETWORK_RATE: { namespace_id: '1001', simple: { limit: 10_000, period: 60 } },
        SITE_RATE: { namespace_id: '1002', simple: { limit: 10_000, period: 60 } },
      },
      serviceBindings: { ASSETS: () => new Response('website') },
      d1Databases: activity ? ['ACTIVITY'] : [],
    }),
  );
  // Tests that turn the activity record off never use the database.
  if (!activity) return { mf, db: undefined as unknown as D1Database };
  const db = await mf.getD1Database('ACTIVITY');
  const files = (await readdir(new URL('../../migrations', import.meta.url))).sort();
  for (const file of files) {
    const sql = await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8');
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    await db.batch(statements.map((s) => db.prepare(s)));
  }
  return { mf, db };
}

export const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

export type OwnerSetup = {
  code: string;
  locator: string;
  member: string;
  credential: string;
  identity: DeviceIdentity;
  expires: number;
  hello: RoomHello;
};
export async function ownerSetup(
  settings: RoomSettings = { join: 'auto', size: 10, send: 'everyone' },
  expires = Date.now() + ROOM_MS - 60_000,
  name = 'Owner',
): Promise<OwnerSetup> {
  const code = pairingCode();
  const locator = await shareLocator(code);
  const identity = await createIdentity();
  const member = randomId();
  const credential = token(32);
  const cert = await signCertificate(identity.privateKey, {
    locator,
    member,
    role: 'owner',
    name,
    key: identity.publicKey,
    expires,
  });
  return {
    code,
    locator,
    member,
    credential,
    identity,
    expires,
    hello: {
      v: 1,
      role: 'create',
      code,
      member,
      credential,
      name,
      key: identity.publicKey,
      cert,
      expires,
      settings,
    },
  };
}
export function joinHello(code: string, name = 'Joiner') {
  return {
    v: 1 as const,
    role: 'join' as const,
    code,
    member: randomId(),
    credential: token(32),
    name,
  };
}

export type TestSocket = Awaited<ReturnType<typeof openRoom>>;
export async function openRoom(mf: Miniflare, locator: string, hello: RoomHello, ip = '192.0.2.1') {
  const response = await mf.dispatchFetch(`${ORIGIN}/api/share/${locator}`, {
    headers: {
      Origin: ORIGIN,
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `${ROOM_PROTOCOL}, ${encodeHello(hello)}`,
      'CF-Connecting-IP': ip,
    },
  });
  const socket = response.webSocket;
  const messages: any[] = [];
  const frames: ArrayBuffer[] = [];
  let closeCode: number | undefined;
  socket?.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const message = JSON.parse(event.data);
      messages.push(message);
      // The room announces every close it initiates; finish it like the app does.
      if (message.type === 'closing') {
        closeCode ??= message.code;
        socket.close(1000);
      }
    } else frames.push(event.data as ArrayBuffer);
  });
  socket?.addEventListener('close', (event) => {
    closeCode ??= event.code;
  });
  socket?.accept();
  const find = (type: string, where: (m: any) => boolean, from: number) =>
    messages.slice(from).find((m) => m.type === type && where(m));
  return {
    response,
    socket: socket!,
    messages,
    frames,
    closeCode: () => closeCode,
    mark: () => messages.length,
    // Waits for a message of this type at or after position `from`.
    async next(type: string, where: (m: any) => boolean = () => true, from = 0) {
      await expect.poll(() => find(type, where, from), { timeout: 5000 }).toBeDefined();
      return find(type, where, from);
    },
    async closed() {
      await expect.poll(() => closeCode, { timeout: 5000 }).toBeDefined();
      return closeCode!;
    },
    send(value: unknown) {
      socket!.send(JSON.stringify(value));
    },
    sendBinary(bytes: Uint8Array) {
      socket!.send(bytes.slice().buffer);
    },
  };
}
