// The admin dashboard for browser tests, on https://localhost:8789 with password sign-in
// (tests/e2e/admin-sign-in.spec.ts). A public Worker runs alongside it in the same
// session to provide the AbuseGuard the dashboard counts sign-in attempts with.
// Local only: separate state under .wrangler/e2e-admin, a fixed test password. HTTPS,
// because WebKit keeps no Secure cookie, like the session, from http://localhost.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { run, local } from './run.mjs';

export const TEST_PASSWORD = 'local test password';
const root = new URL('../', import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const folder = path('.wrangler/e2e-admin');
const database = {
  binding: 'ACTIVITY',
  database_name: 'widesend-e2e-activity',
  database_id: '00000000-0000-4000-8000-000000000000',
  migrations_dir: path('migrations'),
};
const site = parse(await readFile(new URL('wrangler.jsonc', root), 'utf8'));
site.name = 'widesend-e2e-guard';
site.main = path(site.main);
site.assets.directory = path('dist');
site.d1_databases = [database];
delete site.$schema;
delete site.observability;
delete site.triggers;
const admin = {
  name: 'widesend-e2e-admin',
  main: path('admin/index.ts'),
  compatibility_date: site.compatibility_date,
  assets: { directory: path('admin/public'), binding: 'ASSETS', run_worker_first: true },
  d1_databases: [database],
  durable_objects: {
    bindings: [{ name: 'GUARD', class_name: 'AbuseGuard', script_name: site.name }],
  },
  vars: { ADMIN_PASSWORD: TEST_PASSWORD },
};
// Fresh state each start: sign-in attempts are limited per network, and tests make several.
await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
await writeFile(`${folder}/site.jsonc`, JSON.stringify(site, null, 2));
await writeFile(`${folder}/admin.jsonc`, JSON.stringify(admin, null, 2));
const state = ['--persist-to', `${folder}/state`];
await run(local('wrangler'), [
  'd1',
  'migrations',
  'apply',
  'ACTIVITY',
  '--local',
  '--config',
  `${folder}/admin.jsonc`,
  ...state,
]);
// The first configuration is served on the port; the second runs beside it.
await run(local('wrangler'), [
  'dev',
  '--config',
  `${folder}/admin.jsonc`,
  '--config',
  `${folder}/site.jsonc`,
  '--port',
  '8789',
  '--local-protocol',
  'https',
  ...state,
]);
