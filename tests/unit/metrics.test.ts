import { describe, expect, it } from 'vitest';
import { TransferMeter } from '../../src/metrics';

describe('transfer diagnostics', () => {
  it('starts timing at acceptance and counts acknowledged progress once across a resume', () => {
    let now = 10_000;
    const meter = new TransferMeter(() => now);
    expect(meter.sample(0).elapsed).toBe(0);
    meter.start();
    now += 1000;
    expect(meter.sample(1024).speed).toBe(1024);
    now += 1000;
    // A stale resume position must not produce a negative rate or count a replay twice.
    expect(meter.sample(512).speed).toBe(0);
    meter.start();
    now += 1000;
    const resumed = meter.sample(2048);
    expect(resumed.speed).toBe(1024);
    expect(resumed.elapsed).toBe(3);
    expect(resumed.averageSpeed).toBeCloseTo(2048 / 3);
  });

  it('shows zero speed during a stall and freezes the final snapshot', () => {
    let now = 0;
    const meter = new TransferMeter(() => now);
    meter.start();
    now = 1000;
    meter.sample(2048);
    now = 3000;
    expect(meter.sample(2048).speed).toBe(0);
    meter.record('Transfer failed');
    const final = meter.sample(2048, true);
    now = 60_000;
    meter.record('Should not appear');
    expect(meter.sample(99999)).toEqual(final);
    expect(final.averageSpeed).toBeCloseTo(2048 / 3);
  });

  it('bounds history during a day-long transfer and does not mutate published samples', () => {
    let now = 0;
    const meter = new TransferMeter(() => now);
    meter.start();
    const first = meter.sample(0);
    for (let second = 1; second <= 86400; second++) {
      now = second * 1000;
      meter.record('Reconnection attempt');
      meter.sample(second * 1024);
    }
    const last = meter.sample(86400 * 1024);
    expect(first.events).toHaveLength(1);
    expect(first.samples).toHaveLength(1);
    expect(last.events).toHaveLength(30);
    expect(last.samples.length).toBeLessThanOrEqual(61);
    expect(last.samples.every((point) => point.elapsed > last.elapsed - 60)).toBe(true);
    expect(last.averageSpeed).toBe(1024);
  });
});
