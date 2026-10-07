/**
 * Twin chain helpers (chain id 918453): the Twin chain is a pinned lazy fork of real Base state served by anvil (core's twin-fork
 * tool starts it). The three environment steps that may differ from production run here, through anvil's own RPC methods:
 *   fund-gas   anvil_setBalance
 *   fund-usdc  anvil_setStorageAt on the real FiatToken balance slot (balanceAndBlacklistStates, mapping at slot 9)
 *   warp       evm_increaseTime / anvil_setNextBlockTimestamp, then evm_mine (how the 48 hour governance waits run)
 * Nothing else about the forked state is patched. Every helper refuses unless the RPC is NOT Base mainnet (eth_chainId 8453) and
 * answers anvil_nodeInfo, so none of them can touch a real chain. No secret is read or written here.
 */
import { encodeAbiParameters, keccak256, pad, toHex, type Hex } from "viem";
import { USDC_ADDRESS, assertUsdcCode } from "../usdc.ts";

import { MAINNET_CHAIN_ID as BASE_CHAIN_ID } from "../chains.ts";
export { BASE_CHAIN_ID };
/** FiatTokenV2_2: `mapping(address => uint256) balanceAndBlacklistStates` is storage slot 9. Bit 255 is the blacklist flag, the rest is the balance. */
export const USDC_BALANCE_SLOT = 9n;
const BLACKLIST_BIT = 1n << 255n;
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
