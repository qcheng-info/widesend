// npm run setup: sets up, or changes, a WideSend instance on your Cloudflare account.
// It asks a few questions (or takes them as options), writes the Wrangler files, creates
// the activity database when you want the dashboard, deploys, and sets the dashboard's
// sign-in. Run it again to change an instance. See docs/self-hosting.md.
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { capture, loadEnvironment, local, root, run } from './run.mjs';
import { hosts, resolveAnswer } from './answers.mjs';
import { usedNamespaces } from './instances.mjs';
import { deleteSecret, putSecret, secretNames } from './secrets.mjs';
import { build, deployInstance, files } from './deploy.mjs';
import {
  nextNamespaces,
  readOptions,
  renderInstance,
  signInDefault,
  validateOptions,
} from './instance-config.mjs';

const HELP = `npm run setup -- [options]

Without options it asks. Answers default to the instance's current settings: press
Enter to keep one, or type - to clear it. Cloudflare settings may be in a .env file.
  --dir <folder>           Keep this instance in a folder, e.g. instances/team (default: this checkout)
  --name <name>            Worker name; the dashboard is <name>-admin
  --domain <host>          Custom domain for the site (repeat for more); none: workers.dev
  --api-host <host>        Extra host that serves only the command line
  --admin | --no-admin     Add or remove the admin dashboard and activity record
  --admin-domain <host>    Custom domain for the dashboard; none: workers.dev
  --sign-in <password|access>
  --password <text>        Dashboard password (12+ characters); default: generate one
  --access-team, --access-aud, --access-email   Cloudflare Access settings
  --file-names | --no-file-names   Record file names in the activity record (default: yes)
  --database-id <id>       Use this D1 database instead of finding or creating one
  --yes                    Accept defaults without asking
  --no-deploy              Only write the files, without calling Cloudflare
                           (with --admin, also give --database-id)`;
const MIN_PASSWORD = 12;
const { values: flag } = parseArgs({
  options: {
    dir: { type: 'string', default: '.' },
    name: { type: 'string' },
    domain: { type: 'string', multiple: true },
    'api-host': { type: 'string', multiple: true },
    admin: { type: 'boolean' },
    'no-admin': { type: 'boolean' },
    'admin-domain': { type: 'string', multiple: true },
    'sign-in': { type: 'string' },
    password: { type: 'string' },
    'access-team': { type: 'string' },
    'access-aud': { type: 'string' },
    'access-email': { type: 'string' },
    'file-names': { type: 'boolean' },
    'no-file-names': { type: 'boolean' },
    'database-name': { type: 'string' },
    'database-id': { type: 'string' },
    yes: { type: 'boolean', default: false },
    'no-deploy': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const interactive = !flag.yes && process.stdin.isTTY;
let prompt;
async function ask(question, fallback = '') {
  if (!interactive) return fallback;
  prompt ??= createInterface({ input: process.stdin, output: process.stdout });
  return resolveAnswer(
    await prompt.question(`${question}${fallback ? ` [${fallback}]` : ''}: `),
    fallback,
  );
}
/** Lets go of the terminal before a command that reads it (Wrangler's own questions). */
function closePrompt() {
  prompt?.close();
  prompt = undefined;
}
async function confirm(question, fallback) {
  if (!interactive) return fallback;
  const answer = await ask(`${question} (${fallback ? 'Y/n' : 'y/N'})`);
  return answer ? /^y/i.test(answer) : fallback;
}
const exists = (path) =>
  access(join(root, path)).then(
    () => true,
    () => false,
  );
const wrangler = (args, options = {}) =>
  capture(local('wrangler'), args, { quiet: true, ...options });

let account;
/** The signed-in Cloudflare account, asking which one when there are several. */
async function cloudflare(current) {
  if (account) return account;
  let whoami;
  try {
    whoami = JSON.parse(await wrangler(['whoami', '--json']));
  } catch {
    whoami = { loggedIn: false };
  }
  if (!whoami.loggedIn)
    throw new Error(
      'Log in to Cloudflare first: npx wrangler login (or set CLOUDFLARE_API_TOKEN).',
    );
  const accounts = whoami.accounts ?? [];
  let id = current ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!id && accounts.length > 1) {
    const list = accounts.map((a, i) => `  ${i + 1}. ${a.name} (${a.id})`).join('\n');
    if (!interactive)
      throw new Error(`Several Cloudflare accounts; set CLOUDFLARE_ACCOUNT_ID:\n${list}`);
    console.log(`\nYour Cloudflare accounts:\n${list}`);
    id = accounts[Number(await ask('Which one', '1')) - 1]?.id;
    if (!id) throw new Error('No such account.');
  }
  account = { id, env: id ? { CLOUDFLARE_ACCOUNT_ID: id } : {} };
  return account;
}

/** The activity database's ID: given, already in the files, found by name, or created. */
async function activityDatabase(name, current, accountId) {
  if (flag['database-id']) return flag['database-id'];
  if (current?.name === name && current.id) return current.id;
  if (flag['no-deploy'])
    throw new Error(
      `--no-deploy only writes files, so it can't find or create the database ${name}: ` +
        'pass --database-id (npx wrangler d1 list shows it), or run setup without --no-deploy.',
    );
  const { env } = await cloudflare(accountId);
  const listed = JSON.parse(await wrangler(['d1', 'list', '--json'], { env }));
  const found = listed.find((database) => database.name === name);
  if (found) return found.uuid;
  console.log(`Creating the activity database ${name}…`);
  const created = await wrangler(['d1', 'create', name], { env: { ...env, CI: '1' } });
  const id = created.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  if (!id) throw new Error(`Cloudflare did not return the new database's ID:\n${created}`);
  return id;
}

async function main() {
  if (flag.help) return console.log(HELP);
  loadEnvironment(); // CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from a .env file
  const dir = normalize(flag.dir).replace(/\/$/, '') || '.';
  const { publicFile, adminFile } = files(dir);
  const fresh = !(await exists(publicFile));
  const publicText = await readFile(join(root, fresh ? 'wrangler.jsonc' : publicFile), 'utf8');
  const adminText = (await exists(adminFile))
    ? await readFile(join(root, adminFile), 'utf8')
    : null;
  const current = readOptions(publicText, adminText);
  console.log(
    `Setting up WideSend ${dir === '.' ? 'in this checkout' : `in ${dir}`}. Press Enter to keep a value, or type - to clear one.\n`,
  );

  const name =
    flag.name ??
    (await ask('Name of the Worker', fresh && dir !== '.' ? basename(dir) : current.name));
  const domains = flag.domain
    ? hosts(flag.domain.join(','))
    : hosts(
        await ask('Custom domain for the site (- for workers.dev)', current.domains.join(', ')),
      );
  const apiHosts = flag['api-host']
    ? hosts(flag['api-host'].join(','))
    : domains.length
      ? hosts(
          await ask(
            'Extra host only for the command line (- for none)',
            current.apiHosts.join(', '),
          ),
        )
      : [];
  const wantsAdmin = flag['no-admin']
    ? false
    : (flag.admin ??
      (await confirm('Add the admin dashboard and its activity record?', !!current.admin)));
  const used = await usedNamespaces(dir);
  const namespaces =
    current.namespaces.every(Boolean) && !current.namespaces.some((id) => used.includes(id))
      ? current.namespaces
      : nextNamespaces(used);

  let admin = null;
  let signIn = null;
  if (wantsAdmin) {
    const adminDomains = flag['admin-domain']
      ? hosts(flag['admin-domain'].join(','))
      : hosts(
          await ask(
            'Custom domain for the dashboard (- for workers.dev)',
            (current.admin?.domains ?? []).join(', '),
          ),
        );
    // Access kept as secrets is invisible in the files: ask the dashboard Worker (not
    // with --no-deploy, which never calls Cloudflare and changes no secrets).
    const secrets =
      adminText && !flag['no-deploy']
        ? await secretNames(adminFile, (await cloudflare(current.accountId)).env)
        : [];
    const existing = signInDefault(current.admin, secrets);
    const auth =
      flag['sign-in'] ??
      (flag['access-team'] || flag['access-aud']
        ? 'access'
        : await ask(
            'Sign in with a password or Cloudflare Access [password/access]',
            existing.auth,
          ));
    if (!['password', 'access'].includes(auth))
      throw new Error('Sign-in is "password" or "access".');
    if (flag.password !== undefined && flag.password.length < MIN_PASSWORD)
      throw new Error(`The dashboard password needs at least ${MIN_PASSWORD} characters.`);
    const fileNames = flag['no-file-names']
      ? false
      : (flag['file-names'] ??
        (await confirm(
          'Record file names in the activity record?',
          current.admin?.fileNames ?? true,
        )));
    const databaseName =
      flag['database-name'] ?? current.admin?.database.name ?? `${name}-activity`;
    // Access settings kept as values in the file stay there; new ones become secrets.
    const keptAccess =
      auth === 'access' && !flag['access-team'] ? current.admin?.access : undefined;
    // Access secrets already on the dashboard stay as they are unless new values are given.
    const keptSecrets = auth === 'access' && existing.accessSecrets && !flag['access-team'];
    let accessSecrets = null;
    if (auth === 'access' && !keptAccess && !keptSecrets) {
      accessSecrets = {
        ACCESS_TEAM_DOMAIN:
          flag['access-team'] ?? (await ask('Access team domain (TEAM.cloudflareaccess.com)')),
        ACCESS_AUD: flag['access-aud'] ?? (await ask('Access application audience (AUD) tag')),
        ADMIN_EMAILS:
          flag['access-email'] ?? (await ask('Admin e-mail address(es), comma-separated')),
      };
      if (!accessSecrets.ACCESS_TEAM_DOMAIN.includes('.'))
        accessSecrets.ACCESS_TEAM_DOMAIN += '.cloudflareaccess.com';
      if (Object.values(accessSecrets).some((value) => !value))
        throw new Error(
          'Cloudflare Access needs the team domain, the AUD tag and an e-mail address.',
        );
    }
    validateOptions({ name, domains, apiHosts, namespaces, admin: null });
    const database = {
      name: databaseName,
      id: await activityDatabase(databaseName, current.admin?.database, current.accountId),
    };
    admin = {
      domains: adminDomains,
      auth,
      ...(keptAccess ? { access: keptAccess } : {}),
      fileNames,
      database,
    };
    signIn = { auth, accessSecrets, keptAccess: !!keptAccess };
  }

  const options = {
    name,
    accountId: current.accountId ?? (flag['no-deploy'] ? undefined : (await cloudflare()).id),
    domains,
    apiHosts,
    namespaces,
    admin,
  };
  validateOptions(options);
  const rendered = renderInstance(publicText, options, dir);
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, publicFile), rendered.publicText);
  if (rendered.adminText) await writeFile(join(root, adminFile), rendered.adminText);
  else if (adminText) await rm(join(root, adminFile));
  console.log(`\nWrote ${publicFile}${rendered.adminText ? ` and ${adminFile}` : ''}.`);
  const deployCommand = dir === '.' ? 'npm run deploy' : `npm run deploy -- --dir ${dir}`;
  if (adminText && !admin)
    console.log(
      `The site no longer records activity. The dashboard Worker ${current.name}-admin and the database ` +
        `${current.admin?.database.name} stay on Cloudflare, and the site no longer cleans up records ` +
        `older than 90 days. To delete the dashboard and the old records:\n` +
        `  npx wrangler delete --name ${current.name}-admin\n  npx wrangler d1 delete ${current.admin?.database.name}`,
    );

  if (flag['no-deploy']) {
    console.log(`\nDeploy with: ${deployCommand}`);
    if (admin?.auth === 'password')
      console.log(
        `Then set the dashboard password (${MIN_PASSWORD}+ characters): npx wrangler secret put ADMIN_PASSWORD --config ${adminFile}`,
      );
    if (signIn?.accessSecrets)
      console.log(
        `Then set the Access settings: npx wrangler secret put ACCESS_TEAM_DOMAIN|ACCESS_AUD|ADMIN_EMAILS --config ${adminFile}`,
      );
    return;
  }

  const { env } = await cloudflare(options.accountId);
  console.log('\nBuilding and deploying…\n');
  closePrompt();
  await build();
  const deployed = await deployInstance(dir, { yes: true });
  let password;
  if (admin) {
    const secrets = await secretNames(adminFile, env);
    if (admin.auth === 'password') {
      for (const name of ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAILS'])
        if (secrets.includes(name)) await deleteSecret(name, adminFile, env);
      const keep =
        flag.password === undefined &&
        secrets.includes('ADMIN_PASSWORD') &&
        (await confirm('Keep the current dashboard password?', true));
      if (!keep) {
        const generate =
          flag.password !== undefined ||
          (await confirm('Generate a strong password for you?', true));
        if (generate) {
          password = flag.password ?? randomBytes(18).toString('base64url');
          await putSecret('ADMIN_PASSWORD', password, adminFile, env);
        } else {
          console.log(`Wrangler asks for the password now (${MIN_PASSWORD}+ characters):`);
          closePrompt();
          await run(local('wrangler'), ['secret', 'put', 'ADMIN_PASSWORD', '--config', adminFile]);
        }
      }
    } else {
      if (secrets.includes('ADMIN_PASSWORD')) await deleteSecret('ADMIN_PASSWORD', adminFile, env);
      for (const [name, value] of Object.entries(signIn.accessSecrets ?? {}))
        await putSecret(name, value, adminFile, env);
    }
  }

  const site = domains.length ? `https://${domains[0]}` : deployed.site;
  const dashboard = admin?.domains.length ? `https://${admin.domains[0]}` : deployed.dashboard;
  const server = apiHosts.length ? `https://${apiHosts[0]}` : site;
  console.log(
    `\nWideSend is ready.\n  Site:       ${site ?? '(see the address Wrangler printed above)'}`,
  );
  if (admin)
    console.log(`  Dashboard:  ${dashboard ?? '(see the address Wrangler printed above)'}`);
  if (password)
    console.log(
      `  Password:   ${password}\n              Shown once: keep it in your password manager.`,
    );
  if (admin?.auth === 'access')
    console.log('  Protect the dashboard with your Access application (docs/admin.md).');
  if (domains.length || admin?.domains.length)
    console.log('  New custom domains can take a few minutes to get their certificate.');
  console.log(
    `\nSend from the command line:  npx widesend send FILE --server ${server ?? '<site>'}` +
      `\n  (or set WIDESEND_SERVER=${server ?? '<site>'})` +
      `\nDeploy again after updating: ${deployCommand}`,
  );
}

main()
  .catch((error) => {
    console.error(`\nSetup stopped: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => prompt?.close());
