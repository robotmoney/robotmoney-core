/**
 * Playwright globalSetup. Boots the smoke-test full-stack devnet
 * unconditionally — every dapp E2E spec runs against a real
 * Geth+Lighthouse chain with the gateway deployed and the dapp
 * container built with the deployed runtime hash pinned. There is no
 * fast-path local dev-server mode; all specs see a prod-bit-identical
 * dapp bundle.
 *
 * Flow:
 *   - Spawns `cargo run -p smoke-test -- --full-stack`.
 *   - Reads stdout line-by-line until the "--- endpoint summary ---"
 *     block emits every required key=value pair.
 *   - Writes the parsed values to a temp JSON file whose path is
 *     stored in `DEVNET_ENDPOINTS_FILE`. Specs read that file via
 *     `helpers/devnet.ts`.
 *   - globalTeardown kills the child process; the binary's Drop runs
 *     `docker compose down` on both compose stacks.
 *
 * Canonical: docs/development/smoke-test-design.md, issue #245.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as readline from "node:readline";
import type { FullConfig } from "@playwright/test";

const REQUIRED_KEYS = [
  "rpc_url",
  "dapp_url",
  "explorer_api_url",
  "chain_id",
  "gateway_addr",
  "vault_addr",
  "usdc_addr",
  "agent_addr",
  "admin_addr",
  "pauser_addr",
  "share_receiver_addr",
  "admin_private_key",
  "pauser_private_key",
  "agent_private_key",
  "gateway_runtime_hash",
  "harness_usdc_holder_addr",
  "harness_usdc_holder_private_key",
  // Issue #320: vault-selector and router deposit flow.
  "registry_addr",
  "router_addr",
] as const;
type RequiredKey = (typeof REQUIRED_KEYS)[number];

function findCargoWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`devnet-global-setup: no Cargo.toml found from ${startDir}`);
}

let smokeTestProc: ChildProcess | null = null;
let endpointsFilePath: string | null = null;

function waitForEndpoints(proc: ChildProcess, timeoutMs: number): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const acc: Record<string, string> = {};
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const missing = REQUIRED_KEYS.filter((k) => !(k in acc));
      reject(
        new Error(
          `devnet-global-setup: timed out after ${timeoutMs / 1000}s waiting for endpoint ` +
            `summary. Missing keys: [${missing.join(", ")}]`,
        ),
      );
    }, timeoutMs);

    function trySettle() {
      if (settled) return;
      if (REQUIRED_KEYS.every((k) => k in acc)) {
        settled = true;
        clearTimeout(timer);
        resolve(acc);
      }
    }

    if (!proc.stdout) {
      clearTimeout(timer);
      reject(new Error("devnet-global-setup: smoke-test has no stdout pipe"));
      return;
    }

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      process.stdout.write(`[smoke-test] ${line}\n`);
      const eq = line.indexOf("=");
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if ((REQUIRED_KEYS as readonly string[]).includes(key)) {
        acc[key] = value;
        trySettle();
      }
    });

    if (proc.stderr) {
      const errRl = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
      errRl.on("line", (line) => process.stderr.write(`[smoke-test stderr] ${line}\n`));
    }

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`devnet-global-setup: smoke-test spawn error: ${err.message}`));
    });
    proc.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `devnet-global-setup: smoke-test exited prematurely (code=${code}, signal=${signal}) ` +
            `before emitting the endpoint summary`,
        ),
      );
    });
  });
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const cargoRoot = findCargoWorkspaceRoot(
    path.resolve(fileURLToPath(import.meta.url), "../../../.."),
  );
  console.log(`devnet-global-setup: cargo workspace root = ${cargoRoot}`);
  console.log("devnet-global-setup: spawning smoke-test --full-stack …");

  smokeTestProc = spawn("cargo", ["run", "-p", "smoke-test", "--", "--full-stack"], {
    cwd: cargoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const BOOT_TIMEOUT_MS = 15 * 60 * 1000;
  let raw: Record<string, string>;
  try {
    raw = await waitForEndpoints(smokeTestProc, BOOT_TIMEOUT_MS);
  } catch (err) {
    if (smokeTestProc && !smokeTestProc.killed) smokeTestProc.kill("SIGTERM");
    throw err;
  }

  const endpoints: Record<RequiredKey, string | number> = {
    rpc_url: raw.rpc_url,
    dapp_url: raw.dapp_url,
    explorer_api_url: raw.explorer_api_url,
    chain_id: Number(raw.chain_id),
    gateway_addr: raw.gateway_addr,
    vault_addr: raw.vault_addr,
    usdc_addr: raw.usdc_addr,
    agent_addr: raw.agent_addr,
    admin_addr: raw.admin_addr,
    pauser_addr: raw.pauser_addr,
    share_receiver_addr: raw.share_receiver_addr,
    admin_private_key: raw.admin_private_key,
    pauser_private_key: raw.pauser_private_key,
    agent_private_key: raw.agent_private_key,
    gateway_runtime_hash: raw.gateway_runtime_hash,
    harness_usdc_holder_addr: raw.harness_usdc_holder_addr,
    harness_usdc_holder_private_key: raw.harness_usdc_holder_private_key,
    // Issue #320: vault-selector and router deposit flow.
    registry_addr: raw.registry_addr,
    router_addr: raw.router_addr,
  };

  console.log("devnet-global-setup: endpoint summary received");
  endpointsFilePath = path.join(os.tmpdir(), `devnet-endpoints-${process.pid}.json`);
  fs.writeFileSync(endpointsFilePath, JSON.stringify(endpoints, null, 2), "utf8");
  process.env.DEVNET_ENDPOINTS_FILE = endpointsFilePath;
  console.log(`devnet-global-setup: endpoints written to ${endpointsFilePath}`);
}

export async function globalTeardown(): Promise<void> {
  console.log("devnet-global-teardown: killing smoke-test …");
  if (smokeTestProc && !smokeTestProc.killed) {
    smokeTestProc.kill("SIGTERM");
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        if (smokeTestProc && !smokeTestProc.killed) smokeTestProc.kill("SIGKILL");
        res();
      }, 60_000);
      smokeTestProc!.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
  }
  if (endpointsFilePath) {
    try {
      fs.unlinkSync(endpointsFilePath);
    } catch {
      /* file may already be gone */
    }
    endpointsFilePath = null;
  }
  console.log("devnet-global-teardown: done.");
}
