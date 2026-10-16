import { describe, expect, it } from 'vitest';
import {
  MemoryHistoryStore,
  historyFolder,
  keptBytes,
  roomEnded,
  type HistoryItem,
  type HistoryRoom,
} from '../../src/room/history';

const room = (locator: string, updated: number, expires = Date.now() + 60_000): HistoryRoom => ({
  locator,
  code: 'AB12CD',
  me: '1'.repeat(32),
  names: { ['1'.repeat(32)]: 'Me' },
  joined: updated,
  updated,
  expires,
});
const item = (locator: string, id: string, at: number, extra: Partial<HistoryItem> = {}) =>
  ({
    locator,
    id,
    at,
    from: '1'.repeat(32),
    to: ['2'.repeat(32)],
    kind: 'text',
    ...extra,
  }) as HistoryItem;

describe('room history', () => {
  it('keeps rooms newest first and each room’s items in time order', async () => {
    const store = new MemoryHistoryStore();
    await store.putRoom(room('a', 1));
    await store.putRoom(room('b', 5));
    await store.putItem(item('a', 'x2', 20, { text: 'second' }));
    await store.putItem(item('a', 'x1', 10, { text: 'first' }));
    await store.putItem(item('b', 'y1', 15, { text: 'other room' }));
    await store.putItem(item('a', 'x1', 10, { text: 'first, updated' }));
    expect((await store.rooms()).map((r) => r.locator)).toEqual(['b', 'a']);
    expect((await store.items('a')).map((i) => i.text)).toEqual(['first, updated', 'second']);
    expect((await store.room('b'))?.updated).toBe(5);
  });

  it('deletes a room with its items and kept folders', async () => {
    const store = new MemoryHistoryStore();
    await store.putRoom(room('a', 1));
    await store.putItem(
      item('a', 'f1', 10, { kind: 'files', folder: historyFolder('f1', 'm1'), kept: [0] }),
    );
    await store.putItem(item('a', 't1', 11, { text: 'hi' }));
    await store.putRoom(room('b', 2));
    await store.putItem(item('b', 't2', 12, { text: 'keep me' }));
    await store.deleteRoom('a');
    expect(await store.room('a')).toBeUndefined();
    expect(await store.items('a')).toEqual([]);
    expect(store.deleted).toEqual(['widesend-room-f1-m1']);
    expect(await store.items('b')).toHaveLength(1);
  });

  it('opens kept files through the resolver it was given', async () => {
    const file = new File(['abc'], '0');
    const store = new MemoryHistoryStore((folder, id) =>
      folder === 'widesend-room-f1' && id === 0 ? file : undefined,
    );
    const meta = { id: 0, name: 'note.txt', size: 3, type: 'text/plain' };
    const opened = await store.file('widesend-room-f1', 0, meta);
    expect(opened?.name).toBe('note.txt');
    expect(await opened?.text()).toBe('abc');
    expect(await store.file('widesend-room-f1', 1, meta)).toBeUndefined();
  });

  it('treats a room past its expiry as expired, and counts only kept bytes', () => {
    const now = Date.now();
    expect(roomEnded(room('a', 1, now - 1), now)).toBe('expired');
    expect(roomEnded(room('a', 1, now + 1000), now)).toBeUndefined();
    expect(roomEnded({ ...room('a', 1, now + 1000), ended: 'dismissed' }, now)).toBe('dismissed');
    const files = [
      { id: 0, name: 'a', size: 100, type: '' },
      { id: 1, name: 'b', size: 50, type: '' },
    ];
    expect(
      keptBytes([
        item('a', 'f', 1, { kind: 'files', files, kept: [1] }),
        item('a', 'g', 2, { kind: 'files', files }),
        item('a', 't', 3, { text: 'hi' }),
      ]),
    ).toBe(50);
  });
});
