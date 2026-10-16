// Self-hosted defaults: a team behind one office address can work all day. Sites open
// to everyone set stricter ABUSE_LIMITS (docs/configuration.md).
export const DEFAULT_LIMITS = {
  attemptsPerMinute: 60,
  attemptsPerHour: 1000,
  createsPerHour: 200,
  createsPerDay: 1000,
  createsGlobalPerDay: 2000,
  concurrentPerNetwork: 20,
  concurrentGlobal: 50,
  // Share rooms can stay open for a day, so they have their own slots and never
  // take the ones one-to-one transfers need.
  roomsPerNetwork: 10,
  roomsGlobal: 50,
};
export type Limits = typeof DEFAULT_LIMITS;
// Dashboard password guesses, per network only: a shared ceiling would let anyone with a
// few networks lock the owner out. A 12-character password outlasts many networks' guesses.
export const ADMIN_LOGIN = { perWindow: 10, window: 15 * 60_000, perDay: 100 };
export type Decision = { allowed: true } | { allowed: false; retryAfter: number };
export type Participant = {
  room: string;
  // 'send' or 'receive' for one-to-one transfers; the member ID in share rooms.
  role: string;
  credential: string;
};
export type Reservation = Participant & {
  owner: string;
  network: string;
  connection: string;
  expires: number;
  newSession: boolean;
};
export const LEASE_MS = 15 * 60_000;
export const RENEW_MS = 5 * 60_000;

export function readLimits(value?: Partial<Limits>): Limits {
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const [key, number] of Object.entries(limits)) {
    if (
      !(key in DEFAULT_LIMITS) ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > 1_000_000
    )
      throw new Error('Invalid abuse limit configuration.');
  }
  return limits;
}

// Synchronous SQL operations run together inside a storage transaction. Counters
// and reservations survive deployments; no file contents pass through this store.
export class AbuseStore {
  constructor(
    private sql: SqlStorage,
    private limits: Limits,
  ) {
    sql.exec(
      'CREATE TABLE IF NOT EXISTS buckets (key TEXT PRIMARY KEY, used INTEGER NOT NULL, resets INTEGER NOT NULL)',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS bucket_expiry ON buckets(resets)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS sessions (room TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS participants (room TEXT NOT NULL, role TEXT NOT NULL, credential TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(room,role))',
    );
    sql.exec(
      'CREATE TABLE IF NOT EXISTS leases (room TEXT NOT NULL, role TEXT NOT NULL, network TEXT NOT NULL, connection TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(room,role))',
    );
    sql.exec('CREATE INDEX IF NOT EXISTS lease_network ON leases(network,expires)');
  }
  private row<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...args: SqlStorageValue[]
  ): T | undefined {
    return this.sql.exec<T>(query, ...args).toArray()[0];
  }
  private counters(specs: [string, number, number][], now: number): Decision {
    const values = specs.map(([key, limit, period]) => {
      const prior = this.row<{ used: number; resets: number }>(
        'SELECT used,resets FROM buckets WHERE key=?',
        key,
      );
      return {
        key,
        limit,
        used: prior && prior.resets > now ? prior.used : 0,
        resets: prior && prior.resets > now ? prior.resets : now + period,
      };
    });
    const retryAfter = Math.max(
      0,
      ...values.filter((v) => v.used >= v.limit).map((v) => Math.ceil((v.resets - now) / 1000)),
    );
    if (retryAfter) return { allowed: false, retryAfter };
    for (const value of values)
      this.sql.exec(
        'INSERT INTO buckets VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET used=excluded.used,resets=excluded.resets',
        value.key,
        value.used + 1,
        value.resets,
      );
    return { allowed: true };
  }
  attempt(network: string, participant: Participant, now: number): Decision {
    // Only a credential previously admitted by its room gets the recovery exemption,
    // whatever its role: a receiver learns its slot (receive:2) only once admitted.
    const known = this.row(
      'SELECT 1 AS found FROM participants WHERE room=? AND credential=? AND expires>?',
      participant.room,
      participant.credential,
      now,
    );
    if (known) return { allowed: true };
    return this.counters(
      [
        [`attempt-minute:${network}`, this.limits.attemptsPerMinute, 60_000],
        [`attempt-hour:${network}`, this.limits.attemptsPerHour, 3_600_000],
      ],
      now,
    );
  }
  adminLogin(network: string, now: number): Decision {
    return this.counters(
      [
        [`admin-login:${network}`, ADMIN_LOGIN.perWindow, ADMIN_LOGIN.window],
        [`admin-login-day:${network}`, ADMIN_LOGIN.perDay, 86_400_000],
      ],
      now,
    );
  }
  reserve(r: Reservation, now: number): Decision {
    if (r.expires <= now) return { allowed: false, retryAfter: 60 };
    const session = this.row<{ owner: string; expires: number }>(
      'SELECT owner,expires FROM sessions WHERE room=? AND expires>?',
      r.room,
      now,
    );
    const participant = this.row<{ credential: string }>(
      'SELECT credential FROM participants WHERE room=? AND role=? AND expires>?',
      r.room,
      r.role,
      now,
    );
    if (
      (session && session.owner !== r.owner) ||
      (participant && participant.credential !== r.credential)
    )
      return { allowed: false, retryAfter: 60 };
    const shared = r.room.startsWith('share:');
    const kind = shared ? "room LIKE 'share:%'" : "room NOT LIKE 'share:%'";
    const networkRooms = this.row<{ count: number }>(
      `SELECT COUNT(DISTINCT room) AS count FROM leases WHERE network=? AND expires>? AND room<>? AND ${kind}`,
      r.network,
      now,
      r.room,
    )!.count;
    const allRooms = this.row<{ count: number }>(
      `SELECT COUNT(DISTINCT room) AS count FROM leases WHERE expires>? AND room<>? AND ${kind}`,
      now,
      r.room,
    )!.count;
    if (
      networkRooms >= (shared ? this.limits.roomsPerNetwork : this.limits.concurrentPerNetwork) ||
      allRooms >= (shared ? this.limits.roomsGlobal : this.limits.concurrentGlobal)
    )
      return { allowed: false, retryAfter: 30 };
    if (!session && r.newSession) {
      const decision = this.counters(
        [
          [`create-hour:${r.network}`, this.limits.createsPerHour, 3_600_000],
          [`create-day:${r.network}`, this.limits.createsPerDay, 86_400_000],
          ['create-global-day', this.limits.createsGlobalPerDay, 86_400_000],
        ],
        now,
      );
      if (!decision.allowed) return decision;
    }
    const expires = session?.expires ?? r.expires;
    this.sql.exec(
      'INSERT INTO sessions VALUES (?,?,?) ON CONFLICT(room) DO UPDATE SET owner=excluded.owner,expires=excluded.expires',
      r.room,
      r.owner,
      expires,
    );
    this.sql.exec(
      'INSERT INTO participants VALUES (?,?,?,?) ON CONFLICT(room,role) DO UPDATE SET credential=excluded.credential,expires=excluded.expires',
      r.room,
      r.role,
      r.credential,
      expires,
    );
    this.sql.exec(
      'INSERT INTO leases VALUES (?,?,?,?,?) ON CONFLICT(room,role) DO UPDATE SET network=excluded.network,connection=excluded.connection,expires=excluded.expires',
      r.room,
      r.role,
      r.network,
      r.connection,
      Math.min(expires, now + LEASE_MS),
    );
    return { allowed: true };
  }
  release(room: string, role: string, connection: string): void {
    // A late close from a replaced socket must not release its replacement.
    this.sql.exec(
      'DELETE FROM leases WHERE room=? AND role=? AND connection=?',
      room,
      role,
      connection,
    );
  }
  prune(now: number): void {
    this.sql.exec('DELETE FROM buckets WHERE resets<=?', now);
    this.sql.exec('DELETE FROM leases WHERE expires<=?', now);
    this.sql.exec('DELETE FROM participants WHERE expires<=?', now);
    this.sql.exec('DELETE FROM sessions WHERE expires<=?', now);
  }
}
