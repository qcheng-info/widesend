import { formatBytes } from '../../src/format';
import { SendSession, type GroupSnapshot } from '../../src/send-session';
import type { Phase } from '../../src/transfer';
import { settleSockets, socketsClosed } from './environment';
import { DEFAULT_SERVER, shareLink } from './link';
import {
  SIGNALS,
  directNotice,
  routeName,
  within,
  type Exit,
  type Options,
  type Signal,
} from './run';
import { cliMessage, groupStatus, plural, qrCode } from './ui';

export type SessionLike = Pick<
  SendSession,
  'snapshot' | 'start' | 'stopSharing' | 'cancel' | 'dispose' | 'settled'
>;
const ended = (phase: Phase) => phase === 'complete' || phase === 'error' || phase === 'cancelled';

/** Follows a send whose code can be used several times: a line per use, one status line, signals. */
export class GroupRun {
  session!: SessionLike;
  snapshot?: GroupSnapshot;
  private signal?: Signal;
  private problem?: string;
  private reported = new Set<number>();
  private started = new Set<number>();
  private finished!: () => void;
  private ended = new Promise<void>((resolve) => (this.finished = resolve));
  constructor(private options: Options) {}
  listener = (g: GroupSnapshot) => {
    this.snapshot = g;
    const { screen } = this.options;
    for (const r of g.receivers) {
      if (!r.claimed || this.reported.has(r.slot)) continue;
      if (r.phase === 'transferring') this.started.add(r.slot);
      if (r.phase === 'complete') {
        this.reported.add(r.slot);
        screen.say(`✓ Use ${r.slot + 1}: delivered (${routeName(r.route)}).`);
      } else if (r.phase === 'error' || r.phase === 'cancelled') {
        this.reported.add(r.slot);
        screen.warn(`✗ Use ${r.slot + 1}: ${cliMessage(r.message)}`);
      }
    }
    if (g.phase !== 'active') this.finished();
    else this.render();
  };
  private render() {
    if (!this.snapshot || this.snapshot.phase !== 'active') return;
    const { text, key } = groupStatus(this.snapshot, Date.now());
    if (text) this.options.screen.status(text, key);
  }
  async follow(start: () => Promise<void>): Promise<Exit> {
    const { screen } = this.options;
    let signals = 0;
    const onSignal = (signal: Signal) => {
      if (++signals > 1) process.exit(SIGNALS[signal]);
      const g = this.snapshot;
      // While a use is receiving, Ctrl-C cancels. While only waiting for further
      // uses after a delivery, it stops sharing the code and finishes.
      if (g && g.delivered && !g.receivers.some((r) => r.claimed && !ended(r.phase))) {
        screen.say('Stopping…');
        this.session.stopSharing();
      } else {
        this.signal = signal;
        screen.say('Cancelling…');
        this.session.cancel();
      }
    };
    const handlers = (Object.keys(SIGNALS) as Signal[]).map(
      (signal) => [signal, () => onSignal(signal)] as const,
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const ticker = setInterval(() => this.render(), 1000);
    try {
      await start();
    } catch (error) {
      this.problem = (error as Error).message;
      this.session.cancel();
    }
    await this.ended;
    clearInterval(ticker);
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
      process.once(signal, () => process.exit(SIGNALS[signal]));
    }
    screen.clear();
    const g = this.snapshot!;
    const failed = g.receivers.filter(
      (r) => r.claimed && r.phase !== 'complete' && this.started.has(r.slot),
    ).length;
    if (this.signal) {
      screen.warn('Cancelled. The other devices were told.');
      return SIGNALS[this.signal];
    }
    if (this.problem) {
      screen.warn(`✗ ${cliMessage(this.problem)}`);
      return 1;
    }
    if (!g.delivered) {
      screen.warn(`✗ ${cliMessage(g.message)}`);
      return 1;
    }
    screen.say(`✓ Delivered ${g.delivered === 1 ? 'once' : `${g.delivered} times`}.`);
    return failed ? 1 : 0;
  }
}

export async function sendMany(files: File[], uses: number, options: Options): Promise<Exit> {
  const { screen, server } = options;
  const run = new GroupRun(options);
  const session = (run.session = SendSession.create(files, uses, run.listener));
  const { code, total } = session.snapshot;
  const link = shareLink(code);
  screen.say(
    `Sending ${plural(files.length, 'file')} (${formatBytes(total)}). The code can be used ${uses} times.`,
  );
  screen.say();
  screen.say(`  Code   ${code}`);
  screen.say(`  Link   ${link}`);
  if (screen.interactive && screen.width >= 46) {
    screen.say();
    for (const line of qrCode(link).split('\n')) screen.say(`  ${line}`);
  }
  screen.say();
  screen.say(
    `Open the link on each device that should receive, or run: widesend receive ${server.origin === DEFAULT_SERVER ? code : link}`,
  );
  directNotice(options);
  const exit = await run.follow(() => session.start());
  // Each receiving device waits for its final acknowledgement; the code is closed on the server.
  await settleSockets(2000);
  await within(session.settled, 5000);
  await session.dispose();
  await socketsClosed(1000);
  return exit;
}
