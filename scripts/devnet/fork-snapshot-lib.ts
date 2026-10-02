/**
 * Shared helpers for the Twin chain snapshot tooling (core issue 1498).
 *
 * Canonical: docs/technical/full-stack-devnet.md "Fork-state fixture".
 * Used by scripts/devnet/snapshot-fork.ts (capture),
 * scripts/devnet/check-fork-snapshot-contents.ts (contents check) and
 * scripts/devnet/snapshot-fork-selftest.ts.
 *
 * Nothing here holds a secret. RPC URLs are never logged, only their origin.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPO = resolve(dirname(import.meta.path), "..", "..");

// ── well-known Base mainnet addresses ──────────────────────────────────────
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const WETH = "0x4200000000000000000000000000000000000006";
export const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
export const DESPXA = "0x9c5c365e764829876243d0b289733b9d2b729685";
export const DESPXA_POOL = "0xD08f1fb797BfacdeD23323178672557034c64CfA";
export const V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
export const SWAP_ROUTER02 = "0x2626664c2603336e57b271c5c0b26f421741e481";
export const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
export const AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
export const COMET_USDC = "0xb125E6687d4313864e53df431d5425969c15Eb2F";
export const MORPHO_VAULT = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca";

/** Canonical Safe v1.4.1 set (governance-isomorphism.md section 2.2). */
export const SAFE_SET = [
  "0x41675C099F32341bf84BFc5382aF534df5C7461a", // Safe singleton (L1)
  "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", // SafeL2 singleton
  "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", // SafeProxyFactory
  "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99", // CompatibilityFallbackHandler
  "0x38869bf66a61cF6bDB996A6aE40D5853FD43B526", // MultiSend
];
export const SAFE_SINGLETONS = [SAFE_SET[0], SAFE_SET[1]];

/**
 * Third-party infrastructure the Twin chain needs at genesis. Robot Money's
 * own contracts are NOT here: they are deployed on the Twin chain by the same
 * scripts that deploy mainnet (one deployment scheme).
 */
/** BNKR on Base. The same address as config/agent-token-shortlist.json mainnet.shortlist[BNKR]; the contents check asserts they agree. */
export const BNKR = "0x22aF33FE49fD1Fa80c7149773dDe5890D3C76F3b";

export const INFRA_ADDRESSES: Array<[string, string]> = [
  [USDC, "Base mainnet USDC (Circle)"],
  [WETH, "WETH9 on Base"],
  [V3_FACTORY, "Uniswap V3 factory"],
  [SWAP_ROUTER02, "Uniswap V3 SwapRouter02"],
  [QUOTER_V2, "Uniswap V3 QuoterV2"],
  [CBBTC, "cbBTC"],
  [BNKR, "BNKR (agent-token shortlist)"],
  [DESPXA, "deSPXA token (Centrifuge ShareToken)"],
  [DESPXA_POOL, "deSPXA/USDC Uniswap V3 0.01% pool"],
  ["0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca", "Morpho Gauntlet USDC Prime"],
  [AAVE_POOL, "Aave V3 Pool"],
  ["0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", "Aave V3 aUSDC"],
  [COMET_USDC, "Compound V3 cUSDCv3"],
  // Aave Pool.withdraw reads the oracle chain (issue 894).
  ["0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d", "Aave V3 PoolAddressesProvider"],
  ["0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156", "AaveOracle"],
  ["0xf52D010c7d4ecBfda92c2509900593CE34535D86", "USDC PriceCapAdapter"],
  ["0x1550207eAeB590D1557a6E6C066D3d57B5A4Dc65", "USDC/USD EACAggregatorProxy"],
  ["0x0fB39aE1d48Faf8CA5ea8DbF7e134e07386A7877", "USDC/USD underlying aggregator"],
];

/**
 * Robot Money production addresses on Base mainnet (the v1 vault, adapters and
 * admin Safe). None may carry code at Twin chain genesis: the rehearsal
 * deploys the real contracts onto an empty slate.
 */
export const ROBOT_MONEY_ADDRESSES: Array<[string, string]> = [
  ["0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd", "RobotMoneyVault (v1)"],
  ["0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9", "Morpho strategy adapter (v1)"],
  ["0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea", "Aave V3 strategy adapter (v1)"],
  ["0x8247da22a59fce074c102431048d0ce7294c2652", "Compound V3 strategy adapter (v1)"],
  ["0x88ba7364cc6ce5054981d571b33f8fb3e91475a0", "Admin and fee-recipient Safe (v1)"],
];

// ── configured pools ───────────────────────────────────────────────────────
export interface PoolEntry {
  id: string;
  pool: string;
  tokens: string[]; // tokens named in config (may be partial; the pool is the authority)
  source: string;
  /** False only when config/dex-pools.json marks the basket row pool_status "no_liquidity": a fact about the upstream pool. */
  liquidityRequired: boolean;
}

/**
 * Every Uniswap V3 pool in config/dex-pools.json: the basket_assets rows with
 * venue UniswapV3 plus the mainnet.pools price-strip rows. Aerodrome and V4
 * rows are skipped (no V3 pool interface). Deduplicated by address.
 */
export function loadConfiguredPools(repo: string = REPO): PoolEntry[] {
  const cfg = JSON.parse(readFileSync(join(repo, "config/dex-pools.json"), "utf8"));
  const byAddr = new Map<string, PoolEntry>();
  const add = (e: PoolEntry) => {
    const k = e.pool.toLowerCase();
    const prev = byAddr.get(k);
    if (prev) {
      prev.id += `+${e.id}`;
      prev.liquidityRequired = prev.liquidityRequired && e.liquidityRequired;
      return;
    }
    byAddr.set(k, e);
  };
  for (const [id, row] of Object.entries<any>(cfg.basket_assets ?? {})) {
    if (id.startsWith("$") || typeof row !== "object") continue;
    if (row.venue !== "UniswapV3" || !row.pool) continue;
    add({ id, pool: row.pool, tokens: [row.token].filter(Boolean), source: "basket_assets", liquidityRequired: row.pool_status !== "no_liquidity" });
  }
  for (const [id, row] of Object.entries<any>(cfg.mainnet?.pools ?? {})) {
    if (row.aerodromePool || !row.pool || !row.token0) continue;
    add({ id, pool: row.pool, tokens: [row.token0, row.token1].filter(Boolean), source: "mainnet.pools", liquidityRequired: true });
  }
  return [...byAddr.values()];
}

/** Robot Money addresses to refuse at genesis: the fixed list plus any recorded deployments. */
export function robotMoneyAddresses(repo: string = REPO): Array<[string, string]> {
  const out = [...ROBOT_MONEY_ADDRESSES];
  const seen = new Set(out.map(([a]) => a.toLowerCase()));
  // Keys of deployments/full-stack.json that are NOT Robot Money contracts: the anvil dev accounts
  // (EOAs the old stub deploy used as roles) and Base USDC. Everything else in the file is ours.
  const NOT_ROBOT_MONEY_CODE = new Set(["admin", "agent", "pauser", "share_receiver", "usdc"]);
  for (const f of ["deployments/full-stack.json"]) {
    try {
      const j = JSON.parse(readFileSync(join(repo, f), "utf8"));
      for (const [k, v] of Object.entries<any>(j)) {
        if (typeof v === "string" && !NOT_ROBOT_MONEY_CODE.has(k) && /^0x[0-9a-fA-F]{40}$/.test(v) && !seen.has(v.toLowerCase())) {
          seen.add(v.toLowerCase());
          out.push([v, `${f}:${k}`]);
        }
      }
    } catch {
      /* file absent: nothing recorded */
    }
  }
  return out;
}

// ── generic helpers ────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<unparseable RPC URL>";
  }
}

export interface RetryOpts {
  maxAttempts?: number;
  baseDelayMs?: number;
  log?: (msg: string) => void;
}

/**
 * JSON-RPC with back-off on HTTP 429, rate-limit JSON-RPC errors, 5xx and
 * network errors. Any other failure throws at once. Never logs the URL, only
 * its origin. Env: FORK_RPC_RETRY_MAX (attempts, default 8), FORK_RPC_RETRY_SLEEP
 * (first back-off in seconds, doubled per attempt, capped at 60s, default 2).
 */
export async function rpc(url: string, method: string, params: unknown[] = [], opts: RetryOpts = {}): Promise<any> {
  const max = opts.maxAttempts ?? Number(process.env.FORK_RPC_RETRY_MAX ?? 8);
  let delay = opts.baseDelayMs ?? Number(process.env.FORK_RPC_RETRY_SLEEP ?? 2) * 1000;
  const log = opts.log ?? ((m: string) => console.error(m));
  for (let attempt = 1; ; attempt++) {
    let err = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) {
        err = `HTTP ${res.status}`;
      } else if (!res.ok) {
        throw new Error(`${method}: HTTP ${res.status} from ${origin(url)}`);
      } else {
        const j: any = await res.json();
        if (!j.error) return j.result;
        const m = String(j.error.message ?? "");
        if (!/rate.?limit|too many requests|429/i.test(m)) {
          throw new Error(`${method}: ${m}`);
        }
        err = m;
      }
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // fetch network failure only
      err = String(e.message);
    }
    if (attempt >= max) throw new Error(`${method} on ${origin(url)} failed after ${attempt} attempt(s): ${err}`);
    log(`[fork-rpc] ${origin(url)} ${err}; retry ${attempt}/${max} in ${delay / 1000}s`);
    await sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }
}

/** Run a command; returns stdout. Throws on non-zero exit. */
export async function sh(cmd: string[], env: Record<string, string> = {}, inherit = false): Promise<string> {
  const p = Bun.spawn(cmd, {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });
  const [out, err] = inherit
    ? ["", ""]
    : await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code !== 0) throw new Error(`${cmd[0]} ${cmd.slice(1, 3).join(" ")} exited ${code}: ${err.slice(0, 300)}`);
  return out.trim();
}

/** Public fallback endpoints, exactly as fork-rpc-lib.sh resolves them (single source). */
export async function publicEndpoints(): Promise<string[]> {
  const lib = join(REPO, "scripts/devnet/fork-rpc-lib.sh");
  const out = await sh(["bash", "-c", `. "${lib}" && fork_rpc_public_endpoints`]);
  const eps = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (eps.length === 0) throw new Error("fork-rpc-lib.sh listed no public endpoints");
  return eps;
}

/** Bounded-concurrency map. */
export async function pmap<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ── ABI helpers (calldata via cast, decoding by hand) ──────────────────────
export async function calldata(sig: string, ...args: string[]): Promise<string> {
  return sh(["cast", "calldata", sig, ...args]);
}

export const word = (hex: string, i: number): string => "0x" + hex.slice(2).slice(i * 64, (i + 1) * 64);
export const addrOf = (w: string): string => "0x" + w.slice(-40);

export function pad32(v: bigint): string {
  const m = (1n << 256n) - 1n;
  return (v & m).toString(16).padStart(64, "0");
}

/** Signed int from a 32-byte hex word, given its bit width. */
export function signed(w: string, bits: number): bigint {
  const mask = (1n << BigInt(bits)) - 1n;
  let v = BigInt(w) & mask;
  if (v >> BigInt(bits - 1)) v -= 1n << BigInt(bits);
  return v;
}

const keccakCache = new Map<string, string>();
export async function keccakHex(hex: string): Promise<string> {
  const hit = keccakCache.get(hex);
  if (hit) return hit;
  const h = await sh(["cast", "keccak", hex]);
  keccakCache.set(hex, h);
  return h;
}

/** Storage slot of mapping[key] at `slot` (key is a value already left-padded to 32 bytes). */
export async function mappingSlot(keyWord: string, slot: bigint | string): Promise<string> {
  const s = typeof slot === "string" ? BigInt(slot) : slot;
  return keccakHex("0x" + keyWord.replace(/^0x/, "") + pad32(s));
}

export const hexSlot = (v: bigint): string => "0x" + v.toString(16);
export const ZERO_WORD = "0x" + "0".repeat(64);

/** sqrtPriceX96 -> human price of base in quote (bigint math, as clients/dapp/src/lib/uniswapV3.ts). */
export function sqrtPriceToPrice(sqrt: bigint, d0: number, d1: number, baseIsToken0: boolean): number {
  const SCALE = 10n ** 36n;
  const Q96 = 2n ** 96n;
  let r = (sqrt * sqrt * SCALE) / (Q96 * Q96);
  const delta = d0 - d1;
  r = delta >= 0 ? r * 10n ** BigInt(delta) : r / 10n ** BigInt(-delta);
  if (baseIsToken0) return Number(r) / 1e36;
  if (r === 0n) throw new Error("price underflow");
  return Number((SCALE * SCALE) / r) / 1e36;
}

/** Decoded Uniswap V3 slot0 word 0. */
export function decodeSlot0(w0: string) {
  const v = BigInt(w0);
  return {
    sqrtPriceX96: v & ((1n << 160n) - 1n),
    tick: Number(signed("0x" + pad32(v >> 160n), 24)),
    observationIndex: Number((v >> 184n) & 0xffffn),
    observationCardinality: Number((v >> 200n) & 0xffffn),
    observationCardinalityNext: Number((v >> 216n) & 0xffffn),
  };
}
