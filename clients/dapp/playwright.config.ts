import { defineConfig } from "@playwright/test";

// Playwright config for the human-dapp E2E flows.
//
// The fork-anvil sidecar is started by CI (.github/workflows/dapp.yml) or
// the developer ahead of time; the dapp itself reads RPC URL from the
// VITE_FORK_RPC_URL env var. Locally, run:
//
//   anvil --fork-url $RMPC_FORK_RPC_URL --port 8545 &
//   pnpm test:e2e
//
// We do not optimize for fast feedback here; per the user memory
// "no fast-feedback optimization in test harness" we boot a real anvil
// rather than a mocked transport.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "on",
  },
  webServer: {
    // Use the production preview server in CI: it does not need a
    // long Vite dev-server warmup, which on slow CI runners blows
    // through the default 60s timeout. Locally we still spin up the
    // dev server for fast iteration.
    command: process.env.CI ? "pnpm build && pnpm preview --port 5173 --host 127.0.0.1" : "pnpm dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
