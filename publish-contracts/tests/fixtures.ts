// Shared test helpers: the committed example sheet with overrides, a core checkout fixture and the frozen counts used in tests.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const REPO = join(import.meta.dir, "..", ".."); // the core repo root
export const EXAMPLE_SHEET = join(import.meta.dir, "fixtures", "frozen-sheet.env.example");
export const exampleText = (): string => readFileSync(EXAMPLE_SHEET, "utf8");

/** The example sheet with some names replaced, and extra lines appended. */
export function sheetText(over: Record<string, string | null> = {}, extra: string[] = []): string {
  // chain 8453 refuses a sheet that skips a stage 13 unpause (issue 1520): default it to all three unless the caller says otherwise
  if (over.CHAIN_ID === "8453" && !("GOVERN_UNPAUSE_VAULTS" in over)) over = { ...over, GOVERN_UNPAUSE_VAULTS: "PROTO,AGENT,RWA" };
  // and issue 1580: chain 8453 refuses any router weights but the launch vector (eligibility must then name all three baskets)
  if (over.CHAIN_ID === "8453") over = { ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,AGENT:0,RWA:0", ...over };
  const lines = exampleText().split("\n");
  const out: string[] = [];
  const done = new Set<string>();
  for (const l of lines) {
    const m = /^([A-Z0-9_]+)=/.exec(l);
    if (m && m[1]! in over) {
      done.add(m[1]!);
      if (over[m[1]!] !== null) out.push(`${m[1]}=${over[m[1]!]}`);
    } else out.push(l);
  }
  for (const [k, v] of Object.entries(over)) if (!done.has(k) && v !== null) out.push(`${k}=${v}`);
  return [...out, ...extra].join("\n");
}

export const SHA = "a".repeat(40);
export const SHA2 = "b".repeat(40);

/** Frozen counts used across the tests. Deployer stages only. */
export const COUNTS: Record<string, number> = { safe: 1, libs: 4, vault: 18, registry: 2, router: 3, gateway: 3, governance: 2, "ic-policy": 5, proto: 6, agent: 6, rwa: 6, timelock: 25 };

export function tmp(prefix = "pc-"): string { return mkdtempSync(join(tmpdir(), prefix)); }

export function writeCounts(dir: string, sha = SHA, counts = COUNTS): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${sha}.json`);
  writeFileSync(p, JSON.stringify({ deploySha: sha, measured: { chainId: 918453, at: "2026-10-02T00:00:00Z" }, counts }, null, 2));
  return p;
}

// ---- core asset config and a healthy pool chain --------------------------------------------------------------------------------------

import { mkdirSync as mkdirSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { encodeFunctionData as encodeFn, encodeAbiParameters as encodeParams, parseAbi as parseAbi2 } from "viem";
import type { ChainReader, Hex as Hex2 } from "../src/verify/types.ts";

/** One asset in core's config shape (symbol, token, pool, poolFee, venue). */
export const CONFIG_ASSET = { symbol: "wETH", token: "0x4200000000000000000000000000000000000006", tokenDecimals: 18, venue: "UniswapV3", pool: "0x00000000000000000000000000000000000000a1", poolFee: 500 } as const;
/** The adapter a vault manifest names (deployed per run, not in static config). */
export const MANIFEST_ADAPTER = "0x00000000000000000000000000000000000000a2" as const;

/** Writes core's three asset config files in their real shape: protocol-assets.json, rwa-assets.json, agent-token-shortlist.json. */
export function writeCoreAssetConfig(coreDir: string, o: { proto?: object[]; rwa?: object[]; shortlist?: object[] } = {}): void {
  mkdirSync2(join2(coreDir, "config"), { recursive: true });
  const head = { usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481" };
  writeFileSync2(join2(coreDir, "config", "protocol-assets.json"), JSON.stringify({ ...head, assets: o.proto ?? [CONFIG_ASSET] }));
  writeFileSync2(join2(coreDir, "config", "rwa-assets.json"), JSON.stringify({ ...head, assets: o.rwa ?? [{ ...CONFIG_ASSET, symbol: "deSPXA", token: "0x9c5C365e764829876243d0b289733B9D2b729685", pool: "0x00000000000000000000000000000000000000a3" }] }));
  writeFileSync2(join2(coreDir, "config", "agent-token-shortlist.json"), JSON.stringify({ ...head, shortlist: o.shortlist ?? [] }));
}

const OBSERVE_ABI = parseAbi2(["function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"]);
const w32 = (n: bigint): string => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
export const NOW_TS = 1_800_000_000n;

/** A read-only chain on which every address has code and every V3 pool is healthy: fee 500, cardinality 1000, liquidity above 0, fresh, TWAP equal to spot. */
export function healthyPoolReader(): ChainReader {
  const c = {
    chainId: async () => 918453, blockNumber: async () => 1n, nonce: async () => 0, getStorageAt: async () => "0x" as Hex2, read: async () => { throw new Error("unused"); },
    getLogs: async () => [], getCode: async () => "0x6001" as Hex2, blockTimestamp: async () => NOW_TS,
    callRaw: async (_to: string, data: Hex2) => {
      if (data === "0xddca3f43") return { ok: true, data: `0x${w32(500n)}` as Hex2 };
      if (data === "0x3850c7bd") return { ok: true, data: `0x${[1n, 100n, 7n, 1000n, 1000n, 0n, 1n].map(w32).join("")}` as Hex2 };
      if (data === "0x1a686502") return { ok: true, data: `0x${w32(10n)}` as Hex2 };
      if (data.startsWith("0x252c09d7")) return { ok: true, data: `0x${[NOW_TS - 60n, 0n, 0n, 1n].map(w32).join("")}` as Hex2 };
      if (data === encodeFn({ abi: OBSERVE_ABI, functionName: "observe", args: [[1800, 0]] })) {
        return { ok: true, data: encodeParams([{ type: "int56[]" }, { type: "uint160[]" }], [[0n, 180_000n], [0n, 0n]]) };
      }
      throw new Error("unexpected call " + data);
    },
  };
  return c as unknown as ChainReader;
}
