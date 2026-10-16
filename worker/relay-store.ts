import { DAY } from '../shared/health';
import { RETENTION_MS } from '../shared/audit';
import {
  utcDay,
  type RelayBudget,
  type RelayDay,
  type RelayHealth,
  type UsageSnapshot,
} from '../shared/relay';
import type { Decision } from './abuse-store';

// Internal RPC receives cumulative, server-observed counters. Replays and
// out-of-order flushes cannot charge a message twice. No per-frame SQL writes.
export class RelayStore {
  constructor(
    private sql: SqlStorage,
    private budget: RelayBudget,
    now = Date.now(),
  ) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS relay_days (day INTEGER PRIMARY KEY, messages INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, admitted INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS relay_reports (connection TEXT NOT NULL, day INTEGER NOT NULL, messages INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(connection,day))',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS relay_reports_day ON relay_reports(day)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS relay_admissions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS relay_denials (id TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY(id,day))',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    );
    sql.exec("INSERT OR IGNORE INTO relay_meta VALUES ('since', ?)", now);
  }
  private ensureDay(day: number, now: number): void {
    this.sql.exec('INSERT OR IGNORE INTO relay_days(day,updatedAt) VALUES (?,?)', day, now);
  }
  record(connection: string, snapshots: UsageSnapshot[], now = Date.now()): void {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(connection) || snapshots.length > 2)
      throw new Error('Invalid usage report');
    for (const s of snapshots) {
      if (
        !Number.isSafeInteger(s.day) ||
        s.day % DAY ||
        s.day < utcDay(now) - DAY ||
        s.day > now ||
        ![s.messages, s.bytes].every((n) => Number.isSafeInteger(n) && n >= 0)
      )
        throw new Error('Invalid usage report');
      const prior = this.sql
        .exec<UsageSnapshot>(
          'SELECT day,messages,bytes FROM relay_reports WHERE connection=? AND day=?',
          connection,
          s.day,
        )
        .toArray()[0];
      const messages = Math.max(prior?.messages ?? 0, s.messages),
        bytes = Math.max(prior?.bytes ?? 0, s.bytes);
      const dm = messages - (prior?.messages ?? 0),
        db = bytes - (prior?.bytes ?? 0);
      if (!dm && !db) continue;
      this.ensureDay(s.day, now);
      this.sql.exec(
        'UPDATE relay_days SET messages=messages+?,bytes=bytes+?,updatedAt=MAX(updatedAt,?) WHERE day=?',
        dm,
        db,
        now,
        s.day,
      );
      this.sql.exec(
        'INSERT INTO relay_reports VALUES (?,?,?,?) ON CONFLICT(connection,day) DO UPDATE SET messages=excluded.messages,bytes=excluded.bytes',
        connection,
        s.day,
        messages,
        bytes,
      );
    }
  }
  admit(id: string, expires: number, now = Date.now()): Decision {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      !Number.isSafeInteger(expires) ||
      expires <= now ||
      expires > now + DAY
    )
      throw new Error('Invalid relay admission');
    const previous = this.sql
      .exec<{ expires: number }>('SELECT expires FROM relay_admissions WHERE id=?', id)
      .toArray()[0];
    // An admitted transfer keeps its relay access through reconnects and UTC
    // rollover, until its original session deadline. This is an admission
    // threshold, not a hard traffic cap on an in-progress file.
    if (previous && previous.expires > now) return { allowed: true };
    const day = utcDay(now);
    this.ensureDay(day, now);
    const messages = this.sql
      .exec<{ messages: number }>('SELECT messages FROM relay_days WHERE day=?', day)
      .one().messages;
    if (messages >= (this.budget.dailyRequestUnits * 20 * this.budget.stopNewAtPercent) / 100) {
      const seen = this.sql
        .exec('SELECT 1 FROM relay_denials WHERE id=? AND day=?', id, day)
        .toArray().length;
      if (!seen) {
        this.sql.exec('INSERT INTO relay_denials VALUES (?,?)', id, day);
        this.sql.exec('UPDATE relay_days SET denied=denied+1,updatedAt=? WHERE day=?', now, day);
      }
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((day + DAY - now) / 1000)) };
    }
    this.sql.exec(
      'INSERT INTO relay_admissions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires',
      id,
      expires,
    );
    this.sql.exec('UPDATE relay_days SET admitted=admitted+1,updatedAt=? WHERE day=?', now, day);
    return { allowed: true };
  }
  read(now = Date.now()): RelayHealth {
    const today = utcDay(now);
    const rows = this.sql
      .exec<RelayDay>(
        'SELECT * FROM relay_days WHERE day>=? AND day<=? ORDER BY day',
        today - 6 * DAY,
        today,
      )
      .toArray();
    const daily = Array.from(
      { length: 7 },
      (_, i) =>
        rows.find((r) => r.day === today - (6 - i) * DAY) ?? {
          day: today - (6 - i) * DAY,
          messages: 0,
          bytes: 0,
          admitted: 0,
          denied: 0,
          updatedAt: 0,
        },
    );
    return {
      observedAt: now,
      recordingSince: this.sql
        .exec<{ value: number }>("SELECT value FROM relay_meta WHERE key='since'")
        .one().value,
      budget: this.budget,
      acceptingNew:
        daily[6].messages <
        (this.budget.dailyRequestUnits * 20 * this.budget.stopNewAtPercent) / 100,
      resetAt: today + DAY,
      daily,
    };
  }
  prune(now = Date.now()): void {
    this.sql.exec('DELETE FROM relay_reports WHERE day<?', utcDay(now) - DAY);
    this.sql.exec('DELETE FROM relay_admissions WHERE expires<=?', now);
    this.sql.exec('DELETE FROM relay_denials WHERE day<?', utcDay(now));
    this.sql.exec('DELETE FROM relay_days WHERE day<?', utcDay(now - RETENTION_MS));
  }
}
