import type { FileMeta } from '../../shared/protocol';
import type { DeviceIdentity } from '../key-session';
import type { SavedFile } from '../storage';
import type { HistoryStore } from './history';

// Browser capabilities the room engine needs, injected so the same engine runs in
// the page and in Node tests against the real Worker.
export type SocketLike = {
  readonly readyState: number;
  binaryType: string;
  readonly bufferedAmount: number;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
export type ReceiveSink = {
  open(meta: FileMeta): Promise<void>;
  write(offset: number, data: ArrayBuffer): Promise<void>;
  finish(meta: FileMeta, sha256: string): Promise<SavedFile>;
  dispose(): Promise<void>;
};
export type MembershipRecord = {
  locator: string;
  code: string;
  member: string;
  credential: string;
  name: string;
  role: 'owner' | 'member';
  identity: DeviceIdentity;
  ownerKey: string;
  expires: number;
  updated: number;
};
export type MembershipStore = {
  get(locator: string): Promise<MembershipRecord | undefined>;
  latest(): Promise<MembershipRecord | undefined>;
  put(record: MembershipRecord): Promise<void>;
  delete(locator: string): Promise<void>;
};
export type RoomEnvironment = {
  origin: string;
  socketUrl(locator: string): string;
  connect(url: string, protocols: string[]): SocketLike;
  store: MembershipStore;
  history: HistoryStore;
  // Received files are written into `folder` and kept with the room's history.
  sink(files: FileMeta[], folder: string): Promise<ReceiveSink>;
  // Sends up to this many bytes are accepted without asking (AUTO_ACCEPT_BYTES).
  autoAcceptBytes?: number;
  rtc?: typeof RTCPeerConnection;
  lock?(name: string): Promise<(() => void) | undefined>;
  /** Keeps the screen on while files are moving, so a phone doesn't lock mid-transfer. */
  keepAwake?(on: boolean): void;
};

export class MemoryMembershipStore implements MembershipStore {
  private records = new Map<string, MembershipRecord>();
  async get(locator: string) {
    return this.records.get(locator);
  }
  async latest() {
    return [...this.records.values()]
      .filter((r) => r.expires > Date.now())
      .sort((a, b) => b.updated - a.updated)[0];
  }
  async put(record: MembershipRecord) {
    this.records.set(record.locator, record);
  }
  async delete(locator: string) {
    this.records.delete(locator);
  }
}
