import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { equalBytes } from '@noble/curves/utils.js';
import { MAX_FILES, validateManifest, type FileMeta } from '../../shared/protocol';
import {
  AUTO_ACCEPT_BYTES,
  PIECE_SIZE,
  canSend,
  encodeFanout,
  encodeUnicast,
  type DeliveryRoute,
  type DeliveryStatus,
  type RoomReport,
  type RoomSettings,
} from '../../shared/room';
import type { SavedFile } from '../storage';
import type { DeviceIdentity } from '../key-session';
import type { ReceiveSink, RoomEnvironment } from './environment';
import type { Forwarded } from './client';
import { signOffer, validateOffer, verifyOffer, type SignedOffer } from './identity';
import { Link, type LinkHost, type LinkMessage, type Route } from './link';
import {
  decodePiece,
  decryptPiece,
  encodePiece,
  encryptPiece,
  importContentKey,
  leafHash,
  pieceBounds,
  pieceCount,
  verifyProof,
  PieceCache,
  type PieceMessage,
} from './pieces';
import { PreparedCache, type Prepared } from './prepare';
import { Reporter } from './reporter';
import { publicError } from '../messages';
import { historyFolder } from './history';

const WINDOW = 8; // pieces requested ahead per delivery (4 MiB)
const STALE_MS = 20_000; // re-request a piece after this long without data
const OFFLINE_MS = 60_000; // a peer gone this long fails deliveries that are moving data
const IN_FLIGHT_MS = 5000; // a fan-out copy already on its way satisfies a request
const CACHE = 32; // encrypted pieces kept for fan-out and repeats
const RESEND_MS = 5000; // answers are repeated until acknowledged
const RESENDS = 24;

export type TransferHost = {
  env: RoomEnvironment;
  me(): string;
  locator(): string;
  owner(): string | undefined;
  settings(): RoomSettings | undefined;
  identity(): DeviceIdentity;
  member(id: string): { key: string; name: string; online: boolean } | undefined;
  members(): { id: string; online: boolean }[];
  sendText(value: unknown): boolean;
  sendBinary(bytes: Uint8Array): boolean;
  relayBuffered(): number;
  changed(): void;
  // Links also carry conversation messages, which Transfers hands on.
  linkMessage?(peer: string, message: Extract<LinkMessage, { t: 'msg' | 'got' }>): void;
  linkReady?(peer: string): void;
  // Whether something else waits for a link to this member.
  wantsLink?(peer: string): boolean;
};
export type RecipientView = {
  id: string;
  name: string;
  status: DeliveryStatus;
  transferred: number;
  route: DeliveryRoute;
  message?: string;
};
export type OutgoingView = {
  id: string;
  files: FileMeta[];
  total: number;
  preparing?: number;
  recipients: RecipientView[];
  // The files being sent, and their fingerprints once checked.
  sources: File[];
  sha256?: string[];
};
export type IncomingView = {
  id: string;
  // Where its files are kept on this device.
  folder: string;
  from: string;
  fromName: string;
  files: FileMeta[];
  total: number;
  status: DeliveryStatus;
  transferred: number;
  speed: number;
  route: DeliveryRoute;
  saved: SavedFile[];
  message?: string;
};
type Delivery = {
  id: string;
  // Kept so the offer still says who it was for after they leave the room.
  name: string;
  status: DeliveryStatus;
  route: DeliveryRoute;
  queue: string[];
  queued: Set<string>;
  // Pieces this recipient asked for; only these are re-sent after a relay skip.
  requested: Set<string>;
  sentAt: Map<string, number>;
  sent: number;
  file: number;
  horizon: number;
  offered: number;
  message?: string;
};
type Outgoing = {
  id: string;
  sources: File[];
  files: FileMeta[];
  total: number;
  prepareBytes: number;
  prepared?: Prepared[];
  offer?: SignedOffer;
  rawKey: Uint8Array;
  key?: CryptoKey;
  recipients: Map<string, Delivery>;
  relay: 'none' | 'requested' | 'admitted' | 'limited';
  relayAt: number;
};
type Incoming = {
  offer: SignedOffer;
  from: string;
  fromName: string;
  status: DeliveryStatus;
  route: DeliveryRoute;
  received: number;
  key?: CryptoKey;
  sink?: ReceiveSink;
  file: number;
  have: Set<number>;
  next: number;
  requested: Map<number, number>;
  failures: Map<number, number>;
  transferred: number;
  samples: [number, number][];
  saved: SavedFile[];
  work: Promise<void>;
  message?: string;
  // The last answer to the sender (accept, decline, done, cancel), repeated until
  // the sender acknowledges it: link frames can be lost while a peer reconnects.
  answer?: { message: LinkMessage; sent: number; tries: number };
};
const terminal = (s: DeliveryStatus) => ['declined', 'complete', 'failed', 'cancelled'].includes(s);
const active = (s: DeliveryStatus) => ['offered', 'accepted', 'transferring'].includes(s);
// Offers and answers wait for someone who is away; only data in flight times out.
const inFlight = (s: DeliveryStatus) => s === 'transferring';
const randomHex = (bytes: number) => bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
class SourceChanged extends Error {}

// File sharing inside a room: signed offers, links to members, and the piece
// engine (the original sender serves pieces; relay copies fan out).
export class Transfers {
  private links = new Map<string, Link>();
  private outgoing = new Map<string, Outgoing>();
  private incoming = new Map<string, Incoming>();
  private prepared = new PreparedCache();
  private cache = new PieceCache(CACHE);
  private offline = new Map<string, number>();
  private reporter: Reporter;
  private pumping = false;
  private wake?: ReturnType<typeof setTimeout>;
  private publish?: ReturnType<typeof setTimeout>;
  private ticker: ReturnType<typeof setInterval>;
  private stopped = false;
  private linkHost: LinkHost;
  constructor(private host: TransferHost) {
    this.reporter = new Reporter((value) => host.sendText(value));
    this.ticker = setInterval(() => this.tick(), 1000);
    const self = this;
    this.linkHost = {
      get me() {
        return host.me();
      },
      get locator() {
        return host.locator();
      },
      get identity() {
        return host.identity();
      },
      rtc: host.env.rtc,
      peerKey: (peer) => host.member(peer)?.key,
      relay: (peer, payload) => host.sendBinary(encodeUnicast(peer, payload)),
      message: (peer, message, via) => self.message(peer, message, via),
      piece: (peer, bytes, via) => self.piece(peer, bytes, via),
      ready: (peer) => self.linkReady(peer),
      routeChanged: (peer) => self.routeChanged(peer),
    };
  }
  private link(peer: string): Link {
    let link = this.links.get(peer);
    if (!link) this.links.set(peer, (link = new Link(this.linkHost, peer)));
    return link;
  }
  private changed(): void {
    this.updateAwake();
    if (this.publish || this.stopped) return;
    this.publish = setTimeout(() => {
      this.publish = undefined;
      this.host.changed();
    }, 50);
  }
  // Only transfers that are moving data keep the screen on: not unanswered offers,
  // and not an accepted one whose other side is away (that can wait for hours).
  private awake = false;
  private updateAwake(): void {
    const moving = (s: DeliveryStatus, peer: string) =>
      s === 'transferring' || (s === 'accepted' && !this.offline.has(peer));
    const busy =
      !this.stopped &&
      ([...this.incoming.values()].some((i) => moving(i.status, i.from)) ||
        [...this.outgoing.values()].some((o) =>
          [...o.recipients.values()].some((d) => moving(d.status, d.id)),
        ));
    if (busy === this.awake) return;
    this.awake = busy;
    this.host.env.keepAwake?.(busy);
  }
  private allowed(from: string, to: string): boolean {
    const settings = this.host.settings(),
      owner = this.host.owner();
    return !!settings && !!owner && canSend(settings, owner, from, to);
  }
  private report(inc: Incoming): void {
    this.reporter.report(`${inc.offer.id}:${inc.status}`, {
      event: 'delivery',
      offer: inc.offer.id,
      recipient: this.host.me(),
      status: inc.status,
      route: inc.route,
    });
  }

  // ---- Sending --------------------------------------------------------------
  async send(files: File[], recipients: string[]): Promise<string> {
    const me = this.host.me();
    const targets = [...new Set(recipients)];
    if (!files.length || files.length > MAX_FILES)
      throw new Error('Choose between 1 and 100 files to send.');
    if (!targets.length || targets.some((id) => !this.host.member(id) || !this.allowed(me, id)))
      throw new Error('This room does not allow sending to the selected members.');
    let files_: FileMeta[];
    try {
      files_ = validateManifest(
        files.map((f, id) => ({ id, name: f.name || 'file', size: f.size, type: f.type })),
      );
    } catch {
      throw new Error('One of these files has an unsupported name or size.');
    }
    const id = randomHex(16);
    const now = Date.now();
    const out: Outgoing = {
      id,
      sources: files,
      files: files_,
      total: files_.reduce((sum, f) => sum + f.size, 0),
      prepareBytes: 0,
      rawKey: crypto.getRandomValues(new Uint8Array(32)),
      recipients: new Map(
        targets.map((t) => [
          t,
          {
            id: t,
            name: this.host.member(t)?.name ?? '',
            status: 'offered' as DeliveryStatus,
            route: 'connecting' as DeliveryRoute,
            queue: [],
            queued: new Set<string>(),
            requested: new Set<string>(),
            sentAt: new Map<string, number>(),
            sent: 0,
            file: 0,
            horizon: -1,
            offered: now,
          },
        ]),
      ),
      relay: 'none',
      relayAt: 0,
    };
    this.outgoing.set(id, out);
    this.changed();
    try {
      out.prepared = [];
      for (const file of files)
        out.prepared.push(
          await this.prepared.get(file, (n) => {
            out.prepareBytes += n;
            this.changed();
          }),
        );
      out.key = await importContentKey(out.rawKey);
      out.offer = await signOffer(this.host.identity().privateKey, this.host.locator(), {
        id,
        sender: me,
        files: files_,
        pieceSize: PIECE_SIZE,
        roots: out.prepared.map((p) => bytesToHex(p.tree.root)),
        sha256: out.prepared.map((p) => p.sha256),
        md5: out.prepared.map((p) => p.md5),
        created: now,
      });
    } catch {
      for (const d of out.recipients.values())
        this.deliveryEnded(out, d, 'failed', 'These files could not be read.');
      this.changed();
      return id;
    }
    for (const d of out.recipients.values()) {
      if (d.status !== 'offered') continue;
      d.offered = Date.now();
      this.link(d.id).send({ t: 'offer', offer: out.offer });
    }
    this.reporter.report(`offer:${id}`, {
      event: 'offer',
      offer: id,
      files: files_,
      md5: out.offer.md5,
      sha256: out.offer.sha256,
      recipients: targets,
    });
    this.changed();
    return id;
  }
  cancelOutgoing(id: string, recipient?: string): void {
    const out = this.outgoing.get(id);
    if (!out) return;
    for (const d of out.recipients.values())
      if ((!recipient || d.id === recipient) && !terminal(d.status)) {
        this.link(d.id).send({ t: 'cancel', id });
        this.deliveryEnded(out, d, 'cancelled');
      }
    this.changed();
  }
  private deliveryEnded(out: Outgoing, d: Delivery, status: DeliveryStatus, message?: string) {
    if (terminal(d.status)) return;
    d.status = status;
    d.message = message;
    d.queue = [];
    d.queued.clear();
    this.release(out);
    if (status === 'cancelled' || status === 'failed')
      this.reporter.report(`${out.id}:${d.id}:${status}`, {
        event: 'delivery',
        offer: out.id,
        recipient: d.id,
        status,
        route: d.route,
      });
    // Timeouts end deliveries from the ticker, which only republishes while others are active.
    this.changed();
  }
  // Once nobody is receiving an offer, its encrypted pieces are no longer needed.
  private release(out: Outgoing): void {
    if (![...out.recipients.values()].some((d) => active(d.status))) this.cache.drop(out.id);
  }
  private enqueue(d: Delivery, key: string): void {
    if (d.queued.has(key)) return;
    d.queued.add(key);
    d.queue.push(key);
  }
  private dequeue(d: Delivery, key: string): void {
    if (!d.queued.delete(key)) return;
    d.queue.splice(d.queue.indexOf(key), 1);
  }
  private need(out: Outgoing, d: Delivery, m: Extract<LinkMessage, { t: 'need' }>): void {
    const file = m.file;
    if (
      !Number.isInteger(file) ||
      file < 0 ||
      file >= out.files.length ||
      !Array.isArray(m.pieces) ||
      m.pieces.length > 16
    )
      return;
    const count = pieceCount(out.files[file].size);
    if (d.status === 'accepted') d.status = 'transferring';
    if (file !== d.file) {
      d.file = file;
      d.horizon = -1;
    }
    const now = Date.now();
    for (const piece of m.pieces) {
      if (!Number.isInteger(piece) || piece < 0 || piece >= count) continue;
      d.horizon = Math.max(d.horizon, piece);
      const key = `${file}:${piece}`;
      d.requested.add(key);
      const sent = d.sentAt.get(key);
      if (!m.retry && sent && now - sent < IN_FLIGHT_MS) continue;
      this.enqueue(d, key);
    }
    this.changed();
    void this.pump();
  }
  private route(out: Outgoing, link: Link | undefined): 'direct' | 'relay' | 'wait' {
    if (!link) return 'wait';
    if (link.direct === 'open') return 'direct';
    if (link.direct === 'connecting' && Date.now() - link.directSince < 5000) return 'wait';
    if (out.relay === 'admitted') return 'relay';
    const now = Date.now();
    if (
      out.relay === 'none' ||
      (out.relay === 'limited' && now >= out.relayAt) ||
      (out.relay === 'requested' && now - out.relayAt > 5000)
    ) {
      if (this.host.sendText({ type: 'relay-request', offer: out.id })) {
        out.relay = 'requested';
        out.relayAt = now;
      }
    }
    return 'wait';
  }
  private async pieceMessage(out: Outgoing, key: string): Promise<Uint8Array> {
    const cached = this.cache.get(out.id, key);
    if (cached) return cached;
    const [file, piece] = key.split(':').map(Number);
    const [start, end] = pieceBounds(out.files[file].size, piece);
    const plain = new Uint8Array(await out.sources[file].slice(start, end).arrayBuffer());
    // A piece's nonce is fixed, so it may only ever encrypt the bytes that were
    // hashed when the offer was made. A file changed on disk stops the offer.
    if (!equalBytes(await leafHash(plain), out.prepared![file].leaves[piece]))
      throw new SourceChanged();
    const message = encodePiece({
      offer: out.id,
      file,
      piece,
      proof: out.prepared![file].tree.proof(piece),
      data: await encryptPiece(out.key!, out.id, file, piece, plain),
    });
    this.cache.set(out.id, key, message);
    return message;
  }
  // The encrypted piece, or nothing if its source file changed (the offer stops).
  private async encrypted(out: Outgoing, key: string): Promise<Uint8Array | undefined> {
    try {
      return await this.pieceMessage(out, key);
    } catch (error) {
      if (!(error instanceof SourceChanged)) throw error;
      for (const d of out.recipients.values())
        if (!terminal(d.status)) {
          this.link(d.id).send({ t: 'cancel', id: out.id });
          this.deliveryEnded(
            out,
            d,
            'failed',
            'A file changed after it was checked. Send it again.',
          );
        }
      this.changed();
      return undefined;
    }
  }
  private sent(out: Outgoing, d: Delivery, key: string, route: Route): void {
    const [file, piece] = key.split(':').map(Number);
    const [start, end] = pieceBounds(out.files[file].size, piece);
    d.sentAt.set(key, Date.now());
    d.sent += end - start;
    d.route = route;
  }
  // One loop serves every outgoing delivery, one piece per delivery per round.
  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    clearTimeout(this.wake);
    this.wake = undefined;
    let blocked = false;
    try {
      for (;;) {
        let progressed = false;
        for (const out of this.outgoing.values()) {
          if (!out.offer) continue;
          for (const d of out.recipients.values()) {
            if (d.status !== 'transferring' || !d.queue.length) continue;
            const link = this.links.get(d.id);
            const route = this.route(out, link);
            if (route === 'wait') {
              blocked = true;
              continue;
            }
            const key = d.queue[0];
            if (route === 'direct') {
              if (link!.directBuffered > 1 << 20) {
                blocked = true;
                continue;
              }
              this.dequeue(d, key);
              const message = await this.encrypted(out, key);
              if (!message || d.status !== 'transferring') continue;
              if (!link!.sendPiece(message)) {
                this.enqueue(d, key);
                blocked = true;
                continue;
              }
              this.sent(out, d, key, 'direct');
              progressed = true;
              continue;
            }
            if (this.host.relayBuffered() > 4 << 20) {
              blocked = true;
              continue;
            }
            // Fan-out: every other relay recipient on this file whose request
            // window reaches this piece gets the same encrypted copy.
            const [file, piece] = key.split(':').map(Number);
            const now = Date.now();
            const targets = [...out.recipients.values()].filter(
              (o) =>
                o === d ||
                (o.status === 'transferring' &&
                  this.route(out, this.links.get(o.id)) === 'relay' &&
                  (o.queued.has(key) ||
                    // Never re-send a piece this recipient was already sent.
                    (!o.sentAt.has(key) && o.file === file && piece <= o.horizon + WINDOW))),
            );
            for (const t of targets) this.dequeue(t, key);
            const message = await this.encrypted(out, key);
            if (!message) continue;
            const live = targets.filter((t) => t.status === 'transferring');
            if (!live.length) continue;
            if (
              !this.host.sendBinary(
                encodeFanout(
                  live.map((t) => t.id),
                  message,
                ),
              )
            ) {
              for (const t of live) this.enqueue(t, key);
              blocked = true;
              continue;
            }
            for (const t of live) this.sent(out, t, key, 'relay');
            progressed = true;
          }
        }
        if (!progressed) break;
        this.changed();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.pumping = false;
    }
    if (blocked && !this.stopped) this.wake = setTimeout(() => void this.pump(), 25);
  }

  // ---- Receiving ------------------------------------------------------------
  private async receiveOffer(peer: string, raw: unknown): Promise<void> {
    let offer: SignedOffer;
    try {
      offer = validateOffer(raw);
    } catch {
      return;
    }
    if (offer.sender !== peer) return;
    const known = this.incoming.get(offer.id);
    if (known) {
      // The sender offered again: it missed our answer.
      if (known.answer) this.link(peer).send(known.answer.message);
      return;
    }
    const key = this.host.member(peer)?.key;
    if (!key || !(await verifyOffer(key, this.host.locator(), offer))) return;
    if (this.incoming.has(offer.id)) return;
    if (!this.allowed(peer, this.host.me())) {
      this.link(peer).send({ t: 'decline', id: offer.id, reason: 'not-allowed' });
      return;
    }
    this.incoming.set(offer.id, {
      offer,
      from: peer,
      fromName: this.host.member(peer)?.name ?? '',
      status: 'offered',
      route: 'connecting',
      received: Date.now(),
      file: 0,
      have: new Set(),
      next: 0,
      requested: new Map(),
      failures: new Map(),
      transferred: 0,
      samples: [],
      saved: [],
      work: Promise.resolve(),
    });
    this.changed();
    const total = offer.files.reduce((sum, f) => sum + f.size, 0);
    if (total <= (this.host.env.autoAcceptBytes ?? AUTO_ACCEPT_BYTES))
      void this.accept(offer.id).catch(() => {});
  }
  private answer(inc: Incoming, message: LinkMessage): void {
    inc.answer = { message, sent: Date.now(), tries: 0 };
    this.link(inc.from).send(message);
  }
  async accept(id: string): Promise<void> {
    const inc = this.incoming.get(id);
    if (!inc || inc.status !== 'offered') return;
    if (!this.allowed(inc.from, this.host.me())) {
      this.decline(id);
      throw new Error('This room no longer allows files from this member.');
    }
    inc.status = 'accepted';
    this.changed();
    try {
      inc.sink = await this.host.env.sink(
        inc.offer.files,
        historyFolder(inc.offer.id, this.host.me()),
      );
    } catch (error) {
      this.link(inc.from).send({ t: 'decline', id, reason: 'storage' });
      this.incomingEnded(inc, 'failed', publicError(error));
      throw error;
    }
    if (inc.status !== 'accepted') {
      await inc.sink.dispose().catch(() => {});
      return;
    }
    this.answer(inc, { t: 'accept', id });
    this.link(inc.from).wantDirect();
    this.report(inc);
  }
  decline(id: string): void {
    const inc = this.incoming.get(id);
    if (!inc || inc.status !== 'offered') return;
    this.answer(inc, { t: 'decline', id });
    this.incomingEnded(inc, 'declined');
  }
  cancelIncoming(id: string): void {
    const inc = this.incoming.get(id);
    if (!inc || terminal(inc.status)) return;
    this.answer(inc, { t: 'cancel', id });
    this.incomingEnded(inc, 'cancelled');
  }
  private incomingEnded(inc: Incoming, status: DeliveryStatus, message?: string): void {
    if (terminal(inc.status)) return;
    inc.status = status;
    inc.message = message;
    inc.requested.clear();
    // A finished sink keeps its verified files; closing it ends its disk worker.
    void inc.sink?.dispose().catch(() => {});
    this.report(inc);
    this.changed();
  }
  private begin(inc: Incoming, key: string): void {
    inc.work = inc.work
      .then(async () => {
        if (inc.status !== 'accepted' || inc.key) return;
        inc.key = await importContentKey(hexToBytes(key));
        inc.answer = undefined; // the key acknowledges "accept"
        inc.status = 'transferring';
        await inc.sink!.open(inc.offer.files[0]);
        this.report(inc);
        this.requestMore(inc);
        this.changed();
      })
      .catch(() => this.incomingEnded(inc, 'failed', 'The transfer could not start.'));
  }
  private requestMore(inc: Incoming): void {
    if (inc.status !== 'transferring') return;
    const count = pieceCount(inc.offer.files[inc.file].size);
    const want: number[] = [];
    while (inc.requested.size + want.length < WINDOW && inc.next < count) {
      const piece = inc.next++;
      if (!inc.have.has(piece)) want.push(piece);
    }
    if (!want.length) return;
    const now = Date.now();
    for (const piece of want) inc.requested.set(piece, now);
    this.link(inc.from).send({ t: 'need', id: inc.offer.id, file: inc.file, pieces: want });
  }
  private rerequest(inc: Incoming, pieces: number[]): void {
    if (inc.status !== 'transferring' || !pieces.length) return;
    const now = Date.now();
    for (let i = 0; i < pieces.length; i += 16) {
      const batch = pieces.slice(i, i + 16);
      for (const piece of batch) inc.requested.set(piece, now);
      this.link(inc.from).send({
        t: 'need',
        id: inc.offer.id,
        file: inc.file,
        pieces: batch,
        retry: true,
      });
    }
  }
  private piece(peer: string, bytes: Uint8Array, via: Route): void {
    let message: PieceMessage;
    try {
      message = decodePiece(bytes);
    } catch {
      return;
    }
    const inc = this.incoming.get(message.offer);
    // Phase 1: only the original sender serves pieces.
    if (!inc || inc.from !== peer) return;
    inc.work = inc.work.then(() => this.receivePiece(inc, message, via)).catch(() => {});
  }
  private async receivePiece(inc: Incoming, m: PieceMessage, via: Route): Promise<void> {
    if (inc.status !== 'transferring' || !inc.key || m.file !== inc.file || inc.have.has(m.piece))
      return;
    const meta = inc.offer.files[m.file];
    const count = pieceCount(meta.size);
    if (m.piece >= count) return;
    const [start, end] = pieceBounds(meta.size, m.piece);
    let plain: Uint8Array | undefined;
    try {
      plain = await decryptPiece(inc.key, inc.offer.id, m.file, m.piece, m.data);
      if (
        plain.length !== end - start ||
        !verifyProof(
          await leafHash(plain),
          m.piece,
          count,
          m.proof,
          hexToBytes(inc.offer.roots[m.file]),
        )
      )
        plain = undefined;
    } catch {
      plain = undefined;
    }
    if (!plain) {
      const failures = (inc.failures.get(m.piece) ?? 0) + 1;
      inc.failures.set(m.piece, failures);
      if (failures >= 3)
        return this.incomingEnded(inc, 'failed', 'The file data could not be verified.');
      return this.rerequest(inc, [m.piece]);
    }
    if (inc.status !== 'transferring' || inc.have.has(m.piece)) return;
    const length = plain.length;
    await inc.sink!.write(start, plain.buffer as ArrayBuffer);
    inc.have.add(m.piece);
    inc.requested.delete(m.piece);
    inc.transferred += length;
    inc.route = via;
    inc.samples.push([Date.now(), inc.transferred]);
    if (inc.samples.length > 40) inc.samples.shift();
    if (inc.have.size === count) await this.finishFile(inc);
    else this.requestMore(inc);
    this.changed();
  }
  private async finishFile(inc: Incoming): Promise<void> {
    const meta = inc.offer.files[inc.file];
    let saved: SavedFile;
    try {
      saved = await inc.sink!.finish(meta, inc.offer.sha256[inc.file]);
    } catch {
      return this.incomingEnded(inc, 'failed', 'The received file did not match.');
    }
    inc.saved.push(saved);
    inc.file++;
    inc.have.clear();
    inc.requested.clear();
    inc.next = 0;
    if (inc.file < inc.offer.files.length) {
      await inc.sink!.open(inc.offer.files[inc.file]);
      this.requestMore(inc);
      return;
    }
    this.answer(inc, { t: 'done', id: inc.offer.id });
    this.incomingEnded(inc, 'complete');
  }

  // ---- Links and room events -----------------------------------------------
  private message(peer: string, m: LinkMessage, _via: Route): void {
    const out = 'id' in m ? this.outgoing.get(m.id) : undefined;
    const delivery = out?.recipients.get(peer);
    const inc = 'id' in m ? this.incoming.get(m.id) : undefined;
    const fromSender = inc?.from === peer ? inc : undefined;
    switch (m.t) {
      case 'signal':
        return void this.link(peer).signal(m);
      case 'direct':
        return this.link(peer).directRequested();
      case 'nodirect':
        return this.link(peer).directUnavailable();
      case 'sync':
        return this.sync(peer, m);
      case 'offer':
        return void this.receiveOffer(peer, m.offer);
      case 'accept':
        if (!out?.offer || !delivery) return;
        if (delivery.status === 'offered') {
          delivery.status = 'accepted';
          this.link(peer).wantDirect();
          this.changed();
        }
        // A repeated accept means the key was lost: send it again.
        if (delivery.status === 'accepted' || delivery.status === 'transferring')
          this.link(peer).send({ t: 'key', id: out.id, key: bytesToHex(out.rawKey) });
        else if (delivery.status === 'cancelled' || delivery.status === 'failed')
          this.link(peer).send({ t: 'cancel', id: out.id });
        return;
      case 'decline':
        if (!out || !delivery) return;
        this.link(peer).send({ t: 'ack', id: out.id });
        if (delivery.status === 'offered' || delivery.status === 'accepted') {
          this.deliveryEnded(out, delivery, 'declined');
          this.changed();
        }
        return;
      case 'ack':
        if (inc?.answer && inc.from === peer) inc.answer = undefined;
        return;
      case 'key':
        if (fromSender?.status === 'accepted' && typeof m.key === 'string')
          this.begin(fromSender, m.key);
        return;
      case 'need':
        if (
          out &&
          delivery &&
          (delivery.status === 'accepted' || delivery.status === 'transferring')
        )
          this.need(out, delivery, m);
        // Still asking for a delivery this side ended: the cancel was lost.
        else if (
          out &&
          delivery &&
          (delivery.status === 'cancelled' || delivery.status === 'failed')
        )
          this.link(peer).send({ t: 'cancel', id: out.id });
        return;
      case 'cancel':
        if (out && delivery) {
          this.link(peer).send({ t: 'ack', id: out.id });
          if (!terminal(delivery.status)) {
            this.deliveryEnded(out, delivery, 'cancelled');
            this.changed();
          }
        }
        if (fromSender && !terminal(fromSender.status)) this.incomingEnded(fromSender, 'cancelled');
        return;
      case 'msg':
      case 'got':
        return this.host.linkMessage?.(peer, m);
      case 'done':
        if (!out || !delivery) return;
        this.link(peer).send({ t: 'ack', id: out.id });
        if (active(delivery.status)) {
          delivery.status = 'complete';
          delivery.queue = [];
          delivery.queued.clear();
          this.release(out);
          this.changed();
        }
        return;
    }
  }
  // After every (re)established link each side lists what it is doing with the
  // other. A peer that reloaded no longer knows its deliveries.
  private linkReady(peer: string): void {
    const incoming = [...this.incoming.values()]
      .filter((i) => i.from === peer && active(i.status))
      .map((i) => i.offer.id);
    const outgoing = [...this.outgoing.values()]
      .filter((o) => active(o.recipients.get(peer)?.status ?? 'complete'))
      .map((o) => o.id);
    this.link(peer).send({ t: 'sync', incoming, outgoing });
    this.repeatAnswers(peer);
    this.host.linkReady?.(peer);
  }
  // Answers given while the sender was away (Accept, for one) are repeated as
  // soon as it can hear them again, even after their timed repeats ran out.
  private repeatAnswers(peer: string): void {
    const now = Date.now();
    for (const inc of this.incoming.values())
      if (inc.from === peer && inc.answer) {
        inc.answer.sent = now;
        inc.answer.tries = 0;
        this.link(peer).send(inc.answer.message);
      }
  }
  sendLink(peer: string, message: LinkMessage): void {
    this.link(peer).send(message);
  }
  // Activity reports from elsewhere in the room share this reporter.
  reportActivity(key: string, report: RoomReport): void {
    this.reporter.report(key, report);
  }
  private sync(peer: string, m: Extract<LinkMessage, { t: 'sync' }>): void {
    if (!Array.isArray(m.incoming) || !Array.isArray(m.outgoing)) return;
    const theirIncoming = new Set(m.incoming),
      theirOutgoing = new Set(m.outgoing);
    for (const out of this.outgoing.values()) {
      const d = out.recipients.get(peer);
      if (!d || !out.offer || theirIncoming.has(out.id)) continue;
      if (d.status === 'offered') this.link(peer).send({ t: 'offer', offer: out.offer });
      else if (active(d.status))
        this.deliveryEnded(out, d, 'failed', 'The recipient reloaded or closed the page.');
    }
    for (const inc of this.incoming.values())
      if (inc.from === peer && active(inc.status) && !theirOutgoing.has(inc.offer.id))
        this.incomingEnded(inc, 'failed', 'The sender stopped sending.');
    this.changed();
  }
  private routeChanged(peer: string): void {
    // A closed direct path may have dropped pieces: ask again right away.
    for (const inc of this.incoming.values())
      if (inc.from === peer && inc.status === 'transferring')
        this.rerequest(inc, [...inc.requested.keys()]);
    void this.pump();
  }
  text(m: Record<string, unknown>): void {
    const out = typeof m.offer === 'string' ? this.outgoing.get(m.offer) : undefined;
    switch (m.type) {
      case 'relay-admitted':
        if (out) {
          out.relay = 'admitted';
          void this.pump();
        }
        return;
      case 'relay-limited':
        if (out) {
          out.relay = 'limited';
          out.relayAt = Date.now() + Math.max(1, Number(m.retryAfter) || 60) * 1000;
          for (const d of out.recipients.values())
            if (d.status === 'transferring')
              d.message = 'WideSend is busy. The transfer will continue automatically.';
          this.changed();
        }
        return;
      case 'relay-skipped':
        if (out && Array.isArray(m.to)) {
          const key = `${m.file}:${m.piece}`;
          for (const id of m.to as string[]) {
            const d = out.recipients.get(id);
            if (d?.status === 'transferring' && d.requested.has(key)) {
              d.sentAt.delete(key);
              this.enqueue(d, key);
            }
          }
          void this.pump();
        }
        return;
      case 'audit-ack':
        return this.reporter.ack(m.id);
    }
  }
  binary(frame: Forwarded): void {
    if (!this.host.member(frame.from)) return;
    if (frame.kind === 0) this.link(frame.from).receive(frame.payload, 'relay');
    else this.piece(frame.from, frame.payload, 'relay');
  }
  connection(online: boolean): void {
    if (!online) return;
    for (const link of this.links.values()) link.flush();
    this.reporter.reconnected();
    // Frames in flight on the old socket are gone; ask again for them.
    for (const inc of this.incoming.values())
      if (inc.status === 'transferring' && inc.route !== 'direct')
        this.rerequest(inc, [...inc.requested.keys()]);
    for (const out of this.outgoing.values()) if (out.relay === 'requested') out.relayAt = 0;
    void this.pump();
  }
  roster(gone: string[]): void {
    for (const id of gone) this.memberGone(id);
    const now = Date.now();
    for (const { id, online } of this.host.members()) {
      if (online) {
        if (this.offline.delete(id)) {
          const link = this.links.get(id);
          if (link?.state === 'ready') this.repeatAnswers(id);
          else if ((!link || link.state === 'idle') && this.involves(id))
            void this.link(id).start();
        }
      } else if (!this.offline.has(id)) this.offline.set(id, now);
    }
    this.updateAwake();
  }
  // A page that restored its membership after a reload has no transfers. Opening
  // a fresh link to everyone online triggers the sync that tells them so.
  greet(): void {
    for (const { id, online } of this.host.members())
      if (online && id !== this.host.me()) void this.link(id).start();
  }
  private involves(peer: string): boolean {
    return (
      [...this.incoming.values()].some((i) => i.from === peer && active(i.status)) ||
      [...this.outgoing.values()].some((o) =>
        active(o.recipients.get(peer)?.status ?? 'complete'),
      ) ||
      !!this.host.wantsLink?.(peer)
    );
  }
  private memberGone(peer: string): void {
    for (const out of this.outgoing.values()) {
      const d = out.recipients.get(peer);
      if (d && !terminal(d.status))
        this.deliveryEnded(out, d, 'failed', 'The recipient left the room.');
    }
    for (const inc of this.incoming.values())
      if (inc.from === peer && !terminal(inc.status))
        this.incomingEnded(inc, 'failed', 'The sender left the room.');
    this.links.get(peer)?.close();
    this.links.delete(peer);
    this.offline.delete(peer);
    this.changed();
  }
  private tick(): void {
    const now = Date.now();
    for (const inc of this.incoming.values()) {
      const answer = inc.answer;
      if (answer && now - answer.sent >= RESEND_MS && answer.tries < RESENDS) {
        answer.sent = now;
        answer.tries++;
        this.link(inc.from).send(answer.message);
      }
      if (inc.status === 'transferring')
        this.rerequest(
          inc,
          [...inc.requested].filter(([, at]) => now - at > STALE_MS).map(([piece]) => piece),
        );
      const since = this.offline.get(inc.from);
      if (inFlight(inc.status) && since && now - since > OFFLINE_MS)
        this.incomingEnded(inc, 'failed', 'The sender went offline.');
    }
    for (const out of this.outgoing.values())
      for (const d of out.recipients.values()) {
        const since = this.offline.get(d.id);
        if (inFlight(d.status) && since && now - since > OFFLINE_MS)
          this.deliveryEnded(out, d, 'failed', 'The recipient went offline.');
      }
    this.reporter.flush();
    if (this.involvesAny()) {
      // Progress and speed need redrawing; an offer that only waits doesn't.
      if (this.anyTransferring()) this.changed();
      void this.pump();
    }
  }
  private anyTransferring(): boolean {
    return (
      [...this.incoming.values()].some((i) => i.status === 'transferring') ||
      [...this.outgoing.values()].some((o) =>
        [...o.recipients.values()].some((d) => d.status === 'transferring'),
      )
    );
  }
  private involvesAny(): boolean {
    return (
      [...this.incoming.values()].some((i) => active(i.status)) ||
      [...this.outgoing.values()].some((o) =>
        [...o.recipients.values()].some((d) => active(d.status)),
      )
    );
  }
  views(): { outgoing: OutgoingView[]; incoming: IncomingView[] } {
    return {
      outgoing: [...this.outgoing.values()].map((out) => ({
        id: out.id,
        files: out.files,
        total: out.total,
        preparing: out.offer
          ? undefined
          : out.total
            ? Math.min(1, out.prepareBytes / out.total)
            : 0,
        sources: out.sources,
        sha256: out.offer?.sha256,
        recipients: [...out.recipients.values()].map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
          transferred: d.status === 'complete' ? out.total : Math.min(out.total, d.sent),
          route: d.route,
          message: d.message,
        })),
      })),
      incoming: [...this.incoming.values()].map((inc) => {
        const [first, last] = [inc.samples[0], inc.samples.at(-1)];
        const speed =
          inc.status === 'transferring' && first && last && last[0] > first[0]
            ? ((last[1] - first[1]) * 1000) / (last[0] - first[0])
            : 0;
        return {
          id: inc.offer.id,
          folder: historyFolder(inc.offer.id, this.host.me()),
          from: inc.from,
          fromName: inc.fromName,
          files: inc.offer.files,
          total: inc.offer.files.reduce((sum, f) => sum + f.size, 0),
          status: inc.status,
          transferred: inc.transferred,
          speed,
          route: inc.route,
          saved: inc.saved,
          message: inc.message,
        };
      }),
    };
  }
  stop(): void {
    this.stopped = true;
    this.updateAwake();
    clearInterval(this.ticker);
    clearTimeout(this.wake);
    clearTimeout(this.publish);
    for (const link of this.links.values()) link.close();
    this.links.clear();
    for (const inc of this.incoming.values())
      if (!terminal(inc.status)) void inc.sink?.dispose().catch(() => {});
  }
}
