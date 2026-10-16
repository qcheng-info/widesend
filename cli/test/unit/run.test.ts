import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot, Transfer } from '../../../src/transfer';
import { Run, offerHandler } from '../../src/run';
import { Screen } from '../../src/ui';

class Sink extends Writable {
  _write(_: Buffer, __: string, done: () => void) {
    done();
  }
}
const snapshot = (patch: Partial<Snapshot>): Snapshot => ({
  role: 'receive',
  phase: 'waiting',
  code: 'A1B2C3',
  files: [{ id: 0, name: 'a.bin', size: 10, type: '' }],
  saved: [],
  transferred: 0,
  total: 10,
  speed: 0,
  route: 'relay',
  message: '',
  ...patch,
});
const options = () => ({
  screen: new Screen(new Sink(), new Sink()),
  server: new URL('https://widesend.example'),
  direct: { available: true as const },
});
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const existing = Object.fromEntries(signals.map((s) => [s, process.listeners(s)]));
afterEach(() => {
  vi.restoreAllMocks();
  for (const signal of signals)
    for (const listener of process.listeners(signal))
      if (!existing[signal].includes(listener)) process.off(signal, listener);
});

describe('Run', () => {
  it('offers again when the sender comes back before the answer was used', () => {
    const offered = vi.fn();
    const run = new Run(options(), offered);
    run.listener(snapshot({ phase: 'offered' }));
    run.listener(snapshot({ phase: 'reconnecting' }));
    run.listener(snapshot({ phase: 'offered' }));
    run.listener(snapshot({ phase: 'offered' }));
    expect(offered).toHaveBeenCalledTimes(2);
  });
  it('never cancels a finished transfer when Ctrl-C arrives during the wind-down', async () => {
    const run = new Run(options());
    const cancel = vi.fn();
    run.transfer = { cancel } as unknown as Transfer;
    const exit = await run.follow(async () => run.listener(snapshot({ phase: 'complete' })));
    expect(exit).toBe(0);
    const quit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.emit('SIGINT');
    expect(cancel).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledWith(0);
  });
});

describe('offerHandler', () => {
  it('asks once, then accepts again on every new offer', async () => {
    const ask = vi.fn(async () => 'yes' as const);
    const accept = vi.fn(async () => {});
    const handle = offerHandler({ yes: false, show: () => {}, ask, accept, stop: vi.fn() });
    await handle(snapshot({ phase: 'offered' }));
    await handle(snapshot({ phase: 'offered' }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(2);
  });
  it('ignores offers while the question is open and stops on no or Ctrl-C', async () => {
    let answer!: (value: 'no' | 'interrupted') => void;
    const ask = vi.fn(() => new Promise<'no' | 'interrupted'>((resolve) => (answer = resolve)));
    const stop = vi.fn();
    const accept = vi.fn(async () => {});
    const handle = offerHandler({ yes: false, show: () => {}, ask, accept, stop });
    const first = handle(snapshot({ phase: 'offered' }));
    await handle(snapshot({ phase: 'offered' }));
    answer('no');
    await first;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(accept).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith({ declined: true });
    const interrupted = offerHandler({
      yes: false,
      show: () => {},
      ask: async () => 'interrupted',
      accept,
      stop,
    });
    await interrupted(snapshot({ phase: 'offered' }));
    expect(stop).toHaveBeenLastCalledWith({ signal: 'SIGINT' });
  });
  it('with -y accepts without asking', async () => {
    const ask = vi.fn();
    const accept = vi.fn(async () => {});
    await offerHandler({ yes: true, show: () => {}, ask, accept, stop: vi.fn() })(
      snapshot({ phase: 'offered' }),
    );
    expect(ask).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
