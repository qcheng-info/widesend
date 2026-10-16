import { DAY, HOUR, type BlockBucket, type ProtectionHealth } from '../shared/health';
import { RETENTION_MS } from '../shared/audit';
import type { Limits } from './abuse-store';

export class HealthStore {
  constructor(
    private sql: SqlStorage,
    now = Date.now(),
  ) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS health_blocks (hour INTEGER PRIMARY KEY, burst INTEGER NOT NULL, codes INTEGER NOT NULL, transfers INTEGER NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS health_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    );
    sql.exec("INSERT OR IGNORE INTO health_meta VALUES ('since', ?)", now);
  }
  write(batch: BlockBucket[], now = Date.now()): void {
    if (batch.length > 2) throw new Error('Invalid health batch');
    for (const b of batch) {
      if (
        !Number.isSafeInteger(b.hour) ||
        b.hour % HOUR ||
        b.hour < now - DAY ||
        b.hour > now ||
        ![b.burst, b.codes, b.transfers].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error('Invalid health bucket');
      this.sql.exec(
        'INSERT INTO health_blocks VALUES (?,?,?,?) ON CONFLICT(hour) DO UPDATE SET burst=burst+excluded.burst,codes=codes+excluded.codes,transfers=transfers+excluded.transfers',
        b.hour,
        b.burst,
        b.codes,
        b.transfers,
      );
    }
  }
  read(limits: Limits, pending: BlockBucket[] = [], now = Date.now()): ProtectionHealth {
    const from = Math.floor(now / DAY) * DAY - 6 * DAY;
    const blocks = this.sql
      .exec<BlockBucket>(
        'SELECT * FROM health_blocks WHERE hour>=? AND hour<=? ORDER BY hour',
        from,
        now,
      )
      .toArray();
    for (const bucket of pending) {
      if (bucket.hour < from || bucket.hour > now) continue;
      const target = blocks.find((b) => b.hour === bucket.hour);
      if (target)
        for (const key of ['burst', 'codes', 'transfers'] as const) target[key] += bucket[key];
      else blocks.push({ ...bucket });
    }
    const reserved = this.sql
      .exec<{ rooms: number; connections: number }>(
        'SELECT COUNT(DISTINCT room) AS rooms, COUNT(*) AS connections FROM leases WHERE expires>?',
        now,
      )
      .one();
    return {
      observedAt: now,
      recordingSince: this.sql
        .exec<{ value: number }>("SELECT value FROM health_meta WHERE key='since'")
        .one().value,
      reservedTransfers: reserved.rooms,
      reservedConnections: reserved.connections,
      transferLimit: limits.concurrentGlobal,
      networkLimit: limits.concurrentPerNetwork,
      blocks: blocks.sort((a, b) => a.hour - b.hour),
    };
  }
  prune(now = Date.now()): void {
    this.sql.exec(
      'DELETE FROM health_blocks WHERE hour<?',
      Math.floor((now - RETENTION_MS) / HOUR) * HOUR,
    );
  }
}
