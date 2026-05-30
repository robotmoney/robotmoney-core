import { defineWorkspace } from "vitest/config";

// Two test projects:
//
// "browser" — Playwright/Chromium for all component and logic tests.
//   Uses a real WagmiProvider wrapper (see tests/unit/setup.ts) so wagmi
//   hooks have React context when the browser loads components via Vite's
//   pre-bundled wagmi (vi.mock("wagmi") only intercepts the test file's
//   own imports in browser mode, not those of component source files).
//
// "node"    — Pure Node.js for tests that read files from disk via node:fs.
//   These cannot run in a real browser.
export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "browser",
      globals: true,
      browser: {
        enabled: true,
        name: "chromium",
        provider: "playwright",
        headless: true,
      },
      setupFiles: ["./tests/unit/setup.ts"],
      include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],
      exclude: [
        "tests/e2e/**",
        "node_modules/**",
        "tests/unit/env-example-warning.test.ts",
        "tests/unit/faucet-shared-amount.test.ts",
      ],
    },
  },
  {
    extends: "./vitest.config.ts",
    test: {
      name: "node",
      globals: true,
      environment: "node",
      setupFiles: ["./tests/unit/setup.node.ts"],
      include: [
        "tests/unit/env-example-warning.test.ts",
        "tests/unit/faucet-shared-amount.test.ts",
      ],
    },
  },
]);
