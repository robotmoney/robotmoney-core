/**
 * Sweep: return leftover ETH (and token balance) from every throwaway key to the funder. Runs on every exit path of a
 * rehearsal: success, failure, SIGINT and SIGTERM. Best effort per key: one failure never stops the others.
 */
import { join } from "node:path";
import type { Cast } from "./cast.ts";

export interface SweepOptions {
  rpc: string;
  keyDir: string;
  passwordFile: string;
  names: string[];
  addresses: Record<string, string>;
  funder: string;
  cast: Cast;
  usdc?: string;
  log?: (s: string) => void;
}
export interface SweepRow { name: string; sentWei: bigint; sentUsdc: bigint; error?: string }

const num = (s: string): bigint => BigInt(s.trim().split(/\s+/)[0]!);
const GAS_UNITS_ETH_SEND = 21_000n;

export async function sweep(o: SweepOptions): Promise<SweepRow[]> {
  const log = o.log ?? (() => {});
  const rows: SweepRow[] = [];
  let gp: bigint;
  try { gp = num(await o.cast(["gas-price", "--rpc-url", o.rpc])); } catch (e) { return o.names.map((name) => ({ name, sentWei: 0n, sentUsdc: 0n, error: `gas price: ${(e as Error).message}` })); }
  for (const name of o.names) {
    const row: SweepRow = { name, sentWei: 0n, sentUsdc: 0n };
    const addr = o.addresses[name];
    const sign = ["--keystore", join(o.keyDir, name), "--password-file", o.passwordFile, "--rpc-url", o.rpc, "--json"];
    try {
      if (!addr) throw new Error("no address");
      if (o.usdc) {
        const u = num(await o.cast(["call", o.usdc, "balanceOf(address)(uint256)", addr, "--rpc-url", o.rpc]));
        if (u > 0n) { await o.cast(["send", o.usdc, "transfer(address,uint256)", o.funder, u.toString(), ...sign]); row.sentUsdc = u; }
      }
      const bal = num(await o.cast(["balance", addr, "--rpc-url", o.rpc]));
      // 3x a plain send plus an L1 data allowance, the same shape as the funding reserve
      const reserve = gp * GAS_UNITS_ETH_SEND * 3n + 20_000_000_000_000n;
      if (bal > reserve) { const v = bal - reserve; await o.cast(["send", o.funder, "--value", v.toString(), ...sign]); row.sentWei = v; }
    } catch (e) { row.error = (e as Error).message; }
    log(`sweep ${name}: ${row.sentWei} wei, ${row.sentUsdc} usdc${row.error ? ", " + row.error : ""}`);
    rows.push(row);
  }
  return rows;
}

/**
 * Runs `body`, then `cleanup`, on every exit path. Signals trigger cleanup then exit with 128+signal.
 * Cleanup runs once. A cleanup error is logged, never thrown over the body's own error.
 */
export async function withCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>, log: (s: string) => void = () => {}): Promise<T> {
  let ran = false;
  const run = async () => { if (ran) return; ran = true; try { await cleanup(); } catch (e) { log(`cleanup failed: ${(e as Error).message}`); } };
  const handlers: [NodeJS.Signals, () => void][] = (["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]).map((s) => [s, () => { void run().then(() => process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as Record<string, number>)[s]!)); }]);
  for (const [s, h] of handlers) process.on(s, h);
  try { return await body(); } finally { for (const [s, h] of handlers) process.off(s, h); await run(); }
}
