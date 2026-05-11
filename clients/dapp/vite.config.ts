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
  preview: {
    // The preview server is used only to serve the prebuilt `dist/` bundle
    // locally (dev iteration, smoke-test harness, hosted demo behind a
    // reverse proxy or tunnel). It does not run in production — operators
    // serve the static bundle from a CDN / nginx / IPFS — so the Host
    // header policy is a local-server concern, not a bundle concern.
    // `true` accepts any Host so ephemeral tunnel hostnames work without
    // bake-time configuration.
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
