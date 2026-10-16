import { DurableObject } from 'cloudflare:workers';
import type { AbuseGuard } from './protection';
import { RENEW_MS, type Limits } from './abuse-store';
import { activityId } from './activity';
import {
  recordMember,
  recordMemberLeft,
  recordRoom,
  recordRoomConnection,
  recordRoomDisconnection,
  recordRoomEnded,
  recordRoomReport,
} from './share-activity';
import { validKeyMessage } from '../shared/key-exchange';
import { browserClose, type CloseRecord } from '../shared/diagnostics';
import { errorText, logError, recordRefusal, short } from './diagnostics';
import { utcDay, type UsageSnapshot } from '../shared/relay';
import {
  CLOSE,
  CONTROL_ALLOWANCE,
  DESTINATION_BACKLOG,
  JOIN_WAIT_MS,
  MAX_PENDING,
  MAX_PIECE_MESSAGE,
  MAX_TEXT,
  ROOM_PROTOCOL,
  decodeClientFrame,
  decodeHello,
  encodeForward,
  pieceOfferId,
  roomReportWithoutNames,
  validateRoomAudit,
  ROOM_AUDIT_BUDGET,
  readRoomLimits,
  validKey,
  validMemberId,
  validSignature,
  validateSettings,
  type RoomHello,
  type RoomLimits,
  type RoomSettings,
  type Roster,
} from '../shared/room';

export interface ShareEnv {
  GUARD: DurableObjectNamespace<AbuseGuard>;
  ROOM_LIMITS?: Partial<RoomLimits>;
  ABUSE_LIMITS?: Partial<Limits>;
  ACTIVITY?: D1Database;
  RECORD_FILE_NAMES?: boolean;
}
type Member = {
  credential: string;
  name: string;
  key: string;
  cert: string;
  role: 'owner' | 'member';
  joined: number;
};
type RoomState = {
  code: string;
  locator: string;
  owner: string;
  ownerCredential: string;
  ownerKey: string;
  created: number;
  expires: number;
  settings: RoomSettings;
  members: Record<string, Member>;
  revoked: string[];
  ended?: 'dismissed';
  activity: string;
};
type Attachment = {
  member: string;
  status: 'owner' | 'member' | 'pending';
  credential: string;
  name: string;
  connection: string;
  network: string;
  locator: string;
  since: number;
  round?: string;
  joinerKex?: number;
  ownerKex?: number;
  // Bytes forwarded to this socket that its browser has not yet drained.
  backlog?: number;
  // Unicast bytes this socket sent; beyond CONTROL_ALLOWANCE relay admission applies.
  control?: number;
  usage?: UsageSnapshot[];
  usageSentAt?: number;
  usageSentMessages?: number;
  reports?: number;
};
const guard = (env: ShareEnv) => env.GUARD.get(env.GUARD.idFromName('public-admission'));
const json = (value: unknown, status: number) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

// A socket that closes immediately with an explanatory code. Browsers hide HTTP
// statuses from WebSocket callers; close codes reach them.
export function closedSocket(code: number, reason: string, notice?: unknown): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  if (notice) pair[1].send(JSON.stringify(notice));
  pair[1].close(code, reason);
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: { 'Sec-WebSocket-Protocol': ROOM_PROTOCOL, 'Cache-Control': 'no-store' },
  });
}

export class ShareRoom extends DurableObject<ShareEnv> {
  private limits: RoomLimits;
  private auditTail: Promise<void> = Promise.resolve();
  private recentReports = new Set<string>();
  private pendingReports = new Set<string>();
  // Activity writes run in order with retries and never delay room traffic.
  private queueAudit(work: (db: D1Database) => Promise<void>): Promise<void> {
    const db = this.env.ACTIVITY;
    if (!db) return Promise.resolve();
    const next = this.auditTail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await work(db);
          return;
        } catch (error) {
          if (attempt === 2) {
            logError('room-activity-write-failed', { error: errorText(error) });
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
  constructor(ctx: DurableObjectState, env: ShareEnv) {
    super(ctx, env);
    this.limits = readRoomLimits(env.ROOM_LIMITS);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((s) => s.readyState === WebSocket.OPEN);
  }
  private attachment(ws: WebSocket): Attachment {
    return ws.deserializeAttachment() as Attachment;
  }
  private send(ws: WebSocket, value: unknown): void {
    try {
      ws.send(JSON.stringify(value));
    } catch {
      /* Close handled by the runtime. */
    }
  }
  // Workerd leaves a peer socket closed from another socket's event in CLOSING
  // until the client closes it too. Every server-initiated close therefore sends
  // a final notice first; clients treat it as the close and finish the handshake.
  private terminate(ws: WebSocket, code: number, reason: string): void {
    this.recordClose(ws, { by: 'server', code, reason });
    this.send(ws, { type: 'closing', code, reason });
    try {
      ws.close(code, reason);
    } catch {
      /* Already closing. */
    }
  }
  // The first record wins, so a close the server started keeps its reason when the
  // browser's own close event follows.
  private recordClose(ws: WebSocket, close: CloseRecord): void {
    const { connection } = this.attachment(ws);
    const at = Date.now();
    void this.queueAudit((db) => recordRoomDisconnection(db, connection, at, close)).catch(
      () => {},
    );
  }
  // An attempt turned away before it became a connection.
  private refuse(
    request: Request,
    hello: RoomHello,
    state: RoomState | undefined,
    code: number,
    reason: string,
    notice?: unknown,
  ): Response {
    const db = this.env.ACTIVITY;
    if (db)
      this.ctx.waitUntil(
        recordRefusal(db, {
          kind: 'room',
          room: state?.activity ?? null,
          target: new URL(request.url).pathname.split('/').pop()!,
          role: hello.role,
          ip: request.headers.get('X-Widesend-IP') || 'unknown',
          country: request.headers.get('X-Widesend-Country') || '',
          code,
          reason,
        }).catch((error) => logError('refusal-write-failed', { error: errorText(error) })),
      );
    return closedSocket(code, reason, notice);
  }
  private state(): Promise<RoomState | undefined> {
    return this.ctx.storage.get<RoomState>('room');
  }
  private async save(state: RoomState): Promise<void> {
    await this.ctx.storage.put('room', state);
  }
  private socketsOf(member: string): WebSocket[] {
    return this.sockets().filter((s) => this.attachment(s).member === member);
  }
  private admittedSockets(): WebSocket[] {
    return this.sockets().filter((s) => this.attachment(s).status !== 'pending');
  }
  private pendingSockets(): WebSocket[] {
    return this.sockets().filter((s) => this.attachment(s).status === 'pending');
  }
  private ownerSocket(state: RoomState): WebSocket | undefined {
    return this.socketsOf(state.owner)[0];
  }
  private roster(state: RoomState): Roster {
    const online = new Set(this.admittedSockets().map((s) => this.attachment(s).member));
    return {
      type: 'roster',
      owner: state.owner,
      ownerKey: state.ownerKey,
      settings: state.settings,
      expires: state.expires,
      pending: this.pendingSockets().length,
      members: Object.entries(state.members).map(([id, m]) => ({
        id,
        name: m.name,
        key: m.key,
        cert: m.cert,
        role: m.role,
        online: online.has(id),
      })),
    };
  }
  private broadcastRoster(state: RoomState): void {
    const roster = this.roster(state);
    for (const ws of this.admittedSockets()) this.send(ws, roster);
  }
  // A fresh SPAKE2 round between the online owner and one pending joiner.
  private startRound(state: RoomState, pending: WebSocket): void {
    const owner = this.ownerSocket(state);
    if (!owner) {
      this.send(pending, { type: 'pending', ownerOnline: false });
      return;
    }
    const a = this.attachment(pending);
    const round = crypto.randomUUID();
    pending.serializeAttachment({ ...a, round, joinerKex: 0, ownerKex: 0 } satisfies Attachment);
    this.send(pending, { type: 'pending', ownerOnline: true, round });
    this.send(owner, { type: 'join-request', id: a.member, name: a.name, round });
  }

  async fetch(request: Request): Promise<Response> {
    return this.ctx.blockConcurrencyWhile(() => this.admit(request));
  }
  private async admit(request: Request): Promise<Response> {
    let hello: RoomHello;
    try {
      hello = decodeHello(request.headers.get('Sec-WebSocket-Protocol'), this.limits);
    } catch {
      return json({ error: 'Invalid handshake' }, 400);
    }
    const now = Date.now();
    const locator = new URL(request.url).pathname.split('/').pop()!;
    let state = await this.state();
    if (state && !state.ended && state.expires <= now) {
      await this.expire(state);
      state = undefined;
    }
    if (hello.role === 'create') {
      if (state)
        return this.refuse(
          request,
          hello,
          state,
          state.ended ? CLOSE.dismissed : CLOSE.exists,
          'Room exists',
        );
    } else {
      if (!state) return this.refuse(request, hello, state, CLOSE.notFound, 'Room not found');
      if (state.ended) return this.refuse(request, hello, state, CLOSE.dismissed, 'Room dismissed');
      if (state.revoked.includes(hello.member))
        return this.refuse(request, hello, state, CLOSE.removed, 'Removed');
      const known = state.members[hello.member];
      if (hello.role === 'rejoin' && known?.credential !== hello.credential)
        return this.refuse(request, hello, state, CLOSE.notFound, 'Not a member');
      if (hello.role === 'join' && known && known.credential !== hello.credential)
        return this.refuse(request, hello, state, CLOSE.invalid, 'Member exists');
      if (hello.role === 'join' && !known) {
        if (Object.keys(state.members).length >= state.settings.size)
          return this.refuse(request, hello, state, CLOSE.full, 'Room full');
        const others = this.pendingSockets().filter(
          (s) => this.attachment(s).member !== hello.member,
        );
        if (others.length >= MAX_PENDING)
          return this.refuse(request, hello, state, CLOSE.limited, 'Too many join requests', {
            type: 'limited',
            retryAfter: 30,
          });
      }
    }
    const network = request.headers.get('X-Widesend-Network') || 'unknown';
    const connection = crypto.randomUUID();
    const ownerCredential = state?.ownerCredential ?? hello.credential;
    const expires = state?.expires ?? (hello.role === 'create' ? hello.expires : now);
    const admission = await guard(this.env).reserve({
      room: `share:${locator}`,
      role: hello.member,
      credential: hello.credential,
      owner: ownerCredential,
      expires,
      network,
      connection,
      newSession: hello.role === 'create',
    });
    if (!admission.allowed)
      return this.refuse(request, hello, state, CLOSE.limited, 'Please wait', {
        type: 'limited',
        retryAfter: admission.retryAfter,
      });
    if (hello.role === 'create') {
      state = {
        code: hello.code,
        locator,
        owner: hello.member,
        ownerCredential: hello.credential,
        ownerKey: hello.key,
        created: now,
        expires: hello.expires,
        settings: hello.settings,
        revoked: [],
        activity: await activityId(`share:${hello.credential}`),
        members: {
          [hello.member]: {
            credential: hello.credential,
            name: hello.name,
            key: hello.key,
            cert: hello.cert,
            role: 'owner',
            joined: now,
          },
        },
      };
      await this.save(state);
      const created = state;
      void this.queueAudit(async (db) => {
        await recordRoom(db, {
          id: created.activity,
          code: created.code,
          locator: created.locator,
          created: now,
          expires: created.expires,
        });
        await recordMember(db, created.activity, {
          id: created.owner,
          name: hello.name,
          role: 'owner',
          joined: now,
        });
      }).catch(() => {});
    }
    const room = state!;
    for (const old of this.socketsOf(hello.member)) this.terminate(old, CLOSE.replaced, 'Replaced');
    const member = room.members[hello.member];
    const status: Attachment['status'] = member
      ? member.role === 'owner'
        ? 'owner'
        : 'member'
      : 'pending';
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      member: hello.member,
      status,
      credential: hello.credential,
      name: member?.name ?? (hello.role === 'join' ? hello.name : ''),
      connection,
      network,
      locator,
      since: now,
    } satisfies Attachment);
    // Scheduled with this socket counted: lease renewal and the join deadline.
    await this.scheduleAlarm(room);
    this.send(pair[1], {
      type: 'welcome',
      you: hello.member,
      status,
      code: room.code,
      expires: room.expires,
    });
    const ip = request.headers.get('X-Widesend-IP') || 'unknown';
    const country = request.headers.get('X-Widesend-Country') || '';
    void this.queueAudit((db) =>
      recordRoomConnection(db, room.activity, connection, hello.member, ip, country),
    ).catch(() => {});
    if (status === 'pending') this.startRound(room, pair[1]);
    else {
      this.broadcastRoster(room);
      if (status === 'owner')
        for (const pending of this.pendingSockets()) this.startRound(room, pending);
    }
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { 'Sec-WebSocket-Protocol': ROOM_PROTOCOL },
    });
  }

  private async scheduleAlarm(state: RoomState): Promise<void> {
    const now = Date.now();
    const pendingDeadline = Math.min(
      Infinity,
      ...this.pendingSockets().map((s) => this.attachment(s).since + JOIN_WAIT_MS),
    );
    await this.ctx.storage.setAlarm(
      Math.min(state.expires, pendingDeadline, this.sockets().length ? now + RENEW_MS : Infinity),
    );
  }
  async alarm(): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.state();
      if (!state) {
        await this.ctx.storage.deleteAll();
        return;
      }
      const now = Date.now();
      if (state.expires <= now) {
        await this.expire(state);
        return;
      }
      for (const ws of this.pendingSockets())
        if (this.attachment(ws).since + JOIN_WAIT_MS <= now)
          this.terminate(ws, CLOSE.expired, 'Join request expired');
      if (!state.ended) {
        for (const ws of this.sockets()) {
          await this.flushUsage(ws, true);
          const a = this.attachment(ws);
          const admission = await guard(this.env).reserve({
            room: `share:${a.locator}`,
            role: a.member,
            credential: a.credential,
            owner: state.ownerCredential,
            expires: state.expires,
            network: a.network,
            connection: a.connection,
            newSession: false,
          });
          if (!admission.allowed) {
            this.send(ws, { type: 'limited', retryAfter: admission.retryAfter });
            this.terminate(ws, CLOSE.limited, 'Please wait before reconnecting');
          }
        }
      }
      await this.scheduleAlarm(state);
    });
  }
  private async expire(state: RoomState): Promise<void> {
    for (const ws of this.sockets()) this.terminate(ws, CLOSE.expired, 'Room expired');
    const at = Date.now();
    if (!state.ended)
      void this.queueAudit((db) => recordRoomEnded(db, state.activity, 'expired', at)).catch(
        () => {},
      );
    await this.ctx.storage.deleteAll();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.countUsage(ws, 1);
    try {
      if (typeof message !== 'string') await this.handleBinary(ws, message);
      else if (message.length > MAX_TEXT) throw new Error('Message too large');
      else await this.handleText(ws, JSON.parse(message));
    } catch (error) {
      const a = this.attachment(ws);
      logError('room-message-rejected', {
        member: short(a.member),
        connection: short(a.connection),
        status: a.status,
        type:
          typeof message === 'string'
            ? (/"type":"([a-z-]{1,24})"/.exec(message)?.[1] ?? '?')
            : 'binary',
        error: errorText(error),
      });
      this.terminate(ws, CLOSE.invalid, 'Invalid message');
    } finally {
      this.ctx.waitUntil(this.flushUsage(ws));
    }
  }
  // Cumulative per-connection counters live in the socket attachment and reach the
  // guard's relay statistics without a write per frame.
  private countUsage(ws: WebSocket, messages: number, bytes = 0): void {
    const a = this.attachment(ws),
      day = utcDay(Date.now());
    const usage = (a.usage ?? []).filter((s) => s.day >= day - 86_400_000);
    let current = usage.find((s) => s.day === day);
    if (!current) usage.push((current = { day, messages: 0, bytes: 0 }));
    current.messages += messages;
    current.bytes += bytes;
    ws.serializeAttachment({ ...a, usage } satisfies Attachment);
  }
  private async flushUsage(ws: WebSocket, force = false): Promise<void> {
    const a = this.attachment(ws);
    if (!a.usage?.length) return;
    const total = a.usage.reduce((sum, s) => sum + s.messages, 0);
    if (
      !force &&
      Date.now() - (a.usageSentAt ?? 0) < 30_000 &&
      total - (a.usageSentMessages ?? 0) < 512
    )
      return;
    try {
      ws.serializeAttachment({ ...a, usageSentAt: Date.now(), usageSentMessages: total });
    } catch {
      /* A closed socket keeps its last attachment; the snapshot below still counts. */
    }
    try {
      await guard(this.env).recordUsage(a.connection, a.usage);
    } catch {
      // Snapshots are cumulative; a later flush retries. Monitoring never blocks relay.
    }
  }
  private memberSocket(member: string): WebSocket | undefined {
    return this.admittedSockets().find((s) => this.attachment(s).member === member);
  }
  // Destinations drain what they have processed. A slow browser is skipped for
  // fan-out rather than letting one member stall everyone else.
  private reserveBacklog(ws: WebSocket, bytes: number): boolean {
    const a = this.attachment(ws);
    if ((a.backlog ?? 0) + bytes > DESTINATION_BACKLOG) return false;
    ws.serializeAttachment({ ...a, backlog: (a.backlog ?? 0) + bytes } satisfies Attachment);
    return true;
  }
  private async admitRelay(
    ws: WebSocket,
    state: RoomState,
    offer: string | null,
  ): Promise<boolean> {
    const key = `relay:${offer ?? 'control'}`;
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<boolean>(key)) return true;
      let decision;
      try {
        await Promise.all(this.sockets().map((s) => this.flushUsage(s, true)));
        decision = await guard(this.env).admitRelay(
          // Credentials are browser-generated: bind the approval to this room,
          // its owner and expiry so it can't be reused anywhere else.
          await activityId(
            `share-relay:${state.locator}:${state.ownerCredential}:${state.expires}:${key}`,
          ),
          state.expires,
        );
      } catch {
        decision = { allowed: false as const, retryAfter: 60 };
      }
      if (!decision.allowed) {
        this.send(ws, { type: 'relay-limited', offer, retryAfter: decision.retryAfter });
        return false;
      }
      await this.ctx.storage.put(key, true);
      return true;
    });
  }
  private async handleBinary(ws: WebSocket, buffer: ArrayBuffer): Promise<void> {
    const a = this.attachment(ws);
    if (a.status === 'pending') throw new Error('Not allowed');
    const state = await this.state();
    if (!state || state.ended || state.expires <= Date.now()) return;
    const frame = decodeClientFrame(buffer);
    if (frame.kind === 0) {
      const control = (a.control ?? 0) + frame.payload.length;
      ws.serializeAttachment({ ...this.attachment(ws), control } satisfies Attachment);
      if (control > CONTROL_ALLOWANCE && !(await this.admitRelay(ws, state, null))) return;
      const destination = frame.to === a.member ? undefined : this.memberSocket(frame.to);
      if (!destination) return;
      const out = encodeForward(0, a.member, frame.payload);
      // Control frames are small and capped per connection: counted in the
      // backlog but never refused, so answers and keys are never lost here.
      const d = this.attachment(destination);
      destination.serializeAttachment({
        ...d,
        backlog: (d.backlog ?? 0) + out.length,
      } satisfies Attachment);
      destination.send(out);
      this.countUsage(ws, 0, frame.payload.length);
      return;
    }
    const offer = pieceOfferId(frame.payload);
    if (!(await this.ctx.storage.get<boolean>(`relay:${offer}`))) {
      this.send(ws, { type: 'relay-limited', offer, retryAfter: 0 });
      return;
    }
    const header = new DataView(frame.payload.buffer, frame.payload.byteOffset);
    const out = encodeForward(1, a.member, frame.payload);
    const skipped: string[] = [];
    for (const id of frame.to) {
      const destination = id === a.member ? undefined : this.memberSocket(id);
      if (!destination) continue;
      if (this.reserveBacklog(destination, out.length)) destination.send(out);
      else skipped.push(id);
    }
    if (skipped.length)
      this.send(ws, {
        type: 'relay-skipped',
        offer,
        file: header.getUint16(17),
        piece: header.getUint32(19),
        to: skipped,
      });
    // One upload, one count: fan-out copies are outgoing and cost nothing extra.
    this.countUsage(ws, 0, frame.payload.length);
  }
  private async handleText(ws: WebSocket, m: Record<string, unknown>): Promise<void> {
    const a = this.attachment(ws);
    const state = await this.state();
    if (!state || state.ended || state.expires <= Date.now()) {
      this.terminate(ws, state?.ended ? CLOSE.dismissed : CLOSE.expired, 'Room closed');
      return;
    }
    if (a.status === 'pending') {
      if (m.type !== 'join-kex' || !validKeyMessage(m.message)) throw new Error('Not allowed');
      const current = this.attachment(ws);
      if (!current.round || m.message.round !== current.round) return; // stale round
      if ((current.joinerKex ?? 0) >= 2) throw new Error('Too many key messages');
      ws.serializeAttachment({ ...current, joinerKex: (current.joinerKex ?? 0) + 1 });
      const owner = this.ownerSocket(state);
      if (owner) this.send(owner, { type: 'join-kex', from: a.member, message: m.message });
      return;
    }
    const isOwner = a.status === 'owner';
    switch (m.type) {
      case 'join-kex': {
        if (!isOwner || !validMemberId(m.to) || !validKeyMessage(m.message))
          throw new Error('Not allowed');
        const pending = this.pendingSockets().find((s) => this.attachment(s).member === m.to);
        if (!pending) return;
        const p = this.attachment(pending);
        if (!p.round || m.message.round !== p.round) return;
        if ((p.ownerKex ?? 0) >= 2) throw new Error('Too many key messages');
        pending.serializeAttachment({ ...p, ownerKex: (p.ownerKex ?? 0) + 1 });
        this.send(pending, { type: 'join-kex', message: m.message });
        return;
      }
      case 'admit': {
        if (!isOwner || !validMemberId(m.id) || !validKey(m.key) || !validSignature(m.cert))
          throw new Error('Not allowed');
        const pending = this.pendingSockets().find((s) => this.attachment(s).member === m.id);
        if (!pending) return;
        if (Object.keys(state.members).length >= state.settings.size) {
          this.terminate(pending, CLOSE.full, 'Room full');
          return;
        }
        const p = this.attachment(pending);
        state.members[p.member] = {
          credential: p.credential,
          name: p.name,
          key: m.key,
          cert: m.cert,
          role: 'member',
          joined: Date.now(),
        };
        await this.save(state);
        const joined = state.members[p.member].joined;
        void this.queueAudit((db) =>
          recordMember(db, state.activity, { id: p.member, name: p.name, role: 'member', joined }),
        ).catch(() => {});
        pending.serializeAttachment({ ...p, status: 'member' } satisfies Attachment);
        this.send(pending, { type: 'admitted' });
        this.broadcastRoster(state);
        return;
      }
      case 'deny': {
        if (!isOwner || !validMemberId(m.id)) throw new Error('Not allowed');
        for (const pending of this.pendingSockets())
          if (this.attachment(pending).member === m.id)
            this.terminate(pending, CLOSE.declined, 'Declined');
        return;
      }
      case 'settings': {
        if (!isOwner) throw new Error('Not allowed');
        try {
          state.settings = validateSettings(
            m.settings,
            this.limits,
            Object.keys(state.members).length,
          );
        } catch {
          this.send(ws, { type: 'settings-rejected' });
          return;
        }
        await this.save(state);
        this.broadcastRoster(state);
        return;
      }
      case 'remove': {
        if (!isOwner || !validMemberId(m.id) || m.id === state.owner)
          throw new Error('Not allowed');
        if (state.members[m.id]) {
          delete state.members[m.id];
          if (!state.revoked.includes(m.id)) state.revoked.push(m.id);
          await this.save(state);
          const removed = m.id,
            at = Date.now();
          void this.queueAudit((db) =>
            recordMemberLeft(db, state.activity, removed, 'removed', at),
          ).catch(() => {});
        }
        for (const s of this.socketsOf(m.id)) this.terminate(s, CLOSE.removed, 'Removed');
        this.broadcastRoster(state);
        return;
      }
      case 'relay-request': {
        if (!validMemberId(m.offer)) throw new Error('Invalid offer');
        if (await this.admitRelay(ws, state, m.offer))
          this.send(ws, { type: 'relay-admitted', offer: m.offer });
        return;
      }
      case 'drain': {
        const bytes = m.bytes as number;
        if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 64 * (MAX_PIECE_MESSAGE + 17))
          throw new Error('Invalid drain');
        const current = this.attachment(ws);
        ws.serializeAttachment({
          ...current,
          backlog: Math.max(0, (current.backlog ?? 0) - bytes),
        } satisfies Attachment);
        return;
      }
      case 'audit': {
        const { id, report: reported } = validateRoomAudit(m);
        const report =
          this.env.RECORD_FILE_NAMES === false ? roomReportWithoutNames(reported) : reported;
        const ack = () => this.send(ws, { type: 'audit-ack', id });
        if (!this.env.ACTIVITY) return ack();
        // Offers may only name current members other than the sender.
        if (
          report.event === 'offer' &&
          report.recipients.some((r) => r === a.member || !state.members[r])
        )
          return;
        const current = this.attachment(ws);
        if ((current.reports ?? 0) >= 512) return;
        const key =
          report.event === 'offer'
            ? `${a.member}:offer:${report.offer}`
            : report.event === 'messages'
              ? `${a.member}:messages:${report.count}`
              : `${a.member}:delivery:${report.offer}:${report.recipient}:${report.status}:${report.route}`;
        if (this.recentReports.has(key) || (await this.ctx.storage.get<boolean>(`audit:${key}`)))
          return ack();
        if (this.pendingReports.has(key) || this.pendingReports.size >= 16) return;
        // The room's lifetime budget lives in storage, so reconnecting can't reset it.
        // Rooms created before message counts have no `messages` entry yet.
        const budget = {
          offers: 0,
          files: 0,
          deliveries: 0,
          messages: 0,
          ...(await this.ctx.storage.get<Partial<typeof ROOM_AUDIT_BUDGET>>('audit-budget')),
        };
        if (report.event === 'messages') {
          if (budget.messages + 1 > ROOM_AUDIT_BUDGET.messages) return ack();
          budget.messages++;
        } else if (report.event === 'offer') {
          if (
            budget.offers + 1 > ROOM_AUDIT_BUDGET.offers ||
            budget.files + report.files.length > ROOM_AUDIT_BUDGET.files
          )
            return ack();
          budget.offers++;
          budget.files += report.files.length;
        } else {
          if (budget.deliveries + 1 > ROOM_AUDIT_BUDGET.deliveries) return ack();
          budget.deliveries++;
        }
        await this.ctx.storage.put('audit-budget', budget);
        this.pendingReports.add(key);
        ws.serializeAttachment({ ...current, reports: (current.reports ?? 0) + 1 });
        void this.queueAudit(async (db) => {
          await recordRoomReport(db, state.activity, a.member, report);
          await this.ctx.storage.put(`audit:${key}`, true);
        })
          .then(() => {
            this.recentReports.add(key);
            if (this.recentReports.size > 512)
              this.recentReports.delete(this.recentReports.values().next().value!);
            ack();
          })
          .catch(() => this.send(ws, { type: 'audit-unavailable' }))
          .finally(() => this.pendingReports.delete(key));
        return;
      }
      case 'leave': {
        if (isOwner) throw new Error('Not allowed');
        await this.flushUsage(ws, true);
        delete state.members[a.member];
        await this.save(state);
        const at = Date.now();
        void this.queueAudit((db) =>
          recordMemberLeft(db, state.activity, a.member, 'left', at),
        ).catch(() => {});
        this.terminate(ws, CLOSE.left, 'Left');
        this.broadcastRoster(state);
        return;
      }
      case 'dismiss': {
        if (!isOwner) throw new Error('Not allowed');
        state.ended = 'dismissed';
        state.members = {};
        await this.save(state);
        const at = Date.now();
        void this.queueAudit((db) => recordRoomEnded(db, state.activity, 'dismissed', at)).catch(
          () => {},
        );
        await Promise.all(this.sockets().map((s) => this.flushUsage(s, true)));
        for (const s of this.sockets()) this.terminate(s, CLOSE.dismissed, 'Room dismissed');
        return;
      }
    }
    throw new Error('Unknown message');
  }

  async webSocketClose(ws: WebSocket, code: number, reason = ''): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Connection closed');
    } catch {
      /* Already closed. */
    }
    const a = this.attachment(ws);
    this.ctx.waitUntil(this.flushUsage(ws, true));
    this.ctx.waitUntil(guard(this.env).release(`share:${a.locator}`, a.member, a.connection));
    this.recordClose(ws, browserClose(code, reason));
    const state = await this.state();
    if (!state || state.ended) return;
    const remaining = this.socketsOf(a.member).filter((s) => s !== ws);
    if (remaining.length) return; // replaced by a newer connection
    if (a.status === 'pending') {
      const owner = this.ownerSocket(state);
      if (owner) this.send(owner, { type: 'join-cancelled', id: a.member });
      this.broadcastRoster(state);
      return;
    }
    this.broadcastRoster(state);
    if (a.status === 'owner')
      for (const pending of this.pendingSockets()) {
        pending.serializeAttachment({ ...this.attachment(pending), round: undefined });
        this.send(pending, { type: 'pending', ownerOnline: false });
      }
  }
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1011, errorText(error));
  }
}
