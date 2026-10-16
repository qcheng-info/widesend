import {
  CHUNK_SIZE,
  WINDOW_SIZE,
  MAX_FRAME,
  MAX_RELAY_FRAME,
  RELAY_BATCH_SIZE,
  PAIRING_MS,
  SESSION_MS,
  validOffset,
  validateManifest,
  validateFingerprints,
  type Fingerprint,
  type Control,
  type FileMeta,
  type Role,
} from '../shared/protocol';
import { Cipher, decodeControl, parseCode, pairingCode, roomId, token } from './crypto';
import { Destination, downloadFile, type SavedFile } from './storage';
import { fingerprintFile } from './integrity';
import { RecoverySession } from './recovery';
import {
  createIdentity,
  KeySession,
  PAIRING_ERROR,
  UPDATE_REQUIRED,
  type DeviceIdentity,
} from './key-session';
import { KEY_EXCHANGE, validKeyMessage, type KeyMessage } from '../shared/key-exchange';
import { publicError } from './messages';
import { ActivityReporter } from './activity';
import { TransferMeter, type TimingStats } from './metrics';
import { connectionPath, type ConnectionPath } from './connection-path';
import { RelayDrain } from './relay-drain';
import { siteName } from './site';
import { relayFrame } from '../shared/relay';
import { CLIENT_CLOSE, closeReason } from '../shared/diagnostics';

type Transport = WebSocket | RTCDataChannel;
/** One use of a code that several receivers can use; see send-session.ts. */
export type Slot = {
  index: number;
  uses: number;
  code: string;
  credential: string;
  expires: number;
  pairExpires: number;
  // Computed once for every receiver of the send.
  fingerprints: () => Promise<Fingerprint[]>;
};
export const CODE_USED = 'This code has already been used. Ask the sender for a new code.';
export type TransferStats = TimingStats & {
  queuedBytes: number;
  unacknowledgedBytes: number | null;
  resentBytes: number | null;
  reconnects: number;
  latencyMs: number | null;
  fallbackReason: string | null;
  connectionPath: ConnectionPath | null;
  acknowledgementPath: 'direct' | 'relay' | null;
  currentFile: number;
  fileTransferred: number;
  verifiedFiles: number;
  activity: string;
};

export type Phase =
  | 'connecting'
  | 'waiting'
  | 'offered'
  | 'transferring'
  | 'reconnecting'
  | 'complete'
  | 'error'
  | 'cancelled';
export type Snapshot = {
  role: Role;
  phase: Phase;
  code: string;
  files: FileMeta[];
  saved: SavedFile[];
  transferred: number;
  total: number;
  speed: number;
  route: 'connecting' | 'direct' | 'relay';
  message: string;
  stats?: TransferStats;
  needsFiles?: boolean;
  checkingFiles?: boolean;
  // Sender: the server named this transfer's receiver.
  claimed?: boolean;
};
const terminal = (phase: Phase) => ['error', 'cancelled', 'complete'].includes(phase);

export class Transfer {
  snapshot: Snapshot;
  private audit = new ActivityReporter();
  private listener: (state: Snapshot) => void;
  private cipher?: Cipher;
  private identity?: DeviceIdentity;
  private keySession?: KeySession;
  private keyDeadline = 0;
  private room = '';
  private credential = token(32);
  private receiverCredential?: string;
  private slot = 0;
  private uses = 1;
  // One slot of a several-receiver send: its record stays until the send ends.
  private group = false;
  private sharedFingerprints?: Slot['fingerprints'];
  private sealing = false;
  private expires = Date.now() + SESSION_MS;
  private pairExpires = Date.now() + PAIRING_MS;
  private ws?: WebSocket;
  private relayDrain?: RelayDrain;
  private relayBatchAvailable = false;
  private peerRelayBatch = false;
  private relayPolicyAvailable = false;
  private relayAdmitted = false;
  private relayRetryAt = 0;
  private relayRequest?: { reason: string; notify: boolean; forced: boolean; sentAt: number };
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private candidates: RTCIceCandidateInit[] = [];
  private peerOnline = false;
  private relay = false;
  private negotiating = false;
  private connectionGeneration = 0;
  private directTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private incoming = Promise.resolve();
  private outgoing = Promise.resolve();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private lastPong = Date.now();
  private lastPing = 0;
  private lastAck = Date.now();
  private lastEnd = 0;
  private reconnectStarted = 0;
  private limitedUntil = 0;
  private retry = 0;
  private sendFiles: File[] = [];
  private fingerprints?: Fingerprint[];
  private recovery?: RecoverySession;
  private restored = false;
  private preparing?: Promise<void>;
  private sourceAbort = new AbortController();
  private lastCheckpoint = 0;
  private checkpointOffset = 0;
  private progressBaseline = 0;
  private restoredPosition = false;
  private onPageHide = () => {
    void this.suspend();
  };
  private fileIndex = 0;
  private cursor = 0;
  private highestSent = 0;
  private acknowledged = 0;
  private receiverOffset = 0;
  private lastReceiverAck = 0;
  private accepted = false;
  private ready = false;
  private completionAcknowledged = false;
  private pumping = false;
  private destination?: Destination;
  private lastRender = 0;
  private meter = new TransferMeter();
  private lastStats = 0;
  private reconnects = 0;
  private resentBytes = 0;
  private verifiedFiles = 0;
  private verifying = false;
  private fallbackReason: string | null = null;
  private path: ConnectionPath | null = null;
  private acknowledgementPath: 'direct' | 'relay' | null = null;
  private pathReading?: RTCPeerConnection;
  private lastPathRead = -Infinity;
  private probeId = 0;
  private lastProbe = -Infinity;
  private lastEcho = -Infinity;
  private pendingProbe?: { id: number; sent: number; route: Transport };
  private latency?: { ms: number; measured: number };
  private wakeLock?: WakeLockSentinel;
  private onVisibility = () => {
    if (document.visibilityState === 'visible' && this.accepted && !terminal(this.snapshot.phase)) {
      void this.keepAwake();
      if (Date.now() - this.lastPong > 45_000)
        this.replaceConnection('No reply from the server for 45 s');
    }
  };
  private onNetworkChange = () => {
    if (this.stopped || (terminal(this.snapshot.phase) && !this.pendingCompletion())) return;
    this.replaceConnection('Network changed');
  };
  // `reason` goes to the server's activity log with the close.
  private replaceConnection(reason: string): void {
    const previous = this.ws;
    this.ws = undefined;
    previous?.close(CLIENT_CLOSE.reconnect, closeReason(reason));
    clearTimeout(this.connectionTimer);
    this.peerOnline = false;
    this.ready = false;
    this.resetDirect();
    this.scheduleReconnect();
  }

  private resetDirect(): void {
    // A new signaling connection gets a fresh ICE attempt. Old asynchronous
    // work must never send on, or close, its replacement connection.
    this.connectionGeneration++;
    this.cipher = undefined;
    this.keySession?.destroy();
    this.keySession = undefined;
    this.keyDeadline = 0;
    this.relayDrain?.reset();
    this.peerRelayBatch = false;
    this.relayAdmitted = false;
    this.relayRequest = undefined;
    this.relayRetryAt = 0;
    clearTimeout(this.directTimer);
    this.directTimer = undefined;
    const peer = this.peer;
    this.peer = undefined;
    this.channel = undefined;
    this.candidates = [];
    this.negotiating = false;
    this.relay = false;
    this.cursor = this.acknowledged;
    peer?.close();
    if (!terminal(this.snapshot.phase)) {
      this.path = null;
      this.acknowledgementPath = null;
      this.fallbackReason = null;
      this.lastPathRead = -Infinity;
      this.update({ route: 'connecting' });
    }
  }

  private waitForDirect(): void {
    if (
      this.stopped ||
      this.relay ||
      !this.peerOnline ||
      !this.accepted ||
      terminal(this.snapshot.phase) ||
      this.channel?.readyState === 'open' ||
      this.directTimer
    )
      return;
    const generation = this.connectionGeneration;
    this.directTimer = setTimeout(() => {
      this.directTimer = undefined;
      if (generation === this.connectionGeneration && this.channel?.readyState !== 'open')
        this.useRelay('Direct connection timed out');
    }, 5000);
  }

  constructor(role: Role, code: string, listener: (state: Snapshot) => void) {
    this.snapshot = {
      role,
      phase: 'connecting',
      code,
      files: [],
      saved: [],
      transferred: 0,
      total: 0,
      speed: 0,
      route: 'connecting',
      message: 'Connecting your devices…',
    };
    this.listener = listener;
  }
  static sender(files: File[], listener: (state: Snapshot) => void, slot?: Slot): Transfer {
    const transfer = new Transfer('send', slot?.code ?? pairingCode(), listener);
    if (slot) {
      transfer.slot = slot.index;
      transfer.uses = slot.uses;
      transfer.group = true;
      transfer.credential = slot.credential;
      transfer.expires = slot.expires;
      transfer.pairExpires = slot.pairExpires;
      transfer.sharedFingerprints = slot.fingerprints;
    }
    transfer.sendFiles = files;
    const metadata = validateManifest(
      files.map((file, id) => ({ id, name: file.name, size: file.size, type: file.type })),
    );
    transfer.snapshot.files = metadata;
    transfer.snapshot.total = metadata.reduce((sum, f) => sum + f.size, 0);
    return transfer;
  }
  static receiver(code: string, listener: (state: Snapshot) => void): Transfer {
    return new Transfer('receive', parseCode(code), listener);
  }
  static async restore(listener: (state: Snapshot) => void): Promise<Transfer | undefined> {
    const recovery = await RecoverySession.restore();
    return recovery && Transfer.fromRecovery(recovery, listener);
  }
  static fromRecovery(recovery: RecoverySession, listener: (state: Snapshot) => void): Transfer {
    const r = recovery.record;
    const transfer = new Transfer(r.role, r.code, listener);
    transfer.recovery = recovery;
    transfer.restored = true;
    transfer.credential = r.credential ?? r.id;
    transfer.slot = r.slot ?? 0;
    transfer.uses = r.uses ?? 1;
    transfer.group = transfer.uses > 1;
    transfer.snapshot.claimed = r.role === 'send' && !!r.receiver;
    transfer.receiverCredential = r.receiver;
    transfer.expires = r.expires;
    transfer.pairExpires = r.pairExpires;
    transfer.accepted = r.accepted;
    transfer.fingerprints = r.fingerprints;
    transfer.fileIndex = r.fileIndex;
    transfer.receiverOffset = r.offset;
    transfer.acknowledged = r.offset;
    transfer.verifiedFiles = r.role === 'receive' ? r.completed.length : r.fileIndex;
    transfer.snapshot.files = r.files;
    transfer.snapshot.total = r.files.reduce((sum, file) => sum + file.size, 0);
    transfer.snapshot.transferred = transfer.transferredBytes();
    transfer.progressBaseline = transfer.snapshot.transferred;
    transfer.snapshot.needsFiles = r.role === 'send';
    transfer.snapshot.phase = 'reconnecting';
    transfer.snapshot.message = 'Restoring your transfer…';
    return transfer;
  }
  private async save(patch: Parameters<RecoverySession['save']>[0]): Promise<void> {
    await this.recovery?.save(patch);
  }
  // A finished slot of a several-receiver send keeps its record (and lock) for
  // the send to list after a reload; the send removes it when it ends.
  private async forget(outcome?: 'complete' | 'cancelled' | 'error'): Promise<void> {
    if (this.group && outcome) {
      await this.save({ finished: outcome });
      return;
    }
    try {
      await this.recovery?.remove();
    } finally {
      await this.recovery?.unlock();
    }
  }
  private async manifest(): Promise<void> {
    await this.control({
      type: 'manifest',
      files: this.snapshot.files,
      fingerprints: this.fingerprints,
    });
  }
  private prepareSources(): Promise<void> {
    return (this.preparing ??= (async () => {
      if (!this.sendFiles.length) return;
      this.update({ checkingFiles: true, message: 'Checking your original files…' });
      try {
        if (!this.fingerprints) {
          const fingerprints: Fingerprint[] = [];
          if (this.sharedFingerprints) fingerprints.push(...(await this.sharedFingerprints()));
          else
            for (const file of this.sendFiles)
              fingerprints.push(await fingerprintFile(file, this.sourceAbort.signal));
          await this.save({ fingerprints });
          this.fingerprints = fingerprints;
        }
        if (this.stopped) return;
        // Publishing the fingerprints asks the receiver for its current offset.
        // Wait for that ready reply before starting, avoiding needless replay.
        this.ready = false;
        await this.manifest();
        this.update({
          checkingFiles: false,
          message: 'Sending your files. Keep both devices awake.',
        });
        void this.pump();
      } finally {
        if (!this.stopped) this.update({ checkingFiles: false });
      }
    })());
  }
  async supplyFiles(files: File[]): Promise<void> {
    if (!this.snapshot.needsFiles || this.snapshot.checkingFiles || this.stopped) return;
    this.update({ checkingFiles: true });
    try {
      const original = await Transfer.matchOriginals(
        files,
        this.snapshot.files,
        this.fingerprints,
        this.sourceAbort.signal,
      );
      if (this.stopped) return;
      await this.resumeWith(original.files, original.fingerprints);
    } finally {
      if (!this.stopped) this.update({ checkingFiles: false });
    }
  }
  /** Finds the original files by name and size, checked against saved fingerprints. */
  static async matchOriginals(
    files: File[],
    metadata: FileMeta[],
    saved: Fingerprint[] | undefined,
    signal: AbortSignal,
  ): Promise<{ files: File[]; fingerprints: Fingerprint[] }> {
    if (files.length !== metadata.length)
      throw new Error('Select the same original files to continue.');
    const candidates = files.map((file, id) => ({
      file,
      meta: validateManifest([{ id: 0, name: file.name, size: file.size, type: file.type }])[0],
      id,
    }));
    const fingerprints = new Map<number, Fingerprint>();
    const matched: File[] = [];
    const hashes: Fingerprint[] = [];
    for (const meta of metadata) {
      let found = -1;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (candidate.meta.name !== meta.name || candidate.meta.size !== meta.size) continue;
        let hash = fingerprints.get(candidate.id);
        if (!hash) {
          hash = await fingerprintFile(candidate.file, signal);
          fingerprints.set(candidate.id, hash);
        }
        if (saved && hash.sha256 !== saved[meta.id].sha256) continue;
        matched.push(candidate.file);
        hashes.push(hash);
        found = i;
        break;
      }
      if (found < 0) throw new Error('Select the same original files to continue.');
      candidates.splice(found, 1);
    }
    return { files: matched, fingerprints: hashes };
  }
  /** Continues a restored send with its original files. */
  async resumeWith(files: File[], fingerprints: Fingerprint[]): Promise<void> {
    if (this.stopped) return;
    await this.save({ fingerprints });
    this.sendFiles = files;
    this.fingerprints = fingerprints;
    this.preparing = Promise.resolve();
    this.ready = false;
    this.update({
      needsFiles: false,
      checkingFiles: false,
      message: 'Connection restored. Continuing your transfer.',
    });
    await this.manifest();
    void this.pump();
  }
  private update(value: Partial<Snapshot>): void {
    const previous = this.snapshot;
    const next = { ...previous, ...value };
    if (next.needsFiles && !terminal(next.phase))
      next.message = next.checkingFiles
        ? 'Checking your original files…'
        : 'Select your original files to continue automatically.';
    const phaseChanged = next.phase !== previous.phase;
    const routeChanged = next.route !== previous.route;
    if (!terminal(previous.phase)) {
      if (phaseChanged) {
        if (next.phase === 'transferring' && this.accepted) {
          this.meter.start();
          if (previous.phase === 'reconnecting') this.meter.record('Transfer resumed');
        } else if (next.phase === 'reconnecting') {
          this.pendingProbe = undefined;
          this.latency = undefined;
          this.meter.record('Connection interrupted');
        } else if (terminal(next.phase)) {
          this.meter.record(
            next.phase === 'complete'
              ? 'All files verified'
              : next.phase === 'cancelled'
                ? 'Transfer cancelled'
                : 'Transfer failed',
          );
        }
      }
      if (routeChanged) {
        this.pendingProbe = undefined;
        this.latency = undefined;
        this.lastProbe = -Infinity;
        this.meter.record(
          next.route === 'direct'
            ? 'Direct connection established'
            : next.route === 'relay'
              ? 'Switched to relay'
              : 'Checking direct connection',
        );
      }
      if ((phaseChanged || routeChanged) && (this.accepted || terminal(next.phase))) {
        next.stats = this.readStats(next);
        next.speed = next.stats.speed;
      }
    }
    this.snapshot = next;
    this.listener(this.snapshot);
    const { phase, route } = this.snapshot;
    if (
      phase === 'transferring' ||
      phase === 'complete' ||
      phase === 'error' ||
      phase === 'cancelled'
    )
      this.audit.report(`status:${phase}:${route}`, { event: 'status', status: phase, route });
  }
  async start(): Promise<void> {
    this.room = await roomId(this.snapshot.code);
    if (this.stopped) return;
    if (!this.recovery)
      this.recovery = await RecoverySession.create({
        version: 2,
        identity: await createIdentity(),
        // Each receiver slot of a send has its own record; slot 0 keeps the plain id.
        id: this.slot ? `${this.credential}:${this.slot}` : this.credential,
        ...(this.group ? { credential: this.credential, uses: this.uses, slot: this.slot } : {}),
        role: this.snapshot.role,
        code: this.snapshot.code,
        expires: this.expires,
        pairExpires: this.pairExpires,
        updated: Date.now(),
        files: this.snapshot.files,
        accepted: false,
        fileIndex: 0,
        offset: 0,
        completed: [],
      });
    if (this.recovery.record.version === 1) {
      // Keep the old file checkpoint, but upgrade encryption after both pages
      // refresh. A v1 client skips this v2 record instead of downgrading it.
      await this.save({ version: 2, identity: await createIdentity() });
    }
    this.identity = this.recovery.record.identity;
    if (!this.identity?.privateKey || !this.identity.publicKey)
      throw new Error('Saved transfer data is missing.');
    if (this.stopped) {
      await this.forget();
      return;
    }
    if (this.restored && this.snapshot.role === 'receive' && this.accepted) {
      const r = this.recovery.record;
      if (!r.folder) throw new Error('Saved transfer data is missing.');
      this.destination = new Destination();
      await this.destination.prepare(this.snapshot.files, r.folder);
      const saved: SavedFile[] = [];
      for (let i = 0; i < r.completed.length; i++)
        saved.push(
          await this.destination.restoreFile(this.snapshot.files[i], r.completed[i].sha256),
        );
      this.snapshot.saved = saved;
      if (this.fileIndex < this.snapshot.files.length) {
        await this.destination.open(
          this.snapshot.files[this.fileIndex],
          this.receiverOffset,
          this.receiverOffset > 0,
        );
        this.checkpointOffset = this.receiverOffset;
      } else
        this.update({
          phase: 'complete',
          message:
            'Files received and verified. Check your browser’s downloads. Use Download if a file is missing.',
        });
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('offline', this.onNetworkChange);
    window.addEventListener('online', this.onNetworkChange);
    this.connect();
    this.ticker = setInterval(() => this.tick(), 250);
    this.update({});
  }
  private hello() {
    return {
      keyExchange: KEY_EXCHANGE,
      relayBatch: 1,
      relayPolicy: 1,
      role: this.snapshot.role,
      code: this.snapshot.code,
      credential: this.credential,
      receiver: this.receiverCredential,
      expires: this.expires,
      pairExpires: this.pairExpires,
      ...(this.group ? { uses: this.uses, slot: this.slot } : {}),
    };
  }
  private connect(): void {
    if (this.stopped) return;
    if (Date.now() < this.limitedUntil) {
      this.scheduleReconnect();
      return;
    }
    const auth = btoa(JSON.stringify(this.hello()))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${this.room}`,
      ['widesend', auth],
    );
    ws.binaryType = 'arraybuffer';
    this.relayDrain?.dispose();
    this.relayBatchAvailable = false;
    this.relayPolicyAvailable = false;
    const drain = new RelayDrain((bytes) => {
      if (this.ws === ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'drain', bytes }));
    });
    this.relayDrain = drain;
    this.ws = ws;
    clearTimeout(this.connectionTimer);
    this.connectionTimer = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN)
        this.replaceConnection('Connection did not open within 10 s');
    }, 10_000);
    ws.onopen = () => {
      if (this.ws !== ws || this.stopped) {
        ws.close(CLIENT_CLOSE.done, 'Superseded by a newer connection');
        return;
      }
      clearTimeout(this.connectionTimer);
      this.lastPong = Date.now();
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws || this.stopped) return;
      if (typeof event.data === 'string') {
        if (event.data === 'pong') {
          this.lastPong = Date.now();
          return;
        }
        try {
          const message = JSON.parse(event.data);
          // Key confirmation, peer replacement, and encrypted frames share
          // one ordered receive queue. No file frame can outrun verification.
          this.incoming = this.incoming
            .then(async () => {
              if (this.ws === ws && !this.stopped) await this.serverMessage(message);
            })
            .catch((error) => this.fail(error));
        } catch {
          this.fail('The server sent an invalid message.');
        }
      } else {
        const frame = event.data as ArrayBuffer;
        this.enqueue(frame, ws, () => drain.consumed(frame.byteLength));
      }
    };
    ws.onerror = () => {
      /* onclose performs bounded retry. */
    };
    ws.onclose = (event) => {
      drain.dispose();
      if (this.ws !== ws || this.stopped) return;
      this.ws = undefined;
      clearTimeout(this.connectionTimer);
      this.peerOnline = false;
      this.ready = false;
      this.resetDirect();
      this.closed(event);
    };
  }
  private closed(event: { code: number }): void {
    if (event.code === 4000) {
      this.update({
        phase: 'error',
        message: publicError('This connection was replaced by another tab.'),
      });
      void this.suspend();
      return;
    }
    if (event.code === 4004) {
      this.fail('The other device ended the transfer.', 'cancelled');
      return;
    }
    if (event.code === 4005) {
      this.fail(CODE_USED);
      return;
    }
    if (event.code === 4001 || event.code === 4002) {
      this.fail(
        event.code === 4001
          ? 'This session expired. Create a new transfer.'
          : 'The connection was rejected. Start a new transfer.',
      );
      return;
    }
    if (event.code === 4013 && this.limitedUntil <= Date.now())
      this.limitedUntil = Date.now() + 60_000;
    this.scheduleReconnect();
  }
  /** Asks the server to admit no further receivers, again after reconnects until it confirms. */
  seal(): void {
    this.sealing = true;
    // A reloaded sender page must not offer the code again.
    void this.save({ sealed: true }).catch(() => {});
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'seal' }));
  }
  private pendingCompletion(): boolean {
    return (
      this.snapshot.role === 'receive' &&
      this.snapshot.phase === 'complete' &&
      !this.completionAcknowledged
    );
  }
  private scheduleReconnect(): void {
    if (this.stopped || (terminal(this.snapshot.phase) && !this.pendingCompletion())) return;
    if (!this.reconnectStarted) this.reconnectStarted = Date.now();
    const cooldown = Math.max(0, this.limitedUntil - Date.now());
    // A waiting slot of a shared code keeps trying until the code's window ends
    // (tick fails it then): giving up early would leave the server's slot free,
    // and the next receiver would wait for a sender that never comes.
    if (
      !this.accepted &&
      !this.receiverCredential &&
      !this.restored &&
      !this.group &&
      !cooldown &&
      Date.now() - this.reconnectStarted > 90_000
    ) {
      this.fail(
        'Could not reconnect. Check the code, keep the sender online, and make sure this transfer has not already been claimed.',
      );
      return;
    }
    if (!this.pendingCompletion())
      this.update({
        phase: 'reconnecting',
        message: cooldown
          ? 'WideSend is busy. Keep this tab open; we’ll retry automatically.'
          : 'Waiting for the connection. Keep this tab open to continue.',
      });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnects++;
        if (this.limitedUntil) this.reconnectStarted = Date.now();
        this.meter.record('Reconnection attempt');
        this.connect();
      },
      Math.max(cooldown, Math.min(5000, 500 * 2 ** this.retry++)) + Math.random() * 250,
    );
  }
  private async serverMessage(message: {
    type: string;
    receiver?: string;
    id?: string;
    expires?: number;
    pairExpires?: number;
    retryAfter?: number;
    relayBatch?: 1;
    relayPolicy?: 1;
    keyExchange?: number;
    round?: string;
  }): Promise<void> {
    if (message.type === 'key-exchange') {
      await this.receiveKeyMessage(message);
      return;
    }
    if (message.type === 'audit-ack' && message.id) {
      this.audit.ack(message.id);
      return;
    }
    if (message.type === 'sealed') {
      this.sealing = false;
      return;
    }
    if (message.type === 'limited') {
      const seconds = message.retryAfter;
      if (!Number.isSafeInteger(seconds) || seconds! < 1 || seconds! > 86_400)
        throw new Error('The server sent an invalid message.');
      this.limitedUntil = Date.now() + seconds! * 1000;
      this.replaceConnection('The server asked to wait');
      return;
    }
    if (message.type === 'relay-limited') {
      const seconds = message.retryAfter;
      if (!Number.isSafeInteger(seconds) || seconds! < 1 || seconds! > 86_400)
        throw new Error('The server sent an invalid message.');
      this.relayAdmitted = false;
      this.relayRequest = undefined;
      this.relayRetryAt = Date.now() + seconds! * 1000;
      if (this.accepted && !terminal(this.snapshot.phase) && this.channel?.readyState !== 'open')
        this.update({
          phase: 'reconnecting',
          message: 'WideSend is busy. Keep this tab open; we’ll retry automatically.',
        });
      return;
    }
    if (message.type === 'relay-admitted') {
      const pending = this.relayRequest;
      this.relayAdmitted = true;
      this.relayRequest = undefined;
      this.relayRetryAt = 0;
      // ICE may have succeeded while admission was in flight.
      if (pending && (pending.forced || this.channel?.readyState !== 'open'))
        this.useRelay(pending.reason, pending.notify);
      return;
    }
    if (message.type === 'connected') {
      if (message.keyExchange !== KEY_EXCHANGE) {
        await this.requireUpdate();
        return;
      }
      this.relayBatchAvailable = message.relayBatch === 1;
      this.relayPolicyAvailable = message.relayPolicy === 1;
      this.relayDrain?.setLimit(this.relayBatchAvailable ? MAX_RELAY_FRAME : MAX_FRAME);
      this.retry = 0;
      this.reconnectStarted = 0;
      this.limitedUntil = 0;
      if (this.ws) this.audit.attach(this.ws);
      if (this.snapshot.role === 'send')
        this.audit.report('manifest', { event: 'manifest', files: this.snapshot.files });
      if (message.expires) this.expires = message.expires;
      if (message.pairExpires) this.pairExpires = message.pairExpires;
      if (this.snapshot.role === 'send' && message.receiver)
        this.receiverCredential = message.receiver;
      await this.save({
        expires: this.expires,
        pairExpires: this.pairExpires,
        receiver: this.receiverCredential,
      });
      this.markClaimed();
      if (this.sealing && this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify({ type: 'seal' }));
    }
    if (message.type === 'connected' && !this.accepted)
      this.update({
        phase: 'waiting',
        message:
          this.snapshot.role === 'send'
            ? 'Ready when you are. Share the code with your other device.'
            : 'Waiting for the sender’s file list…',
      });
    if (message.type === 'peer-offline') {
      this.peerOnline = false;
      this.ready = false;
      this.resetDirect();
      if (!terminal(this.snapshot.phase))
        this.update({
          phase: 'reconnecting',
          message: 'The other device disconnected. Keep this tab open to resume.',
        });
    }
    if (message.type === 'peer-online') {
      this.resetDirect();
      this.ready = false;
      this.peerOnline = true;
      const generation = this.connectionGeneration;
      if (this.snapshot.role === 'send') this.receiverCredential = message.receiver;
      await this.save({ receiver: this.receiverCredential });
      this.markClaimed();
      if (
        message.keyExchange !== KEY_EXCHANGE ||
        !message.round ||
        !/^[0-9a-f-]{36}$/.test(message.round)
      ) {
        await this.requireUpdate();
        return;
      }
      const session = await KeySession.start(
        this.snapshot.code,
        this.snapshot.role,
        this.identity!,
        siteName(),
        this.room,
        this.expires,
        message.round,
      );
      if (generation !== this.connectionGeneration || this.stopped) {
        session.destroy();
        return;
      }
      this.keySession = session;
      this.keyDeadline = Date.now() + 20_000;
      this.sendKeyMessage(session.share);
    }
  }
  private markClaimed(): void {
    if (this.snapshot.role === 'send' && this.receiverCredential && !this.snapshot.claimed)
      this.update({ claimed: true });
  }
  private async requireUpdate(): Promise<void> {
    this.update({ phase: 'reconnecting', message: UPDATE_REQUIRED });
    // Preserve both the journal and local files. Refresh can upgrade the
    // existing transfer; never silently fall back to code-derived encryption.
    this.stop('This page needs an update');
    await this.destination?.suspend();
    await this.recovery?.unlock();
  }
  private sendKeyMessage(message: KeyMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  private async receiveKeyMessage(message: unknown): Promise<void> {
    if (!validKeyMessage(message)) throw new Error(PAIRING_ERROR);
    const session = this.keySession,
      generation = this.connectionGeneration;
    // A frame from a replaced connection must not revive its old keys.
    if (!session || message.round !== session.round) return;
    try {
      if (message.step === 'share') {
        const reply = await session.receiveShare(message);
        if (generation === this.connectionGeneration && !this.stopped) this.sendKeyMessage(reply);
        return;
      }
      const { cipher, peerKey } = await session.confirm(message);
      if (generation !== this.connectionGeneration || this.stopped) return;
      this.identity = { ...this.identity!, peerKey };
      await this.save({ identity: this.identity });
      if (generation !== this.connectionGeneration || this.stopped) return;
      this.cipher = cipher;
      this.keyDeadline = 0;
      if (this.snapshot.role === 'send') {
        await this.manifest();
        if (generation !== this.connectionGeneration || this.stopped) return;
        if (!this.peer && !this.relay && !terminal(this.snapshot.phase)) await this.negotiate();
      } else if (this.accepted) {
        if (this.fileIndex >= this.snapshot.files.length) await this.control({ type: 'complete' });
        else
          await this.control({ type: 'ready', file: this.fileIndex, offset: this.receiverOffset });
      }
      if (this.accepted && !terminal(this.snapshot.phase))
        this.update({
          phase: 'transferring',
          message: 'Connection restored. Continuing your transfer.',
        });
      this.waitForDirect();
    } catch {
      if (generation === this.connectionGeneration && !this.stopped) throw new Error(PAIRING_ERROR);
    }
  }
  private enqueue(frame: ArrayBuffer, transport: Transport, drained?: () => void): void {
    const generation = this.connectionGeneration;
    const websocket = transport instanceof WebSocket;
    let consumedGeneration = -1;
    this.incoming = this.incoming
      .then(async () => {
        if (
          this.stopped ||
          (!websocket && generation !== this.connectionGeneration) ||
          (transport instanceof WebSocket
            ? transport !== this.ws
            : this.relay || transport !== this.channel)
        )
          return;
        const max =
          transport instanceof WebSocket && this.relayBatchAvailable ? MAX_RELAY_FRAME : MAX_FRAME;
        if (frame.byteLength > max) throw new Error('Oversized transfer frame.');
        if (!this.cipher) throw new Error(PAIRING_ERROR);
        const currentGeneration = this.connectionGeneration;
        consumedGeneration = currentGeneration;
        const plain = await this.cipher.open(frame);
        if (currentGeneration !== this.connectionGeneration || this.stopped) return;
        if (plain[0] === 0) {
          const message = decodeControl(plain);
          if (message.type === 'probe') await this.handleProbe(message, transport);
          else await this.handleControl(message, transport);
        } else if (plain[0] === 1 || plain[0] === 2) await this.handleChunk(plain, transport);
        else throw new Error('Unsupported transfer frame.');
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        if (consumedGeneration === this.connectionGeneration) drained?.();
      });
  }
  private control(message: Control, receivedOn?: Transport): Promise<void> {
    const generation = this.connectionGeneration;
    const work = this.outgoing.then(async () => {
      if (this.stopped || !this.cipher || generation !== this.connectionGeneration) return;
      const encrypted = await this.cipher.control(
        message.type === 'ready'
          ? { ...message, relayBatch: this.relayBatchAvailable ? 1 : undefined }
          : message,
      );
      if (this.stopped || generation !== this.connectionGeneration) return;
      if (encrypted.byteLength > MAX_FRAME)
        throw new Error('The file list is too large. Send fewer files at once.');
      // Keep negotiation and file lifecycle messages on the ordered signaling
      // stream. Frequent ACKs follow the file data, avoiding a WAN round trip
      // for each send window. Older clients already accept ACKs on either path.
      if (
        message.type === 'ack' &&
        !this.relay &&
        receivedOn === this.channel &&
        this.channel?.readyState === 'open'
      ) {
        try {
          this.channel.send(encrypted);
          this.acknowledgementPath = 'direct';
          return;
        } catch {
          this.useRelay('Direct connection failed');
        }
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendRelay(encrypted);
        if (message.type === 'ack') this.acknowledgementPath = 'relay';
      }
    });
    this.outgoing = work.catch(() => {});
    return work;
  }
  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    this.peer = pc;
    pc.onicecandidate = (event) => {
      if (this.peer !== pc || this.stopped || this.relay) return;
      if (event.candidate)
        void this.control({ type: 'signal', candidate: event.candidate.toJSON() }).catch((error) =>
          this.fail(error),
        );
    };
    pc.ondatachannel = (event) => {
      if (this.peer === pc && !this.relay && !this.stopped) this.attachChannel(event.channel);
      else event.channel.close();
    };
    pc.onconnectionstatechange = () => {
      if (this.peer !== pc) return;
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && !this.stopped)
        this.useRelay('Direct connection closed');
    };
    return pc;
  }
  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (event) => this.enqueue(event.data as ArrayBuffer, channel);
    channel.onopen = () => {
      if (this.channel !== channel || this.relay || this.stopped) return;
      clearTimeout(this.directTimer);
      this.directTimer = undefined;
      this.relayRetryAt = 0;
      this.relayRequest = undefined;
      this.update({
        route: 'direct',
        ...(this.accepted && !terminal(this.snapshot.phase)
          ? {
              phase: 'transferring' as const,
              message: 'Connection restored. Continuing your transfer.',
            }
          : {}),
      });
      this.measurePath(performance.now());
      void this.pump();
    };
    channel.onerror = () => {
      if (this.channel === channel) this.useRelay('Direct connection failed');
    };
    channel.onclose = () => {
      if (!this.stopped && this.channel === channel) this.useRelay('Direct connection closed');
    };
  }
  private async negotiate(): Promise<void> {
    if (this.negotiating) return;
    this.negotiating = true;
    const generation = this.connectionGeneration;
    try {
      const pc = this.createPeer();
      this.attachChannel(pc.createDataChannel('widesend', { ordered: true }));
      const offer = await pc.createOffer();
      if (this.peer !== pc || this.relay || this.stopped) return;
      await pc.setLocalDescription(offer);
      if (this.peer !== pc || this.relay || this.stopped) return;
      await this.control({ type: 'signal', description: pc.localDescription!.toJSON() });
    } catch {
      if (generation === this.connectionGeneration) this.useRelay('Direct connection unavailable');
    }
  }
  private async signal(message: Extract<Control, { type: 'signal' }>): Promise<void> {
    if (this.relay) return;
    const generation = this.connectionGeneration;
    try {
      const pc = this.peer || this.createPeer();
      if (message.description) {
        await pc.setRemoteDescription(message.description);
        if (this.peer !== pc || this.relay || this.stopped) return;
        for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
        if (message.description.type === 'offer') {
          const answer = await pc.createAnswer();
          if (this.peer !== pc || this.relay || this.stopped) return;
          await pc.setLocalDescription(answer);
          if (this.peer !== pc || this.relay || this.stopped) return;
          await this.control({ type: 'signal', description: pc.localDescription!.toJSON() });
        }
      } else if (message.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
        else this.candidates.push(message.candidate);
      }
    } catch {
      if (generation === this.connectionGeneration) this.useRelay('Direct connection unavailable');
    }
  }
  private useRelay(reason: string, notify = true): void {
    if (this.relay || this.stopped || terminal(this.snapshot.phase)) return;
    if (this.relayPolicyAvailable && !this.relayAdmitted) {
      if (
        this.relayRequest ||
        Date.now() < this.relayRetryAt ||
        this.ws?.readyState !== WebSocket.OPEN
      )
        return;
      this.relayRequest = {
        reason,
        notify,
        forced: this.channel?.readyState === 'open',
        sentAt: Date.now(),
      };
      this.ws.send(JSON.stringify({ type: 'relay-request' }));
      return;
    }
    this.relay = true;
    clearTimeout(this.directTimer);
    this.directTimer = undefined;
    this.fallbackReason = reason;
    this.meter.record(reason);
    this.cursor = this.acknowledged;
    this.update({
      route: 'relay',
      ...(this.accepted
        ? {
            phase: 'transferring' as const,
            message: 'Connection restored. Continuing your transfer.',
          }
        : {}),
    });
    if (notify) void this.control({ type: 'relay' }).catch((error) => this.fail(error));
    this.channel?.close();
    this.peer?.close();
    void this.pump();
  }
  private async handleControl(message: Control, transport: Transport): Promise<void> {
    if (message.type === 'signal') {
      await this.signal(message);
      return;
    }
    if (message.type === 'relay') {
      this.useRelay('Other device requested relay', false);
      return;
    }
    if (message.type === 'cancel') {
      this.fail('The other device ended the transfer.', 'cancelled');
      return;
    }
    if (message.type === 'manifest' && this.snapshot.role === 'receive') {
      const files = validateManifest(message.files);
      if (message.fingerprints) {
        const fingerprints = validateFingerprints(message.fingerprints, files.length);
        if (this.fingerprints && JSON.stringify(fingerprints) !== JSON.stringify(this.fingerprints))
          throw new Error('The source file changed during transfer.');
        this.fingerprints = fingerprints;
        await this.save({ fingerprints });
      }
      await this.save({ files });
      this.audit.report('manifest', { event: 'manifest', files });
      if (this.snapshot.files.length) {
        if (JSON.stringify(files) !== JSON.stringify(this.snapshot.files))
          throw new Error('The file list changed during transfer.');
        if (this.accepted) {
          if (this.fileIndex >= files.length) await this.control({ type: 'complete' });
          else
            await this.control({
              type: 'ready',
              file: this.fileIndex,
              offset: this.receiverOffset,
            });
        } else
          this.update({
            phase: 'offered',
            message: 'Your files are ready. Select Receive to start downloading.',
          });
      } else
        this.update({
          files,
          total: files.reduce((sum, f) => sum + f.size, 0),
          phase: 'offered',
          message: 'Your files are ready. Select Receive to start downloading.',
        });
      return;
    }
    if (this.snapshot.role === 'send') {
      if (message.type === 'ready') {
        this.peerRelayBatch = message.relayBatch === 1;
        const file = this.snapshot.files[message.file];
        if (
          !file ||
          !validOffset(message.offset, file.size) ||
          (!this.restored && (message.file < this.fileIndex || message.file > this.fileIndex + 1))
        )
          throw new Error('Invalid resume position.');
        if (message.file !== this.fileIndex) this.highestSent = 0;
        this.verifiedFiles = Math.max(this.verifiedFiles, message.file);
        this.fileIndex = message.file;
        this.acknowledged = message.offset;
        this.cursor = message.offset;
        this.highestSent = Math.max(this.highestSent, message.offset);
        if (this.restored && !this.restoredPosition) {
          this.progressBaseline = this.transferredBytes();
          this.restoredPosition = true;
        }
        this.lastAck = Date.now();
        this.lastEnd = 0;
        this.ready = true;
        this.accepted = true;
        this.waitForDirect();
        await this.save({ accepted: true, fileIndex: this.fileIndex, offset: this.acknowledged });
        this.update({
          phase: 'transferring',
          message: 'Sending your files. Keep both devices awake.',
        });
        void this.keepAwake();
        this.progress();
        if (this.sendFiles.length) void this.prepareSources().catch((error) => this.fail(error));
        void this.pump();
      } else if (message.type === 'ack') {
        if (message.file < this.fileIndex) return;
        const file = this.snapshot.files[this.fileIndex];
        if (
          message.file !== this.fileIndex ||
          !file ||
          !validOffset(message.offset, file.size) ||
          message.offset > this.highestSent
        )
          throw new Error('Invalid delivery acknowledgement.');
        this.acknowledgementPath = transport instanceof WebSocket ? 'relay' : 'direct';
        if (message.offset > this.acknowledged) {
          this.acknowledged = message.offset;
          this.cursor = Math.max(this.cursor, message.offset);
          this.lastAck = Date.now();
          this.progress();
        }
        void this.pump();
      } else if (message.type === 'complete') {
        // The receiver only completes after every file is closed successfully.
        if (
          !this.restored &&
          (this.fileIndex !== this.snapshot.files.length - 1 ||
            this.acknowledged !== this.snapshot.files[this.fileIndex].size)
        )
          throw new Error('Unexpected transfer completion.');
        await this.control({ type: 'complete-ack' });
        await this.forget('complete');
        this.verifiedFiles = this.snapshot.files.length;
        this.fileIndex = this.snapshot.files.length - 1;
        this.acknowledged = this.snapshot.files[this.fileIndex].size;
        this.update({
          phase: 'complete',
          transferred: this.snapshot.total,
          message: 'Your files have arrived.',
        });
        await this.wakeLock?.release();
      }
    } else if (message.type === 'complete-ack') {
      if (this.fileIndex === this.snapshot.files.length && this.accepted) {
        this.completionAcknowledged = true;
        await this.forget();
      }
    } else if (message.type === 'file-end') {
      if (message.file < this.fileIndex) {
        if (this.fileIndex >= this.snapshot.files.length) await this.control({ type: 'complete' });
        else
          await this.control({ type: 'ready', file: this.fileIndex, offset: this.receiverOffset });
        return;
      }
      const file = this.snapshot.files[this.fileIndex];
      if (!this.accepted || message.file !== this.fileIndex || this.receiverOffset !== file.size)
        throw new Error('File ended before all bytes arrived.');
      this.verifying = true;
      this.meter.record('Verifying file');
      this.update({ message: 'Almost done. Checking your file…' });
      if (this.fingerprints && message.hash !== this.fingerprints[this.fileIndex].sha256)
        throw new Error('The source file changed during transfer.');
      const saved = await this.destination!.finish(message.hash);
      if (this.stopped || terminal(this.snapshot.phase)) return;
      this.verifying = false;
      this.verifiedFiles++;
      this.meter.record('File verified');
      this.audit.report(`file:${file.id}`, {
        event: 'file',
        file,
        md5: saved.md5,
        sha256: saved.sha256,
      });
      this.update({ saved: [...this.snapshot.saved, saved] });
      // Download permission is controlled by the browser; a retry link stays available.
      try {
        downloadFile(saved);
      } catch {
        /* The receiver can use Download manually. */
      }
      this.fileIndex++;
      this.receiverOffset = 0;
      this.lastReceiverAck = 0;
      this.checkpointOffset = 0;
      await this.save({
        fileIndex: this.fileIndex,
        offset: 0,
        completed: this.snapshot.saved.map(({ sha256, md5 }) => ({ sha256, md5 })),
      });
      if (this.fileIndex === this.snapshot.files.length) {
        await this.control({ type: 'complete' });
        this.update({
          phase: 'complete',
          transferred: this.snapshot.total,
          message:
            'Files received and verified. Check your browser’s downloads. Use Download if a file is missing.',
        });
        await this.wakeLock?.release();
      } else {
        await this.destination!.open(this.snapshot.files[this.fileIndex]);
        this.update({
          message: 'Receiving your files. Keep this page open and your device awake.',
        });
        await this.control({ type: 'ready', file: this.fileIndex, offset: 0 });
      }
    }
  }
  async accept(): Promise<void> {
    if (this.accepted || this.snapshot.phase !== 'offered') return;
    const destination = new Destination();
    try {
      await destination.prepare(this.snapshot.files);
      if (this.stopped || terminal(this.snapshot.phase)) {
        await destination.dispose();
        return;
      }
      await destination.open(this.snapshot.files[0]);
      if (this.stopped || terminal(this.snapshot.phase)) {
        await destination.dispose();
        return;
      }
      this.destination = destination;
      await this.save({ folder: destination.folder, accepted: true });
      if (this.stopped || terminal(this.snapshot.phase)) return;
      this.accepted = true;
      this.update({
        phase: 'transferring',
        message: 'Receiving your files. Keep this page open and your device awake.',
      });
      void this.keepAwake();
      this.waitForDirect();
      if (!this.stopped) await this.control({ type: 'ready', file: 0, offset: 0 });
    } catch (error) {
      await destination.dispose();
      if ((error as DOMException).name === 'AbortError') return;
      throw error;
    }
  }
  private async handleChunk(plain: Uint8Array<ArrayBuffer>, transport: Transport): Promise<void> {
    const generation = this.connectionGeneration;
    if (this.snapshot.role !== 'receive' || !this.accepted || plain.length < 13)
      throw new Error('Unexpected file data.');
    const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    const index = view.getUint32(1);
    const offset = view.getFloat64(5);
    if (index < this.fileIndex) return; // Retransmission of an already closed file.
    const file = this.snapshot.files[this.fileIndex];
    const size = plain.length - 13;
    const batch = plain[0] === 2;
    if (
      !file ||
      index !== this.fileIndex ||
      !validOffset(offset, file.size) ||
      (batch
        ? !this.relayBatchAvailable ||
          !(transport instanceof WebSocket) ||
          size > RELAY_BATCH_SIZE ||
          offset + size > file.size ||
          (size % CHUNK_SIZE !== 0 && offset + size !== file.size)
        : size !== Math.min(CHUNK_SIZE, file.size - offset)) ||
      size === 0
    )
      throw new Error('Invalid file chunk.');
    for (let start = 0; start < size; start += CHUNK_SIZE) {
      if (this.stopped || generation !== this.connectionGeneration) return;
      // A replayed batch may straddle the saved offset; skip its old chunks and
      // keep writing the remaining tail at the original checkpoint granularity.
      if (offset + start !== this.receiverOffset) continue;
      const data = plain.slice(13 + start, 13 + Math.min(size, start + CHUNK_SIZE));
      const written = data.byteLength;
      await this.destination!.write(offset + start, data.buffer);
      // The disk worker takes ownership of data.buffer, detaching it here.
      this.receiverOffset += written;
      if (
        this.receiverOffset - this.checkpointOffset >= 1024 * 1024 ||
        Date.now() - this.lastCheckpoint >= 1000 ||
        this.receiverOffset === file.size
      ) {
        // Never commit an offset until its bytes have reached disk. A crash can
        // discard a later uncommitted tail, but cannot skip missing file data.
        await this.destination!.flush();
        await this.save({ fileIndex: this.fileIndex, offset: this.receiverOffset });
        this.checkpointOffset = this.receiverOffset;
        this.lastCheckpoint = Date.now();
      }
      this.progress();
    }
    // A pending write can finish after reconnect. Preserve its checkpoint; the
    // replacement connection learns that offset from ready before accepting ACKs.
    if (this.stopped || generation !== this.connectionGeneration) return;
    // Duplicate and out-of-order chunks cause a cumulative ACK, never a second write.
    if (
      batch ||
      offset !== this.receiverOffset - size ||
      this.receiverOffset - this.lastReceiverAck >= CHUNK_SIZE * 4 ||
      this.receiverOffset === file.size
    ) {
      await this.control({ type: 'ack', file: index, offset: this.receiverOffset }, transport);
      this.lastReceiverAck = this.receiverOffset;
    }
  }
  private async pump(): Promise<void> {
    if (
      this.pumping ||
      !this.cipher ||
      !this.fingerprints ||
      !this.sendFiles.length ||
      this.snapshot.checkingFiles ||
      !this.ready ||
      (!this.relay && this.channel?.readyState !== 'open') ||
      !this.peerOnline ||
      this.stopped ||
      this.snapshot.role !== 'send' ||
      terminal(this.snapshot.phase)
    )
      return;
    this.pumping = true;
    try {
      const fileIndex = this.fileIndex;
      const file = this.sendFiles[fileIndex];
      const fileHash = this.fingerprints[fileIndex];
      while (
        this.peerOnline &&
        !this.stopped &&
        this.fileIndex === fileIndex &&
        this.cursor < file.size &&
        this.cursor - this.acknowledged < WINDOW_SIZE
      ) {
        const generation = this.connectionGeneration;
        const route = !this.relay && this.channel?.readyState === 'open' ? this.channel : this.ws;
        if (!route || route.readyState !== (route instanceof WebSocket ? WebSocket.OPEN : 'open'))
          break;
        if (route.bufferedAmount > WINDOW_SIZE) break;
        const offset = this.cursor;
        const batch = route === this.ws && this.relayBatchAvailable && this.peerRelayBatch;
        const length = Math.min(
          batch ? RELAY_BATCH_SIZE : CHUNK_SIZE,
          WINDOW_SIZE - (this.cursor - this.acknowledged),
        );
        const bytes = await file.slice(offset, offset + length).arrayBuffer();
        const cipher = this.cipher;
        if (!cipher || generation !== this.connectionGeneration || this.stopped) break;
        const frame = await cipher.chunk(fileIndex, offset, bytes, batch);
        if (
          this.stopped ||
          generation !== this.connectionGeneration ||
          this.cursor !== offset ||
          this.fileIndex !== fileIndex ||
          route !== this.dataRoute() ||
          !this.peerOnline
        )
          break;
        try {
          if (route === this.ws) this.sendRelay(frame, true);
          else route.send(frame);
        } catch {
          this.useRelay('Direct connection failed');
          break;
        }
        this.resentBytes += Math.min(bytes.byteLength, Math.max(0, this.highestSent - offset));
        this.cursor += bytes.byteLength;
        this.highestSent = Math.max(this.highestSent, this.cursor);
      }
      if (
        this.fileIndex === fileIndex &&
        this.acknowledged === file.size &&
        Date.now() - this.lastEnd > 2000
      ) {
        this.lastEnd = Date.now();
        this.audit.report(`file:${fileIndex}`, {
          event: 'file',
          file: this.snapshot.files[fileIndex],
          md5: fileHash.md5,
          sha256: fileHash.sha256,
        });
        await this.control({ type: 'file-end', file: fileIndex, hash: fileHash.sha256 });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.pumping = false;
    }
  }
  private transferredBytes(): number {
    const done = this.snapshot.files.slice(0, this.fileIndex).reduce((sum, f) => sum + f.size, 0);
    return done + (this.snapshot.role === 'send' ? this.acknowledged : this.receiverOffset);
  }
  private progress(): void {
    const transferred = this.transferredBytes();
    const now = performance.now();
    if (now - this.lastRender < 100 && transferred !== this.snapshot.total) return;
    this.lastRender = now;
    this.update({ transferred });
  }
  private dataRoute(): Transport | undefined {
    return !this.relay && this.channel?.readyState === 'open' ? this.channel : this.ws;
  }
  private sendRelay(frame: ArrayBuffer, file = false): void {
    this.ws?.send(this.relayPolicyAvailable ? relayFrame(frame, file) : frame);
  }
  private transportOpen(route: Transport): boolean {
    return route.readyState === (route instanceof WebSocket ? WebSocket.OPEN : 'open');
  }
  private async sendProbe(message: Extract<Control, { type: 'probe' }>, route: Transport) {
    // Diagnostics are best effort and must never fail or hold up a transfer.
    try {
      const generation = this.connectionGeneration;
      if (!this.cipher) return;
      const encrypted = await this.cipher.control(message);
      if (
        !this.stopped &&
        generation === this.connectionGeneration &&
        this.transportOpen(route) &&
        route.bufferedAmount <= WINDOW_SIZE
      ) {
        if (route === this.ws) this.sendRelay(encrypted);
        else route.send(encrypted);
      }
    } catch {
      /* A missed measurement is shown as unavailable, never as a transfer error. */
    }
  }
  private async handleProbe(message: Extract<Control, { type: 'probe' }>, route: Transport) {
    if (!Number.isSafeInteger(message.id) || message.id < 1 || typeof message.reply !== 'boolean')
      return;
    const now = performance.now();
    if (message.reply) {
      const pending = this.pendingProbe;
      if (
        pending?.id === message.id &&
        pending.route === route &&
        now - pending.sent < 15_000 &&
        !terminal(this.snapshot.phase)
      ) {
        this.latency = { ms: now - pending.sent, measured: now };
        this.pendingProbe = undefined;
      }
    } else if (this.accepted && now - this.lastEcho >= 1000) {
      this.lastEcho = now;
      await this.sendProbe({ type: 'probe', id: message.id, reply: true }, route);
    }
  }
  private measureLatency(now: number): void {
    if (this.pendingProbe && now - this.pendingProbe.sent >= 15_000) this.pendingProbe = undefined;
    if (
      this.snapshot.phase !== 'transferring' ||
      !this.peerOnline ||
      this.verifying ||
      this.snapshot.route === 'connecting' ||
      this.pendingProbe ||
      now - this.lastProbe < 5000
    )
      return;
    const route = this.dataRoute();
    if (!route || !this.transportOpen(route) || route.bufferedAmount > WINDOW_SIZE) return;
    this.lastProbe = now;
    this.pendingProbe = { id: ++this.probeId, sent: now, route };
    void this.sendProbe({ type: 'probe', id: this.probeId, reply: false }, route);
  }
  private measurePath(now: number): void {
    const peer = this.peer;
    if (
      !peer ||
      this.relay ||
      this.channel?.readyState !== 'open' ||
      this.pathReading === peer ||
      now - this.lastPathRead < 3000 ||
      terminal(this.snapshot.phase)
    )
      return;
    this.pathReading = peer;
    this.lastPathRead = now;
    void Promise.resolve()
      .then(() => peer.getStats())
      .then((report) => {
        if (this.peer === peer && !this.relay && !this.stopped && !terminal(this.snapshot.phase))
          this.path = connectionPath(report);
      })
      .catch(() => {
        if (this.peer === peer && !terminal(this.snapshot.phase)) this.path = null;
      })
      .finally(() => {
        if (this.pathReading === peer) this.pathReading = undefined;
      });
  }
  private readStats(state: Snapshot): TransferStats {
    const finished = terminal(state.phase);
    const timing = this.meter.sample(
      Math.max(0, this.transferredBytes() - this.progressBaseline),
      finished,
    );
    const currentFile = Math.max(0, Math.min(this.fileIndex, state.files.length - 1));
    const fileTransferred =
      state.phase === 'complete'
        ? (state.files[currentFile]?.size ?? 0)
        : state.role === 'send'
          ? this.acknowledged
          : this.receiverOffset;
    const awaitingVerification =
      state.role === 'send' &&
      this.ready &&
      this.acknowledged === state.files[this.fileIndex]?.size;
    const unacknowledged = Math.max(0, this.highestSent - this.acknowledged);
    return {
      ...timing,
      queuedBytes:
        (this.ws?.bufferedAmount ?? 0) + (!this.relay ? (this.channel?.bufferedAmount ?? 0) : 0),
      unacknowledgedBytes: state.role === 'send' ? unacknowledged : null,
      resentBytes: state.role === 'send' ? this.resentBytes : null,
      reconnects: this.reconnects,
      latencyMs:
        this.latency && performance.now() - this.latency.measured < 15_000 ? this.latency.ms : null,
      fallbackReason: this.fallbackReason,
      connectionPath: state.route === 'direct' ? this.path : null,
      acknowledgementPath: this.acknowledgementPath,
      currentFile,
      fileTransferred,
      verifiedFiles: this.verifiedFiles,
      activity:
        state.phase === 'complete'
          ? 'All files verified'
          : state.phase === 'error'
            ? 'Transfer failed'
            : state.phase === 'cancelled'
              ? 'Transfer cancelled'
              : state.phase === 'reconnecting'
                ? 'Reconnecting…'
                : this.verifying
                  ? 'Verifying file'
                  : state.route === 'connecting'
                    ? 'Waiting for connection'
                    : awaitingVerification
                      ? 'Waiting for verification'
                      : state.role === 'receive'
                        ? 'Receiving'
                        : unacknowledged >= WINDOW_SIZE
                          ? 'Waiting for acknowledgement'
                          : 'Sending',
    };
  }
  private tick(): void {
    if (this.stopped) return;
    this.audit.flush();
    const now = Date.now();
    if (this.keyDeadline && now > this.keyDeadline) {
      this.replaceConnection('Key exchange timed out');
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN && now - this.lastPing > 15_000) {
      if (now - this.lastPong > 45_000) {
        this.replaceConnection('No reply from the server for 45 s');
        return;
      }
      this.ws.send('ping');
      this.lastPing = now;
    }
    if (
      this.pendingCompletion() &&
      this.peerOnline &&
      now - this.lastEnd > 2000 &&
      now < this.expires
    ) {
      this.lastEnd = now;
      void this.control({ type: 'complete' }).catch(() => {});
    }
    if (terminal(this.snapshot.phase)) return;
    if (
      this.accepted &&
      now < this.relayRetryAt &&
      this.channel?.readyState !== 'open' &&
      this.snapshot.phase !== 'reconnecting'
    )
      this.update({
        phase: 'reconnecting',
        message: 'WideSend is busy. Keep this tab open; we’ll retry automatically.',
      });
    if (this.peerOnline && this.accepted && this.channel?.readyState !== 'open') {
      if (this.relayRequest && now - this.relayRequest.sentAt > 10_000) {
        this.relayRequest = undefined;
        this.relayRetryAt = now;
      }
      if (!this.relayRequest && this.relayRetryAt && now >= this.relayRetryAt) {
        this.relayRetryAt = 0;
        this.useRelay('Retrying relay connection');
      }
    }
    const monotonicNow = performance.now();
    if (this.accepted) {
      this.measurePath(monotonicNow);
      this.measureLatency(monotonicNow);
      if (monotonicNow - this.lastStats >= 1000) {
        this.lastStats = monotonicNow;
        const stats = this.readStats(this.snapshot);
        this.update({ stats, speed: stats.speed });
      }
    }
    if (
      now > this.expires ||
      (!this.receiverCredential && this.snapshot.role === 'send' && now > this.pairExpires)
    ) {
      this.fail('This code expired. Start a new transfer.');
      return;
    }
    if (this.snapshot.role === 'send' && this.ready && this.peerOnline) {
      if (this.cursor > this.acknowledged && now - this.lastAck > 8000) {
        if (this.relay) this.meter.record('Resuming from last acknowledgement');
        this.useRelay('Direct connection stalled');
        this.cursor = this.acknowledged;
        this.lastAck = now;
      }
      void this.pump();
    }
  }
  private async keepAwake(): Promise<void> {
    try {
      if (!this.wakeLock || this.wakeLock.released)
        this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      /* Browsers may decline in background or low-power mode. */
    }
  }
  private fail(error: unknown, phase: 'error' | 'cancelled' = 'error'): void {
    if (this.stopped) return;
    const message = publicError(error);
    this.update({ phase, message });
    void this.control({
      type: 'cancel',
      reason: phase === 'error' ? 'Transfer failed. Please start again.' : 'Transfer cancelled.',
    }).finally(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'end' }));
      this.stop(phase === 'error' ? `Failed: ${message}` : 'Transfer cancelled.');
      void this.forget(phase).catch(() => {});
      void this.destination?.dispose();
    });
  }
  cancel(): void {
    this.fail('Transfer cancelled.', 'cancelled');
  }
  private stop(reason: string): void {
    this.stopped = true;
    this.keySession?.destroy();
    this.keySession = undefined;
    this.cipher = undefined;
    this.relayDrain?.dispose();
    this.sourceAbort.abort();
    clearInterval(this.ticker);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectionTimer);
    clearTimeout(this.directTimer);
    this.ws?.close(CLIENT_CLOSE.done, closeReason(reason));
    this.channel?.close();
    this.peer?.close();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('offline', this.onNetworkChange);
    window.removeEventListener('online', this.onNetworkChange);
    window.removeEventListener('pagehide', this.onPageHide);
    void this.wakeLock?.release();
  }
  async suspend(): Promise<void> {
    this.stop('Transfer paused on this page');
    await this.incoming;
    await this.destination?.suspend();
    await this.recovery?.unlock();
  }
  async dispose(): Promise<void> {
    this.stop('Transfer closed on this page');
    try {
      await this.forget();
    } finally {
      await this.destination?.dispose();
    }
  }
}
