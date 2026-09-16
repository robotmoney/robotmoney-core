/**
 * Playwright configuration for the Fusion acceptance driver.
 *
 * This deliberately reuses the production-artifact spec but does not invoke
 * the normal global setup: that setup creates a new smoke devnet, whereas the
 * acceptance run must inspect the receipt already anchored on staging.  The
 * receipt id and URL remain mandatory in the spec itself, so this config
 * cannot turn an absent real artifact into a fixture pass.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/consensus-receipts.spec.ts"],
  timeout: 5 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results/fusion",
  reporter: [["list"], ["html", { open: "never", outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? "playwright-report/fusion" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "on",
    launchOptions: { args: ["--host-resolver-rules=MAP receipt-fixtures 127.0.0.1"] },
  },
});
