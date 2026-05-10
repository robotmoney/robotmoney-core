import { defineConfig } from "@playwright/test";

// Playwright config for the human-dapp E2E flows.
//
// Default mode (no special env):
//   The fork-anvil sidecar is started by CI (.github/workflows/dapp.yml) or
//   the developer ahead of time; the dapp itself reads RPC URL from the
//   VITE_FORK_RPC_URL env var. Locally, run:
//
//     anvil --fork-url $RMPC_FORK_RPC_URL --port 8545 &
//     pnpm test:e2e
//
// Full-stack devnet mode (DEVNET_E2E_ENABLED=1):
//   devnet-global-setup.ts spawns `cargo run --bin smoke-test -- --full-stack`,
//   parses the endpoint summary printed to stdout, and writes the addresses to a
//   temp JSON file. The baseURL is set to the dapp_url from that summary.
//   globalTeardown kills the process, which triggers Drop teardown of both
//   compose stacks. No shell harness script is needed.
//
//   Run with:
//     DEVNET_E2E_ENABLED=1 pnpm test:e2e -- devnet-e2e.spec.ts
//
// We do not optimize for fast feedback here; per the user memory
// "no fast-feedback optimization in test harness" we boot a real chain
// rather than a mocked transport.

const DEVNET_E2E = process.env.DEVNET_E2E_ENABLED === "1";

// In devnet mode the dapp is already running inside the docker compose stack
// booted by the smoke-test binary, so we point Playwright at the pre-existing
// container-served URL rather than spinning up vite dev/preview.
const devnetDappUrl = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./tests/e2e",
  // Devnet tests can take longer: real block times (~12s) + boot overhead.
  timeout: DEVNET_E2E ? 180_000 : 60_000,
  expect: { timeout: DEVNET_E2E ? 30_000 : 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],

  // Conditionally load globalSetup/globalTeardown for devnet mode.
  ...(DEVNET_E2E
    ? {
        globalSetup: "./tests/e2e/devnet-global-setup.ts",
        globalTeardown: "./tests/e2e/devnet-global-teardown.ts",
      }
    : {}),
  use: {
    baseURL: DEVNET_E2E ? devnetDappUrl : "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "on",
  },

  // In devnet mode the dapp container is already up (started by smoke-test).
  // We reuse the existing server rather than launching a new vite process.
  webServer: DEVNET_E2E
    ? {
        command: "echo 'devnet mode: dapp served by smoke-test compose stack'",
        url: devnetDappUrl,
        reuseExistingServer: true,
        timeout: 30_000,
      }
    : {
        // Use the production preview server in CI: it does not need a
        // long Vite dev-server warmup, which on slow CI runners blows
        // through the default 60s timeout. Locally we still spin up the
        // dev server for fast iteration.
        command: process.env.CI
          ? "pnpm build && pnpm preview --port 5173 --host 127.0.0.1"
          : "pnpm dev",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
