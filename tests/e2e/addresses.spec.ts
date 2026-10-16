import { test, expect, type Browser, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// One deployment can answer on several addresses (a custom domain and another one,
// say). Keys use the deployment's site name, so a page on one address pairs with a
// page on another. Locally: localhost and 127.0.0.1.
const ADDRESSES = ['http://localhost:8788', 'http://127.0.0.1:8788'];
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function page(browser: Browser, base: string): Promise<Page> {
  const type = browser.browserType();
  if (type.name() === 'webkit') {
    await mkdir('test-results', { recursive: true });
    const profile = await mkdtemp('test-results/browser-profile-');
    const context = await type.launchPersistentContext(profile, {
      baseURL: base,
      acceptDownloads: true,
    });
    const close = context.close.bind(context);
    context.close = async (options) => {
      await close(options);
      await rm(profile, { recursive: true, force: true });
    };
    closers.push(() => context.close());
    const p = context.pages()[0] ?? (await context.newPage());
    await p.goto('/');
    return p;
  }
  const context = await browser.newContext({ baseURL: base, acceptDownloads: true });
  closers.push(() => context.close());
  const p = await context.newPage();
  await p.goto('/');
  return p;
}
const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close().catch(() => {})));
});

test('a transfer pairs between two addresses of one deployment', async ({ browser }) => {
  const sender = await page(browser, ADDRESSES[0]);
  const receiver = await page(browser, ADDRESSES[1]);
  const file = {
    name: 'across.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(300_007, 7),
  };
  await sender.getByTestId('file-input').setInputFiles(file);
  await sender.getByRole('button', { name: 'Create transfer' }).click();
  const code = (await sender.getByTestId('transfer-code').textContent())!;
  await receiver.getByRole('tab', { name: 'Receive files' }).click();
  await receiver
    .getByRole('group', { name: 'Transfer code' })
    .getByRole('textbox')
    .first()
    .fill(code);
  await receiver.getByRole('button', { name: 'Connect to sender' }).click();
  await expect(receiver.getByRole('heading', { name: 'Ready to receive.' })).toBeVisible();
  const download = receiver.waitForEvent('download');
  await receiver.getByRole('button', { name: 'Receive', exact: true }).click();
  expect(sha(await readFile((await (await download).path())!))).toBe(sha(file.buffer));
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
});

test('a room pairs between two addresses of one deployment', async ({ browser }) => {
  const owner = await page(browser, ADDRESSES[0]);
  const guest = await page(browser, ADDRESSES[1]);
  await owner.getByRole('tab', { name: 'Create a room' }).click();
  await owner.getByTestId('room-name').fill('Owner');
  await owner.getByRole('button', { name: 'Create room' }).click();
  const code = (await owner.getByTestId('room-code').textContent())!;
  await guest.getByRole('tab', { name: 'Join a room' }).click();
  await guest.getByTestId('room-name').fill('Guest');
  await guest.getByRole('group', { name: 'Room code' }).getByRole('textbox').first().fill(code);
  await guest.getByRole('button', { name: 'Join room' }).click();
  for (const p of [owner, guest])
    await expect(p.getByTestId('room-members').locator('li')).toHaveCount(2);
});
