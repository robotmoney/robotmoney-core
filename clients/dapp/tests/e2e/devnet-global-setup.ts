/**
 * Playwright globalSetup for the full-stack Geth+Lighthouse devnet E2E suite.
 *
 * Gated by DEVNET_E2E_ENABLED=1. When active:
 *   - Spawns `cargo run --bin smoke-test -- --full-stack` as a child process.
 *   - Reads stdout line-by-line until the "--- endpoint summary ---" block
 *     appears and all four key=value pairs are parsed.
 *   - Writes the parsed endpoints to a temp JSON file whose path is stored in
 *     DEVNET_ENDPOINTS_FILE so devnet-e2e.spec.ts can read it.
 *   - globalTeardown kills the child process, which triggers the binary's
 *     Drop teardown of both compose stacks (devnet chain + dapp stack).
 *
 * Canonical: docs/implementation-plan.md §10.5, issue #230.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { FullConfig } from "@playwright/test";

/** Path to the cargo workspace root — walk up until Cargo.toml is found. */
function findCargoWorkspaceRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, "Cargo.toml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `devnet-global-setup: could not locate Cargo.toml workspace root from ${startDir}`,
  );
}

/** Parsed fields from the smoke-test stdout (plain kv + endpoint summary block). */
export interface DevnetEndpoints {
  rpc_url: string;
  dapp_url: string;
  gateway_addr: string;
  vault_addr: string;
  usdc_addr: string;
  /** Agent EOA address from the devnet fixture (printed as `agent_addr=0x…`). */
  agent_addr?: string;
}

let smokeTestProc: ChildProcess | null = null;
let endpointsFilePath: string | null = null;

/**
 * Parse key=value lines from the smoke-test stdout.
 * Accepts lines like `rpc_url=http://127.0.0.1:8545`.
 */
function parseLine(line: string, acc: Partial<DevnetEndpoints>): void {
  const eq = line.indexOf("=");
  if (eq === -1) return;
  const key = line.slice(0, eq).trim() as keyof DevnetEndpoints;
  const value = line.slice(eq + 1).trim();
  if (
    key === "rpc_url" ||
    key === "dapp_url" ||
    key === "gateway_addr" ||
    key === "vault_addr" ||
    key === "usdc_addr" ||
    key === "agent_addr"
  ) {
    acc[key] = value;
  }
}

/**
 * Wait up to `timeoutMs` for the smoke-test child process to emit a
 * complete endpoint summary. Returns the parsed endpoints or throws.
 *
 * The binary prints these lines between the sentinel markers:
 *   --- endpoint summary ---
 *   rpc_url=...
 *   dapp_url=...
 *   explorer_api_url=...  (ignored — we only care about rpc/dapp)
 *   --- end endpoint summary ---
 *
 * The gateway_addr, vault_addr, and usdc_addr are printed before the
 * summary block (part of the plain fixture output):
 *   gateway_addr=0x...
 *   vault_addr=0x...
 *   usdc_addr=0x...
 */
function waitForEndpoints(proc: ChildProcess, timeoutMs: number): Promise<DevnetEndpoints> {
  return new Promise((resolve, reject) => {
    const acc: Partial<DevnetEndpoints> = {};
    let inSummary = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "devnet-global-setup: timed out waiting for smoke-test endpoint summary " +
              `(${timeoutMs / 1000}s). Check that cargo builds and docker is available.`,
          ),
        );
      }
    }, timeoutMs);

    function trySettle() {
      if (settled) return;
      if (acc.rpc_url && acc.dapp_url && acc.gateway_addr && acc.vault_addr && acc.usdc_addr) {
        settled = true;
        clearTimeout(timer);
        resolve(acc as DevnetEndpoints);
      }
    }

    // Parse stdout (endpoint summary + plain kv lines printed before it).
    if (!proc.stdout) {
      reject(new Error("devnet-global-setup: smoke-test has no stdout pipe"));
      clearTimeout(timer);
      return;
    }

    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      process.stdout.write(`[smoke-test] ${line}\n`);
      if (line.trimEnd() === "--- endpoint summary ---") {
        inSummary = true;
        return;
      }
      if (line.trimEnd() === "--- end endpoint summary ---") {
        inSummary = false;
        trySettle();
        return;
      }
      // Parse every kv line regardless of inSummary: gateway_addr/vault_addr/
      // usdc_addr are emitted before the summary marker.
      parseLine(line, acc);
      if (inSummary) trySettle();
    });

    // Relay stderr for debugging.
    if (proc.stderr) {
      const errRl = readline.createInterface({ input: proc.stderr, crlfDelay: Infinity });
      errRl.on("line", (line) => process.stderr.write(`[smoke-test stderr] ${line}\n`));
    }

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`devnet-global-setup: smoke-test spawn error: ${err.message}`));
      }
    });

    proc.on("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `devnet-global-setup: smoke-test exited prematurely ` +
              `(code=${code}, signal=${signal}) before emitting endpoint summary`,
          ),
        );
      }
    });
  });
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.DEVNET_E2E_ENABLED !== "1") {
    // Not enabled — nothing to boot.
    return;
  }

  const cargoRoot = findCargoWorkspaceRoot(path.resolve(__dirname, "../../../.."));
  console.log(`devnet-global-setup: cargo workspace root = ${cargoRoot}`);
  console.log("devnet-global-setup: spawning smoke-test --full-stack …");

  smokeTestProc = spawn("cargo", ["run", "--bin", "smoke-test", "--", "--full-stack"], {
    cwd: cargoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    // Detach so the child's process group can be killed on teardown.
    detached: false,
  });

  // Boot timeout: building + devnet start + health checks can take up to
  // 10 minutes on a cold machine. Warm builds are typically 120-180s.
  const BOOT_TIMEOUT_MS = 10 * 60 * 1000;

  let endpoints: DevnetEndpoints;
  try {
    endpoints = await waitForEndpoints(smokeTestProc, BOOT_TIMEOUT_MS);
  } catch (err) {
    // Kill the child if we timed out or it failed to start.
    if (smokeTestProc && !smokeTestProc.killed) {
      smokeTestProc.kill("SIGTERM");
    }
    throw err;
  }

  console.log("devnet-global-setup: endpoint summary received:", endpoints);

  // Write endpoints to a temp file so devnet-e2e.spec.ts can read them
  // without relying on env-var inheritance across worker processes.
  endpointsFilePath = path.join(os.tmpdir(), `devnet-endpoints-${process.pid}.json`);
  fs.writeFileSync(endpointsFilePath, JSON.stringify(endpoints, null, 2), "utf8");
  process.env.DEVNET_ENDPOINTS_FILE = endpointsFilePath;

  console.log(`devnet-global-setup: endpoints written to ${endpointsFilePath}`);
}

export async function globalTeardown(): Promise<void> {
  if (process.env.DEVNET_E2E_ENABLED !== "1") {
    return;
  }

  console.log("devnet-global-teardown: killing smoke-test process …");
  if (smokeTestProc && !smokeTestProc.killed) {
    smokeTestProc.kill("SIGTERM");
    // Give the process a moment to run its Drop cleanup (docker compose down).
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        // Force kill if it hasn't exited within 60s.
        if (smokeTestProc && !smokeTestProc.killed) {
          smokeTestProc.kill("SIGKILL");
        }
        res();
      }, 60_000);
      smokeTestProc!.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
  }

  // Clean up the temp endpoints file.
  if (endpointsFilePath) {
    try {
      fs.unlinkSync(endpointsFilePath);
    } catch {
      // ignore — file may already be gone
    }
    endpointsFilePath = null;
  }

  console.log("devnet-global-teardown: done.");
}
