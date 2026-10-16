// All histories stay bounded, including for day-long transfers. Times are monotonic.
export type SpeedSample = { elapsed: number; speed: number };
export type TransferEvent = { elapsed: number; label: string };
export type TimingStats = {
  started: boolean;
  elapsed: number;
  speed: number;
  averageSpeed: number;
  samples: SpeedSample[];
  events: TransferEvent[];
};

export class TransferMeter {
  private startedAt?: number;
  private finishedAt?: number;
  private sampledAt = 0;
  private sampledBytes = 0;
  private highWater = 0;
  private samples: SpeedSample[] = [];
  private events: TransferEvent[] = [];
  private speed = 0;

  constructor(private now = () => performance.now()) {}

  start(): void {
    if (this.startedAt !== undefined) return;
    this.startedAt = this.now();
    this.sampledAt = this.startedAt;
    this.samples = [{ elapsed: 0, speed: 0 }];
    this.record('Transfer started');
  }

  record(label: string): void {
    if (this.finishedAt !== undefined) return;
    this.events = [...this.events.slice(-29), { elapsed: this.elapsed(), label }];
  }

  private elapsed(): number {
    return this.startedAt === undefined
      ? 0
      : Math.max(0, ((this.finishedAt ?? this.now()) - this.startedAt) / 1000);
  }

  sample(bytes: number, finish = false): TimingStats {
    if (this.startedAt !== undefined && this.finishedAt === undefined) {
      const now = this.now();
      this.highWater = Math.max(this.highWater, bytes);
      const interval = (now - this.sampledAt) / 1000;
      if (interval >= 1 || finish) {
        this.speed = interval > 0 ? (this.highWater - this.sampledBytes) / interval : 0;
        this.sampledBytes = this.highWater;
        this.sampledAt = now;
        const elapsed = this.elapsed();
        this.samples = [
          ...this.samples.filter((point) => point.elapsed > elapsed - 60).slice(-60),
          { elapsed, speed: this.speed },
        ];
      }
      if (finish) {
        this.finishedAt = now;
        this.speed = 0;
      }
    }
    const elapsed = this.elapsed();
    return {
      started: this.startedAt !== undefined,
      elapsed,
      speed: this.speed,
      averageSpeed: elapsed > 0 ? this.highWater / elapsed : 0,
      samples: this.samples,
      events: this.events,
    };
  }
}
