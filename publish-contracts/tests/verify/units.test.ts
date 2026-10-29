import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ERC1967_IMPLEMENTATION_SLOT, compareCode, compareDeployedCode, implicitRefs, loadArtifact, logicCode, maskHex } from "../../src/verify/codehash.ts";
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
  test("issue 1842: nothing is masked when the byte at the computed CBOR offset is not a CBOR map byte (0xa0-0xbf)", () => {
    for (const b of ["9f", "c0", "00", "60"]) expect(implicitRefs("0x6080604052" + "11".repeat(10) + b + "bbcc" + "0003", true)).toEqual([]);
    for (const b of ["a0", "a2", "bf"]) expect(implicitRefs("0x6080604052" + "11".repeat(10) + b + "bbcc" + "0003", true)).toEqual([{ start: 15, length: 3 }]);
    // a length that reaches past the start of the code masks nothing either
    expect(implicitRefs("0xa2bbcc" + "00ff", true)).toEqual([]);
  });
  test("issue 1842: the trailer of a real solc artifact (the committed ProposerFloorTimelock build) is masked, a CBOR map of the length its last two bytes give", () => {
    const art = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "build-out", "ProposerFloorTimelock.sol", "ProposerFloorTimelock.json"), "utf8"));
    const hex = String(art.deployedBytecode.object).replace(/^0x/, "");
    const total = hex.length / 2, len = parseInt(hex.slice(-4), 16);
    expect(len).toBeGreaterThan(0);
    expect(hex.slice((total - 2 - len) * 2, (total - 2 - len) * 2 + 2)).toBe("a2"); // solc's map of two entries (ipfs, solc)
    expect(implicitRefs(hex, true)).toEqual([{ start: total - 2 - len, length: len }]);
  });
  test("issue 1926: a build whose metadata differs (another checkout path, the relative-remapping foundry.toml) differs only in the CBOR tail and passes compareCode", () => {
    const j = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "build-out", "ProposerFloorTimelock.sol", "ProposerFloorTimelock.json"), "utf8"));
    const art = loadArtifact(join(import.meta.dir, "..", "fixtures", "build-out"), "ProposerFloorTimelock");
    const hex = String(j.deployedBytecode.object).replace(/^0x/, "");
    const total = hex.length / 2, len = parseInt(hex.slice(-4), 16), start = total - 2 - len;
    // The ipfs multihash sits inside the trailer (a2 64 'ipfs' 58 22 <34 bytes> ...): flip every byte of it, as a path-dependent metadata hash would.
    const ipfsAt = hex.indexOf("64697066735822", start * 2) / 2 + 7;
    expect(ipfsAt).toBeGreaterThan(start);
    const otherTail = hex.slice(0, ipfsAt * 2) + hex.slice(ipfsAt * 2, (ipfsAt + 34) * 2).replace(/../g, (b) => (0xff ^ parseInt(b, 16)).toString(16).padStart(2, "0")) + hex.slice((ipfsAt + 34) * 2);
    expect(otherTail).not.toBe(hex);
    expect(compareCode(`0x${otherTail}`, art).ok).toBe(true);
    // One executable byte outside every masked range changed is still a mismatch.
    const at = [...Array(start).keys()].find((i) => i > 0 && !art.refs.some((r) => i >= r.start && i < r.start + r.length))!;
    const exec = hex.slice(0, at * 2) + (0xff ^ parseInt(hex.slice(at * 2, at * 2 + 2), 16)).toString(16).padStart(2, "0") + hex.slice(at * 2 + 2);
    expect(compareCode(`0x${exec}`, art).ok).toBe(false);
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

describe("ERC-1967 proxies (issue 1808)", () => {
  const proxyArt = { object: "0x60806040" + "cc".repeat(8), refs: [] };
  const implArt = { object: "0x" + "11".repeat(4) + "00".repeat(4) + "22".repeat(4), refs: [{ start: 4, length: 4 }] };
  const proxy = "0x00000000000000000000000000000000000000aa" as `0x${string}`;
  const impl = "0x00000000000000000000000000000000000000bb" as `0x${string}`;
  const world = (implCode: string, proxyCode = proxyArt.object) => {
    const codes = new Map<string, string>([[proxy, proxyCode], [impl, implCode]]);
    return {
      getCode: async (a: `0x${string}`) => (codes.get(a.toLowerCase()) ?? "0x") as `0x${string}`,
      getStorageAt: async (a: `0x${string}`, slot: `0x${string}`) =>
        (a === proxy && slot === ERC1967_IMPLEMENTATION_SLOT ? `0x${"0".repeat(24)}${impl.slice(2)}` : `0x${"0".repeat(64)}`) as `0x${string}`,
    };
  };
  test("a proxy is checked through the implementation its slot names", async () => {
    const ok = await compareDeployedCode(world("0x" + "11".repeat(4) + "ab".repeat(4) + "22".repeat(4)), proxy, implArt, proxyArt);
    expect(ok.ok).toBe(true);
    expect(ok.implementation).toBe(impl);
    expect(ok.detail).toContain("ERC-1967 proxy, implementation");
    expect((await compareDeployedCode(world("0x" + "11".repeat(4) + "ab".repeat(4) + "23".repeat(4)), proxy, implArt, proxyArt)).ok).toBe(false);
  });
  test("code that is not the build's proxy is compared directly, and fails against the logic artifact", async () => {
    const r = await compareDeployedCode(world("0x", "0x60806040" + "dd".repeat(8)), proxy, implArt, proxyArt);
    expect(r.ok).toBe(false);
    expect(r.implementation).toBeUndefined();
  });
  test("with no proxy artifact the code at the address is compared directly", async () => {
    expect((await compareDeployedCode(world("0x"), proxy, implArt, undefined)).ok).toBe(false);
  });
  test("a proxy compiled with other settings (another CBOR metadata trailer) is still the proxy", async () => {
    const withCbor = { object: "0x60806040" + "cc".repeat(8) + "aabbcc" + "0003", refs: [] };
    const deployedOtherMeta = "0x60806040" + "cc".repeat(8) + "ddeeff" + "0003";
    const w = world("0x" + "11".repeat(4) + "ab".repeat(4) + "22".repeat(4), deployedOtherMeta);
    expect((await compareDeployedCode(w, proxy, implArt, withCbor)).ok).toBe(true);
    const tampered = world("0x" + "11".repeat(4) + "ab".repeat(4) + "22".repeat(4), "0x60806041" + "cc".repeat(8) + "ddeeff" + "0003");
    expect((await compareDeployedCode(tampered, proxy, implArt, withCbor)).implementation).toBeUndefined();
  });
  test("logicCode reads the implementation's code behind a proxy", async () => {
    const w = world("0xfeed");
    expect(await logicCode(w, proxy, proxyArt)).toBe("0xfeed");
    expect(await logicCode(w, impl, proxyArt)).toBe("0xfeed");
    expect(await logicCode(w, proxy, undefined)).toBe(proxyArt.object as `0x${string}`);
  });
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

  test("converts the basket guard and pool floor to bigint and leaves rmUSDC without them (issue 1666)", () => {
    const s = parseSheetJson(JSON.stringify({ chainId: 1, vaults: {
      rmUSDC: { tvlCap: "5", perDepositCap: "2", exitFeeBps: "10" },
      rmPROTO: { tvlCap: "5", perDepositCap: "2", exitFeeBps: "10", navDeviationBps: "100", minPoolLiquidity: "1000000000000" },
    } }));
    expect(s.vaults.rmPROTO.navDeviationBps).toBe(100n);
    expect(s.vaults.rmPROTO.minPoolLiquidity).toBe(1000000000000n);
    expect(s.vaults.rmUSDC.navDeviationBps).toBeUndefined();
  });
});
