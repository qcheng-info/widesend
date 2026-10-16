import {
  test,
  expect,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
  type Download,
} from '@playwright/test';
import { readFile, open, mkdir, unlink, mkdtemp, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { CHUNK_SIZE, MAX_FRAME, MAX_RELAY_FRAME, RELAY_BATCH_SIZE } from '../../shared/protocol';

const contexts: BrowserContext[] = [];
const downloads = new WeakMap<Page, Download[]>();
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
});

async function pair(
  browser: Browser,
  relay = false,
  mobile = false,
  slow = false,
  persistent = false,
  receiverType = browser.browserType(),
) {
  const senderContext = await browser.newContext();
  const receiverOptions = mobile
    ? {
        viewport: { width: 390, height: 844 },
        isMobile: receiverType.name() !== 'firefox',
        hasTouch: true,
      }
    : {};
  // WebKit's nonpersistent test contexts are private browsing, which denies OPFS.
  // Use a normal isolated profile to exercise Safari's actual disk-backed path.
  await mkdir('test-results', { recursive: true });
  const profile =
    receiverType.name() === 'webkit' ||
    persistent ||
    receiverType.name() !== browser.browserType().name()
      ? await mkdtemp('test-results/browser-profile-')
      : undefined;
  const receiverContext = profile
    ? await receiverType.launchPersistentContext(profile, {
        baseURL: 'http://localhost:8788',
        acceptDownloads: true,
        ...receiverOptions,
        channel: receiverType.name() === 'chromium' ? 'chrome' : undefined,
      })
    : await browser.newContext(receiverOptions);
  if (profile) {
    const close = receiverContext.close.bind(receiverContext);
    receiverContext.close = async (options) => {
      try {
        await close(options);
      } finally {
        await rm(profile, { recursive: true, force: true });
      }
    };
  }
  contexts.push(senderContext, receiverContext);
  for (const context of [senderContext, receiverContext]) {
    await context.addInitScript(
      ({ relay, slow }) => {
        const sockets: WebSocket[] = [],
          peers: RTCPeerConnection[] = [];
        Object.assign(window, { testSockets: sockets, testPeers: peers });
        const NativeSocket = window.WebSocket;
        window.WebSocket = class extends NativeSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            sockets.push(this);
          }
        };
        const NativePeer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePeer {
          constructor(config?: RTCConfiguration) {
            super(config);
            peers.push(this);
          }
        };
        if (slow) {
          const NativeWorker = window.Worker;
          window.Worker = class extends NativeWorker {
            postMessage(message: unknown, transfer: Transferable[]): void {
              if ((message as { command?: string }).command === 'write')
                setTimeout(() => super.postMessage(message, transfer), 8);
              else super.postMessage(message, transfer);
            }
          };
        }
        // Exercise the OPFS path used on mobile rather than a native picker dialog.
        Object.defineProperty(window, 'showSaveFilePicker', {
          value: undefined,
          configurable: true,
        });
        Object.defineProperty(window, 'showDirectoryPicker', {
          value: undefined,
          configurable: true,
        });
        if (relay)
          Object.defineProperty(window, 'RTCPeerConnection', {
            value: class {
              constructor() {
                throw new Error('Direct network unavailable');
              }
            },
            configurable: true,
          });
      },
      { relay, slow },
    );
  }
  const sender = await senderContext.newPage(),
    receiver = await receiverContext.newPage();
  downloads.set(receiver, []);
  receiver.on('download', (download) => downloads.get(receiver)!.push(download));
  await sender.goto('/');
  await receiver.goto('/');
  return { sender, receiver, senderContext, receiverContext };
}
async function enterCode(page: Page, code: string) {
  const boxes = page.getByRole('group', { name: 'Transfer code' }).getByRole('textbox');
  await expect(boxes).toHaveCount(6);
  await boxes.first().fill(code.toLowerCase());
  await expect
    .poll(() =>
      boxes.evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value).join(''),
      ),
    )
    .toBe(code);
}
async function invite(
  sender: Page,
  receiver: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) {
  await sender.getByTestId('file-input').setInputFiles(files);
  await sender.getByRole('button', { name: 'Create transfer' }).click();
  const code = await sender.getByTestId('transfer-code').textContent();
  await receiver.getByRole('tab', { name: 'Receive files' }).click();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  await expect(sender.getByAltText(/Scan this QR/)).toHaveCount(0);
  await enterCode(receiver, code!);
  await receiver.getByRole('button', { name: 'Connect to sender' }).click();
}
async function send(
  sender: Page,
  receiver: Page,
  files: { name: string; mimeType: string; buffer: Buffer }[],
) {
  await invite(sender, receiver, files);
  await expect(receiver.getByRole('heading', { name: 'Ready to receive.' })).toBeVisible();
  await receiver.getByRole('button', { name: 'Receive' }).click();
  await expect(receiver.getByRole('progressbar')).toBeVisible();
}
async function checkDownload(receiver: Page, index: number, expected: Buffer) {
  await expect.poll(() => downloads.get(receiver)!.length).toBeGreaterThan(index);
  const download = downloads.get(receiver)![index];
  const data = await readFile((await download.path())!);
  expect(createHash('sha256').update(data).digest('hex')).toBe(
    createHash('sha256').update(expected).digest('hex'),
  );
}

test('automatic transfer writes exact bytes for multiple files, including an empty file', async ({
  browser,
}) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(browser);
  const files = [
    {
      name: 'photo.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(4 * 1024 * 1024 + 123, 0x42),
    },
    { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) },
    { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('Hello from WideSend 👋') },
  ];
  await send(sender, receiver, files);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  // This host's automated Firefox has no usable ICE candidates; its relay path is still checked.
  if (browser.browserType().name() !== 'firefox')
    await expect
      .poll(() =>
        receiver.evaluate(() =>
          (window as unknown as { testPeers: RTCPeerConnection[] }).testPeers.some(
            (peer) => peer.connectionState === 'connected',
          ),
        ),
      )
      .toBe(true);
  for (let i = 0; i < files.length; i++) await checkDownload(receiver, i, files[i].buffer);
  await senderContext.close();
  await receiverContext.close();
});
test('encrypted relay works on a mobile-sized receiver and produces exact bytes', async ({
  browser,
}) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(browser, true, true);
  const buffer = Buffer.alloc(8 * 1024 * 1024 + 17);
  for (let i = 0; i < buffer.length; i++) buffer[i] = i % 251;
  await send(sender, receiver, [
    { name: 'mobile-video.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await expect(receiver.getByTestId('connection-status')).toHaveText(/Connected|Received/);
  expect(await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await checkDownload(receiver, 0, buffer);
  await receiver.screenshot({ path: 'test-results/mobile-complete.png', fullPage: true });
  await senderContext.close();
  await receiverContext.close();
});

test('a modified key confirmation fails before any file data is sent', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true);
  await sender.evaluate(() => {
    (window as any).fileFrames = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === 1)
        (window as any).fileFrames++;
      return send.call(this, data);
    };
  });
  await receiver.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === 'string' && data.startsWith('{')) {
        const message = JSON.parse(data);
        if (message.type === 'key-exchange' && message.step === 'confirm') {
          message.signature = '00'.repeat(64);
          data = JSON.stringify(message);
        }
      }
      return send.call(this, data);
    };
  });
  await invite(sender, receiver, [
    { name: 'private.bin', mimeType: '', buffer: Buffer.alloc(1024) },
  ]);
  await expect(
    sender.getByText('Could not verify the other device. Start again with a new code.'),
  ).toBeVisible();
  expect(await sender.evaluate(() => (window as any).fileFrames)).toBe(0);
  expect(downloads.get(receiver)).toHaveLength(0);
});

test('mixed versions preserve progress and refresh into the new encryption', async ({
  browser,
}) => {
  const { sender, receiver } = await pair(browser, true);
  // Simulate the old hello. Refresh removes this override from both pages.
  await receiver.evaluate(() => {
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (Array.isArray(protocols)) {
          const hello = JSON.parse(atob(protocols[1].replace(/-/g, '+').replace(/_/g, '/')));
          delete hello.keyExchange;
          protocols = [
            protocols[0],
            btoa(JSON.stringify(hello)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
          ];
        }
        super(url, protocols);
      }
    };
  });
  const original = {
    name: 'upgrade.bin',
    mimeType: '',
    buffer: Buffer.alloc(1024 * 1024 + 17, 51),
  };
  await invite(sender, receiver, [original]);
  await expect(receiver.getByText('Refresh WideSend on both devices to continue.')).toBeVisible();
  expect(await recoveryRecords(receiver)).toHaveLength(1);
  expect(await recoveryRecords(sender)).toHaveLength(1);
  await receiver.reload();
  await sender.reload();
  await sender.getByTestId('original-files').setInputFiles(original);
  await receiver.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 0, original.buffer);
});

test('a lost confirmation resumes with the original local device keys', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true, false, true);
  let blocked = false;
  let intercept = true;
  await receiver.routeWebSocket(/\/api\/rooms\//, (route) => {
    const server = route.connectToServer();
    server.onMessage((data) => {
      if (intercept && typeof data === 'string' && data.startsWith('{')) {
        const message = JSON.parse(data);
        if (message.type === 'key-exchange' && message.step === 'confirm') {
          blocked = true;
          return;
        }
      }
      if (!intercept || !blocked) route.send(data);
    });
  });
  await receiver.reload();
  const original = {
    name: 'pairing-interruption.bin',
    mimeType: '',
    buffer: Buffer.alloc(4 * 1024 * 1024 + 7, 19),
  };
  await invite(sender, receiver, [original]);
  await expect.poll(() => blocked).toBe(true);
  await expect.poll(async () => (await recoveryRecords(sender))[0]?.identity?.peerKey).toBeTruthy();
  const before = (await recoveryRecords(receiver))[0];
  expect(before.identity?.peerKey).toBeUndefined();
  expect(before.identity?.privateKey?.extractable).toBe(false);
  // Disable interception for the next socket without changing browser storage.
  expect((await recoveryRecords(sender))[0].identity?.peerKey).toBe(before.identity?.publicKey);
  intercept = false;
  await receiver.reload();
  await receiver.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 0, original.buffer);
});

async function countRelayMessages(page: Page, compatibility?: 'receiver' | 'server') {
  await page.evaluate((compatibility) => {
    const traffic = { binary: 0, drains: 0, batches: 0, largest: 0 };
    Object.assign(window, { relayTraffic: traffic });
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        traffic.binary++;
        traffic.largest = Math.max(traffic.largest, data.byteLength);
        if (data.byteLength > 256 * 1024) traffic.batches++;
      } else if (
        typeof data === 'string' &&
        data.startsWith('{') &&
        JSON.parse(data).type === 'drain'
      )
        traffic.drains++;
      return originalSend.call(this, data);
    };
    if (compatibility === 'receiver') {
      // An old receiver does not advertise support in its authenticated ready.
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      crypto.subtle.encrypt = async (algorithm, key, data) => {
        let bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        if (bytes[0] === 0) {
          const control = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (control.type === 'ready') {
            delete control.relayBatch;
            const json = new TextEncoder().encode(JSON.stringify(control));
            bytes = new Uint8Array(json.length + 1);
            bytes.set(json, 1);
          }
        }
        return encrypt(algorithm, key, bytes);
      };
    }
    if (compatibility === 'server') {
      // Exercise the legacy server response by omitting the opt-in handshake.
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(url: string | URL, protocols?: string | string[]) {
          if (Array.isArray(protocols) && protocols[0] === 'widesend') {
            const hello = JSON.parse(atob(protocols[1].replace(/-/g, '+').replace(/_/g, '/')));
            delete hello.relayBatch;
            protocols = [
              'widesend',
              btoa(JSON.stringify(hello))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, ''),
            ];
          }
          super(url, protocols);
        }
      };
    }
  }, compatibility);
}
async function relayTraffic(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          relayTraffic: { binary: number; drains: number; batches: number; largest: number };
        }
      ).relayTraffic,
  );
}

test('relay batches reduce real message traffic while keeping exact bytes and a mobile receiver', async ({
  browser,
}, info) => {
  const { sender, receiver } = await pair(browser, true, true);
  await countRelayMessages(sender);
  await countRelayMessages(receiver);
  const buffer = Buffer.alloc(32 * 1024 * 1024 + 17, 0x63);
  await send(sender, receiver, [
    { name: 'batched.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 0, buffer);
  await receiver.waitForTimeout(100); // Include the last coalesced credit.
  const sending = await relayTraffic(sender),
    receiving = await relayTraffic(receiver);
  expect(sending.batches).toBe(Math.floor(buffer.length / RELAY_BATCH_SIZE));
  expect(sending.largest).toBe(MAX_RELAY_FRAME + 1); // File/control envelope on ingress only.
  const messages = sending.binary + sending.drains + receiving.binary + receiving.drains;
  const oldFileMessages =
    Math.ceil(buffer.length / CHUNK_SIZE) * 2 + Math.ceil(buffer.length / (4 * CHUNK_SIZE)) * 2;
  // Include negotiation, diagnostics and completion in the new count, so this
  // is a conservative comparison against the previous file-only traffic.
  expect(messages).toBeLessThan(oldFileMessages / 8);
  await info.attach('relay-message-counts', {
    body: JSON.stringify({
      sending,
      receiving,
      messages,
      oldFileMessages,
      reduction: oldFileMessages / messages,
    }),
    contentType: 'application/json',
  });
});

for (const compatibility of ['receiver', 'server'] as const) {
  test(`relay keeps legacy chunks when ${compatibility} does not advertise batching`, async ({
    browser,
  }) => {
    const { sender, receiver } = await pair(browser, true);
    await countRelayMessages(sender, compatibility === 'server' ? compatibility : undefined);
    await countRelayMessages(receiver, compatibility);
    const buffer = Buffer.alloc(4 * 1024 * 1024 + 17, 0x64);
    await send(sender, receiver, [
      { name: 'compatible.bin', mimeType: 'application/octet-stream', buffer },
    ]);
    await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
    await checkDownload(receiver, 0, buffer);
    expect((await relayTraffic(sender)).batches).toBe(0);
    expect((await relayTraffic(sender)).largest).toBeLessThanOrEqual(MAX_FRAME);
  });
}

test('a modified encrypted relay batch fails without offering a download', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true, false, true);
  await sender.evaluate(() => {
    const send = WebSocket.prototype.send;
    let batches = 0;
    WebSocket.prototype.send = function (data) {
      if (data instanceof ArrayBuffer && data.byteLength > 256 * 1024 && ++batches === 2) {
        data = data.slice(0);
        new Uint8Array(data)[data.byteLength - 1] ^= 1;
      }
      return send.call(this, data);
    };
  });
  await send(sender, receiver, [
    {
      name: 'tampered.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(4 * 1024 * 1024, 0x65),
    },
  ]);
  await expect(receiver.getByRole('heading', { name: 'Transfer failed.' })).toBeVisible();
  await expect(receiver.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
  expect(downloads.get(receiver)).toHaveLength(0);
});
test('home layout and invalid invitation are usable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Send files anywhere.');
  await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  await page.getByRole('tab', { name: 'Receive files' }).click();
  await enterCode(page, 'AB123');
  await expect(page.getByRole('button', { name: 'Connect to sender' })).toBeDisabled();
  const boxes = page.getByRole('group', { name: 'Transfer code' }).getByRole('textbox');
  await boxes.nth(5).press('Backspace');
  await expect(boxes.nth(4)).toBeFocused();
  await expect(boxes.nth(4)).toHaveValue('');
  await page.keyboard.type('34');
  await expect(boxes.nth(5)).toHaveValue('4');
  await expect(page.getByRole('button', { name: 'Connect to sender' })).toBeEnabled();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('x');
  await expect(boxes.nth(4)).toHaveValue('X');
  await boxes.nth(2).evaluate((input) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'https://widesend.example/#c9d8e7');
    // Firefox strips data from constructed ClipboardEvents; provide the paste
    // payload explicitly so this exercises the same input handler on each engine.
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: clipboardData });
    input.dispatchEvent(event);
  });
  await expect
    .poll(() =>
      boxes.evaluateAll((inputs) =>
        inputs.map((input) => (input as HTMLInputElement).value).join(''),
      ),
    )
    .toBe('C9D8E7');
  await expect(boxes.nth(5)).toBeFocused();
  await page.keyboard.type('z');
  await expect(boxes.nth(5)).toHaveValue('Z');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/receive-code-mobile.png', fullPage: true });
});

test('direct connection failures fall back to relay without corrupting the file', async ({
  browser,
}) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(
    browser,
    false,
    false,
    true,
  );
  const buffer = Buffer.alloc(12 * 1024 * 1024 + 13, 0x7b);
  await send(sender, receiver, [
    { name: 'fallback.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await sender.getByRole('button', { name: 'Nerd stats', exact: true }).click();
  const direct = () =>
    sender.evaluate(() =>
      (window as unknown as { testPeers: RTCPeerConnection[] }).testPeers.some(
        (peer) => peer.connectionState === 'connected',
      ),
    );
  // This host's automated Firefox sometimes finds no usable ICE candidates and
  // falls back by itself; when it does connect directly, break it like the others.
  if (browser.browserType().name() !== 'firefox') await expect.poll(direct).toBe(true);
  else
    await expect
      .poll(direct, { timeout: 8000 })
      .toBe(true)
      .catch(() => {});
  if (await direct()) {
    await expect
      .poll(async () =>
        Number(await receiver.getByRole('progressbar').getAttribute('aria-valuenow')),
      )
      .toBeGreaterThan(0);
    await sender.evaluate(() =>
      (window as unknown as { testPeers: RTCPeerConnection[] }).testPeers.forEach((pc) =>
        pc.close(),
      ),
    );
  }
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await expect(sender.getByTestId('stats-route')).toHaveText('Cloudflare relay');
  await expect(sender.getByTestId('stats-fallback')).toContainText('Direct connection');
  await expect(sender.getByRole('list', { name: 'Recent events' })).toContainText(
    'Switched to relay',
  );
  if (browser.browserType().name() !== 'firefox')
    await expect(sender.getByRole('list', { name: 'Recent events' })).toContainText(
      'Direct connection established',
    );
  await expect(receiver.getByTestId('connection-status')).toHaveText(/Connected|Received/);
  await checkDownload(receiver, 0, buffer);
  await senderContext.close();
  await receiverContext.close();
});

test('a receiver reconnects and resumes from disk after a network interruption', async ({
  browser,
}) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(
    browser,
    true,
    false,
    true,
  );
  const buffer = Buffer.alloc(12 * 1024 * 1024 + 13, 0x39);
  await send(sender, receiver, [
    { name: 'resume.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect
    .poll(async () => Number(await receiver.getByRole('progressbar').getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);
  await receiverContext.setOffline(true);
  await receiver.evaluate(() =>
    (window as unknown as { testSockets: WebSocket[] }).testSockets.forEach((ws) => ws.close()),
  );
  await expect(receiver.getByRole('heading', { name: 'Reconnecting…' })).toBeVisible();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  // A suspended phone can remain offline well beyond the old 90-second limit.
  await receiver.evaluate(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 120_000;
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await expect(receiver.getByRole('heading', { name: 'Transfer failed.' })).toHaveCount(0);
  await receiverContext.setOffline(false);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await receiver.getByRole('button', { name: 'Nerd stats', exact: true }).click();
  await expect(receiver.getByTestId('stats-reconnects')).not.toHaveText('0');
  await expect(receiver.getByRole('list', { name: 'Recent events' })).toContainText(
    'Transfer resumed',
  );
  await checkDownload(receiver, 0, buffer);
  await senderContext.close();
  await receiverContext.close();
});

test('a temporary admission limit waits without losing received bytes and resumes automatically', async ({
  browser,
}) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(
    browser,
    true,
    false,
    true,
  );
  let attempts = 0;
  let interrupt: (() => Promise<void>) | undefined;
  await receiver.routeWebSocket('**/api/rooms/*', (route) => {
    attempts++;
    if (attempts === 2) {
      route.send(JSON.stringify({ type: 'limited', retryAfter: 60 }));
      route.close({ code: 4013, reason: 'Please wait before reconnecting' });
    } else {
      const server = route.connectToServer();
      interrupt = async () => {
        await route.close();
        await server.close();
      };
    }
  });
  await receiver.reload();
  const buffer = Buffer.alloc(8 * 1024 * 1024 + 19, 0x71);
  await send(sender, receiver, [
    { name: 'limited-resume.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect
    .poll(async () => Number(await receiver.getByRole('progressbar').getAttribute('aria-valuenow')))
    .toBeGreaterThan(0);
  expect(attempts).toBe(1);
  await interrupt!();
  await expect(
    receiver.getByText('WideSend is busy. Keep this tab open; we’ll retry automatically.'),
  ).toBeVisible();
  // A visibility/network event must not bypass the server's retry deadline.
  await receiver.evaluate(() => window.dispatchEvent(new Event('online')));
  await receiver.waitForTimeout(1200);
  expect(attempts).toBe(2);
  await expect(receiver.getByRole('heading', { name: 'Transfer failed.' })).toHaveCount(0);
  await receiver.evaluate(() => {
    const original = Date.now.bind(Date);
    Date.now = () => original() + 61_000;
    window.dispatchEvent(new Event('online'));
  });
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 0, buffer);
  expect(attempts).toBe(3);
  await senderContext.close();
  await receiverContext.close();
});

test('a relay budget cooldown waits automatically without sending file data or losing pairing', async ({
  browser,
}) => {
  const { sender, receiver } = await pair(browser, true);
  let restricted = true,
    fileFrames = 0,
    connections = 0;
  for (const page of [sender, receiver])
    await page.routeWebSocket('**/api/rooms/*', (route) => {
      connections++;
      const server = route.connectToServer();
      route.onMessage((data) => {
        if (
          typeof data === 'string' &&
          data.startsWith('{') &&
          JSON.parse(data).type === 'relay-request' &&
          restricted
        ) {
          route.send(JSON.stringify({ type: 'relay-limited', retryAfter: 60 }));
          return;
        }
        if (typeof data !== 'string' && data[0] === 1) fileFrames++;
        server.send(data);
      });
    });
  // Install interception before the page's socket instrumentation captures the
  // WebSocket constructor, as with the connection-cooldown regression above.
  await sender.reload();
  await receiver.reload();
  const buffer = Buffer.alloc(2 * 1024 * 1024 + 17, 0x62);
  await send(sender, receiver, [
    { name: 'budget-wait.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect(
    sender.getByText('WideSend is busy. Keep this tab open; we’ll retry automatically.'),
  ).toBeVisible();
  await expect(
    receiver.getByText('WideSend is busy. Keep this tab open; we’ll retry automatically.'),
  ).toBeVisible();
  expect(fileFrames).toBe(0);
  expect(connections).toBe(2);
  restricted = false;
  for (const page of [sender, receiver])
    await page.evaluate(() => {
      const original = Date.now.bind(Date);
      Date.now = () => original() + 61000;
      for (const socket of (window as any).testSockets as WebSocket[])
        socket.dispatchEvent(new MessageEvent('message', { data: 'pong' }));
    });
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 0, buffer);
  expect(fileFrames).toBeGreaterThan(0);
  expect(connections).toBe(2);
});

test('large-file transfer resumes after reload and is verified by SHA-256', async ({ browser }) => {
  test.skip(
    !process.env.WIDESEND_LARGE_TEST,
    'Opt in with npm run test:large; uses several GiB of local disk.',
  );
  test.setTimeout(600_000);
  await mkdir('test-results', { recursive: true });
  const path = 'test-results/large-input.bin';
  const size = Number(process.env.WIDESEND_LARGE_BYTES ?? 2 * 1024 ** 3 + 123);
  if (!Number.isSafeInteger(size) || size < 32 * 1024 * 1024)
    throw new Error('WIDESEND_LARGE_BYTES must be an integer of at least 32 MiB.');
  const forceRelay = process.env.WIDESEND_LARGE_RELAY === '1';
  const file = await open(path, 'w');
  await file.truncate(size);
  for (const offset of [0, 1024 ** 3, 2 * 1024 ** 3, size - 64].filter(
    (offset) => offset + 32 <= size,
  ))
    await file.write(Buffer.from('WideSend large-file boundary test'), 0, 32, offset);
  await file.close();
  const { sender, receiver, senderContext, receiverContext } = await pair(
    browser,
    forceRelay,
    false,
    false,
    true,
  );
  try {
    await sender.evaluate(() =>
      document.addEventListener(
        'change',
        (event) => {
          const input = event.target as HTMLInputElement;
          if (input.files?.[0]) Object.assign(window, { testInputSize: input.files[0].size });
        },
        { capture: true },
      ),
    );
    await sender.getByTestId('file-input').setInputFiles(path);
    expect(
      await sender.evaluate(() => (window as unknown as { testInputSize: number }).testInputSize),
    ).toBe(size);
    await sender.getByRole('button', { name: 'Create transfer' }).click();
    const code = await sender.getByTestId('transfer-code').textContent();
    await receiver.getByRole('tab', { name: 'Receive files' }).click();
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    await expect(sender.getByAltText(/Scan this QR/)).toHaveCount(0);
    await enterCode(receiver, code!);
    await receiver.getByRole('button', { name: 'Connect to sender' }).click();
    await observeRestoredDisk(receiverContext);
    await receiver.getByRole('button', { name: 'Receive' }).click();
    await expect
      .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0, { timeout: 180_000 })
      .toBeGreaterThan(16 * 1024 * 1024);
    await receiver.reload();
    await expectResumedDisk(receiver);
    await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible({
      timeout: 540_000,
    });
    await expect.poll(() => downloads.get(receiver)!.length).toBe(1);
    const download = downloads.get(receiver)![0];
    const downloadedPath = (await download.path())!;
    expect((await stat(downloadedPath)).size).toBe(size);
    const digest = async (path: string) => {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest('hex');
    };
    expect(await digest(downloadedPath)).toBe(await digest(path));
    if (forceRelay) {
      await sender.getByRole('button', { name: 'Nerd stats', exact: true }).click();
      await expect(sender.getByTestId('stats-route')).toHaveText('Cloudflare relay');
    }
  } finally {
    await senderContext.close();
    await receiverContext.close();
    await unlink(path);
  }
});

test('browser downloads preserve duplicate filenames without opening a destination picker', async ({
  browser,
}) => {
  const { sender, receiver } = await pair(browser);
  await receiver.evaluate(() => {
    for (const name of ['showSaveFilePicker', 'showDirectoryPicker'])
      Object.defineProperty(window, name, {
        configurable: true,
        value: () => {
          throw new Error('Destination picker must not open');
        },
      });
  });
  const files = [
    { name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('first file') },
    { name: 'same.txt', mimeType: 'text/plain', buffer: Buffer.from('second file') },
  ];
  await send(sender, receiver, files);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  for (let i = 0; i < files.length; i++) {
    await checkDownload(receiver, i, files[i].buffer);
    expect(downloads.get(receiver)![i].suggestedFilename()).toBe('same.txt');
  }
  await expect(receiver.getByText('Free up space on this device')).toHaveCount(0);
});

test('blocked automatic downloads can be retried and reset keeps their backing files', async ({
  browser,
}) => {
  const { sender, receiver } = await pair(browser, true);
  await receiver.evaluate(() => {
    document.addEventListener(
      'click',
      (event) => {
        if (
          event.target instanceof HTMLAnchorElement &&
          event.target.hidden &&
          event.target.download
        )
          event.preventDefault();
      },
      true,
    );
  });
  const buffer = Buffer.from('Keep this verified file until the browser has it.');
  await send(sender, receiver, [{ name: 'retry.txt', mimeType: 'text/plain', buffer }]);
  await expect(receiver.getByRole('heading', { name: 'Files received.' })).toBeVisible();
  expect(downloads.get(receiver)).toHaveLength(0);
  await expect(receiver.getByRole('status')).toContainText('Check your browser’s downloads');
  const url = await receiver
    .getByRole('link', { name: 'Download', exact: true })
    .getAttribute('href');
  const waiting = receiver.waitForEvent('download');
  await receiver.getByRole('link', { name: 'Download', exact: true }).click();
  const download = await waiting;
  await receiver.getByRole('button', { name: 'New transfer' }).click();
  expect(await readFile((await download.path())!)).toEqual(buffer);
  const retry = receiver.waitForEvent('download');
  await receiver.evaluate((url) => {
    const link = document.createElement('a');
    link.href = url!;
    link.download = 'retry-after-reset.txt';
    document.body.append(link);
    link.click();
    link.remove();
  }, url);
  expect(await readFile((await (await retry).path())!)).toEqual(buffer);
});

test('automatic cleanup skips live transfers, recent files, and unrelated storage', async ({
  browser,
}) => {
  const { sender, receiver, receiverContext } = await pair(browser, true);
  const buffer = Buffer.from('Active transfer data');
  await send(sender, receiver, [{ name: 'protected.txt', mimeType: 'text/plain', buffer }]);
  await expect(receiver.getByRole('heading', { name: 'Files received.' })).toBeVisible();
  const protectedFolder = await receiver.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const keys = [];
    for await (const name of (
      root as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
    ).keys())
      keys.push(name);
    const active = (await navigator.locks.query()).held!.find((lock) =>
      lock.name?.startsWith('widesend-download-'),
    )!.name!;
    for (const [name, age] of [
      [active, 48],
      ['widesend-download-stale', 48],
      ['widesend-download-fresh', 0],
      ['unrelated', 48],
    ] as const) {
      const directory = await root.getDirectoryHandle(name, { create: true });
      const stream = await (
        await directory.getFileHandle('.last-used', { create: true })
      ).createWritable();
      await stream.write(String(Date.now() - age * 3600000));
      await stream.close();
    }
    return active;
  });
  const other = await receiverContext.newPage();
  await other.goto('/');
  const names = () =>
    other.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const keys = [];
      for await (const name of (
        root as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
      ).keys())
        keys.push(name);
      return keys;
    });
  await expect.poll(names).not.toContain('widesend-download-stale');
  expect(await names()).toEqual(
    expect.arrayContaining([protectedFolder, 'widesend-download-fresh', 'unrelated']),
  );
  await receiver.close();
  await other.reload();
  await expect.poll(names).not.toContain(protectedFolder);
});

test('blocked browser storage is explained before any file bytes are sent', async ({ browser }) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(browser, true);
  await receiver.evaluate(() => {
    Object.defineProperty(StorageManager.prototype, 'getDirectory', {
      configurable: true,
      value: async () => {
        throw new DOMException('Storage denied', 'UnknownError');
      },
    });
  });
  await sender
    .getByTestId('file-input')
    .setInputFiles({ name: 'private.txt', mimeType: 'text/plain', buffer: Buffer.from('secret') });
  await sender.getByRole('button', { name: 'Create transfer' }).click();
  const code = await sender.getByTestId('transfer-code').textContent();
  await receiver.getByRole('tab', { name: 'Receive files' }).click();
  expect(code).toMatch(/^[A-Z0-9]{6}$/);
  await expect(sender.getByAltText(/Scan this QR/)).toHaveCount(0);
  await enterCode(receiver, code!);
  await receiver.getByRole('button', { name: 'Connect to sender' }).click();
  await receiver.getByRole('button', { name: 'Receive' }).click();
  await expect(receiver.getByRole('alert')).toContainText('regular (non-private) window');
  await expect(sender.getByRole('heading', { name: 'Share this code' })).toBeVisible();
  await senderContext.close();
  await receiverContext.close();
});

test('Chrome sends exact bytes to a Safari-engine receiver', async ({ browser }) => {
  test.skip(browser.browserType().name() !== 'chromium', 'Run this browser combination once.');
  const { sender, receiver, senderContext, receiverContext } = await pair(
    browser,
    false,
    true,
    false,
    false,
    webkit,
  );
  const buffer = Buffer.alloc(5 * 1024 * 1024 + 77, 0xc5);
  await send(sender, receiver, [
    { name: 'across-browsers.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 0, buffer);
  await senderContext.close();
  await receiverContext.close();
});

test('different languages transfer files and can change during a session', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true);
  const payload = Buffer.from('WideSend · 中文 · Français · Español · 日本語 · 한국어');
  await sender
    .getByTestId('file-input')
    .setInputFiles({ name: '多语言.txt', mimeType: 'text/plain', buffer: payload });
  await sender.getByRole('button', { name: 'Create transfer' }).click();
  const code = (await sender.getByTestId('transfer-code').textContent())!;
  await sender.locator('.language-toggle').click();
  await sender.getByRole('menuitemradio', { name: 'Français' }).click();
  await expect(sender.getByTestId('transfer-code')).toHaveText(code);
  await expect(sender.getByRole('heading', { name: 'Partagez ce code' })).toBeVisible();
  await receiver.locator('.language-toggle').click();
  await receiver.getByRole('menuitemradio', { name: '简体中文' }).click();
  await receiver.getByRole('tab', { name: '接收文件' }).click();
  await receiver.locator('.code-input input').first().fill(code);
  await receiver.getByRole('button', { name: '连接发送方' }).click();
  await expect(receiver.getByRole('heading', { name: '准备接收。' })).toBeVisible();
  await receiver.getByRole('button', { name: '接收', exact: true }).click();
  await expect(sender.getByRole('heading', { name: 'Fichiers livrés.' })).toBeVisible();
  await expect(receiver.getByRole('heading', { name: '文件已接收。' })).toBeVisible();
  await expect(receiver.getByRole('status')).toHaveText(
    '文件已接收并校验。请查看浏览器的下载记录，如有文件未下载，请点击“下载”。',
  );
  const downloading = receiver.waitForEvent('download');
  await receiver.getByRole('link', { name: '下载', exact: true }).click();
  const download = await downloading;
  expect(await readFile((await download.path())!)).toEqual(payload);
});

test('a corrupted received file is never offered as a download', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true, false, true);
  await receiver.evaluate(() => {
    const NativeWorker = window.Worker;
    let corrupted = false;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, transfer: Transferable[]): void {
        const request = message as { command?: string; data?: ArrayBuffer };
        if (!corrupted && request.command === 'write' && request.data?.byteLength) {
          new Uint8Array(request.data)[0] ^= 1;
          corrupted = true;
        }
        super.postMessage(message, transfer);
      }
    };
  });
  await send(sender, receiver, [
    {
      name: 'check.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(4 * 1024 * 1024, 7),
    },
  ]);
  await expect(receiver.getByRole('heading', { name: 'Transfer failed.' })).toBeVisible();
  await expect(receiver.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
  expect(downloads.get(receiver)).toHaveLength(0);
  await expect(receiver.getByRole('status')).toContainText('Please send it again');
  await receiver.getByRole('button', { name: 'Nerd stats', exact: true }).click();
  await expect(receiver.getByTestId('stats-verified')).toHaveText('0 / 1');
  await expect(receiver.getByTestId('stats-activity')).toHaveText('Transfer failed');
  await expect(receiver.getByText('Final snapshot', { exact: true })).toBeVisible();
});

test('cancelling removes unverified temporary files automatically', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true, false, true);
  await send(sender, receiver, [
    {
      name: 'cancel.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(16 * 1024 * 1024, 3),
    },
  ]);
  const folder = await receiver.evaluate(
    async () =>
      (await navigator.locks.query()).held!.find((lock) =>
        lock.name?.startsWith('widesend-download-'),
      )!.name!,
  );
  await receiver.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
  await expect(receiver.getByRole('heading', { name: 'Transfer cancelled.' })).toBeVisible();
  await expect
    .poll(() =>
      receiver.evaluate(async (name) => {
        const root = await navigator.storage.getDirectory();
        try {
          await root.getDirectoryHandle(name);
          return true;
        } catch (error) {
          if ((error as DOMException).name === 'NotFoundError') return false;
          throw error;
        }
      }, folder),
    )
    .toBe(false);
  expect(downloads.get(receiver)).toHaveLength(0);
});

for (const relay of [false, true]) {
  test(`live nerd stats measure ${relay ? 'relay' : 'direct'} transfers and preserve the final snapshot`, async ({
    browser,
  }) => {
    const { sender, receiver } = await pair(browser, relay, relay, true);
    const buffer = Buffer.alloc(32 * 1024 * 1024 + 17, 0x3a);
    await expect(sender.getByRole('button', { name: 'Nerd stats', exact: true })).toHaveCount(0);
    await send(sender, receiver, [
      { name: 'stats-check.bin', mimeType: 'application/octet-stream', buffer },
    ]);
    for (const page of [sender, receiver]) {
      const toggle = page.getByRole('button', { name: 'Nerd stats', exact: true });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('region', { name: 'Nerd stats' })).toHaveCount(0);
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      // This host's automated Firefox may or may not connect directly; either way
      // the route shown and the acknowledgement path must agree.
      const firefox = browser.browserType().name() === 'firefox';
      await expect(page.getByTestId('stats-route')).toHaveText(
        relay ? 'Cloudflare relay' : firefox ? /^(Cloudflare relay|Direct P2P)$/ : 'Direct P2P',
      );
      const route = await page.getByTestId('stats-route').textContent();
      await expect(page.getByTestId('stats-speed')).not.toHaveText('0 B/s');
      await expect(page.getByTestId('stats-latency')).toHaveText(/^\d+ ms$/);
      await expect(page.getByTestId('stats-ack-path')).toHaveText(route!);
      if (!relay && browser.browserType().name() !== 'firefox') {
        await expect(page.getByTestId('stats-transport')).toHaveText('UDP');
        await expect(page.getByTestId('stats-candidates')).toHaveText(
          /^(host|srflx|prflx) ↔ (host|srflx|prflx)$/,
        );
        await expect(page.getByTestId('stats-path')).toHaveText(
          /^(Local addresses \(LAN likely\)|Public addresses|Network not exposed)$/,
        );
      }
      await expect(page.getByTestId('stats-verified')).toHaveText('0 / 1');
    }
    await expect(sender.getByTestId('stats-unacknowledged')).toBeVisible();
    await expect(receiver.getByTestId('stats-unacknowledged')).toHaveCount(0);
    await expect(sender.getByTestId('stats-resent')).toHaveText('0 B');
    await expect
      .poll(
        async () =>
          (await receiver.locator('.nerd-chart-line').getAttribute('points'))!.split(' ').length,
      )
      .toBeGreaterThan(2);
    await receiver.screenshot({
      path: `test-results/nerd-stats-${relay ? 'mobile' : 'desktop'}-${test.info().project.name}.png`,
      fullPage: true,
    });
    await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
    await checkDownload(receiver, 0, buffer);
    for (const page of [sender, receiver]) {
      await expect(page.getByTestId('stats-verified')).toHaveText('1 / 1');
      await expect(page.getByTestId('stats-activity')).toHaveText('All files verified');
      await expect(page.getByText('Final snapshot', { exact: true })).toBeVisible();
    }
    const final = await receiver.locator('.nerd-panel').innerText();
    await receiver.getByRole('button', { name: 'Nerd stats', exact: true }).click();
    await receiver.waitForTimeout(1200);
    await receiver.getByRole('button', { name: 'Nerd stats', exact: true }).click();
    expect(await receiver.locator('.nerd-panel').innerText()).toBe(final);
    if (relay) {
      for (const [language, title] of [
        ['简体中文', '技术统计'],
        ['Français', 'Statistiques avancées'],
        ['Español', 'Estadísticas avanzadas'],
        ['日本語', '詳細統計'],
        ['한국어', '상세 통계'],
      ]) {
        await receiver.locator('.language-toggle').click();
        await receiver.getByRole('menuitemradio', { name: language, exact: true }).click();
        await expect(receiver.getByRole('button', { name: title, exact: true })).toHaveAttribute(
          'aria-expanded',
          'true',
        );
        await expect(receiver.getByTestId('stats-verified')).toHaveText('1 / 1');
        expect(
          await receiver.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
      }
    }
  });
}

test('missing diagnostic replies do not interrupt a transfer', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true, false, true);
  await receiver.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    Object.assign(window, { blockedProbes: 0 });
    crypto.subtle.encrypt = async (algorithm, key, data) => {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      if (
        bytes[0] === 0 &&
        JSON.parse(new TextDecoder().decode(bytes.subarray(1))).type === 'probe'
      ) {
        (window as unknown as { blockedProbes: number }).blockedProbes++;
        throw new Error('Diagnostic unavailable');
      }
      return encrypt(algorithm, key, data);
    };
  });
  const buffer = Buffer.alloc(8 * 1024 * 1024, 13);
  await send(sender, receiver, [
    { name: 'no-probes.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 0, buffer);
  expect(
    await receiver.evaluate(() => (window as unknown as { blockedProbes: number }).blockedProbes),
  ).toBeGreaterThan(0);
  await sender.getByRole('button', { name: 'Nerd stats', exact: true }).click();
  await expect(sender.getByTestId('stats-latency')).toHaveText('—');
  await expect(sender.getByTestId('stats-verified')).toHaveText('1 / 1');
});

async function recoveryRecords(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open('widesend-recovery', 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<
      {
        id: string;
        code: string;
        offset: number;
        fileIndex: number;
        folder?: string;
        version: number;
        identity?: { publicKey: string; peerKey?: string; privateKey: { extractable: boolean } };
      }[]
    >((resolve, reject) => {
      const read = db.transaction('sessions').objectStore('sessions').getAll();
      read.onsuccess = () =>
        resolve(
          read.result.map((record) => ({
            ...record,
            identity: record.identity
              ? {
                  ...record.identity,
                  privateKey: { extractable: record.identity.privateKey.extractable },
                }
              : undefined,
          })),
        );
      read.onerror = () => reject(read.error);
    });
    db.close();
    return records;
  });
}

async function observeRestoredDisk(context: BrowserContext) {
  await context.addInitScript(() => {
    const opens: { offset: number; resume: boolean }[] = [];
    Object.assign(window, { restoredOpens: opens });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(
        message: { command: string; offset: number; resume: boolean },
        transfer: Transferable[],
      ): void {
        if (message.command === 'open')
          opens.push({ offset: message.offset, resume: message.resume });
        super.postMessage(message, transfer);
      }
    };
  });
}

async function expectResumedDisk(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { restoredOpens: { offset: number; resume: boolean }[] }
        ).restoredOpens.some((open) => open.resume && open.offset > 0),
      ),
    )
    .toBe(true);
  await expect(page.getByRole('button', { name: /^(Pause|Resume|Receive)$/ })).toHaveCount(0);
}

async function observeAcknowledgements(context: BrowserContext) {
  const install = () => {
    if (!crypto.subtle) return; // A persistent WebKit context also owns an about:blank page.
    const state = { direct: 0, relay: 0, rejectDirect: false, dropDirect: false, dropRelay: true };
    Object.assign(window, { ackRoutes: state });
    const tags = new Set<string>();
    const tag = (data: unknown) =>
      data instanceof ArrayBuffer && data.byteLength >= 16
        ? Array.from(new Uint8Array(data, data.byteLength - 16)).join(',')
        : '';
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = async (algorithm, key, data) => {
      const result = await encrypt(algorithm, key, data);
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes[0] === 0 && JSON.parse(new TextDecoder().decode(bytes.subarray(1))).type === 'ack')
        tags.add(tag(result));
      return result;
    };
    const directSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data: ArrayBuffer) {
      const key = tag(data),
        ack = tags.has(key);
      if (ack && state.rejectDirect) throw new Error('Simulated direct ACK send failure');
      if (ack) {
        state.direct++;
        tags.delete(key);
        if (state.dropDirect) return;
      }
      return directSend.call(this, data);
    };
    const relaySend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data: ArrayBuffer) {
      const key = tag(data);
      if (tags.has(key)) {
        state.relay++;
        tags.delete(key);
        if (state.dropRelay) return;
      }
      return relaySend.call(this, data);
    };
  };
  await context.addInitScript(install);
  for (const page of context.pages()) await page.evaluate(install);
}

test('relay chunks get relay acknowledgements while a direct channel is still open', async ({
  browser,
}) => {
  test.skip(
    browser.browserType().name() === 'firefox',
    'This host’s Firefox runtime cannot establish direct ICE connections.',
  );
  const { sender, receiver, receiverContext } = await pair(browser, false, false, true);
  await observeAcknowledgements(receiverContext);
  await receiver.evaluate(() => {
    (window as any).ackRoutes.dropRelay = false;
  });
  // Simulate data arriving on the relay before the old direct channel closes.
  // Both transports remain real, encrypted connections to the paired receiver.
  await sender.evaluate(() => {
    RTCDataChannel.prototype.send = function (data: ArrayBuffer) {
      const socket = (window as any).testSockets.at(-1) as WebSocket;
      const wrapped = new Uint8Array(data.byteLength + 1);
      wrapped[0] = 1;
      wrapped.set(new Uint8Array(data), 1);
      socket.send(wrapped.buffer);
    };
  });
  const buffer = Buffer.alloc(4 * 1024 * 1024 + 37, 0x5e);
  await send(sender, receiver, [
    { name: 'handoff-ack.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await receiver.getByRole('button', { name: 'Nerd stats', exact: true }).click();
  await expect(receiver.getByTestId('stats-ack-path')).toHaveText('Cloudflare relay');
  const acks = await receiver.evaluate(() => (window as any).ackRoutes);
  expect(acks.relay).toBeGreaterThan(0);
  expect(acks.direct).toBe(0);
  await checkDownload(receiver, 0, buffer);
});

for (const failure of ['send error', 'lost acknowledgements']) {
  test(`direct acknowledgements recover through relay after ${failure}`, async ({ browser }) => {
    test.skip(
      browser.browserType().name() === 'firefox',
      'This host’s Firefox runtime cannot establish direct ICE connections.',
    );
    const { sender, receiver, receiverContext } = await pair(browser, false, false, true);
    await observeAcknowledgements(receiverContext);
    const buffer = Buffer.alloc(16 * 1024 * 1024 + 47, 0x5a);
    await send(sender, receiver, [
      { name: 'ack-fallback.bin', mimeType: 'application/octet-stream', buffer },
    ]);
    await expect
      .poll(() => receiver.evaluate(() => (window as any).ackRoutes.direct))
      .toBeGreaterThan(4);
    await receiver.evaluate((failure) => {
      const state = (window as any).ackRoutes;
      state.dropRelay = false;
      state.rejectDirect = failure === 'send error';
      state.dropDirect = failure === 'lost acknowledgements';
    }, failure);
    await sender.getByRole('button', { name: 'Nerd stats', exact: true }).click();
    await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
    await expect(sender.getByTestId('stats-route')).toHaveText('Cloudflare relay');
    await expect(sender.getByTestId('stats-ack-path')).toHaveText('Cloudflare relay');
    expect(await receiver.evaluate(() => (window as any).ackRoutes.relay)).toBeGreaterThan(0);
    await checkDownload(receiver, 0, buffer);
  });
}

test('receiver reload automatically reopens a saved checkpoint and downloads exact bytes', async ({
  browser,
}) => {
  const { sender, receiver, receiverContext } = await pair(browser, false, false, true);
  await observeRestoredDisk(receiverContext);
  const direct = browser.browserType().name() !== 'firefox';
  if (direct) await observeAcknowledgements(receiverContext);
  const buffer = Buffer.alloc(16 * 1024 * 1024 + 19, 0x61);
  await send(sender, receiver, [
    { name: 'reload.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect
    .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0)
    .toBeGreaterThan(1024 * 1024);
  await receiver.reload();
  await expectResumedDisk(receiver);
  if (direct) {
    await expect
      .poll(() => sender.evaluate(() => (window as any).testPeers.at(-1)?.connectionState))
      .toBe('connected');
    // A delayed callback from the discarded peer must not close its replacement.
    await sender.evaluate(() => {
      const old = (window as any).testPeers[0] as RTCPeerConnection;
      old.onconnectionstatechange?.call(old, new Event('connectionstatechange'));
    });
  }
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await sender.getByRole('button', { name: 'Nerd stats', exact: true }).click();
  // Automated Firefox connects directly on some hosts and times out to the relay
  // on others; either way the route and the acknowledgement path must agree.
  const route = direct
    ? 'Direct P2P'
    : ((await sender.getByTestId('stats-route').textContent()) ?? '').trim();
  expect(['Direct P2P', 'Cloudflare relay']).toContain(route);
  await expect(sender.getByTestId('stats-route')).toHaveText(route);
  await expect(sender.getByTestId('stats-ack-path')).toHaveText(route);
  if (direct) {
    const acks = await receiver.evaluate(() => (window as any).ackRoutes);
    expect(acks.direct).toBeGreaterThan(0);
    expect(acks.relay).toBe(0);
    expect(await sender.evaluate(() => (window as any).testPeers.length)).toBeGreaterThan(1);
  }
  await checkDownload(receiver, 0, buffer);
  await expect.poll(() => recoveryRecords(receiver)).toEqual([]);
  await expect.poll(() => recoveryRecords(sender)).toEqual([]);
});

for (const initialRelay of [false, true])
  test(`both closed pages resume directly after ${initialRelay ? 'relay' : 'direct'} transfer even when relay acknowledgements are unavailable`, async ({
    browser,
  }) => {
    test.skip(
      browser.browserType().name() === 'firefox',
      'This host’s Firefox runtime cannot establish direct ICE connections.',
    );
    const { sender, receiver, senderContext, receiverContext } = await pair(
      browser,
      false,
      false,
      true,
    );
    await observeAcknowledgements(receiverContext);
    await observeRestoredDisk(receiverContext);
    if (initialRelay) {
      // Only the original page lacks WebRTC. Reopened pages can try it again.
      await sender.evaluate(() => {
        Object.defineProperty(window, 'RTCPeerConnection', {
          configurable: true,
          value: class {
            constructor() {
              throw new Error('Initial direct path unavailable');
            }
          },
        });
      });
      await receiver.evaluate(() => {
        (window as any).ackRoutes.dropRelay = false;
      });
    }
    const buffer = Buffer.alloc(16 * 1024 * 1024 + 51, 0x5b);
    const original = { name: 'direct-restore.bin', mimeType: 'application/octet-stream', buffer };
    await send(sender, receiver, [original]);
    await expect
      .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0)
      .toBeGreaterThan(1024 * 1024);
    const code = (await recoveryRecords(sender))[0].code;
    await receiver.close();
    await sender.close();
    const incoming = await receiverContext.newPage();
    downloads.set(incoming, []);
    incoming.on('download', (download) => downloads.get(incoming)!.push(download));
    await incoming.goto('/');
    await expectResumedDisk(incoming);
    const outgoing = await senderContext.newPage();
    await outgoing.goto('/');
    await expect(outgoing.getByRole('button', { name: 'Select original files' })).toBeVisible();
    expect((await recoveryRecords(outgoing))[0].code).toBe(code);
    await outgoing.getByTestId('original-files').setInputFiles(original);
    await expect(outgoing.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
    await outgoing.getByRole('button', { name: 'Nerd stats', exact: true }).click();
    await expect(outgoing.getByTestId('stats-route')).toHaveText('Direct P2P');
    await expect(outgoing.getByTestId('stats-ack-path')).toHaveText('Direct P2P');
    expect(await incoming.evaluate(() => (window as any).ackRoutes.relay)).toBe(0);
    await checkDownload(incoming, 0, buffer);
  });

test('unavailable connection-path statistics do not interrupt direct transfer', async ({
  browser,
}) => {
  test.skip(
    browser.browserType().name() === 'firefox',
    'This host’s Firefox runtime cannot establish direct ICE connections.',
  );
  const { sender, receiver } = await pair(browser, false, false, true);
  await sender.evaluate(() => {
    Object.assign(window, { pathReads: 0 });
    RTCPeerConnection.prototype.getStats = () => {
      (window as any).pathReads++;
      throw new Error('Browser statistics unavailable');
    };
  });
  const buffer = Buffer.alloc(5 * 1024 * 1024 + 41, 0x5d);
  await send(sender, receiver, [
    { name: 'no-path-stats.bin', mimeType: 'application/octet-stream', buffer },
  ]);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await sender.getByRole('button', { name: 'Nerd stats', exact: true }).click();
  await expect(sender.getByTestId('stats-route')).toHaveText('Direct P2P');
  await expect(sender.getByTestId('stats-ack-path')).toHaveText('Direct P2P');
  await expect(sender.getByTestId('stats-path')).toHaveText('Network not exposed');
  await expect(sender.getByTestId('stats-candidates')).toHaveText('—');
  expect(await sender.evaluate(() => (window as any).pathReads)).toBeGreaterThan(0);
  await checkDownload(receiver, 0, buffer);
});

test('both closed pages recover the same pairing; wrong originals are rejected before automatic continuation', async ({
  browser,
}) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(
    browser,
    true,
    false,
    true,
  );
  await observeRestoredDisk(receiverContext);
  const buffer = Buffer.alloc(16 * 1024 * 1024 + 31, 0x62);
  const original = { name: 'original.bin', mimeType: 'application/octet-stream', buffer };
  await send(sender, receiver, [original]);
  await expect
    .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0)
    .toBeGreaterThan(1024 * 1024);
  const savedCode = (await recoveryRecords(sender))[0].code;
  await receiver.close();
  await sender.close();
  const incoming = await receiverContext.newPage();
  downloads.set(incoming, []);
  incoming.on('download', (download) => downloads.get(incoming)!.push(download));
  await incoming.goto('/');
  await expectResumedDisk(incoming);
  const outgoing = await senderContext.newPage();
  await outgoing.goto('/');
  await expect(outgoing.getByRole('button', { name: 'Select original files' })).toBeVisible();
  expect((await recoveryRecords(outgoing))[0].code).toBe(savedCode);
  await outgoing
    .getByTestId('original-files')
    .setInputFiles({ ...original, buffer: Buffer.alloc(buffer.length, 0x63) });
  await expect(outgoing.getByRole('alert')).toContainText(
    'Select the same original files to continue.',
  );
  expect((await recoveryRecords(outgoing))[0].code).toBe(savedCode);
  await outgoing.getByTestId('original-files').setInputFiles(original);
  await expect(outgoing.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(incoming, 0, buffer);
});

test('cancel removes saved progress and reopening starts a new transfer', async ({ browser }) => {
  const { sender, receiver } = await pair(browser, true, false, true);
  await send(sender, receiver, [
    {
      name: 'cancel.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(12 * 1024 * 1024, 0x64),
    },
  ]);
  await expect
    .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0)
    .toBeGreaterThan(0);
  await receiver.getByRole('button', { name: 'Cancel transfer' }).click();
  await expect(receiver.getByRole('heading', { name: 'Transfer cancelled.' })).toBeVisible();
  await expect.poll(() => recoveryRecords(receiver)).toEqual([]);
  await expect.poll(() => recoveryRecords(sender)).toEqual([]);
  await receiver.reload();
  await expect(receiver.getByRole('button', { name: 'Create transfer' })).toBeVisible();
  await expect(receiver.getByRole('progressbar')).toHaveCount(0);
});

test('a previous-version file checkpoint upgrades without losing its code or saved bytes', async ({
  browser,
}) => {
  const { sender, receiver, senderContext, receiverContext } = await pair(
    browser,
    true,
    false,
    true,
  );
  const original = {
    name: 'legacy-progress.bin',
    mimeType: '',
    buffer: Buffer.alloc(12 * 1024 * 1024 + 3, 29),
  };
  await send(sender, receiver, [original]);
  await expect
    .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0)
    .toBeGreaterThan(1024 * 1024);
  const code = (await recoveryRecords(sender))[0].code;
  await sender.close();
  await receiver.close();
  const incoming = await receiverContext.newPage(),
    outgoing = await senderContext.newPage();
  downloads.set(incoming, []);
  incoming.on('download', (d) => downloads.get(incoming)!.push(d));
  for (const page of [outgoing, incoming]) {
    // Load the same origin without starting the app, then install the v1 journal shape.
    await page.goto('/widesend.svg');
    await page.evaluate(async () => {
      const request = indexedDB.open('widesend-recovery', 1);
      const db = await new Promise<IDBDatabase>((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('sessions', 'readwrite'),
          store = tx.objectStore('sessions');
        const read = store.getAll();
        read.onsuccess = () => {
          for (const record of read.result) {
            record.version = 1;
            delete record.identity;
            store.put(record);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.goto('/');
  }
  await expect.poll(async () => (await recoveryRecords(outgoing))[0]?.version).toBe(2);
  await expect.poll(async () => (await recoveryRecords(incoming))[0]?.version).toBe(2);
  const restored = (await recoveryRecords(incoming))[0];
  expect(restored.code).toBe(code);
  expect(restored.offset).toBeGreaterThan(1024 * 1024);
  expect(restored.identity?.privateKey.extractable).toBe(false);
  await outgoing.getByTestId('original-files').setInputFiles(original);
  await expect(outgoing.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(incoming, 0, original.buffer);
});

test('recovery preserves earlier downloads in a multi-file transfer and keeps a live tab exclusive', async ({
  browser,
}) => {
  const { sender, receiver, receiverContext } = await pair(browser, true, false, true);
  await observeRestoredDisk(receiverContext);
  const files = [
    { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('already delivered') },
    {
      name: 'second.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(16 * 1024 * 1024 + 17, 0x65),
    },
  ];
  await send(sender, receiver, files);
  await expect
    .poll(async () => {
      const r = (await recoveryRecords(receiver))[0];
      return r?.fileIndex === 1 && r.offset > 1024 * 1024;
    })
    .toBe(true);
  await checkDownload(receiver, 0, files[0].buffer);
  const other = await receiverContext.newPage();
  await other.goto('/');
  await other
    .getByTestId('file-input')
    .setInputFiles({ name: 'unused.txt', mimeType: 'text/plain', buffer: Buffer.from('unused') });
  await expect(other.getByRole('button', { name: 'Create transfer' })).toBeEnabled();
  await expect(other.getByRole('progressbar')).toHaveCount(0);
  await receiver.reload();
  await expectResumedDisk(receiver);
  await expect(receiver.getByRole('link', { name: 'Download', exact: true })).toHaveCount(1);
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await checkDownload(receiver, 1, files[1].buffer);
  expect(downloads.get(receiver)).toHaveLength(2);
});

test('a full receiving browser restart recovers persistent bytes without another Receive click', async ({
  browser,
}) => {
  const browserType = browser.browserType();
  await mkdir('test-results', { recursive: true });
  const profile = await mkdtemp('test-results/restart-profile-');
  const launch = () =>
    browserType.launchPersistentContext(profile, {
      baseURL: 'http://localhost:8788',
      acceptDownloads: true,
      channel: browserType.name() === 'chromium' ? 'chrome' : undefined,
    });
  const senderContext = await browser.newContext();
  contexts.push(senderContext);
  let receiverContext = await launch();
  try {
    await senderContext.addInitScript(() => {
      Object.defineProperty(window, 'RTCPeerConnection', {
        value: class {
          constructor() {
            throw new Error('Force relay');
          }
        },
      });
    });
    const slowDisk = async (context: BrowserContext) => {
      await context.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          postMessage(message: { command: string }, transfer: Transferable[]): void {
            if (message.command === 'write')
              setTimeout(() => super.postMessage(message, transfer), 8);
            else super.postMessage(message, transfer);
          }
        };
      });
      await observeRestoredDisk(context);
    };
    await slowDisk(receiverContext);
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    await sender.goto('/');
    await receiver.goto('/');
    const buffer = Buffer.alloc(16 * 1024 * 1024 + 23, 0x66);
    await send(sender, receiver, [
      { name: 'restart.bin', mimeType: 'application/octet-stream', buffer },
    ]);
    await expect
      .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0)
      .toBeGreaterThan(1024 * 1024);
    await receiverContext.close();
    receiverContext = await launch();
    await slowDisk(receiverContext);
    const restored = await receiverContext.newPage();
    downloads.set(restored, []);
    restored.on('download', (download) => downloads.get(restored)!.push(download));
    await restored.goto('/');
    await expectResumedDisk(restored);
    await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
    await checkDownload(restored, 0, buffer);
  } finally {
    await receiverContext.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('missing checkpoint bytes fail safely instead of appending to an incomplete file', async ({
  browser,
}) => {
  const { sender, receiver, receiverContext } = await pair(browser, true, false, true);
  await send(sender, receiver, [
    {
      name: 'damaged.bin',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(16 * 1024 * 1024, 0x67),
    },
  ]);
  await expect
    .poll(async () => (await recoveryRecords(receiver))[0]?.offset ?? 0)
    .toBeGreaterThan(1024 * 1024);
  const record = (await recoveryRecords(receiver))[0];
  const other = await receiverContext.newPage();
  await other.goto('/');
  await other
    .getByTestId('file-input')
    .setInputFiles({ name: 'unused.txt', mimeType: 'text/plain', buffer: Buffer.from('unused') });
  await expect(other.getByRole('button', { name: 'Create transfer' })).toBeEnabled();
  await receiver.close();
  await other.evaluate(async ({ folder, fileIndex }) => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(folder!);
    const file = await directory.getFileHandle(String(fileIndex));
    const writable = await file.createWritable();
    await writable.truncate(0);
    await writable.close();
  }, record);
  await other.reload();
  await expect(other.getByRole('alert')).toContainText('Saved progress is no longer available.');
  await expect(other.getByRole('heading', { name: 'Files received.' })).toHaveCount(0);
  await expect.poll(() => recoveryRecords(other)).toEqual([]);
});

test('expired recovery is discarded when the browser reopens', async ({ browser }) => {
  const { sender } = await pair(browser, true);
  await sender
    .getByTestId('file-input')
    .setInputFiles({ name: 'expired.txt', mimeType: 'text/plain', buffer: Buffer.from('expire') });
  await sender.getByRole('button', { name: 'Create transfer' }).click();
  await expect(sender.getByTestId('transfer-code')).toBeVisible();
  await expect(sender.getByTestId('connection-status')).toHaveText('Waiting for receiver');
  await sender.evaluate(async () => {
    const request = indexedDB.open('widesend-recovery', 1);
    const db = await new Promise<IDBDatabase>((resolve) => {
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      const read = store.getAll();
      read.onsuccess = () => {
        for (const record of read.result)
          store.put({ ...record, expires: Date.now() - 1, pairExpires: Date.now() - 1 });
      };
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await sender.reload();
  await expect(sender.getByRole('button', { name: 'Create transfer' })).toBeVisible();
  await expect.poll(() => recoveryRecords(sender)).toEqual([]);
});

test('reopening after the last file recovers completion without downloading it twice', async ({
  browser,
}) => {
  const { sender, receiver } = await pair(browser, true);
  await receiver.evaluate(() => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    crypto.subtle.encrypt = (algorithm, key, data) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (bytes[0] === 0) {
        const message = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
        if (message.type === 'complete') return new Promise<ArrayBuffer>(() => {});
      }
      return encrypt(algorithm, key, data);
    };
  });
  const buffer = Buffer.from(
    'The last verified file survives an interrupted completion handshake.',
  );
  await send(sender, receiver, [{ name: 'complete.txt', mimeType: 'text/plain', buffer }]);
  await checkDownload(receiver, 0, buffer);
  await expect.poll(async () => (await recoveryRecords(receiver))[0]?.fileIndex).toBe(1);
  await receiver.reload();
  await expect(receiver.getByRole('heading', { name: 'Files received.' })).toBeVisible();
  await expect(sender.getByRole('heading', { name: 'Files delivered.' })).toBeVisible();
  await expect(receiver.getByRole('link', { name: 'Download', exact: true })).toHaveCount(1);
  await expect.poll(() => recoveryRecords(receiver)).toEqual([]);
  expect(downloads.get(receiver)).toHaveLength(1);
});
