// Bundles the command-line client. The web app's src/transfer.ts and
// src/send-session.ts run unchanged; only their two browser-only modules are
// replaced by the Node versions in src/.
import { build } from 'esbuild';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const replaced = { './storage': 'node-storage.ts', './recovery': 'node-recovery.ts' };
// These need a browser, or belong to the web interface and rooms.
const forbidden = [/^src\/(storage|recovery|disk-worker)\.ts$/, /^src\/room\//, /\.tsx$/, /react/];

export const swapBrowserModules = {
  name: 'swap-browser-modules',
  setup(build) {
    build.onResolve({ filter: /^\.\/(storage|recovery)$/ }, (args) =>
      ['transfer.ts', 'send-session.ts'].some((file) => args.importer === join(root, 'src', file))
        ? { path: join(here, 'src', replaced[args.path]) }
        : undefined,
    );
  },
};

/** The npm packages whose code is in the bundle, from its inputs. */
export function bundledPackages(inputs) {
  const names = inputs
    .map((path) => /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1])
    .filter(Boolean);
  return [...new Set(names)].sort();
}

/** Each bundled package's name, version, license and license text, for THIRD_PARTY_NOTICES.txt. */
async function notices(inputs) {
  const sections = [];
  for (const name of bundledPackages(inputs)) {
    const path = inputs.find((input) => input.includes(`node_modules/${name}/`));
    const folder = join(
      root,
      path.slice(0, path.indexOf(`node_modules/${name}/`)),
      'node_modules',
      name,
    );
    const { version, license } = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
    const file = (await readdir(folder)).find((entry) =>
      /^(licen[sc]e|copying)(\.|$)/i.test(entry),
    );
    if (!file) throw new Error(`${name} has no license file to ship with the command.`);
    const text = (await readFile(join(folder, file), 'utf8')).trim();
    sections.push(`${name} ${version} (${license})\n\n${text}`);
  }
  return `WideSend's command line (Apache-2.0, see LICENSE) includes code from these packages:\n\n${sections.join('\n\n' + '-'.repeat(72) + '\n\n')}\n`;
}

/** Builds dist/widesend.mjs and returns the bundled inputs, relative to the repository. */
export async function bundle(outfile = join(here, 'dist', 'widesend.mjs')) {
  const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(here, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node-datachannel', 'node-datachannel/*'],
    banner: { js: '#!/usr/bin/env node' },
    define: { __VERSION__: JSON.stringify(version) },
    plugins: [swapBrowserModules],
    metafile: true,
    logLevel: 'warning',
  });
  const inputs = Object.keys(result.metafile.inputs);
  const bad = inputs.filter((path) => forbidden.some((pattern) => pattern.test(path)));
  if (bad.length) throw new Error(`The CLI bundle must not include: ${bad.join(', ')}`);
  await chmod(outfile, 0o755);
  await writeFile(join(dirname(outfile), 'THIRD_PARTY_NOTICES.txt'), await notices(inputs));
  return inputs;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await bundle();
