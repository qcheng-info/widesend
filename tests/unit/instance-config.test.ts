import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import {
  instancePrefix,
  nextNamespaces,
  readOptions,
  renderInstance,
  signInDefault,
  validateOptions,
} from '../../scripts/instance-config.mjs';

// A template like the repository's wrangler.jsonc, with a comment of its own.
const template = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  // Your copy's notes stay where they are.
  "name": "widesend",
  "main": "worker/index.ts",
  "compatibility_date": "2026-09-01",
  "workers_dev": true,
  "preview_urls": false,
  "assets": {
    "directory": "./dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "ratelimits": [
    { "name": "NETWORK_RATE", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } },
    { "name": "SITE_RATE", "namespace_id": "1002", "simple": { "limit": 1200, "period": 60 } }
  ],
  "triggers": { "crons": ["17 * * * *"] }
}
`;
const base = {
  name: 'widesend',
  domains: [] as string[],
  apiHosts: [] as string[],
  namespaces: ['1001', '1002'] as [string, string],
  admin: null,
};
const database = { name: 'widesend-activity', id: '00000000-0000-4000-8000-000000000000' };
const dashboard = { domains: [], auth: 'password' as const, fileNames: true, database };

describe('instance files', () => {
  it('leave the template as it is for the default answers', () => {
    const { publicText, adminText } = renderInstance(template, base, '.');
    expect(parse(publicText)).toEqual(parse(template));
    expect(publicText).toContain('// Your copy');
    expect(adminText).toBeNull();
  });
  it('serve a custom domain instead of workers.dev', () => {
    const config = parse(
      renderInstance(template, { ...base, domains: ['send.example.com'] }, '.').publicText,
    );
    expect(config.routes).toEqual([{ pattern: 'send.example.com', custom_domain: true }]);
    expect(config.workers_dev).toBe(false);
    expect(config.vars).toBeUndefined();
  });
  it('name the site when the command line has a host of its own', () => {
    const config = parse(
      renderInstance(
        template,
        { ...base, domains: ['send.example.com'], apiHosts: ['cli.example.com'] },
        '.',
      ).publicText,
    );
    expect(config.routes.map((r: { pattern: string }) => r.pattern)).toEqual([
      'send.example.com',
      'cli.example.com',
    ]);
    expect(config.vars).toEqual({
      SITE: 'https://send.example.com',
      API_HOSTS: ['cli.example.com'],
    });
  });
  it('add the dashboard with its database to both Workers', () => {
    const { publicText, adminText } = renderInstance(
      template,
      { ...base, admin: { ...dashboard, fileNames: false } },
      '.',
    );
    const site = parse(publicText);
    const admin = parse(adminText!);
    const binding = {
      binding: 'ACTIVITY',
      database_name: 'widesend-activity',
      database_id: database.id,
      migrations_dir: 'migrations',
    };
    expect(site.d1_databases).toEqual([binding]);
    expect(site.vars).toEqual({ RECORD_FILE_NAMES: false });
    expect(admin).toMatchObject({
      name: 'widesend-admin',
      main: 'admin/index.ts',
      compatibility_date: '2026-09-01',
      workers_dev: true,
      assets: { directory: 'admin/public', binding: 'ASSETS', run_worker_first: true },
      d1_databases: [binding],
      durable_objects: {
        bindings: [{ name: 'GUARD', class_name: 'AbuseGuard', script_name: 'widesend' }],
      },
    });
    expect(admin.vars).toBeUndefined();
  });
  it('remove the database and file-name setting when the dashboard goes', () => {
    const withAdmin = renderInstance(
      template,
      { ...base, admin: { ...dashboard, fileNames: false } },
      '.',
    ).publicText;
    const { publicText, adminText } = renderInstance(withAdmin, base, '.');
    expect(parse(publicText).d1_databases).toBeUndefined();
    expect(parse(publicText).vars).toBeUndefined();
    expect(adminText).toBeNull();
  });
  it('keep settings they do not manage', () => {
    const edited = template.replace(
      '"triggers"',
      '"vars": { "PUBLIC_INSTANCE": true, "SOURCE_URL": "https://example.com/src" },\n  "triggers"',
    );
    const config = parse(
      renderInstance(edited, { ...base, domains: ['send.example.com'] }, '.').publicText,
    );
    expect(config.vars).toEqual({ PUBLIC_INSTANCE: true, SOURCE_URL: 'https://example.com/src' });
  });
  it('point back to the code from an instance folder', () => {
    const { publicText, adminText } = renderInstance(
      template,
      { ...base, accountId: '0123456789abcdef0123456789abcdef', admin: dashboard },
      'instances/team',
    );
    const site = parse(publicText);
    expect(site).toMatchObject({
      $schema: '../../node_modules/wrangler/config-schema.json',
      main: '../../worker/index.ts',
      account_id: '0123456789abcdef0123456789abcdef',
      assets: { directory: '../../dist' },
    });
    expect(site.d1_databases[0].migrations_dir).toBe('../../migrations');
    expect(parse(adminText!)).toMatchObject({
      main: '../../admin/index.ts',
      assets: { directory: '../../admin/public' },
      account_id: '0123456789abcdef0123456789abcdef',
    });
    // Rendering again does not stack the prefix.
    expect(parse(renderInstance(publicText, base, 'instances/team').publicText).main).toBe(
      '../../worker/index.ts',
    );
  });
  it('write Access settings only when given as values', () => {
    const access = { team: 'team.cloudflareaccess.com', aud: 'aud', emails: 'me@example.com' };
    const admin = parse(
      renderInstance(
        template,
        {
          ...base,
          admin: { ...dashboard, auth: 'access', access, domains: ['admin.example.com'] },
        },
        '.',
      ).adminText!,
    );
    expect(admin.vars).toEqual({
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'aud',
      ADMIN_EMAILS: 'me@example.com',
    });
    expect(admin.routes).toEqual([{ pattern: 'admin.example.com', custom_domain: true }]);
    expect(admin.workers_dev).toBe(false);
  });
  it('use their own rate-limit counters', () => {
    const config = parse(
      renderInstance(template, { ...base, namespaces: ['2001', '2002'] }, '.').publicText,
    );
    expect(config.ratelimits.map((r: { namespace_id: string }) => r.namespace_id)).toEqual([
      '2001',
      '2002',
    ]);
  });
});

describe('setup answers', () => {
  it('read back from the files they made', () => {
    const options = {
      ...base,
      name: 'team-send',
      domains: ['send.example.com'],
      apiHosts: ['cli.example.com'],
      namespaces: ['2001', '2002'] as [string, string],
      admin: { ...dashboard, domains: ['admin.example.com'], fileNames: false },
    };
    const { publicText, adminText } = renderInstance(template, options, 'instances/team');
    expect(readOptions(publicText, adminText)).toEqual({ ...options, accountId: undefined });
    expect(readOptions(template, null)).toEqual({ ...base, accountId: undefined });
  });
  it('keep the sign-in a dashboard already has, including Access kept as secrets', () => {
    const access = { team: 'team.cloudflareaccess.com', aud: 'aud', emails: 'me@example.com' };
    expect(signInDefault(null, [])).toEqual({ auth: 'password', accessSecrets: false });
    expect(signInDefault({ ...dashboard }, ['ADMIN_PASSWORD'])).toEqual({
      auth: 'password',
      accessSecrets: false,
    });
    expect(
      signInDefault({ ...dashboard }, ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS']),
    ).toEqual({
      auth: 'access',
      accessSecrets: true,
    });
    expect(signInDefault({ ...dashboard, auth: 'access', access }, [])).toEqual({
      auth: 'access',
      accessSecrets: false,
    });
  });
  it('pick rate-limit counters no other instance uses', () => {
    expect(nextNamespaces([])).toEqual(['1001', '1002']);
    expect(nextNamespaces(['1001', '1002'])).toEqual(['2001', '2002']);
    expect(nextNamespaces(['1001', '1002', '3001', '3002'])).toEqual(['2001', '2002']);
  });
  it('find the way back to the repository', () => {
    expect(instancePrefix('.')).toBe('');
    expect(instancePrefix('instances/team')).toBe('../../');
    expect(instancePrefix('./instances/team/')).toBe('../../');
  });
  it('refuse answers Cloudflare would reject', () => {
    const bad = [
      { ...base, name: 'Has Spaces' },
      { ...base, name: 'x'.repeat(58) },
      { ...base, domains: ['https://send.example.com'] },
      { ...base, apiHosts: ['cli.example.com'] },
      { ...base, admin: { ...dashboard, database: { name: '', id: '' } } },
    ];
    for (const options of bad) expect(() => validateOptions(options), options.name).toThrow();
    expect(() => validateOptions({ ...base, domains: ['send.example.com'] })).not.toThrow();
  });
});
