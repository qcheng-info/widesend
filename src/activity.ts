import type { AuditMessage, AuditReport } from '../shared/audit';
import { reportedFiles } from './site';

// Reports travel only over this participant's authenticated session socket.
// They are separate from encrypted file frames and contain no file bytes/keys.
export class ActivityReporter {
  private socket?: WebSocket;
  private reports = new Map<
    string,
    { message: AuditMessage; attempts: number; acked: boolean; sent: number }
  >();
  attach(socket: WebSocket): void {
    this.socket = socket;
    for (const report of this.reports.values()) if (!report.acked) report.sent = 0;
    this.flush();
  }
  report(key: string, original: AuditReport): void {
    if (this.reports.has(key) || this.reports.size >= 128) return;
    const report =
      original.event === 'manifest'
        ? { ...original, files: reportedFiles(original.files) }
        : original.event === 'file'
          ? { ...original, file: reportedFiles([original.file])[0] }
          : original;
    this.reports.set(key, {
      message: { type: 'audit', id: crypto.randomUUID(), report },
      attempts: 0,
      acked: false,
      sent: 0,
    });
    this.flush();
  }
  ack(id: string): void {
    for (const report of this.reports.values()) if (report.message.id === id) report.acked = true;
  }
  flush(): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 1024 * 1024)
      return;
    const now = Date.now();
    for (const report of this.reports.values()) {
      if (report.acked || report.attempts >= 8 || now - report.sent < 5000) continue;
      try {
        this.socket.send(JSON.stringify(report.message));
      } catch {
        return;
      }
      report.attempts++;
      report.sent = now;
    }
  }
}
