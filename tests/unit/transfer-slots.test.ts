import { describe, expect, it, vi } from 'vitest';
import { CODE_USED, Transfer, type Slot } from '../../src/transfer';
import { publicError } from '../../src/messages';

const fingerprint = { sha256: 'a'.repeat(64), md5: 'b'.repeat(32) };
const slot = (index: number): Slot => ({
  index,
  uses: 3,
  code: 'A1B2C3',
  credential: 'c'.repeat(43),
  expires: Date.now() + 1e7,
  pairExpires: Date.now() + 1e6,
  fingerprints: vi.fn(async () => [fingerprint]),
});
const file = new File(['hi'], 'hi.txt');

describe('a transfer as one receiver slot', () => {
  it('announces its slot and the code’s uses when it connects', () => {
    const t = Transfer.sender([file], () => {}, slot(2)) as any;
    expect(t.hello()).toMatchObject({
      role: 'send',
      uses: 3,
      slot: 2,
      code: 'A1B2C3',
      credential: 'c'.repeat(43),
    });
    const single = (Transfer.sender([file], () => {}) as any).hello();
    expect(single.uses).toBeUndefined();
    expect(single.slot).toBeUndefined();
  });
  it('uses the shared fingerprints instead of reading the files again', async () => {
    const s = slot(1);
    const t = Transfer.sender([file], () => {}, s) as any;
    t.save = vi.fn(async () => {});
    t.manifest = vi.fn(async () => {});
    t.pump = vi.fn(async () => {});
    await t.prepareSources();
    expect(s.fingerprints).toHaveBeenCalledOnce();
    expect(t.fingerprints).toEqual([fingerprint]);
  });
  it('reports when the server names its receiver', async () => {
    const snapshots: any[] = [];
    const t = Transfer.sender([file], (s) => snapshots.push(s), slot(0)) as any;
    t.save = vi.fn(async () => {});
    await t.serverMessage({ type: 'connected', keyExchange: 2 });
    expect(snapshots.at(-1).claimed).toBeFalsy();
    await t.serverMessage({ type: 'connected', keyExchange: 2, receiver: 'r'.repeat(43) });
    expect(snapshots.at(-1).claimed).toBe(true);
  });
  it('keeps a finished slot’s record for the rest of the send', async () => {
    const t = Transfer.sender([file], () => {}, slot(1)) as any;
    t.recovery = {
      save: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      unlock: vi.fn(async () => {}),
    };
    await t.forget('complete');
    expect(t.recovery.save).toHaveBeenCalledWith({ finished: 'complete' });
    expect(t.recovery.remove).not.toHaveBeenCalled();
    await t.forget();
    expect(t.recovery.remove).toHaveBeenCalled();
  });
  it('asks the server to stop admitting receivers until it confirms', async () => {
    const t = Transfer.sender([file], () => {}, slot(1)) as any;
    const sent: string[] = [];
    t.ws = { readyState: 1, send: (m: string) => sent.push(m) };
    const seals = () => sent.filter((m) => m === JSON.stringify({ type: 'seal' })).length;
    t.seal();
    expect(seals()).toBe(1);
    t.save = vi.fn(async () => {});
    // After a reconnect it asks again, until the server answers.
    await t.serverMessage({ type: 'connected', keyExchange: 2 });
    expect(seals()).toBe(2);
    await t.serverMessage({ type: 'sealed' });
    await t.serverMessage({ type: 'connected', keyExchange: 2 });
    expect(seals()).toBe(2);
  });
  it('says plainly when the code is used up', () => {
    const t = new Transfer('receive', 'A1B2C3', () => {}) as any;
    t.fail = vi.fn();
    t.closed({ code: 4005 });
    expect(t.fail).toHaveBeenCalledWith(CODE_USED);
    expect(publicError(CODE_USED)).toBe(CODE_USED);
  });
  it('matches the original files by name, size and fingerprint', async () => {
    const other = new File(['other'], 'other.txt');
    const meta = [
      { id: 0, name: 'hi.txt', size: 2, type: '' },
      { id: 1, name: 'other.txt', size: 5, type: '' },
    ];
    const signal = new AbortController().signal;
    // Selection order doesn't matter.
    const { files, fingerprints } = await Transfer.matchOriginals(
      [other, file],
      meta,
      undefined,
      signal,
    );
    expect(files).toEqual([file, other]);
    expect(fingerprints[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    // A different file with the same name and size is refused.
    await expect(
      Transfer.matchOriginals(
        [new File(['zz'], 'hi.txt'), other],
        meta,
        [fingerprint, fingerprints[1]],
        signal,
      ),
    ).rejects.toThrow('Select the same original files to continue.');
  });
});

describe('a waiting slot of a shared code', () => {
  const stalled = (t: any) => {
    t.update = vi.fn();
    t.fail = vi.fn();
    t.reconnectStarted = Date.now() - 100_000;
    t.scheduleReconnect();
    clearTimeout(t.reconnectTimer);
    return t.fail;
  };
  it('keeps reconnecting until the code’s window ends, so the next receiver isn’t stranded', () => {
    expect(stalled(Transfer.sender([file], () => {}, slot(2)))).not.toHaveBeenCalled();
  });
  it('still gives up after 90 seconds as a one-receiver sender', () => {
    expect(stalled(Transfer.sender([file], () => {}))).toHaveBeenCalled();
  });
});

it('remembers that the code was closed, for a reloaded page', () => {
  const t = Transfer.sender([file], () => {}, slot(1)) as any;
  t.save = vi.fn(async () => {});
  t.seal();
  expect(t.save).toHaveBeenCalledWith({ sealed: true });
});
