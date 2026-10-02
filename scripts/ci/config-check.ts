#!/usr/bin/env bun
// Canonical: the one-deployment-scheme plan, core S2 (issue 1484).
//
// Read-only check of the launch config against live Base. Never sends a transaction.
//
// Static rules (always run, no network):
//   - every 0x string in config/ is exactly 40 hex digits (catches the 39-digit addresses)
//   - deSPXA is listed with Uniswap V3 fee 500 and nothing else in rwa-assets.json
//   - wSOL, BNKR, JUNO and RM are absent (no usable pool at launch)
//   - no Chronicle, V4, Aerodrome, mainnet or devnet key anywhere in config/
//   - agent-token-shortlist.json launch list is empty and records swapRouter02 (the script parser needs it)
// Live rules (per asset, pinned to one block): token, pool, factory and router have code,
//   pool fee() equals config, factory.getPool equals config, observationCardinality >= 2,
//   liquidity() > 0, USD TVL (USDC reserve plus other side at slot0 price) >= the file's
//   minTvlUsd floor.
//
// Usage: bun scripts/ci/config-check.ts [--config-dir DIR] [--rpc URL] [--out-dir DIR] [--offline]
// Output: <out-dir>/config-check-block-<N>.json (default out dir: config-check-output).
// Exit 0 when every rule passes, 1 otherwise.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const BASE_CHAIN_ID = 8453;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const DEFAULT_RPC = "https://mainnet.base.org";
export const FORBIDDEN_SYMBOLS = ["wsol", "bnkr", "juno", "rm"];
const FORBIDDEN_KEY = /chronicle|v4|aerodrome|slipstream|^mainnet$|^devnet$|^wsol|^bnkr|^juno/i;
const META_KEYS = new Set(["description", "$schema"]);

export interface Asset {
  symbol: string;
  token: string;
  tokenDecimals: number;
  venue: string;
  pool: string;
  poolFee: number;
}
export interface AssetFile {
  usdc: string;
  uniswapV3Factory: string;
  swapRouter02: string;
  minTvlUsd: number;
  assets: Asset[];
}
export interface Configs {
  protocol: AssetFile;
  rwa: AssetFile;
  agent: { shortlist: unknown[]; swapRouter02?: string };
  dexPools: Record<string, unknown>;
  /** Raw parsed JSON of every config/*.json, keyed by file name. */
  raw: Record<string, unknown>;
}
export interface Finding {
  scope: string;
  rule: string;
  ok: boolean;
  detail: string;
}

export function loadConfigs(dir: string): Configs {
  const raw: Record<string, unknown> = {};
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".json")) raw[name] = JSON.parse(readFileSync(join(dir, name), "utf8"));
  }
  const need = (n: string) => {
    if (!(n in raw)) throw new Error(`missing config file ${n}`);
    return raw[n];
  };
  return {
    protocol: need("protocol-assets.json") as AssetFile,
    rwa: need("rwa-assets.json") as AssetFile,
    agent: need("agent-token-shortlist.json") as { shortlist: unknown[]; swapRouter02?: string },
    dexPools: need("dex-pools.json") as Record<string, unknown>,
    raw,
  };
}

function walk(v: unknown, path: string, visit: (path: string, key: string | null, val: unknown) => void, key: string | null = null): void {
  visit(path, key, v);
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, visit, null));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${path}.${k}`, visit, k);
  }
}

/** Offline rules. Pure: reads nothing but the parsed configs. */
export function staticFindings(c: Configs): Finding[] {
  const out: Finding[] = [];
  const add = (scope: string, rule: string, ok: boolean, detail: string) => out.push({ scope, rule, ok, detail });

  for (const [file, json] of Object.entries(c.raw)) {
    const badAddr: string[] = [];
    const badKey: string[] = [];
    const badSym: string[] = [];
    walk(json, file, (path, key, val) => {
      if (key && !META_KEYS.has(key) && !key.startsWith("$") && FORBIDDEN_KEY.test(key)) badKey.push(path);
      const underMeta = path.split(".").some((p) => META_KEYS.has(p) || p.startsWith("$"));
      if (typeof val === "string" && !underMeta) {
        if (/^0x[0-9a-fA-F]*$/.test(val) && val.length > 2 && val.length !== 42) badAddr.push(`${path}=${val} (${val.length - 2} digits)`);
        const lower = val.toLowerCase();
        if (FORBIDDEN_SYMBOLS.includes(lower) || /wsol/.test(lower) || /chronicle|aerodrome|slipstream/.test(lower)) badSym.push(`${path}=${val}`);
      }
    });
    add(file, "address-format", badAddr.length === 0, badAddr.join("; ") || "all 0x values are 40 hex digits");
    add(file, "forbidden-key", badKey.length === 0, badKey.join("; ") || "no Chronicle, V4, Aerodrome, mainnet or devnet key");
    add(file, "forbidden-symbol", badSym.length === 0, badSym.join("; ") || "no wSOL, BNKR, JUNO, RM or Chronicle/Aerodrome value");
  }

  const rwaSyms = (c.rwa.assets ?? []).map((a) => a.symbol);
  add("rwa-assets.json", "despxa-only", rwaSyms.length === 1 && rwaSyms[0] === "deSPXA", `symbols=${rwaSyms.join(",")}`);
  const d = (c.rwa.assets ?? []).find((a) => a.symbol === "deSPXA");
  add("rwa-assets.json", "despxa-fee-500", d?.poolFee === 500, `poolFee=${d?.poolFee}`);
  add("rwa-assets.json", "despxa-venue", d?.venue === "UniswapV3", `venue=${d?.venue}`);
  const protoSyms = (c.protocol.assets ?? []).map((a) => a.symbol).sort();
  add("protocol-assets.json", "weth-cbbtc-only", JSON.stringify(protoSyms) === JSON.stringify(["cbBTC", "wETH"]), `symbols=${protoSyms.join(",")}`);
  add("agent-token-shortlist.json", "launch-list-empty", Array.isArray(c.agent.shortlist) && c.agent.shortlist.length === 0, `entries=${c.agent.shortlist?.length}`);
  // The rmAGENT script reads swapRouter02 from this file even while the list is empty.
  add("agent-token-shortlist.json", "swap-router-recorded",
    c.agent.swapRouter02?.toLowerCase() === "0x2626664c2603336e57b271c5c0b26f421741e481", `router=${c.agent.swapRouter02}`);
  for (const [name, f] of [["protocol-assets.json", c.protocol], ["rwa-assets.json", c.rwa]] as const) {
    add(name, "venues-recorded",
      f.swapRouter02?.toLowerCase() === "0x2626664c2603336e57b271c5c0b26f421741e481" &&
        f.uniswapV3Factory?.toLowerCase() === "0x33128a8fc17869897dce68ed026d694621f6fdfd",
      `router=${f.swapRouter02} factory=${f.uniswapV3Factory}`);
    add(name, "tvl-floor-stated", typeof f.minTvlUsd === "number" && f.minTvlUsd > 0, `minTvlUsd=${f.minTvlUsd}`);
  }
  return out;
}

// ---- live reads -----------------------------------------------------------------------

export type Rpc = (method: string, params: unknown[]) => Promise<string>;

export function httpRpc(url: string): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
    const j = (await res.json()) as { result?: string; error?: { message: string } };
    if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
    return j.result as string;
  };
}

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (data: string, i: number) => data.replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const addrOf = (w: string) => "0x" + w.slice(24);

export interface PoolFacts {
  fee: number;
  token0: string;
  token1: string;
  sqrtPriceX96: bigint;
  cardinality: number;
  liquidity: bigint;
  usdcReserve: bigint;
  otherReserve: bigint;
  tvlUsd: number;
  factoryPool: string;
}

export async function readPool(rpc: Rpc, tag: string, a: Asset, f: AssetFile): Promise<PoolFacts> {
  const call = (to: string, data: string) => rpc("eth_call", [{ to, data }, tag]);
  const [feeW, t0, t1, slot0, liqW] = await Promise.all([
    call(a.pool, "0xddca3f43"), call(a.pool, "0x0dfe1681"), call(a.pool, "0xd21220a7"),
    call(a.pool, "0x3850c7bd"), call(a.pool, "0x1a686502"),
  ]);
  const token0 = addrOf(word(t0, 0));
  const token1 = addrOf(word(t1, 0));
  const usdc = f.usdc.toLowerCase();
  const usdcIs0 = token0 === usdc;
  const otherToken = usdcIs0 ? token1 : token0;
  const [balU, balO, gp] = await Promise.all([
    call(f.usdc, "0x70a08231" + pad(a.pool)),
    call(otherToken, "0x70a08231" + pad(a.pool)),
    call(f.uniswapV3Factory, "0x1698ee82" + pad(a.token) + pad(f.usdc) + pad("0x" + BigInt(a.poolFee).toString(16))),
  ]);
  const sqrtP = BigInt("0x" + word(slot0, 0));
  const usdcReserve = BigInt("0x" + word(balU, 0));
  const otherReserve = BigInt("0x" + word(balO, 0));
  const Q192 = 1n << 192n;
  // Value of the non-USDC side in raw USDC units, from the pool's own slot0 price.
  const otherInUsdc = usdcIs0 ? (otherReserve * Q192) / (sqrtP * sqrtP || 1n) : (otherReserve * sqrtP * sqrtP) / Q192;
  const tvlUsd = Number(usdcReserve + otherInUsdc) / 1e6;
  return {
    fee: Number(BigInt("0x" + word(feeW, 0))),
    token0, token1, sqrtPriceX96: sqrtP,
    cardinality: Number(BigInt("0x" + word(slot0, 4))),
    liquidity: BigInt("0x" + word(liqW, 0)),
    usdcReserve, otherReserve, tvlUsd,
    factoryPool: addrOf(word(gp, 0)),
  };
}

export async function liveFindings(rpc: Rpc, tag: string, c: Configs): Promise<{ findings: Finding[]; facts: Record<string, unknown> }> {
  const findings: Finding[] = [];
  const facts: Record<string, unknown> = {};
  const add = (scope: string, rule: string, ok: boolean, detail: string) => findings.push({ scope, rule, ok, detail });
  const hasCode = async (addr: string) => {
    const code = await rpc("eth_getCode", [addr, tag]);
    return code !== "0x" && code.length > 2;
  };
  for (const [name, f] of [["protocol-assets.json", c.protocol], ["rwa-assets.json", c.rwa]] as const) {
    add(name, "code:usdc", await hasCode(f.usdc), f.usdc);
    add(name, "code:factory", await hasCode(f.uniswapV3Factory), f.uniswapV3Factory);
    add(name, "code:swapRouter02", await hasCode(f.swapRouter02), f.swapRouter02);
    for (const a of f.assets) {
      const s = `${name}:${a.symbol}`;
      add(s, "code:token", await hasCode(a.token), a.token);
      const poolCode = await hasCode(a.pool);
      add(s, "code:pool", poolCode, a.pool);
      if (!poolCode) continue;
      try {
        const p = await readPool(rpc, tag, a, f);
        facts[s] = {
          pool: a.pool, fee: p.fee, token0: p.token0, token1: p.token1,
          observationCardinality: p.cardinality, liquidity: p.liquidity.toString(),
          usdcReserve: p.usdcReserve.toString(), otherReserve: p.otherReserve.toString(), tvlUsd: p.tvlUsd,
        };
        add(s, "pool-fee-equals-config", p.fee === a.poolFee, `live=${p.fee} config=${a.poolFee}`);
        add(s, "pool-is-token-usdc", [p.token0, p.token1].sort().join() === [a.token.toLowerCase(), f.usdc.toLowerCase()].sort().join(), `${p.token0},${p.token1}`);
        add(s, "factory-getPool-equals-config", p.factoryPool.toLowerCase() === a.pool.toLowerCase(), `factory=${p.factoryPool} config=${a.pool}`);
        add(s, "observation-cardinality>=2", p.cardinality >= 2, `cardinality=${p.cardinality}`);
        add(s, "liquidity>0", p.liquidity > 0n, `liquidity=${p.liquidity}`);
        add(s, `tvl-usd>=${f.minTvlUsd}`, p.tvlUsd >= f.minTvlUsd, `tvlUsd=${p.tvlUsd.toFixed(0)}`);
      } catch (e) {
        add(s, "pool-read", false, String(e));
      }
    }
  }
  return { findings, facts };
}

// ---- main -----------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const repo = resolve(import.meta.dir, "..", "..");
  const dir = resolve(arg("--config-dir") ?? join(repo, "config"));
  const outDir = resolve(arg("--out-dir") ?? join(repo, "config-check-output"));
  const offline = process.argv.includes("--offline");
  const rpcUrl = arg("--rpc") ?? process.env.BASE_RPC_URL ?? DEFAULT_RPC;

  const cfg = loadConfigs(dir);
  let findings = staticFindings(cfg);
  let block: number | null = null;
  let facts: Record<string, unknown> = {};

  if (!offline) {
    const rpc = httpRpc(rpcUrl);
    const chain = Number(BigInt(await rpc("eth_chainId", [])));
    findings.push({ scope: "rpc", rule: "chain-id-8453", ok: chain === BASE_CHAIN_ID, detail: `chainId=${chain}` });
    block = Number(BigInt(await rpc("eth_blockNumber", [])));
    const live = await liveFindings(rpc, "0x" + block.toString(16), cfg);
    findings = findings.concat(live.findings);
    facts = live.facts;
  }

  const failed = findings.filter((f) => !f.ok);
  const report = {
    checkedAt: new Date().toISOString(),
    configDir: dir,
    rpc: offline ? null : rpcUrl,
    blockNumber: block,
    ok: failed.length === 0,
    findings,
    facts,
  };
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `config-check-block-${block ?? "offline"}.json`);
  writeFileSync(file, JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

  for (const f of findings) console.log(`${f.ok ? "PASS" : "FAIL"}  ${f.scope}  ${f.rule}  ${f.detail}`);
  console.log(`config-check: ${failed.length === 0 ? "ok" : `${failed.length} failure(s)`}, block ${block ?? "none"}, output ${file}`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  main().then((c) => process.exit(c), (e) => { console.error(`config-check: ${e}`); process.exit(1); });
}
