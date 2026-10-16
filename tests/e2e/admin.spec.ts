import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { healthFixture } from '../fixtures/health';
const id = 'a'.repeat(64),
  now = Date.now();
const transfer = {
  id,
  code: 'A1B2C3',
  started_at: now - 2000,
  updated_at: now,
  expires_at: now + 86400000,
  sender_status: 'complete',
  receiver_status: 'complete',
  sender_route: 'direct',
  receiver_route: 'direct',
  sender_finished_at: now,
  receiver_finished_at: now,
  status: 'complete',
  file_count: 1,
  total_size: 3,
  sender_ip: '192.0.2.1',
  receiver_ip: '198.51.100.2',
};
const file = {
  file_id: 0,
  name: '<img src=x onerror="window.hacked=true">.txt',
  size: 3,
  mime_type: 'text/plain',
  md5: '900150983cd24fb0d6963f7d28e17f72',
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  reported_at: now,
  completed_at: now,
};
test('admin activity search and detail show metadata as text', async ({ page }) => {
  let currentTransfer: { code: string | null; status: string } & Omit<
    typeof transfer,
    'code' | 'status'
  > = { ...transfer };
  const assets = new Map();
  for (const [path, type] of [
    ['/', 'text/html'],
    ['/admin.js', 'text/javascript'],
    ['/health.js', 'text/javascript'],
    ['/rooms.js', 'text/javascript'],
    ['/controls.js', 'text/javascript'],
    ['/admin.css', 'text/css'],
    ['/widesend.svg', 'image/svg+xml'],
  ])
    assets.set(path, {
      contentType: type,
      body: await readFile(
        new URL(
          `../../admin/public/${path === '/' ? 'index.html' : path.slice(1)}`,
          import.meta.url,
        ),
      ),
    });
  await page.route('https://admin.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (assets.has(url.pathname))
      return route.fulfill({ status: 200, ...assets.get(url.pathname) });
    if (url.pathname === '/api/me')
      return route.fulfill({ json: { email: 'owner@example.com', retentionDays: 90 } });
    if (url.pathname === '/api/health-overview') return route.fulfill({ json: healthFixture() });
    if (url.pathname === `/api/transfers/${id}`)
      return route.fulfill({
        json: {
          transfer: currentTransfer,
          files: [
            { ...file, role: 'send' },
            { ...file, role: 'receive' },
          ],
          connections: [
            {
              role: 'send',
              ip: '192.0.2.1',
              country: 'CA',
              connected_at: now - 2000,
              disconnected_at: now,
              closed_by: 'lost',
              close_code: 1006,
              close_reason: 'Connection lost',
            },
          ],
          refusals: [],
        },
      });
    if (url.pathname === '/api/transfers')
      return route.fulfill({
        json: {
          items: url.searchParams.get('q') === 'missing' ? [] : [currentTransfer],
          next: null,
          retentionDays: 90,
        },
      });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.goto('https://admin.test/');
  await expect(page.getByText('owner@example.com')).toBeVisible();
  await expect(page.locator('.record').getByText('192.0.2.1', { exact: true })).toBeVisible();
  await expect(page.locator('.record .pairing-code')).toHaveText('A1B2C3');
  const statusToggle = page.getByRole('button', { name: 'Status All activity', exact: true });
  await statusToggle.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.getByRole('option', { name: 'All activity', exact: true }).press('ArrowDown');
  await page.getByRole('option', { name: 'Waiting', exact: true }).press('Enter');
  await expect(page.locator('#status')).toHaveValue('waiting');
  await expect(page.locator('#status-toggle')).toBeFocused();
  await page.locator('#status-toggle').click();
  await page.getByRole('option', { name: 'Receiver confirmed', exact: true }).click();
  await page.locator('#status-toggle').click();
  await page.screenshot({
    path: `test-results/admin-status-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();

  // Fixed UTC dates cover month/year boundaries and leap-day navigation.
  await page.locator('#from').evaluate((el) => ((el as HTMLInputElement).value = '2024-01-31'));
  await page.locator('#from-toggle').click();
  const calendar = page.getByRole('dialog', { name: 'From date (UTC)' });
  await page.keyboard.press('PageDown');
  await expect(
    calendar.getByRole('button', { name: 'Thursday, February 29, 2024', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#from')).toHaveValue('2024-02-29');
  await page.locator('#to-toggle').click();
  await page.getByRole('button', { name: 'Choose today (UTC)' }).click();
  const request = page.waitForRequest((req) => {
    const url = new URL(req.url());
    return url.pathname === '/api/transfers' && url.searchParams.get('from') === '2024-02-29';
  });
  await page.getByRole('button', { name: 'Find transfers' }).click();
  const params = new URL((await request).url()).searchParams;
  expect(params.get('status')).toBe('complete');
  expect(params.get('to')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await page.locator('#from-toggle').click();
  await page.screenshot({
    path: `test-results/admin-calendar-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Clear date' }).click();
  await expect(page.locator('#from')).toHaveValue('');
  await page.locator('#from-toggle').click();
  await page.locator('#to-toggle').click();
  await expect(calendar).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'To date (UTC)' })).toBeVisible();
  await page.getByRole('heading', { name: 'See what’s moving.' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.locator('.record').click();
  await expect(page.locator('.record')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#detail-selected')).toBeVisible();
  await expect(page.locator('#detail-content .pairing-code')).toHaveText('A1B2C3');
  await expect(page.locator('#detail-content')).toContainText('Connection lost (1006)');
  await expect(page.locator('#detail-content')).toContainText('No attempts were refused.');
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: file.name, exact: true })).toHaveCount(2);
  await expect(page.getByText('Reports match', { exact: true })).toHaveCount(2);
  expect(await page.evaluate(() => Reflect.get(window, 'hacked'))).toBeUndefined();
  await expect(page.locator('#detail img')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Health overview', exact: true }).click();
  await expect(page.locator('#history-panel')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Transfer health', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.locator('#health-panel')).toBeHidden();
  await expect(page.locator('.record')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#detail-selected')).toBeVisible();
  await expect(page.locator('#detail-content .pairing-code')).toHaveText('A1B2C3');
  await expect(page.locator('#status')).toHaveValue('complete');
  await page.screenshot({
    path: `test-results/admin-desktop-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.locator('#detail-placeholder')).toBeVisible();
  await expect(page.locator('.record')).toBeFocused();
  await page.getByLabel('Search', { exact: true }).fill('missing');
  await page.getByRole('button', { name: 'Find transfers' }).click();
  await expect(page.getByText(/No matching transfers/)).toBeVisible();
  await page.setViewportSize({ width: 760, height: 900 });
  await page.locator('#from-toggle').click();
  const tabletCalendar = await calendar.boundingBox();
  expect(tabletCalendar!.x).toBeGreaterThanOrEqual(0);
  expect(tabletCalendar!.x + tabletCalendar!.width).toBeLessThanOrEqual(760);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('#from-toggle').click();
  await page.screenshot({
    path: `test-results/admin-calendar-mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
  const box = await calendar.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByLabel('Search', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Find transfers' }).click();
  await page.locator('.record').click();
  await expect(page.getByText('Reports match', { exact: true })).toHaveCount(2);
  await expect(page.locator('#detail-heading')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/admin-detail-mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
  // Active records use the same code field, and Refresh updates the selected detail too.
  currentTransfer = { ...transfer, code: 'Z9Y8X7', status: 'transferring' };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.record .pairing-code')).toHaveText('Z9Y8X7');
  await expect(page.locator('#detail-content .pairing-code')).toHaveText('Z9Y8X7');
  await page.getByLabel('Search', { exact: true }).fill('z9y8x7');
  const codeSearch = page.waitForRequest(
    (req) => new URL(req.url()).searchParams.get('q') === 'z9y8x7',
  );
  await page.getByRole('button', { name: 'Find transfers' }).click();
  await codeSearch;
  await expect(page.locator('.record .pairing-code')).toHaveText('Z9Y8X7');
  currentTransfer = { ...transfer, code: null };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.record-code')).toHaveText('CodeNot recorded');
  await page.locator('.record').click();
  await expect(
    page.locator('#detail-content dt').filter({ hasText: 'Transfer code' }).locator('..'),
  ).toHaveText('Transfer codeNot recorded');
});

test('admin labels each use of a shared code', async ({ page }) => {
  const shared = { ...transfer, slot: 1, uses: 3 };
  await page.route('https://admin.test/**', async (route) => {
    const url = new URL(route.request().url());
    const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (/^(index\.html|\w+\.(js|css|svg))$/.test(asset))
      return route.fulfill({
        status: 200,
        contentType: asset.endsWith('.js')
          ? 'text/javascript'
          : asset.endsWith('.css')
            ? 'text/css'
            : asset.endsWith('.svg')
              ? 'image/svg+xml'
              : 'text/html',
        body: await readFile(new URL(`../../admin/public/${asset}`, import.meta.url)),
      });
    if (url.pathname === '/api/me')
      return route.fulfill({ json: { email: 'owner@example.com', retentionDays: 90 } });
    if (url.pathname === '/api/health-overview') return route.fulfill({ json: healthFixture() });
    if (url.pathname === `/api/transfers/${id}`)
      return route.fulfill({
        // A deployment that doesn't record file names stores them empty.
        json: {
          transfer: shared,
          files: [{ ...file, name: '', role: 'send' }],
          connections: [],
          refusals: [],
        },
      });
    if (url.pathname === '/api/transfers')
      return route.fulfill({ json: { items: [shared], next: null, retentionDays: 90 } });
    return route.fulfill({ status: 404, body: 'Not found' });
  });
  await page.goto('https://admin.test/');
  await expect(page.locator('.record')).toContainText('Use 2 of 3');
  await page.locator('.record').click();
  await expect(
    page.locator('#detail-content dt').filter({ hasText: /^Use$/ }).locator('..'),
  ).toHaveText('Use2 of 3');
  await expect(page.locator('#detail-content .file-name')).toHaveText('Not recorded');
});
