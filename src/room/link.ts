import type { Cipher } from '../crypto';
import type { DeviceIdentity } from '../key-session';
import { LinkHandshake, validLinkHello, type SignedOffer } from './identity';
import { FRAGMENT_LAST, FRAGMENT_MORE, Reassembler, fragment } from './pieces';

export type LinkMessage =
  | { t: 'signal'; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
  | { t: 'direct' }
  | { t: 'nodirect' }
  | { t: 'sync'; incoming: string[]; outgoing: string[] }
  | { t: 'offer'; offer: SignedOffer }
  | { t: 'accept'; id: string }
  | { t: 'decline'; id: string; reason?: string }
  | { t: 'key'; id: string; key: string }
  | { t: 'need'; id: string; file: number; pieces: number[]; retry?: boolean }
  | { t: 'cancel'; id: string; reason?: string }
  | { t: 'done'; id: string }
  | { t: 'ack'; id: string }
  // Room conversations (see messages.ts).
  | { t: 'msg'; id: string; text: string; to: string[]; at: number }
  | { t: 'got'; id: string; refused?: boolean };
export type Route = 'direct' | 'relay';
export type LinkHost = {
  me: string;
  locator: string;
  identity: DeviceIdentity;
  rtc?: typeof RTCPeerConnection;
  peerKey(peer: string): string | undefined;
  relay(peer: string, payload: Uint8Array): boolean;
  message(peer: string, message: LinkMessage, via: Route): void;
  piece(peer: string, bytes: Uint8Array, via: Route): void;
  ready(peer: string): void;
  routeChanged(peer: string): void;
};
const HELLO = 0x10;
const SEALED = 0x11;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const DIRECT_DEADLINE = 5000;

// An end-to-end encrypted channel to one other member. Messages go over the
// relay or, when open, a WebRTC data channel that also carries piece fragments.
export class Link {
  state: 'idle' | 'handshaking' | 'ready' = 'idle';
  direct: 'none' | 'connecting' | 'open' | 'failed' = 'none';
  directSince = 0;
  private cipher?: Cipher;
  private round?: string;
  private handshake?: LinkHandshake;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private directTimer?: ReturnType<typeof setTimeout>;
  private queue: LinkMessage[] = [];
  // Frames that couldn't go out while the room connection was down.
  private unsent: Uint8Array[] = [];
  private incoming: Promise<void> = Promise.resolve();
  private outgoing: Promise<void> = Promise.resolve();
  private failures = 0;
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private candidates: RTCIceCandidateInit[] = [];
  private reassembler = new Reassembler();
  private closed = false;
  constructor(
    private host: LinkHost,
    readonly peer: string,
  ) {}

  send(message: LinkMessage): void {
    if (this.closed) return;
    if (this.state !== 'ready') {
      this.queue.push(message);
      if (this.state === 'idle') void this.start();
      return;
    }
    this.transmit(message);
  }
  private transmit(message: LinkMessage): void {
    const cipher = this.cipher!;
    const plain = utf8.encode(JSON.stringify(message));
    const framed = new Uint8Array(plain.length + 1);
    framed.set(plain, 1);
    // Counters are allocated in call order; keep frames in that order on the wire.
    this.outgoing = this.outgoing.then(async () => {
      if (this.cipher !== cipher || this.closed) return;
      const sealed = new Uint8Array(await cipher.seal(framed));
      const payload = new Uint8Array(sealed.length + 1);
      payload[0] = SEALED;
      payload.set(sealed, 1);
      if (this.channel?.readyState === 'open') {
        try {
          this.channel.send(payload);
          return;
        } catch {
          this.directFailed();
        }
      }
      this.relay(payload);
    });
  }
  private relay(payload: Uint8Array): void {
    if (!this.unsent.length && this.host.relay(this.peer, payload)) return;
    if (this.unsent.length < 512) this.unsent.push(payload);
    this.flush();
  }
  // Sends frames held back while the room connection was down, in order.
  flush(): void {
    while (this.unsent.length && !this.closed && this.host.relay(this.peer, this.unsent[0]))
      this.unsent.shift();
  }
  // Starts (or restarts) a handshake as the initiator.
  async start(): Promise<void> {
    const key = this.host.peerKey(this.peer);
    if (!key || this.closed) {
      this.state = 'idle';
      return;
    }
    this.state = 'handshaking';
    let handshake: LinkHandshake;
    try {
      handshake = await LinkHandshake.start(
        { id: this.host.me, identity: this.host.identity },
        { id: this.peer, key },
        this.host.locator,
      );
    } catch {
      if (this.state === 'handshaking' && !this.handshake) this.state = 'idle';
      return;
    }
    if (this.closed || this.state !== 'handshaking') return;
    this.handshake = handshake;
    this.sendHello(handshake);
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = setTimeout(() => {
      if (this.handshake === handshake && this.state === 'handshaking') {
        this.handshake = undefined;
        this.state = 'idle';
        if (this.queue.length) void this.start();
      }
    }, 10_000);
  }
  private sendHello(handshake: LinkHandshake): void {
    const json = utf8.encode(JSON.stringify(handshake.hello));
    const payload = new Uint8Array(json.length + 1);
    payload[0] = HELLO;
    payload.set(json, 1);
    this.relay(payload);
  }
  receive(payload: Uint8Array, via: Route): void {
    this.incoming = this.incoming.then(() => this.process(payload, via)).catch(() => {});
  }
  private async process(payload: Uint8Array, via: Route): Promise<void> {
    if (this.closed || !payload.length) return;
    if (payload[0] === HELLO) return this.hello(payload.subarray(1));
    if (payload[0] === SEALED) {
      if (!this.cipher) {
        if (this.state === 'idle') void this.start();
        return;
      }
      let plain: Uint8Array;
      try {
        plain = await this.cipher.open(payload.slice(1).buffer);
      } catch {
        // Repeated authentication failures mean the keys diverged: start over.
        if (++this.failures >= 3) {
          this.failures = 0;
          this.reset();
          void this.start();
        }
        return;
      }
      this.failures = 0;
      if (plain[0] !== 0) return;
      let message: LinkMessage;
      try {
        message = JSON.parse(fromUtf8.decode(plain.subarray(1)));
      } catch {
        return;
      }
      if (message && typeof message.t === 'string') this.host.message(this.peer, message, via);
      return;
    }
    if (via === 'direct' && (payload[0] === FRAGMENT_MORE || payload[0] === FRAGMENT_LAST)) {
      let whole: Uint8Array | undefined;
      try {
        whole = this.reassembler.push(payload);
      } catch {
        return this.directFailed();
      }
      if (whole) this.host.piece(this.peer, whole, 'direct');
    }
  }
  private async hello(bytes: Uint8Array): Promise<void> {
    let hello: unknown;
    try {
      hello = JSON.parse(fromUtf8.decode(bytes));
    } catch {
      return;
    }
    if (!validLinkHello(hello)) return;
    if (this.state === 'ready' && hello.round === this.round) return; // duplicate
    if (this.state === 'handshaking' && this.handshake?.round === hello.round) {
      const handshake = this.handshake;
      this.handshake = undefined;
      try {
        this.established(await handshake.finish(hello), hello.round);
      } catch {
        this.state = 'idle';
      }
      return;
    }
    // Both started at once: the lower member ID's round wins. That holds from the
    // moment it starts, before its own hello is ready: answering the other round
    // then as well leaves the two sides on different keys.
    if (this.state === 'handshaking' && this.host.me < this.peer) return;
    const key = this.host.peerKey(this.peer);
    if (!key) return;
    const responder = await LinkHandshake.start(
      { id: this.host.me, identity: this.host.identity },
      { id: this.peer, key },
      this.host.locator,
      hello.round,
    );
    let cipher: Cipher;
    try {
      cipher = await responder.finish(hello);
    } catch {
      return;
    }
    this.handshake = undefined;
    this.sendHello(responder);
    // A new round from the peer means it restarted: any direct path is stale.
    this.closeDirect();
    this.established(cipher, hello.round);
  }
  private established(cipher: Cipher, round: string): void {
    clearTimeout(this.handshakeTimer);
    this.cipher = cipher;
    this.round = round;
    this.state = 'ready';
    this.outgoing = Promise.resolve();
    for (const message of this.queue.splice(0)) this.transmit(message);
    this.host.ready(this.peer);
  }
  private reset(): void {
    this.cipher = undefined;
    this.round = undefined;
    this.handshake = undefined;
    this.state = 'idle';
    this.closeDirect();
  }

  // Direct WebRTC: the lower member ID creates the connection; the other side asks.
  wantDirect(): void {
    if (this.closed || this.direct === 'open' || this.direct === 'connecting') return;
    if (!this.host.rtc) {
      this.direct = 'failed';
      return;
    }
    if (this.direct === 'failed') return;
    this.direct = 'connecting';
    this.directSince = Date.now();
    clearTimeout(this.directTimer);
    this.directTimer = setTimeout(() => {
      if (this.direct === 'connecting') this.directFailed();
    }, DIRECT_DEADLINE);
    if (this.host.me < this.peer) void this.offerDirect();
    else this.send({ t: 'direct' });
  }
  directRequested(): void {
    // Tell the waiting side at once when this browser can't connect directly.
    if (!this.host.rtc) return this.send({ t: 'nodirect' });
    if (this.host.me < this.peer && this.direct !== 'open') {
      if (this.direct === 'failed') this.direct = 'none';
      if (this.direct === 'none') this.wantDirect();
    }
  }
  private createPeer(): RTCPeerConnection {
    const pc = new this.host.rtc!({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    this.pc = pc;
    pc.onicecandidate = (event) => {
      if (this.pc === pc && event.candidate)
        this.send({ t: 'signal', candidate: event.candidate.toJSON() });
    };
    pc.ondatachannel = (event) => {
      if (this.pc === pc) this.attach(event.channel);
      else event.channel.close();
    };
    pc.onconnectionstatechange = () => {
      if (this.pc === pc && ['failed', 'closed'].includes(pc.connectionState)) this.directFailed();
    };
    return pc;
  }
  private async offerDirect(): Promise<void> {
    try {
      const pc = this.createPeer();
      this.attach(pc.createDataChannel('widesend-room', { ordered: true }));
      const offer = await pc.createOffer();
      if (this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      this.send({ t: 'signal', description: pc.localDescription!.toJSON() });
    } catch {
      this.directFailed();
    }
  }
  async signal(message: Extract<LinkMessage, { t: 'signal' }>): Promise<void> {
    if (!this.host.rtc || this.direct === 'failed') return;
    try {
      if (!this.pc) {
        this.direct = 'connecting';
        this.directSince = Date.now();
      }
      const pc = this.pc ?? this.createPeer();
      if (message.description) {
        await pc.setRemoteDescription(message.description);
        for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
        if (message.description.type === 'offer') {
          const answer = await pc.createAnswer();
          if (this.pc !== pc) return;
          await pc.setLocalDescription(answer);
          this.send({ t: 'signal', description: pc.localDescription!.toJSON() });
        }
      } else if (message.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
        else this.candidates.push(message.candidate);
      }
    } catch {
      this.directFailed();
    }
  }
  private attach(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => {
      if (this.channel !== channel) return;
      clearTimeout(this.directTimer);
      this.direct = 'open';
      this.host.routeChanged(this.peer);
    };
    channel.onmessage = (event) => {
      if (this.channel === channel)
        this.receive(new Uint8Array(event.data as ArrayBuffer), 'direct');
    };
    channel.onbufferedamountlow = () => this.host.routeChanged(this.peer);
    channel.onclose = () => {
      if (this.channel === channel) this.directFailed();
    };
    channel.onerror = () => {
      if (this.channel === channel) this.directFailed();
    };
  }
  sendPiece(message: Uint8Array): boolean {
    if (this.direct !== 'open' || this.channel?.readyState !== 'open') return false;
    try {
      for (const part of fragment(message)) this.channel.send(part);
      return true;
    } catch {
      this.directFailed();
      return false;
    }
  }
  get directBuffered(): number {
    return this.channel?.bufferedAmount ?? 0;
  }
  private directFailed(): void {
    const wasActive = this.direct !== 'failed';
    this.closeDirect();
    this.direct = 'failed';
    if (!wasActive) return;
    if (this.state === 'ready') this.send({ t: 'nodirect' });
    this.host.routeChanged(this.peer);
  }
  // The other side reported that a direct connection isn't possible right now.
  directUnavailable(): void {
    if (this.direct === 'failed') return;
    this.closeDirect();
    this.direct = 'failed';
    this.host.routeChanged(this.peer);
  }
  private closeDirect(): void {
    clearTimeout(this.directTimer);
    const pc = this.pc;
    this.pc = undefined;
    this.channel = undefined;
    this.candidates = [];
    this.reassembler.reset();
    pc?.close();
    this.direct = 'none';
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.closeDirect();
    this.cipher = undefined;
    this.queue = [];
    this.unsent = [];
  }
}
