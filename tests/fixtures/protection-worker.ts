import { DurableObject } from 'cloudflare:workers';
import { AbuseStore, readLimits } from '../../worker/abuse-store';
import { networkAddress } from '../../worker/protection';
import { HealthStore } from '../../worker/health-store';
import { RelayStore } from '../../worker/relay-store';
import { readRelayBudget } from '../../shared/relay';

// Fake time and introspection exist only in this local test fixture.
export class StoreFixture extends DurableObject<any> {
  store = new AbuseStore(this.ctx.storage.sql, readLimits(this.env.ABUSE_LIMITS));
  async fetch(request: Request) {
    const { action, now, ...input } = await request.json<any>();
    return this.ctx.blockConcurrencyWhile(async () => {
      const result = this.ctx.storage.transactionSync(() => {
        switch (action) {
          case 'relay-record':
            new RelayStore(this.ctx.storage.sql, readRelayBudget(input.budget), now).record(
              input.connection,
              input.snapshots,
              now,
            );
            return null;
          case 'relay-admit':
            return new RelayStore(this.ctx.storage.sql, readRelayBudget(input.budget), now).admit(
              input.id,
              input.expires,
              now,
            );
          case 'relay-health':
            return new RelayStore(this.ctx.storage.sql, readRelayBudget(input.budget), now).read(
              now,
            );
          case 'relay-prune':
            new RelayStore(this.ctx.storage.sql, readRelayBudget(input.budget), now).prune(now);
            return null;
          case 'attempt':
            return this.store.attempt(input.network, input.participant, now);
          case 'admin-login':
            return this.store.adminLogin(input.network, now);
          case 'reserve':
            return this.store.reserve(input.reservation, now);
          case 'release':
            this.store.release(input.room, input.role, input.connection);
            return null;
          case 'prune':
            this.store.prune(now);
            return null;
          case 'inspect':
            return Object.fromEntries(
              ['sessions', 'participants', 'buckets', 'leases'].map((table) => [
                table,
                this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
              ]),
            );
          case 'network':
            return networkAddress(input.ip);
          case 'health-write':
            new HealthStore(this.ctx.storage.sql, now).write(input.batch, now);
            return null;
          case 'health-prune':
            new HealthStore(this.ctx.storage.sql, now).prune(now);
            return null;
          case 'health':
            return new HealthStore(this.ctx.storage.sql, now).read(
              readLimits(this.env.ABUSE_LIMITS),
              [],
              now,
            );
        }
      });
      return Response.json(result);
    });
  }
}
export default {
  fetch(request: Request, env: any) {
    return env.STORE.get(env.STORE.idFromName(new URL(request.url).pathname)).fetch(request);
  },
};
