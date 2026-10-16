import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hosts, resolveAnswer } from '../../scripts/answers.mjs';
import { usedNamespaces } from '../../scripts/instances.mjs';
import { previewConfig } from '../../scripts/preview-config.mjs';
import { needsBuild } from '../../scripts/deploy.mjs';

const folders: string[] = [];
afterEach(async () => {
  for (const dir of folders.splice(0)) await rm(dir, { recursive: true, force: true });
});
const limits = (network: string, site: string) =>
  JSON.stringify({
    ratelimits: [
      { name: 'NETWORK_RATE', namespace_id: network, simple: { limit: 120, period: 60 } },
      { name: 'SITE_RATE', namespace_id: site, simple: { limit: 1200, period: 60 } },
    ],
  });

describe('setup answers', () => {
  it('keep the current value when blank, and clear it with a dash', () => {
    expect(resolveAnswer('', 'send.example.com')).toBe('send.example.com');
    expect(resolveAnswer('  new.example.com ', 'send.example.com')).toBe('new.example.com');
    expect(resolveAnswer('-', 'send.example.com')).toBe('');
    expect(resolveAnswer(' - ', 'send.example.com')).toBe('');
    expect(hosts(resolveAnswer('-', 'send.example.com'))).toEqual([]);
    expect(hosts('https://Send.Example.com/, b.example.com')).toEqual([
      'send.example.com',
      'b.example.com',
    ]);
  });
});

describe('rate-limit namespaces in use', () => {
  it('count the checkout itself as well as the other instance folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'widesend-root-'));
    folders.push(root);
    await writeFile(join(root, 'wrangler.jsonc'), limits('1001', '1002'));
    for (const [name, a, b] of [
      ['team', '2001', '2002'],
      ['new', '3001', '3002'],
    ]) {
      await mkdir(join(root, 'instances', name), { recursive: true });
      await writeFile(join(root, 'instances', name, 'wrangler.jsonc'), limits(a, b));
    }
    expect((await usedNamespaces('instances/new', root)).sort()).toEqual([
      '1001',
      '1002',
      '2001',
      '2002',
    ]);
    expect((await usedNamespaces('.', root)).sort()).toEqual(['2001', '2002', '3001', '3002']);
  });
});

describe('the local test preview', () => {
  it('starts from the template even in a checkout set up as an instance', () => {
    const config = previewConfig(
      {
        name: 'team-send',
        account_id: '0123456789abcdef0123456789abcdef',
        main: 'worker/index.ts',
        assets: { directory: './dist', binding: 'ASSETS' },
        workers_dev: false,
        routes: [{ pattern: 'send.example.com', custom_domain: true }],
        d1_databases: [{ binding: 'ACTIVITY', database_name: 'x', database_id: 'y' }],
        vars: { RECORD_FILE_NAMES: false, PUBLIC_INSTANCE: true },
        ratelimits: [
          { name: 'NETWORK_RATE', namespace_id: '2001', simple: { limit: 120, period: 60 } },
        ],
        triggers: { crons: ['17 * * * *'] },
        observability: { enabled: true },
      },
      '/repo/',
    );
    // observability: Miniflare would keep every test run's traces, hundreds of MB.
    for (const key of ['account_id', 'routes', 'd1_databases', 'triggers', 'observability'])
      expect(config, key).not.toHaveProperty(key);
    expect(config.name).toBe('widesend-e2e');
    expect(config.vars).toMatchObject({ SITE: 'http://localhost:8788' });
    expect(config.vars).not.toHaveProperty('PUBLIC_INSTANCE');
    expect(config.ratelimits[0].simple.limit).toBe(100_000);
  });
});

describe('npm run deploy in Workers Builds', () => {
  it('uses the build step’s output instead of building again', () => {
    expect(needsBuild({}, true)).toBe(true);
    expect(needsBuild({ WORKERS_CI: '1' }, true)).toBe(false);
    expect(needsBuild({ WORKERS_CI: '1' }, false)).toBe(true);
  });
});
