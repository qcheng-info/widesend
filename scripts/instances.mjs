// What the instances of one checkout share: a Cloudflare account, so rate-limit
// namespaces must differ between them (docs/self-hosting.md: several instances).
import { readdir, readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { readOptions } from './instance-config.mjs';
import { root as repository } from './run.mjs';

async function namespacesIn(file) {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text ? readOptions(text, null).namespaces.filter(Boolean) : [];
}

/** Namespaces used by the checkout's other instances: its root and its instance folders. */
export async function usedNamespaces(dir, root = repository) {
  const used = [];
  if (normalize(dir) !== '.') used.push(...(await namespacesIn(join(root, 'wrangler.jsonc'))));
  const entries = await readdir(join(root, 'instances'), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const folder = `instances/${entry.name}`;
    if (entry.isDirectory() && normalize(folder) !== normalize(dir))
      used.push(...(await namespacesIn(join(root, folder, 'wrangler.jsonc'))));
  }
  return used;
}
