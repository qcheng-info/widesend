import { expect, test, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePages, downloadsOf, openPage, receiveInPage } from './browser';
import { RESULTS, cli, codeOf, folder, sha256, sha256File } from './fixtures';

// A code used several times, between the command line and the web app.
test.beforeAll(() => mkdir(RESULTS, { recursive: true }));
test.afterEach(closePages);

async function expectDownloads(page: Page, files: Buffer[]) {
  await expect.poll(() => downloadsOf(page).length, { timeout: 120_000 }).toBe(files.length);
  const got = await Promise.all(
    downloadsOf(page).map(async (d) => sha256(await readFile((await d.path())!))),
  );
  expect(got.sort()).toEqual(files.map(sha256).sort());
}

test('the CLI sends a code used twice to two web pages', async ({ browser }) => {
  const from = await folder('cli-many');
  const data = [randomBytes(2 * 1024 * 1024 + 3), Buffer.from('hello, both of you')];
  const names = ['a.bin', 'b.txt'];
  for (let i = 0; i < names.length; i++) await writeFile(join(from, names[i]), data[i]);
  const sender = cli(['send', ...names.map((n) => join(from, n)), '--uses', '2']);
  const code = await codeOf(sender);
  await sender.waitFor(/The code can be used 2 times/);
  const one = await openPage(browser);
  const two = await openPage(browser);
  await receiveInPage(one, code);
  await receiveInPage(two, code);
  await expectDownloads(one, data);
  await expectDownloads(two, data);
  expect(await sender.exited, sender.output()).toBe(0);
  expect(sender.output()).toContain('✓ Use 1: delivered');
  expect(sender.output()).toContain('✓ Use 2: delivered');
  expect(sender.output()).toContain('✓ Delivered 2 times.');
});

test('two CLI receivers use a web code twice, and a third try is told it is used', async ({
  browser,
}) => {
  const files = [
    { name: 'photo.bin', mimeType: 'application/octet-stream', buffer: randomBytes(3_000_123) },
    { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('for two people') },
  ];
  const page = await openPage(browser);
  await page.getByTestId('file-input').setInputFiles(files);
  await page.getByRole('button', { name: 'More uses' }).click();
  await page.getByRole('button', { name: 'Create transfer' }).click();
  const code = (await page.getByTestId('transfer-code').textContent())!;
  const folders = [await folder('cli-many-a'), await folder('cli-many-b')];
  const receivers = folders.map((to) => cli(['receive', code, '-y', '-o', to]));
  for (const receiver of receivers) expect(await receiver.exited, receiver.output()).toBe(0);
  await expect(page.getByText('Delivered 2 times')).toBeVisible();
  for (const to of folders)
    for (const file of files)
      expect(await sha256File(join(to, file.name))).toBe(sha256(file.buffer));
  const late = cli(['receive', code, '-y', '-o', await folder('cli-many-c')]);
  expect(await late.exited).toBe(1);
  expect(late.output()).toContain(
    'This code has already been used. Ask the sender for a new code.',
  );
});

test('Ctrl-C after a delivery stops sharing and succeeds', async ({ browser }) => {
  const from = await folder('cli-many-stop');
  const data = Buffer.from('just the first person');
  await writeFile(join(from, 'once.txt'), data);
  const sender = cli(['send', join(from, 'once.txt'), '--uses', '3']);
  const code = await codeOf(sender);
  const page = await openPage(browser);
  await receiveInPage(page, code);
  await expectDownloads(page, [data]);
  await sender.waitFor(/✓ Use 1: delivered/);
  sender.process.kill('SIGINT');
  expect(await sender.exited, sender.output()).toBe(0);
  expect(sender.output()).toContain('✓ Delivered once.');
  const late = cli(['receive', code, '-y', '-o', await folder('cli-many-late')]);
  expect(await late.exited).toBe(1);
  expect(late.output()).toContain('This code has already been used.');
});
