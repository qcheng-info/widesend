import { DurableObject } from 'cloudflare:workers';
import { BlockBuffer } from './block-buffer';
import { HealthStore } from './health-store';
import { RelayStore } from './relay-store';
import { readRelayBudget, type RelayBudget, type UsageSnapshot } from '../shared/relay';
import { HOUR, type BlockBucket, type BlockKind, type ProtectionHealth } from '../shared/health';
import {
  AbuseStore,
  readLimits,
  type Limits,
  type Participant,
  type Reservation,
  type Decision,
} from './abuse-store';

type GuardEnv = { ABUSE_LIMITS?: Partial<Limits>; RELAY_BUDGET?: Partial<RelayBudget> };
export class AbuseGuard extends DurableObject<GuardEnv> {
  private store: AbuseStore;
  private healthStore: HealthStore;
  private blockBuffer: BlockBuffer;
  private limits: Limits;
  private relayStore: RelayStore;
  constructor(ctx: DurableObjectState, env: GuardEnv) {
    super(ctx, env);
    this.limits = readLimits(env.ABUSE_LIMITS);
    this.store = new AbuseStore(ctx.storage.sql, this.limits);
    this.healthStore = new HealthStore(ctx.storage.sql);
    this.relayStore = new RelayStore(ctx.storage.sql, readRelayBudget(env.RELAY_BUDGET));
    this.blockBuffer = new BlockBuffer((batch) =>
      ctx.blockConcurrencyWhile(async () => {
        ctx.storage.transactionSync(() => this.healthStore.write(batch));
      }),
    );
  }
  private async run(work: () => Decision, kind: BlockKind): Promise<Decision> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const result = this.ctx.storage.transactionSync(work);
      if (!result.allowed) this.ctx.waitUntil(this.blockBuffer.add(kind));
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
      return result;
    });
  }
  async attempt(network: string, participant: Participant): Promise<Decision> {
    return this.run(() => this.store.attempt(network, participant, Date.now()), 'codes');
  }
  /** One dashboard sign-in attempt; refusals stay out of the public health counters. */
  async adminLogin(network: string): Promise<Decision> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const result = this.ctx.storage.transactionSync(() =>
        this.store.adminLogin(network, Date.now()),
      );
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
      return result;
    });
  }
  async reserve(reservation: Reservation): Promise<Decision> {
    return this.run(() => this.store.reserve(reservation, Date.now()), 'transfers');
  }
  async recordEdgeBlocks(batch: BlockBucket[]): Promise<void> {
    // Internal RPC only; edge isolates already coalesce requests for ten seconds.
    return this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => this.healthStore.write(batch));
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + HOUR);
    });
  }
  async health(): Promise<ProtectionHealth> {
    return this.ctx.blockConcurrencyWhile(async () => ({
      ...this.healthStore.read(this.limits, this.blockBuffer.snapshot()),
      relay: this.relayStore.read(),
    }));
  }
  async recordUsage(connection: string, snapshots: UsageSnapshot[]): Promise<void> {
    return this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => this.relayStore.record(connection, snapshots));
      if ((await this.ctx.storage.getAlarm()) === null)
        await this.ctx.storage.setAlarm(Date.now() + HOUR);
    });
  }
  async admitRelay(id: string, expires: number): Promise<Decision> {
    return this.ctx.blockConcurrencyWhile(async () =>
      this.ctx.storage.transactionSync(() => this.relayStore.admit(id, expires)),
    );
  }
  async release(room: string, role: string, connection: string): Promise<void> {
    this.store.release(room, role, connection);
  }
  async alarm(): Promise<void> {
    this.ctx.storage.transactionSync(() => this.store.prune(Date.now()));
    this.ctx.storage.transactionSync(() => this.healthStore.prune());
    this.ctx.storage.transactionSync(() => this.relayStore.prune());
    const any = this.ctx.storage.sql
      .exec<{ count: number }>(
        'SELECT (SELECT COUNT(*) FROM sessions)+(SELECT COUNT(*) FROM buckets)+(SELECT COUNT(*) FROM health_blocks)+(SELECT COUNT(*) FROM relay_days) AS count',
      )
      .one().count;
    if (any) await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
    // Keep the empty schema: deleteAll() would also remove the SQL tables while
    // this instance could still be serving subsequent admissions.
  }
}

export { networkAddress, networkKey } from './network';
export function limited(retryAfter: number, protocol = 'widesend'): Response {
  const seconds = Math.max(1, Math.min(86_400, Math.ceil(retryAfter)));
  // Browser WebSocket APIs hide HTTP 429 headers. A short-lived socket delivers
  // the same cooldown without starting a room or writing an activity record.
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].send(JSON.stringify({ type: 'limited', retryAfter: seconds }));
  pair[1].close(4013, 'Please wait before reconnecting');
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: { 'Sec-WebSocket-Protocol': protocol, 'Cache-Control': 'no-store' },
  });
}
