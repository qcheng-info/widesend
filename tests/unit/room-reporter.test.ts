import { describe, expect, it } from 'vitest';
import { Reporter } from '../../src/room/reporter';

const delivery = (n: number) => ({
  event: 'delivery' as const,
  offer: n.toString(16).padStart(32, '0'),
  recipient: 'a'.repeat(32),
  status: 'complete' as const,
  route: 'relay' as const,
});

describe('room activity reporter', () => {
  it('keeps reporting for a busy member once earlier reports are acknowledged', () => {
    const sent: { id: string }[] = [];
    const reporter = new Reporter((message) => {
      sent.push(message as { id: string });
      reporter.ack((message as { id: string }).id);
      return true;
    });
    for (let i = 0; i < 600; i++) reporter.report(`d${i}`, delivery(i));
    expect(sent).toHaveLength(600);
  });
  it('sends each logical report once, even after it was acknowledged', () => {
    const sent: unknown[] = [];
    const reporter = new Reporter((message) => {
      sent.push(message);
      reporter.ack((message as { id: string }).id);
      return true;
    });
    reporter.report('same', delivery(1));
    reporter.report('same', delivery(1));
    expect(sent).toHaveLength(1);
  });
  it('retries unacknowledged reports after a reconnect', () => {
    let online = false;
    const sent: unknown[] = [];
    const reporter = new Reporter((message) => {
      if (!online) return false;
      sent.push(message);
      return true;
    });
    reporter.report('r', delivery(2));
    expect(sent).toHaveLength(0);
    online = true;
    reporter.reconnected();
    expect(sent).toHaveLength(1);
  });
});
