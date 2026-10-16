import { KeySession, PAIRING_ERROR, createIdentity, type DeviceIdentity } from '../key-session';
import { pairingCode, token } from '../crypto';
import {
  CLOSE,
  JOIN_WAIT_MS,
  ROOM_MS,
  shareLocator,
  validMemberId,
  type RoomHello,
  type RoomSettings,
  type Roster,
  type RosterMember,
} from '../../shared/room';
import { signCertificate, verifyCertificate } from './identity';
import { RoomClient, type Forwarded } from './client';
import type { MembershipRecord, RoomEnvironment } from './environment';
import { Transfers, type IncomingView, type OutgoingView } from './transfers';
import { Messages } from './messages';
import { Conversation, type TimelineEntry } from './conversation';
import { canSend } from '../../shared/room';

export type EndReason =
  | 'dismissed'
  | 'removed'
  | 'declined'
  | 'full'
  | 'not-found'
  | 'expired'
  | 'left'
  | 'locked'
  | 'failed'
  | 'owner-offline';
export type MemberView = {
  id: string;
  name: string;
  owner: boolean;
  me: boolean;
  online: boolean;
};
export type JoinRequestView = { id: string; name: string; verified: boolean };
export type RoomSnapshot = {
  phase: 'connecting' | 'pending' | 'in-room' | 'ended';
  connection: 'online' | 'reconnecting';
  pending?: 'verifying' | 'approval' | 'owner-offline';
  ended?: EndReason;
  message?: string;
  code: string;
  locator: string;
  me: string;
  name: string;
  isOwner: boolean;
  owner?: string;
  settings?: RoomSettings;
  expires: number;
  members: MemberView[];
  requests: JoinRequestView[];
  outgoing: OutgoingView[];
  incoming: IncomingView[];
  // The conversation: messages and files in the order this device saw them.
  timeline: TimelineEntry[];
  // False when this browser can't keep history.
  history: boolean;
};
// Membership is forgotten for these; other endings keep it for a later rejoin.
const forget: EndReason[] = ['dismissed', 'removed', 'expired', 'left', 'not-found'];
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

type JoinRequest = {
  name: string;
  round: string;
  session?: KeySession;
  key?: string;
  verified: boolean;
};
type Setup =
  | { kind: 'create'; name: string; settings: RoomSettings }
  | { kind: 'join'; code: string; name: string }
  | { kind: 'restore'; record: MembershipRecord };

// The room controller: membership, roster verification and owner controls.
export class Room {
  snapshot: RoomSnapshot;
  private listeners = new Set<(s: RoomSnapshot) => void>();
  private client?: RoomClient;
  private identity?: DeviceIdentity;
  private credential = token(32);
  private ownerKey?: string;
  private role: 'owner' | 'member' = 'member';
  private admitted = false;
  private creating = 0;
  private roster?: Roster;
  private verifiedCerts = new Map<string, boolean>();
  private verified = new Map<string, RosterMember>();
  private joinSession?: KeySession;
  private requests = new Map<string, JoinRequest>();
  private release?: () => void;
  private joinTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private greeted = false;
  private welcomed = false;
  private refused = 0;
  private transfers: Transfers;
  private messages: Messages;
  private conversation: Conversation;
  protected constructor(
    protected env: RoomEnvironment,
    private setup: Setup,
  ) {
    const record = setup.kind === 'restore' ? setup.record : undefined;
    this.snapshot = {
      phase: 'connecting',
      connection: 'reconnecting',
      code: record?.code ?? (setup.kind === 'join' ? setup.code : ''),
      locator: record?.locator ?? '',
      me: record?.member ?? hex(crypto.getRandomValues(new Uint8Array(16))),
      name: record?.name ?? (setup.kind === 'restore' ? '' : setup.name),
      isOwner: setup.kind === 'create' || record?.role === 'owner',
      expires: record?.expires ?? 0,
      members: [],
      requests: [],
      outgoing: [],
      incoming: [],
      timeline: [],
      history: true,
    };
    const online = (id: string) => !!this.verified.get(id)?.online;
    this.conversation = new Conversation({
      env,
      me: () => this.snapshot.me,
      locator: () => this.snapshot.locator,
      online,
      report: (key, report) => this.transfers.reportActivity(key, report),
      changed: () => this.refresh(),
    });
    this.messages = new Messages({
      me: () => this.snapshot.me,
      member: (id) => {
        const m = this.verified.get(id);
        return m && { online: m.online };
      },
      allowed: (from, to) => {
        const { settings, owner } = this.snapshot;
        return !!settings && !!owner && canSend(settings, owner, from, to);
      },
      send: (peer, message) => this.transfers.sendLink(peer, message),
      save: (message) => this.conversation.saveText(message),
      known: (id) => this.conversation.has(id),
      changed: () => this.refresh(),
    });
    this.transfers = new Transfers({
      env,
      me: () => this.snapshot.me,
      locator: () => this.snapshot.locator,
      owner: () => this.snapshot.owner,
      settings: () => this.snapshot.settings,
      identity: () => this.identity!,
      member: (id) => {
        const m = this.verified.get(id);
        return m && { key: m.key, name: m.name, online: m.online };
      },
      members: () => [...this.verified.values()].map((m) => ({ id: m.id, online: m.online })),
      sendText: (value) => this.client?.send(value) ?? false,
      sendBinary: (bytes) => this.client?.sendBinary(bytes) ?? false,
      relayBuffered: () => this.client?.bufferedAmount ?? 0,
      changed: () => this.refresh(),
      linkMessage: (peer, message) => this.messages.receive(peer, message),
      linkReady: (peer) => this.messages.ready(peer),
      wantsLink: (peer) => this.messages.pending(peer),
    });
    if (record) {
      this.identity = record.identity;
      this.credential = record.credential;
      this.ownerKey = record.ownerKey;
      this.role = record.role;
      this.admitted = true;
    }
  }
  static create(env: RoomEnvironment, options: { name: string; settings: RoomSettings }) {
    return new this(env, { kind: 'create', ...options });
  }
  static join(env: RoomEnvironment, options: { code: string; name: string }) {
    return new this(env, { kind: 'join', ...options });
  }
  // The most recent room, or the one at `locator`, if this device is still in it.
  static async restore(env: RoomEnvironment, locator?: string): Promise<Room | undefined> {
    const record = locator ? await env.store.get(locator) : await env.store.latest();
    return record && record.expires > Date.now()
      ? new this(env, { kind: 'restore', record })
      : undefined;
  }
  subscribe(listener: (s: RoomSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  protected update(patch: Partial<RoomSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private refresh(): void {
    const views = this.transfers.views();
    this.conversation.track(views.outgoing, views.incoming);
    this.update({
      ...views,
      timeline: this.conversation.entries(views.outgoing, views.incoming),
      history: this.conversation.available,
    });
  }

  async start(): Promise<void> {
    try {
      this.identity ??= await createIdentity();
      const hello = await this.firstHello();
      // History first, so messages that arrive are checked against it.
      this.messages.load(await this.conversation.load());
      this.refresh();
      if (this.env.lock) {
        this.release = await this.env.lock(`widesend-room-${this.snapshot.locator}`);
        if (!this.release) return this.end('locked');
      }
      this.client = new RoomClient(this.env, this.snapshot.locator, hello, {
        text: (m) => this.text(m),
        binary: (f) => this.binary(f),
        closed: (code) => this.closed(code),
        connection: (online) => {
          this.update({ connection: online ? 'online' : 'reconnecting' });
          this.transfers.connection(online);
        },
      });
      this.client.connect();
    } catch {
      this.end('failed', 'Could not start the room connection');
    }
  }
  private async firstHello(): Promise<RoomHello> {
    const { me, name } = this.snapshot;
    if (this.setup.kind === 'restore')
      return { v: 1, role: 'rejoin', member: me, credential: this.credential };
    if (this.setup.kind === 'join') {
      this.update({ locator: await shareLocator(this.snapshot.code) });
      return {
        v: 1,
        role: 'join',
        code: this.snapshot.code,
        member: me,
        credential: this.credential,
        name,
      };
    }
    const code = pairingCode();
    const locator = await shareLocator(code);
    // Stay safely inside the Worker's 24-hour limit despite clock differences.
    const expires = Date.now() + ROOM_MS - 5 * 60_000;
    const cert = await signCertificate(this.identity!.privateKey, {
      locator,
      member: me,
      role: 'owner',
      name,
      key: this.identity!.publicKey,
      expires,
    });
    this.role = 'owner';
    this.ownerKey = this.identity!.publicKey;
    this.update({ code, locator, expires });
    return {
      v: 1,
      role: 'create',
      code,
      member: me,
      credential: this.credential,
      name,
      key: this.identity!.publicKey,
      cert,
      expires,
      settings: (this.setup as { settings: RoomSettings }).settings,
    };
  }
  private rejoinHello(): RoomHello {
    return { v: 1, role: 'rejoin', member: this.snapshot.me, credential: this.credential };
  }
  private async remember(): Promise<void> {
    await this.env.store.put({
      locator: this.snapshot.locator,
      code: this.snapshot.code,
      member: this.snapshot.me,
      credential: this.credential,
      name: this.snapshot.name,
      role: this.role,
      identity: this.identity!,
      ownerKey: this.ownerKey!,
      expires: this.snapshot.expires,
      updated: Date.now(),
    });
  }

  private async text(m: Record<string, unknown>): Promise<void> {
    switch (m.type) {
      case 'welcome':
        this.welcomed = true;
        this.client!.connected();
        this.update({
          expires: m.expires as number,
          code: (m.code as string) ?? this.snapshot.code,
        });
        if (m.status === 'pending') {
          this.update({ phase: 'pending', pending: 'verifying' });
          clearTimeout(this.joinTimer);
          this.joinTimer = setTimeout(() => {
            if (this.snapshot.phase === 'pending')
              this.end('owner-offline', 'Room creator stayed offline for 10 minutes');
          }, JOIN_WAIT_MS);
        } else if (this.role === 'owner') {
          await this.remember();
          this.client!.setHello(this.rejoinHello());
        }
        return;
      case 'pending':
        return this.pendingUpdate(m);
      case 'join-kex':
        return this.role === 'owner' ? this.ownerKex(m) : this.joinerKex(m);
      case 'join-request':
        return this.joinRequest(m);
      case 'join-cancelled':
        this.requests.get(m.id as string)?.session?.destroy();
        this.requests.delete(m.id as string);
        return this.publishRequests();
      case 'roster':
        return this.handleRoster(m as unknown as Roster);
      case 'settings-rejected':
        return this.update({ message: 'The room settings could not be changed.' });
      case 'limited':
        this.client!.cooldown(Number(m.retryAfter) || 60);
        return this.update({
          message: 'WideSend is busy. Keep this tab open; we’ll retry automatically.',
        });
    }
    this.transfers.text(m);
  }
  private binary(frame: Forwarded): void {
    this.transfers.binary(frame);
  }
  // Text: see Messages. Files: see Transfers for offers, links and the piece engine.
  sendMessage(text: string, recipients: string[]): Promise<string> {
    if (this.snapshot.phase !== 'in-room') return Promise.reject(new Error('Join the room first.'));
    return this.messages.send(text, recipients);
  }
  send(files: File[], recipients: string[]): Promise<string> {
    if (this.snapshot.phase !== 'in-room') return Promise.reject(new Error('Join the room first.'));
    // Record the item now: the page may close before the next refresh.
    return this.transfers.send(files, recipients).then((id) => {
      this.refresh();
      return id;
    });
  }
  accept(offer: string): Promise<void> {
    return this.transfers.accept(offer);
  }
  decline(offer: string): void {
    this.transfers.decline(offer);
  }
  cancelOutgoing(offer: string, recipient?: string): void {
    this.transfers.cancelOutgoing(offer, recipient);
  }
  cancelIncoming(offer: string): void {
    this.transfers.cancelIncoming(offer);
  }

  private async pendingUpdate(m: Record<string, unknown>): Promise<void> {
    this.joinSession?.destroy();
    this.joinSession = undefined;
    if (!m.ownerOnline || typeof m.round !== 'string') {
      this.update({ phase: 'pending', pending: 'owner-offline' });
      return;
    }
    this.update({ phase: 'pending', pending: 'verifying' });
    const { code, locator, me, name, expires } = this.snapshot;
    this.joinSession = await KeySession.start(
      code,
      'receive',
      this.identity!,
      this.env.origin,
      `share:${locator}:${me}:${name}`,
      expires,
      m.round,
    );
    this.client!.send({ type: 'join-kex', message: this.joinSession.share });
  }
  private async joinerKex(m: Record<string, unknown>): Promise<void> {
    const session = this.joinSession;
    const message = m.message as Parameters<KeySession['receiveShare']>[0];
    if (!session || message?.round !== session.round) return;
    try {
      if (message.step === 'share')
        this.client!.send({ type: 'join-kex', message: await session.receiveShare(message) });
      else {
        const { peerKey } = await session.confirm(message);
        this.ownerKey = peerKey;
        this.update({ pending: 'approval' });
      }
    } catch {
      this.update({ message: PAIRING_ERROR });
      this.end('failed', 'Key check with the room creator failed');
    }
  }
  private async joinRequest(m: Record<string, unknown>): Promise<void> {
    const id = m.id as string;
    if (this.role !== 'owner' || !validMemberId(id) || typeof m.round !== 'string') return;
    this.requests.get(id)?.session?.destroy();
    const request: JoinRequest = { name: String(m.name), round: m.round, verified: false };
    this.requests.set(id, request);
    this.publishRequests();
    const { code, locator, expires } = this.snapshot;
    request.session = await KeySession.start(
      code,
      'send',
      this.identity!,
      this.env.origin,
      `share:${locator}:${id}:${request.name}`,
      expires,
      m.round,
    );
    if (this.requests.get(id) === request)
      this.client!.send({ type: 'join-kex', to: id, message: request.session.share });
  }
  private async ownerKex(m: Record<string, unknown>): Promise<void> {
    const id = m.from as string;
    const request = this.requests.get(id);
    const message = m.message as Parameters<KeySession['receiveShare']>[0];
    if (!request?.session || message?.round !== request.round) return;
    try {
      if (message.step === 'share')
        this.client!.send({
          type: 'join-kex',
          to: id,
          message: await request.session.receiveShare(message),
        });
      else {
        request.key = (await request.session.confirm(message)).peerKey;
        request.verified = true;
        this.publishRequests();
        if (this.snapshot.settings?.join === 'auto') await this.approve(id);
      }
    } catch {
      this.deny(id);
    }
  }
  private publishRequests(): void {
    this.update({
      requests: [...this.requests].map(([id, r]) => ({ id, name: r.name, verified: r.verified })),
    });
  }
  async approve(id: string): Promise<void> {
    const request = this.requests.get(id);
    if (!request?.verified || !request.key) return;
    this.requests.delete(id);
    const cert = await signCertificate(this.identity!.privateKey, {
      locator: this.snapshot.locator,
      member: id,
      role: 'member',
      name: request.name,
      key: request.key,
      expires: this.snapshot.expires,
    });
    this.client?.send({ type: 'admit', id, key: request.key, cert });
    this.publishRequests();
  }
  deny(id: string): void {
    this.requests.get(id)?.session?.destroy();
    this.requests.delete(id);
    this.client?.send({ type: 'deny', id });
    this.publishRequests();
  }
  updateSettings(settings: RoomSettings): void {
    this.client?.send({ type: 'settings', settings });
  }
  remove(id: string): void {
    this.client?.send({ type: 'remove', id });
  }
  // Leaving and closing only take effect once the room confirms them (its closing
  // notice ends the page); offline, nothing changes and the person is told.
  async leave(): Promise<void> {
    if (!this.client?.send({ type: 'leave' })) this.offline();
  }
  async dismiss(): Promise<void> {
    if (!this.client?.send({ type: 'dismiss' })) this.offline();
  }
  private offline(): void {
    this.update({ message: 'You’re offline. Try again when you’re connected.' });
  }

  private async handleRoster(roster: Roster): Promise<void> {
    if (!this.ownerKey || roster.ownerKey !== this.ownerKey) {
      // The server answered with a different room authority than the one this
      // device verified with the code: never trust it.
      if (this.admitted || this.role === 'owner')
        this.end('failed', 'The room answered with a different creator key');
      return;
    }
    this.roster = roster;
    const next = new Map<string, RosterMember>();
    for (const member of roster.members) {
      const cacheKey = `${member.id}:${member.role}:${member.name}:${member.key}:${member.cert}`;
      let valid = this.verifiedCerts.get(cacheKey);
      if (valid === undefined) {
        valid =
          validMemberId(member.id) &&
          (member.role === 'owner'
            ? member.id === roster.owner && member.key === this.ownerKey
            : member.id !== roster.owner) &&
          (await verifyCertificate(
            this.ownerKey,
            {
              locator: this.snapshot.locator,
              member: member.id,
              role: member.role,
              name: member.name,
              key: member.key,
              expires: roster.expires,
            },
            member.cert,
          ));
        this.verifiedCerts.set(cacheKey, valid);
      }
      if (valid) next.set(member.id, member);
    }
    const mine = next.get(this.snapshot.me);
    if (mine && mine.key !== this.identity!.publicKey)
      return this.end('failed', 'The room listed a different key for this member');
    if (mine && !this.admitted) {
      this.admitted = true;
      clearTimeout(this.joinTimer);
      this.joinSession = undefined;
      await this.remember();
      this.client!.setHello(this.rejoinHello());
    }
    const gone = [...this.verified.keys()].filter((id) => !next.has(id));
    this.verified = next;
    this.update({
      phase: mine ? 'in-room' : this.snapshot.phase,
      pending: mine ? undefined : this.snapshot.pending,
      owner: roster.owner,
      settings: roster.settings,
      expires: roster.expires,
      members: [...next.values()].map((m) => ({
        id: m.id,
        name: m.name,
        owner: m.role === 'owner',
        me: m.id === this.snapshot.me,
        online: m.online,
      })),
    });
    this.transfers.roster(gone);
    if (mine) {
      this.conversation.joined({
        code: this.snapshot.code,
        owner: roster.owner,
        expires: roster.expires,
        members: [...next.values()],
      });
      this.messages.roster([...next.values()], gone);
    }
    if (mine && this.setup.kind === 'restore' && !this.greeted) {
      this.greeted = true;
      this.transfers.greet();
    }
  }

  private closed(code: number): boolean {
    const pending = !this.admitted;
    switch (code) {
      case CLOSE.replaced:
        this.end('locked');
        return false;
      case CLOSE.expired:
        this.end(pending && this.role !== 'owner' ? 'owner-offline' : 'expired');
        return false;
      case CLOSE.invalid:
        this.end('failed');
        return false;
      case CLOSE.dismissed:
        this.end('dismissed');
        return false;
      case CLOSE.full:
        this.end('full');
        return false;
      case CLOSE.declined:
        this.end('declined');
        return false;
      case CLOSE.removed:
        this.end('removed');
        return false;
      case CLOSE.left:
        this.end('left');
        return false;
      case CLOSE.notFound:
        this.end('not-found');
        return false;
      case CLOSE.exists:
        // A code collision while creating: start again with a new code.
        if (this.setup.kind === 'create' && !this.admitted && ++this.creating < 3) {
          void this.firstHello().then((hello) => {
            this.client!.setHello(hello);
            this.client!.connect();
          });
          return false;
        }
        this.end('failed');
        return false;
    }
    // A handshake the server keeps refusing (never reaching welcome) won't succeed.
    if (!this.welcomed && ++this.refused >= 5) {
      this.end('failed', 'The server refused the connection 5 times');
      return false;
    }
    if (!this.stopped && this.snapshot.phase !== 'ended') {
      if (this.snapshot.phase === 'pending') this.update({ pending: 'verifying' });
      return true;
    }
    return false;
  }
  // `detail` tells the room's activity log why this page ended its connection.
  protected end(reason: EndReason, detail?: string): void {
    if (this.snapshot.phase === 'ended') return;
    this.stopped = true;
    clearTimeout(this.joinTimer);
    this.joinSession?.destroy();
    for (const request of this.requests.values()) request.session?.destroy();
    this.requests.clear();
    this.client?.stop(detail ?? `Room ended: ${reason}`);
    this.release?.();
    this.release = undefined;
    if (forget.includes(reason) && this.snapshot.locator) {
      void this.env.store.delete(this.snapshot.locator).catch(() => {});
      void this.conversation.ended(reason);
    }
    this.messages.ended();
    this.transfers.stop();
    this.refresh();
    this.update({ phase: 'ended', ended: reason, requests: [] });
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.joinTimer);
    this.joinSession?.destroy();
    this.client?.stop('Room closed on this page');
    this.release?.();
    this.release = undefined;
    this.messages.stop();
    this.transfers.stop();
    this.refresh();
    this.conversation.dispose();
  }
}
