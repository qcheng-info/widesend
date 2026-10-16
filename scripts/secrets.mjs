// The dashboard Worker's secrets (its password or Cloudflare Access settings), through
// Wrangler. `wrangler` runs a Wrangler command and returns its standard output; tests
// pass their own.
import { capture, local } from './run.mjs';

const runWrangler = (args, options) =>
  capture(local('wrangler'), args, { quiet: true, ...options });

/** The names of the secrets set on the dashboard: none before its first deployment. */
export async function secretNames(adminFile, env, wrangler = runWrangler) {
  try {
    return JSON.parse(await wrangler(['secret', 'list', '--config', adminFile], { env })).map(
      (secret) => secret.name,
    );
  } catch (error) {
    if (/does not exist|not found|\[code: 10007\]/i.test(error.output ?? '')) return [];
    throw new Error(`Could not list the dashboard's secrets: ${error.output || error.message}`);
  }
}
export const putSecret = (name, value, adminFile, env, wrangler = runWrangler) =>
  wrangler(['secret', 'put', name, '--config', adminFile], { env, input: value });
export async function deleteSecret(name, adminFile, env, wrangler = runWrangler) {
  try {
    await wrangler(['secret', 'delete', name, '--config', adminFile, '--force'], { env });
  } catch (error) {
    throw new Error(
      `Could not remove the dashboard secret ${name}: ${error.output || error.message}`,
    );
  }
}
