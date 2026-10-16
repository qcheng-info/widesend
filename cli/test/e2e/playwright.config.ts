import { defineConfig, devices } from '@playwright/test';
// Browser and CLI tests against the isolated local Worker that the root e2e suite uses.
export default defineConfig({
  testDir: '.',
  outputDir: '../../../test-results/cli',
  timeout: 180_000,
  expect: { timeout: 30_000 },
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
  webServer: {
    command: 'npm run preview:test',
    cwd: '../../..',
    url: 'http://localhost:8788/api/health',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
