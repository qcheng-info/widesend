import {
  MAX_RECEIVERS,
  PAIRING_MS,
  SESSION_MS,
  validateManifest,
  type FileMeta,
  type Fingerprint,
} from '../shared/protocol';
import { pairingCode, token } from './crypto';
import { fingerprintFile } from './integrity';
import { publicError } from './messages';
import { RecoverySession } from './recovery';
import { Transfer, type Phase, type Slot, type Snapshot } from './transfer';

// A send that several people can receive with one code. Each receiver is its own
// one-to-one Transfer (a slot); this keeps one slot waiting for the next person
// at a time, shares the files and their fingerprints, and decides when it ends.

export type ReceiverRow = {
  slot: number;
  phase: Phase;
  claimed: boolean;
  transferred: number;
  total: number;
  speed: number;
  route: Snapshot['route'];
  message: string;
};
export type GroupSnapshot = {
  code: string;
  uses: number;
  files: FileMeta[];
  total: number;
  pairExpires: number;
  // New receivers can still use the code.
  open: boolean;
  phase: 'active' | 'complete' | 'error' | 'cancelled';
  message: string;
  receivers: ReceiverRow[];
  joined: number;
  delivered: number;
  needsFiles: boolean;
  checkingFiles: boolean;
};
export type SlotTransfer = Pick<
  Transfer,
  'snapshot' | 'start' | 'cancel' | 'seal' | 'dispose' | 'resumeWith'
>;
export type MakeSlot = (slot: Slot, listener: (s: Snapshot) => void) => SlotTransfer;
type Base = {
  code: string;
  credential: string;
  uses: number;
  expires: number;
  pairExpires: number;
  files: FileMeta[];
};
type Entry = {
  row: ReceiverRow;
  transfer?: SlotTransfer;
  // A finished slot restored from storage, removed when the send ends.
  record?: RecoverySession;
  // This slot carries the request to close the code.
  sealing?: boolean;
};
const terminal = (phase: Phase) =>
  phase === 'complete' || phase === 'error' || phase === 'cancelled';
const rowOf = (slot: number, s: Snapshot): ReceiverRow => ({
  slot,
  phase: s.phase,
  claimed: !!s.claimed,
  transferred: s.transferred,
  total: s.total,
  speed: s.speed,
  route: s.route,
  message: s.message,
});

export class SendSession {
  snapshot: GroupSnapshot;
  /** Every slot has been disposed after the send ended. */
  readonly settled: Promise<void>;
  private settle!: () => void;
  private entries = new Map<number, Entry>();
  private sources: File[] = [];
  private fingerprints?: Promise<Fingerprint[]>;
  private savedFingerprints?: Fingerprint[];
  private abort = new AbortController();
  private make: MakeSlot;
  private phase: GroupSnapshot['phase'] = 'active';
  private message = '';
  private sealed = false;
  private cancelled = false;
  private finished = false;
  private disposed = false;
  private needsFiles = false;
  private checkingFiles = false;
  private ticker?: ReturnType<typeof setInterval>;

  private constructor(
    private base: Base,
    private listener: (snapshot: GroupSnapshot) => void,
    make?: MakeSlot,
  ) {
    this.make = make ?? ((slot, update) => Transfer.sender(this.sources, update, slot));
    this.settled = new Promise((resolve) => (this.settle = resolve));
    this.snapshot = this.read();
  }

  static create(
    files: File[],
    uses: number,
    listener: (snapshot: GroupSnapshot) => void,
    make?: MakeSlot,
  ): SendSession {
    if (!Number.isSafeInteger(uses) || uses < 1 || uses > MAX_RECEIVERS)
      throw new Error('Invalid number of receivers.');
    const metadata = validateManifest(
      files.map((file, id) => ({ id, name: file.name, size: file.size, type: file.type })),
    );
    const now = Date.now();
    const session = new SendSession(
      {
        code: pairingCode(),
        credential: token(32),
        uses,
        expires: now + SESSION_MS,
        pairExpires: now + PAIRING_MS,
        files: metadata,
      },
      listener,
      make,
    );
    session.sources = files;
    return session;
  }

  /** Rebuilds a send from the saved record of one of its slots, after a reload. */
  static async restore(
    first: RecoverySession,
    listener: (snapshot: GroupSnapshot) => void,
  ): Promise<SendSession> {
    const records = [first, ...(await RecoverySession.group(first.record))];
    const r = first.record;
    const session = new SendSession(
      {
        code: r.code,
        credential: r.credential ?? r.id,
        uses: r.uses ?? 1,
        expires: r.expires,
        pairExpires: r.pairExpires,
        files: r.files,
      },
      listener,
    );
    session.needsFiles = true;
    session.sealed = records.some((s) => s.record.sealed);
    session.savedFingerprints = records.find((s) => s.record.fingerprints)?.record.fingerprints;
    const total = r.files.reduce((sum, file) => sum + file.size, 0);
    for (const record of records) {
      const slot = record.record.slot ?? 0;
      const finished = record.record.finished;
      if (finished) {
        session.entries.set(slot, {
          record,
          row: {
            slot,
            phase: finished,
            claimed: !!record.record.receiver,
            transferred: finished === 'complete' ? total : 0,
            total,
            speed: 0,
            route: 'connecting',
            message: '',
          },
        });
        continue;
      }
      const transfer = Transfer.fromRecovery(record, (s) => session.update(slot, s));
      session.entries.set(slot, { transfer, row: rowOf(slot, transfer.snapshot) });
    }
    // Closing the code may not have reached the server before the page went away.
    if (session.sealed) session.sealThrough();
    session.snapshot = session.read();
    return session;
  }

  async start(): Promise<void> {
    this.ticker = setInterval(() => this.evaluate(), 1000);
    if (!this.entries.size) await this.open(0);
    else
      for (const entry of this.entries.values()) {
        if (!entry.transfer) continue;
        try {
          await entry.transfer.start();
        } catch (error) {
          entry.row = { ...entry.row, phase: 'error', message: publicError(error) };
        }
      }
    this.evaluate();
  }

  /** After a reload: the original files, checked once, resume every receiver. */
  async supplyFiles(files: File[]): Promise<void> {
    if (!this.needsFiles || this.checkingFiles || this.finished) return;
    this.checkingFiles = true;
    this.emit();
    try {
      const original = await Transfer.matchOriginals(
        files,
        this.base.files,
        this.savedFingerprints,
        this.abort.signal,
      );
      this.sources = original.files;
      this.fingerprints = Promise.resolve(original.fingerprints);
      this.needsFiles = false;
      for (const entry of this.entries.values())
        if (entry.transfer && !terminal(entry.row.phase))
          await entry.transfer.resumeWith(original.files, original.fingerprints);
    } finally {
      this.checkingFiles = false;
      this.evaluate();
    }
  }

  /** Nobody else can join; receivers already sending carry on. */
  stopSharing(): void {
    if (this.sealed || this.finished) return;
    this.sealed = true;
    this.sealThrough();
    this.evaluate();
  }

  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    if (!this.sealed) {
      this.sealed = true;
      this.sealThrough();
    }
    for (const entry of this.entries.values())
      if (entry.row.claimed && !terminal(entry.row.phase)) entry.transfer?.cancel();
    this.evaluate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.finished = true;
    clearInterval(this.ticker);
    this.abort.abort();
    await this.cleanup();
  }

  private async open(index: number): Promise<void> {
    const entry: Entry = {
      row: {
        slot: index,
        phase: 'connecting',
        claimed: false,
        transferred: 0,
        total: this.total(),
        speed: 0,
        route: 'connecting',
        message: '',
      },
    };
    this.entries.set(index, entry);
    entry.transfer = this.make(
      {
        index,
        uses: this.base.uses,
        code: this.base.code,
        credential: this.base.credential,
        expires: this.base.expires,
        pairExpires: this.base.pairExpires,
        fingerprints: () => (this.fingerprints ??= this.fingerprintAll()),
      },
      (s) => this.update(index, s),
    );
    if (this.sealed) {
      entry.sealing = true;
      entry.transfer.seal();
    }
    this.emit();
    await entry.transfer.start();
  }
  private async fingerprintAll(): Promise<Fingerprint[]> {
    const fingerprints: Fingerprint[] = [];
    for (const file of this.sources)
      fingerprints.push(await fingerprintFile(file, this.abort.signal));
    return fingerprints;
  }
  private update(slot: number, s: Snapshot): void {
    const entry = this.entries.get(slot);
    if (!entry) return;
    entry.row = rowOf(slot, s);
    if (terminal(s.phase)) {
      entry.sealing = false;
      // A slot still closing the code is disposed once the server has closed it.
      if (this.finished && entry.transfer) void this.cleanup();
    }
    this.evaluate();
  }
  private isOpen(): boolean {
    return (
      !this.sealed &&
      !this.cancelled &&
      Date.now() < this.base.pairExpires &&
      this.rows().filter((r) => r.claimed).length < this.base.uses
    );
  }
  // Keep one slot waiting for the next person while the code is open.
  private openNext(): void {
    if (this.needsFiles || !this.isOpen()) return;
    if (this.rows().some((r) => !r.claimed && !terminal(r.phase))) return;
    const next = Math.max(-1, ...this.entries.keys()) + 1;
    if (next >= this.base.uses) return;
    void this.open(next).catch((error) => {
      const entry = this.entries.get(next);
      if (entry) entry.row = { ...entry.row, phase: 'error', message: publicError(error) };
      this.evaluate();
    });
  }
  private sealThrough(): void {
    const live = [...this.entries.values()].filter((e) => e.transfer && !terminal(e.row.phase));
    const carrier = live.find((e) => !e.row.claimed) ?? live[0];
    if (!carrier) return;
    carrier.sealing = true;
    carrier.transfer!.seal();
  }
  private evaluate(): void {
    if (!this.finished) {
      if (this.isOpen()) this.openNext();
      else if (this.rows().every((r) => !r.claimed || terminal(r.phase))) this.finish();
    }
    this.emit();
  }
  private finish(): void {
    this.finished = true;
    clearInterval(this.ticker);
    const claimed = this.rows().filter((r) => r.claimed);
    const delivered = claimed.some((r) => r.phase === 'complete');
    this.phase = this.cancelled ? 'cancelled' : delivered ? 'complete' : 'error';
    this.message = this.cancelled
      ? 'Transfer cancelled.'
      : delivered
        ? 'Your files have arrived.'
        : claimed.length
          ? 'No one received the files.'
          : 'This code expired. Start a new transfer.';
    void this.cleanup();
  }
  // Disposes finished slots and removes the send's records; settles when all are gone.
  // A slot still closing the code is left to finish that; it is disposed when it ends.
  private async cleanup(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.transfer && entry.sealing) continue;
      const { transfer, record } = entry;
      entry.transfer = undefined;
      entry.record = undefined;
      try {
        await transfer?.dispose();
        await record?.remove();
        await record?.unlock();
      } catch {
        /* Cleanup is best effort; expired records are removed on a later visit. */
      }
    }
    if ([...this.entries.values()].every((e) => !e.transfer && !e.record)) this.settle();
  }
  private rows(): ReceiverRow[] {
    return [...this.entries.values()].map((e) => e.row);
  }
  private total(): number {
    return this.base.files.reduce((sum, file) => sum + file.size, 0);
  }
  private read(): GroupSnapshot {
    const rows = this.rows().sort((a, b) => a.slot - b.slot);
    const open = !this.finished && this.isOpen();
    return {
      code: this.base.code,
      uses: this.base.uses,
      files: this.base.files,
      total: this.total(),
      pairExpires: this.base.pairExpires,
      open,
      phase: this.phase,
      message: this.message,
      receivers: rows.filter((r) => r.claimed || (open && !terminal(r.phase))),
      joined: rows.filter((r) => r.claimed).length,
      delivered: rows.filter((r) => r.claimed && r.phase === 'complete').length,
      needsFiles: this.needsFiles,
      checkingFiles: this.checkingFiles,
    };
  }
  private emit(): void {
    this.snapshot = this.read();
    this.listener(this.snapshot);
  }
}

/** Restores whatever this browser was sending or receiving before a reload. */
export async function restoreTransfer(
  single: (snapshot: Snapshot) => void,
  group: (snapshot: GroupSnapshot) => void,
): Promise<{ transfer: Transfer } | { session: SendSession } | undefined> {
  const recovery = await RecoverySession.restore();
  if (!recovery) return;
  if (recovery.record.role === 'send' && (recovery.record.uses ?? 1) > 1)
    return { session: await SendSession.restore(recovery, group) };
  return { transfer: Transfer.fromRecovery(recovery, single) };
}
