/**
 * Playwright config for the READ-ONLY public-deployment check (QA finding R20).
 *
 * Separate from `playwright.config.ts` for one reason: that config's
 * `globalSetup` boots the full-stack smoke-test devnet (Geth, Lighthouse,
 * contracts, containers — several minutes). Checking what a already-deployed
 * public URL serves needs none of it, and must not be able to mutate anything.
 *
 *   PUBLIC_DAPP_URL=https://stage-dapp.robotmoney-labs.dev \
 *     bunx playwright test -c playwright.public.config.ts
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/public",
  testMatch: ["**/*.spec.ts"],
  timeout: 3 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results-public",
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? "playwright-report-public",
      },
    ],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "on",
  },
});
