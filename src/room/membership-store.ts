import type { MembershipRecord, MembershipStore } from './environment';

// Room memberships survive a reload so members rejoin without approval. Device
// private keys are non-exportable CryptoKeys, structured-cloned into IndexedDB.
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('widesend-rooms', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('memberships', { keyPath: 'locator' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function run<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('memberships', mode);
    const request = action(tx.objectStore('memberships'));
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error ?? new Error('Could not save the room membership.'));
    tx.onerror = () => reject(tx.error);
  });
}
export class IndexedMembershipStore implements MembershipStore {
  async get(locator: string) {
    return run<MembershipRecord | undefined>('readonly', (s) => s.get(locator));
  }
  async latest() {
    const all = await run<MembershipRecord[]>('readonly', (s) => s.getAll());
    const now = Date.now();
    for (const record of all) if (record.expires <= now) await this.delete(record.locator);
    return all.filter((r) => r.expires > now).sort((a, b) => b.updated - a.updated)[0];
  }
  async put(record: MembershipRecord) {
    await run('readwrite', (s) => s.put(record));
  }
  async delete(locator: string) {
    await run('readwrite', (s) => s.delete(locator));
  }
}
