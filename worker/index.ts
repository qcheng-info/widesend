import { DurableObject } from 'cloudflare:workers';
import { AUDIT_MAX_BYTES, RETENTION_MS, validateAudit, withoutFileNames } from '../shared/audit';
import { DAY } from '../shared/health';
import {
  activityId,
  recordConnection,
  recordDisconnection,
  recordReport,
  pruneActivity,
} from './activity';
import { browserClose, type CloseRecord } from '../shared/diagnostics';
import { errorText, logError, recordRefusal, short, type Refusal } from './diagnostics';
import { MAX_FRAME, MAX_RELAY_FRAME, PAIRING_MS, SESSION_MS, type Role } from '../shared/protocol';
import { parseHello, type Hello } from './handshake';
import { AbuseGuard, limited, networkKey } from './protection';
import { RENEW_MS, type Limits } from './abuse-store';
import { BlockBuffer } from './block-buffer';
import { utcDay, type RelayBudget, type UsageSnapshot } from '../shared/relay';
import { KEY_EXCHANGE, validKeyMessage } from '../shared/key-exchange';
import {
  claimed,
  freeSlot,
  readState,
  slotActivity,
  slotRole,
  unclaimedSlots,
  type State,
} from './slots';
import {
  ROOM_PROTOCOL,
  decodeHello,
  readRoomLimits,
  shareLocator,
  type RoomHello,
  type RoomLimits,
} from '../shared/room';
import type { ShareRoom } from './share-room';
export { AbuseGuard } from './protection';
export { ShareRoom } from './share-room';

interface Env {
  ROOMS: DurableObjectNamespace<TransferRoom>;
  GUARD: DurableObjectNamespace<AbuseGuard>;
  SHARE: DurableObjectNamespace<ShareRoom>;
  ROOM_LIMITS?: Partial<RoomLimits>;
  NETWORK_RATE: RateLimit;
  SITE_RATE: RateLimit;
  ABUSE_LIMITS?: Partial<Limits>;
  RELAY_BUDGET?: Partial<RelayBudget>;
  ASSETS: Fetcher;
  ACTIVITY?: D1Database;
  // The site's address. Clients put it in their keys, so every address of this
  // deployment (and the CLI through an API host) can pair. Unset: its own address.
  SITE?: string;
  // Hosts that serve only the API (the CLI's server); pages there go to SITE.
  API_HOSTS?: string[];
  // false: the activity log keeps no file names (sizes and fingerprints remain).
  RECORD_FILE_NAMES?: boolean;
  // true: the page says this is a public instance for trying WideSend.
  PUBLIC_INSTANCE?: boolean;
  // Where the page links for the source code (an http or https address).
  SOURCE_URL?: string;
}
type Attachment = {
  owner: string;
  // This slot's receiver.
  receiver?: string;
  expires: number;
  pairExpires: number;
  uses?: number;
  // Sockets accepted before receiver slots have none: they are slot 0.
  slot?: number;
  relayAdmitted?: boolean;
  role: Role;
  credential: string;
  outstanding: number;
  activityId?: string;
  connectionId?: string;
  reports?: number;
  room?: string;
  network?: string;
  relayBatch?: 1;
  relayPolicy?: 1;
  keyExchange?: 2;
  keyRound?: string;
  keyMessages?: number;
  controlBytes?: number;
  usage?: UsageSnapshot[];
  usageSentAt?: number;
  usageSentMessages?: number;
};
const guard = (env: Env) => env.GUARD.get(env.GUARD.idFromName('public-admission'));
const slotOf = (a: Attachment) => a.slot ?? 0;
let reportedSite = false;
/** The deployment's site name; its own address if none is set, or if SITE is malformed. */
function siteOf(env: Env, url: URL): string {
  if (!env.SITE) return url.origin;
  try {
    return new URL(env.SITE).origin;
  } catch {
    if (!reportedSite) logError('site-setting-invalid', { site: short(env.SITE) });
    reportedSite = true;
    return url.origin;
  }
}
/** An http(s) address, or undefined for anything else. */
function webAddress(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return;
  }
}
let edgeBlocks: BlockBuffer | undefined;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const site = siteOf(env, url);
    const apiHost = !!env.API_HOSTS?.includes(url.hostname) && site !== url.origin;
    // Static files are served before the Worker runs, so pages on an API host also
    // learn from /api/health that they belong on the site, and go there themselves.
    if (apiHost && !url.pathname.startsWith('/api/')) {
      // Set the path rather than resolving it: "//evil.com" must stay on the site.
      const target = new URL(site);
      target.pathname = url.pathname;
      target.search = url.search;
      return Response.redirect(target.href, 302);
    }
    if (url.pathname === '/api/health')
      return json({
        ok: true,
        protocol: KEY_EXCHANGE,
        site,
        fileNames: env.RECORD_FILE_NAMES !== false,
        apiHost,
        // What the page tells visitors about this site (How it works).
        activity: !!env.ACTIVITY,
        retentionDays: RETENTION_MS / DAY,
        publicInstance: env.PUBLIC_INSTANCE === true,
        source: webAddress(env.SOURCE_URL),
      });
    const match = /^\/api\/rooms\/([a-f0-9]{64})$/.exec(url.pathname);
    const shared = /^\/api\/share\/([a-f0-9]{64})$/.exec(url.pathname);
    if (!match && !shared)
      return url.pathname.startsWith('/api/')
        ? json({ error: 'Not found' }, 404)
        : env.ASSETS.fetch(request);
    if (request.headers.get('Origin') !== url.origin)
      return json({ error: 'Origin rejected' }, 403);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return json({ error: 'WebSocket required' }, 426);
    const network = await networkKey(request);
    const protocol = shared ? ROOM_PROTOCOL : 'widesend';
    // Cheap edge limits protect the persistent guard from request bursts. These
    // are per Cloudflare location; the guard below enforces the global budgets.
    const [networkRate, siteRate] = await Promise.all([
      env.NETWORK_RATE.limit({ key: network }),
      env.SITE_RATE.limit({ key: 'public-admission' }),
    ]);
    if (!networkRate.success || !siteRate.success) {
      edgeBlocks ??= new BlockBuffer((batch) => guard(env).recordEdgeBlocks(batch));
      ctx.waitUntil(edgeBlocks.add('burst'));
      return limited(60, protocol);
    }
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const country = String(request.cf?.country || '');
    // Attempts turned away here never reach a room; record them for diagnosis.
    // Edge bursts above are not recorded: they are floods by definition.
    const refused = (refusal: Omit<Refusal, 'ip' | 'country'>) => {
      if (env.ACTIVITY)
        ctx.waitUntil(
          recordRefusal(env.ACTIVITY, { ...refusal, ip, country }).catch((error) =>
            logError('refusal-write-failed', { error: errorText(error) }),
          ),
        );
    };
    const forwardedHeaders = (forwarded: Request) => {
      forwarded.headers.set('X-Widesend-IP', ip);
      forwarded.headers.set('X-Widesend-Country', country);
      forwarded.headers.set('X-Widesend-Network', network);
      return forwarded;
    };
    if (shared) {
      let roomHello: RoomHello;
      try {
        roomHello = decodeHello(
          request.headers.get('Sec-WebSocket-Protocol'),
          readRoomLimits(env.ROOM_LIMITS),
        );
        if (roomHello.role !== 'rejoin' && (await shareLocator(roomHello.code)) !== shared[1])
          throw new Error('Invalid code');
      } catch {
        refused({ kind: 'room', target: shared[1], code: 400, reason: 'Invalid handshake' });
        return json({ error: 'Invalid handshake' }, 400);
      }
      const attempt = await guard(env).attempt(network, {
        room: `share:${shared[1]}`,
        role: roomHello.member,
        credential: roomHello.credential,
      });
      if (!attempt.allowed) {
        refused({
          kind: 'room',
          target: shared[1],
          role: roomHello.role,
          code: 4013,
          reason: 'Please wait',
        });
        return limited(attempt.retryAfter, protocol);
      }
      return env.SHARE.get(env.SHARE.idFromName(shared[1])).fetch(
        forwardedHeaders(new Request(request)),
      );
    }
    let hello: Hello;
    try {
      hello = await parseHello(request);
    } catch {
      refused({ kind: 'transfer', target: match![1], code: 400, reason: 'Invalid handshake' });
      return json({ error: 'Invalid handshake' }, 400);
    }
    const admission = await guard(env).attempt(network, {
      room: match![1],
      role: hello.role,
      credential: hello.credential,
    });
    if (!admission.allowed) {
      refused({
        kind: 'transfer',
        target: match![1],
        role: hello.role,
        code: 4013,
        reason: 'Please wait',
      });
      return limited(admission.retryAfter);
    }
    // The URL contains an opaque room hash. Updated clients include the pairing
    // code in the TLS-protected handshake so it can be retained for the admin.
    return env.ROOMS.get(env.ROOMS.idFromName(match![1])).fetch(
      forwardedHeaders(new Request(request)),
    );
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.ACTIVITY) await pruneActivity(env.ACTIVITY);
  },
} satisfies ExportedHandler<Env>;

export class TransferRoom extends DurableObject<Env> {
  private auditTail: Promise<void> = Promise.resolve();
  private recentReports = new Set<string>();
  private pendingReports = new Set<string>();
  private queueAudit(work: () => Promise<void>): Promise<void> {
    const next = this.auditTail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await work();
          return;
        } catch (error) {
          if (attempt === 2) {
            logError('transfer-activity-write-failed', { error: errorText(error) });
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    });
    this.auditTail = next.catch(() => {});
    this.ctx.waitUntil(this.auditTail);
    return next;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN);
  }
  private attachment(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment;
  }
  // Each slot of a several-receiver code pairs one sender socket with one receiver socket.
  private inSlot(slot: number): WebSocket[] {
    return this.sockets().filter((s) => slotOf(this.attachment(s)) === slot);
  }
  private peerOf(ws: WebSocket): WebSocket | undefined {
    const a = this.attachment(ws);
    return this.inSlot(slotOf(a)).find((s) => this.attachment(s).role !== a.role);
  }
  private async session(): Promise<State | undefined> {
    return readState(await this.ctx.storage.get('session'));
  }
  private nextAlarm(state: State, now: number): number {
    const sockets = this.sockets();
    const waiting = sockets.some((s) => !state.receivers[slotOf(this.attachment(s))]);
    return Math.min(
      claimed(state) ? state.expires : state.pairExpires,
      sockets.length ? now + RENEW_MS : Infinity,
      waiting && state.pairExpires > now ? state.pairExpires : Infinity,
    );
  }
  private notice(ws: WebSocket, value: unknown) {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      /* Close handled by runtime. */
    }
  }
  private countUsage(ws: WebSocket, messages: number, bytes = 0): void {
    const a = this.attachment(ws),
      day = utcDay(Date.now());
    const usage = (a.usage ?? []).filter((s) => s.day >= day - 86_400_000);
    let current = usage.find((s) => s.day === day);
    if (!current) usage.push((current = { day, messages: 0, bytes: 0 }));
    current.messages += messages;
    current.bytes += bytes;
    ws.serializeAttachment({ ...a, usage });
  }
  private async flushUsage(ws: WebSocket, force = false): Promise<void> {
    const a = this.attachment(ws);
    if (!a.connectionId || !a.usage?.length) return;
    const total = a.usage.reduce((sum, s) => sum + s.messages, 0);
    if (
      !force &&
      Date.now() - (a.usageSentAt ?? 0) < 30_000 &&
      total - (a.usageSentMessages ?? 0) < 512
    )
      return;
    ws.serializeAttachment({ ...a, usageSentAt: Date.now(), usageSentMessages: total });
    try {
      await guard(this.env).recordUsage(a.connectionId, a.usage);
    } catch {
      // The cumulative snapshot survives in the socket attachment. A later
      // flush retries it; monitoring failures don't interrupt existing files.
    }
  }
  private async permitRelay(ws: WebSocket): Promise<boolean> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const a = this.attachment(ws);
      if (a.relayAdmitted) return true;
      const slot = slotOf(a);
      const state = await this.session();
      if (!state || state.ended.includes(slot) || state.expires <= Date.now()) return false;
      if (!state.receivers[slot] || !this.peerOf(ws)) {
        this.notice(ws, { type: 'peer-offline' });
        return false;
      }
      let decision;
      try {
        await Promise.all(this.inSlot(slot).map((s) => this.flushUsage(s, true)));
        decision = state.relayAdmitted.includes(slot)
          ? { allowed: true as const }
          : await guard(this.env).admitRelay(
              // Credentials are client-generated. Bind an approval to this
              // room, its immutable expiry and the receiver's slot, so it
              // can't be reused elsewhere. Each receiver is approved on its own.
              await activityId(
                `relay:${this.ctx.id.toString()}:${state.owner}:${state.expires}${slot ? `:${slot}` : ''}`,
              ),
              state.expires,
            );
      } catch {
        decision = { allowed: false as const, retryAfter: 60 };
      }
      if (!decision.allowed) {
        for (const socket of this.inSlot(slot)) {
          const modern = this.attachment(socket).relayPolicy === 1;
          this.notice(socket, {
            type: modern ? 'relay-limited' : 'limited',
            retryAfter: decision.retryAfter,
          });
          if (!modern) this.closeSocket(socket, 4013, 'Please wait before reconnecting');
        }
        return false;
      }
      await this.ctx.storage.put('session', {
        ...state,
        relayAdmitted: [...state.relayAdmitted, slot],
      } satisfies State);
      for (const socket of this.inSlot(slot))
        socket.serializeAttachment({ ...this.attachment(socket), relayAdmitted: true });
      return true;
    });
  }
  // The first record wins, so a close the server started keeps its reason when
  // the browser's own close event follows.
  private recordClose(ws: WebSocket, close: CloseRecord): void {
    const { connectionId } = this.attachment(ws);
    if (!this.env.ACTIVITY || !connectionId) return;
    const at = Date.now();
    void this.queueAudit(() =>
      recordDisconnection(this.env.ACTIVITY!, connectionId, at, close),
    ).catch(() => {});
  }
  private rejected(ws: WebSocket, reason: string, fields: Record<string, unknown>): void {
    const a = this.attachment(ws);
    logError('transfer-message-rejected', {
      connection: short(a.connectionId),
      role: a.role,
      reason,
      ...fields,
    });
    this.closeSocket(ws, 4002, reason);
  }
  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    this.recordClose(ws, { by: 'server', code, reason });
    try {
      ws.close(code, reason);
    } catch {
      /* Already closing. */
    }
  }
  // An attempt turned away before it became a connection.
  private async refuse(
    request: Request,
    role: string | null,
    state: State | undefined,
    code: number,
    reason: string,
    response: Response,
  ): Promise<Response> {
    const db = this.env.ACTIVITY;
    if (db) {
      const room = state ? await activityId(state.owner) : null;
      this.ctx.waitUntil(
        recordRefusal(db, {
          kind: 'transfer',
          room,
          target: new URL(request.url).pathname.split('/').pop()!,
          role,
          ip: request.headers.get('X-Widesend-IP') || 'unknown',
          country: request.headers.get('X-Widesend-Country') || '',
          code,
          reason,
        }).catch((error) => logError('refusal-write-failed', { error: errorText(error) })),
      );
    }
    return response;
  }
  // Accept and close at once: a refused upgrade looks like a network error to a
  // page, which would keep retrying. A close code tells it why.
  private closeAtOnce(
    request: Request,
    role: Role,
    state: State | undefined,
    code: number,
    reason: string,
  ): Promise<Response> {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(code, reason);
    return this.refuse(
      request,
      role,
      state,
      code,
      reason,
      new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { 'Sec-WebSocket-Protocol': 'widesend' },
      }),
    );
  }
  async fetch(request: Request): Promise<Response> {
    // Keep admission atomic while deriving the activity ID asynchronously.
    return this.ctx.blockConcurrencyWhile(() => this.admit(request));
  }
  private async admit(request: Request): Promise<Response> {
    let hello: Hello;
    try {
      hello = await parseHello(request);
    } catch {
      return this.refuse(
        request,
        null,
        undefined,
        400,
        'Invalid handshake',
        json({ error: 'Invalid handshake' }, 400),
      );
    }
    const sockets = this.sockets();
    let state = await this.session();
    if (!state && sockets.length) {
      // Rebuild a session from its open sockets if storage lost it.
      const previous = this.attachment(sockets[0]);
      const uses = previous.uses ?? 1;
      state = {
        owner: previous.owner,
        uses,
        receivers: Array(uses).fill(null),
        ended: [],
        relayAdmitted: [],
        expires: previous.expires,
        pairExpires: previous.pairExpires,
      };
      for (const ws of sockets) {
        const a = this.attachment(ws);
        if (a.receiver) state.receivers[slotOf(a)] = a.receiver;
      }
    }
    const now = Date.now();
    const newSession = !state;
    // A sender names its slot. A returning receiver has one; a new one is given one below.
    let slot =
      hello.role === 'send'
        ? (hello.slot ?? 0)
        : state
          ? state.receivers.indexOf(hello.credential)
          : -1;
    const known = !!state && (hello.role === 'send' ? hello.credential === state.owner : slot >= 0);
    if (known && state!.ended.includes(slot))
      return this.closeAtOnce(request, hello.role, state, 4004, 'Transfer ended');
    const refuse = (status: number, error: string) =>
      this.refuse(request, hello.role, state, status, error, json({ error }, status));
    if (state && (state.expires < now || (!claimed(state) && state.pairExpires < now))) {
      for (const ws of sockets) this.closeSocket(ws, 4001, 'Session expired');
      return refuse(410, 'Session expired');
    }
    if (hello.role === 'send') {
      if (state && state.owner !== hello.credential) return refuse(403, 'Room occupied');
      if (!state) {
        if (
          !Number.isSafeInteger(hello.expires) ||
          hello.expires! <= now ||
          hello.expires! > now + SESSION_MS ||
          !Number.isSafeInteger(hello.pairExpires) ||
          hello.pairExpires! > now + PAIRING_MS
        )
          return refuse(400, 'Invalid expiry');
        const uses = hello.uses ?? 1;
        state = {
          owner: hello.credential,
          uses,
          receivers: Array(uses).fill(null),
          ended: [],
          relayAdmitted: [],
          expires: hello.expires!,
          pairExpires: hello.pairExpires!,
        };
        if (hello.receiver) state.receivers[slot] = hello.receiver;
      }
      if (slot >= state.uses) return refuse(400, 'Invalid slot');
      if (!state.receivers[slot] && state.pairExpires < now) return refuse(410, 'Pairing expired');
    } else {
      if (!state) return refuse(404, 'Sender is offline');
      if (slot < 0) {
        if (state.pairExpires < now) return refuse(410, 'Pairing expired');
        slot = freeSlot(state);
        // Every use is taken, or the sender stopped sharing the code.
        if (slot < 0)
          return this.closeAtOnce(request, hello.role, state, 4005, 'Code already used');
      }
    }
    const room = new URL(request.url).pathname.split('/').pop()!;
    const network = request.headers.get('X-Widesend-Network')!;
    const connectionId = crypto.randomUUID();
    const admission = await guard(this.env).reserve({
      room,
      network,
      connection: connectionId,
      role: slotRole(hello.role, slot),
      credential: hello.credential,
      owner: state.owner,
      expires: state.expires,
      newSession,
    });
    if (!admission.allowed)
      return this.refuse(
        request,
        hello.role,
        state,
        4013,
        'Please wait',
        limited(admission.retryAfter),
      );
    // A rejected receiver must never claim the session's receiver credential.
    if (hello.role === 'receive') state.receivers[slot] = hello.credential;
    await this.ctx.storage.put('session', state);
    const shared = {
      owner: state.owner,
      receiver: state.receivers[slot] ?? undefined,
      expires: state.expires,
      pairExpires: state.pairExpires,
      uses: state.uses,
      slot,
      relayAdmitted: state.relayAdmitted.includes(slot) || undefined,
    };
    for (const ws of this.inSlot(slot)) {
      const a = this.attachment(ws);
      // A replacement peer cannot return credits for data forwarded to the old
      // socket. The new peer-online round starts with fresh relay accounting.
      ws.serializeAttachment({ ...a, ...shared, outstanding: 0 });
      if (a.role === hello.role) this.closeSocket(ws, 4000, 'Connection replaced');
    }
    const auditId = await activityId(slotActivity(state.owner, slot));
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      ...shared,
      role: hello.role,
      credential: hello.credential,
      outstanding: 0,
      activityId: auditId,
      connectionId,
      reports: 0,
      room,
      network,
      relayBatch: hello.relayBatch,
      relayPolicy: hello.relayPolicy,
      keyExchange: hello.keyExchange,
    } satisfies Attachment);
    await this.ctx.storage.setAlarm(this.nextAlarm(state, now));
    if (this.env.ACTIVITY) {
      const ip = request.headers.get('X-Widesend-IP') || 'unknown';
      const country = request.headers.get('X-Widesend-Country') || '';
      const { expires, uses } = state;
      void this.queueAudit(() =>
        recordConnection(
          this.env.ACTIVITY!,
          auditId,
          connectionId,
          hello.role,
          ip,
          country,
          expires,
          hello.code ?? null,
          slot,
          uses,
        ),
      ).catch(() => {
        this.notice(pair[1], { type: 'audit-unavailable' });
      });
    }
    this.notice(pair[1], {
      type: 'connected',
      keyExchange: hello.keyExchange,
      relayBatch: hello.relayBatch,
      relayPolicy: hello.relayPolicy,
      expires: state.expires,
      pairExpires: state.pairExpires,
      receiver: shared.receiver,
    });
    const paired = this.inSlot(slot);
    if (paired.length === 2) {
      const round = crypto.randomUUID();
      for (const ws of paired) {
        ws.serializeAttachment({ ...this.attachment(ws), keyRound: round, keyMessages: 0 });
        const other = paired.find((s) => s !== ws)!;
        this.notice(ws, {
          type: 'peer-online',
          receiver: shared.receiver,
          keyExchange: this.attachment(other).keyExchange,
          round,
        });
      }
    }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': 'widesend' },
    });
  }
  async alarm(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(() => this.maintain());
  }
  private async maintain(): Promise<void> {
    const state = await this.session();
    const now = Date.now();
    if (state && state.expires > now && (claimed(state) || state.pairExpires > now)) {
      for (const ws of this.sockets()) {
        await this.flushUsage(ws, true);
        const a = this.attachment(ws);
        // Nobody claimed this use of the code in time.
        if (!state.receivers[slotOf(a)] && state.pairExpires <= now) {
          this.closeSocket(ws, 4001, 'Session expired');
          continue;
        }
        if (!a.room || !a.network || !a.connectionId) continue;
        const admission = await guard(this.env).reserve({
          room: a.room,
          network: a.network,
          connection: a.connectionId,
          role: slotRole(a.role, slotOf(a)),
          credential: a.credential,
          owner: a.owner,
          expires: a.expires,
          newSession: false,
        });
        if (!admission.allowed) {
          this.notice(ws, { type: 'limited', retryAfter: admission.retryAfter });
          this.closeSocket(ws, 4013, 'Please wait before reconnecting');
        }
      }
      await this.ctx.storage.setAlarm(this.nextAlarm(state, Date.now()));
      return;
    }
    for (const ws of this.sockets()) {
      await this.flushUsage(ws, true);
      this.closeSocket(ws, 4001, 'Session expired');
    }
    await this.ctx.storage.deleteAll();
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.countUsage(ws, 1);
    try {
      await this.handleMessage(ws, message);
    } finally {
      this.ctx.waitUntil(this.flushUsage(ws));
    }
  }
  private async handleMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.attachment(ws);
    if (Date.now() > a.expires || (!a.receiver && Date.now() > a.pairExpires)) {
      this.closeSocket(ws, 4001, 'Session expired');
      return;
    }
    const slot = slotOf(a);
    const peer = this.peerOf(ws);
    if (typeof message === 'string') {
      try {
        if (message.length > AUDIT_MAX_BYTES) throw new Error();
        const m = JSON.parse(message);
        if (m.type === 'key-exchange') {
          if (message.length > 1024 || a.keyExchange !== KEY_EXCHANGE || !validKeyMessage(m))
            throw new Error();
          if (!peer || a.keyRound !== m.round || this.attachment(peer).keyRound !== m.round) return;
          if (this.attachment(peer).keyExchange !== KEY_EXCHANGE) return;
          // Exactly one share and one confirmation are needed per endpoint.
          // Allow no unlimited unauthenticated signaling stream.
          if ((a.keyMessages ?? 0) >= 2) throw new Error();
          ws.serializeAttachment({ ...this.attachment(ws), keyMessages: (a.keyMessages ?? 0) + 1 });
          peer.send(message);
          this.countUsage(ws, 0, new TextEncoder().encode(message).byteLength);
          return;
        }
        if (m.type === 'relay-request') {
          if (message.length > 128 || a.relayPolicy !== 1) throw new Error();
          if (await this.permitRelay(ws)) this.notice(ws, { type: 'relay-admitted' });
          return;
        }
        // Either device ends its own slot. Other receivers of the code carry on.
        if (m.type === 'end') {
          await Promise.all(this.inSlot(slot).map((s) => this.flushUsage(s, true)));
          await this.ctx.blockConcurrencyWhile(async () => {
            const state = await this.session();
            if (state && state.owner === a.owner && !state.ended.includes(slot))
              await this.ctx.storage.put('session', {
                ...state,
                ended: [...state.ended, slot],
              } satisfies State);
          });
          for (const socket of this.inSlot(slot)) this.closeSocket(socket, 4004, 'Transfer ended');
          return;
        }
        // The sender stops sharing: no new receiver can claim the code.
        if (m.type === 'seal') {
          if (message.length > 128 || a.role !== 'send') throw new Error();
          let sealed: number[] = [];
          await this.ctx.blockConcurrencyWhile(async () => {
            const state = await this.session();
            if (!state || state.owner !== a.owner) return;
            sealed = unclaimedSlots(state);
            if (sealed.length)
              await this.ctx.storage.put('session', {
                ...state,
                ended: [...state.ended, ...sealed],
              } satisfies State);
          });
          this.notice(ws, { type: 'sealed' });
          for (const socket of this.sockets())
            if (sealed.includes(slotOf(this.attachment(socket))))
              this.closeSocket(socket, 4004, 'Transfer ended');
          return;
        }
        if (m.type === 'audit') {
          const audited = validateAudit(m);
          const report =
            this.env.RECORD_FILE_NAMES === false
              ? { ...audited, report: withoutFileNames(audited.report) }
              : audited;
          // Reconnects may regenerate report IDs. Bound database writes by the
          // logical event, not a client-controlled UUID: one manifest, each
          // file's fingerprint, and each status/route combination per role.
          const event = report.report;
          if (event.event === 'status' && ['complete', 'cancelled', 'error'].includes(event.status))
            this.ctx.waitUntil(this.flushUsage(ws, true));
          // Each receiver slot has its own activity record; slot 0 keeps the old keys.
          const key = `${slot ? `${slot}:` : ''}${a.role}:${event.event}:${event.event === 'file' ? event.file.id : event.event === 'status' ? `${event.status}:${event.route}` : ''}`;
          if (!this.env.ACTIVITY) {
            this.notice(ws, { type: 'audit-ack', id: report.id });
            return;
          }
          if (!a.activityId || (a.reports || 0) >= 512) return;
          if (
            this.recentReports.has(key) ||
            (await this.ctx.storage.get<boolean>(`audit:${key}`))
          ) {
            this.notice(ws, { type: 'audit-ack', id: report.id });
            return;
          }
          if (this.pendingReports.has(key)) return;
          if (this.pendingReports.size >= 16) return;
          this.pendingReports.add(key);
          ws.serializeAttachment({ ...this.attachment(ws), reports: (a.reports || 0) + 1 });
          void this.queueAudit(async () => {
            await recordReport(this.env.ACTIVITY!, a.activityId!, a.role, report.report);
            await this.ctx.storage.put(`audit:${key}`, true);
          })
            .then(() => {
              this.recentReports.add(key);
              if (this.recentReports.size > 512)
                this.recentReports.delete(this.recentReports.values().next().value!);
              this.notice(ws, { type: 'audit-ack', id: report.id });
            })
            .catch(() => this.notice(ws, { type: 'audit-unavailable' }))
            .finally(() => this.pendingReports.delete(key));
          return;
        }
        if (message.length > 128) throw new Error();
        if (
          m.type !== 'drain' ||
          !Number.isSafeInteger(m.bytes) ||
          m.bytes < 0 ||
          m.bytes > (a.relayBatch === 1 ? MAX_RELAY_FRAME : MAX_FRAME)
        )
          throw new Error();
        if (peer) {
          const p = this.attachment(peer);
          peer.serializeAttachment({ ...p, outstanding: Math.max(0, p.outstanding - m.bytes) });
        }
      } catch (error) {
        this.rejected(ws, 'Invalid message', {
          type:
            typeof message === 'string'
              ? (/"type":"([a-z-]{1,24})"/.exec(message)?.[1] ?? '?')
              : 'binary',
          error: errorText(error) || 'invalid',
        });
      }
      return;
    }
    let fileFrame = a.relayPolicy !== 1;
    if (a.relayPolicy === 1) {
      const tag = new Uint8Array(message)[0];
      if (tag !== 0 && tag !== 1) {
        this.rejected(ws, 'Invalid frame type', { tag });
        return;
      }
      fileFrame = tag === 1;
      message = message.slice(1);
    }
    if (
      message.byteLength < 29 ||
      message.byteLength >
        (a.relayBatch === 1 && (!peer || this.attachment(peer).relayBatch === 1)
          ? MAX_RELAY_FRAME
          : MAX_FRAME)
    ) {
      this.rejected(ws, 'Invalid frame size', { bytes: message.byteLength });
      return;
    }
    if (!peer) {
      this.notice(ws, { type: 'peer-offline' });
      return;
    }
    // Updated clients cannot be bridged to a legacy cipher. Existing old/old
    // tabs can finish, but either upgraded endpoint requires both pages v2.
    if (a.keyExchange !== this.attachment(peer).keyExchange) return;
    // A device sends encrypted frames only after its own share and confirmation for
    // this pairing round. Anything earlier was encrypted for a previous peer (a page
    // still working through a backlog when its peer reconnected) and would make the
    // new peer give up on verification.
    if (a.keyExchange === KEY_EXCHANGE && (a.keyMessages ?? 0) < 2) return;
    // Small control traffic stays available for direct pairing. A client cannot
    // stream unlimited data by labelling every encrypted frame as control.
    if (!fileFrame)
      ws.serializeAttachment({
        ...this.attachment(ws),
        controlBytes: (a.controlBytes ?? 0) + message.byteLength,
      });
    if (
      (fileFrame || (this.attachment(ws).controlBytes ?? 0) > 1024 * 1024) &&
      !this.attachment(ws).relayAdmitted &&
      !(await this.permitRelay(ws))
    )
      return;
    const current = this.attachment(ws);
    if (current.outstanding + message.byteLength > 4 * 1024 * 1024) {
      this.closeSocket(ws, 4003, 'Receiver too slow');
      return;
    }
    ws.serializeAttachment({ ...current, outstanding: current.outstanding + message.byteLength });
    peer.send(message);
    this.countUsage(ws, 0, message.byteLength);
  }
  webSocketClose(ws: WebSocket, code: number, reason = ''): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Connection closed');
    } catch {
      /* Already closed. */
    }
    const a = this.attachment(ws);
    const slot = slotOf(a);
    this.ctx.waitUntil(this.flushUsage(ws, true));
    if (a.room && a.connectionId)
      this.ctx.waitUntil(guard(this.env).release(a.room, slotRole(a.role, slot), a.connectionId));
    this.recordClose(ws, browserClose(code, reason));
    const active = this.inSlot(slot);
    if (!active.some((s) => this.attachment(s).role === a.role)) {
      for (const peer of active) {
        const p = this.attachment(peer);
        peer.serializeAttachment({ ...p, outstanding: 0 });
        this.notice(peer, { type: 'peer-offline' });
      }
    }
  }
  webSocketError(ws: WebSocket, error: unknown): void {
    this.webSocketClose(ws, 1011, errorText(error));
  }
}
