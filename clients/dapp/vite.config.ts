import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { validateFaucetKeyForBuild } from "./src/lib/buildEnvValidation";

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
export default defineConfig(({ command, mode }) => {
  // Issue #431 — refuse to build a production-like bundle that contains
  // the testnet faucet private key. `loadEnv("", cwd, "")` reads BOTH
  // process.env and `.env*` files with no prefix filter so we see
  // VITE_ENV_CLASS / VITE_FAUCET_HARNESS_PRIVATE_KEY exactly as the
  // bundle would inline them. The gate runs on `command === "build"`
  // only; the dev server is unaffected.
  const env = loadEnv(mode, process.cwd(), "");
  const faucetCheck = validateFaucetKeyForBuild({ env, command, mode });
  if (!faucetCheck.ok) {
    // Throw rather than process.exit so Vite's error reporting surfaces
    // the message verbatim in CI logs and local builds.
    throw new Error(`[dapp build] faucet-key guard failed: ${faucetCheck.reason}`);
  }

  return {
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
  };
});

function execGit(command: string): string | undefined {
  try {
    return execSync(command, { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}
