// Issue 1750 / 1723: the post-execute reads that a stale load-balanced RPC answers late are retried a BOUNDED number of times and still fail closed.
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from "viem";
import { NONCE_RETRY_TRIES, awaitSafeNonce } from "../src/safe/tx.ts";
import { awaitExecutionSuccess } from "../src/record-receipt.ts";

const TX = `0x${"11".repeat(32)}` as Hex;
const handleWith = (reads: number[]) => {
  let i = 0;
  const calls = { n: 0 };
  return { calls, handle: { chain: { rpcUrl: "https://secret-key.rpc.example.org/v2/abc123", chainId: 8453 }, nonce: async () => { calls.n++; return reads[Math.min(i++, reads.length - 1)]!; } } as never };
};
const noSleep = { sleep: async () => {} };

describe("awaitSafeNonce: a stale RPC read is retried, bounded, and fails closed", () => {
  test("stale then fresh passes", async () => {
    const { handle, calls } = handleWith([4, 4, 5]);
    expect(await awaitSafeNonce(handle, 5, TX, noSleep)).toBe(5);
    expect(calls.n).toBe(3);
  });
  test("a fresh first read passes with one read and no sleep", async () => {
    const { handle, calls } = handleWith([5]);
    let slept = 0;
    expect(await awaitSafeNonce(handle, 5, TX, { sleep: async () => { slept++; } })).toBe(5);
    expect([calls.n, slept]).toEqual([1, 0]);
  });
  test("always stale fails after the default 5 tries, names the RPC origin (not its path or key) and the transaction", async () => {
    const { handle, calls } = handleWith([4]);
    const e = await awaitSafeNonce(handle, 5, TX, noSleep).catch((x) => x);
    expect(e).toMatchObject({ code: "NONCE_DID_NOT_MOVE" });
    expect(calls.n).toBe(NONCE_RETRY_TRIES);
    expect(NONCE_RETRY_TRIES).toBe(5);
    expect(e.message).toContain("secret-key.rpc.example.org");
    expect(e.message).not.toContain("abc123");
    expect(e.message).toContain(TX);
  });
  test("the tries are configurable and the sleep is between tries only", async () => {
    const { handle, calls } = handleWith([4]);
    let slept = 0;
    await expect(awaitSafeNonce(handle, 5, TX, { tries: 3, delayMs: 7, sleep: async (ms) => { expect(ms).toBe(7); slept++; } })).rejects.toBeDefined();
    expect([calls.n, slept]).toEqual([3, 2]);
  });
  test("a nonce ABOVE the wanted one fails at once: another transaction moved the Safe", async () => {
    const { handle, calls } = handleWith([7]);
    await expect(awaitSafeNonce(handle, 5, TX, noSleep)).rejects.toMatchObject({ code: "NONCE_DID_NOT_MOVE" });
    expect(calls.n).toBe(1);
  });
});

describe("awaitExecutionSuccess", () => {
  const SAFE = "0x00000000000000000000000000000000005afe01" as Address;
  const HASH = `0x${"33".repeat(32)}` as Hex;
  const log = { address: SAFE, topics: [keccak256(toBytes("ExecutionSuccess(bytes32,uint256)")), HASH] as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [0n]) };
  test("logs in hand pass without a refetch", async () => {
    let f = 0;
    expect(await awaitExecutionSuccess(async () => { f++; return []; }, SAFE, HASH, [log], noSleep)).toBe(true);
    expect(f).toBe(0);
  });
  test("a stale receipt without logs, then a fresh one, passes", async () => {
    let f = 0;
    expect(await awaitExecutionSuccess(async () => (++f < 3 ? [] : [log]), SAFE, HASH, [], noSleep)).toBe(true);
    expect(f).toBe(3);
  });
  test("never present: false after 5 looks in total (1 in hand + 4 refetches); another Safe's or another hash's event does not count", async () => {
    let f = 0;
    expect(await awaitExecutionSuccess(async () => { f++; return [{ ...log, address: "0x00000000000000000000000000000000000000aa" as Address }, { ...log, topics: [log.topics[0]!, `0x${"44".repeat(32)}` as Hex] }]; }, SAFE, HASH, [], noSleep)).toBe(false);
    expect(f).toBe(4);
  });
  test("a refetch that throws is tried again", async () => {
    let f = 0;
    expect(await awaitExecutionSuccess(async () => { if (++f < 2) throw new Error("rpc"); return [log]; }, SAFE, HASH, [], noSleep)).toBe(true);
  });
});
