import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot, ReceiverRow } from '../../../src/send-session';
import { GroupRun, type SessionLike } from '../../src/many';
import { Screen } from '../../src/ui';

class Sink extends Writable {
  text = '';
  _write(chunk: Buffer, _: string, done: () => void) {
    this.text += chunk.toString();
    done();
  }
}
const row = (slot: number, patch: Partial<ReceiverRow> = {}): ReceiverRow => ({
  slot,
  phase: 'waiting',
  claimed: true,
  transferred: 0,
  total: 10,
  speed: 0,
  route: 'direct',
  message: '',
  ...patch,
});
const group = (patch: Partial<GroupSnapshot> = {}): GroupSnapshot => ({
  code: 'A1B2C3',
  uses: 3,
  files: [{ id: 0, name: 'a.bin', size: 10, type: '' }],
  total: 10,
  pairExpires: Date.now() + 1_000_000,
  open: true,
  phase: 'active',
  message: '',
  receivers: [],
  joined: 0,
  delivered: 0,
  needsFiles: false,
  checkingFiles: false,
  ...patch,
});
function setup() {
  const out = new Sink(),
    err = new Sink();
  const run = new GroupRun({
    screen: new Screen(out, err),
    server: new URL('https://widesend.example'),
    direct: { available: true },
  });
  const session: SessionLike & { [k: string]: any } = {
    snapshot: group(),
    start: vi.fn(async () => {}),
    stopSharing: vi.fn(),
    cancel: vi.fn(),
    dispose: vi.fn(async () => {}),
    settled: Promise.resolve(),
  };
  run.session = session;
  return { run, session, out, err };
}
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const existing = Object.fromEntries(signals.map((s) => [s, process.listeners(s)]));
afterEach(() => {
  vi.restoreAllMocks();
  for (const signal of signals)
    for (const listener of process.listeners(signal))
      if (!existing[signal].includes(listener)) process.off(signal, listener);
});

describe('a send to several receivers on the command line', () => {
  it('prints each receiver’s result and succeeds when everyone who started got the files', async () => {
    const { run, out, err } = setup();
    const exit = await run.follow(async () => {
      run.listener(group({ receivers: [row(0, { phase: 'transferring' })], joined: 1 }));
      run.listener(
        group({
          receivers: [
            row(0, { phase: 'complete' }),
            row(1, { phase: 'cancelled', message: 'The other device ended the transfer.' }),
          ],
          joined: 2,
          delivered: 1,
        }),
      );
      run.listener(
        group({
          phase: 'complete',
          open: false,
          receivers: [row(0, { phase: 'complete' }), row(1, { phase: 'cancelled' })],
          joined: 2,
          delivered: 1,
        }),
      );
    });
    expect(exit).toBe(0);
    expect(out.text).toContain('✓ Use 1: delivered (direct connection).');
    expect(err.text).toContain('✗ Use 2: The other device ended the transfer.');
    expect(out.text).toContain('✓ Delivered once.');
  });
  it('fails when a receiver stopped part way', async () => {
    const { run } = setup();
    const exit = await run.follow(async () => {
      run.listener(
        group({
          receivers: [row(0, { phase: 'transferring' }), row(1, { phase: 'transferring' })],
          joined: 2,
        }),
      );
      run.listener(
        group({
          phase: 'complete',
          open: false,
          receivers: [row(0, { phase: 'complete' }), row(1, { phase: 'error', message: 'x' })],
          joined: 2,
          delivered: 1,
        }),
      );
    });
    expect(exit).toBe(1);
  });
  it('cancels receivers in progress on Ctrl-C', async () => {
    const { run, session } = setup();
    session.cancel = vi.fn(() =>
      run.listener(
        group({
          phase: 'cancelled',
          open: false,
          message: 'Transfer cancelled.',
          receivers: [row(0, { phase: 'cancelled' })],
          joined: 1,
        }),
      ),
    );
    const exit = await run.follow(async () => {
      run.listener(group({ receivers: [row(0, { phase: 'transferring' })], joined: 1 }));
      process.emit('SIGINT');
    });
    expect(session.cancel).toHaveBeenCalled();
    expect(session.stopSharing).not.toHaveBeenCalled();
    expect(exit).toBe(130);
  });
  it('stops sharing on Ctrl-C when it is only waiting for more receivers', async () => {
    const { run, session } = setup();
    const done = group({ receivers: [row(0, { phase: 'complete' })], joined: 1, delivered: 1 });
    session.stopSharing = vi.fn(() => run.listener({ ...done, phase: 'complete', open: false }));
    const exit = await run.follow(async () => {
      run.listener(done);
      process.emit('SIGINT');
    });
    expect(session.stopSharing).toHaveBeenCalled();
    expect(session.cancel).not.toHaveBeenCalled();
    expect(exit).toBe(0);
  });
  it('fails like a one-receiver send when nobody joins in time', async () => {
    const { run, err } = setup();
    const exit = await run.follow(async () => {
      run.listener(
        group({ phase: 'error', open: false, message: 'This code expired. Start a new transfer.' }),
      );
    });
    expect(exit).toBe(1);
    expect(err.text).toContain('✗ This code expired. Start a new transfer.');
  });
});
