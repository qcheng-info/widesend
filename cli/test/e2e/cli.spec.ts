import { expect, test } from '@playwright/test';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RESULTS, cli, codeOf, folder, partSize, randomFile, sha256File } from './fixtures';
import { startProxy } from './proxy';

// CLI ↔ CLI needs no browser; run these once.
test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'CLI only'));
test.beforeAll(() => mkdir(RESULTS, { recursive: true }));

for (const relay of [false, true])
  test(`CLI to CLI over ${relay ? 'the relay' : 'a direct connection'} keeps exact bytes`, async () => {
    const from = await folder('send');
    const to = await folder('receive');
    const paths = [
      await randomFile(from, 'photo.bin', 4 * 1024 * 1024 + 123),
      await randomFile(from, 'empty.txt', 0),
      await randomFile(from, 'héllo 👋.txt', 1000),
    ];
    const flags = relay ? ['--relay'] : [];
    const sender = cli(['send', ...paths, ...flags]);
    const receiver = cli(['receive', await codeOf(sender), '-y', '-o', to, ...flags]);
    expect(await receiver.exited, receiver.output()).toBe(0);
    expect(await sender.exited, sender.output()).toBe(0);
    expect(sender.output()).toContain(relay ? '(encrypted relay)' : '(direct connection)');
    expect((await readdir(to)).sort()).toEqual(['empty.txt', 'héllo 👋.txt', 'photo.bin']);
    for (const path of paths)
      expect(await sha256File(join(to, basename(path)))).toBe(await sha256File(path));
  });

test('a dropped connection reconnects and finishes with exact bytes', async () => {
  const proxy = await startProxy();
  try {
    const from = await folder('drop-send');
    const to = await folder('drop-receive');
    const path = await randomFile(from, 'big.bin', 256 * 1024 * 1024 + 5);
    const sender = cli(['send', path, '--relay'], { server: proxy.url });
    const receiver = cli(['receive', await codeOf(sender), '-y', '-o', to, '--relay'], {
      server: proxy.url,
    });
    await expect.poll(() => partSize(to), { timeout: 60_000 }).toBeGreaterThan(8 * 1024 * 1024);
    proxy.cut();
    expect(await receiver.exited, receiver.output()).toBe(0);
    expect(await sender.exited, sender.output()).toBe(0);
    expect(sender.output() + receiver.output()).toMatch(/Waiting for the connection/);
    expect(await sha256File(join(to, 'big.bin'))).toBe(await sha256File(path));
  } finally {
    await proxy.close();
  }
});

test('Ctrl-C on the CLI receiver removes its partial file and tells the sender', async () => {
  const from = await folder('cancel-receive-send');
  const to = await folder('cancel-receive');
  const path = await randomFile(from, 'big.bin', 256 * 1024 * 1024);
  const sender = cli(['send', path, '--relay']);
  const receiver = cli(['receive', await codeOf(sender), '-y', '-o', to, '--relay']);
  await expect.poll(() => partSize(to), { timeout: 60_000 }).toBeGreaterThan(0);
  receiver.process.kill('SIGINT');
  expect(await receiver.exited).toBe(130);
  expect(await sender.exited).toBe(1);
  expect(sender.output()).toContain('The other device ended the transfer.');
  expect(await readdir(to)).toEqual([]);
});

test('Ctrl-C on the CLI sender ends the CLI receiver cleanly', async () => {
  const from = await folder('cancel-send-send');
  const to = await folder('cancel-send-receive');
  const path = await randomFile(from, 'big.bin', 256 * 1024 * 1024);
  const sender = cli(['send', path, '--relay']);
  const receiver = cli(['receive', await codeOf(sender), '-y', '-o', to, '--relay']);
  await expect.poll(() => partSize(to), { timeout: 60_000 }).toBeGreaterThan(0);
  sender.process.kill('SIGINT');
  expect(await sender.exited).toBe(130);
  expect(await receiver.exited).toBe(1);
  expect(receiver.output()).toContain('The other device ended the transfer.');
  expect(await readdir(to)).toEqual([]);
});

test('received files never replace existing ones', async () => {
  const from = await folder('clash-send');
  const to = await folder('clash-receive');
  const path = await randomFile(from, 'report.pdf', 1000);
  await writeFile(join(to, 'report.pdf'), 'keep me');
  const sender = cli(['send', path]);
  const receiver = cli(['receive', await codeOf(sender), '-y', '-o', to]);
  expect(await receiver.exited, receiver.output()).toBe(0);
  expect(await readFile(join(to, 'report.pdf'), 'utf8')).toBe('keep me');
  expect(await sha256File(join(to, 'report (1).pdf'))).toBe(await sha256File(path));
  expect(receiver.output()).toContain(join(to, 'report (1).pdf'));
  expect(await sender.exited, sender.output()).toBe(0);
});

test('misuse is refused before connecting, with exit code 2', async () => {
  const dir = await folder('misuse');
  await mkdir(join(dir, 'album'));
  const cases: [string[], RegExp][] = [
    [['send', join(dir, 'missing.txt')], /no such file/],
    [['send', join(dir, 'album')], /is a folder/],
    [['receive', 'A1B2C3', '-y', '-o', join(dir, 'nowhere')], /does not exist/],
    [['receive', 'A1B2C3'], /Add -y/],
    [['receive', 'https://old.example.com/#room=A1B2C3', '-y'], /room link/],
    [['receive', 'nope', '-y'], /6 letters and digits/],
    [['upload', 'x'], /Unknown command/],
  ];
  for (const [args, message] of cases) {
    const run = cli(args, { cwd: dir });
    expect(await run.exited, args.join(' ')).toBe(2);
    expect(run.output()).toMatch(message);
  }
});

test('a code nobody is sending with fails with a clear message', async () => {
  test.setTimeout(150_000);
  const to = await folder('wrong-code');
  const receiver = cli(['receive', 'Z9Z9Z9', '-y', '-o', to]);
  expect(await receiver.exited, receiver.output()).toBe(1);
  expect(receiver.output()).toContain('Looking for the sender…');
  expect(receiver.output()).toMatch(/✗ Could not connect\. Check the code/);
});
