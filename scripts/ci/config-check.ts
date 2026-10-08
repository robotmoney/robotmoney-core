#!/usr/bin/env bun
// Canonical: core issue 1499, core S2 (issue 1484).
//
// Read-only check of the launch config against live Base. Never sends a transaction.
//
// Static rules (always run, no network):
//   - every 0x string in config/ is exactly 40 hex digits (catches the 39-digit addresses)
//   - deSPXA is listed with Uniswap V3 fee 500 and nothing else in rwa-assets.json
//   - wSOL, BNKR and JUNO are absent; RM appears only in agent-token-shortlist.json
//   - no Chronicle, V4, Aerodrome, mainnet or devnet key anywhere in config/
//   - agent-token-shortlist.json launch list is exactly RM (live ROBOTMONEY token, code-hash pinned,
//     owner-funded V3 pool, fee 10000) and records swapRouter02 (the script parser needs it)
// Live rules (per asset, pinned to one block): token, pool, factory and router have code,
//   pool fee() equals config, factory.getPool equals config, observationCardinality >= 901 (1800 s default TWAP window / 2 s Base blocks + 1, core 1665),
//   liquidity() > 0, USD TVL (USDC reserve plus other side at slot0 price) >= the file's
//   minTvlUsd floor.
//
// USDC code-hash rule (live, every chain): USDC is the one canonical constant on every chain, so
// the proxy at USDC and the implementation behind its FiatTokenProxy slot must have the code hashes
// pinned in config/usdc-hashes.json. A mock token fails this rule. An unpinned (null) hash is
// refused too. Pin with --print-usdc-hashes against Base mainnet, then review the diff.
//
// CLI (devops calls this):
//   bun scripts/ci/config-check.ts --rpc URL [--config-dir DIR] [--chain ID] [--out-dir DIR]   (env CONFIG_CHECK_RPC_URL replaces --rpc, so a keyed URL stays out of argv)
//   bun scripts/ci/config-check.ts --offline [--config-dir DIR]        (static rules only)
//   bun scripts/ci/config-check.ts --rpc URL --print-usdc-hashes       (prints the two hashes, exit 0)
// --rpc        JSON-RPC URL of the target chain (required unless --offline)
// --config-dir directory holding the config JSON files (default: <repo>/config)
// --chain      expected chain id of the RPC (default 8453; 918453 for the Twin chain)
// Output: <out-dir>/config-check-block-<N>.json (default out dir: config-check-output).
// Exit codes: 0 every rule passes, 1 a check failed (or the RPC failed), 2 usage error.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const BASE_CHAIN_ID = 8453;
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/**
 * Implementation slot of Circle's FiatTokenProxy: keccak256("org.zeppelinos.proxy.implementation").
 * It is NOT the EIP-1967 slot: on Base the EIP-1967 slot reads zero for USDC. Verified on Base
 * mainnet: this slot holds 0x2Ce6311ddAE708829bc0784C967b7d77D19FD779, equal to implementation().
 */
export const USDC_IMPL_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
export const FORBIDDEN_SYMBOLS = ["wsol", "bnkr", "juno"];
const AGENT_FILE = "agent-token-shortlist.json";
export const RM = {
  token: "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3",
  pool: "0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882",
  fee: 10000,
};
const FORBIDDEN_KEY = /chronicle|v4|aerodrome|slipstream|^mainnet$|^devnet$|^wsol|^bnkr|^juno/i;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const META_KEYS = new Set(["description", "$schema"]);

export interface Asset {
  symbol: string;
  token: string;
  tokenDecimals: number;
  venue: string;
  pool: string;
  poolFee: number;
}
export interface AgentEntry extends Asset {
  tokenCodeHash: string;
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
  agent: { usdc: string; uniswapV3Factory: string; swapRouter02: string; shortlist: AgentEntry[] };
  dexPools: Record<string, unknown>;
  /** Pinned USDC code hashes (config/usdc-hashes.json). null means not pinned yet: refused. */
  usdcHashes: UsdcHashes;
  /** Raw parsed JSON of every config/*.json, keyed by file name. */
  raw: Record<string, unknown>;
}
export interface UsdcHashes {
  proxyCodeHash: string | null;
  implementationCodeHash: string | null;
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
    agent: need(AGENT_FILE) as Configs["agent"],
    dexPools: need("dex-pools.json") as Record<string, unknown>,
    usdcHashes: need("usdc-hashes.json") as UsdcHashes,
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
        const isHashKey = key !== null && /CodeHash$/.test(key);
        if (!isHashKey && /^0x[0-9a-fA-F]*$/.test(val) && val.length > 2 && val.length !== 42) badAddr.push(`${path}=${val} (${val.length - 2} digits)`);
        const lower = val.toLowerCase();
        if (FORBIDDEN_SYMBOLS.includes(lower) || (lower === "rm" && file !== AGENT_FILE) || /wsol/.test(lower) || /chronicle|aerodrome|slipstream/.test(lower)) badSym.push(`${path}=${val}`);
      }
    });
    add(file, "address-format", badAddr.length === 0, badAddr.join("; ") || "all 0x values are 40 hex digits");
    add(file, "forbidden-key", badKey.length === 0, badKey.join("; ") || "no Chronicle, V4, Aerodrome, mainnet or devnet key");
    add(file, "forbidden-symbol", badSym.length === 0, badSym.join("; ") || "no wSOL, BNKR, JUNO, RM (outside the agent shortlist) or Chronicle/Aerodrome value");
  }

  for (const k of ["proxyCodeHash", "implementationCodeHash"] as const) {
    const v = c.usdcHashes?.[k];
    add("usdc-hashes.json", `format:${k}`, v === null || (typeof v === "string" && HASH_RE.test(v)), `${k}=${v}`);
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
      rm.pool?.toLowerCase() === RM.pool.toLowerCase() && rm.poolFee === RM.fee && rm.venue === "UniswapV3" &&
      HASH_RE.test(rm.tokenCodeHash ?? ""),
    `entries=${sl.length} ${rm ? `${rm.symbol} fee=${rm.poolFee} venue=${rm.venue}` : ""}`);
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

export interface HttpRpcOptions {
  /** Injected for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests. Returns a number in [0, 1). Defaults to Math.random. */
  random?: () => number;
  /** Maximum attempts per call, first try included. Default 6. */
  maxTries?: number;
  /** First backoff delay in ms. It doubles on each retry. Default 1000. */
  baseDelayMs?: number;
  /** Minimum gap between the starts of two requests in ms. Default 250. */
  minSpacingMs?: number;
}

/** True for failures worth retrying: rate limit (429) and transient server or network errors. */
function isRetryable(status: number | null): boolean {
  return status === null || status === 429 || status >= 500;
}

/** Spacing between requests in ms. Env CONFIG_CHECK_RPC_SPACING_MS overrides (tests use 0 for a local fake). */
function spacingFromEnv(): number {
  const v = Number(process.env.CONFIG_CHECK_RPC_SPACING_MS);
  return process.env.CONFIG_CHECK_RPC_SPACING_MS !== undefined && Number.isFinite(v) && v >= 0 ? v : 300;
}

/**
 * JSON-RPC client over HTTP. Requests are serialized and spaced so a public endpoint is not
 * flooded. A 429, a 5xx or a network error is retried with exponential backoff and full jitter,
 * up to `maxTries` attempts (equal jitter, honors Retry-After). The URL is never put in an error message (it may carry a key).
 */
export function httpRpc(url: string, opts: HttpRpcOptions = {}): Rpc {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const maxTries = opts.maxTries ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const minSpacingMs = opts.minSpacingMs ?? spacingFromEnv();
  let id = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const attempt = async (method: string, params: unknown[]): Promise<string> => {
    let lastErr = "";
    let retryAfterMs = 0;
    for (let t = 0; t < maxTries; t++) {
      if (t > 0) {
        const cap = baseDelayMs * 2 ** (t - 1);
        const jittered = Math.floor(cap / 2 + (random() * cap) / 2);
        await sleep(Math.max(jittered, retryAfterMs));
      }
      retryAfterMs = 0;
      let status: number | null = null;
      try {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        status = res.status;
        if (!res.ok) {
          lastErr = `rpc ${method} http ${res.status}`;
          const ra = Number(res.headers.get("retry-after"));
          retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : 0;
          if (!isRetryable(status)) throw new Error(lastErr);
          continue;
        }
        const j = (await res.json()) as { result?: string; error?: { message: string } };
        if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
        return j.result as string;
      } catch (e) {
        if (status !== null) throw e; // an HTTP-level or JSON-RPC error that is final
        lastErr = `rpc ${method} network error`;
      }
    }
    throw new Error(`${lastErr} (gave up after ${maxTries} tries)`);
  };

  return (method, params) => {
    const run = queue.then(async () => {
      try {
        return await attempt(method, params);
      } finally {
        if (minSpacingMs > 0) await sleep(minSpacingMs);
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

/** Host only: a keyed RPC URL carries its secret in the path or query, so never record it. */
export function redactUrl(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "<invalid-url>";
  }
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

export async function readPool(rpc: Rpc, tag: string, a: Asset, f: Pick<AssetFile, "usdc" | "uniswapV3Factory">): Promise<PoolFacts> {
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
  try {
    findings.push(...usdcHashFindings(c.usdcHashes, await readUsdcHashes(rpc, tag)));
  } catch (e) {
    add("usdc-hashes.json", "usdc-hash-read", false, String(e));
  }
  for (const [name, f] of [["protocol-assets.json", c.protocol], ["rwa-assets.json", c.rwa], [AGENT_FILE, c.agent]] as const) {
    add(name, "code:usdc", await hasCode(f.usdc), f.usdc);
    add(name, "code:factory", await hasCode(f.uniswapV3Factory), f.uniswapV3Factory);
    add(name, "code:swapRouter02", await hasCode(f.swapRouter02), f.swapRouter02);
    const isAgent = name === AGENT_FILE;
    const assets: Asset[] = isAgent ? c.agent.shortlist : (f as AssetFile).assets;
    for (const a of assets) {
      const s = `${name}:${a.symbol}`;
      add(s, "code:token", await hasCode(a.token), a.token);
      if (isAgent) {
        const want = (a as AgentEntry).tokenCodeHash.toLowerCase();
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
        // BasketVault.addAsset needs cardinality >= 901 and liquidity >= 1e6, so an unfunded RM pool
        // fails here before the deploy reverts. The TVL floor is a rwa/protocol file field only.
        // The agent pool is funded by the owner on chain before the mainnet run (core 1554, devops 72). Say so when it is not.
        const unfunded = isAgent ? ` (RM pool ${a.pool} is not funded yet: the owner must add in-range liquidity and raise observation cardinality before the mainnet run; BasketVault.addAsset needs cardinality>=901 and liquidity>=1e6)` : "";
        add(s, "observation-cardinality>=901", p.cardinality >= 901, `cardinality=${p.cardinality}${p.cardinality >= 901 ? "" : unfunded}`);
        add(s, "liquidity>0", p.liquidity > 0n, `liquidity=${p.liquidity}${p.liquidity > 0n ? "" : unfunded}`);
        // The addAsset liquidity floor, unrelaxed: a pool with 1..999999 would pass liquidity>0 and still revert the deploy.
        if (isAgent) add(s, "liquidity>=1000000", p.liquidity >= 1_000_000n, `liquidity=${p.liquidity}${p.liquidity >= 1_000_000n ? "" : unfunded}`);
        if (!isAgent) {
          const floor = (f as AssetFile).minTvlUsd;
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

// ---- USDC code-hash check --------------------------------------------------------------

/** Reads the live proxy and implementation code hashes of USDC on the target chain. */
export async function readUsdcHashes(rpc: Rpc, tag: string): Promise<{ proxy: string; implementation: string; implementationAddress: string }> {
  const proxyCode = await rpc("eth_getCode", [USDC, tag]);
  const slot = await rpc("eth_getStorageAt", [USDC, USDC_IMPL_SLOT, tag]);
  const implementationAddress = addrOf(slot.replace(/^0x/, "").padStart(64, "0"));
  const implCode = await rpc("eth_getCode", [implementationAddress, tag]);
  return {
    proxy: proxyCode.length > 2 ? keccakHex(proxyCode) : "no-code",
    implementation: implCode.length > 2 ? keccakHex(implCode) : "no-code",
    implementationAddress,
  };
}

/** Pure judgement: pinned hashes against live ones. A null pin is refused. */
export function usdcHashFindings(
  pinned: UsdcHashes,
  live: { proxy: string; implementation: string; implementationAddress: string },
): Finding[] {
  const out: Finding[] = [];
  const one = (rule: string, pin: string | null, got: string) => {
    if (pin === null || !HASH_RE.test(pin)) {
      out.push({ scope: "usdc-hashes.json", rule, ok: false, detail: `not pinned (value=${pin}): refused. Pin with --print-usdc-hashes against Base mainnet` });
    } else {
      out.push({ scope: "usdc-hashes.json", rule, ok: pin === got.toLowerCase(), detail: `pinned=${pin} live=${got}` });
    }
  };
  one("usdc-proxy-code-hash", pinned.proxyCodeHash, live.proxy);
  one("usdc-implementation-code-hash", pinned.implementationCodeHash, live.implementation);
  return out;
}

// ---- cli --------------------------------------------------------------------------------

export class UsageError extends Error {}
export interface CliArgs {
  rpc?: string;
  configDir?: string;
  chain: number;
  outDir?: string;
  offline: boolean;
  printUsdcHashes: boolean;
}

/** Strict parser. Any unknown flag, missing value or missing --rpc (unless --offline) is a usage error. */
export function parseCli(argv: string[], env: Record<string, string | undefined> = process.env): CliArgs {
  const a: CliArgs = { chain: BASE_CHAIN_ID, offline: false, printUsdcHashes: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${f} needs a value`);
      return v;
    };
    if (f === "--rpc") a.rpc = val();
    else if (f === "--config-dir") a.configDir = val();
    else if (f === "--out-dir") a.outDir = val();
    else if (f === "--chain") {
      const v = val();
      if (!/^[1-9][0-9]*$/.test(v)) throw new UsageError(`--chain must be a positive integer, got ${v}`);
      a.chain = Number(v);
    } else if (f === "--offline") a.offline = true;
    else if (f === "--print-usdc-hashes") a.printUsdcHashes = true;
    else throw new UsageError(`unknown argument ${f}`);
  }
  // An RPC URL may carry a key, so a caller that must keep it out of argv (devops publish contracts) hands it over in CONFIG_CHECK_RPC_URL.
  if (!a.rpc && env.CONFIG_CHECK_RPC_URL) a.rpc = env.CONFIG_CHECK_RPC_URL;
  if (!a.offline && !a.rpc) throw new UsageError("--rpc is required (or set CONFIG_CHECK_RPC_URL, or pass --offline)");
  if (a.offline && a.printUsdcHashes) throw new UsageError("--print-usdc-hashes needs --rpc, not --offline");
  return a;
}

export const USAGE =
  "usage: config-check.ts --rpc URL [--config-dir DIR] [--chain ID] [--out-dir DIR] | --offline [--config-dir DIR] | --rpc URL --print-usdc-hashes";

// ---- main -----------------------------------------------------------------------------

async function main(): Promise<number> {
  let cli: CliArgs;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`config-check: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const repo = resolve(import.meta.dir, "..", "..");
  const dir = resolve(cli.configDir ?? join(repo, "config"));
  const outDir = resolve(cli.outDir ?? join(repo, "config-check-output"));
  const offline = cli.offline;
  const rpcUrl = cli.rpc ?? "";

  if (cli.printUsdcHashes) {
    const rpc = httpRpc(rpcUrl);
    const h = await readUsdcHashes(rpc, "latest");
    console.log(JSON.stringify({ proxyCodeHash: h.proxy, implementationCodeHash: h.implementation, implementationAddress: h.implementationAddress }, null, 2));
    return 0;
  }

  const cfg = loadConfigs(dir);
  let findings = staticFindings(cfg);
  let block: number | null = null;
  let facts: Record<string, unknown> = {};

  if (!offline) {
    const rpc = httpRpc(rpcUrl);
    const chain = Number(BigInt(await rpc("eth_chainId", [])));
    findings.push({ scope: "rpc", rule: "chain-id", ok: chain === cli.chain, detail: `live=${chain} expected=${cli.chain}` });
    block = Number(BigInt(await rpc("eth_blockNumber", [])));
    const live = await liveFindings(rpc, "0x" + block.toString(16), cfg);
    findings = findings.concat(live.findings);
    facts = live.facts;
  }

  const failed = findings.filter((f) => !f.ok);
  const report = {
    checkedAt: new Date().toISOString(),
    configDir: dir,
    rpc: offline ? null : redactUrl(rpcUrl),
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
