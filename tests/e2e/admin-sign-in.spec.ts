import { expect, test } from '@playwright/test';

// The real dashboard Worker with password sign-in (scripts/preview-admin.mjs), driven
// through its form the way a person signs in: unit tests can't show what a browser
// sends with the form.
const ADMIN = 'https://localhost:8789';
test.use({ ignoreHTTPSErrors: true }); // Wrangler's local certificate
const PASSWORD = 'local test password';

test('the dashboard signs in and out with its password', async ({ page }) => {
  await page.goto(ADMIN);
  await expect(page).toHaveURL(`${ADMIN}/login`);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('That password is not right.');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(`${ADMIN}/`);
  await expect(page.locator('#email')).toHaveText('Administrator');
  await expect(page.locator('#sign-out')).toHaveAttribute('href', '/logout');
  await page.locator('#sign-out').click();
  await expect(page).toHaveURL(`${ADMIN}/login`);
  await page.goto(`${ADMIN}/`);
  await expect(page).toHaveURL(`${ADMIN}/login`);
});
