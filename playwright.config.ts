import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  use: { baseURL: 'http://localhost:8788', acceptDownloads: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: {
          firefoxUserPrefs: {
            'media.peerconnection.ice.obfuscate_host_addresses': false,
            'media.peerconnection.ice.loopback': true,
          },
        },
      },
    },
  ],
  webServer: [
    {
      command: 'npm run preview:test',
      url: 'http://localhost:8788/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // The dashboard with password sign-in (tests/e2e/admin-sign-in.spec.ts).
      command: 'node scripts/preview-admin.mjs',
      url: 'https://localhost:8789/login',
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
