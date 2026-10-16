// The local Worker for browser tests (npm run preview:test), made from the repository's
// wrangler.jsonc. A checkout set up as an instance has routes, a database, an account and
// settings of its own there; the test Worker keeps none of them.
import { fileURLToPath } from 'node:url';

// Every limit in worker/abuse-store.ts DEFAULT_LIMITS, raised far out of the way.
const LIMITS = [
  'attemptsPerMinute',
  'attemptsPerHour',
  'createsPerHour',
  'createsPerDay',
  'createsGlobalPerDay',
  'concurrentPerNetwork',
  'concurrentGlobal',
  'roomsPerNetwork',
  'roomsGlobal',
];

/** `root`: the repository's file URL, for absolute paths in the generated file. */
export function previewConfig(template, root) {
  const config = structuredClone(template);
  config.name = 'widesend-e2e';
  config.main = fileURLToPath(new URL(config.main, new URL(root, 'file:///')));
  config.assets.directory = fileURLToPath(new URL('dist', new URL(root, 'file:///')));
  // No observability: Miniflare would keep every run's traces locally, hundreds of MB.
  for (const key of [
    '$schema',
    'account_id',
    'routes',
    'd1_databases',
    'triggers',
    'observability',
  ])
    delete config[key];
  config.workers_dev = true;
  config.vars = {
    ABUSE_LIMITS: Object.fromEntries(LIMITS.map((key) => [key, 100_000])),
    // One deployment answering on localhost and 127.0.0.1, like a site with several
    // addresses: the local site name makes both pair (tests/e2e/addresses.spec.ts).
    SITE: 'http://localhost:8788',
  };
  for (const binding of config.ratelimits ?? []) binding.simple.limit = 100_000;
  return config;
}
