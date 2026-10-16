import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePages, downloadsOf, openPage, receiveInPage, sendFromPage } from './browser';
import { RESULTS, cli, codeOf, folder, partSize, randomFile, sha256, sha256File } from './fixtures';

test.beforeAll(() => mkdir(RESULTS, { recursive: true }));
test.afterEach(closePages);

async function expectDownloads(page: Page, files: Buffer[]) {
  await expect.poll(() => downloadsOf(page).length, { timeout: 120_000 }).toBe(files.length);
  for (let i = 0; i < files.length; i++)
    expect(sha256(await readFile((await downloadsOf(page)[i].path())!))).toBe(sha256(files[i]));
}
const progress = async (page: Page) =>
  Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'));

for (const relay of [false, true]) {
  test(`CLI sends to the web app over ${relay ? 'the relay' : 'any route'}`, async ({
    browser,
  }) => {
    const from = await folder('cli-send');
    const data = [randomBytes(3 * 1024 * 1024 + 7), Buffer.alloc(0), Buffer.from('hi 👋')];
    const names = ['a.bin', 'empty.txt', 'b.txt'];
    for (let i = 0; i < names.length; i++) await writeFile(join(from, names[i]), data[i]);
    const page = await openPage(browser, { relay });
    const sender = cli(['send', ...names.map((n) => join(from, n)), ...(relay ? ['--relay'] : [])]);
    await receiveInPage(page, await codeOf(sender));
    await expectDownloads(page, data);
    expect(await sender.exited, sender.output()).toBe(0);
    // Firefox in this automation has no usable ICE candidates; elsewhere expect direct.
    if (relay) expect(sender.output()).toContain('(encrypted relay)');
    else if (browser.browserType().name() !== 'firefox')
      expect(sender.output()).toContain('(direct connection)');
    // The final acknowledgement reached the page: it does not start reconnecting.
    await page.waitForTimeout(3000);
    await expect(page.getByRole('heading', { name: 'Reconnecting…' })).toHaveCount(0);
  });

  test(`the web app sends to the CLI over ${relay ? 'the relay' : 'any route'}`, async ({
    browser,
  }) => {
    const to = await folder('cli-receive');
    const files = [
      { name: 'photo.bin', mimeType: 'application/octet-stream', buffer: randomBytes(5_000_123) },
      { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello from the web') },
    ];
    const page = await openPage(browser, { relay });
    const code = await sendFromPage(page, files);
    const receiver = cli(['receive', code, '-y', '-o', to, ...(relay ? ['--relay'] : [])]);
    expect(await receiver.exited, receiver.output()).toBe(0);
    await expect(page.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
    for (const file of files)
      expect(await sha256File(join(to, file.name))).toBe(sha256(file.buffer));
    if (relay) expect(receiver.output()).toContain('(encrypted relay)');
    else if (browser.browserType().name() !== 'firefox')
      expect(receiver.output()).toContain('(direct connection)');
  });
}

test('a web receiver that reloads mid-transfer resumes from the CLI sender', async ({
  browser,
}) => {
  const from = await folder('reload-send');
  const data = randomBytes(24 * 1024 * 1024 + 11);
  await writeFile(join(from, 'big.bin'), data);
  const page = await openPage(browser, { relay: true, slow: true });
  const sender = cli(['send', join(from, 'big.bin'), '--relay']);
  await receiveInPage(page, await codeOf(sender));
  await expect.poll(() => progress(page)).toBeGreaterThan(5);
  await page.reload();
  await expectDownloads(page, [data]);
  expect(await sender.exited, sender.output()).toBe(0);
  expect(sender.output()).toMatch(/Waiting for the connection/);
});

test('a web sender that is closed and reopened continues to the CLI receiver', async ({
  browser,
}) => {
  const from = await folder('reopen-web-send');
  const to = await folder('reopen-receive');
  const path = await randomFile(from, 'big.bin', 256 * 1024 * 1024 + 3);
  const page = await openPage(browser, { relay: true });
  const code = await sendFromPage(page, [path]);
  const receiver = cli(['receive', code, '-y', '-o', to, '--relay']);
  await expect.poll(() => partSize(to), { timeout: 60_000 }).toBeGreaterThan(8 * 1024 * 1024);
  // As in the root suite, the sender comes back in a new page of the same profile.
  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await reopened.getByTestId('original-files').setInputFiles([path]);
  expect(await receiver.exited, receiver.output()).toBe(0);
  expect(receiver.output()).toMatch(/Waiting for the connection/);
  expect(await sha256File(join(to, 'big.bin'))).toBe(await sha256File(path));
});

test('Ctrl-C on the CLI sender tells the web receiver', async ({ browser }) => {
  const from = await folder('cancel-send');
  await writeFile(join(from, 'big.bin'), randomBytes(48 * 1024 * 1024));
  const page = await openPage(browser, { relay: true, slow: true });
  const sender = cli(['send', join(from, 'big.bin'), '--relay']);
  await receiveInPage(page, await codeOf(sender));
  await expect.poll(() => progress(page)).toBeGreaterThan(0);
  sender.process.kill('SIGINT');
  expect(await sender.exited).toBe(130);
  await expect(page.getByText('The other device ended the transfer.')).toBeVisible();
  expect(downloadsOf(page)).toHaveLength(0);
});
