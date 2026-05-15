import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config — jsdom for component tests, exclude Playwright specs
// so the unit suite never picks up an E2E file by accident.
export default defineConfig({
  plugins: [react()],
  define: {
    __DAPP_VERSION__: JSON.stringify("0.1.0"),
    __GIT_COMMIT__: JSON.stringify("test-commit"),
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/unit/setup.ts"],
    include: ["tests/unit/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
});
