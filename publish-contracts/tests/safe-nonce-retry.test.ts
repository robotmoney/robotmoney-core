// Issue 1750 / 1723: the post-execute reads that a stale load-balanced RPC answers late are retried a BOUNDED number of times and still fail closed.
// QA plan v1 E6: the shared primitive (safe/read-after-write.ts) and the Safe creation's reads (awaitCreatedSafe) on a fake RPC that is stale for the first K reads.
// The runner sites have their own tests: the prove-control entry and the stage 11 gate in prove-control.test.ts, the redeploy verb in redeploy-vault.test.ts.
import { describe, expect, test } from "bun:test";
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from "viem";
import { NONCE_RETRY_TRIES, awaitSafeNonce } from "../src/safe/tx.ts";
import { awaitExecutionSuccess } from "../src/record-receipt.ts";
import { READ_RETRY_TRIES, SAFE_141, SafeToolError, awaitCreatedSafe, awaitRead, readUntil, type SafeHandle } from "../src/safe/index.ts";

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

// ---- QA plan v1 E6: the shared read-after-write primitive -------------------------------------------------------------------------------

/** A read that answers `values` in order (the last one forever). An Error in the list is thrown by that read. */
const reader = <T,>(values: (T | Error)[]) => {
  const n = { reads: 0 };
  return { n, read: async (): Promise<T> => { const v = values[Math.min(n.reads++, values.length - 1)]!; if (v instanceof Error) throw v; return v; } };
};

describe("awaitRead / readUntil: read again, bounded, until the expected state shows", () => {
  test("stale twice, then expected: ok on the third read, two sleeps between reads and none after", async () => {
    const r = reader([4, 4, 5]);
    let slept = 0;
    const out = await awaitRead(r.read, (v) => v === 5, { sleep: async () => { slept++; } });
    expect(out).toMatchObject({ ok: true, last: 5, seen: [4, 4, 5], reads: 3 });
    expect(slept).toBe(2);
  });
  test("never expected: not ok after READ_RETRY_TRIES reads (5), the last value kept for the caller's own refusal", async () => {
    const r = reader([4]);
    const out = await awaitRead(r.read, (v) => v === 5, noSleep);
    expect(READ_RETRY_TRIES).toBe(5);
    expect(out).toMatchObject({ ok: false, last: 4, reads: 5 });
    expect(r.n.reads).toBe(5);
  });
  test("a value past the expected state stops at once: no stale node can show it", async () => {
    const r = reader([7]);
    expect(await awaitRead(r.read, (v) => v === 5, noSleep, (v) => v > 5)).toMatchObject({ ok: false, last: 7, reads: 1 });
  });
  test("a read that throws (a node without the contract reverts) is read again; one that never answers keeps the last error", async () => {
    const ok = reader<number>([new Error("returned no data"), 5]);
    expect(await awaitRead(ok.read, (v) => v === 5, noSleep)).toMatchObject({ ok: true, last: 5, reads: 2 });
    const never = reader<number>([new Error("returned no data")]);
    const out = await awaitRead(never.read, (v) => v === 5, { tries: 3, sleep: async () => {} });
    expect(out.ok).toBe(false);
    expect(out.seen).toEqual([]);
    expect((out.error as Error).message).toBe("returned no data");
  });
  test("readUntil: the first expected value, else the last value read; the last read's error is thrown, never an older value", async () => {
    expect(await readUntil(reader([0, 0, 1]).read, (v) => v !== 0, noSleep)).toBe(1);
    expect(await readUntil(reader([0]).read, (v) => v !== 0, noSleep)).toBe(0);
    await expect(readUntil(reader<number>([0, new Error("rpc down")]).read, (v) => v !== 0, noSleep)).rejects.toThrow("rpc down");
  });
});

// ---- QA plan v1 E6: the reads after a landed Safe creation (createSafe -> awaitCreatedSafe) ---------------------------------------------

/** The runtime code of every canonical SafeProxy 1.4.1 (contracts/test/helpers/SafeFixture.sol): its keccak is the pinned SAFE_141.proxyCodehash, so the real verifyCreatedSafe accepts it. */
const PROXY_RUNTIME = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033" as Hex;
const RPC = "https://key-in-host.rpc.example.org/v2/secret999";
const CREATION = `0x${"cc".repeat(32)}` as Hex;
const OWNERS3 = ["0x00000000000000000000000000000000000000a1", "0x00000000000000000000000000000000000000a2", "0x00000000000000000000000000000000000000a3"] as Address[];
const word = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;

/**
 * A Safe created moments ago, read through a load-balanced RPC: the first `staleCode` getCode reads come from a node behind the creation block (no code there yet), every
 * other read is the created Safe. `owners` overrides the roster the chain holds (a consistent but wrong Safe).
 */
function createdSafe(o: { staleCode?: number; owners?: Address[] } = {}) {
  const n = { getCode: 0, connects: 0 };
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "getOwners": return o.owners ?? OWNERS3;
        case "getThreshold": return 2n;
        case "VERSION": return "1.4.1";
        case "nonce": return 0n;
      }
      throw new Error(`fake Safe: ${functionName}`);
    },
    getStorageAt: async ({ slot }: { slot: Hex }) => (slot === "0x0" ? word(SAFE_141.singletonL2) : word(SAFE_141.fallbackHandler)),
    getCode: async () => (++n.getCode <= (o.staleCode ?? 0) ? undefined : PROXY_RUNTIME),
  };
  const handle = { chain: { rpcUrl: RPC, chainId: 8453 }, address: "0x00000000000000000000000000000000000050fe", client, owners: OWNERS3, threshold: 2, nonce: async () => 0 } as unknown as SafeHandle;
  return { n, handle, connect: async () => { n.connects++; return handle; } };
}
const want = { owners: OWNERS3, threshold: 2 };

describe("awaitCreatedSafe: the creation landed, a stale node must not fail it and a wrong Safe must not pass", () => {
  test("verifyCreatedSafe's getCode answered empty by a node behind the creation block for the first 2 reads: verified on the third, no false VERIFY_FAILED", async () => {
    const s = createdSafe({ staleCode: 2 });
    let slept = 0;
    expect(await awaitCreatedSafe({ connect: s.connect, want, rpcUrl: RPC, txHash: CREATION, retry: { sleep: async () => { slept++; } } })).toBe(s.handle);
    expect([s.n.getCode, s.n.connects, slept]).toEqual([3, 3, 2]);
  });
  test("connectSafe refused by a stale node (NOT_A_SAFE: no code at the address yet), then the Safe: connected and verified", async () => {
    const s = createdSafe();
    let tries = 0;
    const connect = async () => { if (++tries <= 2) throw new SafeToolError("NOT_A_SAFE", "no contract at the Safe address"); return s.handle; };
    expect(await awaitCreatedSafe({ connect, want, rpcUrl: RPC, txHash: CREATION, retry: noSleep })).toBe(s.handle);
    expect(tries).toBe(3);
  });
  test("the deployer nonce from before the creation (stale), then the true one: passes on the read that shows it", async () => {
    const s = createdSafe();
    const r = reader([4, 4, 5]);
    await awaitCreatedSafe({ connect: s.connect, want, deployerNonce: { want: 5, read: r.read }, rpcUrl: RPC, txHash: CREATION, retry: noSleep });
    expect(r.n.reads).toBe(3);
  });
  test("never converges within the bound: VERIFY_FAILED, naming the expected value, the last value seen and the RPC host (never its path or key)", async () => {
    const code = await awaitCreatedSafe({ connect: createdSafe({ staleCode: 99 }).connect, want, rpcUrl: RPC, txHash: CREATION, retry: noSleep }).catch((e) => e);
    expect(code).toMatchObject({ code: "VERIFY_FAILED", details: { reads: 5, rpc: "key-in-host.rpc.example.org" } });
    expect(code.message).toContain("canonical proxy code");
    expect(code.message).toContain("5 read(s) from RPC key-in-host.rpc.example.org");
    expect(code.message).not.toContain("secret999");
    const r = reader([4]);
    const nonce = await awaitCreatedSafe({ connect: createdSafe().connect, want, deployerNonce: { want: 5, read: r.read }, rpcUrl: RPC, txHash: CREATION, retry: noSleep }).catch((e) => e);
    expect(nonce).toMatchObject({ code: "VERIFY_FAILED", details: { got: 4, want: 5, seen: [4, 4, 4, 4, 4], rpc: "key-in-host.rpc.example.org" } });
    expect(nonce.message).toContain("deployer nonce is 4 after the stage, expected 5");
    expect(nonce.message).toContain("key-in-host.rpc.example.org");
    expect(nonce.message).not.toContain("secret999");
    expect(r.n.reads).toBe(5);
  });
  test("a consistent but wrong state fails as before: another roster is VERIFY_FAILED after the bound, a deployer nonce above the expected one at once", async () => {
    const other = createdSafe({ owners: [OWNERS3[0]!, OWNERS3[1]!, "0x00000000000000000000000000000000000000ff"] });
    const e = await awaitCreatedSafe({ connect: other.connect, want, rpcUrl: RPC, txHash: CREATION, retry: noSleep }).catch((x) => x);
    expect(e).toMatchObject({ code: "VERIFY_FAILED" });
    expect(e.message).toContain("owners on chain differ from the plan");
    expect(other.n.connects).toBe(5);
    const r = reader([6]);
    await expect(awaitCreatedSafe({ connect: createdSafe().connect, want, deployerNonce: { want: 5, read: r.read }, rpcUrl: RPC, txHash: CREATION, retry: noSleep })).rejects.toMatchObject({ code: "VERIFY_FAILED" });
    expect(r.n.reads).toBe(1);
  });
});
