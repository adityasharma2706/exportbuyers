/**
 * M39 — Playwright config for the LLD M39 #1 mobile QA suite: "a Playwright suite on a Moto G
 * Power emulation over throttled 4G, covering Flows 1, 2 and 4. It asserts the §7 budgets."
 *
 * `baseURL` points at a running instance of this app (started separately — `npm run build &&
 * node dist/server.js` in CI, or `npm run dev` locally); Playwright itself does not boot the
 * server here because doing so needs the full platform boot sequence (DB, Redis, secrets — M01
 * `bootPlatform()`), which is an operational concern outside a single test config file.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false, // the anti-scrape and pipeline-budget assertions share test accounts
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'playwright-results.xml' }]] : [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'moto-g-power-4g',
      use: {
        // Moto G Power (LLD M39 #1 / M04's LIGHTHOUSE_DEVICE_PROFILE), matched exactly so the
        // e2e assertions and the Lighthouse CI budgets (apps/web/lighthouserc.json) cannot drift.
        viewport: { width: 412, height: 823 },
        deviceScaleFactor: 1.75,
        isMobile: true,
        hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 11; moto g power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
      },
    },
  ],
});
