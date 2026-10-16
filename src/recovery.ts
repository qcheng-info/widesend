import type { FileMeta, Fingerprint, Role } from '../shared/protocol';
import type { DeviceIdentity } from './key-session';

export type RecoveryRecord = {
  version: 1 | 2;
  identity?: DeviceIdentity;
  id: string;
  role: Role;
  code: string;
  receiver?: string;
  expires: number;
  pairExpires: number;
  updated: number;
  files: FileMeta[];
  fingerprints?: Fingerprint[];
  accepted: boolean;
  folder?: string;
  fileIndex: number;
  offset: number;
  completed: Fingerprint[];
  // A send several receivers can use: one record per receiver slot. The id is
  // `${credential}:${slot}` above slot 0, and the server credential is kept here.
  credential?: string;
  uses?: number;
  slot?: number;
  // A slot that ended, kept until its send ends.
  finished?: 'complete' | 'cancelled' | 'error';
  // The sender stopped sharing the code through this slot.
  sealed?: boolean;
};
const pointer = 'widesend-recovery';
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('widesend-recovery', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function transaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction('sessions', mode, { durability: 'strict' });
    const request = action(tx.objectStore('sessions'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? new Error('Could not save transfer progress.'));
    tx.onerror = () => reject(tx.error);
  });
}
export class RecoverySession {
  private writes = Promise.resolve();
  private removed = false;
  private release?: () => void;
  private constructor(public record: RecoveryRecord) {}

  private async claim(): Promise<boolean> {
    if (!navigator.locks) return false;
    return new Promise((resolve, reject) => {
      void navigator.locks
        .request(`widesend-session-${this.record.id}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          return new Promise<void>((release) => {
            this.release = release;
            resolve(true);
          });
        })
        .catch(reject);
    });
  }
  private remember() {
    try {
      sessionStorage.setItem(pointer, this.record.id);
    } catch {
      /* IDB can still restore the latest available session. */
    }
  }
  static async create(record: RecoveryRecord): Promise<RecoverySession> {
    const session = new RecoverySession(record);
    if (!(await session.claim())) throw new Error('Could not save transfer progress.');
    try {
      await session.save({});
      session.remember();
      return session;
    } catch (error) {
      session.release?.();
      throw error;
    }
  }
  static async restore(): Promise<RecoverySession | undefined> {
    let preferred: string | null = null;
    try {
      preferred = sessionStorage.getItem(pointer);
    } catch {
      /* Optional hint. */
    }
    const records = (await transaction('readonly', (store) => store.getAll())) as RecoveryRecord[];
    records.sort(
      (a, b) => Number(b.id === preferred) - Number(a.id === preferred) || b.updated - a.updated,
    );
    const now = Date.now();
    const lapsed = (r: RecoveryRecord) =>
      r.expires <= now ||
      (!r.finished && r.role === 'send' && !r.accepted && !r.receiver && r.pairExpires <= now);
    const sendOf = (r: RecoveryRecord) => r.credential ?? r.id;
    for (const record of records) {
      if (record.version !== 1 && record.version !== 2) continue;
      if (record.finished) {
        // A finished slot is kept only while the rest of its send can still resume.
        const resumable = records.some(
          (other) =>
            !other.finished &&
            !lapsed(other) &&
            other.role === 'send' &&
            sendOf(other) === sendOf(record),
        );
        if (resumable && !lapsed(record)) continue;
        const session = new RecoverySession(record);
        if (await session.claim()) {
          await session.remove();
          session.release?.();
        }
        continue;
      }
      const session = new RecoverySession(record);
      if (!(await session.claim())) continue;
      if (lapsed(record)) {
        await session.remove();
        session.release?.();
        continue;
      }
      session.remember();
      return session;
    }
  }
  /** The other records of a several-receiver send, each claimed by this page. */
  static async group(first: RecoveryRecord): Promise<RecoverySession[]> {
    const credential = first.credential ?? first.id;
    const records = (await transaction('readonly', (store) => store.getAll())) as RecoveryRecord[];
    const found: RecoverySession[] = [];
    for (const record of records) {
      if (
        record.id === first.id ||
        record.role !== 'send' ||
        (record.credential ?? record.id) !== credential
      )
        continue;
      const session = new RecoverySession(record);
      if (!(await session.claim())) continue;
      if (
        record.expires <= Date.now() ||
        (!record.finished && !record.receiver && record.pairExpires <= Date.now())
      ) {
        await session.remove();
        session.release?.();
        continue;
      }
      found.push(session);
    }
    return found;
  }
  save(patch: Partial<RecoveryRecord>): Promise<void> {
    if (this.removed) return Promise.resolve();
    this.record = { ...this.record, ...patch, updated: Date.now() };
    const snapshot = structuredClone(this.record);
    const work = this.writes.then(async () => {
      await transaction('readwrite', (store) => store.put(snapshot));
    });
    this.writes = work.catch(() => {});
    return work;
  }
  remove(): Promise<void> {
    this.removed = true;
    const work = this.writes.then(async () => {
      await transaction('readwrite', (store) => store.delete(this.record.id));
    });
    this.writes = work.catch(() => {});
    return work;
  }
  async unlock(): Promise<void> {
    await this.writes;
    this.release?.();
    this.release = undefined;
  }
}
