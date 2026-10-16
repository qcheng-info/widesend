import type { RoomReport } from '../../shared/room';
import { reportedFiles } from '../site';

// Activity reports are retried until the room acknowledges them.
export class Reporter {
  private reports = new Map<
    string,
    {
      message: { type: 'audit'; id: string; report: RoomReport };
      acked: boolean;
      attempts: number;
      sent: number;
    }
  >();
  // Keys already acknowledged, so a logical event is reported once; bounded.
  private done = new Set<string>();
  constructor(private send: (value: unknown) => boolean) {}
  report(key: string, original: RoomReport): void {
    if (this.reports.has(key) || this.done.has(key) || this.reports.size >= 512) return;
    const report =
      original.event === 'offer' ? { ...original, files: reportedFiles(original.files) } : original;
    this.reports.set(key, {
      message: { type: 'audit', id: crypto.randomUUID(), report },
      acked: false,
      attempts: 0,
      sent: 0,
    });
    this.flush();
  }
  ack(id: unknown): void {
    for (const [key, r] of this.reports)
      if (r.message.id === id) {
        this.reports.delete(key);
        this.done.add(key);
        if (this.done.size > 4096) this.done.delete(this.done.values().next().value!);
      }
  }
  reconnected(): void {
    for (const r of this.reports.values()) if (!r.acked) r.sent = 0;
    this.flush();
  }
  flush(): void {
    const now = Date.now();
    for (const r of this.reports.values()) {
      if (r.acked || r.attempts >= 8 || now - r.sent < 5000) continue;
      if (!this.send(r.message)) return;
      r.attempts++;
      r.sent = now;
    }
  }
}
