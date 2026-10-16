import { HOUR, emptyBlocks, type BlockBucket, type BlockKind } from '../shared/health';

// Ten-second batches bound monitoring work during a burst. Callers attach the
// returned promise to waitUntil; no file messages pass through this buffer.
// A runtime termination can lose the last batch. Telemetry is best effort.
export class BlockBuffer {
  private pending = new Map<number, BlockBucket>();
  private task?: Promise<void>;
  constructor(private write: (batch: BlockBucket[]) => Promise<void>) {}
  add(kind: BlockKind, now = Date.now(), count = 1): Promise<void> {
    const hour = Math.floor(now / HOUR) * HOUR;
    const bucket = this.pending.get(hour) ?? { hour, ...emptyBlocks() };
    bucket[kind] += count;
    this.pending.set(hour, bucket);
    if (!this.task) {
      this.task = new Promise<void>((resolve) => setTimeout(resolve, 10_000)).then(async () => {
        const batch = [...this.pending.values()];
        this.pending.clear();
        this.task = undefined;
        try {
          await this.write(batch);
        } catch {
          /* Monitoring must never change an admission decision. */
        }
      });
    }
    return this.task;
  }
  snapshot(): BlockBucket[] {
    return [...this.pending.values()].map((bucket) => ({ ...bucket }));
  }
}
