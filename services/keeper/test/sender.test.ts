// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.2. Receipt status 0 raises <duty>_reverted with the
// hash, gas used, limit and decoded reason; no receipt in time triggers a same-nonce replacement with fees bumped
// 12.5 %, then tx_stuck; fees above maxFeeGwei skip with gas_price_high.
import { describe, expect, test } from "bun:test";
import { encodeErrorResult, type Hex } from "viem";
import { errorsAbi } from "../src/abi.ts";
import { Alerts, setLogWriter } from "../src/alerts.ts";
import { Metrics } from "../src/health.ts";
import { bump, Sender, type ChainIO, type ReceiptLike, type TxRequest } from "../src/sender.ts";

setLogWriter(() => {});
const TO = "0x1111111111111111111111111111111111111111";
const FROM = "0x2222222222222222222222222222222222222222";
const OOG = encodeErrorResult({ abi: errorsAbi, errorName: "SettleSideOutOfGas", args: [1] });
const revert = (data: Hex) => Object.assign(new Error("execution reverted"), { cause: { data } });

function fakeIO(over: Partial<ChainIO> & { mined?: (tx: TxRequest, i: number) => ReceiptLike | null } = {}) {
  const sent: TxRequest[] = [];
  const calls: any[] = [];
  const io: ChainIO = {
    chainId: async () => 8453,
    call: async (a) => { calls.push(a); return "0x"; },
    estimateGas: async () => 100_000n,
    blockGasLimit: async () => 30_000_000n,
    fees: async () => ({ baseFee: 1_000_000_000n, priorityFee: 100_000_000n }),
    pendingNonce: async () => 7,
    sendTx: async (tx) => { sent.push(tx); return `0x${String(sent.length).padStart(64, "0")}` as Hex; },
    receipt: async (h) => {
      const i = Number(BigInt(h)) - 1;
      const r = over.mined ? over.mined(sent[i]!, i) : null;
      return r ? { ...r, transactionHash: h } : null;
    },
    balance: async () => 10n ** 18n,
    blockTimestamp: async () => 1n,
    ...over,
  };
  return { io, sent, calls };
}

function sender(io: ChainIO, opts: Partial<ConstructorParameters<typeof Sender>[0]> = {}) {
  const lines: any[] = [];
  const alerts = new Alerts({ realertSecs: 3600, write: (l) => lines.push(JSON.parse(l)) });
  const metrics = new Metrics();
  const s = new Sender({ io, from: FROM, alerts, metrics, gasMultiplier: 1.5, maxFeeGwei: 10, receiptTimeoutSecs: 0.2, maxReplacements: 2, pollMs: 20, ...opts });
  return { s, lines, metrics };
}

const ok = (gasUsed = 90_000n): ReceiptLike => ({ transactionHash: "0x", status: "success", blockNumber: 100n, gasUsed, effectiveGasPrice: 1_100_000_000n, l1Fee: 5n });

describe("sender", () => {
  test("a mined success is recorded with gas, price, L1 fee and total fee", async () => {
    const { io, sent } = fakeIO({ mined: () => ok() });
    const { s, lines, metrics } = sender(io);
    const r = await s.send("step", "step", TO, "0x01");
    expect(r.status).toBe("mined");
    expect(sent[0]).toMatchObject({ gas: 150_000n, nonce: 7, maxPriorityFeePerGas: 100_000_000n, maxFeePerGas: 2_100_000_000n });
    expect(lines).toEqual([]);
    expect(metrics.sends.step).toBe(1);
    expect(metrics.feesWei.step).toBe(90_000n * 1_100_000_000n + 5n);
    expect(s.currentNonce).toBe(8);
  });

  test("receipt status 0 raises <duty>_reverted with hash, gas used, limit and the reason decoded by replay", async () => {
    let replay: any;
    const { io } = fakeIO({
      mined: () => ({ ...ok(2_299_380n), status: "reverted" }),
      call: async (a) => { if (a.blockNumber !== undefined) { replay = a; throw revert(OOG); } return "0x"; },
    });
    const { s, lines, metrics } = sender(io);
    const r = await s.send("settle", "settle", TO, "0x02", { floor: 8_000_000n });
    expect(r.status).toBe("reverted");
    if (r.status === "reverted") expect(r.reason.name).toBe("SettleSideOutOfGas");
    expect(replay).toMatchObject({ blockNumber: 99n, gas: 8_000_000n }); // the block before, with the same limit
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      alert: "settle_reverted", cause: "settle", hash: `0x${"1".padStart(64, "0")}`, gasUsed: "2299380", gasLimit: "8000000",
      reason: "SettleSideOutOfGas(1)",
    });
    expect(metrics.reverts.settle).toBe(1);
    expect(metrics.sends.settle).toBeUndefined();
  });

  test("a KeeperAccount CallFailed wrapper is unwrapped to the inner reason", async () => {
    const wrapped = encodeErrorResult({ abi: errorsAbi, errorName: "CallFailed", args: [OOG] });
    const { io } = fakeIO({
      mined: () => ({ ...ok(), status: "reverted" }),
      call: async (a) => { if (a.blockNumber !== undefined) throw revert(wrapped); return "0x"; },
    });
    const { s, lines } = sender(io);
    const r = await s.send("settle", "settle", TO, "0x02");
    if (r.status !== "reverted") throw new Error(r.status);
    expect(r.reason.name).toBe("SettleSideOutOfGas");
    expect(lines[0].reason).toBe("CallFailed(SettleSideOutOfGas(1))");
  });

  test("a simulated revert sends nothing and alerts", async () => {
    const { io, sent } = fakeIO({ call: async () => { throw revert(OOG); } });
    const { s, lines } = sender(io);
    const r = await s.send("step", "step", TO, "0x03");
    expect(r.status).toBe("simulation_reverted");
    expect(sent.length).toBe(0);
    expect(lines[0]).toMatchObject({ alert: "step_reverted", stage: "simulate" });
  });

  test("no receipt in time: same-nonce replacements with fees bumped 12.5 %, then tx_stuck", async () => {
    const { io, sent } = fakeIO({ mined: () => null });
    const { s, lines } = sender(io, { maxFeeGwei: 100 });
    const r = await s.send("settle", "settle", TO, "0x04");
    expect(r.status).toBe("stuck");
    expect(sent.length).toBe(3); // the send plus maxReplacements = 2
    expect(new Set(sent.map((t) => t.nonce))).toEqual(new Set([7]));
    expect(sent[1]!.maxFeePerGas).toBe(bump(sent[0]!.maxFeePerGas));
    expect(sent[1]!.maxPriorityFeePerGas).toBe(bump(sent[0]!.maxPriorityFeePerGas));
    expect(sent[2]!.maxFeePerGas).toBe(bump(sent[1]!.maxFeePerGas));
    expect(sent[1]!.maxFeePerGas * 1000n / sent[0]!.maxFeePerGas).toBe(1125n);
    expect(lines.map((l) => l.alert)).toEqual(["tx_stuck"]);
    expect(lines[0].hashes.length).toBe(3);
    expect(s.currentNonce).toBeUndefined(); // re-read from the chain on the next send
  });

  test("a replacement that mines ends the wait", async () => {
    const { io, sent } = fakeIO({ mined: (_tx, i) => (i === 1 ? ok() : null) });
    const { s, lines } = sender(io, { maxFeeGwei: 100 });
    const r = await s.send("step", "step", TO, "0x05");
    expect(r.status).toBe("mined");
    expect(sent.length).toBe(2);
    expect(lines).toEqual([]);
  });

  test("fees above maxFeeGwei skip the duty with gas_price_high and send nothing", async () => {
    const { io, sent } = fakeIO({ fees: async () => ({ baseFee: 20_000_000_000n, priorityFee: 1n }), mined: () => ok() });
    const { s, lines } = sender(io, { maxFeeGwei: 10 });
    const r = await s.send("settle", "settle", TO, "0x06");
    expect(r).toEqual({ status: "skipped", why: "gas_price_high" });
    expect(sent.length).toBe(0);
    expect(lines[0]).toMatchObject({ alert: "gas_price_high" });
  });

  test("maxFeePerGas is capped at maxFeeGwei", async () => {
    const { io, sent } = fakeIO({ fees: async () => ({ baseFee: 6_000_000_000n, priorityFee: 0n }), mined: () => ok() });
    const { s } = sender(io, { maxFeeGwei: 10 });
    await s.send("step", "step", TO, "0x07");
    expect(sent[0]!.maxFeePerGas).toBe(10_000_000_000n);
  });

  test("a failed send alerts send_failed and re-reads the nonce next time", async () => {
    let n = 0;
    const { io } = fakeIO({ sendTx: async () => { n++; throw new Error("nonce too low"); }, pendingNonce: async () => 7 + n });
    const { s, lines } = sender(io);
    const r = await s.send("step", "step", TO, "0x08");
    expect(r.status).toBe("failed");
    expect(lines[0]).toMatchObject({ alert: "send_failed" });
    expect(s.currentNonce).toBeUndefined();
  });

  test("the nonce is held in memory across sends", async () => {
    let reads = 0;
    const { io, sent } = fakeIO({ mined: () => ok(), pendingNonce: async () => { reads++; return 7; } });
    const { s } = sender(io);
    await s.send("step", "step", TO, "0x09");
    await s.send("step", "step", TO, "0x0a");
    expect(sent.map((t) => t.nonce)).toEqual([7, 8]);
    expect(reads).toBe(1);
  });
});
