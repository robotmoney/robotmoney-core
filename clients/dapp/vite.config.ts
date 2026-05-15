import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  version?: string;
};
const gitCommit =
  process.env.GITHUB_SHA ??
  process.env.VITE_GIT_COMMIT ??
  execGit("git rev-parse --short=12 HEAD") ??
  "unknown";

// Vite config for the human dapp. Keeps the dev server pinned to 5173
// so the Playwright fork-anvil walkthrough can target a stable URL.
// See docs/technical/dapp-credential-decisions.md for scope.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __DAPP_VERSION__: JSON.stringify(packageJson.version ?? "0.0.0"),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
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

function execGit(command: string): string | undefined {
  try {
    return execSync(command, { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}
