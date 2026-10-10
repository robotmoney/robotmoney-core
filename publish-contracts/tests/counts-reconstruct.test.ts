// Reconstructed baseline frozen counts (issue 1733): a new sha gets a NON-adopted frozen file rebuilt from an adopted Twin measuring run, checked against the
// stage table, the build and the chain, and marked `measured.reconstructed`. Every refusal below has a mutation check in the PR description.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { fileHashOf, loadFrozen, loadFrozenFile, resolveCounts, frozenPath, sumCounts } from "../src/counts.ts";
import { adoptableOf, crossCheckDiff, reconstructBaseline, verifyReconstruction, verifyReconstructionOnChain, type CountsJsonLike, type Reconstruction } from "../src/counts-reconstruct.ts";
import { PublishError } from "../src/errors.ts";
import { buildCreate2Libraries, predictedLibraryAddress, expectedLibraryRuntime } from "../src/libs-adopt.ts";
import { assertReleaseGate } from "../src/release-gate.ts";
import { adoptedFromRunManifest, buildCountsJson, checkCountsJson } from "../src/ci/rehearsal-counts.ts";
import { freezeFromAdoptedRun } from "../scripts/freeze-counts.ts";
import { getStageTable } from "../src/stages.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { REPO, tmp } from "./fixtures.ts";
import { world } from "./harness.ts";

const SHA = "c".repeat(40);
const OUT = join(import.meta.dir, "fixtures", "build-out");
const table = getStageTable();
const kind = async (f: () => unknown): Promise<string | undefined> => { try { await f(); } catch (e) { return (e as PublishError).kind; } return undefined; };
const msg = async (f: () => unknown): Promise<string> => { try { await f(); } catch (e) { return (e as Error).message; } return ""; };

// The frozen counts of the first real release (9a768bb9), read from the repo: the reference a rebuilt baseline must equal.
const REF_PATH = join(REPO, "deployments", "frozen-counts", "9a768bb9cc66d4485470a99a068ba7477604501a.json");
const REF = JSON.parse(readFileSync(REF_PATH, "utf8")).counts as Record<string, number>;

// Build artifacts and what the chain holds, derived with the code under test's own inputs but compared with hand-built values below.
const tickArt = JSON.parse(readFileSync(join(OUT, "TickMath.sol", "TickMath.json"), "utf8"));
const TICK = predictedLibraryAddress(tickArt.bytecode.object);
const TICK_RUNTIME = `0x73${TICK.slice(2).toLowerCase()}${tickArt.deployedBytecode.object.slice(44)}` as Hex; // PUSH20 <address(this)> at bytes 1 to 20
const C2 = buildCreate2Libraries(table.create2Libraries!, OUT);
const THREE = [...C2.values()];
const chain = (over: Record<string, string> = {}) => {
  const code: Record<string, string> = { [TICK.toLowerCase()]: TICK_RUNTIME, ...Object.fromEntries(THREE.map((b) => [b.address.toLowerCase(), b.runtime])), ...over };
  return async (a: Address): Promise<string> => code[a.toLowerCase()] ?? "0x";
};
const OUTS = { linkOut: OUT, c2Out: OUT };

/** The counts.json of an adopted Twin measuring run: libs 0 (TickMath adopted), proto 7 (three creations adopted), every other stage as measured. */
function adoptedRun(over: Partial<CountsJsonLike> = {}, ad: Record<string, unknown> = {}): CountsJsonLike {
  const counts = { ...REF, libs: 0, proto: REF.proto! - 3 };
  return {
    deploySha: SHA, chainId: 918453, counts, deployerNonce: sumCounts(counts) + 1, pinBlock: 52_500_000, rehearsal: { conclusion: "success" },
    adopted: {
      libs: { deployerTxs: 0, factory: "0x4e59b44847b379578588920cA78FbF26c0B4956C", libraries: [{ name: "tick_math", artifact: "TickMath", address: TICK, codeHash: keccak256(TICK_RUNTIME) }] },
      proto: { deployerTxs: REF.proto! - 3, libraries: THREE.map((b) => ({ name: b.name, artifact: b.artifact, address: b.address, codeHash: b.runtimeHash })) },
      ...ad,
    } as never,
    ...over,
  };
}
const rebuild = (j: CountsJsonLike, o: { cross?: { sha: string; counts: Record<string, number>; fileHash?: string }; acceptDiff?: string[]; getCode?: (a: Address) => Promise<string>; sha?: string } = {}) =>
  reconstructBaseline({ j, sha: o.sha ?? SHA, table, at: "2026-10-10T00:00:00Z", verify: (r) => verifyReconstructionOnChain(r, { table, out: OUTS, getCode: o.getCode ?? chain() }), cross: o.cross && { fileHash: "ab".repeat(32), ...o.cross }, acceptDiff: o.acceptDiff });

describe("the fixtures are the real thing", () => {
  test("the build's libraries sit at the Base mainnet addresses and the table lets libs adopt tick_math and proto the three create2 libraries", () => {
    expect(TICK).toBe("0x3353854084194AE5Cc1697a9E4337806ECcdD9F6");
    expect(THREE.map((b) => b.address.toLowerCase())).toEqual(["0xb026a232f54d381a47a9e2640d04084830f0ae58", "0x7fdc1e387486c81f97a2379ce897b202d4e815e2", "0xe0a16a5b9a4edd2e0723b74f593c1053f8cbe6ba"]);
    expect(adoptableOf(table, "libs").map((l) => l.library)).toEqual(["tick_math"]);
    expect(adoptableOf(table, "proto").map((l) => l.library)).toEqual(["BasketAssetConfigGuard", "TwapTickMath", "BasketViews"]);
    expect(adoptableOf(table, "vault")).toEqual([]);
    expect(expectedLibraryRuntime(tickArt.deployedBytecode.object, TICK)).toBe(TICK_RUNTIME);
    expect(REF.libs).toBe(1);
    expect(REF.proto).toBe(10);
  });
});

describe("reconstruction from an adopted measuring run", () => {
  test("libs 0 + 1 and proto 7 + 3 give the baseline of the first release; every other stage is as measured; the file is marked reconstructed and NOT adopted", async () => {
    const f = await rebuild(adoptedRun());
    expect(f.counts).toEqual(REF);
    expect(f.deploySha).toBe(SHA);
    expect(f.measured.adopted).toBeUndefined();
    const r = f.measured.reconstructed!;
    expect(r.fromRun).toEqual({ sha: SHA, chainId: 918453, pinBlock: 52_500_000 });
    expect(r.measuredCounts.libs).toBe(0);
    expect(r.measuredCounts.proto).toBe(7);
    expect(r.adopted.map((a) => `${a.stage}/${a.library}`)).toEqual(["libs/tick_math", "proto/BasketAssetConfigGuard", "proto/TwapTickMath", "proto/BasketViews"]);
    expect(() => verifyReconstruction(f, table)).not.toThrow();
  });

  test("the written file loads by loadFrozen and resolveCounts for chain 8453 (strict, no allowAdopted) and the other chains, and is the count a fresh chain shows", async () => {
    const dir = tmp("pc-recon-");
    const countsJson = join(dir, "counts.json");
    writeFileSync(countsJson, JSON.stringify(adoptedRun()));
    const out = join(dir, "frozen");
    const p = await freezeFromAdoptedRun({ countsJsonPath: countsJson, sha: SHA, countsDir: out, table, getCode: chain(), build: () => ({ ...OUTS, linked: [], create2: [] }), at: "2026-10-10T00:00:00Z" });
    expect(p).toBe(frozenPath(out, SHA));
    const f = loadFrozen(out, SHA);
    expect(f.counts).toEqual(REF);
    for (const chainId of [8453, 918453, 84532]) expect(resolveCounts({ dir: out, sha: SHA, measureFlag: false, dryRun: false, chainId }).frozen).toEqual(REF);
    // a rerun with the same inputs leaves the file as it is
    await freezeFromAdoptedRun({ countsJsonPath: countsJson, sha: SHA, countsDir: out, table, getCode: chain(), build: () => ({ ...OUTS, linked: [], create2: [] }), at: "later" });
    expect(JSON.parse(readFileSync(p, "utf8")).measured.at).toBe("2026-10-10T00:00:00Z");
  });

  test("cross-check against the first release: no difference, recorded as an empty accepted list", async () => {
    const f = await rebuild(adoptedRun(), { cross: { sha: "9a768bb9cc66d4485470a99a068ba7477604501a", counts: REF } });
    expect(f.measured.reconstructed!.crossCheck).toEqual({ against: "9a768bb9cc66d4485470a99a068ba7477604501a", accepted: [] });
  });

  test("cross-check: a difference is REFUSED unless the stage is named in --accept-diff, and an accepted difference is written into the file", async () => {
    const run = adoptedRun();
    run.counts = { ...run.counts, vault: 17 };
    run.deployerNonce += 1;
    const cross = { sha: "9a768bb9cc66d4485470a99a068ba7477604501a", counts: REF };
    expect(await kind(() => rebuild(run, { cross }))).toBe("COUNT_MISMATCH");
    expect(await msg(() => rebuild(run, { cross }))).toContain("vault (old 16, new 17)");
    expect(await kind(() => rebuild(run, { cross, acceptDiff: ["vault", "router"] }))).toBe("USAGE"); // accepting a stage that does not differ
    const f = await rebuild(run, { cross, acceptDiff: ["vault"] });
    expect(f.counts.vault).toBe(17);
    expect(f.measured.reconstructed!.crossCheck!.accepted).toEqual([{ stage: "vault", old: 16, new: 17 }]);
    expect(await kind(() => rebuild(adoptedRun(), { acceptDiff: ["vault"] }))).toBe("USAGE"); // --accept-diff without --cross-check
    expect(crossCheckDiff({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([{ stage: "b", old: null, new: 2 }, { stage: "c", old: 3, new: null }]);
  });

  test("the cross-check reference must itself be a frozen file: an adopted-marked earlier file is refused", async () => {
    const dir = tmp("pc-recon-");
    const countsJson = join(dir, "counts.json");
    writeFileSync(countsJson, JSON.stringify(adoptedRun()));
    const old = join(dir, "old.json");
    writeFileSync(old, JSON.stringify({ deploySha: "d".repeat(40), measured: { chainId: 918453, at: "x", adopted: ["libs"] }, counts: REF }));
    expect(await kind(() => freezeFromAdoptedRun({ countsJsonPath: countsJson, sha: SHA, countsDir: join(dir, "o"), table, getCode: chain(), build: () => ({ ...OUTS, linked: [], create2: [] }), crossCheckPath: old }))).toBe("COUNTS_MISSING");
    writeFileSync(old, JSON.stringify({ deploySha: "d".repeat(40), measured: { chainId: 918453, at: "x" }, counts: REF }));
    await freezeFromAdoptedRun({ countsJsonPath: countsJson, sha: SHA, countsDir: join(dir, "o2"), table, getCode: chain(), build: () => ({ ...OUTS, linked: [], create2: [] }), crossCheckPath: old });
    expect(loadFrozen(join(dir, "o2"), SHA).measured.reconstructed!.crossCheck!.against).toBe("d".repeat(40));
  });
});

describe("the adoption records are proven against the build and the chain", () => {
  test("a wrong runtime code hash on chain is refused (libs and create2), nothing is written", async () => {
    expect(await kind(() => rebuild(adoptedRun(), { getCode: chain({ [TICK.toLowerCase()]: "0x6001600155" }) }))).toBe("LIBS_ADOPTION");
    expect(await kind(() => rebuild(adoptedRun(), { getCode: chain({ [THREE[1]!.address.toLowerCase()]: "0x6001600155" }) }))).toBe("LIBS_ADOPTION");
  });
  test("no code at an adopted address is refused", async () => {
    expect(await kind(() => rebuild(adoptedRun(), { getCode: chain({ [THREE[2]!.address.toLowerCase()]: "0x" }) }))).toBe("LIBS_ADOPTION");
  });
  test("a record whose address is not the build's CREATE2 address is refused, even when the chain holds the recorded code there", async () => {
    const fake = "0x00000000000000000000000000000000000000f1";
    const run = adoptedRun();
    (run.adopted!.libs!.libraries![0] as { address: string }).address = fake;
    expect(await kind(() => rebuild(run, { getCode: chain({ [fake]: TICK_RUNTIME }) }))).toBe("LIBS_ADOPTION");
    const run2 = adoptedRun();
    (run2.adopted!.proto!.libraries![0] as { address: string }).address = fake;
    expect(await msg(() => rebuild(run2, { getCode: chain({ [fake]: THREE[0]!.runtime }) }))).toContain("the build deploys it to");
  });
  test("a record whose code hash differs from the build's is refused even when the chain agrees with the build", async () => {
    const run = adoptedRun();
    (run.adopted!.proto!.libraries![1] as { codeHash: string }).codeHash = keccak256("0x1234");
    expect(await msg(() => rebuild(run))).toContain("the build's runtime hash");
    const run2 = adoptedRun();
    (run2.adopted!.libs!.libraries![0] as { codeHash: string }).codeHash = keccak256("0x1234");
    expect(await kind(() => rebuild(run2))).toBe("LIBS_ADOPTION");
  });
});

describe("the adoption set is bounded by the stage table", () => {
  test("a stage that adopts fewer libraries than the table lists, more, or one the table does not list is refused", async () => {
    const two = adoptedRun();
    two.adopted!.proto!.libraries = two.adopted!.proto!.libraries!.slice(0, 2);
    two.adopted!.proto!.deployerTxs = REF.proto! - 2;
    two.counts.proto = REF.proto! - 2; two.deployerNonce = sumCounts(two.counts) + 1;
    expect(await msg(() => rebuild(two))).toContain("lets it adopt exactly");
    const extra = adoptedRun();
    extra.adopted!.proto!.libraries!.push({ name: "Extra", artifact: "Extra", address: "0x00000000000000000000000000000000000000f2", codeHash: keccak256("0x12") });
    expect(await msg(() => rebuild(extra))).toContain("lets it adopt exactly");
    const wrongStage = adoptedRun({}, { vault: { deployerTxs: REF.vault, libraries: [{ name: "tick_math", artifact: "TickMath", address: "0x00000000000000000000000000000000000000f3", codeHash: keccak256(TICK_RUNTIME) }] } });
    expect(await msg(() => rebuild(wrongStage))).toContain("lets it adopt exactly [nothing]");
  });
  test("an adopted stage whose measured count differs from the deployer transactions the run sent (a partly resumed stage) is refused", async () => {
    const run = adoptedRun();
    run.adopted!.proto!.deployerTxs = REF.proto! - 2;
    expect(await msg(() => rebuild(run))).toContain("partly resumed");
  });
  test("a counts.json without adoption records (an older build of rehearsal-counts) is refused with the way out", async () => {
    const run = adoptedRun({}, { libs: { deployerTxs: 0 } });
    expect(await msg(() => rebuild(run))).toContain("carries no adoption records");
  });
});

describe("the counts.json that is rebuilt from must be a clean, green measurement at this sha", () => {
  test("a red rehearsal, another sha, a non-Twin chain, nothing adopted, a stray deployer transaction and wrong stage names are each refused", async () => {
    expect(await kind(() => rebuild(adoptedRun({ rehearsal: { conclusion: "failure" } })))).toBe("USAGE");
    expect(await kind(() => rebuild(adoptedRun({ deploySha: "d".repeat(40) })))).toBe("USAGE");
    expect(await kind(() => rebuild(adoptedRun({ chainId: 8453 })))).toBe("USAGE");
    expect(await kind(() => rebuild(adoptedRun({ adopted: {} })))).toBe("USAGE");
    expect(await msg(() => rebuild(adoptedRun({ deployerNonce: sumCounts(adoptedRun().counts) + 2 })))).toContain("stray transaction");
    const { timelock: _t, ...fewer } = adoptedRun().counts;
    expect(await kind(() => rebuild(adoptedRun({ counts: fewer })))).toBe("USAGE");
  });
  test("a rehearsal-kind run (deployer not fresh) is rebuilt with its start nonce counted", async () => {
    const run = adoptedRun({ deployerStartNonce: 3 });
    run.deployerNonce += 3;
    expect((await rebuild(run)).counts).toEqual(REF);
  });
});

describe("a reconstructed file is verified on every load, so a hand-set or tampered one is refused", () => {
  const good = async () => {
    const dir = tmp("pc-recon-");
    const f = await rebuild(adoptedRun());
    mkdirSync(dir, { recursive: true });
    writeFileSync(frozenPath(dir, SHA), JSON.stringify(f, null, 2));
    return { dir, f: JSON.parse(JSON.stringify(f)) };
  };
  const edit = async (fn: (f: any) => void): Promise<string> => {
    const { dir, f } = await good();
    fn(f);
    writeFileSync(frozenPath(dir, SHA), JSON.stringify(f));
    return msg(() => loadFrozen(dir, SHA));
  };
  test("the untouched file loads", async () => {
    const { dir } = await good();
    expect(loadFrozen(dir, SHA).counts).toEqual(REF);
  });
  test("a raised count, a lowered count and a raised measured count are refused (the sum no longer holds)", async () => {
    expect(await edit((f) => { f.counts.proto = 11; })).toContain("plus 3 adopted creation");
    expect(await edit((f) => { f.counts.libs = 2; })).toContain("stage libs");
    expect(await edit((f) => { f.counts.agent = 9; })).toContain("stage agent");
    expect(await edit((f) => { f.measured.reconstructed.measuredCounts.proto = 8; })).toContain("stage proto");
  });
  test("a removed or duplicated adoption entry, an invalid address or hash, and an unknown stage are refused", async () => {
    expect(await edit((f) => { f.measured.reconstructed.adopted.pop(); })).toContain("lets it adopt exactly");
    expect(await edit((f) => { f.measured.reconstructed.adopted.push(f.measured.reconstructed.adopted[0]); })).toContain("twice");
    expect(await edit((f) => { f.measured.reconstructed.adopted[0].address = "0x12"; })).toContain("no valid address");
    expect(await edit((f) => { f.measured.reconstructed.adopted[0].codeHash = "0x12"; })).toContain("no valid code hash");
    expect(await edit((f) => { f.measured.reconstructed.adopted[0].stage = "nonesuch"; })).toContain("not a deployer stage");
    expect(await edit((f) => { f.measured.reconstructed.adopted = []; })).toContain("records no adopted creation");
  });
  test("another sha, a non-Twin source chain and a block that is not a number are refused", async () => {
    expect(await edit((f) => { f.measured.reconstructed.fromRun.sha = "d".repeat(40); })).toContain("SAME sha");
    expect(await edit((f) => { f.measured.reconstructed.fromRun.chainId = 8453; })).toContain("Twin chain");
    expect(await edit((f) => { f.measured.reconstructed.fromRun.pinBlock = -1; })).toContain("pinBlock");
    expect(await edit((f) => { f.measured.reconstructed.crossCheck = { against: "zz", accepted: [] }; f.measured.crossChecked = { sha: "zz", fileHash: "zz" }; })).toContain("crossChecked is malformed");
  });
  test("a file for another sha, a stage set that is not the table's and a marker on a pure measurement are refused", async () => {
    const { dir } = await good();
    writeFileSync(frozenPath(dir, "d".repeat(40)), readFileSync(frozenPath(dir, SHA)));
    expect(await kind(() => loadFrozen(dir, "d".repeat(40)))).toBe("COUNTS_MISSING");
    expect(await edit((f) => { delete f.counts.timelock; })).toContain("stage table names");
    expect(await edit((f) => { f.counts.extra = 1; f.measured.reconstructed.measuredCounts.extra = 1; })).toContain("stage table names");
  });
  test("verifyReconstruction itself refuses a file that is marked adopted AND reconstructed (defense in depth behind the loader)", async () => {
    const f = JSON.parse(JSON.stringify(await rebuild(adoptedRun())));
    f.measured.adopted = ["libs"];
    expect(() => verifyReconstruction(f, table)).toThrow("adopted AND reconstructed");
  });
  test("the OLD adopted marker is still refused on every chain, alone or together with a reconstruction block, and the message names the way out", async () => {
    const msg1 = await edit((f) => { f.measured.adopted = ["libs"]; });
    expect(msg1).toContain("ADOPTED stage(s) libs");
    expect(msg1).toContain("--from-adopted-run");
    const dir = tmp("pc-recon-");
    writeFileSync(join(dir, `${SHA}.json`), JSON.stringify({ deploySha: SHA, measured: { chainId: 918453, at: "x", adopted: ["libs", "proto"] }, counts: REF }));
    for (const chainId of [8453, 84532, 1, 918454]) expect(await kind(() => resolveCounts({ dir, sha: SHA, measureFlag: false, dryRun: false, chainId }))).toBe("COUNTS_MISSING");
    expect(loadFrozen(dir, SHA, { allowAdopted: true }).counts).toEqual(REF); // the Twin follow-on verbs only
  });
  test("a hand-written block that is arithmetically consistent passes the OFFLINE load but is refused by the plan-time release gate: it is re-verified on chain", async () => {
    // an attacker raises libs by one and fakes a record for a second tick_math "adoption" at a made-up address
    const dir = tmp("pc-recon-");
    const f = JSON.parse(JSON.stringify(await rebuild(adoptedRun())));
    f.measured.reconstructed.adopted[0].address = "0x00000000000000000000000000000000000000f1";
    writeFileSync(frozenPath(dir, SHA), JSON.stringify(f));
    expect(loadFrozen(dir, SHA).counts).toEqual(REF); // structure holds
    const gate = (verifyReconstructed?: Parameters<typeof assertReleaseGate>[0]["verifyReconstructed"]) =>
      assertReleaseGate({ sha: SHA, coreDir: "/x", countsDir: dir, env: { GITHUB_TOKEN: "t" }, kind: "rehearsal", releaseTags: async () => ["release/v1-rehearsal"], remoteTag: async () => {}, checkShaGreen: async () => ({ code: 0, output: "" }), verifyReconstructed });
    expect(await kind(() => gate())).toBe("COUNTS_MISSING"); // no way to re-verify: refused
    expect(await kind(() => gate((file) => verifyReconstructionOnChain(file.measured.reconstructed!, { table, out: OUTS, getCode: chain() })))).toBe("LIBS_ADOPTION");
  });
  test("the plan-time gate accepts a genuine reconstruction after re-verifying it, and calls the verifier exactly once; a pure measurement never calls it", async () => {
    const dir = tmp("pc-recon-");
    const f = await rebuild(adoptedRun());
    writeFileSync(frozenPath(dir, SHA), JSON.stringify(f));
    let calls = 0;
    const gate = (d: string) => assertReleaseGate({ sha: SHA, coreDir: "/x", countsDir: d, env: { GITHUB_TOKEN: "t" }, kind: "rehearsal", releaseTags: async () => ["release/v1-rehearsal"], remoteTag: async () => {}, checkShaGreen: async () => ({ code: 0, output: "" }),
      verifyReconstructed: async (file) => { calls++; await verifyReconstructionOnChain(file.measured.reconstructed!, { table, out: OUTS, getCode: chain() }); } });
    expect(await gate(dir)).toBe("release/v1-rehearsal");
    expect(calls).toBe(1);
    const pure = tmp("pc-recon-");
    writeFileSync(frozenPath(pure, SHA), JSON.stringify({ deploySha: SHA, measured: { chainId: 918453, at: "x" }, counts: REF }));
    expect(await gate(pure)).toBe("release/v1-rehearsal");
    expect(calls).toBe(1);
  });
});

describe("the Twin job's counts.json carries the adoption records, so the reconstruct verb can use it", () => {
  test("adoptedFromRunManifest keeps the libraries and the factory of each adopted stage; buildCountsJson keeps them and the pin block; the nonce check still holds", () => {
    const dir = tmp("pc-recon-");
    const mf = join(dir, "publish-run.json");
    const run = adoptedRun();
    writeFileSync(mf, JSON.stringify({ stages: {
      libs: { status: "done", adopted: true, adoption: { deployerTxs: 0, factory: run.adopted!.libs!.factory, libraries: run.adopted!.libs!.libraries } },
      proto: { status: "done", adopted: true, adoption: { deployerTxs: 7, libraries: run.adopted!.proto!.libraries } },
      "prove-control": { status: "done", adopted: true }, safe: { status: "done" },
    } }));
    const adopted = adoptedFromRunManifest(mf);
    expect(adopted).toEqual(run.adopted as never);
    const cdir = join(dir, "counts");
    mkdirSync(cdir);
    writeFileSync(join(cdir, `${SHA}.json`), JSON.stringify({ deploySha: SHA, measured: { chainId: 918453, at: "x", adopted: ["libs", "proto"] }, counts: run.counts }));
    const j = buildCountsJson(cdir, SHA, run.deployerNonce, adopted, undefined, 52_500_000);
    expect(j.pinBlock).toBe(52_500_000);
    expect(j.adopted).toEqual(adopted);
    expect(checkCountsJson(j, Object.keys(REF))).toEqual([]);
    expect("pinBlock" in buildCountsJson(cdir, SHA, run.deployerNonce, adopted)).toBe(false);
  });
  test("end to end at unit level: a measuring counts.json built that way is rebuilt by the verb into a file the strict load accepts, and that file is equal to the first release", async () => {
    const dir = tmp("pc-recon-");
    const run = adoptedRun();
    const cj = join(dir, "counts.json");
    writeFileSync(cj, JSON.stringify(run));
    const p = await freezeFromAdoptedRun({ countsJsonPath: cj, sha: SHA, countsDir: join(dir, "f"), table, getCode: chain(), build: () => ({ ...OUTS, linked: [], create2: [] }), crossCheckPath: REF_PATH });
    const f = loadFrozenFile(p, SHA);
    expect(f.counts).toEqual(REF);
    expect((f.measured.reconstructed as Reconstruction).crossCheck!.accepted).toEqual([]);
  });
});

describe("the 8453 plan job (the CLI) with a reconstructed baseline", () => {
  const A40 = "a".repeat(40); // the sha of the test world
  async function plan(file: unknown, seam?: (f: unknown) => Promise<void>): Promise<{ code: number; verified: number; signerMade: boolean }> {
    const w = world({ chainId: 8453, writeFrozen: false });
    mkdirSync(w.countsDir, { recursive: true });
    writeFileSync(frozenPath(w.countsDir, A40), JSON.stringify(file));
    let verified = 0, signerMade = false;
    const real = console.log;
    console.log = () => {};
    try {
      const code = await w.run(["--stage", "plan", "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; throw new Error("no signer in the plan"); }, verifyReconstructed: async (f: unknown) => { verified++; await seam?.(f); } });
      return { code, verified, signerMade };
    } finally { console.log = real; }
  }
  const baseline = async () => rebuild(adoptedRun({ deploySha: A40 }), { sha: A40 });
  test("a genuine reconstruction passes the plan; its records are re-verified exactly once; no signer exists", async () => {
    const r = await plan(await baseline());
    expect(r).toEqual({ code: 0, verified: 1, signerMade: false });
  });
  test("a re-verification that fails (the chain or the build disagrees with a record) stops the plan with LIBS_ADOPTION", async () => {
    const r = await plan(await baseline(), async () => { throw new PublishError("LIBS_ADOPTION", "code hash differs"); });
    expect(r.code).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(r.signerMade).toBe(false);
  });
  test("a tampered reconstruction is refused before the re-verification is asked", async () => {
    const f = JSON.parse(JSON.stringify(await baseline()));
    f.counts.proto = 11;
    const r = await plan(f);
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(r.verified).toBe(0);
  });
  test("the old adopted marker is refused by the plan: it is not a frozen file", async () => {
    const r = await plan({ deploySha: A40, measured: { chainId: 918453, at: "x", adopted: ["libs", "proto"] }, counts: REF });
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
  });
});

describe("the cross-check against the previous release is mandatory (issue 1733 review)", () => {
  const PREV = "9a768bb9cc66d4485470a99a068ba7477604501a";
  /** A counts dir holding an earlier frozen file (the first release's, copied), and the adopted run's counts.json. */
  function setup(counts = REF) {
    const dir = tmp("pc-mand-");
    const frozen = join(dir, "frozen");
    mkdirSync(frozen);
    const earlier = { deploySha: PREV, measured: { chainId: 918453, at: "2026-10-09T19:46:52.795Z" }, counts };
    writeFileSync(join(frozen, `${PREV}.json`), JSON.stringify(earlier, null, 2));
    const cj = join(dir, "counts.json");
    return { dir, frozen, cj, earlier };
  }
  const go = (cj: string, frozen: string, extra: Partial<Parameters<typeof freezeFromAdoptedRun>[0]> = {}) =>
    freezeFromAdoptedRun({ countsJsonPath: cj, sha: SHA, countsDir: frozen, table, getCode: chain(), build: () => ({ ...OUTS, linked: [], create2: [] }), ...extra });
  test("with an earlier frozen file in the counts dir and no --cross-check, the most recent earlier file is the anchor; the file records its sha and the hash of its bytes", async () => {
    const t = setup();
    writeFileSync(t.cj, JSON.stringify(adoptedRun()));
    const p = await go(t.cj, t.frozen);
    const f = JSON.parse(readFileSync(p, "utf8"));
    expect(f.measured.crossChecked).toEqual({ sha: PREV, fileHash: fileHashOf(readFileSync(join(t.frozen, `${PREV}.json`))) });
    expect(f.measured.reconstructed.crossCheck.against).toBe(PREV);
    expect(loadFrozen(t.frozen, SHA).counts).toEqual(REF);
  });
  test("a stage difference against that anchor is COUNT_MISMATCH with no way to skip it; only --accept-diff naming the stage lets it through, and it is recorded", async () => {
    const t = setup();
    const run = adoptedRun();
    run.counts = { ...run.counts, vault: 17 }; run.deployerNonce += 1;
    writeFileSync(t.cj, JSON.stringify(run));
    expect(await kind(() => go(t.cj, t.frozen))).toBe("COUNT_MISMATCH");
    expect(await kind(() => go(t.cj, t.frozen, { acceptDiff: ["router"] }))).toBe("COUNT_MISMATCH");
    const p = await go(t.cj, t.frozen, { acceptDiff: ["vault"] });
    expect(JSON.parse(readFileSync(p, "utf8")).measured.reconstructed.crossCheck.accepted).toEqual([{ stage: "vault", old: 16, new: 17 }]);
  });
  test("an explicit --cross-check overrides the automatic choice; with no earlier file at all nothing is recorded and the baseline still builds", async () => {
    const t = setup({ ...REF, vault: 99 });
    writeFileSync(t.cj, JSON.stringify(adoptedRun()));
    expect(await kind(() => go(t.cj, t.frozen))).toBe("COUNT_MISMATCH"); // the auto anchor differs
    const p = await go(t.cj, t.frozen, { crossCheckPath: REF_PATH });
    expect(JSON.parse(readFileSync(p, "utf8")).measured.crossChecked.sha).toBe(PREV);
    const empty = tmp("pc-mand-");
    const p2 = await go(t.cj, empty);
    expect(JSON.parse(readFileSync(p2, "utf8")).measured.crossChecked).toBeUndefined();
    expect(loadFrozen(empty, SHA).counts).toEqual(REF);
  });
  test("an earlier file that does not load (adopted-marked) stops the verb: an anchor is never silently skipped", async () => {
    const t = setup();
    writeFileSync(join(t.frozen, `${PREV}.json`), JSON.stringify({ deploySha: PREV, measured: { chainId: 918453, at: "2026-10-09T00:00:00Z", adopted: ["libs"] }, counts: REF }));
    writeFileSync(t.cj, JSON.stringify(adoptedRun()));
    expect(await kind(() => go(t.cj, t.frozen))).toBe("COUNTS_MISSING");
  });
  test("loadFrozen refuses a reconstructed file with no crossChecked record when an earlier frozen file exists, and one whose anchor file changed since", async () => {
    const t = setup();
    writeFileSync(t.cj, JSON.stringify(adoptedRun()));
    const p = await go(t.cj, t.frozen);
    const good = JSON.parse(readFileSync(p, "utf8"));
    const strip = JSON.parse(JSON.stringify(good));
    delete strip.measured.crossChecked; delete strip.measured.reconstructed.crossCheck;
    writeFileSync(p, JSON.stringify(strip));
    expect(await msg(() => loadFrozen(t.frozen, SHA))).toContain("no crossChecked record");
    writeFileSync(p, JSON.stringify(good));
    expect(() => loadFrozen(t.frozen, SHA)).not.toThrow();
    writeFileSync(join(t.frozen, `${PREV}.json`), JSON.stringify({ deploySha: PREV, measured: { chainId: 918453, at: "2026-10-09T19:46:52.795Z" }, counts: { ...REF, timelock: 44 } }));
    expect(await msg(() => loadFrozen(t.frozen, SHA))).toContain("has changed since");
  });
  test("a LATER frozen file in the dir is not an earlier anchor, so an old baseline keeps loading after a newer release is added", async () => {
    const dir = tmp("pc-mand-");
    const f = await rebuild(adoptedRun());
    writeFileSync(frozenPath(dir, SHA), JSON.stringify(f));
    writeFileSync(frozenPath(dir, "e".repeat(40)), JSON.stringify({ deploySha: "e".repeat(40), measured: { chainId: 918453, at: "2099-01-01T00:00:00Z" }, counts: REF }));
    expect(() => loadFrozen(dir, SHA)).not.toThrow();
  });
  test("malformed or inconsistent crossChecked fields are refused offline", async () => {
    const t = setup();
    writeFileSync(t.cj, JSON.stringify(adoptedRun()));
    const good = JSON.parse(readFileSync(await go(t.cj, t.frozen), "utf8"));
    const bad = (fn: (f: any) => void): string => { const f = JSON.parse(JSON.stringify(good)); fn(f); try { verifyReconstruction(f, table); } catch (e) { return (e as Error).message; } return ""; };
    expect(bad((f) => { f.measured.crossChecked.fileHash = "zz"; })).toContain("crossChecked is malformed");
    expect(bad((f) => { f.measured.crossChecked.sha = SHA; })).toContain("crossChecked is malformed");
    expect(bad((f) => { delete f.measured.crossChecked; })).toContain("both be present");
    expect(bad((f) => { f.measured.crossChecked.sha = "f".repeat(40); })).toContain("different files");
  });
});

describe("publish on 8453 re-verifies a reconstructed baseline itself (the order plan then publish is not left to the operator)", () => {
  test("a deploy stage on 8453 asks for the re-verification before any signer or forge call; a failure stops it with LIBS_ADOPTION", async () => {
    const A40 = "a".repeat(40);
    const w = world({ chainId: 8453, writeFrozen: false });
    mkdirSync(w.countsDir, { recursive: true });
    writeFileSync(frozenPath(w.countsDir, A40), JSON.stringify(await rebuild(adoptedRun({ deploySha: A40 }), { sha: A40 })));
    let asked = 0, signerMade = false;
    const code = await w.run(["--stage", "libs", "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; throw new Error("no signer"); }, verifyReconstructed: async () => { asked++; throw new PublishError("LIBS_ADOPTION", "the chain disagrees"); } });
    expect(code).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(asked).toBe(1);
    expect(signerMade).toBe(false);
    expect(w.state().calls.filter((c: any) => c.tool === "forge").length).toBe(0);
  });
});
