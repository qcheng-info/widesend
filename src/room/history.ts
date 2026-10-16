import type { FileMeta } from '../../shared/protocol';

// A room's conversation as this device saw it, kept until the person deletes it.
// The browser keeps it in IndexedDB and OPFS (history-store.ts); tests in memory.
export type HistoryRoom = {
  locator: string;
  code: string;
  me: string;
  owner?: string;
  // Everyone this device saw in the room, kept after they leave.
  names: Record<string, string>;
  joined: number;
  updated: number;
  expires: number;
  ended?: string;
  endedAt?: number;
};
export type HistoryItem = {
  locator: string;
  id: string;
  // This device's clock when the item was sent or arrived.
  at: number;
  from: string;
  to: string[];
  kind: 'text' | 'files';
  text?: string;
  files?: FileMeta[];
  // OPFS folder holding the kept copies, and which files are in it.
  folder?: string;
  kept?: number[];
  // My items: final or current status per recipient. Received items: my status.
  sent?: Record<string, string>;
  status?: string;
};
export type HistoryStore = {
  rooms(): Promise<HistoryRoom[]>;
  room(locator: string): Promise<HistoryRoom | undefined>;
  putRoom(room: HistoryRoom): Promise<void>;
  items(locator: string): Promise<HistoryItem[]>;
  putItem(item: HistoryItem): Promise<void>;
  file(folder: string, id: number, meta: FileMeta): Promise<File | undefined>;
  deleteRoom(locator: string): Promise<void>;
  // Asks the browser not to evict kept files (best effort).
  persist?(): void;
};

// One folder per send and member: tabs of one browser profile share its storage.
export const historyFolder = (offer: string, member: string) => `widesend-room-${offer}-${member}`;
export function roomEnded(room: HistoryRoom, now = Date.now()): string | undefined {
  return room.ended ?? (room.expires <= now ? 'expired' : undefined);
}
export function keptBytes(items: HistoryItem[]): number {
  let total = 0;
  for (const item of items)
    for (const id of item.kept ?? []) total += item.files?.find((f) => f.id === id)?.size ?? 0;
  return total;
}
const byTime = (a: HistoryItem, b: HistoryItem) => a.at - b.at || (a.id < b.id ? -1 : 1);

export class MemoryHistoryStore implements HistoryStore {
  private records = new Map<string, HistoryRoom>();
  private entries = new Map<string, HistoryItem>();
  // Folders deleteRoom removed, for tests to check.
  deleted: string[] = [];
  constructor(private files?: (folder: string, id: number) => File | undefined) {}
  async rooms() {
    return [...this.records.values()].sort((a, b) => b.updated - a.updated);
  }
  async room(locator: string) {
    return this.records.get(locator);
  }
  async putRoom(room: HistoryRoom) {
    this.records.set(room.locator, structuredClone(room));
  }
  async items(locator: string) {
    return [...this.entries.values()].filter((i) => i.locator === locator).sort(byTime);
  }
  async putItem(item: HistoryItem) {
    this.entries.set(`${item.locator}:${item.id}`, structuredClone(item));
  }
  async file(folder: string, id: number, meta: FileMeta) {
    const found = this.files?.(folder, id);
    return found && new File([found], meta.name, { type: meta.type });
  }
  async deleteRoom(locator: string) {
    for (const item of await this.items(locator)) {
      if (item.folder) this.deleted.push(item.folder);
      this.entries.delete(`${locator}:${item.id}`);
    }
    this.records.delete(locator);
  }
}
