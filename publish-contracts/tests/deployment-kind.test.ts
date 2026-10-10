// Issue 1727: the deployment kind. A Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) lowers the timelock delay floor to 900 s. Production (the default) keeps 172800 s.
// Every refusal has a boundary mutation: the value one step inside the bound passes. Nothing here reads the process environment for the kind.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOYMENT_KINDS, MAINNET_DELAY_FLOOR, REHEARSAL_DELAY_FLOOR, delayFloor, kindLabel, rehearsalDelayProblem } from "../src/chains.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { assertFloors } from "../src/floors.ts";
import { assertReleaseGate, tagForKind } from "../src/release-gate.ts";
import { REHEARSAL_TAG_SUFFIX, tagKind } from "../src/release-tag.ts";
import { PROOF_TX_NONCES, checkNonce, finalDeployerNonce } from "../src/counts.ts";
import { assertFreshSafeAddress, childEnv, newManifest, recordedStartNonce, runStartNonce, stageEnv, type RunContext } from "../src/runner.ts";
import { callerInputs, parseSheet } from "../src/sheet.ts";
import { DEPLOYER_STAGES, STAGE_NAMES, expectedStartNonce } from "../src/stages.ts";
import { COUNTS, REPO, SHA, sheetText, tmp } from "./fixtures.ts";
import { SCRIPT, world } from "./harness.ts";

const REH = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "20261010" };
const sheetFor = (chain: number, extra: Record<string, string | null> = {}) => parseSheet(sheetText({ CHAIN_ID: String(chain), EXPECTED_CHAIN_ID: String(chain), ...extra }));
const floorsInput = (chain: number, extra: Record<string, string | null> = {}) =>
  ({ rpcChainId: chain, sheet: sheetFor(chain, extra), caller: callerInputs({}), signerSpec: "keystore:/dev/shm/k/DEPLOYER", env: {}, environment: "mainnet", githubActions: false }) as Parameters<typeof assertFloors>[0];
const refusal = (f: () => void): string | undefined => { try { f(); } catch (e) { return `${(e as PublishError).kind}: ${(e as Error).message}`; } return undefined; };
const sheetError = (over: Record<string, string | null>): string => { try { parseSheet(sheetText(over)); return ""; } catch (e) { return (e as Error).message; } };

describe("the floors by kind", () => {
  test("the rehearsal floor is 900 s on every chain, production is 172800 s on 8453 and 1 s elsewhere (unchanged)", () => {
    expect(REHEARSAL_DELAY_FLOOR).toBe(900);
    expect(delayFloor(8453)).toBe(MAINNET_DELAY_FLOOR);
    expect(delayFloor(8453, "production")).toBe(172800);
    expect(delayFloor(918453, "production")).toBe(1);
    expect(delayFloor(8453, "rehearsal")).toBe(900);
    expect(delayFloor(918453, "rehearsal")).toBe(900);
  });
  test("a rehearsal delay is 900 up to 172799, nothing else", () => {
    expect(rehearsalDelayProblem(899)).toContain("below the rehearsal floor");
    expect(rehearsalDelayProblem(900)).toBe("");
    expect(rehearsalDelayProblem(172799)).toBe("");
    expect(rehearsalDelayProblem(172800)).toContain("production floor");
  });
  test("the label states the kind and the delay", () => {
    expect(kindLabel("rehearsal", 900)).toBe("[rehearsal 900s]");
    expect(kindLabel("production", 172800n)).toBe("[production 172800s]");
  });

  test("8453 with the rehearsal kind: 900 passes, 899 and 897 are refused (mutation: 900)", () => {
    expect(refusal(() => assertFloors(floorsInput(8453, { ...REH })))).toBeUndefined();
    for (const d of ["899", "897", "60", "1"]) expect(refusal(() => assertFloors(floorsInput(8453, { ...REH, TIMELOCK_MIN_DELAY: d })))).toBeDefined();
  });
  test("8453 production (no kind line): 900 and 897 are refused with FLOOR, 172799 is refused, 172800 passes (mutation: the floor is unchanged)", () => {
    for (const d of ["900", "897", "172799"]) expect(refusal(() => assertFloors(floorsInput(8453, { TIMELOCK_MIN_DELAY: d, GOVERN_NEW_DELAY: "172800" })))).toContain("FLOOR");
    expect(refusal(() => assertFloors(floorsInput(8453, { TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800" })))).toBeUndefined();
  });
  test("an explicit DEPLOYMENT_KIND=production is the same as no line", () => {
    expect(refusal(() => assertFloors(floorsInput(8453, { DEPLOYMENT_KIND: "production", TIMELOCK_MIN_DELAY: "900" })))).toContain("FLOOR");
    expect(parseSheet(sheetText({})).kind).toBe("production");
  });
  test("GOVERN_NEW_DELAY follows the mode floor too", () => {
    expect(refusal(() => assertFloors(floorsInput(8453, { ...REH, GOVERN_NEW_DELAY: "900" })))).toBeUndefined();
    expect(sheetError({ ...REH, GOVERN_NEW_DELAY: "899" })).toContain("GOVERN_NEW_DELAY");
    expect(sheetError({ ...REH, GOVERN_NEW_DELAY: "172800" })).toContain("production floor");
  });
  test("production GOVERN_NEW_DELAY keeps its 3600 lower bound", () => {
    expect(sheetError({ GOVERN_NEW_DELAY: "900" })).toContain("GOVERN_NEW_DELAY must be from 3600");
  });
  test("the kind is a sheet line only: a process environment variable named DEPLOYMENT_KIND changes nothing", () => {
    const before = process.env.DEPLOYMENT_KIND;
    process.env.DEPLOYMENT_KIND = "rehearsal";
    try {
      expect(parseSheet(sheetText({})).kind).toBe("production");
      expect(refusal(() => assertFloors(floorsInput(8453, { TIMELOCK_MIN_DELAY: "900" })))).toContain("FLOOR");
    } finally { if (before === undefined) delete process.env.DEPLOYMENT_KIND; else process.env.DEPLOYMENT_KIND = before; }
  });
  test("the child environment of forge never inherits DEPLOYMENT_KIND, and a stage gets the SHEET's kind", () => {
    const ctx = { baseEnv: { DEPLOYMENT_KIND: "rehearsal", PATH: "/bin" }, rpc: "http://x", chainId: 8453 };
    expect(childEnv(ctx).DEPLOYMENT_KIND).toBeUndefined();
    expect(childEnv(ctx).PATH).toBe("/bin");
    const w = world({});
    expect(w.sheetPath).toBeDefined();
  });
  test("an unknown kind, a lower case mismatch and a rehearsal without a Safe salt are sheet errors", () => {
    expect(sheetError({ ...REH, DEPLOYMENT_KIND: "Rehearsal" })).toContain("DEPLOYMENT_KIND must be production or rehearsal");
    expect(sheetError({ ...REH, DEPLOYMENT_KIND: "test" })).toContain("DEPLOYMENT_KIND");
    expect(sheetError({ ...REH, SAFE_SALT_NONCE: null })).toContain("needs an explicit SAFE_SALT_NONCE");
    expect(sheetError({ ...REH })).toBe(""); // mutation: with the salt the same sheet parses
    expect(sheetError({ ...REH, TIMELOCK_MIN_DELAY: "172800" })).toContain("production floor");
    expect(sheetError({ ...REH, TIMELOCK_MIN_DELAY: "899" })).toContain("below the rehearsal floor");
  });
  test("DEPLOYMENT_KIND is a whitelisted name, not a refused switch", () => {
    expect(DEPLOYMENT_KINDS).toEqual(["production", "rehearsal"]);
    expect(sheetError({ ...REH, REHEARSAL: "1" })).toContain("deleted"); // the old REHEARSAL switch stays deleted
  });
  test("the example rehearsal sheet for 8453 validates and passes the rehearsal floors", () => {
    const text = readFileSync(join(REPO, "deployments", "base-8453-rehearsal", "stage-sheet.example.env"), "utf8");
    const s = parseSheet(text);
    expect(s.kind).toBe("rehearsal");
    expect(s.chainId).toBe(8453);
    expect(s.timelockMinDelay).toBe(900n);
    expect(s.safeSalt).toBeDefined();
    expect(text).not.toMatch(/0x5E68a40648DD23065b21b1C414e1178ddE6482ca/i); // the first rehearsal's Safe is never the new one
    expect(text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")).not.toMatch(/PRIVATE_KEY|MNEMONIC|PASSPHRASE|keystore/i);
    expect(refusal(() => assertFloors({ rpcChainId: 8453, sheet: s, caller: callerInputs({}), signerSpec: "ledger", env: {}, environment: "mainnet", githubActions: false }))).toBeUndefined();
    // the same sheet as production is refused
    expect(refusal(() => assertFloors({ rpcChainId: 8453, sheet: parseSheet(text.replace(/^DEPLOYMENT_KIND=.*$/m, "")), caller: callerInputs({}), signerSpec: "ledger", env: {}, environment: "mainnet", githubActions: false }))).toBeDefined();
  });
});

describe("the release tag kind", () => {
  const tags = (...t: string[]) => async () => t;
  const gate = (kind: "production" | "rehearsal", found: string[]) =>
    assertReleaseGate({ sha: SHA, coreDir: "/x", countsDir: join(REPO, "no-such"), env: { GITHUB_TOKEN: "t" }, kind, releaseTags: tags(...found), remoteTag: async () => {}, checkShaGreen: async () => ({ code: 0, output: "" }) });
  test("a tag is a rehearsal tag only by the -rehearsal suffix; any other mention is ambiguous and satisfies neither", () => {
    expect(REHEARSAL_TAG_SUFFIX).toBe("-rehearsal");
    expect(tagKind("release/v0.4.0-base")).toBe("production");
    expect(tagKind("release/v0.5.0-rehearsal")).toBe("rehearsal");
    expect(tagKind("release/rehearsal-v0.5.0")).toBe("ambiguous");
    expect(tagKind("release/v0.5.0-Rehearsal")).toBe("ambiguous");
  });
  test("production + production tag and rehearsal + rehearsal tag are accepted", async () => {
    expect(await tagForKind({ sha: SHA, coreDir: "/x", kind: "production", releaseTags: tags("release/v1.0.0") })).toBe("release/v1.0.0");
    expect(await tagForKind({ sha: SHA, coreDir: "/x", kind: "rehearsal", releaseTags: tags("release/v1.0.0-rehearsal") })).toBe("release/v1.0.0-rehearsal");
  });
  test("production + rehearsal tag is refused with RELEASE_TAG_KIND, and so is rehearsal + production tag", async () => {
    await expect(tagForKind({ sha: SHA, coreDir: "/x", kind: "production", releaseTags: tags("release/v1.0.0-rehearsal") })).rejects.toMatchObject({ kind: "RELEASE_TAG_KIND", exitCode: EXIT_CODES.RELEASE_TAG_KIND });
    await expect(tagForKind({ sha: SHA, coreDir: "/x", kind: "rehearsal", releaseTags: tags("release/v1.0.0") })).rejects.toMatchObject({ kind: "RELEASE_TAG_KIND" });
    await expect(tagForKind({ sha: SHA, coreDir: "/x", kind: "production", releaseTags: tags("release/rehearsal-1") })).rejects.toMatchObject({ kind: "RELEASE_TAG_KIND" });
    expect(EXIT_CODES.RELEASE_TAG_KIND).not.toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
  });
  test("both tags at one sha: each kind finds its own", async () => {
    const both = tags("release/v1.0.0", "release/v1.0.0-rehearsal");
    expect(await tagForKind({ sha: SHA, coreDir: "/x", kind: "production", releaseTags: both })).toBe("release/v1.0.0");
    expect(await tagForKind({ sha: SHA, coreDir: "/x", kind: "rehearsal", releaseTags: both })).toBe("release/v1.0.0-rehearsal");
  });
  test("no tag at all is still RELEASE_SHA_UNTAGGED, and the message names the -rehearsal form for a rehearsal", async () => {
    expect(await tagForKind({ sha: SHA, coreDir: "/x", kind: "rehearsal", releaseTags: tags() })).toBeNull();
    await expect(gate("rehearsal", [])).rejects.toMatchObject({ kind: "RELEASE_SHA_UNTAGGED", message: expect.stringContaining("-rehearsal") });
  });
  test("the single-tag test seam is kind-checked too", async () => {
    await expect(tagForKind({ sha: SHA, coreDir: "/x", kind: "production", releaseTag: async () => "release/v1.0.0-rehearsal" })).rejects.toMatchObject({ kind: "RELEASE_TAG_KIND" });
  });
  test("the 8453 plan job refuses a mismatched tag before any signer exists (production sheet, rehearsal tag; rehearsal sheet, production tag) and accepts the right pairs", async () => {
    const plan = async (over: Record<string, string>, tag: string) => {
      const w = world({ chainId: 8453, sheet: over });
      let signerMade = false;
      const real = console.log; console.log = () => {};
      try { return { code: await w.run(["--stage", "plan", "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; throw new Error("no signer in plan"); }, releaseTag: async () => tag }), signerMade }; } finally { console.log = real; }
    };
    expect((await plan({}, "release/v1.0.0-rehearsal")).code).toBe(EXIT_CODES.RELEASE_TAG_KIND);
    expect((await plan(REH, "release/v1.0.0")).code).toBe(EXIT_CODES.RELEASE_TAG_KIND);
    expect((await plan({}, "release/v1.0.0")).code).toBe(0);
    const ok = await plan(REH, "release/v1.0.0-rehearsal");
    expect(ok.code).toBe(0);
    expect(ok.signerMade).toBe(false);
  });
});

describe("the deployer nonce relative to the recorded start (rehearsal), absolute from 0 (production)", () => {
  const D = ["safe", "libs", "recorder"];
  const rehearsalWorld = (startNonce: number) => world({ startNonce, sheet: REH });
  const manifestOf = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
  const failed = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
  const bump = (w: ReturnType<typeof world>, by = 1) => { const n = w.state().nonces["0x000000000000000000000000000000000000a001"]; w.setNonce(n + by); };

  test("a rehearsal from a deployer at nonce 118 runs every stage, records the start and checks the final nonce relative to it", async () => {
    const w = rehearsalWorld(118);
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const m = manifestOf(w);
    expect(m.deploymentKind).toBe("rehearsal");
    expect(m.deployerStartNonce).toBe(118);
    expect(m.stages.safe.startNonce).toBe(118);
    let n = 118;
    for (const s of DEPLOYER_STAGES) { if (s.name === "timelock") n += PROOF_TX_NONCES; expect(m.stages[s.name].startNonce).toBe(n); n += COUNTS[s.countKey!]!; }
    expect(w.state().nonces["0x000000000000000000000000000000000000a001"]).toBe(n);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.deployer_start_nonce === 118 && l.deployment_kind === "rehearsal")).toBe(true);
  });
  test("production from the same nonce 118 is refused: absolute accounting from 0 is unchanged", async () => {
    const w = world({ startNonce: 118 });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.NONCE);
    expect(w.state().calls.filter((c: any) => c.tool === "forge" && c.args.includes("--broadcast"))).toEqual([]);
  });
  test("production records no start nonce and writes kind production", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(manifestOf(w).deployerStartNonce).toBeUndefined();
    expect(manifestOf(w).deploymentKind).toBe("production");
  });
  test("a stray deployer transaction BEFORE the first stage after the start was recorded is refused", async () => {
    const w = rehearsalWorld(118);
    expect(await w.run(["--stage", "safe"])).toBe(0);
    // forget the stage record, keep the recorded start: only the chain says a transaction left the deployer
    const m = manifestOf(w); delete m.stages.safe; writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify(m));
    bump(w, 0); // nonce is 119 after the Safe; the recorded start is 118 and no stage claims it
    expect(await w.run(["--stage", "safe", "--resume"])).toBe(EXIT_CODES.NONCE);
  });
  test("a stray transaction BETWEEN stages is refused before the next stage broadcasts", async () => {
    const w = rehearsalWorld(118);
    expect(await w.run(["--stage", "safe,libs"])).toBe(0);
    bump(w);
    expect(await w.run(["--stage", "recorder", "--resume"])).toBe(EXIT_CODES.NONCE);
    expect(failed(w)!.message).toContain("expected");
    expect(w.state().calls.filter((c: any) => c.tool === "forge" && c.args.includes("--broadcast") && String(c.args[1]).includes(SCRIPT.recorder!.replace(/\.s\.sol$/, "")))).toEqual([]);
  });
  test("mutation: with no stray the same resume succeeds", async () => {
    const w = rehearsalWorld(118);
    expect(await w.run(["--stage", "safe,libs"])).toBe(0);
    expect(await w.run(["--stage", "recorder", "--resume"])).toBe(0);
  });
  test("a stray transaction AFTER the last stage fails the end-of-deploy relative check", () => {
    const counts = { safe: 1, libs: 4 };
    const end = 118 + 5 + PROOF_TX_NONCES;
    expect(() => checkNonce(end, counts, undefined, 118)).not.toThrow();
    expect(() => checkNonce(end + 1, counts, undefined, 118)).toThrow(/NONCE|start nonce 118/);
    expect(() => checkNonce(end - 1, counts, undefined, 118)).toThrow();
    expect(() => checkNonce(end, counts)).toThrow(); // read as production (start 0) the same nonce is wrong
    expect(finalDeployerNonce(counts, 118)).toBe(end);
    expect(finalDeployerNonce(counts)).toBe(5 + PROOF_TX_NONCES);
  });
  test("expectedStartNonce is the start plus the earlier counts (plus the proof after it), and 0-based by default", () => {
    expect(expectedStartNonce("libs", COUNTS)).toBe(expectedStartNonce("libs", COUNTS, 0));
    for (const s of STAGE_NAMES.filter((x) => DEPLOYER_STAGES.some((d) => d.name === x))) expect(expectedStartNonce(s, COUNTS, 118)).toBe(expectedStartNonce(s, COUNTS) + 118);
  });
  test("the recorded start cannot be rewritten: editing it after a stage ran is refused", async () => {
    const w = rehearsalWorld(118);
    expect(await w.run(["--stage", "safe"])).toBe(0);
    const m = manifestOf(w); m.deployerStartNonce = 119; writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify(m));
    expect(await w.run(["--stage", "libs", "--resume"])).toBe(EXIT_CODES.NONCE);
    expect(failed(w)!.message).toContain("never rewritten");
  });
  test("a rehearsal manifest without a start, resumed at a later stage, is refused (the start is recorded at the first stage only)", async () => {
    const w = rehearsalWorld(118);
    expect(await w.run(["--stage", "safe"])).toBe(0);
    const m = manifestOf(w); delete m.deployerStartNonce; writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify(m));
    expect(await w.run(["--stage", "libs", "--resume"])).toBe(EXIT_CODES.NONCE);
    expect(failed(w)!.message).toContain("no deployerStartNonce");
  });
  test("a run never changes kind: a production sheet cannot resume a rehearsal manifest, nor the reverse", async () => {
    const w = rehearsalWorld(118);
    expect(await w.run(["--stage", "safe"])).toBe(0);
    const prod = world({ dir: w.dir, startNonce: 119 });
    expect(await prod.run(["--stage", "libs", "--resume"])).toBe(EXIT_CODES.RESUME);
    expect(failed(prod)!.message).toContain("rehearsal run");
  });
  test("runStartNonce and recordedStartNonce: production is always 0 and writes nothing", () => {
    const sheet = parseSheet(sheetText({}));
    const ctx = { sheet, dryRun: false, evidenceDir: "/nonexistent", log: { log() {} } } as never;
    const m = { stages: {} } as never;
    expect(runStartNonce(ctx, m, { name: "safe" }, 118)).toBe(0);
    expect((m as { deployerStartNonce?: number }).deployerStartNonce).toBeUndefined();
    expect(recordedStartNonce("production", { deployerStartNonce: 118 })).toBe(0);
    expect(recordedStartNonce("rehearsal", { deployerStartNonce: 118 })).toBe(118);
    expect(() => recordedStartNonce("rehearsal", {})).toThrow(PublishError);
  });
});

describe("the Safe predicted for a rehearsal must be new", () => {
  const ctx = (code: string, over: Record<string, unknown> = {}) => ({ sheet: parseSheet(sheetText(REH)), chainId: 8453, rpc: "http://x", baseEnv: {}, resume: false, run: async () => ({ code: 0, stdout: code, stderr: "" }), ...over }) as unknown as RunContext;
  const PREDICTED = "0x00000000000000000000000000000000000050fe";
  test("a predicted address that holds code is refused with a named error that says to change SAFE_SALT_NONCE", async () => {
    await expect(assertFreshSafeAddress(ctx("0x6001"), undefined, PREDICTED)).rejects.toMatchObject({ kind: "SAFE", message: expect.stringContaining("SAFE_SALT_NONCE_REUSED") });
    await expect(assertFreshSafeAddress(ctx("0x6001"), undefined, PREDICTED)).rejects.toMatchObject({ message: expect.stringContaining("change SAFE_SALT_NONCE") });
  });
  test("mutation: an empty address passes, and so does the resume of the SAME run that recorded this address", async () => {
    await expect(assertFreshSafeAddress(ctx("0x"), undefined, PREDICTED)).resolves.toBeUndefined();
    await expect(assertFreshSafeAddress(ctx(""), undefined, PREDICTED)).resolves.toBeUndefined();
    await expect(assertFreshSafeAddress(ctx("0x6001", { resume: true }), { status: "started", startedAt: "", safe: PREDICTED.toUpperCase().replace("0X", "0x") }, PREDICTED)).resolves.toBeUndefined();
    // a resume with a DIFFERENT recorded address does not excuse existing code
    await expect(assertFreshSafeAddress(ctx("0x6001", { resume: true }), { status: "started", startedAt: "", safe: "0x00000000000000000000000000000000000000aa" }, PREDICTED)).rejects.toMatchObject({ kind: "SAFE" });
  });
  test("production does not read the chain for it", async () => {
    const c = { ...ctx("0x6001"), sheet: parseSheet(sheetText({})), run: async () => { throw new Error("no read in production"); } } as unknown as RunContext;
    await expect(assertFreshSafeAddress(c, undefined, PREDICTED)).resolves.toBeUndefined();
  });
  test("through the runner: a rehearsal run whose Safe address holds code stops at the Safe stage with SAFE before anything is sent", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    w.cfg.emptyCode = []; // the predicted Safe address holds code (the first rehearsal's Safe)
    const code = await w.run(["--stage", "safe"]);
    expect(code).toBe(EXIT_CODES.SAFE);
    expect(w.logs().filter((l) => l.event === "run.failed").pop()!.message).toContain("SAFE_SALT_NONCE_REUSED");
  });
});

describe("the kind reaches the stage scripts only from the sheet", () => {
  test("stageEnv carries DEPLOYMENT_KIND from the sheet for every stage", () => {
    const row = { name: "timelock", requiredEnv: [], optionalEnv: [], manifest: null, libraries: [] } as never;
    const mk = (over: Record<string, string>) => ({ sheet: parseSheet(sheetText(over)), chainId: 918453, coreSha: SHA, coreDir: "/x", manifestOut: tmp(), baseEnv: { DEPLOYMENT_KIND: "rehearsal" } }) as unknown as RunContext;
    expect(stageEnv(mk(REH), row).DEPLOYMENT_KIND).toBe("rehearsal");
    expect(stageEnv(mk({}), row).DEPLOYMENT_KIND).toBe("production");
  });
});
