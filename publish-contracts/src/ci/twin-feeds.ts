#!/usr/bin/env bun
// The real Chainlink feeds of the fund system on the Twin fork (Deploy 4). The Twin chain (918453) is a PINNED lazy fork of Base (scripts/devnet/twin-fork.ts): every
// feed serves the round it held at the pin block for as long as the fork runs, while the fork's clock moves on (anvil stamps each new block with the pin's time plus
// the wall time since the fork started, and a warp adds to it). So a feed goes stale on the Twin at its pre-pin updatedAt plus its maxFeedAge, and never comes back:
// ETH / USD (maxFeedAge 1,500 s, a 1,200 s heartbeat) within 300 to 1,500 s of chain time after the pin, cbBTC / USD and USDC / USD (86,700 s, a 24 h heartbeat)
// within 300 to 86,700 s. Nothing here writes feed storage or etches a mock: the tool only reads, and the probe moves the clock forward to show the refusal.
//   bun src/ci/twin-feeds.ts check --rpc URL [--min-margin S] [--out FILE]
//        reads every feed and the fork's clock; exit 1 when a feed is stale or goes stale within S seconds (the fund stage's addAsset and the queue's checks would refuse).
//   bun src/ci/twin-feeds.ts probe --rpc URL --fund ADDR --queue ADDR --usdc N [--out FILE]
//        on a published fund: while ETH / USD is fresh, totalAssets() reads; then the clock is moved past the ETH round's stale point (only forward, only when it is not
//        already past) and totalAssets() must revert FeedUnhealthy(ethIndex, Stale) and quoteDeposit(N) SettleBlocked(Feed, ethIndex, Stale). Exit 1 otherwise.
// Both refuse any chain but 918453. The feed addresses, the maximum ages and the WETH asset index are read from contracts/script/FundSystemBase.sol, the constants
// the deploy scripts use, so this file holds none of them.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { TWIN_CHAIN_ID } from "../chains.ts";

/** One JSON-RPC answer: the result, or the error with its revert data. */
export type RawRpc = (method: string, params?: unknown[]) => Promise<{ result?: unknown; error?: { message?: string; data?: unknown } }>;

export function httpRawRpc(url: string, fetchFn: typeof fetch = fetch): RawRpc {
  let id = 0;
  return async (method, params = []) => {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    return (await res.json()) as { result?: unknown; error?: { message?: string; data?: unknown } };
  };
}

export interface FeedSpec { name: string; address: Address; maxAge: number }
export interface FundFeeds { feeds: FeedSpec[]; sequencer: Address; ethIndex: number }

/** The fund system's feeds as the deploy scripts name them (contracts/script/FundSystemBase.sol): ETH / USD and cbBTC / USD for the two basket assets, USDC / USD for the queue's peg check. */
export function fundFeedsFromSource(src: string): FundFeeds {
  const constant = (name: string): string => {
    const m = new RegExp(`\\b${name}\\s*=\\s*([0-9a-fA-Fx_]+)\\s*;`).exec(src);
    if (!m) throw new Error(`FundSystemBase.sol names no ${name}`);
    return m[1]!.replace(/_/g, "");
  };
  const addr = (n: string): Address => getAddress(constant(n));
  const age = (n: string): number => Number(constant(n));
  return {
    feeds: [
      { name: "ETH/USD", address: addr("FEED_ETH"), maxAge: age("ETH_FEED_MAX_AGE") },
      { name: "cbBTC/USD", address: addr("FEED_CBBTC"), maxAge: age("DAY_FEED_MAX_AGE") },
      { name: "USDC/USD", address: addr("FEED_USDC"), maxAge: age("DAY_FEED_MAX_AGE") },
    ],
    sequencer: addr("FEED_SEQUENCER"),
    ethIndex: age("IDX_WETH"),
  };
}
export const loadFundFeeds = (root: string): FundFeeds => fundFeedsFromSource(readFileSync(join(root, "contracts/script/FundSystemBase.sol"), "utf8"));

export interface FeedWindow { name: string; address: Address; maxAge: number; updatedAt: number; staleAt: number; marginSec: number; fresh: boolean }

/** PURE. Each feed's stale point (its updatedAt plus its maxFeedAge, FeedLib: stale when block.timestamp - updatedAt > maxAge) and the seconds left at `chainNow`. */
export function feedWindows(feeds: FeedSpec[], updatedAt: Record<string, number>, chainNow: number): FeedWindow[] {
  return feeds.map((f) => {
    const u = updatedAt[f.address];
    if (u === undefined) throw new Error(`no round read for ${f.name} ${f.address}`);
    const staleAt = u + f.maxAge;
    return { name: f.name, address: f.address, maxAge: f.maxAge, updatedAt: u, staleAt, marginSec: staleAt - chainNow, fresh: chainNow - u <= f.maxAge };
  });
}

/** PURE. The problems of a window set against the margin a caller needs (the publish's time to its fund stage, say). */
export function windowProblems(w: FeedWindow[], minMargin: number): string[] {
  const out: string[] = [];
  for (const x of w) {
    if (!x.fresh) out.push(`${x.name} is stale on this fork: updated at ${x.updatedAt}, maxFeedAge ${x.maxAge} s, stale since ${x.staleAt}. The pinned fork serves no newer round: start a new fork at a fresh pin`);
    else if (x.marginSec < minMargin) out.push(`${x.name} goes stale in ${x.marginSec} s (at ${x.staleAt}), less than the ${minMargin} s this step needs. The pinned fork serves no newer round: start a new fork at a fresh pin`);
  }
  return out;
}

const ROUND_ABI = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)"]);
const FUND_ABI = parseAbi(["function totalAssets() view returns (uint256)", "function quoteDeposit(uint256 usdc) view returns ((uint256,uint256,uint256,uint64,uint64))"]);
/** FeedStatus.Stale and SettleCheck.Feed (contracts/test/prototype/src/FundTypes.sol, FlowTypes.sol). */
export const FEED_STATUS_STALE = 5;
export const SETTLE_CHECK_FEED = 5;
export const FEED_UNHEALTHY = toFunctionSelector("FeedUnhealthy(uint256,uint8)");
export const SETTLE_BLOCKED = toFunctionSelector("SettleBlocked(uint8,uint256,uint256)");
/** PURE. The revert data the fund and the queue give for a stale basket feed at `index`. */
export const feedUnhealthyData = (index: number): Hex => `${FEED_UNHEALTHY}${encodeAbiParameters([{ type: "uint256" }, { type: "uint8" }], [BigInt(index), FEED_STATUS_STALE]).slice(2)}` as Hex;
export const settleBlockedFeedData = (index: number): Hex => `${SETTLE_BLOCKED}${encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }], [SETTLE_CHECK_FEED, BigInt(index), BigInt(FEED_STATUS_STALE)]).slice(2)}` as Hex;

const hexNum = (h: unknown): number => Number(BigInt(String(h)));
const blockTag = (n: number): string => `0x${n.toString(16)}`;

async function chainId(rpc: RawRpc): Promise<number> {
  const r = await rpc("eth_chainId");
  if (r.error) throw new Error(`eth_chainId: ${r.error.message ?? "error"}`);
  return hexNum(r.result);
}
/** Twin only: the probe moves the clock, and neither verb has any business on Base. */
export async function requireTwinChain(rpc: RawRpc): Promise<void> {
  const id = await chainId(rpc);
  if (id !== TWIN_CHAIN_ID) throw new Error(`refusing: the RPC is chain ${id}, not the Twin chain ${TWIN_CHAIN_ID}`);
}
async function head(rpc: RawRpc): Promise<{ number: number; timestamp: number }> {
  const r = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (r.error) throw new Error(`eth_getBlockByNumber: ${r.error.message ?? "error"}`);
  const b = r.result as { number: string; timestamp: string };
  return { number: hexNum(b.number), timestamp: hexNum(b.timestamp) };
}
async function call(rpc: RawRpc, to: Address, data: Hex, block: number): Promise<{ ok: true; data: Hex } | { ok: false; data: Hex | undefined; message: string }> {
  const r = await rpc("eth_call", [{ to, data }, blockTag(block)]);
  if (r.error) {
    const d = r.error.data;
    const raw = typeof d === "string" ? d : typeof (d as { data?: unknown })?.data === "string" ? (d as { data: string }).data : undefined;
    return { ok: false, data: raw as Hex | undefined, message: r.error.message ?? "reverted" };
  }
  return { ok: true, data: r.result as Hex };
}
async function updatedAtOf(rpc: RawRpc, feed: Address, block: number): Promise<number> {
  const r = await call(rpc, feed, encodeFunctionData({ abi: ROUND_ABI, functionName: "latestRoundData" }), block);
  if (!r.ok) throw new Error(`latestRoundData of ${feed} reverted: ${r.message}`);
  const [, , , updatedAt] = decodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], r.data);
  return Number(updatedAt);
}
async function sequencerAnswer(rpc: RawRpc, feed: Address, block: number): Promise<{ answer: number; startedAt: number }> {
  const r = await call(rpc, feed, encodeFunctionData({ abi: ROUND_ABI, functionName: "latestRoundData" }), block);
  if (!r.ok) throw new Error(`latestRoundData of the sequencer feed ${feed} reverted: ${r.message}`);
  const [, answer, startedAt] = decodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], r.data);
  return { answer: Number(answer), startedAt: Number(startedAt) };
}

export interface CheckRecord { chainNow: number; headBlock: number; headTimestamp: number; wallClock: number; windows: FeedWindow[]; sequencer: { answer: number; startedAt: number }; minMargin: number; problems: string[] }

/**
 * Reads every feed at the head block. The clock the next transaction sees is at least the head's timestamp and, on a fork started at a fresh pin (the Twin's `auto`
 * pin, head minus two blocks), the wall clock: anvil stamps a new block with the pin's time plus the time since it started. The larger of the two is used, so the
 * margin is never overstated (on a fork pinned in the past it is understated, which only refuses earlier).
 */
export async function checkFeeds(rpc: RawRpc, ff: FundFeeds, minMargin: number, wallClock: number = Math.floor(Date.now() / 1000)): Promise<CheckRecord> {
  await requireTwinChain(rpc);
  const h = await head(rpc);
  const updatedAt: Record<string, number> = {};
  for (const f of ff.feeds) updatedAt[f.address] = await updatedAtOf(rpc, f.address, h.number);
  const sequencer = await sequencerAnswer(rpc, ff.sequencer, h.number);
  const chainNow = Math.max(h.timestamp, wallClock);
  const windows = feedWindows(ff.feeds, updatedAt, chainNow);
  const problems = windowProblems(windows, minMargin);
  if (sequencer.answer !== 0) problems.push(`the sequencer uptime feed reports down (answer ${sequencer.answer})`);
  return { chainNow, headBlock: h.number, headTimestamp: h.timestamp, wallClock, windows, sequencer, minMargin, problems };
}

export interface ProbeRecord {
  ethIndex: number;
  fresh: { block: number; timestamp: number; ethStaleAt: number; result: "ok" | "skipped-feed-stale" | "reverted"; detail?: string };
  stale: { block: number; timestamp: number; warpedSec: number; totalAssets: Hex | "no-revert"; quoteDeposit: Hex | "no-revert" };
  problems: string[];
}

/**
 * The fund's own refusal on the Twin's frozen feeds. One empty block is mined first (evm_mine) so the head carries the fork's clock and every call reads at that
 * explicit block. While every feed is fresh there, totalAssets() must read (otherwise the fresh probe is recorded as skipped, with the stale feeds named). Then the clock moves to one second past the ETH round's stale point (anvil_setNextBlockTimestamp
 * and evm_mine, forward only, skipped when the head is already past it), and both calls must revert with the named error for the WETH asset.
 */
export async function probeFeeds(rpc: RawRpc, ff: FundFeeds, o: { fund: Address; queue: Address; usdc: bigint }): Promise<ProbeRecord> {
  await requireTwinChain(rpc);
  const problems: string[] = [];
  const mined = await rpc("evm_mine", []);
  if (mined.error) throw new Error(`evm_mine: ${mined.error.message ?? "error"} (the probe runs on an anvil fork only)`);
  const h0 = await head(rpc);
  const updatedAt: Record<string, number> = {};
  for (const f of ff.feeds) updatedAt[f.address] = await updatedAtOf(rpc, f.address, h0.number);
  const w0 = feedWindows(ff.feeds, updatedAt, h0.timestamp);
  const ethStaleAt = w0[0]!.staleAt;
  const totalAssets = encodeFunctionData({ abi: FUND_ABI, functionName: "totalAssets" });
  const quote = encodeFunctionData({ abi: FUND_ABI, functionName: "quoteDeposit", args: [o.usdc] });
  let fresh: ProbeRecord["fresh"];
  if (w0.every((w) => w.fresh)) {
    const r = await call(rpc, o.fund, totalAssets, h0.number);
    fresh = { block: h0.number, timestamp: h0.timestamp, ethStaleAt, result: r.ok ? "ok" : "reverted", ...(r.ok ? {} : { detail: r.data ?? r.message }) };
    if (!r.ok) problems.push(`totalAssets() reverted at block ${h0.number} while ETH / USD was fresh (stale at ${ethStaleAt}): ${r.data ?? r.message}`);
  } else fresh = { block: h0.number, timestamp: h0.timestamp, ethStaleAt, result: "skipped-feed-stale", detail: w0.filter((w) => !w.fresh).map((w) => w.name).join(",") };
  let h1 = h0, warpedSec = 0;
  if (h0.timestamp <= ethStaleAt) {
    const target = ethStaleAt + 1;
    for (const [m, p] of [["anvil_setNextBlockTimestamp", [target]], ["evm_mine", []]] as const) {
      const r = await rpc(m, [...p]);
      if (r.error) throw new Error(`${m}: ${r.error.message ?? "error"}`);
    }
    h1 = await head(rpc);
    if (h1.timestamp < target) throw new Error(`the warp to ${target} left the head at ${h1.timestamp}`);
    warpedSec = h1.timestamp - h0.timestamp;
  }
  const ta = await call(rpc, o.fund, totalAssets, h1.number);
  const qd = await call(rpc, o.queue, quote, h1.number);
  const want = { ta: feedUnhealthyData(ff.ethIndex), qd: settleBlockedFeedData(ff.ethIndex) };
  const got = (r: Awaited<ReturnType<typeof call>>): Hex | "no-revert" => (r.ok ? "no-revert" : (r.data ?? ("0x" as Hex)));
  if (got(ta).toLowerCase() !== want.ta.toLowerCase()) problems.push(`totalAssets() past the ETH / USD stale point: want FeedUnhealthy(${ff.ethIndex}, Stale) ${want.ta}, got ${got(ta)}`);
  if (got(qd).toLowerCase() !== want.qd.toLowerCase()) problems.push(`quoteDeposit(${o.usdc}) past the ETH / USD stale point: want SettleBlocked(Feed, ${ff.ethIndex}, Stale) ${want.qd}, got ${got(qd)}`);
  return { ethIndex: ff.ethIndex, fresh, stale: { block: h1.number, timestamp: h1.timestamp, warpedSec, totalAssets: got(ta), quoteDeposit: got(qd) }, problems };
}

if (import.meta.main) {
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: {
    rpc: { type: "string" }, "min-margin": { type: "string", default: "0" }, out: { type: "string" }, fund: { type: "string" }, queue: { type: "string" }, usdc: { type: "string" },
  } });
  const root = new URL("../../../", import.meta.url).pathname;
  const fail = (m: string, code = 1): never => { console.error(`twin-feeds: ${m}`); process.exit(code); };
  try {
    if (!v.rpc) fail("--rpc is required", 2);
    const rpc = httpRawRpc(v.rpc!);
    const ff = loadFundFeeds(root);
    if (positionals[0] === "check") {
      const minMargin = Number(v["min-margin"]);
      if (!Number.isInteger(minMargin) || minMargin < 0) fail("--min-margin is a whole number of seconds", 2);
      const rec = await checkFeeds(rpc, ff, minMargin);
      if (v.out) writeFileSync(v.out, JSON.stringify(rec, null, 2) + "\n");
      for (const w of rec.windows) console.log(`${w.name.padEnd(10)} ${w.address} updatedAt ${w.updatedAt} maxFeedAge ${w.maxAge} staleAt ${w.staleAt} ${w.fresh ? `fresh, ${w.marginSec} s left` : "STALE"}`);
      console.log(`chain clock ${rec.chainNow} (head ${rec.headBlock} at ${rec.headTimestamp}, wall ${rec.wallClock}), sequencer answer ${rec.sequencer.answer}`);
      if (rec.problems.length) fail(rec.problems.join("; "));
    } else if (positionals[0] === "probe") {
      if (!v.fund || !v.queue || !/^\d+$/.test(v.usdc ?? "")) fail("probe needs --fund --queue --usdc", 2);
      const rec = await probeFeeds(rpc, ff, { fund: getAddress(v.fund!), queue: getAddress(v.queue!), usdc: BigInt(v.usdc!) });
      if (v.out) writeFileSync(v.out, JSON.stringify(rec, null, 2) + "\n");
      console.log(`fresh probe at block ${rec.fresh.block}: ${rec.fresh.result}; past the ETH / USD stale point (block ${rec.stale.block}, warped ${rec.stale.warpedSec} s): totalAssets ${rec.stale.totalAssets}, quoteDeposit ${rec.stale.quoteDeposit}`);
      if (rec.problems.length) fail(rec.problems.join("; "));
    } else fail("usage: twin-feeds.ts check --rpc URL [--min-margin S] [--out F] | probe --rpc URL --fund A --queue A --usdc N [--out F]", 2);
  } catch (e) { fail((e as Error).message); }
}
