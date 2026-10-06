import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareCode, implicitRefs, maskHex } from "../../src/verify/codehash.ts";
import { loadFrozenCounts, sumFrozenCounts } from "../../src/verify/frozen.ts";
import { minDelayFloor } from "../../src/verify/constants.ts";
import { scanLogs } from "../../src/verify/logs.ts";
import { verifySources } from "../../src/verify/sources.ts";
import { parseSheetJson } from "../../src/verify/cli.ts";
import { toFunctionSelector } from "viem";
import { CHECK_SIGS } from "../../src/verify/safe-checks.ts";
import { FakeChain } from "./world.ts";

describe("Safe 1.4.1 checkSignatures selector", () => {
  test("the verifier's negative controls call the real 1.4.1 function, selector 0x934f3a11 (the executor form 0xf855438b is Safe 1.5.0 and reverts empty on 1.4.1)", () => {
    expect(toFunctionSelector(CHECK_SIGS)).toBe("0x934f3a11");
  });
});

describe("implicit masks (found in the first Twin rehearsal)", () => {
  test("a library's own address (PUSH20 at byte 1) is masked, an ordinary contract's start is not", () => {
    expect(implicitRefs("0x73" + "00".repeat(20) + "6080", false)).toEqual([{ start: 1, length: 20 }]);
    expect(implicitRefs("0x6080604052", false)).toEqual([]);
  });
  test("the CBOR metadata trailer is masked only for a contract that links libraries", () => {
    const hex = "0x6080604052" + "11".repeat(10) + "aabbcc" + "0003"; // cbor = the 3 bytes aabbcc
    expect(implicitRefs(hex, true)).toEqual([{ start: 15, length: 3 }]);
    expect(implicitRefs(hex, false)).toEqual([]);
    const art = { object: hex, refs: implicitRefs(hex, true) };
    const chain = "0x6080604052" + "11".repeat(10) + "ddeeff" + "0003";
    expect(compareCode(chain as `0x${string}`, art).ok).toBe(true);
    expect(compareCode(("0x6080604053" + "11".repeat(10) + "ddeeff" + "0003") as `0x${string}`, art).ok).toBe(false);
  });
});

describe("masked code hash", () => {
  const art = { object: "0x" + "11".repeat(4) + "00".repeat(4) + "22".repeat(4), refs: [{ start: 4, length: 4 }] };
  test("immutable bytes may differ", () => {
    expect(compareCode(("0x" + "11".repeat(4) + "ab".repeat(4) + "22".repeat(4)) as `0x${string}`, art).ok).toBe(true);
  });
  test("a changed byte outside the mask fails", () => {
    expect(compareCode(("0x" + "11".repeat(4) + "ab".repeat(4) + "23".repeat(4)) as `0x${string}`, art).ok).toBe(false);
  });
  test("unlinked placeholders in an artifact are masked", () => {
    expect(maskHex("0x11__$abc$__22", [{ start: 1, length: 3 }]).slice(0, 6)).toBe("0x1100");
  });
  test("empty code fails", () => expect(compareCode("0x", art).ok).toBe(false));
});

describe("frozen counts", () => {
  test("loads by DEPLOY_SHA and sums", () => {
    const f = join(mkdtempSync(join(tmpdir(), "fc-")), "counts.json");
    writeFileSync(f, JSON.stringify({ abc: { safe: 1, libs: 4 } }));
    expect(sumFrozenCounts(loadFrozenCounts(f, "abc"))).toBe(5);
    expect(() => loadFrozenCounts(f, "other")).toThrow();
  });
});

describe("chain floors", () => {
  test("48 hours on 8453, one second elsewhere", () => {
    expect(minDelayFloor(8453)).toBe(172800);
    expect(minDelayFloor(918453)).toBe(1);
  });
});

describe("scanLogs", () => {
  test("gives up after the retry budget on 429", async () => {
    const c = new FakeChain();
    c.rateLimits = 100;
    await expect(scanLogs(c, { topics: [], fromBlock: 0n, toBlock: 10n, chunk: 5, retryBaseMs: 0, maxRetries: 2 })).rejects.toThrow();
  });
  test("covers the whole range exactly once", async () => {
    const c = new FakeChain();
    await scanLogs(c, { topics: [], fromBlock: 3n, toBlock: 10n, chunk: 3, retryBaseMs: 0 });
    expect(c.logCalls).toEqual([{ from: 3n, to: 5n }, { from: 6n, to: 8n }, { from: 9n, to: 10n }]);
  });
});

describe("source verification", () => {
  const A = "0x00000000000000000000000000000000000000a1" as const;
  const mk = (bs: boolean, match: string | undefined) => (async (url: any) => {
    const u = String(url);
    const body = u.includes("blockscout") ? { is_verified: bs } : { match };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const base = { chainId: 8453, contracts: { vault: A }, timeoutMs: 0, pollIntervalMs: 1 };
  test("passes on blockscout verified and sourcify exact match", async () => {
    expect((await verifySources({ ...base, fetchFn: mk(true, "exact_match") })).ok).toBe(true);
  });
  test("a partial sourcify match fails", async () => {
    expect((await verifySources({ ...base, fetchFn: mk(true, "match") })).ok).toBe(false);
  });
  test("unverified on blockscout fails", async () => {
    expect((await verifySources({ ...base, fetchFn: mk(false, "exact_match") })).ok).toBe(false);
  });
  test("refuses chains without an explorer", async () => {
    await expect(verifySources({ ...base, chainId: 918453 })).rejects.toThrow();
  });
});

describe("sheet json", () => {
  test("converts bigint fields", () => {
    const s = parseSheetJson(JSON.stringify({ chainId: 1, vaults: { rmUSDC: { tvlCap: "5", perDepositCap: "2", exitFeeBps: "10", seed: "1000000" } } }));
    expect(s.vaults.rmUSDC.tvlCap).toBe(5n);
    expect(s.vaults.rmUSDC.seed).toBe(1000000n);
    expect(s.vaults.rmUSDC.assets).toEqual([]);
  });
});
