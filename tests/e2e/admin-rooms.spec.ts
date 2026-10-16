import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const now = Date.now();
const room = {
  id: 'b'.repeat(64),
  code: 'R00M42',
  created_at: now - 60_000,
  updated_at: now,
  expires_at: now + 86_000_000,
  ended_at: null,
  end_reason: null,
  status: 'open',
  member_count: 2,
  offer_count: 1,
  message_count: 7,
  owner_name: 'Teacher',
};
const detail = {
  room,
  members: [
    {
      member_id: '1'.repeat(32),
      name: 'Teacher',
      is_owner: 1,
      joined_at: now - 60_000,
      message_count: 5,
      message_bytes: 2048,
    },
    {
      member_id: '2'.repeat(32),
      name: '<img src=x onerror="window.hacked=true">',
      is_owner: 0,
      joined_at: now - 50_000,
      left_at: now - 1000,
      left_reason: 'removed',
      message_count: 0,
      message_bytes: 0,
    },
  ],
  connections: [
    {
      member_id: '2'.repeat(32),
      member_name: '<img src=x onerror="window.hacked=true">',
      ip: '203.0.113.7',
      country: 'NZ',
      connected_at: now - 50_000,
      disconnected_at: now - 1000,
      closed_by: 'server',
      close_code: 4011,
      close_reason: 'Removed',
    },
  ],
  refusals: [
    {
      at: now - 500,
      role: 'join',
      ip: '198.51.100.4',
      country: 'US',
      code: 4009,
      reason: '<b>Room full</b>',
    },
  ],
  offers: [
    {
      offer_id: 'e'.repeat(32),
      sender_id: '1'.repeat(32),
      sender_name: 'Teacher',
      created_at: now - 40_000,
      file_count: 1,
      total_size: 2048,
      files: [
        {
          file_id: 0,
          name: 'worksheet.pdf',
          size: 2048,
          mime_type: 'application/pdf',
          md5: '9'.repeat(32),
          sha256: '8'.repeat(64),
        },
        // Stored by a deployment that doesn't record file names.
        {
          file_id: 1,
          name: '',
          size: 1024,
          mime_type: 'image/png',
          md5: '7'.repeat(32),
          sha256: '6'.repeat(64),
        },
      ],
      deliveries: [
        {
          recipient_id: '2'.repeat(32),
          recipient_name: 'Student',
          status: 'complete',
          route: 'relay',
        },
      ],
    },
  ],
};

test('admin rooms tab lists rooms, searches and shows members, offers and connections as text', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/.test(message.text())) errors.push(message.text());
  });
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
  const searches: string[] = [];
  await page.route('https://admin.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (assets.has(url.pathname))
      return route.fulfill({
        ...assets.get(url.pathname),
        headers: {
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'",
        },
      });
    if (url.pathname === '/api/me') return route.fulfill({ json: { email: 'owner@example.com' } });
    if (url.pathname === '/api/transfers')
      return route.fulfill({ json: { items: [], next: null } });
    if (url.pathname === '/api/rooms') {
      searches.push(url.searchParams.get('q') ?? '');
      const q = url.searchParams.get('q');
      return route.fulfill({ json: { items: !q || q === 'worksheet' ? [room] : [], next: null } });
    }
    if (url.pathname === `/api/rooms/${room.id}`) return route.fulfill({ json: detail });
    return route.fulfill({ status: 404 });
  });
  await page.goto('https://admin.test/');
  await page.getByRole('tab', { name: 'Rooms' }).click();
  const record = page.locator('#rooms .record');
  await expect(record).toHaveCount(1);
  await expect(record).toContainText('R00M42');
  await expect(record).toContainText('Created by Teacher');
  await expect(record).toContainText('2 members · 1 offer · 7 messages');
  await expect(record.locator('.badge')).toHaveText('Open');

  await page.getByLabel('Search rooms').fill('nothing');
  await page.getByRole('button', { name: 'Find rooms' }).click();
  await expect(page.locator('#rooms-empty')).toBeVisible();
  await page.getByLabel('Search rooms').fill('worksheet');
  await page.getByRole('button', { name: 'Find rooms' }).click();
  await expect(record).toHaveCount(1);
  expect(searches).toEqual(['', 'nothing', 'worksheet']);

  await record.click();
  const content = page.locator('#room-content');
  await expect(content).toContainText('Teacher · creator');
  await expect(content).toContainText('<img src=x onerror="window.hacked=true">');
  await expect(content).toContainText('Removed by creator');
  await expect(content.locator('.connection-card').first()).toContainText('5 messages · 2.0 KiB');
  await expect(content.locator('.connection-card').nth(1)).toContainText('No messages');
  await expect(content).toContainText('worksheet.pdf');
  await expect(content).toContainText('Not recorded · 1.0 KiB · image/png');
  await expect(content).toContainText('8'.repeat(64));
  await expect(content).toContainText('Received · reported · relay');
  await expect(content).toContainText('203.0.113.7');
  await expect(content).toContainText('By the server: Removed (4011)');
  const refused = content.locator('.refusal-card');
  await expect(refused).toContainText('<b>Room full</b>');
  await expect(refused).toContainText('198.51.100.4');
  await expect(refused).toContainText('Join');
  expect(
    await page.evaluate(() => (window as unknown as { hacked?: boolean }).hacked),
  ).toBeUndefined();
  expect(await page.locator('#room-content img').count()).toBe(0);
  expect(errors).toEqual([]);
});
