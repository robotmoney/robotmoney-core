/**
 * Single-mode Playwright config. Every spec runs against the
 * smoke-test full-stack devnet booted by `devnet-global-setup.ts`:
 * real Geth + Lighthouse, real deployed contracts, dapp container
 * built with the gateway runtime code hash pinned at build time.
 *
 * There is no local dev-server fast path. Tests must exercise a
 * bundle that is bit-identical to a production deployment, with no
 * test-only env flags compiled into the dapp source.
 *
 * Canonical: docs/testing/smoke-test-design.md.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/*.spec.ts"],
  // Booting the devnet + building the dapp image takes several
  // minutes; specs themselves wait on real block production
  // (~12s per block). Use generous timeouts.
  timeout: 5 * 60 * 1000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./tests/e2e/devnet-global-setup.ts",
  globalTeardown: "./tests/e2e/devnet-global-teardown.ts",
  use: {
    trace: "retain-on-failure",
    screenshot: "on",
  },
});
