// End-to-end tests (Playwright). They drive the real web app against the demo data.
//
//   npm run db:seed          once, so that the demo accounts exist
//   npx playwright install chromium   once, to download the browser
//   npm run test:e2e
//
// The suite starts the app with `npm run dev` unless it is already running.
//   E2E_BASE_URL        where the web app is served (default http://localhost:5173)
//   E2E_NO_SERVER=1     never start the app; fail if it is not running
//   E2E_CHROMIUM_PATH   use this Chromium binary instead of the one Playwright downloads
//   E2E_CHROMIUM_ARGS   extra browser flags, space separated (for example "--no-sandbox")
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The tests share one database (the demo school), so they run one after another.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL,
    locale: 'en-PH',
    timezoneId: 'Asia/Manila',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.E2E_CHROMIUM_PATH || undefined,
      args: (process.env.E2E_CHROMIUM_ARGS ?? '').split(' ').filter(Boolean),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : { command: 'npm run dev', cwd: '..', url: `${baseURL}/login`, reuseExistingServer: true, timeout: 180_000, stdout: 'ignore', stderr: 'pipe' },
});
