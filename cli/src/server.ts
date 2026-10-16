import { KEY_EXCHANGE } from '../../shared/key-exchange';
import { loadSite } from '../../src/site';

export const UPDATE =
  'This server needs a newer widesend. Update with: npm install -g widesend@latest (or run npx widesend@latest).';

/**
 * Learns the server's site name before anything pairs: keys and links use it, so
 * the command line pairs with browsers on the site even through an API-only host.
 * A server without /api/health is used as before, under its own address; one that
 * doesn't answer stops the command here rather than failing later as a key mismatch.
 */
export async function prepareServer(
  server: URL,
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  retry: Parameters<typeof loadSite>[2] = { timeout: 8000 },
): Promise<void> {
  const answer = await loadSite(fetcher, server.origin, retry);
  if (answer.status === 'unreachable')
    throw new Error(`Could not reach ${server.host}. Check the connection and try again.`);
  const protocol = answer.status === 'ok' ? answer.health.protocol : undefined;
  if (typeof protocol === 'number' && protocol > KEY_EXCHANGE) throw new Error(UPDATE);
}
