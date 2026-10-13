/**
 * Twin chain helpers (chain id 918453): the Twin chain is a pinned lazy fork of real Base state served by anvil (core's twin-fork
 * tool starts it). The three environment steps that may differ from production run here, through anvil's own RPC methods:
 *   fund-gas   anvil_setBalance
 *   fund-usdc  anvil_setStorageAt on the real FiatToken balance slot (balanceAndBlacklistStates, mapping at slot 9)
 *   fund-rm-pool  the live RM/USDC Uniswap V4 pool gets real in-range liquidity through the real V4 PositionManager (Permit2). Never a mock.
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

export async function requireTwin(rpc: Rpc): Promise<void> {
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

// ---- fund-rm-pool (core 1554, rewritten for the Uniswap V4 pool in core 1676)
/** Uniswap V4 PositionManager on Base (v4-periphery): real Base state on the Twin chain, so the real contract mints the position. */
export const UNISWAP_V4_POSITION_MANAGER: Hex = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
/** Permit2 on Base: the PositionManager pulls tokens from the owner through it. */
export const PERMIT2: Hex = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** v4-periphery Actions: MINT_POSITION and SETTLE_PAIR. */
export const ACTION_MINT_POSITION = 0x02;
export const ACTION_SETTLE_PAIR = 0x0d;
/** An EOA with no code that holds the RM and USDC for the position. anvil impersonates it, so no key exists. */
export const RM_POOL_FUNDER: Hex = "0x000000000000000000000000000000000000f1d0";
/**
 * The in-range liquidity L the funder adds on top of whatever the live pool holds (about 1e18 at the pin). With the pool fee of 2.91 percent the
 * vault swap bound has 209 bps left for price impact (500 bps ceiling), and a sheet deposit of up to 100 USDC must fit inside it: L of 2e19 holds
 * about 37,000 USDC of virtual reserve, so 100 USDC moves the price about 0.5 percent.
 */
export const RM_POOL_LIQUIDITY = 2n * 10n ** 19n;
/** RM given to the funder (raw units, 18 decimals): far more than the position takes, set by storage write on the fork only. */
export const RM_POOL_RM_UNITS = 10n ** 30n;
export const RM_POOL_USDC_UNITS = 1_000_000n * 10n ** 6n;
/** BasketVault.addAsset floor on in-range liquidity. It is checked here as well, never relaxed. For a V4 pool the unit is the pool's liquidity L, not USDC. */
export const ADD_ASSET_MIN_LIQUIDITY = 1_000_000n;

const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const PERMIT2_ABI = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const POSM_ABI = parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);
const POOL_KEY = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] } as const;

/** The tick range `[lower, lower + spacing]` that holds `tick`, aligned to `spacing`. Floors toward negative infinity (the RM pool sits near -403009). */
export function tickRangeAround(tick: number, spacing: number): [number, number] {
  const lower = Math.floor(tick / spacing) * spacing;
  return [lower, lower + spacing];
}

export interface RmPoolFacts {
  token: Hex; usdc: Hex; poolManager: Hex; stateView: Hex; poolId: Hex;
  key: { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };
}
/** The RM entry of config/agent-token-shortlist.json (the one the vault deploy adds): the Uniswap V4 pool, with its full PoolKey. */
export function readRmPoolFacts(coreDir: string): RmPoolFacts {
  const p = `${coreDir}/config/agent-token-shortlist.json`;
  const j = JSON.parse(readFileSync(p, "utf8"));
  const rm = j.shortlist?.[0];
  const k = rm?.poolKey;
  const hash = (v: unknown): boolean => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
  if (!rm || rm.symbol !== "RM" || rm.venue !== "UniswapV4" || !ADDR.test(rm.token) || !ADDR.test(rm.poolManager) || !ADDR.test(rm.stateView) || !hash(rm.poolId) || !k
    || !ADDR.test(k.currency0) || !ADDR.test(k.currency1) || !Number.isInteger(k.fee) || !Number.isInteger(k.tickSpacing) || !ADDR.test(k.hooks) || !ADDR.test(j.usdc)) fail(`${p} has no usable UniswapV4 RM entry to fund`);
  return { token: rm.token, usdc: j.usdc, poolManager: rm.poolManager, stateView: rm.stateView, poolId: rm.poolId, key: k };
}

/**
 * Funds the live RM/USDC Uniswap V4 pool on the Twin chain through the REAL V4 PositionManager (Permit2), never a mock. The pool is real Base state:
 * it is not created or initialised here (an uninitialised pool is a loud error). The funder is given RM (OpenZeppelin balance slot 0) and USDC
 * (FiatToken slot 9) with the fork's balance helpers, approves Permit2 and lets Permit2 approve the PositionManager, then mints one in-range
 * position of `RM_POOL_LIQUIDITY` with MINT_POSITION and SETTLE_PAIR. The price is not moved by a mint, so the recorder history stays at the live tick.
 * The pool's liquidity must rise by at least the minted L and clear the addAsset floor, or this fails.
 */
export async function fundRmPool(rpc: Rpc, facts: RmPoolFacts, o: { usdcCodeHash?: string } = {}): Promise<{ liquidity: bigint; liquidityBefore: bigint; ticks: [number, number]; tick: number }> {
  await requireTwin(rpc);
  const call = async <T>(to: Hex, abi: ReturnType<typeof parseAbi>, functionName: string, args: unknown[] = []): Promise<T> =>
    decodeFunctionResult({ abi, functionName, data: (await rpc("eth_call", [{ to, data: encodeFunctionData({ abi, functionName, args } as never) }, "latest"])) as Hex } as never) as T;
  const send = async (to: Hex, data: Hex, what: string): Promise<void> => {
    const hash = (await rpc("eth_sendTransaction", [{ from: RM_POOL_FUNDER, to, data, gas: "0x1c9c380" }])) as Hex;
    for (let i = 0; i < 120; i++) {
      const r = (await rpc("eth_getTransactionReceipt", [hash])) as { status?: string } | null;
      if (r) { if (r.status !== "0x1") fail(`${what} reverted (tx ${hash})`); return; }
      await new Promise((res) => setTimeout(res, 500));
    }
    fail(`${what} was not mined within 60 s (tx ${hash})`);
  };
  const { key } = facts;
  if (key.currency0.toLowerCase() !== facts.token.toLowerCase() || key.currency1.toLowerCase() !== facts.usdc.toLowerCase()) fail(`the PoolKey is ${key.currency0}/${key.currency1}, expected RM ${facts.token} then USDC ${facts.usdc}: the mint below orders RM first`);
  const derived = keccak256(encodeAbiParameters([POOL_KEY], [key]));
  if (derived.toLowerCase() !== facts.poolId.toLowerCase()) fail(`the config PoolKey hashes to ${derived}, not the pool id ${facts.poolId}`);
  const slot0 = await call<readonly [bigint, number, number, number]>(facts.stateView, STATE_VIEW_ABI, "getSlot0", [facts.poolId]);
  if (slot0[0] === 0n) fail(`pool ${facts.poolId} is not initialized on this chain: it is created on Base, not by this helper`);
  const liquidityBefore = await call<bigint>(facts.stateView, STATE_VIEW_ABI, "getLiquidity", [facts.poolId]);
  if (BigInt(String(await rpc("eth_getCode", [RM_POOL_FUNDER, "latest"])).length) > 2n) fail(`${RM_POOL_FUNDER} has code, it must be a plain EOA`);

  await fundGas(rpc, [RM_POOL_FUNDER], 10n ** 18n);
  await rpc("anvil_impersonateAccount", [RM_POOL_FUNDER]);
  // RM: an absolute write of the balance slot (OpenZeppelin ERC20, `_balances` at slot 0), then a read back through balanceOf.
  const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [RM_POOL_FUNDER, 0n]));
  await rpc("anvil_setStorageAt", [facts.token, slot, pad(toHex(RM_POOL_RM_UNITS), { size: 32 })]);
  const rmNow = await call<bigint>(facts.token, ERC20_ABI, "balanceOf", [RM_POOL_FUNDER]);
  if (rmNow !== RM_POOL_RM_UNITS) fail(`RM balanceOf(funder) is ${rmNow}, wanted ${RM_POOL_RM_UNITS}: slot 0 is not the balances mapping`);
  await fundUsdc(rpc, [RM_POOL_FUNDER], RM_POOL_USDC_UNITS, o.usdcCodeHash);

  const maxU256 = 2n ** 256n - 1n, maxU160 = 2n ** 160n - 1n, maxU128 = 2n ** 128n - 1n, expiry = 2n ** 48n - 1n;
  for (const [token, what] of [[facts.token, "RM"], [facts.usdc, "USDC"]] as const) {
    await send(token, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [PERMIT2, maxU256] }), `${what} approve to Permit2`);
    await send(PERMIT2, encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [token, UNISWAP_V4_POSITION_MANAGER, maxU160, Number(expiry)] }), `${what} Permit2 approve to the PositionManager`);
  }
  const [lower, upper] = tickRangeAround(Number(slot0[1]), key.tickSpacing);
  const mint = encodeAbiParameters(
    [POOL_KEY, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [key, lower, upper, RM_POOL_LIQUIDITY, maxU128, maxU128, RM_POOL_FUNDER, "0x"],
  );
  const settle = encodeAbiParameters([{ type: "address" }, { type: "address" }], [key.currency0, key.currency1]);
  const actions = `0x${ACTION_MINT_POSITION.toString(16).padStart(2, "0")}${ACTION_SETTLE_PAIR.toString(16).padStart(2, "0")}` as Hex;
  const unlockData = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [mint, settle]]);
  await send(UNISWAP_V4_POSITION_MANAGER, encodeFunctionData({ abi: POSM_ABI, functionName: "modifyLiquidities", args: [unlockData, 2n ** 40n] }), "PositionManager.modifyLiquidities (mint)");
  await rpc("anvil_stopImpersonatingAccount", [RM_POOL_FUNDER]);

  const liquidity = await call<bigint>(facts.stateView, STATE_VIEW_ABI, "getLiquidity", [facts.poolId]);
  if (liquidity < liquidityBefore + RM_POOL_LIQUIDITY || liquidity < ADD_ASSET_MIN_LIQUIDITY) {
    fail(`RM pool ${facts.poolId} did not take the position: liquidity ${liquidityBefore} before, ${liquidity} after, wanted at least ${liquidityBefore + RM_POOL_LIQUIDITY}`);
  }
  return { liquidity, liquidityBefore, ticks: [lower, upper], tick: Number(slot0[1]) };
}
