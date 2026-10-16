import type { FileMeta } from '../../shared/protocol';
import type { HistoryItem, HistoryRoom, HistoryStore } from './history';

// Room history in the browser: records in IndexedDB, kept files in OPFS folders
// (see historyFolder). Both stay until the person deletes the room.
let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('widesend-history', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('rooms', { keyPath: 'locator' });
      db.createObjectStore('items', { keyPath: ['locator', 'id'] }).createIndex('room', 'locator');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
async function run<T>(
  stores: string[],
  mode: IDBTransactionMode,
  action: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const request = action(tx);
    tx.oncomplete = () => resolve(request?.result as T);
    tx.onabort = () => reject(tx.error ?? new Error('Could not save the conversation.'));
    tx.onerror = () => reject(tx.error);
  });
}

export class IndexedHistoryStore implements HistoryStore {
  private persisting = false;
  async rooms() {
    const all = await run<HistoryRoom[]>(['rooms'], 'readonly', (tx) =>
      tx.objectStore('rooms').getAll(),
    );
    return all.sort((a, b) => b.updated - a.updated);
  }
  async room(locator: string) {
    return run<HistoryRoom | undefined>(['rooms'], 'readonly', (tx) =>
      tx.objectStore('rooms').get(locator),
    );
  }
  async putRoom(room: HistoryRoom) {
    await run(['rooms'], 'readwrite', (tx) => tx.objectStore('rooms').put(room));
  }
  async items(locator: string) {
    const all = await run<HistoryItem[]>(['items'], 'readonly', (tx) =>
      tx.objectStore('items').index('room').getAll(locator),
    );
    return all.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  }
  async putItem(item: HistoryItem) {
    await run(['items'], 'readwrite', (tx) => tx.objectStore('items').put(item));
  }
  async file(folder: string, id: number, meta: FileMeta) {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle(folder);
      const raw = await (await directory.getFileHandle(String(id))).getFile();
      if (raw.size !== meta.size) return undefined;
      return new File([raw], meta.name, { type: meta.type || 'application/octet-stream' });
    } catch {
      return undefined;
    }
  }
  async deleteRoom(locator: string) {
    const items = await this.items(locator);
    const folders = new Set(items.flatMap((i) => (i.folder ? [i.folder] : [])));
    try {
      const root = await navigator.storage.getDirectory();
      for (const folder of folders)
        await root.removeEntry(folder, { recursive: true }).catch(() => {});
    } catch {
      /* No file storage here: only the records remain to delete. */
    }
    await run(['rooms', 'items'], 'readwrite', (tx) => {
      const store = tx.objectStore('items');
      for (const item of items) store.delete([locator, item.id]);
      tx.objectStore('rooms').delete(locator);
    });
  }
  persist() {
    if (this.persisting) return;
    this.persisting = true;
    void navigator.storage?.persist?.().catch(() => false);
  }
}
