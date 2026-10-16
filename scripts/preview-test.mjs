import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { run, local } from './run.mjs';
import { previewConfig } from './preview-config.mjs';

// Browser regressions create many transfers. Give only this isolated local
// runtime generous budgets; never add a request-header or hostname bypass.
const root = new URL('../', import.meta.url);
const config = previewConfig(
  parse(await readFile(new URL('wrangler.jsonc', root), 'utf8')),
  root.href,
);
// Fresh state each start, so local test data never piles up between runs.
await rm(new URL('.wrangler/e2e', root), { recursive: true, force: true });
await mkdir(new URL('.wrangler/e2e', root), { recursive: true });
const path = fileURLToPath(new URL('.wrangler/e2e/wrangler.jsonc', root));
await writeFile(path, JSON.stringify(config, null, 2));
await run(local('wrangler'), [
  'dev',
  '--config',
  path,
  '--port',
  '8788',
  '--persist-to',
  fileURLToPath(new URL('.wrangler/e2e/state', root)),
]);
