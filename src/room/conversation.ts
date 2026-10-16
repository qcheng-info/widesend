import type { FileMeta } from '../../shared/protocol';
import { AUTO_ACCEPT_BYTES, type RoomReport } from '../../shared/room';
import type { RoomEnvironment } from './environment';
import { historyFolder, type HistoryItem, type HistoryRoom, type HistoryStore } from './history';
import type { TextMessage, TextStatus } from './messages';
import type { IncomingView, OutgoingView } from './transfers';

export const MESSAGE_REPORT_MS = 30_000;
export type TimelineFile = {
  id: number;
  name: string;
  size: number;
  type: string;
  url?: string;
  // Kept once, but no longer in this browser's storage.
  missing?: boolean;
};
export type TimelineDelivery = { id: string; name: string; status: string; online: boolean };
export type TimelineEntry = {
  id: string;
  kind: 'text' | 'files';
  at: number;
  from: string;
  fromName: string;
  mine: boolean;
  // Recipients the sender named; empty when unknown (files sent to me).
  to: string[];
  text?: string;
  // My items: one per recipient.
  deliveries: TimelineDelivery[];
  files?: FileMeta[];
  total?: number;
  // Live transfer state while this page is moving the files.
  incoming?: IncomingView;
  outgoing?: OutgoingView;
  kept: TimelineFile[];
  // Received items: where my copy stands.
  status?: string;
};
export type ConversationHost = {
  env: RoomEnvironment;
  me(): string;
  locator(): string;
  online(id: string): boolean;
  report(key: string, report: RoomReport): void;
  changed(): void;
};
const finished = ['declined', 'complete', 'failed', 'cancelled', 'delivered', 'refused'];
const byTime = (a: HistoryItem, b: HistoryItem) => a.at - b.at || (a.id < b.id ? -1 : 1);
const utf8 = new TextEncoder();

function entry(
  item: HistoryItem,
  me: string,
  names: Record<string, string>,
  kept: TimelineFile[],
  online: (id: string) => boolean,
  live: { incoming?: IncomingView; outgoing?: OutgoingView } = {},
): TimelineEntry {
  const mine = item.from === me;
  const deliveries = !mine
    ? []
    : live.outgoing
      ? live.outgoing.recipients.map((r) => ({
          id: r.id,
          name: r.name || names[r.id] || '',
          status: r.status,
          online: online(r.id),
        }))
      : Object.entries(item.sent ?? {}).map(([id, status]) => ({
          id,
          name: names[id] ?? '',
          status,
          online: online(id),
        }));
  return {
    id: item.id,
    kind: item.kind,
    at: item.at,
    from: item.from,
    fromName: names[item.from] ?? '',
    mine,
    to: item.to,
    text: item.text,
    deliveries,
    files: item.files,
    total: item.files?.reduce((sum, f) => sum + f.size, 0),
    incoming: live.incoming,
    outgoing: live.outgoing,
    kept,
    status: mine ? undefined : (live.incoming?.status ?? item.status),
  };
}

// One room's conversation on this device: its timeline, kept in history so it
// outlives the page and the room.
export class Conversation {
  // False when this browser can't store history (for example a private window).
  available = true;
  private room?: HistoryRoom;
  private items = new Map<string, HistoryItem>();
  private names: Record<string, string> = {};
  // Kept file → object URL (or null when it's gone from storage).
  private urls = new Map<string, string | null>();
  private opening = new Set<string>();
  private copied = new Set<string>();
  private reportedAt = 0;
  private reportTimer?: ReturnType<typeof setTimeout>;
  private persisted = false;
  private closed = false;
  // The room refuses reports from someone it hasn't let in yet.
  private admitted = false;
  constructor(private host: ConversationHost) {}
  private get history(): HistoryStore {
    return this.host.env.history;
  }
  private store(work: () => Promise<void>): Promise<void> {
    return work().catch(() => {
      this.available = false;
      this.host.changed();
    });
  }

  // Reads this room's history. Returns the text messages for Messages.
  async load(): Promise<TextMessage[]> {
    const locator = this.host.locator();
    let items: HistoryItem[] = [];
    try {
      this.room = await this.history.room(locator);
      items = await this.history.items(locator);
    } catch {
      this.available = false;
    }
    this.names = { ...this.room?.names };
    // Joining the same room again gives this device a new member ID: what it sent
    // and received under the old one is still its own.
    const me = this.host.me();
    const former = this.room && this.room.me !== me ? this.room.me : undefined;
    for (const item of items) {
      if (former && (item.from === former || item.to.includes(former))) {
        if (item.from === former) item.from = me;
        item.to = item.to.map((id) => (id === former ? me : id));
        void this.save(item);
      }
      this.items.set(item.id, item);
      // This page no longer has the files it was moving: those deliveries ended.
      if (item.kind !== 'files') continue;
      let changed = false;
      for (const [id, status] of Object.entries(item.sent ?? {}))
        if (!finished.includes(status)) {
          item.sent![id] = 'failed';
          changed = true;
        }
      if (item.status && !finished.includes(item.status)) {
        item.status = 'failed';
        changed = true;
      }
      if (changed) void this.save(item);
    }
    return items
      .filter((i) => i.kind === 'text')
      .map((i) => ({
        id: i.id,
        at: i.at,
        from: i.from,
        to: i.to,
        text: i.text ?? '',
        sent: i.sent as Record<string, TextStatus> | undefined,
      }));
  }
  has(id: string): boolean {
    return this.items.has(id);
  }
  private save(item: HistoryItem): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.store(() => this.history.putItem(item));
  }
  // Called with every roster while this page is in the room.
  joined(details: {
    code: string;
    owner?: string;
    expires: number;
    members: { id: string; name: string }[];
  }): void {
    if (!this.admitted) {
      this.admitted = true;
      if (this.texts().length) this.reportCounts();
    }
    let changed = !this.room;
    for (const m of details.members)
      if (this.names[m.id] !== m.name) {
        this.names[m.id] = m.name;
        changed = true;
      }
    const now = Date.now();
    const room: HistoryRoom = {
      locator: this.host.locator(),
      code: details.code,
      me: this.host.me(),
      owner: details.owner,
      names: { ...this.names },
      joined: this.room?.joined ?? now,
      updated: this.room?.updated ?? now,
      expires: details.expires,
    };
    if (!changed && this.room?.expires === room.expires && this.room.owner === room.owner) return;
    this.room = room;
    void this.store(() => this.history.putRoom(room));
  }
  private touch(): void {
    if (!this.room) return;
    this.room = { ...this.room, updated: Date.now() };
    const room = this.room;
    void this.store(() => this.history.putRoom(room));
  }

  async saveText(m: TextMessage): Promise<void> {
    const mine = m.from === this.host.me();
    const isNew = !this.items.has(m.id);
    const item: HistoryItem = {
      locator: this.host.locator(),
      id: m.id,
      at: m.at,
      from: m.from,
      to: m.to,
      kind: 'text',
      text: m.text,
      ...(mine ? { sent: { ...m.sent } } : { status: 'delivered' }),
    };
    this.items.set(m.id, item);
    if (isNew) this.touch();
    if (isNew && mine) this.reportCounts();
    await this.save(item);
  }

  // Records file items as transfers create and finish them.
  track(outgoing: OutgoingView[], incoming: IncomingView[]): void {
    const me = this.host.me(),
      locator = this.host.locator();
    for (const out of outgoing) {
      let item = this.items.get(out.id);
      let changed = false;
      if (!item) {
        item = {
          locator,
          id: out.id,
          at: Date.now(),
          from: me,
          to: out.recipients.map((r) => r.id),
          kind: 'files',
          files: out.files,
          folder: historyFolder(out.id, me),
          kept: [],
          sent: {},
        };
        this.items.set(out.id, item);
        this.touch();
        changed = true;
      }
      for (const r of out.recipients)
        if (
          item.sent![r.id] === undefined ||
          (item.sent![r.id] !== r.status && finished.includes(r.status))
        ) {
          item.sent![r.id] = r.status;
          changed = true;
        }
      if (out.sha256 && out.sources && !this.copied.has(out.id)) {
        this.copied.add(out.id);
        void this.keepImages(item, out.sources, out.sha256);
      }
      if (changed) void this.save(item);
    }
    for (const inc of incoming) {
      let item = this.items.get(inc.id);
      let changed = false;
      if (!item) {
        item = {
          locator,
          id: inc.id,
          at: Date.now(),
          from: inc.from,
          to: [],
          kind: 'files',
          files: inc.files,
          folder: inc.folder,
          kept: [],
          status: inc.status,
        };
        this.items.set(inc.id, item);
        this.touch();
        changed = true;
      }
      if (item.status !== inc.status && (finished.includes(inc.status) || !item.status)) {
        item.status = inc.status;
        changed = true;
      }
      for (const saved of inc.saved)
        if (!item.kept!.includes(saved.id)) {
          item.kept!.push(saved.id);
          changed = true;
          this.keepStorage();
        }
      if (changed) void this.save(item);
    }
  }
  private keepStorage(): void {
    if (this.persisted) return;
    this.persisted = true;
    this.history.persist?.();
  }
  // My own images stay viewable in my history after this page is gone.
  private async keepImages(item: HistoryItem, sources: File[], sha256: string[]): Promise<void> {
    const images = item.files!.filter(
      (f, i) => f.type.startsWith('image/') && f.size <= AUTO_ACCEPT_BYTES && sources[i],
    );
    if (!images.length) return;
    let sink;
    try {
      sink = await this.host.env.sink(images, item.folder!);
      for (const meta of images) {
        await sink.open(meta);
        if (meta.size) await sink.write(0, await sources[meta.id].arrayBuffer());
        await sink.finish(meta, sha256[meta.id]);
        item.kept!.push(meta.id);
      }
    } catch {
      /* Keeping my own copy is a convenience; the send itself goes on. */
    } finally {
      await sink?.dispose().catch(() => {});
    }
    if (!item.kept!.length) return;
    this.keepStorage();
    await this.save(item);
    this.host.changed();
  }

  entries(outgoing: OutgoingView[], incoming: IncomingView[]): TimelineEntry[] {
    const outs = new Map(outgoing.map((o) => [o.id, o])),
      ins = new Map(incoming.map((i) => [i.id, i]));
    const me = this.host.me();
    return [...this.items.values()].sort(byTime).map((item) => {
      const live = { outgoing: outs.get(item.id), incoming: ins.get(item.id) };
      return entry(item, me, this.names, this.kept(item, live), (id) => this.host.online(id), live);
    });
  }
  private kept(
    item: HistoryItem,
    live: { incoming?: IncomingView; outgoing?: OutgoingView },
  ): TimelineFile[] {
    const result: TimelineFile[] = [];
    for (const id of item.kept ?? []) {
      const meta = item.files?.find((f) => f.id === id);
      if (!meta) continue;
      const saved = live.incoming?.saved.find((f) => f.id === id);
      const key = `${item.folder}:${id}`;
      if (saved) result.push({ ...meta, url: saved.url });
      else if (live.outgoing?.sources?.[id]) {
        if (!this.urls.has(key)) this.urls.set(key, URL.createObjectURL(live.outgoing.sources[id]));
        result.push({ ...meta, url: this.urls.get(key) ?? undefined });
      } else {
        const url = this.urls.get(key);
        if (url === undefined) this.open(key, item.folder!, meta);
        result.push({ ...meta, url: url ?? undefined, missing: url === null });
      }
    }
    return result;
  }
  // Opens a kept file from storage, then shows it.
  private open(key: string, folder: string, meta: FileMeta): void {
    if (this.opening.has(key)) return;
    this.opening.add(key);
    void this.history
      .file(folder, meta.id, meta)
      .catch(() => undefined)
      .then((file) => {
        if (this.closed) return;
        this.urls.set(key, file ? URL.createObjectURL(file) : null);
        this.host.changed();
      });
  }

  // Running totals of my text messages, at most every MESSAGE_REPORT_MS.
  private texts(): HistoryItem[] {
    const me = this.host.me();
    return [...this.items.values()].filter((i) => i.kind === 'text' && i.from === me);
  }
  private reportCounts(): void {
    if (this.reportTimer || this.closed || !this.admitted) return;
    const wait = Math.max(0, this.reportedAt + MESSAGE_REPORT_MS - Date.now());
    this.reportTimer = setTimeout(() => {
      this.reportTimer = undefined;
      if (this.closed) return;
      this.reportedAt = Date.now();
      const texts = this.texts();
      const bytes = texts.reduce((sum, i) => sum + utf8.encode(i.text ?? '').length, 0);
      if (texts.length)
        this.host.report(`messages:${texts.length}`, {
          event: 'messages',
          count: texts.length,
          bytes,
        });
    }, wait);
  }

  async ended(reason: string): Promise<void> {
    if (!this.room) return;
    this.room = { ...this.room, ended: reason, endedAt: Date.now() };
    const room = this.room;
    await this.store(() => this.history.putRoom(room));
  }
  dispose(): void {
    this.closed = true;
    clearTimeout(this.reportTimer);
    for (const url of this.urls.values()) if (url) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}

// A past room's conversation, read from history.
export async function pastTimeline(
  history: HistoryStore,
  locator: string,
): Promise<{ room: HistoryRoom; entries: TimelineEntry[]; release(): void } | undefined> {
  const room = await history.room(locator);
  if (!room) return undefined;
  const items = (await history.items(locator)).sort(byTime);
  const urls: string[] = [];
  const entries = await Promise.all(
    items.map(async (item) => {
      const kept: TimelineFile[] = [];
      for (const id of item.kept ?? []) {
        const meta = item.files?.find((f) => f.id === id);
        if (!meta) continue;
        const file = await history.file(item.folder!, id, meta).catch(() => undefined);
        const url = file && URL.createObjectURL(file);
        if (url) urls.push(url);
        kept.push({ ...meta, url, missing: !file });
      }
      return entry(item, room.me, room.names, kept, () => false);
    }),
  );
  return { room, entries, release: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
}
