import {
  expect,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RESULTS } from './fixtures';

const contexts: BrowserContext[] = [];
const downloads = new WeakMap<Page, Download[]>();
export const downloadsOf = (page: Page) => downloads.get(page)!;

/** A page of the web app in its own profile. WebKit's private contexts deny OPFS. */
export async function openPage(
  browser: Browser,
  options: { relay?: boolean; slow?: boolean } = {},
) {
  const type = browser.browserType();
  let context: BrowserContext;
  if (type.name() === 'webkit') {
    const profile = await mkdtemp(join(RESULTS, 'profile-'));
    context = await type.launchPersistentContext(profile, {
      baseURL: 'http://localhost:8788',
      acceptDownloads: true,
    });
    const close = context.close.bind(context);
    context.close = async (o) => {
      await close(o);
      await rm(profile, { recursive: true, force: true });
    };
  } else context = await browser.newContext();
  contexts.push(context);
  await context.addInitScript(
    ({ relay, slow }) => {
      if (relay)
        Object.defineProperty(window, 'RTCPeerConnection', {
          value: class {
            constructor() {
              throw new Error('Direct network unavailable');
            }
          },
          configurable: true,
        });
      // Slow disk writes keep a transfer running long enough to interrupt it.
      if (slow) {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
            const send = () => super.postMessage(message, transfer as Transferable[]);
            if ((message as { command?: string }).command === 'write') setTimeout(send, 8);
            else send();
          }
        };
      }
      localStorage.setItem('widesend-language', 'en');
    },
    { relay: !!options.relay, slow: !!options.slow },
  );
  const page = context.pages()[0] ?? (await context.newPage());
  downloads.set(page, []);
  page.on('download', (download) => downloads.get(page)!.push(download));
  await page.goto('/');
  return page;
}
export async function closePages() {
  await Promise.all(contexts.splice(0).map((context) => context.close().catch(() => {})));
}
export async function receiveInPage(page: Page, code: string) {
  await page.getByRole('tab', { name: 'Receive files' }).click();
  const boxes = page.getByRole('group', { name: 'Transfer code' }).getByRole('textbox');
  await boxes.first().fill(code.toLowerCase());
  await page.getByRole('button', { name: 'Connect to sender' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to receive.' })).toBeVisible();
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
}
export type Source = { name: string; mimeType: string; buffer: Buffer };
/** Files as data, or as paths for files too big to pass to the browser as data. */
export async function sendFromPage(page: Page, files: Source[] | string[]) {
  await page.getByTestId('file-input').setInputFiles(files);
  await page.getByRole('button', { name: 'Create transfer' }).click();
  await expect(page.getByTestId('transfer-code')).toHaveText(/^[A-Z0-9]{6}$/);
  return (await page.getByTestId('transfer-code').textContent())!;
}
