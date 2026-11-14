// Deploy 4: the fund's real Chainlink feeds on the pinned Twin fork (src/ci/twin-feeds.ts). A fake anvil answers the JSON-RPC calls: a clock that moves only when a
// block is mined, feeds whose rounds never change (the pinned fork), and a fund and queue that refuse with the contracts' own errors once a feed is past its maximum age.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, parseAbi, toFunctionSelector, type Hex } from "viem";
import { checkFeeds, feedUnhealthyData, feedWindows, fundFeedsFromSource, loadFundFeeds, probeFeeds, settleBlockedFeedData, windowProblems, type RawRpc } from "../src/ci/twin-feeds.ts";
import { REPO_ROOT } from "./repo-root.ts";

const FF = loadFundFeeds(REPO_ROOT);
const [ETH, BTC, USDC] = FF.feeds.map((f) => f.address);
const FUND = "0x00000000000000000000000000000000000000f1", QUEUE = "0x00000000000000000000000000000000000000f2";
const ROUND = (answer: bigint, startedAt: number, updatedAt: number): Hex => encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [1n, answer, BigInt(startedAt), BigInt(updatedAt), 1n]);

/** A fake Twin fork: `ts` is the head's timestamp, which moves only on evm_mine (to `next`, the fork clock, or a set timestamp). */
function fakeFork(o: { chainId?: number; head: number; clock: number; updated: Record<string, number>; fundRefuses?: boolean; sequencerAnswer?: bigint }) {
  const st = { number: 100, ts: o.head, nextSet: undefined as number | undefined, calls: [] as string[] };
  const maxAge = Object.fromEntries(FF.feeds.map((f) => [f.address.toLowerCase(), f.maxAge]));
  const rpc: RawRpc = async (method, params = []) => {
    st.calls.push(method);
    if (method === "eth_chainId") return { result: `0x${(o.chainId ?? 918453).toString(16)}` };
    if (method === "eth_getBlockByNumber") return { result: { number: `0x${st.number.toString(16)}`, timestamp: `0x${st.ts.toString(16)}` } };
    if (method === "evm_mine") { st.number++; st.ts = st.nextSet ?? Math.max(st.ts + 1, o.clock); st.nextSet = undefined; return { result: "0x0" }; }
    if (method === "anvil_setNextBlockTimestamp") { st.nextSet = Number(params[0]); return { result: null }; }
    if (method === "eth_call") {
      const [{ to, data }] = params as [{ to: string; data: Hex }];
      const a = Object.keys(o.updated).find((k) => k.toLowerCase() === to.toLowerCase());
      if (a) return { result: ROUND(1n, 1, o.updated[a]!) };
      if (to.toLowerCase() === FF.sequencer.toLowerCase()) return { result: ROUND(o.sequencerAnswer ?? 0n, 1, 1) };
      // the fund and the queue at the head's timestamp: WETH (index 2) is checked first among the basket assets
      const stale = (a: string) => st.ts - o.updated[a]! > maxAge[a.toLowerCase()]!;
      const ok = { result: encodeAbiParameters([{ type: "uint256" }], [1_000_000n]) as Hex };
      if (o.fundRefuses === false) return ok;
      if (stale(ETH!)) {
        if (to === FUND) return { error: { message: "execution reverted", data: feedUnhealthyData(FF.ethIndex) } };
        decodeFunctionData({ abi: parseAbi(["function quoteDeposit(uint256)"]), data });
        return { error: { message: "execution reverted", data: settleBlockedFeedData(FF.ethIndex) } };
      }
      return stale(BTC!) ? { error: { message: "execution reverted", data: feedUnhealthyData(3) } } : ok;
    }
    return { error: { message: `unexpected ${method}` } };
  };
  return { rpc, st };
}

describe("the fund's feeds from the deploy scripts", () => {
  test("FundSystemBase.sol names the four feeds, the two maximum ages and the WETH index", () => {
    expect(FF.feeds.map((f) => [f.name, f.address.toLowerCase(), f.maxAge])).toEqual([
      ["ETH/USD", "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70", 1500],
      ["cbBTC/USD", "0x07da0e54543a844a80abe69c8a12f22b3aa59f9d", 86_700],
      ["USDC/USD", "0x7e860098f58bbfc8648a4311b374b1d669a2bc6b", 86_700],
    ]);
    expect(FF.sequencer.toLowerCase()).toBe("0xbcf85224fc0756b9fa45aa7892530b47e10b6433");
    expect(FF.ethIndex).toBe(2);
  });
  test("a source without a constant is refused, never defaulted", () => {
    const src = readFileSync(join(REPO_ROOT, "contracts/script/FundSystemBase.sol"), "utf8");
    expect(() => fundFeedsFromSource(src.replace(/ETH_FEED_MAX_AGE\s*=\s*[0-9_]+;/, ""))).toThrow("ETH_FEED_MAX_AGE");
  });
  test("the selectors are the contracts' errors", () => {
    expect(feedUnhealthyData(2).slice(0, 10)).toBe(toFunctionSelector("FeedUnhealthy(uint256,uint8)"));
    expect(settleBlockedFeedData(2).slice(0, 10)).toBe(toFunctionSelector("SettleBlocked(uint8,uint256,uint256)"));
  });
});

describe("feed windows on a pinned fork", () => {
  test("a feed is fresh up to updatedAt plus maxAge and stale one second later (FeedLib: now - updatedAt > maxAge)", () => {
    const w = feedWindows(FF.feeds, { [ETH!]: 1000, [BTC!]: 1000, [USDC!]: 1000 }, 2500);
    expect(w[0]).toMatchObject({ staleAt: 2500, marginSec: 0, fresh: true });
    expect(feedWindows(FF.feeds, { [ETH!]: 1000, [BTC!]: 1000, [USDC!]: 1000 }, 2501)[0]!.fresh).toBe(false);
    expect(w[1]).toMatchObject({ staleAt: 87_700, fresh: true });
  });
  test("a stale feed and a margin below the minimum are problems that say the fork must be restarted", () => {
    const w = feedWindows(FF.feeds, { [ETH!]: 1000, [BTC!]: 1000, [USDC!]: 1000 }, 2300);
    expect(windowProblems(w, 0)).toEqual([]);
    expect(windowProblems(w, 300).join()).toContain("ETH/USD goes stale in 200 s");
    expect(windowProblems(feedWindows(FF.feeds, { [ETH!]: 1000, [BTC!]: 1000, [USDC!]: 1000 }, 3000), 0).join()).toContain("start a new fork at a fresh pin");
  });
});

describe("check", () => {
  test("reads every feed at the head and takes the later of the head's time and the wall clock as the fork's clock", async () => {
    const { rpc } = fakeFork({ head: 10_000, clock: 10_000, updated: { [ETH!]: 9_000, [BTC!]: 9_000, [USDC!]: 9_000 } });
    const r = await checkFeeds(rpc, FF, 300, 10_100);
    expect(r.chainNow).toBe(10_100);
    expect(r.windows[0]!.marginSec).toBe(400);
    expect(r.problems).toEqual([]);
    expect((await checkFeeds(rpc, FF, 500, 10_100)).problems.join()).toContain("ETH/USD goes stale in 400 s");
  });
  test("a sequencer reported down is a problem", async () => {
    const { rpc } = fakeFork({ head: 10_000, clock: 10_000, updated: { [ETH!]: 9_900, [BTC!]: 9_900, [USDC!]: 9_900 }, sequencerAnswer: 1n });
    expect((await checkFeeds(rpc, FF, 0, 10_000)).problems.join()).toContain("sequencer");
  });
  test("refuses any chain but the Twin, Base included", async () => {
    const { rpc } = fakeFork({ chainId: 8453, head: 1, clock: 1, updated: {} });
    await expect(checkFeeds(rpc, FF, 0)).rejects.toThrow("not the Twin chain");
  });
});

describe("probe", () => {
  test("while the feeds are fresh totalAssets reads; the clock moves to one second past the ETH round's stale point, and both calls refuse with the named error", async () => {
    const { rpc, st } = fakeFork({ head: 10_000, clock: 10_010, updated: { [ETH!]: 9_500, [BTC!]: 9_500, [USDC!]: 9_500 } });
    const r = await probeFeeds(rpc, FF, { fund: FUND, queue: QUEUE, usdc: 1_000_000n });
    expect(r.problems).toEqual([]);
    expect(r.fresh).toMatchObject({ result: "ok", timestamp: 10_010, ethStaleAt: 11_000 });
    expect(r.stale).toMatchObject({ timestamp: 11_001, warpedSec: 991, totalAssets: feedUnhealthyData(2), quoteDeposit: settleBlockedFeedData(2) });
    expect(st.calls).toContain("anvil_setNextBlockTimestamp");
    expect(st.calls).not.toContain("anvil_setStorageAt");
    expect(st.calls).not.toContain("anvil_setCode");
  });
  test("on a fork already past the stale point nothing is warped and the fresh probe is recorded as skipped, naming the stale feed", async () => {
    const { rpc, st } = fakeFork({ head: 20_000, clock: 20_000, updated: { [ETH!]: 9_500, [BTC!]: 19_000, [USDC!]: 19_000 } });
    const r = await probeFeeds(rpc, FF, { fund: FUND, queue: QUEUE, usdc: 1_000_000n });
    expect(r.problems).toEqual([]);
    expect(r.fresh).toMatchObject({ result: "skipped-feed-stale", detail: "ETH/USD" });
    expect(r.stale.warpedSec).toBe(0);
    expect(st.calls).not.toContain("anvil_setNextBlockTimestamp");
  });
  test("a fund that still reads past the stale point is a problem: the refusal is required, not assumed", async () => {
    const { rpc } = fakeFork({ head: 10_000, clock: 10_000, updated: { [ETH!]: 9_500, [BTC!]: 9_500, [USDC!]: 9_500 }, fundRefuses: false });
    const r = await probeFeeds(rpc, FF, { fund: FUND, queue: QUEUE, usdc: 1_000_000n });
    expect(r.problems.join()).toContain("want FeedUnhealthy(2, Stale)");
    expect(r.problems.join()).toContain("want SettleBlocked(Feed, 2, Stale)");
  });
  test("refuses any chain but the Twin before it moves any clock", async () => {
    const { rpc, st } = fakeFork({ chainId: 8453, head: 1, clock: 1, updated: {} });
    await expect(probeFeeds(rpc, FF, { fund: FUND, queue: QUEUE, usdc: 1n })).rejects.toThrow("not the Twin chain");
    expect(st.calls).toEqual(["eth_chainId"]);
  });
});
