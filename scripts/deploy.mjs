// Deploys a WideSend instance: its public Worker and, when it has one, its dashboard.
//   npm run deploy                            this checkout (wrangler.jsonc, wrangler.admin.jsonc)
//   npm run deploy -- --dir instances/team    an instance folder (docs/self-hosting.md)
//   npm run deploy -- --all                   every folder in instances/
// --check runs the tests first; --dry-run builds and lists what would be deployed.
// Workers Builds (the Deploy to Cloudflare button) runs it with no options.
import { access, copyFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import { capture, local, root, run } from './run.mjs';

const exists = (path) =>
  access(join(root, path)).then(
    () => true,
    () => false,
  );
export const files = (dir) => ({
  publicFile: join(dir, 'wrangler.jsonc'),
  adminFile: join(dir, 'wrangler.admin.jsonc'),
});

/**
 * Workers Builds (the Deploy button's builds) deploys only the Worker it is connected to:
 * Wrangler refuses any other name there. The dashboard is then deployed from a checkout.
 */
export function deployTargets(hasDashboard, env = process.env) {
  const workersBuilds = !!(env.WORKERS_CI || env.WRANGLER_CI_MATCH_TAG);
  return { site: true, dashboard: hasDashboard && !workersBuilds };
}

/** Workers Builds has just built the site in its build step; elsewhere, build first. */
export function needsBuild(env = process.env, built = false) {
  return !(env.WORKERS_CI && built);
}

export async function build({ check = false } = {}) {
  await run('npm', ['run', check ? 'check' : 'build']);
}

/** Deploys one instance; returns the addresses Wrangler reported (workers.dev or domains). */
export async function deployInstance(dir, { dryRun = false, yes = false } = {}) {
  const { publicFile, adminFile } = files(dir);
  const config = parse(await readFile(join(root, publicFile), 'utf8'));
  const flags = dryRun ? ['--dry-run'] : [];
  if (!dryRun && config.d1_databases?.some((database) => database.binding === 'ACTIVITY'))
    // yes: setup's person has already agreed to deploy, so Wrangler doesn't ask again.
    await capture(
      local('wrangler'),
      ['d1', 'migrations', 'apply', 'ACTIVITY', '--remote', '--config', publicFile],
      yes ? { env: { CI: '1' } } : {},
    );
  const site = await capture(local('wrangler'), ['deploy', '--config', publicFile, ...flags]);
  let dashboard = '';
  const hasDashboard = await exists(adminFile);
  if (deployTargets(hasDashboard).dashboard) {
    await copyFile(join(root, 'public/widesend.svg'), join(root, 'admin/public/widesend.svg'));
    dashboard = await capture(local('wrangler'), ['deploy', '--config', adminFile, ...flags]);
  } else if (hasDashboard)
    console.log(
      `\nWorkers Builds deploys only the site. Deploy the dashboard from a checkout: npm run deploy${dir === '.' ? '' : ` -- --dir ${dir}`}`,
    );
  const address = (output) => output.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  return { site: address(site), dashboard: address(dashboard) };
}

async function instanceFolders() {
  const entries = await readdir(join(root, 'instances'), { withFileTypes: true }).catch(() => []);
  const folders = [];
  for (const entry of entries)
    if (entry.isDirectory() && (await exists(`instances/${entry.name}/wrangler.jsonc`)))
      folders.push(`instances/${entry.name}`);
  return folders;
}

async function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: '.' },
      all: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dirs = values.all ? await instanceFolders() : [values.dir];
  if (!dirs.length) throw new Error('No instance folders in instances/. Run npm run setup first.');
  for (const dir of dirs)
    if (!(await exists(files(dir).publicFile)))
      throw new Error(`${files(dir).publicFile} does not exist. Run npm run setup first.`);
  if (values.check || needsBuild(process.env, await exists('dist/index.html')))
    await build({ check: values.check });
  for (const dir of dirs) {
    console.log(`\nDeploying ${dir === '.' ? 'this checkout' : dir}…\n`);
    await deployInstance(dir, { dryRun: values['dry-run'] });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(`\nDeployment stopped: ${error.message}\nNothing further was attempted.`);
    process.exitCode = 1;
  });
