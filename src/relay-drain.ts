import { MAX_FRAME } from '../shared/protocol';

// Credit returned after consumed messages is cumulative. Keep one bounded
// counter/timer per socket, and flush small tails even if no more data arrives.
export class RelayDrain {
  private pending = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private limit = MAX_FRAME;

  // One-to-one transfers use the defaults. Rooms batch larger credits less often,
  // since every drain message counts against the relay budget.
  constructor(
    private send: (bytes: number) => void,
    private batching: { threshold?: number; delay?: number } = {},
  ) {}

  setLimit(limit: number): void {
    this.flush();
    this.limit = limit;
  }

  consumed(bytes: number): void {
    if (this.stopped) return;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.limit)
      throw new Error('Invalid relay credit.');
    const threshold = this.batching.threshold ?? Math.min(MAX_FRAME, this.limit);
    if (this.batching.threshold === undefined && this.pending + bytes > this.limit) this.flush();
    this.pending += bytes;
    if (this.pending >= threshold) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.batching.delay ?? 50);
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const bytes = this.pending;
    this.pending = 0;
    if (bytes && !this.stopped) this.send(bytes);
  }

  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = 0;
  }

  dispose(): void {
    this.stopped = true;
    this.reset();
  }
}
