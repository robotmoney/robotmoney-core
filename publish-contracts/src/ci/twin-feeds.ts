#!/usr/bin/env bun
// The real Chainlink feeds of the fund system on the Twin fork (Deploy 4). The Twin chain (918453) is a PINNED lazy fork of Base (scripts/devnet/twin-fork.ts): every
// feed serves the round it held at the pin block for as long as the fork runs, while the fork's clock moves on (anvil stamps each new block with the pin's time plus
// the wall time since the fork started, and a warp adds to it). So a feed goes stale on the Twin at its pre-pin updatedAt plus its maxFeedAge, and never comes back:
// ETH / USD (maxFeedAge 1,500 s, a 1,200 s heartbeat) within 300 to 1,500 s of chain time after the pin, cbBTC / USD and USDC / USD (86,700 s, a 24 h heartbeat)
// within 300 to 86,700 s. check and probe only read (the probe moves the clock forward to show the refusal); refresh and keep are the Twin feed step, the one place
// that writes feed storage, on the Twin only (owner decision 2026-11-13, D4-9 of releases/v0.7.0-onevault.yaml; the design is in the block comment above refreshFeeds).
//   bun src/ci/twin-feeds.ts check --rpc URL [--min-margin S] [--out FILE]
//        reads every feed and the fork's clock; exit 1 when a feed is stale or goes stale within S seconds (the fund stage's addAsset and the queue's checks would refuse).
//   bun src/ci/twin-feeds.ts probe --rpc URL --fund ADDR --queue ADDR --usdc N [--out FILE]
//        on a published fund: while ETH / USD is fresh, totalAssets() reads; then the clock is moved past the ETH round's stale point (only forward, only when it is not
//        already past) and totalAssets() must revert FeedUnhealthy(ethIndex, Stale) and quoteDeposit(N) SettleBlocked(Feed, ethIndex, Stale). Exit 1 otherwise.
//   bun src/ci/twin-feeds.ts refresh --rpc URL --journal FILE [--advance-to T] [--out FILE]
//        the Twin feed step: (with --advance-to, the clock first moves forward to T) one new round per basket and peg feed that restates the answer the feed reported at
//        the pin, stamped at the fork's clock, written to the real aggregator's storage and read back through the real proxy; one JSON line per call to FILE.
//   bun src/ci/twin-feeds.ts keep --rpc URL --journal FILE --stop-file FILE [--every S] [--speed K]
//        the same refresh every S seconds of wall time (default 300) until FILE exists: the heartbeat for a row that waits on the wall clock; with --speed K
//        each beat first moves the clock K times the wall time since the last beat.
// Every verb refuses any chain but 918453; refresh and keep also refuse an RPC that is not an anvil fork. The feed addresses, the maximum ages and the WETH asset index
// are read from contracts/script/FundSystemBase.sol, the constants the deploy scripts use, so this file holds none of them.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { decodeAbiParameters, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The Twin feed step (owner, 2026-11-13: "we should in parallel start a subagent which builds the feed storage on the fork"). Twin chain 918453 only, never 8453.
// A pinned fork serves each feed's pin round forever while its clock moves on, so the fund's checks refuse once a round passes its maxFeedAge. `refresh` writes ONE
// new round per basket and peg feed, through the feed's own storage: the real EACAggregatorProxy keeps pointing at its real aggregator (no code is etched), the
// aggregator's s_transmissions[latest + 1] gets the answer the feed reported AT THE PIN (the very bits of the pin round's word), with its timestamps moved to the
// fork's clock, and s_hotVars.latestAggregatorRoundId moves to that round. The price never changes: the Twin's pools are frozen at the pin unless a row trades in
// them, so the pin answer keeps check 4 (each basket TWAP within refBandBps of its feed) where it was at the pin. The sequencer uptime feed is read, never written:
// its status (up) and its startedAt (when that status began) are what FeedLib.sequencerUp checks, and neither goes stale.
// Layouts: the aggregators at the pin (Base, read 2026-11-13): ETH / USD 0x05c8...7bB0 "DualAggregator 1.0.0", cbBTC / USD 0x51cE...e718 and USDC / USD 0x68bE...A5E2
// "AccessControlledOCR2Aggregator 1.0.0". Both pack HotVars as (uint8 f, uint40 latestEpochAndRound, uint32 latestAggregatorRoundId, ...): the round id is bits
// 48..79. Both store Transmission as (int192 answer, uint32 observationsTimestamp, uint32 transmissionTimestamp | recordedTimestamp) in one word, mapping key uint32.
// The ETH proxy is the DualAggregator's secondary proxy: it serves the newest round whose recordedTimestamp + s_cutoffTime < block.timestamp (_getSyncPrimaryRound),
// so the ETH round is stamped s_cutoffTime + 1 seconds before the fork's clock, as a real round is when that proxy first serves it. Before any write the layout is
// proved on the pin round itself (its word decodes to the proxy's answer and timestamps at the pin block); after the writes the proxy must read back exactly the new
// round, else every slot is put back and the step fails.

/** The storage layout of an aggregator type: the HotVars slot, the s_transmissions mapping slot, and (DualAggregator) the s_cutoffTime slot. */
export interface AggregatorLayout { hotVarsSlot: bigint; transmissionsSlot: bigint; cutoffSlot?: bigint }
export const AGGREGATOR_LAYOUTS: Record<string, AggregatorLayout> = {
  "AccessControlledOCR2Aggregator 1.0.0": { hotVarsSlot: 11n, transmissionsSlot: 12n },
  "DualAggregator 1.0.0": { hotVarsSlot: 13n, transmissionsSlot: 17n, cutoffSlot: 18n },
};
const U32 = (1n << 32n) - 1n;
const U192 = (1n << 192n) - 1n;
const ROUND_SHIFT = 48n;
const PHASE_SHIFT = 64n;

/** PURE. The storage slot of s_transmissions[round] (a mapping(uint32 => Transmission) at `mapSlot`). */
export const transmissionSlot = (round: number, mapSlot: bigint): Hex => keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(round), mapSlot]));
/** PURE. A Transmission word: the answer's raw 192 bits, observationsTimestamp, then the transmission (recorded) timestamp. */
export function decodeTransmission(word: bigint): { answerBits: bigint; answer: bigint; observedAt: number; recordedAt: number } {
  const answerBits = word & U192;
  return { answerBits, answer: answerBits >= 1n << 191n ? answerBits - (1n << 192n) : answerBits, observedAt: Number((word >> 192n) & U32), recordedAt: Number(word >> 224n) };
}
export const encodeTransmission = (answerBits: bigint, observedAt: number, recordedAt: number): bigint => (answerBits & U192) | (BigInt(observedAt) << 192n) | (BigInt(recordedAt) << 224n);
export const hotVarsRound = (word: bigint): number => Number((word >> ROUND_SHIFT) & U32);
export const withHotVarsRound = (word: bigint, round: number): bigint => (word & ~(U32 << ROUND_SHIFT)) | (BigInt(round) << ROUND_SHIFT);
const word32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;

export interface RoundData { roundId: bigint; answer: bigint; startedAt: number; updatedAt: number; answeredInRound: bigint }
export interface FeedWrite { slot: Hex; before: Hex; after: Hex }
export interface FeedRefresh {
  name: string; proxy: Address; aggregator: Address; type: string; phaseId: number; maxAge: number;
  pin: { block: number; aggregatorRound: number; answer: string; startedAt: number; updatedAt: number };
  before: { aggregatorRound: number; answer: string; updatedAt: number };
  after: { aggregatorRound: number; proxyRoundId: string; answer: string; startedAt: number; updatedAt: number };
  lagSec: number; writes: FeedWrite[];
}
export interface RefreshRecord {
  kind: "twin-feed-refresh"; chainId: number; pinBlock: number; at: string;
  advanced: { from: number; to: number } | null; head: { number: number; timestamp: number };
  feeds: FeedRefresh[]; sequencer: { address: Address; answer: number; startedAt: number; updatedAt: number; upForSec: number; written: false };
  windows: FeedWindow[]; problems: string[];
}

/**
 * PURE. The new round of one feed: the pin answer's bits, recorded `lag` seconds before the fork's clock `now` (0 for an OCR2 aggregator, s_cutoffTime + 1 for the
 * DualAggregator's secondary proxy), observed as long before that as the pin round was (its updatedAt minus its startedAt), as round `current + 1`. Refuses a
 * clock that is not after the current round's recorded time (a second refresh in the same second has nothing to restate).
 */
export function planRound(o: { pinWord: bigint; pinStartedAt: number; pinUpdatedAt: number; currentRound: number; currentRecordedAt: number; now: number; lag: number }): { round: number; word: bigint; startedAt: number; updatedAt: number } {
  const updatedAt = o.now - o.lag;
  if (updatedAt <= o.currentRecordedAt) throw new Error(`the fork clock ${o.now} (minus a ${o.lag} s lag) is not after the current round's recorded time ${o.currentRecordedAt}`);
  const startedAt = updatedAt - Math.max(0, o.pinUpdatedAt - o.pinStartedAt);
  const answerBits = decodeTransmission(o.pinWord).answerBits;
  return { round: o.currentRound + 1, word: encodeTransmission(answerBits, startedAt, updatedAt), startedAt, updatedAt };
}

const AGG_ABI = parseAbi([
  "function aggregator() view returns (address)", "function phaseId() view returns (uint16)", "function typeAndVersion() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
async function ok(rpc: RawRpc, method: string, params: unknown[]): Promise<unknown> {
  const r = await rpc(method, params);
  if (r.error) throw new Error(`${method}: ${r.error.message ?? "error"}`);
  return r.result;
}
async function read<T>(rpc: RawRpc, to: Address, fn: "aggregator" | "phaseId" | "typeAndVersion" | "latestRoundData", tag: string): Promise<T> {
  const data = encodeFunctionData({ abi: AGG_ABI, functionName: fn });
  const r = await rpc("eth_call", [{ to, data }, tag]);
  if (r.error) throw new Error(`${fn}() of ${to} at ${tag} reverted: ${r.error.message ?? "error"}`);
  return decodeFunctionResult({ abi: AGG_ABI, functionName: fn, data: r.result as Hex }) as T;
}
async function roundOf(rpc: RawRpc, to: Address, tag: string): Promise<RoundData> {
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = await read<readonly [bigint, bigint, bigint, bigint, bigint]>(rpc, to, "latestRoundData", tag);
  return { roundId, answer, startedAt: Number(startedAt), updatedAt: Number(updatedAt), answeredInRound };
}
const storageAt = async (rpc: RawRpc, a: Address, slot: Hex | bigint, tag: string): Promise<bigint> => BigInt(String(await ok(rpc, "eth_getStorageAt", [a, typeof slot === "bigint" ? word32(slot) : slot, tag])));

/** Twin only: chain 918453 AND an anvil fork (anvil_nodeInfo names the fork block, the pin). Base, any other chain and a plain node are refused before anything is read. */
export async function requireTwinFork(rpc: RawRpc): Promise<{ pinBlock: number }> {
  await requireTwinChain(rpc);
  const info = await rpc("anvil_nodeInfo");
  const pin = (info.result as { forkConfig?: { forkBlockNumber?: number } } | undefined)?.forkConfig?.forkBlockNumber;
  if (info.error || typeof pin !== "number" || pin <= 0) throw new Error("refusing: the Twin RPC is not an anvil fork of Base (anvil_nodeInfo names no fork block)");
  return { pinBlock: pin };
}

/**
 * One refresh of the fund's basket and peg feeds on the Twin (see the block comment above). `advanceTo`, when given and after the head, first moves the clock
 * there (forward only: anvil_setNextBlockTimestamp, evm_mine). Then one block is mined so the head carries the fork's clock, and each feed gets its new round.
 */
export async function refreshFeeds(rpc: RawRpc, ff: FundFeeds, o: { advanceTo?: number } = {}): Promise<RefreshRecord> {
  const { pinBlock } = await requireTwinFork(rpc);
  const pinTag = blockTag(pinBlock);
  let advanced: RefreshRecord["advanced"] = null;
  const h0 = await head(rpc);
  if (o.advanceTo !== undefined && o.advanceTo > h0.timestamp) {
    await ok(rpc, "anvil_setNextBlockTimestamp", [o.advanceTo]);
    await ok(rpc, "evm_mine", []);
    advanced = { from: h0.timestamp, to: o.advanceTo };
  } else await ok(rpc, "evm_mine", []);
  const h = await head(rpc);
  if (advanced && h.timestamp < advanced.to) throw new Error(`the clock move to ${advanced.to} left the head at ${h.timestamp}`);
  const tag = blockTag(h.number);
  const feeds: FeedRefresh[] = [];
  for (const f of ff.feeds) {
    const aggregator = getAddress(await read<Address>(rpc, f.address, "aggregator", tag));
    const pinAggregator = getAddress(await read<Address>(rpc, f.address, "aggregator", pinTag));
    if (aggregator !== pinAggregator) throw new Error(`${f.name}: the proxy points at ${aggregator}, at the pin it pointed at ${pinAggregator}; refusing to write a feed that is not the pin's`);
    const type = await read<string>(rpc, aggregator, "typeAndVersion", tag);
    const layout = AGGREGATOR_LAYOUTS[type];
    if (!layout) throw new Error(`${f.name}: aggregator ${aggregator} is '${type}', a type whose storage layout this tool does not know (${Object.keys(AGGREGATOR_LAYOUTS).join(", ")})`);
    const phaseId = Number(await read<number>(rpc, f.address, "phaseId", tag));
    // The pin round as the fund read it (through the proxy, at the pin block), and its storage word: the layout is proved on it before anything is written.
    const pin = await roundOf(rpc, f.address, pinTag);
    if (pin.roundId >> PHASE_SHIFT !== BigInt(phaseId)) throw new Error(`${f.name}: the pin round ${pin.roundId} is not of phase ${phaseId}`);
    const pinRound = Number(pin.roundId & ((1n << PHASE_SHIFT) - 1n));
    const pinWord = await storageAt(rpc, aggregator, transmissionSlot(pinRound, layout.transmissionsSlot), pinTag);
    const pw = decodeTransmission(pinWord);
    if (pw.answer !== pin.answer || pw.observedAt !== pin.startedAt || pw.recordedAt !== pin.updatedAt)
      throw new Error(`${f.name}: s_transmissions[${pinRound}] at the pin (slot ${layout.transmissionsSlot}) decodes to answer ${pw.answer} at ${pw.observedAt}/${pw.recordedAt}, the proxy read ${pin.answer} at ${pin.startedAt}/${pin.updatedAt}: the '${type}' layout does not hold, nothing is written`);
    const pinHot = await storageAt(rpc, aggregator, layout.hotVarsSlot, pinTag);
    if (hotVarsRound(pinHot) < pinRound) throw new Error(`${f.name}: s_hotVars (slot ${layout.hotVarsSlot}) at the pin names round ${hotVarsRound(pinHot)}, before the proxy's round ${pinRound}: the layout does not hold, nothing is written`);
    // The current state: every round after the pin restates the pin answer (written by this step), else something else wrote the feed and the step refuses.
    const hot = await storageAt(rpc, aggregator, layout.hotVarsSlot, tag);
    const current = hotVarsRound(hot);
    const curSlot = transmissionSlot(current, layout.transmissionsSlot);
    const cw = decodeTransmission(await storageAt(rpc, aggregator, curSlot, tag));
    if (current !== hotVarsRound(pinHot) && cw.answerBits !== pw.answerBits) throw new Error(`${f.name}: round ${current} answers ${cw.answer}, not the pin answer ${pin.answer}: the feed was written by something other than this step; refusing`);
    const lag = layout.cutoffSlot === undefined ? 0 : Number((await storageAt(rpc, aggregator, layout.cutoffSlot, tag)) & U32) + 1;
    const plan = planRound({ pinWord, pinStartedAt: pin.startedAt, pinUpdatedAt: pin.updatedAt, currentRound: current, currentRecordedAt: Math.max(cw.recordedAt, pin.updatedAt), now: h.timestamp, lag });
    const tSlot = transmissionSlot(plan.round, layout.transmissionsSlot);
    const writes: FeedWrite[] = [
      { slot: tSlot, before: word32(await storageAt(rpc, aggregator, tSlot, tag)), after: word32(plan.word) },
      { slot: word32(layout.hotVarsSlot), before: word32(hot), after: word32(withHotVarsRound(hot, plan.round)) },
    ];
    for (const w of writes) await ok(rpc, "anvil_setStorageAt", [aggregator, w.slot, w.after]);
    // Read back through the proxy, as the fund reads it: exactly the new round, or every slot goes back and the step fails.
    const back = await roundOf(rpc, f.address, "latest");
    const want = (BigInt(phaseId) << PHASE_SHIFT) | BigInt(plan.round);
    if (back.roundId !== want || back.answeredInRound !== want || back.answer !== pin.answer || back.startedAt !== plan.startedAt || back.updatedAt !== plan.updatedAt) {
      for (const w of [...writes].reverse()) await ok(rpc, "anvil_setStorageAt", [aggregator, w.slot, w.before]);
      throw new Error(`${f.name}: after the write the proxy reads round ${back.roundId} answer ${back.answer} at ${back.startedAt}/${back.updatedAt}, not round ${want} answer ${pin.answer} at ${plan.startedAt}/${plan.updatedAt}; the slots were put back`);
    }
    feeds.push({
      name: f.name, proxy: f.address, aggregator, type, phaseId, maxAge: f.maxAge,
      pin: { block: pinBlock, aggregatorRound: pinRound, answer: pin.answer.toString(), startedAt: pin.startedAt, updatedAt: pin.updatedAt },
      before: { aggregatorRound: current, answer: cw.answer.toString(), updatedAt: cw.recordedAt },
      after: { aggregatorRound: plan.round, proxyRoundId: want.toString(), answer: pin.answer.toString(), startedAt: plan.startedAt, updatedAt: plan.updatedAt },
      lagSec: lag, writes,
    });
  }
  const seq = await roundOf(rpc, ff.sequencer, tag);
  const sequencer = { address: ff.sequencer, answer: Number(seq.answer), startedAt: seq.startedAt, updatedAt: seq.updatedAt, upForSec: h.timestamp - seq.startedAt, written: false as const };
  const windows = feedWindows(ff.feeds, Object.fromEntries(feeds.map((x) => [x.proxy, x.after.updatedAt])), h.timestamp);
  const problems = windowProblems(windows, 0);
  if (sequencer.answer !== 0) problems.push(`the sequencer uptime feed reports down (answer ${sequencer.answer}) at the pin; it is never written`);
  return { kind: "twin-feed-refresh", chainId: TWIN_CHAIN_ID, pinBlock, at: new Date().toISOString(), advanced, head: h, feeds, sequencer, windows, problems };
}

/** PURE. The journal line of one refresh: one JSON object per line, appended, so the run directory holds every feed write the Twin ever saw. */
export const journalLine = (r: RefreshRecord): string => JSON.stringify(r) + "\n";

if (import.meta.main) {
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: {
    rpc: { type: "string" }, "min-margin": { type: "string", default: "0" }, out: { type: "string" }, fund: { type: "string" }, queue: { type: "string" }, usdc: { type: "string" },
    journal: { type: "string" }, "advance-to": { type: "string" }, every: { type: "string", default: "300" }, speed: { type: "string", default: "1" }, "stop-file": { type: "string" },
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
    } else if (positionals[0] === "refresh") {
      if (!v.journal) fail("refresh needs --journal FILE: every feed write is journaled", 2);
      const to = v["advance-to"];
      if (to !== undefined && !/^\d+$/.test(to)) fail("--advance-to is a unix time in seconds", 2);
      const rec = await refreshFeeds(rpc, ff, to === undefined ? {} : { advanceTo: Number(to) });
      appendFileSync(v.journal!, journalLine(rec));
      if (v.out) writeFileSync(v.out, JSON.stringify(rec, null, 2) + "\n");
      if (rec.advanced) console.log(`clock moved ${rec.advanced.from} -> ${rec.advanced.to} (${rec.advanced.to - rec.advanced.from} s)`);
      for (const x of rec.feeds) console.log(`${x.name.padEnd(10)} ${x.aggregator} ${x.type}: round ${x.before.aggregatorRound} -> ${x.after.aggregatorRound}, answer ${x.after.answer} (the pin's, block ${x.pin.block} round ${x.pin.aggregatorRound}), updatedAt ${x.after.updatedAt}`);
      console.log(`sequencer answer ${rec.sequencer.answer}, up for ${rec.sequencer.upForSec} s (not written); head ${rec.head.number} at ${rec.head.timestamp}`);
      if (rec.problems.length) fail(rec.problems.join("; "));
    } else if (positionals[0] === "keep") {
      // The Twin heartbeat for a row that waits on the wall clock (P6.76's step loop): one refresh every --every seconds of wall time, each journaled, until
      // --stop-file exists. With --speed K (default 1) each beat also moves the fork clock K times the wall time since the last beat (forward only, as refresh
      // --advance-to does), so a row that sleeps on the wall clock sees K times as much chain time: the Twin's compression of the plan's day and its overrun.
      // It only restates the pin answers, as refresh does.
      if (!v.journal || !v["stop-file"]) fail("keep needs --journal FILE and --stop-file FILE", 2);
      const every = Number(v.every), speed = Number(v.speed);
      if (!Number.isInteger(every) || every < 5 || every > 600) fail("--every is 5 to 600 seconds of wall time (ETH / USD's maxFeedAge is 1,500 s)", 2);
      if (!Number.isInteger(speed) || speed < 1 || speed > 1000) fail("--speed is a whole factor from 1 to 1000", 2);
      await requireTwinFork(rpc);
      let lastWall = 0, lastChain = 0;
      while (!existsSync(v["stop-file"]!)) {
        const wall = Math.floor(Date.now() / 1000);
        if (!lastWall || wall - lastWall >= every) {
          const h = await head(rpc);
          const advanceTo = speed > 1 && lastWall ? Math.max(h.timestamp, lastChain + speed * (wall - lastWall)) : undefined;
          const rec = await refreshFeeds(rpc, ff, advanceTo === undefined ? {} : { advanceTo });
          appendFileSync(v.journal!, journalLine(rec));
          if (rec.problems.length) fail(rec.problems.join("; "));
          lastWall = wall; lastChain = rec.head.timestamp;
          console.log(`refresh at ${rec.head.timestamp}${rec.advanced ? ` (clock +${rec.advanced.to - rec.advanced.from} s)` : ""}: ${rec.feeds.map((x) => `${x.name} round ${x.after.aggregatorRound}`).join(", ")}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.log("keep: stop file found, the heartbeat ends");
    } else fail("usage: twin-feeds.ts check --rpc URL [--min-margin S] [--out F] | probe --rpc URL --fund A --queue A --usdc N [--out F] | refresh --rpc URL --journal F [--advance-to T] [--out F] | keep --rpc URL --journal F --stop-file F [--every S] [--speed K]", 2);
  } catch (e) { fail((e as Error).message); }
}
