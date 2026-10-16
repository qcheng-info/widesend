import { test, expect } from '@playwright/test';

const locales = [
  ['zh-CN', 'zh-Hans', '简体中文', '随时随地，传送文件。', '接收文件'],
  ['fr-CA', 'fr', 'Français', 'Envoyez vos fichiers partout.', 'Recevoir des fichiers'],
  ['es-MX', 'es', 'Español', 'Envía archivos a cualquier lugar.', 'Recibir archivos'],
  ['ja-JP', 'ja', '日本語', 'どこへでもファイルを送信。', 'ファイルを受信'],
  ['ko-KR', 'ko', '한국어', '어디로든 파일을 보내세요.', '파일 받기'],
];
test('all public languages detect, persist, and fit mobile send/receive screens', async ({
  browser,
  baseURL,
}) => {
  for (const [locale, lang, name, heading, receive] of locales) {
    const context = await browser.newContext({
      baseURL,
      locale,
      viewport: { width: 375, height: 812 },
    });
    try {
      const page = await context.newPage();
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
      await expect(page.locator('.activity-notice, .benefits, .personal-badge')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('tab', { name: receive }).click();
      await expect(page.locator('.code-input input')).toHaveCount(6);
      await expect(page.locator('.receive-icon')).toHaveCount(0);
      await expect(page.locator('#receive-code-label')).toHaveClass('visually-hidden');
      const boxes = await page.locator('.code-input').boundingBox();
      const description = await page.locator('#receive-code-hint').boundingBox();
      expect(boxes!.y - description!.y - description!.height).toBeLessThan(70);
      await page.locator('.code-input input').first().fill('ab12cd');
      await expect(page.locator('.receive-form button[type="submit"]')).toBeEnabled();
      await page.screenshot({
        path: `test-results/receive-${lang}-${test.info().project.name}.png`,
        fullPage: true,
      });
      await page.locator('.language-toggle').click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      // Switching language preserves form state.
      await expect(page.locator('.code-input input').first()).toHaveValue('A');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await page.locator('.language-toggle').press('ArrowDown');
      await page.keyboard.press('End');
      await expect(page.getByRole('menuitemradio', { name: '한국어' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.locator('.language-toggle')).toBeFocused();
      await page.locator('.language-toggle').click();
      await page.getByRole('menuitemradio', { name, exact: true }).click();
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await page.locator('.help-button').click();
      await expect(page.locator('.help-panel')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await context.close();
    }
  }
});

test('language selection works without local storage', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, locale: 'fr-FR' });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new DOMException('Blocked', 'SecurityError');
        },
      });
    });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await page.locator('.language-toggle').click();
    await page.getByRole('menuitemradio', { name: '日本語' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  } finally {
    await context.close();
  }
});
