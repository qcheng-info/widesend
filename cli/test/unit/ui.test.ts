import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../../../src/transfer';
import {
  Screen,
  bar,
  cliMessage,
  confirm,
  groupStatus,
  plural,
  progressLine,
  statusLine,
} from '../../src/ui';
import type { GroupSnapshot, ReceiverRow } from '../../../src/send-session';

const snapshot = (patch: Partial<Snapshot>): Snapshot => ({
  role: 'send',
  phase: 'transferring',
  code: 'A1B2C3',
  files: [],
  saved: [],
  transferred: 0,
  total: 0,
  speed: 0,
  route: 'direct',
  message: '',
  ...patch,
});
class Sink extends Writable {
  text = '';
  constructor(readonly isTTY = false) {
    super();
  }
  _write(chunk: Buffer, _: string, done: () => void) {
    this.text += chunk.toString();
    done();
  }
}

describe('progress text', () => {
  it('draws a bar and the transfer numbers', () => {
    expect(bar(0.5, 8)).toBe('████░░░░');
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(3, 'file')).toBe('3 files');
    const line = progressLine(
      snapshot({ transferred: 512 * 1024, total: 1024 * 1024, speed: 256 * 1024 }),
      100,
    );
    expect(line).toMatch(
      /^Sending\s+█+░+\s+50%\s+512\.0 KiB \/ 1\.0 MiB\s+256\.0 KiB\/s\s+direct\s+00:02 left$/,
    );
    expect(progressLine(snapshot({ transferred: 1, total: 2 }), 30)).not.toContain('█');
  });
  it('words each phase for a terminal', () => {
    const view = { pairingEnds: 600_000, waitingSince: 0 };
    expect(statusLine(snapshot({ phase: 'waiting' }), view, 0).text).toBe(
      'Waiting for the receiver… the code expires in 10:00.',
    );
    expect(statusLine(snapshot({ phase: 'reconnecting', message: 'x' }), view, 42_000).text).toBe(
      'Waiting for the connection… (00:42)',
    );
    expect(
      statusLine(
        snapshot({
          phase: 'reconnecting',
          message: 'WideSend is busy. Keep this tab open; we’ll retry automatically.',
        }),
        view,
        0,
      ).text,
    ).toBe('Server busy — retrying automatically.');
    // A receiver that has not found a sender yet may have a mistyped code.
    expect(
      statusLine(snapshot({ role: 'receive', phase: 'reconnecting', files: [] }), view, 15_000)
        .text,
    ).toBe('Looking for the sender… (00:15) Check the code if this takes long.');
    expect(statusLine(snapshot({ checkingFiles: true }), view, 0).text).toBe(
      'Checking files before sending…',
    );
    // A route found while checking is not news on a non-terminal log.
    expect(statusLine(snapshot({ checkingFiles: true, route: 'connecting' }), view, 0).key).toBe(
      statusLine(snapshot({ checkingFiles: true, route: 'direct' }), view, 0).key,
    );
  });
  it('rewords browser messages', () => {
    expect(
      cliMessage('Could not reconnect. Check the code and keep the sender’s page open.'),
    ).toMatch(/sender is still running/);
    expect(cliMessage('The other device ended the transfer.')).toBe(
      'The other device ended the transfer.',
    );
  });
});

describe('a code used several times', () => {
  const row = (slot: number, patch: Partial<ReceiverRow>): ReceiverRow => ({
    slot,
    phase: 'waiting',
    claimed: true,
    transferred: 0,
    total: 100,
    speed: 0,
    route: 'direct',
    message: '',
    ...patch,
  });
  const group = (patch: Partial<GroupSnapshot>): GroupSnapshot => ({
    code: 'A1B2C3',
    uses: 3,
    files: [],
    total: 100,
    pairExpires: 1_092_000,
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
  it('waits for the first use with the code’s time left', () => {
    expect(groupStatus(group({ receivers: [row(0, { claimed: false })] }), 0).text).toBe(
      'Waiting for the code to be used… it expires in 18:12.',
    );
  });
  it('sums up each use', () => {
    const g = group({
      receivers: [
        row(0, { phase: 'complete', transferred: 100 }),
        row(1, { phase: 'transferring', transferred: 45 }),
        row(2, { phase: 'transferring', transferred: 12 }),
      ],
      joined: 3,
      delivered: 1,
      open: false,
    });
    expect(groupStatus(g, 0).text).toBe('1 delivered · 2 sending (45%, 12%)');
    expect(
      groupStatus(group({ receivers: [row(0, {}), row(1, { claimed: false })], joined: 1 }), 0)
        .text,
    ).toBe('1 connecting · code open 18:12');
  });
});

describe('Screen', () => {
  it('prints status changes at once and progress every 5 s without a terminal', () => {
    let now = 0;
    const out = new Sink();
    const screen = new Screen(out, new Sink(), () => now);
    screen.status('Connecting…', 'a');
    screen.status('Sending 1%', 'b');
    now = 1000;
    screen.status('Sending 2%', 'b');
    now = 5000;
    screen.status('Sending 9%', 'b');
    expect(out.text).toBe('Connecting…\nSending 1%\nSending 9%\n');
  });
  it('assumes 80 columns when a terminal reports none', () => {
    const out = Object.assign(new Sink(true), { columns: 0 });
    const screen = new Screen(out, new Sink(), () => 0);
    expect(screen.width).toBe(80);
    screen.status('Sending  0%  direct', 'a');
    expect(out.text).toBe('\r\x1b[2KSending  0%  direct');
  });
  it('redraws one line on a terminal', () => {
    const out = new Sink(true);
    const screen = new Screen(out, new Sink(), () => 0);
    screen.status('one', 'a');
    screen.say('done');
    expect(out.text).toBe('\r\x1b[2Kone\r\x1b[2Kdone\n');
  });
});

describe('confirm', () => {
  it('treats Enter and y as yes, anything else as no', async () => {
    for (const [typed, answer] of [
      ['\n', 'yes'],
      ['Y\n', 'yes'],
      ['no\n', 'no'],
    ]) {
      const input = new PassThrough();
      const result = confirm('Save? ', input, new Sink());
      input.write(typed);
      expect(await result).toBe(answer);
    }
  });
  it('reports Ctrl-C as interrupted', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} });
    const result = confirm('Save? ', input, new Sink(true));
    input.write('\x03');
    expect(await result).toBe('interrupted');
  });
});
