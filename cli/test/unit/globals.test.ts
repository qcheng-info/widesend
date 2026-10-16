import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JavaScript.
import { bundle } from '../../build.mjs';

// Every browser global the bundled web modules touch, and how the CLI covers it.
// A new use fails this test until environment.ts handles it and it is added here.
const covered = new Set([
  'src/transfer.ts document.visibilityState', // environment: always "visible"
  'src/transfer.ts document.addEventListener', // environment: inert EventTarget
  'src/transfer.ts document.removeEventListener',
  'src/transfer.ts window.addEventListener', // environment: inert EventTarget
  'src/transfer.ts window.removeEventListener',
  'src/transfer.ts location.protocol', // environment: the server origin
  'src/transfer.ts location.host',
  'src/site.ts location.origin', // environment: the server origin, until /api/health names the site
  'src/site.ts location.pathname', // apiHostTarget, which only the web page calls; a URL here
  'src/site.ts location.search',
  'src/site.ts location.hash',
  'src/transfer.ts navigator.wakeLock', // Node's navigator has none; transfer.ts uses ?.
  'src/transfer.ts RTCPeerConnection', // environment: node-datachannel or unavailable
]);
const browserGlobal =
  /\b(document|window|navigator|location|indexedDB|sessionStorage|localStorage|Worker|RTCPeerConnection|URL\.createObjectURL|showSaveFilePicker|showDirectoryPicker)\b(\.[A-Za-z]+)?/g;

it('the bundled web modules use only browser globals the CLI provides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'widesend-globals-'));
  const inputs: string[] = await bundle(join(dir, 'widesend.mjs')).finally(() =>
    rm(dir, { recursive: true, force: true }),
  );
  const web = inputs.filter((path) => /^(src|shared)\//.test(path));
  expect(web).toContain('src/transfer.ts');
  const found = new Set<string>();
  for (const path of web) {
    const code = (await readFile(join(__dirname, '../../..', path), 'utf8'))
      .replace(/(^|[^:])\/\/.*$/gm, '$1') // Comments, but not "://" in URLs.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Words in messages ("a regular window") are not uses.
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
    for (const match of code.matchAll(browserGlobal)) {
      const before = code.slice(Math.max(0, match.index - 1), match.index);
      if (before === '.' || /\btype\b|:\s*$/.test(code.slice(match.index - 12, match.index)))
        continue; // A property of something else, or a type annotation.
      found.add(`${path} ${match[0]}`);
    }
  }
  expect([...found].filter((use) => !covered.has(use))).toEqual([]);
  // A stale entry means the scan or this list no longer matches the code.
  expect([...covered].filter((use) => !found.has(use))).toEqual([]);
});
