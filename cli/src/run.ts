import { fileURLToPath } from 'node:url';
import { PAIRING_MS } from '../../shared/protocol';
import { formatBytes } from '../../src/format';
import { UPDATE_REQUIRED } from '../../src/key-session';
import { Transfer, type Snapshot } from '../../src/transfer';
import { settleSockets, socketsClosed, type Direct } from './environment';
import { DEFAULT_SERVER, shareLink } from './link';
import { progressDiscarded } from './node-recovery';
import { configureStorage, settleStorage, storageFailure } from './node-storage';
import { cliMessage, confirm, plural, qrCode, statusLine, type Screen } from './ui';

export type Exit = 0 | 1 | 129 | 130 | 143;
export type Options = { screen: Screen; server: URL; direct: Direct };
export const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
export type Signal = keyof typeof SIGNALS;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const within = (promise: Promise<unknown>, ms: number) => Promise.race([promise, sleep(ms)]);
export const routeName = (route: Snapshot['route']) =>
  route === 'direct' ? 'direct connection' : 'encrypted relay';

/** Follows one transfer to its end: draws progress, handles signals, cleans up. */
export class Run {
  transfer!: Transfer;
  snapshot?: Snapshot;
  prompting = false;
  private signal?: Signal;
  private problem?: string;
  private declined = false;
  private phase?: Snapshot['phase'];
  private waitingSince = 0;
  private finished!: () => void;
  private ended = new Promise<void>((resolve) => (this.finished = resolve));
  private pairingEnds = Date.now() + PAIRING_MS;
  constructor(
    private options: Options,
    private onOffered?: (s: Snapshot) => void,
  ) {}
  listener = (s: Snapshot) => {
    this.snapshot = s;
    if (s.phase !== 'reconnecting') this.waitingSince = 0;
    else this.waitingSince ||= Date.now();
    if (s.message === UPDATE_REQUIRED || ['complete', 'error', 'cancelled'].includes(s.phase)) {
      this.finished();
      return;
    }
    // The sender can drop and offer again while the question is open; each offer counts.
    const offered = s.phase === 'offered' && this.phase !== 'offered';
    this.phase = s.phase;
    if (offered) this.onOffered?.(s);
    this.render();
  };
  private render() {
    const s = this.snapshot;
    if (!s || this.prompting || s.phase === 'offered') return;
    const view = { pairingEnds: this.pairingEnds, waitingSince: this.waitingSince };
    const { text, key } = statusLine(s, view, Date.now(), this.options.screen.width);
    if (text) this.options.screen.status(text, key);
  }
  /** Stops the transfer because of the user or a local problem; the other side is told. */
  stop(reason: { signal: Signal } | { problem: string } | { declined: true }) {
    if (this.signal || this.problem || this.declined) return;
    if ('signal' in reason) {
      this.signal = reason.signal;
      this.options.screen.say('Cancelling…');
    } else if ('problem' in reason) this.problem = reason.problem;
    else this.declined = true;
    this.transfer.cancel();
  }
  async follow(start: () => Promise<void>): Promise<Exit> {
    const { screen } = this.options;
    let signals = 0;
    const onSignal = (signal: Signal) => {
      // A second signal means "now": leave without waiting for the network.
      if (++signals > 1) process.exit(SIGNALS[signal]);
      this.stop({ signal });
    };
    for (const signal of Object.keys(SIGNALS) as Signal[]) process.on(signal, onSignal);
    const ticker = setInterval(() => this.render(), 1000);
    try {
      await start();
    } catch (error) {
      this.stop({ problem: storageFailure()?.message ?? (error as Error).message });
    }
    await this.ended;
    clearInterval(ticker);
    // The transfer is over: a signal now only means "stop waiting", never "cancel".
    const done = this.snapshot!.phase === 'complete' && !this.signal;
    for (const signal of Object.keys(SIGNALS) as Signal[]) {
      process.off(signal, onSignal);
      process.once(signal, () => process.exit(done ? 0 : SIGNALS[signal]));
    }
    screen.clear();
    const s = this.snapshot!;
    if (done) return 0;
    if (this.signal) screen.warn('Cancelled. The other side was told.');
    else if (this.declined) screen.warn('Declined. The sender was told.');
    else if (s.message === UPDATE_REQUIRED)
      screen.warn(
        '✗ The other side runs an older WideSend. Ask them to refresh the page, then start again.',
      );
    else screen.warn(`✗ ${this.problem ?? storageFailure()?.message ?? cliMessage(s.message)}`);
    // Give the cancel message and file cleanup a moment; never hang on a dead network.
    await within(progressDiscarded, 3000);
    await settleStorage();
    await socketsClosed(1000);
    return this.signal ? SIGNALS[this.signal] : 1;
  }
}

type Answer = 'yes' | 'no' | 'interrupted';
type Stop = Parameters<Run['stop']>[0];
/**
 * Handles each offer of the file list: asks once (unless -y), then accepts this
 * and every later offer, since the sender offers again after it reconnects.
 */
export function offerHandler(o: {
  yes: boolean;
  show: (s: Snapshot) => void;
  ask: () => Promise<Answer>;
  accept: () => Promise<void>;
  stop: (reason: Stop) => void;
}) {
  let state: 'new' | 'asking' | 'accepted' = 'new';
  return async (s: Snapshot) => {
    if (state === 'asking') return;
    if (state === 'new') {
      o.show(s);
      if (!o.yes) {
        state = 'asking';
        const answer = await o.ask();
        if (answer !== 'yes') {
          state = 'new';
          o.stop(answer === 'no' ? { declined: true } : { signal: 'SIGINT' });
          return;
        }
      }
      state = 'accepted';
    }
    await o.accept();
  };
}

export function directNotice({ screen, direct }: Options) {
  if (!direct.available && direct.reason !== 'turned off with --relay')
    screen.warn(`Direct connections are unavailable here (${direct.reason}); using the relay.`);
}

export async function send(files: File[], options: Options): Promise<Exit> {
  const { screen, server } = options;
  const run = new Run(options);
  const transfer = (run.transfer = Transfer.sender(files, run.listener));
  const { code, total } = transfer.snapshot;
  const link = shareLink(code);
  screen.say(`Sending ${plural(files.length, 'file')} (${formatBytes(total)})`);
  screen.say();
  screen.say(`  Code   ${code}`);
  screen.say(`  Link   ${link}`);
  if (screen.interactive && screen.width >= 46) {
    screen.say();
    for (const line of qrCode(link).split('\n')) screen.say(`  ${line}`);
  }
  screen.say();
  screen.say(
    `Open the link to receive in a browser, or run: widesend receive ${server.origin === DEFAULT_SERVER ? code : link}`,
  );
  directNotice(options);
  const exit = await run.follow(() => transfer.start());
  if (exit) return exit;
  screen.say(
    `✓ ${files.length === 1 ? 'The file' : `All ${files.length} files`} arrived and passed the receiver's check (${routeName(run.snapshot!.route)}).`,
  );
  // The receiver waits for this acknowledgement; let it leave before exiting.
  await settleSockets(2000);
  await transfer.dispose();
  await socketsClosed(1000);
  return 0;
}

export async function receive(
  code: string,
  output: string,
  yes: boolean,
  options: Options,
): Promise<Exit> {
  const { screen } = options;
  configureStorage({ directory: output });
  const handle = offerHandler({
    yes,
    show: (s) => {
      screen.clear();
      screen.say(`From ${s.code} — ${plural(s.files.length, 'file')}, ${formatBytes(s.total)}`);
      const width = Math.min(48, Math.max(...s.files.map((f) => f.name.length)));
      for (const file of s.files.slice(0, 20))
        screen.say(`  ${file.name.padEnd(width)}  ${formatBytes(file.size)}`);
      if (s.files.length > 20) screen.say(`  … and ${s.files.length - 20} more`);
      if (yes) screen.say(`Saving to ${output}`);
    },
    ask: async () => {
      run.prompting = true;
      try {
        return await confirm(`Save to ${output}? [Y/n] `);
      } finally {
        run.prompting = false;
      }
    },
    accept: async () => {
      try {
        await transfer.accept();
      } catch (error) {
        run.stop({ problem: storageFailure()?.message ?? (error as Error).message });
      }
    },
    stop: (reason) => run.stop(reason),
  });
  const run: Run = new Run(options, (s) => void handle(s));
  const transfer = (run.transfer = Transfer.receiver(code, run.listener));
  directNotice(options);
  const exit = await run.follow(() => transfer.start());
  if (exit) return exit;
  screen.say(`✓ Saved and verified (${routeName(run.snapshot!.route)}):`);
  for (const file of run.snapshot!.saved) screen.say(`  ${fileURLToPath(file.url)}`);
  // The sender is told we are done; its reply ends the session cleanly.
  await within(progressDiscarded, 10_000);
  await settleSockets(1000);
  await transfer.dispose();
  await socketsClosed(1000);
  return 0;
}
