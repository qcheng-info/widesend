import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { renderUnicodeCompact } from 'uqr';
import { formatBytes, formatDuration } from '../../src/format';
import type { Snapshot } from '../../src/transfer';
import type { GroupSnapshot } from '../../src/send-session';

type Terminal = Writable & { isTTY?: boolean; columns?: number };

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
export const qrCode = (text: string) => renderUnicodeCompact(text, { border: 1 });

/** Prints lines, and one status line that is redrawn on a terminal or printed now and then. */
export class Screen {
  private live = false;
  private drawn = -Infinity;
  private printed = -Infinity;
  private key = '';
  constructor(
    readonly out: Terminal = process.stdout,
    readonly err: Terminal = process.stderr,
    private clock = () => Date.now(),
  ) {}
  get interactive(): boolean {
    return !!this.out.isTTY;
  }
  get width(): number {
    return this.out.columns || 80;
  }
  say(text = ''): void {
    this.clear();
    this.out.write(`${text}\n`);
  }
  warn(text: string): void {
    this.clear();
    this.err.write(`${text}\n`);
  }
  status(text: string, key: string): void {
    const now = this.clock();
    const changed = key !== this.key;
    this.key = key;
    if (this.interactive) {
      if (!changed && now - this.drawn < 100) return;
      this.drawn = now;
      this.out.write(`\r\x1b[2K${text.slice(0, this.width - 1)}`);
      this.live = true;
    } else if (changed || now - this.printed >= 5000) {
      this.printed = now;
      this.out.write(`${text}\n`);
    }
  }
  clear(): void {
    if (!this.live) return;
    this.out.write('\r\x1b[2K');
    this.live = false;
  }
}

export function progressLine(s: Snapshot, width: number): string {
  const verb = s.role === 'send' ? 'Sending' : 'Receiving';
  const fraction = s.total ? s.transferred / s.total : 1;
  const speed = s.stats?.speed ?? s.speed;
  const tail = [
    `${Math.floor(fraction * 100)}%`,
    `${formatBytes(s.transferred)} / ${formatBytes(s.total)}`,
    speed > 0 ? `${formatBytes(speed)}/s` : '',
    s.route === 'connecting' ? '' : s.route,
    speed > 0 ? `${formatDuration((s.total - s.transferred) / speed)} left` : '',
  ]
    .filter(Boolean)
    .join('  ');
  const room = Math.min(24, width - verb.length - tail.length - 6);
  return room >= 8 ? `${verb}  ${bar(fraction, room)}  ${tail}` : `${verb}  ${tail}`;
}

export type View = { pairingEnds: number; waitingSince: number };
export function statusLine(s: Snapshot, view: View, now: number, width = 80) {
  const key = s.checkingFiles ? 'checking' : `${s.phase}:${s.route}`;
  const text = (() => {
    switch (s.phase) {
      case 'connecting':
        return 'Connecting…';
      case 'waiting':
        if (s.role === 'receive') return 'Waiting for the sender…';
        return view.pairingEnds > now
          ? `Waiting for the receiver… the code expires in ${formatDuration((view.pairingEnds - now) / 1000)}.`
          : 'Waiting for the receiver…';
      case 'reconnecting': {
        const waited = formatDuration((now - view.waitingSince) / 1000);
        if (/busy/i.test(s.message)) return 'Server busy — retrying automatically.';
        // The server refuses an unknown code, but a socket cannot tell why.
        if (s.role === 'receive' && !s.files.length)
          return `Looking for the sender… (${waited}) Check the code if this takes long.`;
        return `Waiting for the connection… (${waited})`;
      }
      case 'transferring':
        return s.checkingFiles ? 'Checking files before sending…' : progressLine(s, width);
      default:
        return '';
    }
  })();
  return { text, key };
}

/** One line for a send whose code can be used several times. */
export function groupStatus(g: GroupSnapshot, now: number) {
  const claimed = g.receivers.filter((r) => r.claimed);
  const percent = (r: { transferred: number; total: number }) =>
    `${r.total ? Math.floor((r.transferred / r.total) * 100) : 100}%`;
  const sending = claimed.filter((r) => r.phase === 'transferring' || r.phase === 'reconnecting');
  const joining = claimed.filter((r) => ['connecting', 'waiting', 'offered'].includes(r.phase));
  const left = formatDuration((g.pairExpires - now) / 1000);
  const parts = [
    g.delivered ? `${g.delivered} delivered` : '',
    sending.length ? `${sending.length} sending (${sending.map(percent).join(', ')})` : '',
    joining.length ? `${joining.length} connecting` : '',
    g.open ? `code open ${left}` : '',
  ].filter(Boolean);
  const text =
    !claimed.length && g.open
      ? `Waiting for the code to be used… it expires in ${left}.`
      : parts.join(' · ');
  return { text, key: `${g.delivered}:${sending.length}:${joining.length}:${g.open}` };
}

// The engine's messages are written for a web page.
const wording = new Map([
  [
    'Could not reconnect. Check the code and keep the sender’s page open.',
    'Could not connect. Check the code, and that the sender is still running and nobody else claimed it.',
  ],
  [
    'Could not join this transfer. Ask the sender for a new code.',
    'Could not join this transfer. It may already be claimed; ask the sender for a new code.',
  ],
  [
    'A selected file changed. Select it again and start a new transfer.',
    'A file changed while it was being sent. Start a new transfer.',
  ],
  [
    'This transfer was opened in another tab. Continue there or start again.',
    'Another device took over this transfer.',
  ],
]);
export const cliMessage = (message: string) => wording.get(message) ?? message;

/** Asks a yes/no question; Enter means yes. */
export function confirm(
  question: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<'yes' | 'no' | 'interrupted'> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output });
    let settled = false;
    const done = (answer: 'yes' | 'no' | 'interrupted') => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(answer);
    };
    rl.on('SIGINT', () => {
      output.write('\n');
      done('interrupted');
    });
    rl.on('close', () => done('no'));
    rl.question(question, (answer) => done(/^\s*(y(es)?)?\s*$/i.test(answer) ? 'yes' : 'no'));
  });
}
