import { expect, test } from '@playwright/test';

// The local preview has no activity database, like a self-hosted site without the dashboard.
test('How it works says what this site records', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'How it works' }).click();
  const panel = page.locator('.help-panel');
  await expect(panel.getByRole('heading', { name: 'This site' })).toBeVisible();
  await expect(panel).toContainText('This site keeps no record of your transfers.');
  await expect(panel).toContainText('relay');
  await expect(panel).toContainText('Apache-2.0');
  await expect(panel.getByRole('link')).toHaveCount(0);
});
