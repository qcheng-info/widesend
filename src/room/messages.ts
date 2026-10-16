import { bytesToHex } from '@noble/hashes/utils.js';
import { MAX_FANOUT, validMemberId, validMessageText } from '../../shared/room';
import type { LinkMessage } from './link';

export type TextStatus = 'sending' | 'delivered' | 'refused' | 'failed';
export type TextMessage = {
  id: string;
  // This device's clock: when it was sent, or when it arrived.
  at: number;
  from: string;
  to: string[];
  text: string;
  // My messages: where each recipient's copy stands.
  sent?: Record<string, TextStatus>;
};
export type MessagesHost = {
  me(): string;
  member(id: string): { online: boolean } | undefined;
  allowed(from: string, to: string): boolean;
  send(peer: string, message: LinkMessage): void;
  // Resolves once the message is stored (or storing failed).
  save(message: TextMessage): Promise<void>;
  known(id: string): boolean;
  changed(): void;
};
type Wire = Extract<LinkMessage, { t: 'msg' | 'got' }>;
const RESEND_MS = 5000; // an unacknowledged message is sent again after this long
const RESENDS = 24; // per stretch of the recipient being online
const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));

// Text messages in a room: sent over each recipient's link, acknowledged, sent
// again until acknowledged, and kept waiting while a recipient is away.
export class Messages {
  private messages = new Map<string, TextMessage>();
  // My message ID → recipient → attempts in the current online stretch.
  private tries = new Map<string, Map<string, { n: number; last: number }>>();
  private online = new Set<string>();
  private ticker = setInterval(() => this.tick(), 1000);
  constructor(private host: MessagesHost) {}

  // Messages restored from history; my unacknowledged ones are sent again.
  load(messages: TextMessage[]): void {
    for (const m of messages) this.messages.set(m.id, m);
  }
  list(): TextMessage[] {
    return [...this.messages.values()];
  }
  async send(text: string, recipients: string[]): Promise<string> {
    const body = text.trim();
    if (!body) throw new Error('Write a message first.');
    if (!validMessageText(body)) throw new Error('Messages can be up to 10,000 characters.');
    const me = this.host.me();
    const to = [...new Set(recipients)];
    if (
      !to.length ||
      to.some((id) => id === me || !this.host.member(id) || !this.host.allowed(me, id))
    )
      throw new Error('This room does not allow sending to the selected members.');
    const m: TextMessage = {
      id: randomHex(16),
      at: Date.now(),
      from: me,
      to,
      text: body,
      sent: Object.fromEntries(to.map((id) => [id, 'sending' as TextStatus])),
    };
    this.messages.set(m.id, m);
    await this.host.save(m);
    for (const peer of to) this.transmit(m, peer);
    this.host.changed();
    return m.id;
  }
  private transmit(m: TextMessage, peer: string): void {
    if (!this.host.member(peer)?.online) return;
    let byPeer = this.tries.get(m.id);
    if (!byPeer) this.tries.set(m.id, (byPeer = new Map()));
    const attempt = byPeer.get(peer) ?? { n: 0, last: 0 };
    attempt.n++;
    attempt.last = Date.now();
    byPeer.set(peer, attempt);
    this.host.send(peer, { t: 'msg', id: m.id, text: m.text, to: m.to, at: m.at });
  }
  private waiting(peer: string): TextMessage[] {
    return this.list().filter((m) => m.sent?.[peer] === 'sending');
  }
  // Sends everything still waiting for `peer` now, with a fresh set of attempts.
  private resend(peer: string): void {
    for (const m of this.waiting(peer)) {
      this.tries.get(m.id)?.delete(peer);
      this.transmit(m, peer);
    }
  }

  receive(peer: string, message: Wire): void {
    if (message.t === 'got') return this.acknowledged(peer, message);
    const me = this.host.me();
    const m = message as Extract<Wire, { t: 'msg' }>;
    if (
      !this.host.member(peer) ||
      !validMemberId(m.id) ||
      !validMessageText(m.text) ||
      !Array.isArray(m.to) ||
      !m.to.length ||
      m.to.length > MAX_FANOUT ||
      !m.to.every(validMemberId) ||
      !m.to.includes(me) ||
      !Number.isSafeInteger(m.at)
    )
      return;
    if (!this.host.allowed(peer, me)) {
      this.host.send(peer, { t: 'got', id: m.id, refused: true });
      return;
    }
    const known = this.messages.get(m.id);
    if (known || this.host.known(m.id)) {
      // A repeat: the sender missed our acknowledgement.
      if (!known || known.from === peer) this.host.send(peer, { t: 'got', id: m.id });
      return;
    }
    const received: TextMessage = {
      id: m.id,
      at: Date.now(),
      from: peer,
      to: [...new Set(m.to)],
      text: m.text,
    };
    this.messages.set(m.id, received);
    // The conversation takes it in at once; acknowledge once it's stored, so an
    // acknowledged message survives a reload.
    const saved = this.host.save(received).catch(() => {});
    this.host.changed();
    void saved.then(() => this.host.send(peer, { t: 'got', id: m.id }));
  }
  private acknowledged(peer: string, got: Extract<Wire, { t: 'got' }>): void {
    const m = typeof got.id === 'string' ? this.messages.get(got.id) : undefined;
    if (!m?.sent || m.sent[peer] !== 'sending') return;
    m.sent[peer] = got.refused ? 'refused' : 'delivered';
    this.tries.get(m.id)?.delete(peer);
    void this.host.save(m).catch(() => {});
    this.host.changed();
  }

  // The link to `peer` was (re)established.
  ready(peer: string): void {
    this.resend(peer);
  }
  pending(peer: string): boolean {
    return this.waiting(peer).length > 0;
  }
  // Called with every roster: people who came back get what waited for them;
  // people who left won't get what's still waiting.
  roster(members: { id: string; online: boolean }[], gone: string[]): void {
    const now = new Set(members.filter((m) => m.online).map((m) => m.id));
    for (const id of now) if (!this.online.has(id)) this.resend(id);
    this.online = now;
    // Anyone no longer listed has left, including while this page was closed.
    const present = new Set(members.map((m) => m.id));
    const waitingFor = new Set(
      this.list().flatMap((m) =>
        Object.entries(m.sent ?? {}).flatMap(([id, status]) => (status === 'sending' ? [id] : [])),
      ),
    );
    for (const id of new Set([...gone, ...waitingFor])) if (!present.has(id)) this.fail(id);
  }
  private fail(peer?: string): void {
    for (const m of this.list()) {
      if (!m.sent) continue;
      let changed = false;
      for (const [id, status] of Object.entries(m.sent))
        if (status === 'sending' && (!peer || id === peer)) {
          m.sent[id] = 'failed';
          changed = true;
        }
      if (changed) void this.host.save(m).catch(() => {});
    }
    this.host.changed();
  }
  // The room ended for this page: nothing waiting will be delivered.
  ended(): void {
    this.fail();
    this.stop();
  }
  private tick(): void {
    const now = Date.now();
    for (const m of this.list())
      for (const [peer, status] of Object.entries(m.sent ?? {})) {
        if (status !== 'sending') continue;
        const attempt = this.tries.get(m.id)?.get(peer);
        if (!attempt || (now - attempt.last >= RESEND_MS && attempt.n < RESENDS))
          this.transmit(m, peer);
      }
  }
  stop(): void {
    clearInterval(this.ticker);
  }
}
