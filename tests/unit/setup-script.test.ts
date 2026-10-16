import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readdir, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { parse } from 'jsonc-parser';

// npm run setup without deploying: writes an instance's files and nothing else, so it
// never reaches Cloudflare (an invalid token makes sure of it even if it tried). It
// runs here without a Cloudflare account. Instance folders are git-ignored.
const run = promisify(execFile);
const root = new URL('../../', import.meta.url);
const folders: string[] = [];
afterEach(async () => {
  for (const dir of folders.splice(0))
    await rm(new URL(dir, root), { recursive: true, force: true });
});
async function setup(...args: string[]) {
  const dir = `instances/test-${Math.random().toString(36).slice(2, 8)}`;
  folders.push(dir);
  const { stdout } = await run(
    process.execPath,
    ['scripts/setup.mjs', '--dir', dir, '--yes', '--no-deploy', ...args],
    { cwd: root, env: { ...process.env, CLOUDFLARE_API_TOKEN: 'invalid-token-for-tests' } },
  );
  const read = async (name: string) => {
    try {
      return parse(await readFile(new URL(`${dir}/${name}`, root), 'utf8'));
    } catch {
      return null;
    }
  };
  return {
    dir,
    stdout,
    site: await read('wrangler.jsonc'),
    admin: await read('wrangler.admin.jsonc'),
  };
}
async function otherNamespaces(except: string) {
  const used: string[] = [];
  for (const name of await readdir(new URL('instances/', root)).catch(() => [])) {
    if (`instances/${name}` === except) continue;
    const text = await readFile(new URL(`instances/${name}/wrangler.jsonc`, root), 'utf8').catch(
      () => '',
    );
    for (const limit of parse(text)?.ratelimits ?? []) used.push(limit.namespace_id);
  }
  return used;
}

describe('npm run setup', () => {
  it('writes an instance on a custom domain without the dashboard', async () => {
    const { dir, site, admin, stdout } = await setup(
      '--name',
      'team-send',
      '--domain',
      'Send.Example.com/',
    );
    expect(site).toMatchObject({
      name: 'team-send',
      main: '../../worker/index.ts',
      workers_dev: false,
      routes: [{ pattern: 'send.example.com', custom_domain: true }],
    });
    expect(site.d1_databases).toBeUndefined();
    expect(admin).toBeNull();
    const ids = site.ratelimits.map((limit: { namespace_id: string }) => limit.namespace_id);
    for (const id of ids) expect(await otherNamespaces(dir)).not.toContain(id);
    expect(stdout).toContain('npm run deploy -- --dir');
  });
  it('writes the dashboard with a given database, and keeps the password out of files', async () => {
    const { site, admin, stdout, dir } = await setup(
      '--name',
      'team-send',
      '--admin',
      '--database-id',
      '00000000-0000-4000-8000-000000000000',
      '--password',
      'a long enough password',
      '--no-file-names',
    );
    expect(site.workers_dev).toBe(true);
    expect(site.vars).toEqual({ RECORD_FILE_NAMES: false });
    expect(site.d1_databases[0]).toMatchObject({
      database_name: 'team-send-activity',
      database_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(admin).toMatchObject({ name: 'team-send-admin', workers_dev: true });
    const files = await readdir(new URL(`${dir}/`, root));
    for (const file of files)
      expect(await readFile(new URL(`${dir}/${file}`, root), 'utf8')).not.toContain(
        'a long enough password',
      );
    expect(stdout).toContain('wrangler secret put ADMIN_PASSWORD');
  });
  it('only writes files with --no-deploy, asking for the database it would have looked up', async () => {
    await expect(setup('--name', 'team-send', '--admin')).rejects.toThrow(/--database-id/);
  });
  it('says the kept database is no longer cleaned up when the dashboard goes', async () => {
    const first = await setup(
      '--name',
      'team-send',
      '--admin',
      '--database-id',
      '00000000-0000-4000-8000-000000000000',
    );
    const { stdout } = await run(
      process.execPath,
      ['scripts/setup.mjs', '--dir', first.dir, '--yes', '--no-deploy', '--no-admin'],
      { cwd: root, env: { ...process.env, CLOUDFLARE_API_TOKEN: 'invalid-token-for-tests' } },
    );
    expect(stdout).toMatch(/no longer/);
    expect(stdout).toContain('npx wrangler d1 delete team-send-activity');
  });
  it('refuses a short password and a malformed name', async () => {
    await expect(setup('--admin', '--database-id', 'x', '--password', 'short')).rejects.toThrow(
      /12 characters/,
    );
    await expect(setup('--name', 'Not Valid')).rejects.toThrow(/lowercase/);
  });
});
