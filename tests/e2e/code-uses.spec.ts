import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Send files with a code that can be used several times. Each use is its own
// one-to-one transfer; the sender's page shows one row per use.
const contexts: BrowserContext[] = [];
const downloads = new WeakMap<Page, string[]>();
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
type Options = { relay?: boolean; slow?: boolean; delay?: number };

/** A person with their own browser profile. */
async function person(browser: Browser, options: Options = {}): Promise<Page> {
  const type = browser.browserType();
  // WebKit's nonpersistent contexts are private browsing, which denies OPFS.
  let context: BrowserContext;
  if (type.name() === 'webkit') {
    await mkdir('test-results', { recursive: true });
    const profile = await mkdtemp('test-results/browser-profile-');
    context = await type.launchPersistentContext(profile, {
      baseURL: 'http://localhost:8788',
      acceptDownloads: true,
    });
    const close = context.close.bind(context);
    context.close = async (closeOptions) => {
      try {
        await close(closeOptions);
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    };
  } else context = await browser.newContext();
  contexts.push(context);
  await context.addInitScript(
    ({ relay, slow, delay }) => {
      if (relay)
        Object.defineProperty(window, 'RTCPeerConnection', {
          value: class {
            constructor() {
              throw new Error('Direct network unavailable');
            }
          },
          configurable: true,
        });
      if (slow) {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          postMessage(message: unknown, transfer: Transferable[]): void {
            if ((message as { command?: string }).command === 'write')
              setTimeout(() => super.postMessage(message, transfer), delay ?? 8);
            else super.postMessage(message, transfer);
          }
        };
      }
    },
    { relay: false, slow: false, delay: 8, ...options },
  );
  const page = context.pages()[0] ?? (await context.newPage());
  watchDownloads(page);
  await page.goto('/');
  return page;
}
function watchDownloads(page: Page) {
  downloads.set(page, []);
  page.on('download', async (download) => {
    const path = await download.path();
    if (path) downloads.get(page)!.push(sha(await readFile(path)));
  });
}
async function create(sender: Page, files: { name: string; buffer: Buffer }[], uses: number) {
  await sender
    .getByTestId('file-input')
    .setInputFiles(files.map((f) => ({ ...f, mimeType: 'application/octet-stream' })));
  for (let n = 1; n < uses; n++) await sender.getByRole('button', { name: 'More uses' }).click();
  await expect(sender.getByTestId('code-uses')).toHaveText(String(uses));
  await sender.getByRole('button', { name: 'Create transfer' }).click();
  const code = (await sender.getByTestId('transfer-code').textContent())!;
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  return code;
}
async function connect(receiver: Page, code: string) {
  await receiver.getByRole('tab', { name: 'Receive files' }).click();
  await receiver
    .getByRole('group', { name: 'Transfer code' })
    .getByRole('textbox')
    .first()
    .fill(code);
  await receiver.getByRole('button', { name: 'Connect to sender' }).click();
}
async function receive(receiver: Page, code: string) {
  await connect(receiver, code);
  await expect(receiver.getByRole('heading', { name: 'Ready to receive.' })).toBeVisible();
  await receiver.getByRole('button', { name: 'Receive' }).click();
}
async function received(receiver: Page, files: { buffer: Buffer }[]) {
  await expect(receiver.getByRole('heading', { name: 'Files received.' })).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(() => downloads.get(receiver)!.length).toBe(files.length);
  expect([...downloads.get(receiver)!].sort()).toEqual(files.map((f) => sha(f.buffer)).sort());
}
const USED = 'This code has already been used. Ask the sender for a new code.';

test('a code used three times delivers the same files and a fourth try is told it is used', async ({
  browser,
}) => {
  const files = [
    { name: 'report.bin', buffer: Buffer.alloc(3 * 1024 * 1024 + 77, 0x37) },
    { name: 'note.txt', buffer: Buffer.from('Hello, everyone 👋') },
  ];
  const sender = await person(browser);
  const code = await create(sender, files, 3);
  await expect(sender.getByText('Can be used 3 times · Code expires in 20 minutes')).toBeVisible();
  const receivers = [await person(browser), await person(browser), await person(browser)];
  for (const receiver of receivers) await receive(receiver, code);
  for (const receiver of receivers) await received(receiver, files);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await expect(sender.getByText('Delivered 3 times')).toBeVisible();
  await expect(sender.getByTestId('use-row')).toHaveCount(3);
  const late = await person(browser);
  await connect(late, code);
  await expect(late.getByText(USED)).toBeVisible({ timeout: 10_000 });
});

test('a code used twice delivers through the encrypted relay', async ({ browser }) => {
  const files = [{ name: 'relay.bin', buffer: Buffer.alloc(2 * 1024 * 1024 + 9, 0x52) }];
  const sender = await person(browser, { relay: true });
  const code = await create(sender, files, 2);
  const one = await person(browser, { relay: true });
  const two = await person(browser, { relay: true });
  await receive(one, code);
  await receive(two, code);
  await received(one, files);
  await received(two, files);
  await expect(sender.getByText('Delivered 2 times')).toBeVisible();
});

test('stopping sharing finishes the send and refuses further uses', async ({ browser }) => {
  const files = [{ name: 'once.txt', buffer: Buffer.from('only for the first person') }];
  const sender = await person(browser);
  const code = await create(sender, files, 3);
  const first = await person(browser);
  await receive(first, code);
  await received(first, files);
  await expect(sender.getByTestId('connection-status')).toHaveText('Used 1 of 3 times');
  await sender.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await expect(sender.getByText('Delivered once')).toBeVisible();
  const late = await person(browser);
  await connect(late, code);
  await expect(late.getByText(USED)).toBeVisible({ timeout: 10_000 });
});

test('a receiver who cancels ends only their own use', async ({ browser }) => {
  const files = [{ name: 'big.bin', buffer: Buffer.alloc(12 * 1024 * 1024 + 5, 0x63) }];
  const sender = await person(browser);
  const code = await create(sender, files, 2);
  const leaving = await person(browser, { slow: true });
  const staying = await person(browser);
  await receive(leaving, code);
  await expect(leaving.getByRole('progressbar')).toBeVisible();
  await leaving.getByRole('button', { name: 'Cancel transfer' }).click();
  await receive(staying, code);
  await received(staying, files);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  const rows = sender.getByTestId('use-row');
  await expect(rows.filter({ hasText: 'Cancelled' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Delivered' })).toHaveCount(1);
});

test('the sender reloads and one file selection resumes every use', async ({ browser }) => {
  const original = { name: 'resume.bin', buffer: Buffer.alloc(16 * 1024 * 1024 + 31, 0x29) };
  const sender = await person(browser);
  const code = await create(sender, [original], 2);
  const one = await person(browser, { slow: true });
  const two = await person(browser, { slow: true });
  await receive(one, code);
  await receive(two, code);
  await expect(sender.getByTestId('use-row')).toHaveCount(2);
  await expect
    .poll(() =>
      Promise.all(
        [one, two].map(async (page) =>
          Number(await page.getByRole('progressbar').getAttribute('aria-valuenow')),
        ),
      ).then((values) => Math.min(...values)),
    )
    .toBeGreaterThan(5);
  const context = sender.context();
  await sender.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByRole('button', { name: 'Select original files' })).toBeVisible();
  await reopened.getByTestId('original-files').setInputFiles({
    ...original,
    mimeType: 'application/octet-stream',
  });
  await received(one, [original]);
  await received(two, [original]);
  await expect(reopened.getByText('Delivered 2 times')).toBeVisible();
});

test('a second try of a code that can be used once is told at once', async ({ browser }) => {
  const files = [{ name: 'single.txt', buffer: Buffer.from('just one') }];
  const sender = await person(browser);
  const code = await create(sender, files, 1);
  await expect(sender.getByText('Can be used once · Code expires in 20 minutes')).toBeVisible();
  const first = await person(browser);
  await receive(first, code);
  await received(first, files);
  const second = await person(browser);
  await connect(second, code);
  await expect(second.getByText(USED)).toBeVisible({ timeout: 10_000 });
});

test('after stopping sharing and a reload, one file selection finishes the send', async ({
  browser,
}) => {
  const original = { name: 'later.bin', buffer: Buffer.alloc(16 * 1024 * 1024 + 7, 0x41) };
  const sender = await person(browser);
  const code = await create(sender, [original], 3);
  const quick = await person(browser);
  await receive(quick, code);
  await received(quick, [original]);
  const slow = await person(browser, { slow: true, delay: 40 });
  await receive(slow, code);
  await expect(slow.getByRole('progressbar')).toBeVisible();
  await sender.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(sender.getByTestId('transfer-code')).toHaveCount(0);
  // The page saves that the code is closed; wait for it as a reload a moment later would.
  await expect
    .poll(() =>
      sender.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const open = indexedDB.open('widesend-recovery', 1);
            open.onsuccess = () => {
              const request = open.result.transaction('sessions').objectStore('sessions').getAll();
              request.onsuccess = () => {
                open.result.close();
                resolve(request.result.some((r: { sealed?: boolean }) => r.sealed));
              };
            };
          }),
      ),
    )
    .toBe(true);
  const context = sender.context();
  await sender.close();
  const reopened = await context.newPage();
  await reopened.goto('/');
  await expect(reopened.getByRole('button', { name: 'Select original files' })).toBeVisible();
  // The code stays closed and the receiver who already has the files is listed.
  await expect(reopened.getByTestId('transfer-code')).toHaveCount(0);
  await expect(reopened.getByTestId('use-row').filter({ hasText: 'Delivered' })).toHaveCount(1);
  await reopened.getByTestId('original-files').setInputFiles({
    ...original,
    mimeType: 'application/octet-stream',
  });
  await received(slow, [original]);
  await expect(reopened.getByText('Delivered 2 times')).toBeVisible();
  await expect(reopened.getByTestId('use-row')).toHaveCount(2);
  const late = await person(browser);
  await connect(late, code);
  await expect(late.getByText(USED)).toBeVisible({ timeout: 10_000 });
});

test('a later visit removes the records of a send that was left unfinished', async ({
  browser,
}) => {
  const page = await person(browser);
  const write = (records: object[]) =>
    page.evaluate(
      (records) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('widesend-recovery', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('sessions', { keyPath: 'id' });
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction('sessions', 'readwrite');
            for (const record of records) tx.objectStore('sessions').put(record);
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
        }),
      records,
    );
  const ids = () =>
    page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const open = indexedDB.open('widesend-recovery', 1);
          open.onsuccess = () => {
            const request = open.result
              .transaction('sessions')
              .objectStore('sessions')
              .getAllKeys();
            request.onsuccess = () => {
              open.result.close();
              resolve(request.result as string[]);
            };
          };
        }),
    );
  const now = Date.now();
  const base = {
    version: 2,
    role: 'send',
    code: 'A1B2C3',
    uses: 3,
    updated: now,
    files: [{ id: 0, name: 'old.bin', size: 1, type: '' }],
    accepted: true,
    fileIndex: 0,
    offset: 0,
    completed: [],
    pairExpires: now - 1000,
  };
  await write([
    // Delivered to one person; the rest of the send is gone.
    {
      ...base,
      id: 'orphan:1',
      credential: 'orphan',
      slot: 1,
      receiver: 'r',
      finished: 'complete',
      expires: now + 3_600_000,
    },
    // Long expired.
    {
      ...base,
      id: 'old',
      credential: 'old',
      slot: 0,
      receiver: 'r',
      finished: 'cancelled',
      expires: now - 1000,
    },
  ]);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Send files' })).toBeVisible();
  await expect.poll(ids).toEqual([]);
});
