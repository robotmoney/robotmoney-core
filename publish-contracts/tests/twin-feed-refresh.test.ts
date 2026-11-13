// Deploy 4: the Twin feed step (src/ci/twin-feeds.ts refresh). A fake anvil fork models the real feeds at the pin: EACAggregatorProxy -> aggregator, the aggregator's
// HotVars and s_transmissions words in storage (the real slots: OCR2 11 / 12, DualAggregator 13 / 17 with s_cutoffTime at 18), the DualAggregator's secondary-proxy
// rule (serve the newest round recorded more than s_cutoffTime ago), and storage read at the pin block or at the head. The proxy answers only from that storage, so a
// write lands where the fund reads it or the read-back fails.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, getAddress, parseAbi, type Address, type Hex } from "viem";
import {
  AGGREGATOR_LAYOUTS, decodeTransmission, encodeTransmission, hotVarsRound, journalLine, loadFundFeeds, planRound, refreshFeeds, transmissionSlot, withHotVarsRound, type RawRpc,
} from "../src/ci/twin-feeds.ts";
import { REPO_ROOT } from "./repo-root.ts";

const FF = loadFundFeeds(REPO_ROOT);
const [ETH, BTC, USDC] = FF.feeds.map((f) => f.address) as [Address, Address, Address];
const AGG = { eth: getAddress("0x05c84a58FE042275b37db038bAAcD15F410c7bB0"), btc: getAddress("0x51cE3091Cf646587E02Cad83b580992f8723e718"), usdc: getAddress("0x68bE4C50235205Ede361ac8244B1ee221CDDA5E2") };
const PIN = 56_730_718, PIN_TS = 1_794_536_519;
const ABI = parseAbi(["function aggregator() view returns (address)", "function phaseId() view returns (uint16)", "function typeAndVersion() view returns (string)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"]);
const hex = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;
const roundData = (id: bigint, answer: bigint, s: number, u: number): Hex => encodeAbiParameters([{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }], [id, answer, BigInt(s), BigInt(u), id]);

interface Feed { proxy: Address; agg: Address; type: string; phase: number }
const FEEDS: Feed[] = [
  { proxy: ETH, agg: AGG.eth, type: "DualAggregator 1.0.0", phase: 3 },
  { proxy: BTC, agg: AGG.btc, type: "AccessControlledOCR2Aggregator 1.0.0", phase: 2 },
  { proxy: USDC, agg: AGG.usdc, type: "AccessControlledOCR2Aggregator 1.0.0", phase: 3 },
];
const PIN_ROUND: Record<string, { round: number; answer: bigint; s: number; u: number }> = {
  [AGG.eth]: { round: 13_525, answer: 200_173_965_689n, s: PIN_TS - 120, u: PIN_TS - 107 },
  [AGG.btc]: { round: 19_576, answer: 7_061_011_901_103n, s: PIN_TS - 459, u: PIN_TS - 446 },
  [AGG.usdc]: { round: 85, answer: 99_973_272n, s: PIN_TS - 48_222, u: PIN_TS - 48_209 },
};

/** The fake fork. `pinStorage` is the state at the pin block (frozen), `storage` the head's. The clock moves only on evm_mine. */
function fakeFork(o: { chainId?: number; nodeInfo?: boolean; brokenLayout?: string; foreignWrite?: string; proxyIgnoresWrites?: boolean } = {}) {
  const pinStorage = new Map<string, bigint>();
  const key = (a: string, slot: Hex | string) => `${a.toLowerCase()}:${BigInt(slot)}`;
  for (const f of FEEDS) {
    const l = AGGREGATOR_LAYOUTS[f.type]!, p = PIN_ROUND[f.agg]!;
    pinStorage.set(key(f.agg, transmissionSlot(p.round, l.transmissionsSlot)), encodeTransmission(p.answer & ((1n << 192n) - 1n), p.s, p.u));
    pinStorage.set(key(f.agg, hex(l.hotVarsSlot)), withHotVarsRound(0x81e00603n | (13_443n << 80n), p.round));
    if (l.cutoffSlot !== undefined) pinStorage.set(key(f.agg, hex(l.cutoffSlot)), 30n);
  }
  if (o.brokenLayout) pinStorage.set(key(o.brokenLayout, transmissionSlot(PIN_ROUND[o.brokenLayout]!.round, AGGREGATOR_LAYOUTS[FEEDS.find((f) => f.agg === o.brokenLayout)!.type]!.transmissionsSlot)), 0n);
  const storage = new Map(pinStorage);
  const st = { number: PIN, ts: PIN_TS, nextSet: undefined as number | undefined, calls: [] as string[], writes: [] as [string, string, string][] };
  if (o.foreignWrite) {
    const f = FEEDS.find((x) => x.agg === o.foreignWrite)!, l = AGGREGATOR_LAYOUTS[f.type]!, p = PIN_ROUND[f.agg]!;
    storage.set(key(f.agg, transmissionSlot(p.round + 1, l.transmissionsSlot)), encodeTransmission(p.answer * 2n, PIN_TS, PIN_TS));
    storage.set(key(f.agg, hex(l.hotVarsSlot)), withHotVarsRound(storage.get(key(f.agg, hex(l.hotVarsSlot)))!, p.round + 1));
  }
  const view = (tag: string) => (tag === `0x${PIN.toString(16)}` ? { s: pinStorage, ts: PIN_TS } : { s: storage, ts: st.ts });
  /** The aggregator's latestRoundData as its proxy sees it: OCR2 the HotVars round; the DualAggregator's secondary proxy the newest round recorded over s_cutoffTime ago. */
  const latest = (f: Feed, s: Map<string, bigint>, ts: number) => {
    const l = AGGREGATOR_LAYOUTS[f.type]!;
    let r = hotVarsRound(s.get(key(f.agg, hex(l.hotVarsSlot)))!);
    const word = (n: number) => s.get(key(f.agg, transmissionSlot(n, l.transmissionsSlot))) ?? 0n;
    if (l.cutoffSlot !== undefined && !o.proxyIgnoresWrites) { const cut = Number(s.get(key(f.agg, hex(l.cutoffSlot)))!); while (r > 0 && decodeTransmission(word(r)).recordedAt + cut >= ts) r--; }
    if (o.proxyIgnoresWrites) r = PIN_ROUND[f.agg]!.round;
    // A layout the tool gets wrong: the real proxy still answers the real pin round, the slot the tool reads holds something else.
    if (o.brokenLayout === f.agg) { const p = PIN_ROUND[f.agg]!; return roundData((BigInt(f.phase) << 64n) | BigInt(p.round), p.answer, p.s, p.u); }
    const t = decodeTransmission(word(r));
    return roundData((BigInt(f.phase) << 64n) | BigInt(r), t.answer, t.observedAt, t.recordedAt);
  };
  const rpc: RawRpc = async (method, params = []) => {
    st.calls.push(method);
    if (method === "eth_chainId") return { result: `0x${(o.chainId ?? 918453).toString(16)}` };
    if (method === "anvil_nodeInfo") return o.nodeInfo === false ? { error: { message: "method not found" } } : { result: { forkConfig: { forkBlockNumber: PIN } } };
    if (method === "eth_getBlockByNumber") return { result: { number: `0x${st.number.toString(16)}`, timestamp: `0x${st.ts.toString(16)}` } };
    if (method === "evm_mine") { st.number++; st.ts = st.nextSet ?? st.ts + 12; st.nextSet = undefined; return { result: "0x0" }; }
    if (method === "anvil_setNextBlockTimestamp") { st.nextSet = Number(params[0]); return { result: null }; }
    if (method === "eth_getStorageAt") { const [a, slot, tag] = params as [string, Hex, string]; return { result: hex(view(tag).s.get(key(a, slot)) ?? 0n) }; }
    if (method === "anvil_setStorageAt") { const [a, slot, v] = params as [string, Hex, Hex]; st.writes.push([a.toLowerCase(), slot, v]); storage.set(key(a, slot), BigInt(v)); return { result: true }; }
    if (method === "eth_call") {
      const [{ to, data }, tag] = params as [{ to: string; data: Hex }, string];
      const { s, ts } = view(tag);
      const fn = decodeFunctionData({ abi: ABI, data }).functionName;
      const byProxy = FEEDS.find((f) => f.proxy.toLowerCase() === to.toLowerCase()), byAgg = FEEDS.find((f) => f.agg.toLowerCase() === to.toLowerCase());
      if (byProxy && fn === "aggregator") return { result: encodeAbiParameters([{ type: "address" }], [byProxy.agg]) };
      if (byProxy && fn === "phaseId") return { result: encodeAbiParameters([{ type: "uint16" }], [byProxy.phase]) };
      if (byProxy && fn === "latestRoundData") return { result: latest(byProxy, s, ts) };
      if (byAgg && fn === "typeAndVersion") return { result: encodeAbiParameters([{ type: "string" }], [byAgg.type]) };
      if (to.toLowerCase() === FF.sequencer.toLowerCase()) return { result: roundData(18_446_744_073_709_551_636n, 0n, 1_782_491_507, 1_794_504_399) };
      return { error: { message: `unexpected call ${fn} to ${to}` } };
    }
    return { error: { message: `unexpected ${method}` } };
  };
  return { rpc, st, storage, key };
}

describe("the storage words", () => {
  test("a Transmission word is answer (192 bits), observationsTimestamp, transmission timestamp: the ETH round read on Base at the pin", () => {
    const t = decodeTransmission(BigInt("0x6af673dc6af673cf000000000000000000000000000000000000002e9b4c5179"));
    expect(t).toMatchObject({ answer: 200_173_965_689n, observedAt: 1_794_536_399, recordedAt: 1_794_536_412 });
    expect(encodeTransmission(t.answerBits, t.observedAt, t.recordedAt)).toBe(BigInt("0x6af673dc6af673cf000000000000000000000000000000000000002e9b4c5179"));
    expect(decodeTransmission(encodeTransmission((1n << 192n) - 5n, 1, 2)).answer).toBe(-5n);
  });
  test("HotVars holds latestAggregatorRoundId at bits 48 to 79, the rest is kept: the ETH aggregator's slot 13 on Base", () => {
    const w = BigInt("0x00000000000000000000000000000000000000003483000034d5000081e00603");
    expect(hotVarsRound(w)).toBe(13_525);
    const n = withHotVarsRound(w, 13_526);
    expect(hotVarsRound(n)).toBe(13_526);
    expect(n ^ w).toBe((13_526n ^ 13_525n) << 48n);
  });
  test("a new round restates the pin answer, keeps the pin round's observation gap, and lags the clock by the proxy's cutoff", () => {
    const pinWord = encodeTransmission(200_173_965_689n, 1000, 1013);
    const p = planRound({ pinWord, pinStartedAt: 1000, pinUpdatedAt: 1013, currentRound: 7, currentRecordedAt: 1013, now: 5000, lag: 31 });
    expect(p).toMatchObject({ round: 8, startedAt: 4956, updatedAt: 4969 });
    expect(decodeTransmission(p.word).answer).toBe(200_173_965_689n);
    expect(() => planRound({ pinWord, pinStartedAt: 1000, pinUpdatedAt: 1013, currentRound: 8, currentRecordedAt: 4969, now: 4990, lag: 31 })).toThrow("not after the current round");
  });
});

describe("refresh", () => {
  test("each basket and peg feed gets round latest + 1 with the pin answer at the fork's clock; the proxy serves it; only the two aggregator slots are written", async () => {
    const { rpc, st } = fakeFork();
    st.ts = PIN_TS + 4000; // the fork's clock has moved on: ETH / USD (1,500 s) is stale
    const r = await refreshFeeds(rpc, FF);
    expect(r.problems).toEqual([]);
    expect(r.pinBlock).toBe(PIN);
    expect(r.windows.every((w) => w.fresh)).toBe(true);
    const eth = r.feeds[0]!;
    expect(eth).toMatchObject({ name: "ETH/USD", aggregator: AGG.eth, lagSec: 31, before: { aggregatorRound: 13_525 }, after: { aggregatorRound: 13_526, answer: "200173965689", updatedAt: r.head.timestamp - 31 } });
    expect(eth.after.updatedAt - eth.after.startedAt).toBe(13);
    expect(r.feeds[1]).toMatchObject({ name: "cbBTC/USD", lagSec: 0, after: { aggregatorRound: 19_577, answer: "7061011901103", updatedAt: r.head.timestamp } });
    expect(r.feeds[2]).toMatchObject({ name: "USDC/USD", after: { aggregatorRound: 86, answer: "99973272" } });
    expect(r.sequencer).toMatchObject({ answer: 0, written: false });
    // two slots per aggregator, nothing else: no proxy, no sequencer, no pool, token, fund or queue slot, no code
    expect(new Set(st.writes.map((w) => w[0]))).toEqual(new Set([AGG.eth, AGG.btc, AGG.usdc].map((a) => a.toLowerCase())));
    expect(st.writes.length).toBe(6);
    expect(st.calls).not.toContain("anvil_setCode");
    expect(JSON.parse(journalLine(r))).toMatchObject({ kind: "twin-feed-refresh", pinBlock: PIN });
  });
  test("a second refresh writes the next round with the same pin answer; --advance-to moves the clock forward first", async () => {
    const { rpc, st } = fakeFork();
    await refreshFeeds(rpc, FF);
    const r = await refreshFeeds(rpc, FF, { advanceTo: PIN_TS + 86_400 });
    expect(r.advanced).toMatchObject({ to: PIN_TS + 86_400 });
    expect(r.head.timestamp).toBe(PIN_TS + 86_400);
    expect(r.feeds.map((f) => [f.before.aggregatorRound, f.after.aggregatorRound, f.after.answer])).toEqual([[13_526, 13_527, "200173965689"], [19_577, 19_578, "7061011901103"], [86, 87, "99973272"]]);
    expect(st.calls).toContain("anvil_setNextBlockTimestamp");
  });
  test("--advance-to never moves the clock back", async () => {
    const { rpc, st } = fakeFork();
    st.ts = PIN_TS + 5000;
    const r = await refreshFeeds(rpc, FF, { advanceTo: PIN_TS + 100 });
    expect(r.advanced).toBeNull();
    expect(st.calls).not.toContain("anvil_setNextBlockTimestamp");
  });
  test("refuses Base, any chain but the Twin, and a Twin RPC that is not an anvil fork, before any read or write", async () => {
    for (const o of [{ chainId: 8453 }, { chainId: 1 }]) {
      const { rpc, st } = fakeFork(o);
      await expect(refreshFeeds(rpc, FF)).rejects.toThrow("not the Twin chain");
      expect(st.calls).toEqual(["eth_chainId"]);
    }
    const { rpc, st } = fakeFork({ nodeInfo: false });
    await expect(refreshFeeds(rpc, FF)).rejects.toThrow("not an anvil fork");
    expect(st.writes).toEqual([]);
  });
  test("a layout that does not decode the pin round to the proxy's own answer writes nothing", async () => {
    const { rpc, st } = fakeFork({ brokenLayout: AGG.btc });
    await expect(refreshFeeds(rpc, FF)).rejects.toThrow("layout does not hold");
    expect(st.writes.filter((w) => w[0] === AGG.btc.toLowerCase())).toEqual([]);
  });
  test("a feed someone else wrote (a round after the pin with another answer) is refused: the step only ever restates the pin answer", async () => {
    const { rpc } = fakeFork({ foreignWrite: AGG.usdc });
    await expect(refreshFeeds(rpc, FF)).rejects.toThrow("written by something other than this step");
  });
  test("a write the proxy does not serve back is put back and fails the step", async () => {
    const { rpc, storage, key } = fakeFork({ proxyIgnoresWrites: true });
    const before = new Map(storage);
    await expect(refreshFeeds(rpc, FF)).rejects.toThrow("the slots were put back");
    const l = AGGREGATOR_LAYOUTS["DualAggregator 1.0.0"]!;
    expect(storage.get(key(AGG.eth, hex(l.hotVarsSlot)))).toBe(before.get(key(AGG.eth, hex(l.hotVarsSlot))));
    expect(storage.get(key(AGG.eth, transmissionSlot(13_526, l.transmissionsSlot))) ?? 0n).toBe(0n);
  });
});
