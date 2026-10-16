import { expect, test } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RESULTS, cli, codeOf, folder, randomFile, sha256File } from './fixtures';

const run = promisify(execFile);
test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'CLI only'));
test.beforeAll(() => mkdir(RESULTS, { recursive: true }));

test('the packed npm package installs and transfers', async () => {
  test.setTimeout(300_000);
  const here = fileURLToPath(new URL('../..', import.meta.url));
  const pack = await folder('pack');
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', pack], {
    cwd: here,
  });
  const [{ filename, files }] = JSON.parse(stdout.slice(stdout.indexOf('[')));
  expect(files.map((f: { path: string }) => f.path).sort()).toEqual([
    'LICENSE',
    'README.md',
    'dist/widesend.mjs',
    'package.json',
  ]);
  const install = await folder('install');
  // Its own package.json stops npm from walking up and installing into the repository.
  await writeFile(join(install, 'package.json'), '{ "private": true }\n');
  const rootPackage = await readFile(join(here, '..', 'package.json'), 'utf8');
  await run('npm', ['install', '--no-audit', '--no-fund', join(pack, filename)], { cwd: install });
  expect(await readFile(join(here, '..', 'package.json'), 'utf8')).toBe(rootPackage);
  const bin = join(install, 'node_modules', '.bin', 'widesend');
  const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
  expect((await run(bin, ['--version'])).stdout.trim()).toBe(version);
  const from = await folder('pack-send');
  const to = await folder('pack-receive');
  const path = await randomFile(from, 'data.bin', 2 * 1024 * 1024 + 9);
  const sender = cli(['send', path], { command: [bin] });
  const receiver = cli(['receive', await codeOf(sender), '-y', '-o', to], { command: [bin] });
  expect(await receiver.exited, receiver.output()).toBe(0);
  expect(await sender.exited, sender.output()).toBe(0);
  expect(sender.output()).toContain('(direct connection)');
  expect(await sha256File(join(to, 'data.bin'))).toBe(await sha256File(path));
});
