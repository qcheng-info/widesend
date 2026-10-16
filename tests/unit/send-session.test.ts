import { afterEach, describe, expect, it, vi } from 'vitest';
import { SendSession, type GroupSnapshot, type MakeSlot } from '../../src/send-session';
import type { Slot, Snapshot } from '../../src/transfer';
import { PAIRING_MS } from '../../shared/protocol';

type Fake = {
  slot: Slot;
  snapshot: Snapshot;
  start: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  seal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  resumeWith: ReturnType<typeof vi.fn>;
  set: (patch: Partial<Snapshot>) => void;
};
function harness(uses = 3) {
  const made: Fake[] = [];
  const make: MakeSlot = (slot, listener) => {
    const fake: Fake = {
      slot,
      snapshot: {
        role: 'send',
        phase: 'connecting',
        code: slot.code,
        files: [],
        saved: [],
        transferred: 0,
        total: 2,
        speed: 0,
        route: 'connecting',
        message: '',
      },
      start: vi.fn(async () => {}),
      cancel: vi.fn(),
      seal: vi.fn(),
      dispose: vi.fn(async () => {}),
      resumeWith: vi.fn(async () => {}),
      set(patch) {
        fake.snapshot = { ...fake.snapshot, ...patch };
        listener(fake.snapshot);
      },
    };
    made.push(fake);
    return fake;
  };
  const states: GroupSnapshot[] = [];
  const session = SendSession.create(
    [new File(['hi'], 'hi.txt')],
    uses,
    (g) => states.push(g),
    make,
  );
  return { session, made, last: () => states.at(-1)! };
}
afterEach(() => {
  vi.restoreAllMocks();
});

describe('a send several receivers can use', () => {
  it('keeps one waiting slot and opens the next once it is claimed', async () => {
    const { session, made, last } = harness(3);
    await session.start();
    expect(made.map((m) => m.slot.index)).toEqual([0]);
    expect(made[0].slot).toMatchObject({ uses: 3, code: session.snapshot.code });
    made[0].set({ claimed: true });
    expect(made.map((m) => m.slot.index)).toEqual([0, 1]);
    made[1].set({ claimed: true });
    made[2].set({ claimed: true });
    // Never more slots than uses.
    expect(made).toHaveLength(3);
    expect(last()).toMatchObject({ joined: 3, open: false, phase: 'active' });
    expect(last().receivers.map((r) => r.slot)).toEqual([0, 1, 2]);
    await session.dispose();
  });
  it('shows the waiting slot only while the code is open', async () => {
    const { session, made, last } = harness(2);
    await session.start();
    expect(last()).toMatchObject({ open: true, joined: 0 });
    expect(last().receivers).toHaveLength(1);
    expect(last().receivers[0]).toMatchObject({ slot: 0, claimed: false });
    made[0].set({ claimed: true });
    expect(last().receivers).toHaveLength(2);
    await session.dispose();
  });
  it('reads the files once for every receiver', async () => {
    const { session, made } = harness(2);
    await session.start();
    made[0].set({ claimed: true });
    const [a, b] = await Promise.all([made[0].slot.fingerprints(), made[1].slot.fingerprints()]);
    expect(a).toBe(b);
    expect(a[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    await session.dispose();
  });
  it('ends when the code is used up and every receiver has finished', async () => {
    const { session, made, last } = harness(2);
    await session.start();
    made[0].set({ claimed: true, phase: 'transferring' });
    made[1].set({ claimed: true });
    made[0].set({ phase: 'complete' });
    expect(last().phase).toBe('active');
    made[1].set({ phase: 'cancelled' });
    expect(last()).toMatchObject({ phase: 'complete', delivered: 1, joined: 2 });
    await session.settled;
    expect(made[0].dispose).toHaveBeenCalled();
    expect(made[1].dispose).toHaveBeenCalled();
  });
  it('stops sharing through the waiting slot and ends once nothing is in progress', async () => {
    const { session, made, last } = harness(3);
    await session.start();
    made[0].set({ claimed: true, phase: 'complete' });
    expect(last()).toMatchObject({ phase: 'active', open: true });
    session.stopSharing();
    expect(made[1].seal).toHaveBeenCalled();
    expect(last()).toMatchObject({ open: false, phase: 'complete', delivered: 1 });
    expect(last().receivers.map((r) => r.slot)).toEqual([0]);
    // The waiting slot is disposed once the server has closed it.
    expect(made[1].dispose).not.toHaveBeenCalled();
    made[1].set({ phase: 'cancelled' });
    await session.settled;
    expect(made[1].dispose).toHaveBeenCalled();
  });
  it('keeps sending to receivers in progress after it stops sharing', async () => {
    const { session, made, last } = harness(3);
    await session.start();
    made[0].set({ claimed: true, phase: 'transferring' });
    session.stopSharing();
    expect(last()).toMatchObject({ open: false, phase: 'active' });
    expect(made[0].cancel).not.toHaveBeenCalled();
    made[0].set({ phase: 'complete' });
    expect(last().phase).toBe('complete');
  });
  it('cancels receivers in progress and closes the code', async () => {
    const { session, made, last } = harness(3);
    await session.start();
    made[0].set({ claimed: true, phase: 'transferring' });
    session.cancel();
    expect(made[0].cancel).toHaveBeenCalled();
    expect(made[1].seal).toHaveBeenCalled();
    made[0].set({ phase: 'cancelled' });
    expect(last().phase).toBe('cancelled');
  });
  it('fails like a one-receiver code when nobody joins in time', async () => {
    const { session, made, last } = harness(2);
    await session.start();
    vi.spyOn(Date, 'now').mockReturnValue(made[0].slot.pairExpires + 1000);
    made[0].set({ phase: 'error', message: 'This code expired. Start a new transfer.' });
    expect(made).toHaveLength(1);
    expect(last()).toMatchObject({
      phase: 'error',
      message: 'This code expired. Start a new transfer.',
      receivers: [],
    });
    expect(made[0].slot.pairExpires - made[0].slot.expires).toBeLessThan(0);
    expect(made[0].slot.pairExpires).toBeLessThanOrEqual(Date.now() + PAIRING_MS);
  });
  it('lets claimed receivers finish after the window closes', async () => {
    const { session, made, last } = harness(3);
    await session.start();
    made[0].set({ claimed: true, phase: 'transferring' });
    vi.spyOn(Date, 'now').mockReturnValue(made[0].slot.pairExpires + 1000);
    made[1].set({ phase: 'error', message: 'This code expired. Start a new transfer.' });
    expect(last()).toMatchObject({ phase: 'active', open: false });
    expect(last().receivers.map((r) => r.slot)).toEqual([0]);
    made[0].set({ phase: 'complete' });
    expect(last()).toMatchObject({ phase: 'complete', delivered: 1 });
  });
});
