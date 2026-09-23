import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

function calculateWorkers() {
  const total = os.cpus().length;

  // Reserve 2 cores for the system
  const usable = Math.max(total - 2, 1);

  // 1 worker per 2 cores, minimum 1
  const workers = Math.max(Math.floor(usable / 2), 1);

  // Max 6 workers
  return Math.min(workers, 6);
}

const ENV_FILES = ['.env', '.env.local', `.env.${process.env.NODE_ENV || 'development'}`];

ENV_FILES.forEach((file) => {
  dotenv.config({
    path: path.join(__dirname, `../../${file}`),
  });
});

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  workers: 10, // See Projects where 10 is utilized for API tests. We're not running 10 workers for UI tests.
  maxFailures: process.env.CI ? 1 : undefined,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 4 : 1,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [['html'], ['list']],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.NEXT_PUBLIC_WEBAPP_URL || 'http://localhost:3000',

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'retain-on-failure',
    video: 'retain-on-failure',

    /* Add explicit timeouts for actions */
    actionTimeout: 15_000,
    navigationTimeout: 30_000,

    contextOptions: {
      reducedMotion: 'reduce',
    },

    /* Disable animations via cookie for more stable tests */
    storageState: {
      cookies: [
        {
          name: '__disable_animations',
          value: 'true',
          domain: 'localhost',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax' as const,
        },
      ],
      origins: [],
    },
  },

  timeout: 60_000,

  /* Configure projects for major browsers */
  projects: [
    // API Tests e2e/api/**/*.spec.ts
    {
      name: 'api',
      testMatch: /e2e\/api\/.*\.spec\.ts/,
      workers: 10, // Limited by DB connections before it gets flakey.
    },
    // License tests that share a single license file - must run serially
    {
      name: 'license',
      testMatch: /e2e\/license\/.*\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1200 },
      },
      workers: 1, // Must run serially since they share a license file
    },
    // Run UI Tests (excluding license tests and the dedicated mobile-signing
    // suite below, which runs ONLY under the mobile-* device projects).
    {
      name: 'ui',
      testMatch: /e2e\/(?!api\/).*\.spec\.ts/,
      testIgnore: [/e2e\/license\/.*\.spec\.ts/, /e2e\/mobile-signing\/.*\.spec\.ts/],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1200 },
      },
      workers: calculateWorkers(),
    },

    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },

    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /**
     * DEV-659 -- Reeve.Sign mobile recipient-signing validation.
     *
     * Five profiles standing in for the ticket's "iPhone 12-15, Pixel 7-8,
     * iPad Mini, iPad Pro" acceptance criterion: the iPhone range is
     * bookended (12 = smallest/oldest, 15 = newest CSS viewport) rather than
     * covering all 4 iPhone generations 1:1, since Documenso's fork ships no
     * physical devices to test against -- see DEV-659's Linear ticket for the
     * full profile-selection rationale. Playwright 1.56.1 (this repo's
     * pinned version) has no "Pixel 8" or generic "iPad Pro" preset, so
     * "Pixel 7" and "iPad Pro 11" stand in for those groups; real dimensions
     * are whatever @playwright/test's `devices` registry ships for each name
     * below, not hand-picked/fabricated numbers.
     *
     * Scoped ONLY to e2e/mobile-signing -- never runs the rest of the UI
     * suite at a mobile viewport by accident.
     */
    {
      name: 'mobile-iphone-12',
      testMatch: /e2e\/mobile-signing\/.*\.spec\.ts/,
      use: { ...devices['iPhone 12'] },
    },
    {
      name: 'mobile-iphone-15',
      testMatch: /e2e\/mobile-signing\/.*\.spec\.ts/,
      use: { ...devices['iPhone 15'] },
    },
    {
      name: 'mobile-pixel-7',
      testMatch: /e2e\/mobile-signing\/.*\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-ipad-mini',
      testMatch: /e2e\/mobile-signing\/.*\.spec\.ts/,
      use: { ...devices['iPad Mini'] },
    },
    {
      name: 'mobile-ipad-pro-11',
      testMatch: /e2e\/mobile-signing\/.*\.spec\.ts/,
      use: { ...devices['iPad Pro 11'] },
    },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://127.0.0.1:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
