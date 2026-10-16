import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { healthFixture } from '../fixtures/health';

const now = Date.UTC(2026, 8, 11, 12);
async function setup(page: Page) {
  const state: { calls: number; status: number; body: any } = {
    calls: 0,
    status: 200,
    body: healthFixture(now),
  };
  const assets = new Map();
  for (const [name, contentType] of [
    ['index.html', 'text/html'],
    ['admin.js', 'text/javascript'],
    ['health.js', 'text/javascript'],
    ['rooms.js', 'text/javascript'],
    ['controls.js', 'text/javascript'],
    ['admin.css', 'text/css'],
    ['widesend.svg', 'image/svg+xml'],
  ])
    assets.set(name === 'index.html' ? '/' : `/${name}`, {
      contentType,
      body: await readFile(new URL(`../../admin/public/${name}`, import.meta.url)),
    });
  await page.route('https://admin.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (assets.has(path))
      return route.fulfill({
        ...assets.get(path),
        headers: {
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'",
        },
      });
    if (path === '/api/health-overview') {
      state.calls++;
      return route.fulfill({ status: state.status, json: state.body });
    }
    if (path === '/api/me') return route.fulfill({ json: { email: 'owner@example.com' } });
    if (path === '/api/transfers') return route.fulfill({ json: { items: [], next: null } });
    return route.fulfill({ status: 404 });
  });
  return state;
}
const metric = (page: Page, title: string) =>
  page
    .locator('.health-metric')
    .filter({ has: page.getByText(title, { exact: true }) })
    .locator('strong');

test('health overview switches UTC periods, refreshes, and fits desktop and mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const state = await setup(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/.test(message.text())) errors.push(message.text());
  });
  await page.goto('https://admin.test/');
  await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tabpanel', { name: 'History', exact: true })).toBeVisible();
  await expect(page.locator('#health-panel')).toBeHidden();
  expect(state.calls).toBe(0);
  await page.getByRole('tab', { name: 'Health overview', exact: true }).click();
  await expect(page.locator('#history-panel')).toBeHidden();
  await expect(metric(page, 'Transfers started')).toHaveText('12');
  await expect(metric(page, 'Blocked attempts')).toHaveText('6');
  await expect(metric(page, 'Reconnections')).toHaveText('3');
  await expect(page.locator('#health-live')).toContainText('3 / 25 transfer slots reserved');
  await expect(page.locator('#health-relay')).toContainText('25 GiB');
  await expect(page.locator('#health-relay')).toContainText('200,000');
  await expect(page.locator('#health-relay')).toContainText('10,000 / 50,000');
  await expect(page.locator('#health-cleanup')).toContainText('Up to date');
  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect(metric(page, 'Transfers started')).toHaveText('40');
  await expect(metric(page, 'Blocked attempts')).toHaveText('16');
  await expect(metric(page, 'Reconnections')).toHaveText('14');
  await expect(page.locator('#health-relay')).toContainText('75 GiB');
  await expect(page.locator('#health-relay')).toContainText('600,000');
  // The budget is always today even while displaying seven-day traffic.
  await expect(page.locator('#health-relay')).toContainText('10,000 / 50,000');
  expect(state.calls).toBe(1);
  await page.getByText('About these numbers', { exact: true }).click();
  await expect(page.locator('#health-coverage')).toContainText(/9 Sept?/);
  await expect(page.locator('#health-routes')).toContainText('Unknown');
  await expect(page.getByRole('link', { name: 'Cloudflare usage' })).toHaveAttribute(
    'href',
    'https://dash.cloudflare.com/',
  );
  await page.getByText('About these numbers', { exact: true }).click();
  state.body.activity.last7Days.total = 41;
  state.body.protection.reservedTransfers = 25;
  state.body.protection.reservedConnections = 50;
  state.body.protection.relay.acceptingNew = false;
  state.body.protection.relay.daily[1].messages = 810000;
  state.body.cleanup.overdueTransfers = 125;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(metric(page, 'Transfers started')).toHaveText('41');
  await expect(page.locator('#health-live')).toContainText('New transfers at capacity');
  await expect(page.locator('#health-relay')).toContainText('New relay transfers waiting');
  await expect(page.locator('#health-cleanup')).toContainText('Expired records awaiting cleanup');
  await expect(page.locator('#health-cleanup')).toContainText('125');
  await expect(page.getByRole('button', { name: 'Last 7 days', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.getByLabel('Search', { exact: true }).fill('anything');
  await page.getByRole('button', { name: 'Find transfers' }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  expect(state.calls).toBe(2);
  await page.getByRole('tab', { name: 'Health overview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Last 7 days', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(metric(page, 'Transfers started')).toHaveText('41');
  await page.setViewportSize({ width: 375, height: 812 });
  const historyTab = page.getByRole('tab', { name: 'History', exact: true });
  const healthTab = page.getByRole('tab', { name: 'Health overview', exact: true });
  const roomsTab = page.getByRole('tab', { name: 'Rooms', exact: true });
  await healthTab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(historyTab).toBeFocused();
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue('anything');
  await expect(page.locator('#health-panel')).toBeHidden();
  // Three tabs: History, Health overview, Rooms. Arrow keys wrap around.
  await page.keyboard.press('ArrowLeft');
  await expect(roomsTab).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(healthTab).toBeFocused();
  await page.keyboard.press('Home');
  await expect(historyTab).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(healthTab).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await expect(roomsTab).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(healthTab).toHaveAttribute('aria-selected', 'true');
  await expect(historyTab).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('#health-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Today', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(metric(page, 'Transfers started')).toHaveText('12');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  // WebKit screenshot capture injects a `body {}` stylesheet that strict CSP
  // rejects. Check application errors before invoking that test-tool behavior.
  await page.screenshot({
    path: `test-results/health-mobile-${test.info().project.name}.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({
    path: `test-results/health-desktop-${test.info().project.name}.png`,
    fullPage: true,
  });
});

test('health failures show unavailable or stale data without preventing activity searches', async ({
  page,
}) => {
  const state = await setup(page);
  state.status = 503;
  await page.goto('https://admin.test/');
  await page.getByRole('tab', { name: 'Health overview', exact: true }).click();
  await expect(page.locator('#health-error')).toContainText('Could not update');
  await expect(metric(page, 'Transfers started')).toHaveText('—');
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Find transfers' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Find transfers' })).toBeEnabled();
  await page.getByRole('tab', { name: 'Health overview', exact: true }).click();
  state.status = 200;
  state.body.protection = null;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(metric(page, 'Transfers started')).toHaveText('12');
  await expect(metric(page, 'Blocked attempts')).toHaveText('—');
  await expect(page.locator('#health-error')).toContainText('Protection activity unavailable');
  state.body = { ...healthFixture(now), activity: null };
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(metric(page, 'Transfers started')).toHaveText('—');
  await expect(metric(page, 'Blocked attempts')).toHaveText('6');
  state.body = healthFixture(now);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(metric(page, 'Transfers started')).toHaveText('12');
  state.status = 503;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#health-error')).toContainText('Showing the last snapshot');
  await expect(metric(page, 'Transfers started')).toHaveText('12');
  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect(metric(page, 'Transfers started')).toHaveText('40');
  await expect(page.locator('#health-updated')).toContainText('Last successful update');
  state.status = 403;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#health-error')).toContainText('Your admin session ended');
});

test('health polling pauses while hidden and refreshes when the admin returns', async ({
  page,
}) => {
  await page.clock.install({ time: now });
  const state = await setup(page);
  await page.goto('https://admin.test/');
  await page.clock.fastForward(180000);
  expect(state.calls).toBe(0);
  await page.getByRole('tab', { name: 'Health overview', exact: true }).click();
  await expect(metric(page, 'Transfers started')).toHaveText('12');
  await page.clock.fastForward(60001);
  await expect.poll(() => state.calls).toBe(2);
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  await page.clock.fastForward(180000);
  expect(state.calls).toBe(2);
  await page.getByRole('tab', { name: 'Health overview', exact: true }).click();
  await expect.poll(() => state.calls).toBe(3);
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }),
  );
  await page.clock.fastForward(180000);
  expect(state.calls).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => state.calls).toBe(4);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'History', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('#health-panel')).toBeHidden();
  expect(state.calls).toBe(4);
});
