import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';

// The repository is published: its Wrangler file is a template anyone can deploy, and
// nothing tracked names a real account, database, Access team or person.
const root = new URL('../../', import.meta.url);
const template = parse(readFileSync(new URL('wrangler.jsonc', root), 'utf8'));
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && !/\.(png|ico|svg|woff2?)$|package-lock\.json$/.test(file));
const text = (file: string) => {
  try {
    return readFileSync(new URL(file, root), 'utf8');
  } catch {
    return ''; // Deleted in the working tree.
  }
};

// A checkout set up as an instance (npm run setup in place, e.g. a Deploy-button copy)
// has its own settings in wrangler.jsonc: the template checks apply to the repository as
// published, not to it. The privacy checks below always apply.
const instance =
  ['account_id', 'routes', 'd1_databases', 'vars'].some((key) => key in template) ||
  existsSync(new URL('wrangler.admin.jsonc', root));

describe.skipIf(instance)('the Wrangler template', () => {
  it('deploys to any account on workers.dev without an activity record', () => {
    expect(template.workers_dev).toBe(true);
    for (const key of ['account_id', 'routes', 'd1_databases', 'vars'])
      expect(template, key).not.toHaveProperty(key);
  });
  it('declares the Durable Objects, their migrations and rate limits', () => {
    expect(
      template.durable_objects.bindings.map((b: { class_name: string }) => b.class_name),
    ).toEqual(['TransferRoom', 'AbuseGuard', 'ShareRoom']);
    expect(template.migrations.map((m: { tag: string }) => m.tag)).toEqual(['v1', 'v2', 'v3']);
    expect(template.ratelimits.map((r: { namespace_id: string }) => r.namespace_id)).toEqual([
      '1001',
      '1002',
    ]);
  });
  it('is the only Wrangler file in the repository', () => {
    expect(tracked.filter((file) => /(^|\/)wrangler[^/]*\.jsonc?$/.test(file))).toEqual([
      'wrangler.jsonc',
    ]);
  });
});

describe('published files', () => {
  it('hold no e-mail address but examples', () => {
    for (const file of tracked)
      for (const [address] of text(file).matchAll(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi))
        expect(address, file).toMatch(/@example\.(com|org|test)$/);
  });
  it('hold no Cloudflare Access team but examples', () => {
    for (const file of tracked)
      for (const [team] of text(file).matchAll(/[a-z0-9-]+\.cloudflareaccess\.com/g))
        expect(team, file).toMatch(/^(your-team|test-team|team|TEAM)\./);
  });
});
