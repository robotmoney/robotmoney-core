#!/usr/bin/env bun
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S2 (issue 1484).
//
// Read-only check of the launch config against live Base. Never sends a transaction.
//
// Static rules (always run, no network):
//   - every 0x string in config/ is exactly 40 hex digits (catches the 39-digit addresses)
//   - deSPXA is listed with Uniswap V3 fee 500 and nothing else in rwa-assets.json
//   - wSOL, BNKR, JUNO are absent everywhere; RM appears only in agent-token-shortlist.json
//   - no Chronicle, V4, Aerodrome, mainnet or devnet key anywhere in config/
//   - agent-token-shortlist.json launch list is exactly RM (live ROBOTMONEY token, code-hash pinned,
//     owner-funded V3 RM/USDC pool fee 10000)
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
export const FORBIDDEN_SYMBOLS = ["wsol", "bnkr", "juno"];
export const RM = {
  token: "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3",
  pool: "0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882",
  fee: 10000,
};
const AGENT_FILE = "agent-token-shortlist.json";
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
export interface AgentEntry {
  symbol: string;
  token: string;
  tokenDecimals: number;
  tokenCodeHash: string;
  pool: string;
  swapFee: number;
  venue: string;
  adapter: string;
}
export interface Configs {
  protocol: AssetFile;
  rwa: AssetFile;
  agent: { usdc: string; uniswapV3Factory: string; swapRouter02: string; shortlist: AgentEntry[] };
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
    agent: need("agent-token-shortlist.json") as Configs["agent"],
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
        if (/^0x[0-9a-fA-F]*$/.test(val) && val.length > 2 && val.length !== 42 && !(key === "tokenCodeHash" && val.length === 66)) badAddr.push(`${path}=${val} (${val.length - 2} digits)`);
        const lower = val.toLowerCase();
        if (FORBIDDEN_SYMBOLS.includes(lower) || (lower === "rm" && file !== AGENT_FILE) || /wsol/.test(lower) || /chronicle|aerodrome|slipstream/.test(lower)) badSym.push(`${path}=${val}`);
      }
    });
    add(file, "address-format", badAddr.length === 0, badAddr.join("; ") || "all 0x values are 40 hex digits");
    add(file, "forbidden-key", badKey.length === 0, badKey.join("; ") || "no Chronicle, V4, Aerodrome, mainnet or devnet key");
    add(file, "forbidden-symbol", badSym.length === 0, badSym.join("; ") || "no wSOL, BNKR, JUNO, RM (outside the agent shortlist) or Chronicle/Aerodrome value");
  }

  const rwaSyms = (c.rwa.assets ?? []).map((a) => a.symbol);
  add("rwa-assets.json", "despxa-only", rwaSyms.length === 1 && rwaSyms[0] === "deSPXA", `symbols=${rwaSyms.join(",")}`);
  const d = (c.rwa.assets ?? []).find((a) => a.symbol === "deSPXA");
  add("rwa-assets.json", "despxa-fee-500", d?.poolFee === 500, `poolFee=${d?.poolFee}`);
  add("rwa-assets.json", "despxa-venue", d?.venue === "UniswapV3", `venue=${d?.venue}`);
  const protoSyms = (c.protocol.assets ?? []).map((a) => a.symbol).sort();
  add("protocol-assets.json", "weth-cbbtc-only", JSON.stringify(protoSyms) === JSON.stringify(["cbBTC", "wETH"]), `symbols=${protoSyms.join(",")}`);
  const sl = c.agent.shortlist ?? [];
  const rm = sl[0];
  add(AGENT_FILE, "launch-list-is-rm-only",
    sl.length === 1 && rm.symbol === "RM" && rm.token?.toLowerCase() === RM.token.toLowerCase() &&
      rm.pool?.toLowerCase() === RM.pool.toLowerCase() && rm.swapFee === RM.fee && rm.venue === "V3" &&
      /^0x[0-9a-f]{64}$/.test(rm.tokenCodeHash ?? ""),
    `entries=${sl.length} ${rm ? `${rm.symbol} fee=${rm.swapFee} venue=${rm.venue}` : ""}`);
  for (const [name, f] of [["protocol-assets.json", c.protocol], ["rwa-assets.json", c.rwa], [AGENT_FILE, c.agent]] as const) {
    add(name, "venues-recorded",
      f.swapRouter02?.toLowerCase() === "0x2626664c2603336e57b271c5c0b26f421741e481" &&
        f.uniswapV3Factory?.toLowerCase() === "0x33128a8fc17869897dce68ed026d694621f6fdfd",
      `router=${f.swapRouter02} factory=${f.uniswapV3Factory}`);
    if (name !== AGENT_FILE) {
      const m = (f as AssetFile).minTvlUsd;
      add(name, "tvl-floor-stated", typeof m === "number" && m > 0, `minTvlUsd=${m}`);
    }
  }
  return out;
}

// ---- live reads -----------------------------------------------------------------------

export type Rpc = (method: string, params: unknown[]) => Promise<string>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JSON-RPC over HTTP. Calls are spaced and a 429 is retried with backoff (public RPCs rate-limit). */
export function httpRpc(url: string, spacingMs = 300): Rpc {
  let id = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const once = async (method: string, params: unknown[]): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 8) {
        const ra = Number(res.headers.get("retry-after")) * 1000;
        await sleep(Math.max(ra || 0, 1000 * 2 ** attempt) + Math.random() * 500);
        continue;
      }
      if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
      const j = (await res.json()) as { result?: string; error?: { message: string } };
      if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
      return j.result as string;
    }
  };
  // One call at a time, spaced, so Promise.all fan-out in the readers cannot burst.
  return (method, params) => {
    const run = chain.then(() => once(method, params));
    chain = run.then(() => sleep(spacingMs), () => sleep(spacingMs));
    return run;
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

type Venues = { usdc: string; uniswapV3Factory: string };
export async function readPool(rpc: Rpc, tag: string, a: Asset, f: Venues): Promise<PoolFacts> {
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
  for (const [name, f] of [["protocol-assets.json", c.protocol], ["rwa-assets.json", c.rwa], [AGENT_FILE, c.agent]] as const) {
    add(name, "code:usdc", await hasCode(f.usdc), f.usdc);
    add(name, "code:factory", await hasCode(f.uniswapV3Factory), f.uniswapV3Factory);
    add(name, "code:swapRouter02", await hasCode(f.swapRouter02), f.swapRouter02);
    const isAgent = name === AGENT_FILE;
    const assets: Asset[] = isAgent
      ? c.agent.shortlist.map((e) => ({ symbol: e.symbol, token: e.token, tokenDecimals: e.tokenDecimals, venue: "UniswapV3", pool: e.pool, poolFee: e.swapFee }))
      : (f as AssetFile).assets;
    for (const a of assets) {
      const s = `${name}:${a.symbol}`;
      add(s, "code:token", await hasCode(a.token), a.token);
      if (isAgent) {
        const want = c.agent.shortlist.find((e) => e.symbol === a.symbol)!.tokenCodeHash.toLowerCase();
        const got = keccakHex(await rpc("eth_getCode", [a.token, tag])).toLowerCase();
        add(s, "token-code-hash-pinned", got === want, `live=${got} config=${want}`);
      }
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
        // The RM pool is owner-funded after deploy: it has no liquidity or observations yet.
        if (!isAgent) {
          const floor = (f as AssetFile).minTvlUsd;
          add(s, "observation-cardinality>=2", p.cardinality >= 2, `cardinality=${p.cardinality}`);
          add(s, "liquidity>0", p.liquidity > 0n, `liquidity=${p.liquidity}`);
          add(s, `tvl-usd>=${floor}`, p.tvlUsd >= floor, `tvlUsd=${p.tvlUsd.toFixed(0)}`);
        }
      } catch (e) {
        add(s, "pool-read", false, String(e));
      }
    }
  }
  return { findings, facts };
}



// ---- keccak256 (pure, so the hash check needs no extra tool) ------------------------------

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn,
  0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n,
  0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const M64 = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);

function keccakF(a: bigint[]): void {
  for (let r = 0; r < 24; r++) {
    const c = [0, 1, 2, 3, 4].map((x) => a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) a[x + 5 * y] ^= d;
    }
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M64 & b[((x + 2) % 5) + 5 * y]);
    a[0] ^= RC[r];
  }
}

/** Ethereum keccak256 of bytes, as 0x-hex. */
export function keccak256(data: Uint8Array): string {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const st: bigint[] = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      st[i] ^= lane;
    }
    keccakF(st);
  }
  let out = "";
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out += Number((st[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, "0");
  return "0x" + out;
}

export function keccakHex(hex: string): string {
  const h = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return keccak256(bytes);
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
