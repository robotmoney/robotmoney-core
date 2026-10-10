// Libs-stage adoption (issue 1721): the libs simulation plans ZERO transactions because the CREATE2 library already sits on chain.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { PROOF_TX_NONCES, checkNonce, effectiveCounts, finalDeployerNonce } from "../src/counts.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { CREATE2_FACTORY, expectedLibraryRuntime, predictedLibraryAddress } from "../src/libs-adopt.ts";
import { adoptedTxs } from "../src/runner.ts";
import { driftErrors } from "../src/counts-drift.ts";
import { adoptedFromRunManifest, buildCountsJson, checkCountsJson } from "../src/ci/rehearsal-counts.ts";
import { freezeCounts } from "../scripts/freeze-counts.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { COUNTS, SHA } from "./fixtures.ts";
import { loadFrozen, resolveCounts } from "../src/counts.ts";
import { LOCAL_RPC, SCRIPT, world, type World } from "./harness.ts";

const OUT_FIXTURE = join(import.meta.dir, "fixtures", "build-out");
const ART = JSON.parse(readFileSync(join(OUT_FIXTURE, "TickMath.sol", "TickMath.json"), "utf8")) as { bytecode: { object: Hex }; deployedBytecode: { object: string } };
/** The library address on Base mainnet (block 52401633): the CREATE2 address of the build below. */
const MAINNET_TICKMATH: Address = "0x3353854084194AE5Cc1697a9E4337806ECcdD9F6";
const ADDR = predictedLibraryAddress(ART.bytecode.object);
// built here by hand, not with the function under test: the library's runtime code is its artifact with PUSH20 <its own address> at bytes 1 to 20
const withSelf = (a: string): Hex => `0x73${a.slice(2).toLowerCase()}${ART.deployedBytecode.object.slice(44)}` as Hex;
const RUNTIME = withSelf(ADDR);
const A = "0x000000000000000000000000000000000000a001";
const manifest = (w: World) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const lastError = (w: World) => w.logs().filter((l) => l.event === "run.failed").pop();
const forgeScripts = (w: World) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script");
const broadcastsOf = (w: World, file: string) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast") && c.args[1].includes(file));

/** A world whose libs script plans zero transactions and whose chain holds `code` at the library address the build predicts. */
function adoptWorld(o: { code?: string; address?: string; bumps?: number; startNonce?: number; writeFrozen?: boolean; chainId?: number } = {}): World {
  const w = world({ startNonce: o.startNonce ?? 0, writeFrozen: o.writeFrozen, chainId: o.chainId });
  mkdirSync(join(w.coreDir, "out", "TickMath.sol"), { recursive: true });
  writeFileSync(join(w.coreDir, "out", "TickMath.sol", "TickMath.json"), JSON.stringify(ART));
  const at = o.address ?? ADDR;
  Object.assign(w.cfg, { zeroTx: SCRIPT.libs, libsAddress: at, zeroTxBumps: o.bumps, codeAt: { [at.toLowerCase()]: o.code ?? RUNTIME } });
  return w;
}

describe("the CREATE2 library address and runtime code", () => {
  test("the build's address through the Arachnid factory is the Base mainnet TickMath", () => {
    expect(CREATE2_FACTORY).toBe("0x4e59b44847b379578588920cA78FbF26c0B4956C");
    expect(ADDR).toBe(MAINNET_TICKMATH);
  });
  test("the expected runtime code is the artifact with the library's own address filled in", () => {
    expect(expectedLibraryRuntime(ART.deployedBytecode.object, ADDR)).toBe(RUNTIME);
    expect(RUNTIME.slice(0, 4)).toBe("0x73");
    expect(RUNTIME.slice(4, 44)).toBe(ADDR.slice(2).toLowerCase());
    expect(RUNTIME.length).toBe(ART.deployedBytecode.object.length);
  });
});

describe("a libs stage that plans zero transactions", () => {
  test("is ADOPTED when the predicted address holds the build's runtime code hash: manifest records it, no dry-run file, nothing broadcast for libs, the rest of the deploy runs", async () => {
    const w = adoptWorld();
    const code = await w.run(["--stage", "deploy"]);
    expect(lastError(w)).toBeUndefined();
    expect(code).toBe(0);
    const libs = manifest(w).stages.libs;
    expect(libs).toMatchObject({ status: "done", adopted: true, count: COUNTS.libs, dryRunCount: 0, startNonce: COUNTS.safe, endNonce: COUNTS.safe });
    expect(libs.adoption).toMatchObject({ deployerTxs: 0, factory: CREATE2_FACTORY });
    expect(libs.adoption.libraries).toEqual([{ name: "tick_math", artifact: "TickMath", address: ADDR, codeHash: keccak256(RUNTIME) }]);
    expect(broadcastsOf(w, SCRIPT.libs)).toEqual([]);
    expect(existsSync(join(w.coreDir, "broadcast", SCRIPT.libs))).toBe(false); // no dry-run file and no broadcast file: forge wrote none
    expect(w.logs().some((l) => l.event === "stage.libs_adopted")).toBe(true);
    expect(manifest(w).stages.timelock.status).toBe("done");
  });

  test("the deployer nonce is the summed frozen counts MINUS the libs count PLUS the prove-control transaction, and the end-of-deploy check accepts it", async () => {
    const w = adoptWorld();
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
    const want = sum - COUNTS.libs! + PROOF_TX_NONCES;
    expect(w.state().nonces[A]).toBe(want);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.nonce === want && l.summed_frozen_counts === sum - COUNTS.libs!)).toBe(true);
    const m = manifest(w);
    expect(m.stages.recorder.startNonce).toBe(COUNTS.safe); // the next stage starts where libs started: libs contributed 0
    expect(m.stages.timelock.startNonce).toBe(want - COUNTS.timelock!);
  });

  test("a stray extra deployer transaction after an adopted libs stage is still detected at the end-of-deploy check", async () => {
    const w = adoptWorld();
    w.cfg.sent = { [SCRIPT.timelock]: COUNTS.timelock! + 1 }; // the timelock stage's broadcast sends one transaction more than its frozen count
    expect(await w.run(["--stage", "deploy"])).not.toBe(0);
    const e = lastError(w);
    expect(e?.kind === "COUNT_MISMATCH" || e?.kind === "NONCE").toBe(true);
  });

  test("a stray transaction BEFORE the libs stage is refused by the start-nonce check, adopted or not", async () => {
    const w = adoptWorld({ startNonce: 5 });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.NONCE);
  });

  test("a resume where the deployer's own libs transaction had already landed is adopted at the whole frozen count: the normal nonce sum holds", async () => {
    const w = adoptWorld({ bumps: COUNTS.libs });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(manifest(w).stages.libs.adoption.deployerTxs).toBe(COUNTS.libs);
    const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
    expect(w.state().nonces[A]).toBe(sum + PROOF_TX_NONCES);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.summed_frozen_counts === sum)).toBe(true);
  });

  test("a deployer nonce that moved by some other amount (a partial or stray transaction) is refused: NONCE, nothing recorded as done", async () => {
    const w = adoptWorld({ bumps: 2 });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.NONCE);
    expect(manifest(w).stages.libs?.status).not.toBe("done");
  });

  test("other code at the predicted address is refused with LIBS_ADOPTION and nothing is sent", async () => {
    const w = adoptWorld({ code: RUNTIME.slice(0, -2) + (RUNTIME.endsWith("00") ? "01" : "00") });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(lastError(w)?.message).toContain("is not the build's tick_math");
    expect(forgeScripts(w).filter((c: any) => c.args.includes("--broadcast"))).toEqual([]);
    expect(manifest(w).stages.libs).toBeUndefined();
  });

  test("code with the right bytes but another library address filled in is refused (the self-address is part of the hash)", async () => {
    const other = withSelf("0x000000000000000000000000000000000000dead");
    const w = adoptWorld({ code: other });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
  });

  test("no code at the address with zero planned transactions is refused with LIBS_ADOPTION", async () => {
    const w = adoptWorld({ code: "0x" });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(lastError(w)?.message).toContain("NO code");
    expect(forgeScripts(w).filter((c: any) => c.args.includes("--broadcast"))).toEqual([]);
  });

  test("an address the build does not predict is refused even if it holds the right code", async () => {
    const w = adoptWorld({ address: "0x000000000000000000000000000000000000dead", code: RUNTIME });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
    expect(lastError(w)?.message).toContain("does not commit to this build");
  });

  test("a missing build artifact is refused with LIBS_ADOPTION", async () => {
    const w = adoptWorld();
    rmOut(w);
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.LIBS_ADOPTION);
  });

  test("a forge non-zero exit is still SIMULATION, never adopted", async () => {
    const w = adoptWorld();
    w.cfg.simFails = SCRIPT.libs;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SIMULATION);
  });

  test("only the libs stage can be adopted: another stage that plans zero transactions is still a SIMULATION failure", async () => {
    const w = adoptWorld();
    w.cfg.zeroTx = SCRIPT.recorder;
    w.cfg.libsAddress = undefined;
    // libs runs normally (SIMULATION COMPLETE), then the recorder stage prints no SIMULATION COMPLETE
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SIMULATION);
  });

  test("the normal path is unchanged: a libs stage that sends its frozen count is not adopted", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(manifest(w).stages.libs.adopted).toBeUndefined();
    expect(manifest(w).stages.libs.adoption).toBeUndefined();
    expect(manifest(w).stages.libs.broadcastCount).toBe(COUNTS.libs);
    expect(w.state().nonces[A]).toBe(Object.values(COUNTS).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES);
  });

  test("a dry run adopts too, sends nothing and persists no run manifest", async () => {
    const w = adoptWorld();
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    expect(w.logs().some((l) => l.event === "stage.libs_adopted")).toBe(true);
    expect(forgeScripts(w).filter((c: any) => c.args.includes("--broadcast") && c.rpcEnv !== LOCAL_RPC)).toEqual([]);
  });

  test("a measuring run (no frozen file) adopts, measures libs as 0 and writes the counts file", async () => {
    const w = adoptWorld({ writeFrozen: false });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    writeFileSync(join(w.dir, "c.json"), JSON.stringify({ deploySha: SHA }));
    const f = JSON.parse(readFileSync(join(w.countsDir, `${"a".repeat(40)}.json`), "utf8"));
    expect(f.counts.libs).toBe(0);
    expect(manifest(w).stages.libs.adoption.deployerTxs).toBe(0);
    // the raw counts file is MARKED: it is never a frozen file (loadFrozen, the release gate and the drift check refuse it)
    expect(f.measured.adopted).toEqual(["libs"]);
    expect(() => loadFrozen(w.countsDir, SHA)).toThrow("ADOPTED stage(s) libs");
    // the Twin run's own follow-on verbs (verify, govern) read the file back; 8453 never does
    expect(resolveCounts({ dir: w.countsDir, sha: SHA, measureFlag: false, dryRun: false, chainId: 918453 }).frozen?.libs).toBe(0);
    expect(() => resolveCounts({ dir: w.countsDir, sha: SHA, measureFlag: false, dryRun: false, chainId: 8453 })).toThrow("ADOPTED stage(s) libs");
    expect(loadFrozen(w.countsDir, SHA, { allowAdopted: true }).counts.libs).toBe(0);
    const drift = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "counts-drift.ts"), "--counts", join(w.dir, "c.json"), "--frozen-dir", w.countsDir], { stderr: "pipe" });
    expect(drift.exitCode).toBe(1);
    expect(drift.stderr.toString()).toContain("not a frozen file");
  });

  test("a measuring run that adopts nothing writes an unmarked file that loads as frozen", async () => {
    const w = world({ startNonce: 0, writeFrozen: false });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const f = JSON.parse(readFileSync(join(w.countsDir, `${"a".repeat(40)}.json`), "utf8"));
    expect(f.measured.adopted).toBeUndefined();
    expect(loadFrozen(w.countsDir, SHA).counts).toEqual(COUNTS);
  });

  test("resume skips an adopted stage, and an adopted record counts for the start nonce of the later stages", async () => {
    const w = adoptWorld({ startNonce: COUNTS.safe });
    expect(await w.run(["--stage", "libs"])).toBe(0);
    const before = forgeScripts(w).length;
    expect(await w.run(["--stage", "libs", "--resume"])).toBe(0);
    expect(forgeScripts(w).length).toBe(before); // done in the run manifest: skipped
  });
});

function rmOut(w: World): void {
  rmSync(join(w.coreDir, "out"), { recursive: true, force: true });
}

describe("nonce accounting for an adopted stage", () => {
  const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
  test("effectiveCounts replaces the adopted stage's count and leaves everything else; nothing adopted returns the same object", () => {
    expect(effectiveCounts(COUNTS)).toBe(COUNTS as Record<string, number>);
    expect(effectiveCounts(COUNTS, {})).toBe(COUNTS as Record<string, number>);
    const e = effectiveCounts(COUNTS, { libs: 0 });
    expect(e.libs).toBe(0);
    expect({ ...e, libs: COUNTS.libs } as Record<string, number>).toEqual(COUNTS);
    expect(finalDeployerNonce(e)).toBe(sum(COUNTS) - COUNTS.libs! + PROOF_TX_NONCES);
  });
  test("the adopted deployer transactions cannot exceed the frozen count, be negative or fractional, or name an unknown stage", () => {
    expect(() => effectiveCounts(COUNTS, { libs: COUNTS.libs! + 1 })).toThrow("outside 0 to its count");
    expect(() => effectiveCounts(COUNTS, { libs: -1 })).toThrow();
    expect(() => effectiveCounts(COUNTS, { libs: 0.5 })).toThrow();
    expect(() => effectiveCounts(COUNTS, { nonesuch: 0 })).toThrow("no frozen count");
  });
  test("checkNonce on the effective counts accepts the adopted nonce, refuses a stray extra transaction and refuses the un-adjusted sum", () => {
    const e = effectiveCounts(COUNTS, { libs: 0 });
    const ok = sum(COUNTS) - COUNTS.libs! + PROOF_TX_NONCES;
    expect(() => checkNonce(ok, e)).not.toThrow();
    expect(() => checkNonce(ok + 1, e)).toThrow("deployer nonce");
    expect(() => checkNonce(ok - 1, e)).toThrow("deployer nonce");
    expect(() => checkNonce(sum(COUNTS) + PROOF_TX_NONCES, e)).toThrow("deployer nonce");
  });
  test("adoptedTxs reads done and adopted stages only (the prove-control record's own adopted flag is not an adopted count)", () => {
    expect(adoptedTxs({ stages: {
      libs: { status: "done", adopted: true, adoption: { deployerTxs: 0, factory: CREATE2_FACTORY, libraries: [] }, startedAt: "x" },
      "prove-control": { status: "done", adopted: true, startedAt: "x" },
      recorder: { status: "started", adopted: true, adoption: { deployerTxs: 0, factory: CREATE2_FACTORY, libraries: [] }, startedAt: "x" },
    } })).toEqual({ libs: 0 });
  });
});

describe("counts.json, the drift check and freeze-counts with an adopted stage", () => {
  const keys = Object.keys(COUNTS);
  const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
  const json = (over: Record<string, unknown> = {}) => ({ deploySha: "a".repeat(40), chainId: 918453, counts: COUNTS, deployerNonce: sum - COUNTS.libs! + PROOF_TX_NONCES, adopted: { libs: { deployerTxs: 0 } }, ...over });
  test("counts.json check: the nonce is the sum of the counts with the adopted stage at the transactions the deployer sent", () => {
    expect(checkCountsJson(json() as never, keys)).toEqual([]);
    expect(checkCountsJson(json({ deployerNonce: sum + PROOF_TX_NONCES }) as never, keys).join()).toContain("differs from the sum of counts");
    expect(checkCountsJson(json({ deployerNonce: sum - COUNTS.libs! + PROOF_TX_NONCES + 1 }) as never, keys).join()).toContain("differs from the sum of counts");
  });
  test("counts.json check: without an adopted entry the old rule holds byte for byte", () => {
    expect(checkCountsJson({ deploySha: "a".repeat(40), chainId: 918453, counts: COUNTS, deployerNonce: sum + PROOF_TX_NONCES }, keys)).toEqual([]);
    expect(checkCountsJson({ deploySha: "a".repeat(40), chainId: 918453, counts: COUNTS, deployerNonce: sum - COUNTS.libs! + PROOF_TX_NONCES }, keys).join()).toContain("differs from the sum of counts");
  });
  test("counts.json check: adopted deployerTxs above the stage count is refused", () => {
    expect(checkCountsJson(json({ adopted: { libs: { deployerTxs: COUNTS.libs! + 1 } } }) as never, keys).join()).toContain("outside 0 to its count");
  });
  test("build reads the adopted stages from the run manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-adopt-"));
    const mf = join(dir, "publish-run.json");
    writeFileSync(mf, JSON.stringify({ stages: { libs: { status: "done", adopted: true, adoption: { deployerTxs: 0 } }, "prove-control": { status: "done", adopted: true }, safe: { status: "done" } } }));
    expect(adoptedFromRunManifest(mf)).toEqual({ libs: { deployerTxs: 0 } });
    const cdir = join(dir, "counts");
    mkdirSync(cdir);
    writeFileSync(join(cdir, `${"a".repeat(40)}.json`), JSON.stringify({ deploySha: "a".repeat(40), measured: { chainId: 918453, at: "x" }, counts: COUNTS }));
    expect(buildCountsJson(cdir, "a".repeat(40), 7, adoptedFromRunManifest(mf)).adopted).toEqual({ libs: { deployerTxs: 0 } });
    expect(adoptedFromRunManifest(join(dir, "missing.json"))).toEqual({});
    expect("adopted" in buildCountsJson(cdir, "a".repeat(40), 7)).toBe(false);
  });
  test("drift: an adopted stage is not compared, every other stage still is", () => {
    const measured = { ...COUNTS, libs: 0 };
    expect(driftErrors(measured, COUNTS).join()).toContain("stage libs");
    expect(driftErrors(measured, COUNTS, ["libs"])).toEqual([]);
    expect(driftErrors({ ...measured, vault: 1 }, COUNTS, ["libs"]).join()).toContain("stage vault");
  });
  test("freeze-counts refuses a counts.json with an adopted stage: its count was not measured", () => {
    const p = join(mkdtempSync(join(tmpdir(), "pc-adopt-")), "counts.json");
    writeFileSync(p, JSON.stringify(json({ rehearsal: { conclusion: "success" } })));
    expect(() => freezeCounts(p, mkdtempSync(join(tmpdir(), "pc-adopt-")))).toThrow("were adopted");
  });
});
