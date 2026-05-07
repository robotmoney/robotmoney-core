import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the human dapp. Keeps the dev server pinned to 5173
// so the Playwright fork-anvil walkthrough can target a stable URL.
// See docs/technical/dapp-credential-decisions.md for scope.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
