// pause-all (core 1619, plan decision 22): a failed verify or postflight pauses deposits on ALL FOUR vaults, rmUSDC included.
// What is real here: the CLI, the stage order, the signer choice, the argument vector of every `cast send`, the read-back and the rollout report file.
// What is a fake: the chain. A recording `cast send` / `cast call` stands in for the node (every other tool call goes to the stub forge and cast).
// The vaults themselves, the real keys and a real redeem on every paused vault are the Twin rehearsal: testing/smoke-test/tests/twin_pause_all.rs (suite 14).
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";
import { EMERGENCY_ROLE, pauseSignerRole, rolloutReportPath } from "../src/pause-all.ts";
import { spawnTool, type ProcessRunner } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { manifestBase } from "../src/stage-table.ts";
import { getStageTable } from "../src/stages.ts";
import { VAULT_NAME } from "../src/sheet.ts";
import type { PublishSigner } from "../src/signer.ts";
import { MANIFEST_ADAPTER, SHA, sheetText } from "./fixtures.ts";
import { ADMIN, SCRIPT, world } from "./harness.ts";

const sheet = parseSheet(sheetText());
const EMERGENCY = sheet.emergency;
const DEPLOYER_KS = "/dev/shm/stub/DEPLOYER"; // the world's default --signer
const DEPLOYER_SPEC = `keystore:${DEPLOYER_KS}`;
const EMERGENCY_SPEC = "keystore:/k/EMERGENCY";
const vaultAddr = (i: number): string => `0x00000000000000000000000000000000000b${(i + 1).toString(16).padStart(3, "0")}`;
const VAULTS = getStageTable().vaults;

/** A signer that names its keystore in the flags, so a test reads WHICH key `cast send` was given. */
function signerFor(spec: string): PublishSigner {
  const address = spec === EMERGENCY_SPEC ? EMERGENCY : ADMIN;
  const path = spec.slice("keystore:".length);
  return { spec, kind: "keystore", cleanup() {}, async address() { return address as `0x${string}`; }, async forgeArgs() { return ["--keystore", path, "--sender", address]; }, async safeSigner() { return { kind: "keystore", modes: ["raw"], address: async () => address } as never; } };
}

interface Send { to: string; keystore?: string; from?: string }
interface Chain { paused: Record<string, boolean>; sends: Send[]; failSendTo?: string; emergencyHolds: Set<string> }
const newChain = (): Chain => ({ paused: {}, sends: [], emergencyHolds: new Set() });

/** `cast send pauseDeposits()` flips the flag and records its signer flags, `cast call` reads it. Every other tool call goes to the stubs on PATH. */
function chainRunner(c: Chain): ProcessRunner {
  return async (tool, args, opts) => {
    if (tool === "cast" && args[0] === "send") {
      const to = args[1]!;
      expect(args[2]).toBe("pauseDeposits()");
      c.sends.push({ to, keystore: args[args.indexOf("--keystore") + 1], from: args[args.indexOf("--from") + 1] });
      if (c.failSendTo === to) return { code: 1, stdout: "", stderr: "Error: execution reverted: AccessControl" };
      c.paused[to] = true;
      return { code: 0, stdout: JSON.stringify({ status: "0x1", transactionHash: `0x${"ab".repeat(32)}` }) + "\n", stderr: "" };
    }
    if (tool === "cast" && args[0] === "call" && args[2] === "depositsPaused()(bool)") return { code: 0, stdout: `${c.paused[args[1]!] === true}\n`, stderr: "" };
    if (tool === "cast" && args[0] === "call" && args[2] === "hasRole(bytes32,address)(bool)") {
      expect(args[3]).toBe(EMERGENCY_ROLE);
      return { code: 0, stdout: `${args[4]!.toLowerCase() === ADMIN ? !c.emergencyHolds.has(args[1]!) : c.emergencyHolds.has(args[1]!)}\n`, stderr: "" };
    }
    return spawnTool(tool, args, opts);
  };
}

/** The vault manifests of a finished deploy (one per table vault, distinct addresses), and a run manifest with the given stage records. */
function seed(w: ReturnType<typeof world>, stages: Record<string, unknown>): void {
  const m = join(w.coreDir, "deployments", "918453");
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "safe.json"), JSON.stringify({ safe: "0x00000000000000000000000000000000000050fe" }));
  VAULTS.forEach((v, i) => writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: 918453, vault: vaultAddr(i), adapter: MANIFEST_ADAPTER })));
  mkdirSync(w.evidence, { recursive: true });
  writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify({ version: 1, chainId: 918453, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "t", firstBlock: 7, stages }));
}
const rec = (status: "done" | "started") => ({ status, startedAt: "t" });
const BEFORE_HANDOVER = { safe: rec("done"), "prove-control": rec("done") };
const AFTER_HANDOVER = { ...BEFORE_HANDOVER, timelock: rec("done") };

const deps = (c: Chain) => ({ run: chainRunner(c), makeSigner: signerFor });
const report = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(rolloutReportPath({ evidenceDir: w.evidence, chainId: 918453 }), "utf8"));
const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
const failingVerifier = { verifyDeployment: (async () => ({ ok: false, checks: [{ label: "safe: nonce at least 1", ok: false, detail: "forced" }] })) as never };

describe("pause-all: the signer is chosen by stage", () => {
  test("pauseSignerRole: the deployer until the timelock stage has run, the EMERGENCY key once it is done", () => {
    expect(pauseSignerRole({ stages: {} })).toBe("deployer");
    expect(pauseSignerRole({ stages: BEFORE_HANDOVER } as never)).toBe("deployer");
    expect(pauseSignerRole({ stages: { timelock: rec("started") } } as never)).toBe("unsure");
    expect(pauseSignerRole({ stages: AFTER_HANDOVER } as never)).toBe("emergency");
  });

  test("before the stage 11 handover the DEPLOYER signs all four sends", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    expect(await w.run(["pause-all"], deps(c))).toBe(0);
    expect(c.sends).toHaveLength(4);
    for (const s of c.sends) expect(s).toMatchObject({ keystore: DEPLOYER_KS, from: ADMIN });
  });

  test("after the handover the EMERGENCY key signs all four sends, never the deployer", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, AFTER_HANDOVER);
    expect(await w.run(["pause-all", "--emergency-signer", EMERGENCY_SPEC], deps(c))).toBe(0);
    expect(c.sends).toHaveLength(4);
    for (const s of c.sends) expect(s).toMatchObject({ keystore: "/k/EMERGENCY", from: EMERGENCY });
  });

  test("after the handover with no EMERGENCY key: refused with SIGNER before anything is sent", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, AFTER_HANDOVER);
    expect(await w.run(["pause-all"], deps(c))).toBe(EXIT_CODES.SIGNER);
    expect(lastError(w).message).toContain("--emergency-signer");
    expect(c.sends).toEqual([]);
  });

  test("a signer that is not the sheet's EMERGENCY_ADDRESS is refused", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, AFTER_HANDOVER);
    // the deployer's keystore given as the emergency key: its address is ADMIN_ADDRESS, not EMERGENCY_ADDRESS
    expect(await w.run(["pause-all", "--emergency-signer", DEPLOYER_SPEC], deps(c))).toBe(EXIT_CODES.SIGNER);
    expect(c.sends).toEqual([]);
  });

  test("a handover that started but did not finish: each vault takes the key that holds EMERGENCY_ROLE on it now", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, { ...BEFORE_HANDOVER, timelock: rec("started") });
    c.emergencyHolds.add(vaultAddr(1)).add(vaultAddr(3)); // rmPROTO and rmRWA were already moved
    expect(await w.run(["pause-all", "--emergency-signer", EMERGENCY_SPEC], deps(c))).toBe(0);
    expect(c.sends.map((s) => [s.to, s.keystore])).toEqual([[vaultAddr(0), DEPLOYER_KS], [vaultAddr(1), "/k/EMERGENCY"], [vaultAddr(2), DEPLOYER_KS], [vaultAddr(3), "/k/EMERGENCY"]]);
  });
});

describe("pause-all: all four vaults, read back, in the rollout report", () => {
  test("every vault is paused, rmUSDC included, and the report records each vault's depositsPaused", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, AFTER_HANDOVER);
    expect(await w.run(["pause-all", "--emergency-signer", EMERGENCY_SPEC], deps(c))).toBe(0);
    expect(c.sends.map((s) => s.to)).toEqual(VAULTS.map((_, i) => vaultAddr(i)));
    const r = report(w);
    expect(r).toMatchObject({ chainId: 918453, coreSha: SHA });
    expect(r.pauseAll).toMatchObject({ trigger: "manual", allPaused: true });
    expect(r.pauseAll.vaults.map((v: any) => v.vault)).toEqual(["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]);
    expect(VAULTS.map((v) => VAULT_NAME[v.key])).toEqual(["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]);
    for (const v of r.pauseAll.vaults) expect(v).toMatchObject({ depositsPaused: true, signerRole: "emergency", signer: EMERGENCY, txHash: `0x${"ab".repeat(32)}` });
  });

  test("one send fails: the other three are still paused, the report says which vault is open, the exit is PAUSE", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    c.failSendTo = vaultAddr(0); // rmUSDC
    expect(await w.run(["pause-all"], deps(c))).toBe(EXIT_CODES.PAUSE);
    expect(EXIT_CODES.PAUSE).toBe(25);
    expect(c.sends).toHaveLength(4);
    const vaults = report(w).pauseAll.vaults;
    expect(vaults.map((v: any) => v.depositsPaused)).toEqual([false, true, true, true]);
    expect(vaults[0].error).toContain("AccessControl");
    expect(report(w).pauseAll.allPaused).toBe(false);
    expect(lastError(w).message).toContain("rmUSDC");
  });

  test("a read-back that says false after a send that looked fine is NOT a pause", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    const run = chainRunner(c);
    // the node accepts the send and the vault does not change (a wrong target, a no-op): only the read-back can tell
    expect(await w.run(["pause-all"], { run: async (t, a, o) => { const r = await run(t, a, o); if (t === "cast" && a[0] === "send") delete c.paused[a[1]!]; return r; }, makeSigner: signerFor })).toBe(EXIT_CODES.PAUSE);
    expect(report(w).pauseAll.vaults.map((v: any) => v.depositsPaused)).toEqual([false, false, false, false]);
  });

  test("no run manifest: pause-all says so instead of guessing the signer", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    expect(await w.run(["pause-all"], deps(c))).toBe(EXIT_CODES.RESUME);
    expect(c.sends).toEqual([]);
  });

  test("a dry run never pauses", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    expect(await w.run(["pause-all", "--dry-run"], deps(c))).toBe(EXIT_CODES.USAGE);
    expect(c.sends).toEqual([]);
  });

  test("on chain 8453 the EMERGENCY key is never defaulted: no --emergency-signer after the handover is refused", async () => {
    const w = world({ writeSafeManifest: true, chainId: 8453 }), c = newChain();
    const m = join(w.coreDir, "deployments", "8453");
    mkdirSync(m, { recursive: true });
    VAULTS.forEach((v, i) => writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ vault: vaultAddr(i) })));
    mkdirSync(w.evidence, { recursive: true });
    writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify({ version: 1, chainId: 8453, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "t", stages: AFTER_HANDOVER }));
    expect(await w.run(["pause-all"], deps(c))).toBe(EXIT_CODES.SIGNER);
    expect(c.sends).toEqual([]);
  });
});

describe("a failed verify or postflight pauses the vaults by itself", () => {
  test("a failed verify after the handover pauses all four with the EMERGENCY key and the run still exits VERIFY (13)", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, AFTER_HANDOVER);
    const code = await w.run(["verify", "--emergency-signer", EMERGENCY_SPEC], { ...deps(c), verify: failingVerifier });
    expect(code).toBe(EXIT_CODES.VERIFY);
    expect(c.sends).toHaveLength(4);
    for (const s of c.sends) expect(s.keystore).toBe("/k/EMERGENCY");
    expect(Object.keys(c.paused)).toHaveLength(4);
    expect(report(w).pauseAll).toMatchObject({ trigger: "verify", allPaused: true });
    expect(report(w).pauseAll.reason).toContain("safe: nonce at least 1");
    expect(w.logs().some((l) => l.event === "pause_all.auto" && l.trigger === "verify")).toBe(true);
  });

  test("a failed verify before the handover pauses with the deployer", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    expect(await w.run(["verify"], { ...deps(c), verify: failingVerifier })).toBe(EXIT_CODES.VERIFY);
    expect(c.sends).toHaveLength(4);
    for (const s of c.sends) expect(s.keystore).toBe(DEPLOYER_KS);
  });

  test("a failed verify whose pause also fails exits PAUSE and names the vaults still open", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    c.failSendTo = vaultAddr(2);
    expect(await w.run(["verify"], { ...deps(c), verify: failingVerifier })).toBe(EXIT_CODES.PAUSE);
    expect(lastError(w).message).toContain("rmAGENT");
    expect(lastError(w).message).toContain("safe: nonce at least 1"); // the original failure is still in the message
  });

  test("a verify that passes pauses nothing", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, AFTER_HANDOVER);
    const ok = { verifyDeployment: (async () => ({ ok: true, checks: [{ label: "chain: id equals sheet", ok: true, detail: "" }] })) as never };
    expect(await w.run(["verify"], { ...deps(c), verify: ok })).toBe(0);
    expect(c.sends).toEqual([]);
    expect(existsSync(rolloutReportPath({ evidenceDir: w.evidence, chainId: 918453 }))).toBe(false);
  });

  test("a failure in a deploy stage is not a verify failure: nothing is paused", async () => {
    const w = world({ startNonce: 0 }), c = newChain();
    w.cfg.simFails = SCRIPT.libs;
    expect(await w.run(["--stage", "deploy"], deps(c))).toBe(EXIT_CODES.SIMULATION);
    expect(c.sends).toEqual([]);
  });

  test("a postflight failure (the end-of-deploy nonce check) pauses too", async () => {
    const w = world({ startNonce: 0 }), c = newChain();
    // the verifier passes but leaves a stray deployer transaction behind: the nonce check that follows fails
    const stray = { verifyDeployment: (async () => { w.setNonce(w.state().nonces[ADMIN.toLowerCase()] + 3); return { ok: true, checks: [{ label: "chain: id equals sheet", ok: true, detail: "" }] }; }) as never };
    const code = await w.run(["--emergency-signer", EMERGENCY_SPEC], { ...deps(c), verify: stray });
    expect(lastError(w).message).toContain("nonce");
    expect(code).toBe(EXIT_CODES.NONCE);
    expect(c.sends).toHaveLength(4);
    expect(report(w).pauseAll.trigger).toBe("postflight");
  });
});

describe("issue 1686: pause-all records a pause entry in the run manifest", () => {
  const manifestOf = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));

  test("a manual pause-all writes seq, timestamp, trigger and the per-vault results next to the rollout report, which is unchanged", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, AFTER_HANDOVER);
    expect(await w.run(["pause-all", "--emergency-signer", EMERGENCY_SPEC], deps(c))).toBe(0);
    const m = manifestOf(w);
    expect(m.pauses).toHaveLength(1);
    expect(m.pauses[0]).toMatchObject({ seq: 1, trigger: "manual", status: "done", allPaused: true });
    expect(Number.isNaN(Date.parse(m.pauses[0].at))).toBe(false);
    expect(m.pauses[0].vaults.map((v: any) => [v.vault, v.depositsPaused])).toEqual([["rmUSDC", true], ["rmPROTO", true], ["rmAGENT", true], ["rmRWA", true]]);
    expect(m.stages).toEqual(AFTER_HANDOVER); // the rest of the manifest is untouched
    expect(report(w).pauseAll).toMatchObject({ trigger: "manual", allPaused: true });
    expect(existsSync(rolloutReportPath({ evidenceDir: w.evidence, chainId: 918453 }))).toBe(true);
  });

  test("the entry is on disk BEFORE the first pauseDeposits() is sent, and each vault is appended as it finishes (a crash half way still leaves it)", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    const run = chainRunner(c);
    const seen: { sendNo: number; status: string; vaults: number }[] = [];
    await w.run(["pause-all"], { run: async (t, a, o) => {
      if (t === "cast" && a[0] === "send") { const e = manifestOf(w).pauses?.[0]; seen.push({ sendNo: c.sends.length + 1, status: e?.status, vaults: e?.vaults.length }); }
      return run(t, a, o);
    }, makeSigner: signerFor });
    expect(seen).toEqual([{ sendNo: 1, status: "started", vaults: 0 }, { sendNo: 2, status: "started", vaults: 1 }, { sendNo: 3, status: "started", vaults: 2 }, { sendNo: 4, status: "started", vaults: 3 }]);
    expect(manifestOf(w).pauses[0].status).toBe("done");
  });

  test("the automatic pause after a failed verify records the same entry with trigger verify; a second pause-all gets the next seq", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    expect(await w.run(["verify"], { ...deps(c), verify: failingVerifier })).toBe(EXIT_CODES.VERIFY);
    expect(await w.run(["pause-all"], deps(c))).toBe(0);
    expect(manifestOf(w).pauses.map((p: any) => [p.seq, p.trigger])).toEqual([[1, "verify"], [2, "manual"]]);
  });

  test("a stale manifest lock (a crashed holder) is taken over: the entry is still written and all four vaults are paused", async () => {
    const w = world({ writeSafeManifest: true }), c = newChain();
    seed(w, BEFORE_HANDOVER);
    const lock = join(w.evidence, "publish-run.json.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(await w.run(["pause-all"], deps(c))).toBe(0);
    expect(c.sends).toHaveLength(4);
    expect(manifestOf(w).pauses).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });
});

