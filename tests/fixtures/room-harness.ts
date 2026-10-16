import { expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { FileMeta } from '../../shared/protocol';
import type { SavedFile } from '../../src/storage';
import {
  MemoryMembershipStore,
  type ReceiveSink,
  type RoomEnvironment,
  type SocketLike,
} from '../../src/room/environment';
import type { Room, RoomSnapshot } from '../../src/room/room';
import { MemoryHistoryStore } from '../../src/room/history';
import { closeAfterFailedConnection } from '../../shared/socket-close';
import { shareRuntime } from './share-runtime';

// Test-only: an in-memory destination that verifies like the OPFS one.
export class MemorySink implements ReceiveSink {
  files = new Map<number, Uint8Array>();
  writes = 0;
  disposed = false;
  private current?: FileMeta;
  // `delay`: milliseconds per write, to pace a receiver like a slower device.
  constructor(
    readonly folder: string,
    private delay = 0,
  ) {}
  async open(meta: FileMeta) {
    this.current = meta;
    this.files.set(meta.id, new Uint8Array(meta.size));
  }
  async write(offset: number, data: ArrayBuffer) {
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    this.writes++;
    this.files.get(this.current!.id)!.set(new Uint8Array(data), offset);
  }
  async finish(meta: FileMeta, sha256: string): Promise<SavedFile> {
    const bytes = this.files.get(meta.id)!;
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) throw new Error('The received file did not match.');
    return {
      ...meta,
      url: `memory:${meta.id}`,
      file: new File([bytes], meta.name, { type: meta.type }),
      md5: createHash('md5').update(bytes).digest('hex'),
      sha256: actual,
      keepAvailable: () => {},
    };
  }
  async dispose() {
    this.disposed = true;
  }
}

// Wraps a real socket so tests can change what arrives and count what leaves.
class InspectableSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(
    readonly real: WebSocket,
    private hooks: TestHooks,
  ) {
    real.onopen = (event) => this.onopen?.(event);
    real.onerror = (event) => this.onerror?.(event);
    real.onclose = (event) => this.onclose?.({ code: event.code });
    real.onmessage = (event) => {
      const data = hooks.incoming ? hooks.incoming(event.data) : event.data;
      if (data !== undefined) this.onmessage?.({ data });
    };
  }
  get readyState() {
    return this.real.readyState;
  }
  get bufferedAmount() {
    return this.real.bufferedAmount;
  }
  get binaryType() {
    return this.real.binaryType;
  }
  set binaryType(value: string) {
    this.real.binaryType = value as BinaryType;
  }
  send(data: string | ArrayBuffer | Uint8Array) {
    // Returning false drops the frame, as a lossy network would.
    if (this.hooks.outgoing?.(data) === false) return;
    this.real.send(data as ArrayBuffer);
  }
  close(code?: number, reason?: string) {
    this.real.close(code, reason);
  }
  // A network drop as a browser reports it: the connection is simply gone.
  drop() {
    this.real.onclose = null;
    this.real.onmessage = null;
    this.real.close();
    this.onclose?.({ code: 1006 });
  }
}
// A connection attempt while the device has no network: it fails at once.
class UnreachableSocket implements SocketLike {
  readyState = 0;
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor() {
    setTimeout(() => {
      this.readyState = 3;
      this.onclose?.({ code: 1006 });
    }, 0);
  }
  send() {}
  close() {}
}
export type TestHooks = {
  incoming?: (data: unknown) => unknown;
  outgoing?: (data: string | ArrayBuffer | Uint8Array) => boolean | void;
};
export type TestEnvironment = RoomEnvironment & {
  store: MemoryMembershipStore;
  history: MemoryHistoryStore;
  sinks: MemorySink[];
  sockets: InspectableSocket[];
  // Takes this device off the network (its page stays open) until online().
  offline(): void;
  online(): void;
  hooks: TestHooks;
  sinkDelay: number;
  // Every keepAwake call, in order.
  awake: boolean[];
};

export async function roomHarness(options: Parameters<typeof shareRuntime>[0] = {}) {
  const { mf, db } = await shareRuntime(options);
  const base = await mf.ready;
  const origin = base.origin;
  function environment(store = new MemoryMembershipStore()): TestEnvironment {
    let reachable = true;
    const env: TestEnvironment = {
      origin,
      socketUrl: (locator) => `${origin.replace(/^http/, 'ws')}/api/share/${locator}`,
      connect(url, protocols) {
        if (!reachable) return new UnreachableSocket();
        const real = new WebSocket(url, { protocols, headers: { Origin: origin } } as never);
        // Browsers fire close after a failed attempt; Node 22 needs this (shared/socket-close.ts).
        closeAfterFailedConnection(real);
        const socket = new InspectableSocket(real, env.hooks);
        env.sockets.push(socket);
        return socket;
      },
      store,
      // Kept files are whatever the newest sink for that folder holds.
      history: new MemoryHistoryStore((folder, id) => {
        const bytes = env.sinks.findLast((sink) => sink.folder === folder)?.files.get(id);
        return bytes && new File([bytes], String(id));
      }),
      sinks: [],
      sockets: [],
      hooks: {},
      sinkDelay: 0,
      awake: [],
      keepAwake(on) {
        env.awake.push(on);
      },
      async sink(_files, folder) {
        const sink = new MemorySink(folder, env.sinkDelay);
        env.sinks.push(sink);
        return sink;
      },
      offline() {
        reachable = false;
        env.sockets.at(-1)?.drop();
      },
      online() {
        reachable = true;
      },
    };
    return env;
  }
  return { mf, db, environment };
}

export async function until(
  room: Room,
  predicate: (s: RoomSnapshot) => boolean,
  timeout = 15_000,
): Promise<RoomSnapshot> {
  await expect.poll(() => predicate(room.snapshot), { timeout, interval: 25 }).toBe(true);
  return room.snapshot;
}
export const inRoom = (members: number) => (s: RoomSnapshot) =>
  s.phase === 'in-room' && s.members.length === members && s.members.every((m) => m.online);
