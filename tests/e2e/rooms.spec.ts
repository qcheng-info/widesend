import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
} from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';

// Each member is a separate browser profile, as on separate devices.
const contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {})));
});
type Member = { page: Page; context: BrowserContext; downloads: Download[] };
type Options = { relay?: boolean; slow?: boolean; mobile?: boolean; language?: string };
async function member(browser: Browser, options: Options = {}): Promise<Member> {
  await mkdir('test-results', { recursive: true });
  const type = browser.browserType();
  const contextOptions = {
    baseURL: 'http://localhost:8788',
    acceptDownloads: true,
    ...(options.mobile
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: type.name() !== 'firefox',
          hasTouch: true,
        }
      : {}),
  };
  let context: BrowserContext;
  // WebKit's non-persistent contexts are private browsing, which denies OPFS.
  if (type.name() === 'webkit') {
    const profile = await mkdtemp('test-results/room-profile-');
    context = await type.launchPersistentContext(profile, contextOptions);
    const close = context.close.bind(context);
    context.close = async (closeOptions) => {
      try {
        await close(closeOptions);
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    };
  } else context = await browser.newContext(contextOptions);
  contexts.push(context);
  await context.addInitScript(
    ({ relay, slow, language }) => {
      const sockets: WebSocket[] = [];
      const peers: RTCPeerConnection[] = [];
      const fanout = { frames: 0, targets: 0, log: [] as [number, number][] };
      Object.assign(window, { testSockets: sockets, testPeers: peers, testFanout: fanout });
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (data instanceof Uint8Array && data[0] === 1) {
            fanout.frames++;
            fanout.targets += data[1];
            fanout.log.push([Math.round(performance.now()), data[1]]);
          }
          super.send(data);
        }
      };
      const NativePeer = window.RTCPeerConnection;
      if (relay)
        Object.defineProperty(window, 'RTCPeerConnection', {
          value: class {
            constructor() {
              throw new Error('Direct network unavailable');
            }
          },
          configurable: true,
        });
      else
        window.RTCPeerConnection = class extends NativePeer {
          constructor(config?: RTCConfiguration) {
            super(config);
            peers.push(this);
          }
        };
      // Slow disk writes keep a transfer in progress long enough to interrupt it.
      if (slow) {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          postMessage(message: unknown, transfer: Transferable[]): void {
            if ((message as { command?: string }).command === 'write')
              setTimeout(() => super.postMessage(message, transfer), 60);
            else super.postMessage(message, transfer);
          }
        };
      }
      if (language) localStorage.setItem('widesend-language', language);
    },
    { relay: !!options.relay, slow: !!options.slow, language: options.language ?? 'en' },
  );
  const page = await context.newPage();
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.goto('/');
  return { page, context, downloads };
}
async function createRoom(
  page: Page,
  settings: { approve?: boolean; size?: string; send?: string } = {},
  name = 'Owner',
): Promise<string> {
  await page.getByRole('tab', { name: 'Create a room' }).click();
  await page.getByTestId('room-name').fill(name);
  if (settings.approve) await page.getByLabel('Only people I approve').check();
  if (settings.size) await page.getByLabel('Room size').selectOption(settings.size);
  if (settings.send) await page.getByLabel('Who can send').selectOption(settings.send);
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByTestId('room-code')).toHaveText(/^[A-Z0-9]{6}$/);
  return (await page.getByTestId('room-code').textContent())!;
}
async function joinRoom(page: Page, code: string, name: string) {
  await page.getByRole('tab', { name: 'Join a room' }).click();
  await page.getByTestId('room-name').fill(name);
  await page.getByRole('group', { name: 'Room code' }).getByRole('textbox').first().fill(code);
  await page.getByRole('button', { name: 'Join room' }).click();
}
const people = (page: Page) => page.getByTestId('room-members').locator('li');
async function inRoom(...pages: [number, ...Page[]]) {
  const [count, ...rest] = pages;
  for (const page of rest) await expect(people(page)).toHaveCount(count, { timeout: 30_000 });
}
const everyone = { send: 'everyone' };
async function details(page: Page) {
  const panel = page.getByTestId('room-details');
  if (!(await panel.evaluate((d) => (d as HTMLDetailsElement).open)))
    await panel.locator(':scope > summary').click();
}
// The To: row only shows when there's more than one person to choose from.
async function choose(page: Page, to: string[]) {
  const row = page.getByTestId('room-recipients');
  if (!(await row.count())) return;
  const all = row.getByLabel('Everyone', { exact: true });
  if (to.includes('Everyone')) return all.check();
  await all.uncheck();
  for (const name of to) await row.getByLabel(name, { exact: true }).check();
}
type Source = { name: string; mimeType: string; buffer: Buffer };
async function share(page: Page, files: Source[], to: string[] = ['Everyone']) {
  await page.getByTestId('room-file-input').setInputFiles(files);
  await choose(page, to);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function say(page: Page, text: string, to: string[] = ['Everyone']) {
  await choose(page, to);
  await page.getByTestId('composer-text').fill(text);
  await page.getByTestId('composer-text').press('Enter');
}
// A synthetic paste carrying a file. Firefox ignores clipboardData on synthetic
// events, so there the same file is dropped on the composer instead.
async function paste(page: Page, file: Source) {
  await page.getByTestId('composer-text').evaluate(
    (box, f) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.mimeType }));
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      if (event.clipboardData?.files.length) box.dispatchEvent(event);
      else
        box.dispatchEvent(
          new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }),
        );
    },
    { name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] },
  );
}
const messages = (page: Page) => page.getByTestId('message-text');
// The newest item that came in, and my newest delivery to `name`.
const offer = (page: Page) => page.getByTestId('incoming-offer').last();
const delivery = (page: Page, name: string) =>
  page.locator(`[data-testid=delivery][data-member="${name}"]`).last();
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function expectDownloads(m: Member, files: Source[], item = offer(m.page)) {
  const links = item.getByTestId('kept-download');
  await expect(links).toHaveCount(files.length, { timeout: 60_000 });
  const before = m.downloads.length;
  for (let i = 0; i < files.length; i++) await links.nth(i).click();
  await expect.poll(() => m.downloads.length, { timeout: 60_000 }).toBe(before + files.length);
  for (const file of files) {
    const download = m.downloads.slice(before).find((d) => d.suggestedFilename() === file.name);
    expect(download, file.name).toBeDefined();
    expect(sha(await readFile((await download!.path())!)), file.name).toBe(sha(file.buffer));
  }
}
const direct = (browser: Browser) => browser.browserType().name() !== 'firefox';
// A 1×1 PNG.
const png = {
  name: 'pasted.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
};
const shown = (image: ReturnType<Page['getByTestId']>) =>
  expect
    .poll(() => image.evaluate((i) => (i as HTMLImageElement).naturalWidth), { timeout: 30_000 })
    .toBeGreaterThan(0);

test('two people talk: Enter sends, Shift+Enter adds a line, pasted images show inline', async ({
  browser,
}) => {
  const [owner, alice] = await Promise.all([member(browser), member(browser)]);
  const code = await createRoom(owner.page, everyone);
  await joinRoom(alice.page, code, 'Alice');
  await inRoom(2, owner.page, alice.page);
  // Only one person to send to: no To row.
  await expect(owner.page.getByTestId('room-recipients')).toHaveCount(0);
  const box = owner.page.getByTestId('composer-text');
  await box.fill('Hello');
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  await expect(messages(alice.page)).toHaveText(['Hello\nsecond line']);
  await expect(owner.page.getByTestId('timeline-item').last()).toContainText('Delivered');
  // Safari sends the Enter that confirms an input method's text just after
  // compositionend, with isComposing false: it must not send the message. Other
  // browsers flag that Enter as composing.
  if (browser.browserType().name() === 'webkit') {
    await box.fill('你好');
    await box.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '你好' }));
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await expect(box).toHaveValue('你好');
    await box.fill('');
  }
  await say(alice.page, 'Hi! 你好');
  await expect(messages(owner.page)).toHaveText(['Hello\nsecond line', 'Hi! 你好']);
  await paste(owner.page, png);
  await expect(owner.page.getByTestId('staged-file')).toContainText('pasted.png');
  await owner.page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(offer(alice.page)).toHaveAttribute('data-status', 'complete', { timeout: 60_000 });
  await shown(offer(alice.page).getByTestId('kept-image'));
  // A received file never opens as a page of this site (its type is the sender's claim).
  await expect(offer(alice.page).locator('a:has([data-testid=kept-image])')).toHaveCount(0);
  await shown(owner.page.getByTestId('outgoing-offer').last().getByTestId('kept-image'));
  await expectDownloads(alice, [png]);
  await expect(delivery(owner.page, 'Alice')).toHaveAttribute('data-status', 'complete');
  if (browser.browserType().name() === 'chromium') {
    await alice.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await alice.page
      .getByTestId('timeline-item')
      .first()
      .getByRole('button', { name: 'Copy' })
      .click();
    expect(await alice.page.evaluate(() => navigator.clipboard.readText())).toBe(
      'Hello\nsecond line',
    );
  }
});

test('small sends arrive by themselves, verified, and only for the people chosen', async ({
  browser,
}) => {
  const [owner, alice, bob] = await Promise.all([
    member(browser),
    member(browser),
    member(browser),
  ]);
  const code = await createRoom(owner.page, everyone);
  await joinRoom(alice.page, code, 'Alice');
  await joinRoom(bob.page, code, 'Bob');
  await inRoom(3, owner.page, alice.page, bob.page);
  await say(owner.page, 'for everyone');
  await say(owner.page, 'only for Bob', ['Bob']);
  await expect(messages(bob.page)).toHaveText(['for everyone', 'only for Bob']);
  await expect(bob.page.getByTestId('timeline-item').last()).toContainText('To you');
  await expect(messages(alice.page)).toHaveText(['for everyone']);
  // The choice is remembered for the next send.
  await expect(owner.page.getByTestId('room-recipients').getByLabel('Bob')).toBeChecked();
  const files = [
    { name: 'report.pdf', mimeType: 'application/pdf', buffer: randomBytes(1_700_000) },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
  ];
  await share(owner.page, files, ['Everyone']);
  for (const m of [alice, bob]) {
    await expect(offer(m.page)).toHaveAttribute('data-status', 'complete', { timeout: 60_000 });
    await expect(m.page.getByTestId('timeline-item').last()).toContainText('Owner');
    await expectDownloads(m, files);
  }
  await expect(delivery(owner.page, 'Alice')).toHaveAttribute('data-status', 'complete');
  await expect(delivery(owner.page, 'Bob')).toHaveAttribute('data-status', 'complete');
  if (direct(browser)) await expect(offer(alice.page)).toHaveAttribute('data-route', 'direct');
});

test('a send over 100 MiB waits for Accept or Decline', async ({ browser }) => {
  test.skip(browser.browserType().name() !== 'chromium', 'One browser is enough for 100 MiB.');
  const [owner, alice, bob] = await Promise.all([
    member(browser),
    member(browser),
    member(browser),
  ]);
  const code = await createRoom(owner.page);
  await joinRoom(alice.page, code, 'Alice');
  await joinRoom(bob.page, code, 'Bob');
  await inRoom(3, owner.page, alice.page, bob.page);
  const path = 'test-results/over-limit.bin';
  const buffer = randomBytes(100 * 1024 * 1024 + 1);
  await writeFile(path, buffer);
  try {
    await owner.page.getByTestId('room-file-input').setInputFiles(path);
    await owner.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(offer(alice.page)).toHaveAttribute('data-status', 'offered', { timeout: 60_000 });
    await expect(offer(bob.page)).toHaveAttribute('data-status', 'offered');
    await bob.page.getByRole('button', { name: 'Decline' }).click();
    await alice.page.getByRole('button', { name: 'Accept' }).click();
    await expect(offer(alice.page)).toHaveAttribute('data-status', 'complete', {
      timeout: 120_000,
    });
    await expectDownloads(alice, [{ name: 'over-limit.bin', mimeType: '', buffer }]);
    await expect(delivery(owner.page, 'Bob')).toHaveAttribute('data-status', 'declined');
  } finally {
    await rm(path, { force: true });
  }
});

test('relay pieces fan out: two recipients cost less than two uploads', async ({ browser }) => {
  // Realistically paced recipients keep both transfers in flight together.
  const [owner, alice, bob] = await Promise.all([
    member(browser, { relay: true }),
    member(browser, { relay: true, slow: true }),
    member(browser, { relay: true, slow: true }),
  ]);
  const code = await createRoom(owner.page);
  await joinRoom(alice.page, code, 'Alice');
  await joinRoom(bob.page, code, 'Bob');
  await inRoom(3, owner.page, alice.page, bob.page);
  const pieces = 16;
  const files = [
    {
      name: 'video.bin',
      mimeType: 'application/octet-stream',
      buffer: randomBytes(pieces * 512 * 1024 - 7),
    },
  ];
  await share(owner.page, files, ['Everyone']);
  for (const m of [alice, bob])
    await expect(offer(m.page)).toHaveAttribute('data-status', 'complete', { timeout: 90_000 });
  await expectDownloads(alice, files);
  await expectDownloads(bob, files);
  await expect(offer(alice.page)).toHaveAttribute('data-route', 'relay');
  const fanout = await owner.page.evaluate(
    () =>
      (window as unknown as { testFanout: { frames: number; targets: number; log: unknown[] } })
        .testFanout,
  );
  expect(fanout.targets).toBeGreaterThanOrEqual(2 * pieces);
  expect(fanout.frames).toBeLessThan(2 * pieces);
});

test('in approval mode the owner lets one person in and turns another away', async ({
  browser,
}) => {
  const [owner, alice, mallory] = await Promise.all([
    member(browser),
    member(browser),
    member(browser),
  ]);
  const code = await createRoom(owner.page, { approve: true });
  await joinRoom(alice.page, code, 'Alice');
  await expect(alice.page.getByTestId('room-pending')).toContainText(
    'Waiting for the room creator to let you in',
  );
  const requests = owner.page.getByTestId('join-requests');
  await expect(requests).toContainText('Alice wants to join');
  await requests.getByRole('button', { name: 'Allow' }).click();
  await inRoom(2, owner.page, alice.page);
  await joinRoom(mallory.page, code, 'Mallory');
  await expect(requests).toContainText('Mallory wants to join');
  await expect(requests.getByRole('button', { name: 'Allow' })).toBeEnabled();
  await requests.getByRole('button', { name: 'Deny' }).click();
  await expect(mallory.page.getByTestId('room-ended')).toHaveAttribute('data-reason', 'declined');
  await expect(mallory.page.getByRole('heading', { name: 'Request declined' })).toBeVisible();
  await inRoom(2, owner.page);
});

test('a full room turns away the next person', async ({ browser }) => {
  const [owner, alice, late] = await Promise.all([
    member(browser),
    member(browser),
    member(browser),
  ]);
  const code = await createRoom(owner.page, { size: '2' });
  await joinRoom(alice.page, code, 'Alice');
  await inRoom(2, owner.page, alice.page);
  await joinRoom(late.page, code, 'Late');
  await expect(late.page.getByRole('heading', { name: 'Room full' })).toBeVisible();
});

test('only the owner sends by default; hand-in lets members reach only the owner', async ({
  browser,
}) => {
  const [owner, alice, bob] = await Promise.all([
    member(browser),
    member(browser),
    member(browser),
  ]);
  const code = await createRoom(owner.page);
  await joinRoom(alice.page, code, 'Alice');
  await joinRoom(bob.page, code, 'Bob');
  await inRoom(3, owner.page, alice.page, bob.page);
  await expect(alice.page.getByTestId('composer')).toHaveCount(0);
  await expect(alice.page.getByText('Only the room creator can send in this room.')).toBeVisible();
  await say(owner.page, 'Welcome, class');
  await expect(messages(alice.page)).toHaveText(['Welcome, class']);
  await details(owner.page);
  await owner.page.getByText('Room settings').click();
  await owner.page.getByLabel('Who can send').selectOption('to-owner');
  await owner.page.getByRole('button', { name: 'Save settings' }).click();
  await expect(alice.page.getByTestId('composer')).toBeVisible();
  // Only the owner can be chosen, so there is no To row.
  await expect(alice.page.getByTestId('room-recipients')).toHaveCount(0);
  await say(alice.page, 'my answer');
  await expect(messages(owner.page)).toHaveText(['Welcome, class', 'my answer']);
  const homework = { name: 'homework.txt', mimeType: 'text/plain', buffer: Buffer.from('ok') };
  await share(alice.page, [homework]);
  await expect(offer(owner.page)).toHaveAttribute('data-status', 'complete');
  await expectDownloads(owner, [homework]);
  await expect(messages(bob.page)).toHaveText(['Welcome, class']);
  await expect(bob.page.getByTestId('incoming-offer')).toHaveCount(0);
});

test('a transfer survives a dropped connection', async ({ browser }) => {
  const [owner, alice] = await Promise.all([member(browser), member(browser, { slow: true })]);
  const code = await createRoom(owner.page);
  await joinRoom(alice.page, code, 'Alice');
  await inRoom(2, owner.page, alice.page);
  const files = [
    {
      name: 'large.bin',
      mimeType: 'application/octet-stream',
      buffer: randomBytes(40 * 512 * 1024),
    },
  ];
  await share(owner.page, files);
  const progress = offer(alice.page).getByRole('progressbar');
  await expect
    .poll(async () => Number(await progress.getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);
  expect(Number(await progress.getAttribute('aria-valuenow'))).toBeLessThan(100);
  await alice.page.evaluate(() => {
    const w = window as unknown as { testSockets: WebSocket[]; testPeers: RTCPeerConnection[] };
    w.testSockets.forEach((ws) => ws.close());
    w.testPeers.forEach((pc) => pc.close());
  });
  await expect(offer(alice.page)).toHaveAttribute('data-status', 'complete', { timeout: 90_000 });
  await expectDownloads(alice, files);
  await expect(delivery(owner.page, 'Alice')).toHaveAttribute('data-status', 'complete');
});

test('reloading keeps the conversation, rejoins without approval and ends that page’s transfer', async ({
  browser,
}) => {
  const [owner, alice] = await Promise.all([member(browser), member(browser, { slow: true })]);
  const code = await createRoom(owner.page, { approve: true });
  await joinRoom(alice.page, code, 'Alice');
  await owner.page.getByTestId('join-requests').getByRole('button', { name: 'Allow' }).click();
  await inRoom(2, owner.page, alice.page);
  await say(owner.page, 'before the reload');
  await expect(messages(alice.page)).toHaveText(['before the reload']);
  await share(owner.page, [
    { name: 'big.bin', mimeType: 'application/octet-stream', buffer: randomBytes(40 * 512 * 1024) },
  ]);
  await expect(delivery(owner.page, 'Alice')).toHaveAttribute('data-status', 'transferring');
  await alice.page.reload();
  await inRoom(2, alice.page);
  await expect(owner.page.getByTestId('join-requests')).toHaveCount(0);
  await expect(messages(alice.page)).toHaveText(['before the reload']);
  await expect(delivery(owner.page, 'Alice')).toHaveAttribute('data-status', 'failed', {
    timeout: 30_000,
  });
  await expect(delivery(owner.page, 'Alice')).toContainText('reloaded or closed the page');
  await expect(offer(alice.page)).toHaveAttribute('data-status', 'failed');
});

test('a closed room stays in Past rooms until it is deleted', async ({ browser }) => {
  const [owner, alice] = await Promise.all([member(browser), member(browser)]);
  const code = await createRoom(owner.page, everyone);
  await joinRoom(alice.page, code, 'Alice');
  await inRoom(2, owner.page, alice.page);
  await say(owner.page, 'keep this');
  await paste(owner.page, png);
  await owner.page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(offer(alice.page)).toHaveAttribute('data-status', 'complete', { timeout: 60_000 });
  await alice.page.reload();
  await inRoom(2, alice.page);
  await expect(messages(alice.page)).toHaveText(['keep this']);
  await shown(offer(alice.page).getByTestId('kept-image'));
  await owner.page.getByTestId('dismiss-room').click();
  await owner.page.getByTestId('dismiss-room').click();
  await expect(alice.page.getByTestId('room-ended')).toHaveAttribute('data-reason', 'dismissed');
  // The conversation stays readable after the room ends.
  await expect(messages(alice.page)).toHaveText(['keep this']);
  await alice.page.getByRole('button', { name: 'Back' }).click();
  const past = alice.page.getByTestId('past-room').filter({ hasText: 'Owner' });
  await expect(past).toHaveCount(1);
  // Past rooms are listed under both room tabs.
  await alice.page.getByRole('tab', { name: 'Create a room' }).click();
  await expect(past).toHaveCount(1);
  await alice.page.getByRole('tab', { name: 'Join a room' }).click();
  await past.getByRole('button', { name: 'View' }).click();
  await expect(messages(alice.page)).toHaveText(['keep this']);
  await shown(alice.page.getByTestId('kept-image'));
  await alice.page.getByRole('button', { name: 'Back' }).click();
  await past.getByRole('button', { name: 'Delete' }).click();
  await past.getByRole('button', { name: 'Delete?' }).click();
  await expect(alice.page.getByTestId('past-room')).toHaveCount(0);
});

test('joiners wait while the room creator is away', async ({ browser }) => {
  const [owner, alice] = await Promise.all([member(browser), member(browser)]);
  const code = await createRoom(owner.page);
  await owner.page.close();
  await joinRoom(alice.page, code, 'Alice');
  await expect(alice.page.getByTestId('room-pending')).toContainText('The room creator is offline');
  const back = await owner.context.newPage();
  await back.goto('/');
  await inRoom(2, back, alice.page);
});

test('the owner removes a member and closes the room for everyone', async ({ browser }) => {
  const [owner, alice, bob] = await Promise.all([
    member(browser),
    member(browser),
    member(browser),
  ]);
  const code = await createRoom(owner.page);
  await joinRoom(alice.page, code, 'Alice');
  await joinRoom(bob.page, code, 'Bob');
  await inRoom(3, owner.page, alice.page, bob.page);
  await details(owner.page);
  const remove = owner.page.getByRole('button', { name: 'Remove Alice' });
  await remove.click();
  await remove.click();
  await expect(alice.page.getByRole('heading', { name: 'Removed from the room' })).toBeVisible();
  await inRoom(2, owner.page, bob.page);
  await owner.page.getByTestId('dismiss-room').click();
  await owner.page.getByTestId('dismiss-room').click();
  await expect(bob.page.getByRole('heading', { name: 'Room closed' })).toBeVisible();
  await expect(owner.page.getByTestId('room-ended')).toHaveAttribute('data-reason', 'dismissed');
  // Going back shows the home screen again.
  await bob.page.getByRole('button', { name: 'Back' }).click();
  await expect(bob.page.getByRole('tab', { name: 'Join a room' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('a phone joins in Chinese and a long message fits the screen', async ({ browser }) => {
  const owner = await member(browser);
  const phone = await member(browser, { mobile: true, language: 'zh' });
  const code = await createRoom(owner.page, everyone);
  await phone.page.getByRole('tab', { name: '加入房间' }).click();
  await phone.page.getByTestId('room-name').fill('手机');
  await phone.page.getByRole('group', { name: '房间代码' }).getByRole('textbox').first().fill(code);
  await phone.page.getByRole('button', { name: '加入房间' }).click();
  await inRoom(2, owner.page, phone.page);
  await expect(phone.page.getByText('房间详情')).toBeVisible();
  await expect(phone.page.getByTestId('composer-text')).toHaveAttribute('placeholder', '写消息');
  const long = 'x'.repeat(2000);
  await say(owner.page, long);
  await expect(messages(phone.page)).toHaveText([long]);
  // On a touch screen Enter adds a line; the Send button sends.
  const box = phone.page.getByTestId('composer-text');
  await box.fill('第一行');
  await box.press('Enter');
  await box.pressSequentially('第二行');
  await phone.page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(messages(owner.page)).toHaveText([long, '第一行\n第二行']);
  expect(
    await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test('a room link opens the join form with the code filled in', async ({ browser }) => {
  const [owner, alice] = await Promise.all([member(browser), member(browser)]);
  const code = await createRoom(owner.page);
  // A shared link opens a fresh page.
  const page = await alice.context.newPage();
  await page.goto(`/#room=${code}`);
  await expect(page.getByRole('tab', { name: 'Join a room' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const boxes = page.getByRole('group', { name: 'Room code' }).getByRole('textbox');
  await expect
    .poll(() =>
      boxes.evaluateAll((inputs) => inputs.map((i) => (i as HTMLInputElement).value).join('')),
    )
    .toBe(code);
  await page.getByTestId('room-name').fill('Alice');
  await page.getByRole('button', { name: 'Join room' }).click();
  await inRoom(2, owner.page, page);
});

test('the home screen has four tabs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tablist', { name: 'Transfer mode' }).getByRole('tab')).toHaveText([
    'Send files',
    'Receive files',
    'Create a room',
    'Join a room',
  ]);
  await page.getByRole('tab', { name: 'Create a room' }).click();
  await expect(page.getByRole('button', { name: 'Create room' })).toBeVisible();
  await expect(page.getByLabel('Who can send')).toBeVisible();
  await page.getByRole('tab', { name: 'Join a room' }).click();
  await expect(page.getByRole('button', { name: 'Join room' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Room code' })).toBeVisible();
  // The room screens no longer have their own create/join switch.
  await expect(page.getByRole('tablist', { name: 'Room options' })).toHaveCount(0);
});
