import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Base Vite/Vitest config — shared settings consumed by vitest.workspace.ts.
// Do NOT add test-runner settings here; those live in the workspace file.
export default defineConfig({
  plugins: [react()],
  define: {
    __DAPP_VERSION__: JSON.stringify("0.1.0"),
    __GIT_COMMIT__: JSON.stringify("test-commit"),
  },
});
