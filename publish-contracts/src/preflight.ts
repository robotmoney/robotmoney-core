// The preflight chain (devops 58, S11). --dry-run simulates every deployer stage in table order on a local anvil that the preflight
// starts itself, a lazy FORK of the target RPC (the vault stages need the real USDC, Aave, Compound and Moonwell, a blank chain has none).
// Each simulated stage is also applied to that local chain, so a later stage (registry, router, gateway, the vaults, timelock) finds the
// contracts and the manifest of the earlier one. The target only answers reads: nothing is ever sent to it. When anvil is not installed
// the preflight falls back to simulating against the target RPC, which still broadcasts nothing, and says so in the log.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeAbiParameters, keccak256, pad, toHex, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { USDC_ADDRESS } from "./usdc.ts";

export interface PreflightChain {
  rpc: string;
  stop(): Promise<void>;
  /** Tops the deployer up to `units` USDC on this local chain only (the seed deposit needs it). Absent on a test double. */
  topUpUsdc?(deployer: string, units: bigint): Promise<void>;
}
/** Starts a local chain with the given chain id, forking `forkUrl` when given. Returns undefined when no local chain tool is installed. */
export type ChainStarter = (chainId: number, forkUrl?: string) => Promise<PreflightChain | undefined>;

const freePort = (): Promise<number> => new Promise((res, rej) => {
  const s = createServer();
  s.once("error", rej);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); });
});

async function rpcChainId(url: string): Promise<number | undefined> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    const j = (await r.json()) as { result?: string };
    return j.result ? Number(BigInt(j.result)) : undefined;
  } catch { return undefined; }
}

/**
 * The real starter: `anvil --chain-id N` on a free loopback port, no state file. With `forkUrl` it is a lazy local fork of the target
 * (read-only: the target only answers reads, every simulated transaction stays on this process). The vault stages need the real USDC,
 * Aave, Compound and Moonwell contracts, which a chain with no history does not have, so the preflight forks the target. The URL goes
 * is a command-line argument of anvil (anvil does not read it from the environment), so a keyed endpoint is visible in `ps` to local
 * users of the host, the same exposure the Twin fork tool documents.
 */
export const startAnvil: ChainStarter = async (chainId, forkUrl) => {
  if (!Bun.which("anvil")) return undefined;
  const port = await freePort();
  const args = ["--chain-id", String(chainId), "--port", String(port), "--host", "127.0.0.1", "--silent", ...(forkUrl ? ["--fork-url", forkUrl] : [])];
  const child: ChildProcess = spawn("anvil", args, { stdio: "ignore" });
  const rpc = `http://127.0.0.1:${port}`;
  let exited = false;
  child.once("exit", () => { exited = true; });
  for (let i = 0; i < 100; i++) {
    if (exited) throw new PublishError("TOOL", "anvil exited before it was ready");
    if ((await rpcChainId(rpc)) === chainId) {
      return { rpc, stop: async () => { if (!exited) child.kill("SIGTERM"); }, topUpUsdc: (d, u) => topUpSimulationUsdc(rpc, d, u) };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill("SIGKILL");
  throw new PublishError("TOOL", "anvil did not answer eth_chainId within 10 seconds");
};

/** Remembers the manifest files a dry run writes, so the run leaves the core checkout as it found it. */
export class DryRunFiles {
  private before = new Map<string, string | null>();
  /** Call before a simulation can write `path`. */
  touch(path: string): void {
    if (this.before.has(path)) return;
    this.before.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
  }
  write(path: string, text: string): void {
    this.touch(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  restore(): void {
    for (const [p, text] of this.before) {
      if (text === null) rmSync(p, { force: true });
      else writeFileSync(p, text);
    }
    this.before.clear();
  }
}

/** FiatToken balanceAndBlacklistStates is the mapping at storage slot 9: the balance is the low 255 bits. */
export const fiatTokenBalanceSlot = (holder: string): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder as Hex, 9n]));

/**
 * Tops the deployer up to `units` USDC on the LOCAL simulation chain only, through the real FiatToken balance slot, so the seed deposit of
 * the vault stage can be simulated whatever the real balance of the (address-only) preflight deployer is. The caller passes the URL of
 * the anvil it started, and an endpoint that does not answer anvil_nodeInfo is refused.
 */
export async function topUpSimulationUsdc(simRpc: string, deployer: string, units: bigint): Promise<void> {
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    const r = await fetch(simRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new PublishError("TOOL", `${method} on the local preflight chain failed: ${j.error.message}`);
    return j.result;
  };
  try { await call("anvil_nodeInfo", []); } catch { throw new PublishError("TOOL", "refusing to write token storage: the preflight chain does not answer anvil_nodeInfo, it is not the local anvil"); }
  const data = ("0x70a08231" + deployer.slice(2).toLowerCase().padStart(64, "0")) as Hex;
  const have = BigInt(String(await call("eth_call", [{ to: USDC_ADDRESS, data }, "latest"])));
  if (have >= units) return;
  await call("anvil_setStorageAt", [USDC_ADDRESS, fiatTokenBalanceSlot(deployer), pad(toHex(units), { size: 32 })]);
  const now = BigInt(String(await call("eth_call", [{ to: USDC_ADDRESS, data }, "latest"])));
  if (now < units) throw new PublishError("TOOL", `the local preflight chain holds ${now} USDC units for the deployer after the top-up, wanted ${units}`);
}
