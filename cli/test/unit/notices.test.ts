import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JavaScript.
import { bundle, bundledPackages } from '../../build.mjs';

// The command bundles other people's code; their licenses travel with it.
it('ships the license of every package bundled into the command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'widesend-bundle-'));
  try {
    const inputs: string[] = await bundle(join(dir, 'widesend.mjs'));
    const packages: string[] = bundledPackages(inputs);
    expect(packages).toEqual(expect.arrayContaining(['@noble/hashes', 'uqr']));
    const notices = await readFile(join(dir, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    for (const name of packages) expect(notices).toContain(name);
    expect(notices).toMatch(/Permission is hereby granted/); // the MIT text itself
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('publishes the notices with the package', async () => {
  const { files } = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  );
  expect(files).toContain('dist/THIRD_PARTY_NOTICES.txt');
});
