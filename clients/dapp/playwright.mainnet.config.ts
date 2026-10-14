/**
 * Playwright config for the MAINNET-CLASS bundle (QA plan U5, issue 1737 item 3).
 *
 * The devnet suite (`playwright.config.ts`) builds the dapp with VITE_ENV_CLASS=fork, so the mainnet
 * banner, the wrong-chain gate and the blocked writes never ran in a real browser. This config builds
 * its own bundle with VITE_ENV_CLASS=mainnet and VITE_CHAIN_ID=8453, serves it with `vite preview` on
 * loopback, and runs `tests/mainnet/` against it. The specs inject a mocked `window.ethereum` that can
 * sit on chain 1, 918453 or 8453 and records every method it is asked. No chain, no devnet, no key:
 * the bundle carries placeholder addresses and an empty faucet key.
 *
 *   bunx playwright test -c playwright.mainnet.config.ts
 */
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.MAINNET_CLASS_PORT ?? 4180);
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** The build env of the mainnet-class bundle. Placeholder contracts: the mocked wallet answers every read. */
export const MAINNET_CLASS_BUILD_ENV: Record<string, string> = {
  VITE_ENV_CLASS: "mainnet",
  VITE_CHAIN_ID: "8453",
  VITE_FAUCET_HARNESS_PRIVATE_KEY: "",
  VITE_DEVNET_RPC_URL: "",
  VITE_GATEWAY_ADDRESS: A(0x1001),
  VITE_VAULT_ADDRESS: A(0x1002),
  VITE_REGISTRY_ADDRESS: A(0x1003),
  VITE_ROUTER_ADDRESS: A(0x1004),
  // No explorer is running: a closed loopback port, so explorer reads fail fast.
  VITE_EXPLORER_API_URL: "http://127.0.0.1:1",
};

export default defineConfig({
  testDir: "./tests/mainnet",
  testMatch: ["**/*.spec.ts"],
  timeout: 2 * 60 * 1000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results-mainnet",
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? "playwright-report-mainnet",
      },
    ],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // `dist/` is gitignored; the mainnet-class bundle gets its own folder so it never replaces a dev build.
    command:
      `bun x vite build --outDir dist/mainnet-class && ` +
      `bun x vite preview --outDir dist/mainnet-class --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    timeout: 5 * 60 * 1000,
    reuseExistingServer: false,
    env: MAINNET_CLASS_BUILD_ENV,
  },
});
