/**
 * Twin chain helpers (chain id 918453): the Twin chain is a pinned lazy fork of real Base state served by anvil (core's twin-fork
 * tool starts it). The three environment steps that may differ from production run here, through anvil's own RPC methods:
 *   fund-gas   anvil_setBalance
 *   fund-usdc  anvil_setStorageAt on the real FiatToken balance slot (balanceAndBlacklistStates, mapping at slot 9)
 *   fund-rm-pool  the live RM/USDC Uniswap V3 pool gets real liquidity and observation history through the real NonfungiblePositionManager
 *   warp       evm_increaseTime / anvil_setNextBlockTimestamp, then evm_mine (how the 48 hour governance waits run)
 * Nothing else about the forked state is patched. Every helper refuses unless the RPC is NOT Base mainnet (eth_chainId 8453) and
 * answers anvil_nodeInfo, so none of them can touch a real chain. No secret is read or written here.
 */
import { readFileSync } from "node:fs";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toHex, type Hex } from "viem";
import { USDC_ADDRESS, assertUsdcCode } from "../usdc.ts";

import { MAINNET_CHAIN_ID as BASE_CHAIN_ID } from "../chains.ts";
export { BASE_CHAIN_ID };
/** FiatTokenV2_2: `mapping(address => uint256) balanceAndBlacklistStates` is storage slot 9. Bit 255 is the blacklist flag, the rest is the balance. */
export const USDC_BALANCE_SLOT = 9n;
const BLACKLIST_BIT = 1n << 255n;
/**
 * Default gas balance `fund-gas` gives each sheet wallet on the Twin chain: 0.5 ETH. The runner pre-flight needs 3x the simulated stage
 * cost plus the L1 allowance. The vault stage needed 0.0447 ETH at the time of core 1554 (the old 0.02 ETH default failed it once), and every
 * stage spends from the one deployer. Do not lower it without re-measuring. Never weaken the pre-flight instead.
 */
export const TWIN_GAS_WEI = 5n * 10n ** 17n;
const MAX_FUND_WEI = 10n ** 21n;   // 1000 ETH: a misread amount is refused

export class TwinError extends Error {}
const fail = (m: string): never => { throw new TwinError(m); };

/** One JSON-RPC call. Tests inject a stub. */
export type Rpc = (method: string, params?: unknown[]) => Promise<unknown>;

/** The default transport: JSON-RPC over fetch, with a retry and backoff on HTTP 429 (the public upstream rate-limits). */
export function httpRpc(url: string, o: { retries?: number; backoffMs?: number; fetchFn?: typeof fetch } = {}): Rpc {
  const f = o.fetchFn ?? fetch, retries = o.retries ?? 5, backoff = o.backoffMs ?? 500;
  let id = 0;
  return async (method, params = []) => {
    for (let attempt = 0; ; attempt++) {
      const res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      if (res.status === 429 && attempt < retries) { await new Promise((r) => setTimeout(r, backoff * 2 ** attempt)); continue; }
      if (!res.ok) fail(`${method}: HTTP ${res.status}`);
      const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (j.error) fail(`${method}: ${j.error.message ?? "RPC error"}`);
      return j.result;
    }
  };
}

const hexToBig = (v: unknown): bigint => BigInt(String(v));

export async function chainIdOf(rpc: Rpc): Promise<number> { return Number(hexToBig(await rpc("eth_chainId"))); }

/** True only for a non-Base chain whose RPC answers anvil_nodeInfo. A real node answers an error, which is not an anvil. */
export async function isTwinFork(rpc: Rpc): Promise<boolean> {
  try {
    if ((await chainIdOf(rpc)) === BASE_CHAIN_ID) return false;
    const info = await rpc("anvil_nodeInfo");
    return typeof info === "object" && info !== null;
  } catch { return false; }
}

async function requireTwin(rpc: Rpc): Promise<void> {
  const id = await chainIdOf(rpc);
  if (id === BASE_CHAIN_ID) fail(`refusing: the RPC is chain ${BASE_CHAIN_ID} (Base mainnet), these helpers run on the Twin fork only`);
  try { await rpc("anvil_nodeInfo"); } catch { fail(`refusing: chain ${id} does not answer anvil_nodeInfo, it is not an anvil fork`); }
}

export async function latestTimestamp(rpc: Rpc): Promise<bigint> {
  const b = (await rpc("eth_getBlockByNumber", ["latest", false])) as { timestamp: string };
  return hexToBig(b.timestamp);
}

/** Moves chain time forward by `seconds` and mines one block. Returns the new head timestamp. */
export async function warpBy(rpc: Rpc, seconds: bigint): Promise<bigint> {
  if (seconds <= 0n) fail(`warp needs a positive number of seconds, got ${seconds}`);
  await requireTwin(rpc);
  const before = await latestTimestamp(rpc);
  await rpc("evm_increaseTime", [Number(seconds)]);
  await rpc("evm_mine", []);
  const after = await latestTimestamp(rpc);
  if (after < before + seconds) fail(`warp did not move time: head ${before} -> ${after}, wanted at least +${seconds}`);
  return after;
}

/** Sets the next block's timestamp to `ts` and mines it. A timestamp not after the head is refused. */
export async function warpTo(rpc: Rpc, ts: bigint): Promise<bigint> {
  await requireTwin(rpc);
  const before = await latestTimestamp(rpc);
  if (ts <= before) fail(`warp target ${ts} is not after the head timestamp ${before}`);
  await rpc("anvil_setNextBlockTimestamp", [Number(ts)]);
  await rpc("evm_mine", []);
  const after = await latestTimestamp(rpc);
  if (after < ts) fail(`warp to ${ts} left the head at ${after}`);
  return after;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const checkAddrs = (a: string[]): void => { if (!a.length) fail("no address given"); for (const x of a) if (!ADDR.test(x)) fail(`'${x}' is not an address`); };

/** Sets the ETH balance of every address to at least `wei` (a higher balance is left alone). Returns the final balances. */
export async function fundGas(rpc: Rpc, addresses: string[], wei: bigint): Promise<Record<string, bigint>> {
  if (wei <= 0n || wei > MAX_FUND_WEI) fail(`gas amount ${wei} wei is outside 1 to ${MAX_FUND_WEI}: a misread amount?`);
  checkAddrs(addresses);
  await requireTwin(rpc);
  const out: Record<string, bigint> = {};
  for (const a of addresses) {
    const have = hexToBig(await rpc("eth_getBalance", [a, "latest"]));
    if (have < wei) await rpc("anvil_setBalance", [a, toHex(wei)]);
    const now = hexToBig(await rpc("eth_getBalance", [a, "latest"]));
    if (now < wei) fail(`${a} holds ${now} wei after funding, wanted ${wei}`);
    out[a] = now;
  }
  return out;
}

export const usdcBalanceSlot = (holder: string): Hex => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder as Hex, USDC_BALANCE_SLOT]));

async function usdcBalance(rpc: Rpc, holder: string): Promise<bigint> {
  const data = ("0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0")) as Hex;
  return hexToBig(await rpc("eth_call", [{ to: USDC_ADDRESS, data }, "latest"]));
}

/**
 * Sets the real FiatToken balance of every address to at least `units` (6 decimals) by writing its balance storage slot. Total supply is
 * not touched. `pinnedCodeHash` is injectable for tests only. The token code is checked against the pinned FiatTokenProxy hash first, and the balance is read back through balanceOf.
 */
export async function fundUsdc(rpc: Rpc, addresses: string[], units: bigint, pinnedCodeHash?: string): Promise<Record<string, bigint>> {
  if (units <= 0n || units >= BLACKLIST_BIT) fail(`USDC amount ${units} is outside the valid range`);
  checkAddrs(addresses);
  await requireTwin(rpc);
  assertUsdcCode(String(await rpc("eth_getCode", [USDC_ADDRESS, "latest"])), pinnedCodeHash);
  const out: Record<string, bigint> = {};
  for (const a of addresses) {
    const have = await usdcBalance(rpc, a);
    if (have < units) await rpc("anvil_setStorageAt", [USDC_ADDRESS, usdcBalanceSlot(a), pad(toHex(units), { size: 32 })]);
    const now = await usdcBalance(rpc, a);
    if (now < units) fail(`${a} holds ${now} USDC units after funding, wanted ${units}: the balance slot did not take`);
    out[a] = now;
  }
  return out;
}

// ---- fund-rm-pool (core 1554)
/** Uniswap V3 NonfungiblePositionManager on Base: real Base state on the Twin chain, so the real contract mints the position. */
export const UNISWAP_V3_NPM: Hex = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
/** An EOA with no code that holds the RM and USDC for the position. anvil impersonates it, so no key exists. */
export const RM_POOL_FUNDER: Hex = "0x000000000000000000000000000000000000f1d0";
/** Above the 901 floor so the pool clears it with margin once the first observation write grows the ring. */
export const RM_POOL_CARDINALITY_NEXT = 1000;
export const RM_POOL_RM_UNITS = 1_000_000n * 10n ** 18n;
export const RM_POOL_USDC_UNITS = 1_000n * 10n ** 6n;
/** BasketVault.addAsset floors. They are checked here as well, never relaxed. */
/** Window-derived (core 1665): the 1800 s default TWAP window at Base's 2 s blocks needs 1800 / 2 + 1 slots. */
export const ADD_ASSET_MIN_CARDINALITY = 901;
export const ADD_ASSET_MIN_LIQUIDITY = 1_000_000n;

/** Uniswap V3 slot0 packs sqrtPriceX96 (160 bits), tick (24), observationIndex (16), observationCardinality (16 at bit 200), observationCardinalityNext (16 at bit 216). */
export function withObservationCardinality(word: Hex, n: number): Hex {
  const mask = ((1n << 32n) - 1n) << 200n;
  const v = (BigInt(word) & ~mask) | (BigInt(n) << 200n) | (BigInt(n) << 216n);
  return pad(toHex(v), { size: 32 });
}

const POOL_ABI = parseAbi([
  "function token0() view returns (address)",
  "function tickSpacing() view returns (int24)",
  "function liquidity() view returns (uint128)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const NPM_ABI = parseAbi(["function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)"]);

/** The tick range `[lower, lower + spacing]` that holds `tick`, aligned to `spacing`. Floors toward negative infinity (the RM pool sits near -389201). */
export function tickRangeAround(tick: number, spacing: number): [number, number] {
  const lower = Math.floor(tick / spacing) * spacing;
  return [lower, lower + spacing];
}

export interface RmPoolFacts { token: Hex; pool: Hex; fee: number; usdc: Hex }
/** The RM entry of config/agent-token-shortlist.json (the one the vault deploy adds). */
export function readRmPoolFacts(coreDir: string): RmPoolFacts {
  const p = `${coreDir}/config/agent-token-shortlist.json`;
  const j = JSON.parse(readFileSync(p, "utf8"));
  const rm = j.shortlist?.[0];
  if (!rm || rm.symbol !== "RM" || !ADDR.test(rm.token) || !ADDR.test(rm.pool) || !Number.isInteger(rm.poolFee) || !ADDR.test(j.usdc)) fail(`${p} has no usable RM entry to fund`);
  return { token: rm.token, pool: rm.pool, fee: rm.poolFee, usdc: j.usdc };
}

/**
 * Funds the live RM/USDC V3 pool on the Twin chain so `BasketVault.addAsset` (cardinality >= 901, liquidity >= 1e6) accepts RM. Real pool, real
 * position manager, real transactions: the funder is given RM (OpenZeppelin balance slot 0) and USDC (FiatToken slot 9) with the fork's balance
 * helpers, raises the pool's observation cardinality (one slot0 write, see below), then mints one in-range position. An in-range mint writes an observation, so the new
 * cardinality takes effect. The floors are asserted at the end, so a pool that still fails them is a loud error here, not a later revert.
 */
export async function fundRmPool(rpc: Rpc, facts: RmPoolFacts): Promise<{ liquidity: bigint; cardinality: number; ticks: [number, number] }> {
  await requireTwin(rpc);
  const call = async <T>(to: Hex, abi: ReturnType<typeof parseAbi>, functionName: string, args: unknown[] = []): Promise<T> =>
    decodeFunctionResult({ abi, functionName, data: (await rpc("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, "latest"])) as Hex } as never) as T;
  const send = async (to: Hex, data: Hex, what: string): Promise<void> => {
    const hash = (await rpc("eth_sendTransaction", [{ from: RM_POOL_FUNDER, to, data }])) as Hex;
    for (let i = 0; i < 120; i++) {
      const r = (await rpc("eth_getTransactionReceipt", [hash])) as { status?: string } | null;
      if (r) { if (r.status !== "0x1") fail(`${what} reverted (tx ${hash})`); return; }
      await new Promise((res) => setTimeout(res, 500));
    }
    fail(`${what} was not mined within 60 s (tx ${hash})`);
  };
  const token0 = String(await call<string>(facts.pool, POOL_ABI, "token0")).toLowerCase();
  if (token0 !== facts.token.toLowerCase()) fail(`pool ${facts.pool} token0 is ${token0}, expected RM ${facts.token}: the mint below orders RM first`);
  if (BigInt(String(await rpc("eth_getCode", [RM_POOL_FUNDER, "latest"])).length) > 2n) fail(`${RM_POOL_FUNDER} has code, it must be a plain EOA`);

  await fundGas(rpc, [RM_POOL_FUNDER], 10n ** 18n);
  await rpc("anvil_impersonateAccount", [RM_POOL_FUNDER]);
  // RM: an absolute write of the balance slot (OpenZeppelin ERC20, `_balances` at slot 0), then a read back through balanceOf.
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [RM_POOL_FUNDER, 0n]));
  await rpc("anvil_setStorageAt", [facts.token, slot, pad(toHex(RM_POOL_RM_UNITS), { size: 32 })]);
  const rmNow = await call<bigint>(facts.token, ERC20_ABI, "balanceOf", [RM_POOL_FUNDER]);
  if (rmNow !== RM_POOL_RM_UNITS) fail(`RM balanceOf(funder) is ${rmNow}, wanted ${RM_POOL_RM_UNITS}: slot 0 is not the balances mapping`);
  await fundUsdc(rpc, [RM_POOL_FUNDER], RM_POOL_USDC_UNITS);

  // Grow the observation ring. The pool's own increaseObservationCardinalityNext(n) writes every new slot, and on a fork each cold slot is a remote
  // storage read: 900+ of them time the Twin chain out (core 1665). The ring slots the pool initialises are zero-valued markers, so the same end state is
  // one write to the packed slot0 word (observationCardinality and observationCardinalityNext). The funding below still goes through real transactions.
  const slot0Word = (await rpc("eth_getStorageAt", [facts.pool, "0x0", "latest"])) as Hex;
  await rpc("anvil_setStorageAt", [facts.pool, "0x0", withObservationCardinality(slot0Word, RM_POOL_CARDINALITY_NEXT)]);
  await send(facts.token, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [UNISWAP_V3_NPM, RM_POOL_RM_UNITS] }), "RM approve");
  await send(facts.usdc, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [UNISWAP_V3_NPM, RM_POOL_USDC_UNITS] }), "USDC approve");
  const spacing = Number(await call<number>(facts.pool, POOL_ABI, "tickSpacing"));
  const slot0 = await call<readonly [bigint, number, number, number, number, number, boolean]>(facts.pool, POOL_ABI, "slot0");
  const [lower, upper] = tickRangeAround(Number(slot0[1]), spacing);
  await send(UNISWAP_V3_NPM, encodeFunctionData({ abi: NPM_ABI, functionName: "mint", args: [{
    token0: facts.token, token1: facts.usdc, fee: facts.fee, tickLower: lower, tickUpper: upper, amount0Desired: RM_POOL_RM_UNITS, amount1Desired: RM_POOL_USDC_UNITS,
    amount0Min: 0n, amount1Min: 0n, recipient: RM_POOL_FUNDER, deadline: 2n ** 40n,
  }] }), "NonfungiblePositionManager.mint");
  await rpc("anvil_stopImpersonatingAccount", [RM_POOL_FUNDER]);

  const liquidity = await call<bigint>(facts.pool, POOL_ABI, "liquidity");
  const cardinality = Number((await call<readonly [bigint, number, number, number, number, number, boolean]>(facts.pool, POOL_ABI, "slot0"))[3]);
  if (liquidity < ADD_ASSET_MIN_LIQUIDITY || cardinality < ADD_ASSET_MIN_CARDINALITY) {
    fail(`RM pool ${facts.pool} still fails the addAsset floors after funding: liquidity ${liquidity} (need ${ADD_ASSET_MIN_LIQUIDITY}), cardinality ${cardinality} (need ${ADD_ASSET_MIN_CARDINALITY})`);
  }
  return { liquidity, cardinality, ticks: [lower, upper] };
}
