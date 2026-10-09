// Unit D4 (one-deployment-scheme, pass 4): verifier floors, sheet floors, core config-check gate, clean tree through the runner, nonce check
// outcomes, the Safe delay bounds and the frozen counts error. Lint-level unit tests: stubs only, no chain.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { FALLBACK_MAX_EXIT_FEE_BPS, assertExitFeeBound, readMaxExitFeeBps } from "../src/asset-config.ts";
import { CORE_CONFIG_CHECK_SCRIPT, coreCheckEnv, runCoreConfigCheck } from "../src/core-config-check.ts";
import { loadFrozen } from "../src/counts.ts";
import { parseCli } from "../src/cli.ts";
import { finalNonceCheck, isReadOnlyGitStatus, spawnTool } from "../src/runner.ts";
import { DEPLOYER_STAGES, VAULT_STAGES } from "../src/stages.ts";
import { parseSheet } from "../src/sheet.ts";
import { updateTimelockDelay } from "../src/safe/timelock.ts";
import { sheetText, SHA, tmp } from "./fixtures.ts";
import { SCRIPT, world } from "./harness.ts";

const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
const sheetErr = (over: Record<string, string | null>): string => { try { parseSheet(sheetText(over)); return ""; } catch (e) { return (e as Error).message; } };
const ADDR = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("what the CLI spawns: forge, cast and the read-only git status, nothing else", () => {
  test("a full deploy spawns only forge, cast and git -C DIR status --porcelain", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const calls = w.state().calls;
    const tools = new Set(calls.map((c: any) => c.tool));
    expect([...tools].sort()).toEqual(["cast", "forge", "git"]);
    for (const c of calls.filter((x: any) => x.tool === "git")) expect(isReadOnlyGitStatus(c.args)).toBe(true);
    expect(calls.filter((x: any) => x.tool === "git").length).toBe(1);
  });
  test("the spawner allows git status only", async () => {
    expect(isReadOnlyGitStatus(["-C", "/x", "status", "--porcelain", "--untracked-files=all"])).toBe(true);
    // the frozen counts check (core 1668): one path, ignored files shown
    expect(isReadOnlyGitStatus(["-C", "/x", "status", "--porcelain", "--untracked-files=all", "--ignored", "--", "/x/f.json"])).toBe(true);
    for (const bad of [["status"], ["-C", "/x", "push"], ["-C", "/x", "status", "--porcelain", "--ignore-submodules"], ["-C", "/x", "status", "--porcelain", "--", "a", "b"], ["-C", "/x", "checkout", "."], ["-C", "/x", "status", "-s"]]) {
      expect(isReadOnlyGitStatus(bad)).toBe(false);
      await expect(spawnTool("git", bad, { env: {} })).rejects.toThrow("read-only 'git -C DIR status --porcelain'");
    }
  });
  test("a dirty core checkout read through the runner stops the CLI before any forge call", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.gitDirty = [" M contracts/RobotMoneyVault.sol"];
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.USAGE);
    expect(lastError(w)!.message).toContain("uncommitted changes");
    expect(w.state().calls.filter((c: any) => c.tool === "forge")).toEqual([]);
  });
});

describe("core's config-check: plan job and before every vault stage", () => {
  test("the plan job runs it once, read-only, with the report in the evidence directory", async () => {
    const w = world({ chainId: 918453 });
    expect(await w.run(["--stage", "plan"])).toBe(0);
    expect(w.coreChecks.length).toBe(1);
    expect(w.coreChecks[0]!.outDir).toContain(join(w.evidence, "core-config-check"));
  });
  test("a failing check ends the plan job with a verify error", async () => {
    const w = world({ chainId: 918453 });
    w.coreCheckCode = 1;
    expect(await w.run(["--stage", "plan"])).toBe(EXIT_CODES.VERIFY);
    expect(lastError(w)!.message).toContain("core's config-check before the plan failed");
  });
  test("a deploy runs it before each of the four vault stages", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(VAULT_STAGES.length).toBe(4);
    expect(w.coreChecks.length).toBe(VAULT_STAGES.length);
    const ran = w.logs().filter((l) => l.event === "stage.core_config_check").map((l) => l.stage);
    expect(ran).toEqual(VAULT_STAGES.map((v) => v.stage));
  });
  test("a failing check stops the first vault stage before its forge script and later stages never run", async () => {
    const w = world({ startNonce: 0 });
    w.coreCheckCode = 1;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.VERIFY);
    expect(lastError(w)!.message).toContain(`core's config-check before stage ${VAULT_STAGES[0]!.stage} failed`);
    const sent = w.state().calls.filter((c: any) => c.tool === "forge" && c.args.includes("--broadcast")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
    expect(sent).not.toContain(SCRIPT[VAULT_STAGES[0]!.stage]);
    expect(w.coreChecks.length).toBe(1);
  });
  test("a missing script is a named INPUT_MISSING error, not a skip", async () => {
    const dir = tmp("no-core-check-");
    const err = await runCoreConfigCheck({ coreDir: dir, outDir: join(dir, "o"), chainId: 918453, rpc: "http://x", baseEnv: {} }, async () => ({ code: 0, output: "" })).catch((e) => e);
    expect(err).toBeInstanceOf(PublishError);
    expect(err.kind).toBe("INPUT_MISSING");
    expect(err.message).toContain(CORE_CONFIG_CHECK_SCRIPT);
    expect(err.message).toContain("cannot be skipped");
  });
  test("the CLI has no skip flag for it", () => {
    const base = ["--chain", "918453", "--rpc", "http://x", "--sheet", "s", "--core-sha", SHA, "--signer", "ledger"];
    for (const f of ["--skip", "--skip-config-check", "--no-config-check"]) expect(() => parseCli([...base, f])).toThrow();
  });
  test("the child gets the run RPC in CONFIG_CHECK_RPC_URL (never as an argument) and no signing material", () => {
    const env = { PATH: "/bin", HOME: "/h", PRIVATE_KEY: "SECRET", BASE_RPC_URL: "https://live" };
    expect(coreCheckEnv({ rpc: "https://run", baseEnv: env })).toEqual({ PATH: "/bin", HOME: "/h", CONFIG_CHECK_RPC_URL: "https://run" });
    expect(coreCheckEnv({ rpc: "https://twin", baseEnv: { PATH: "/bin" } })).toEqual({ PATH: "/bin", CONFIG_CHECK_RPC_URL: "https://twin" });
  });

});

describe("finalNonceCheck is a stage 12 check with named outcomes", () => {
  const nonce = 100;
  const counts = () => Object.fromEntries(DEPLOYER_STAGES.map((s) => [s.countKey!, 1]));
  const ctx = (over: Record<string, unknown> = {}, got = nonce) => {
    const logs: any[] = [];
    return {
      logs,
      ctx: {
        dryRun: false, chainId: 918453, rpc: "http://x", baseEnv: {}, frozen: Object.fromEntries(DEPLOYER_STAGES.map((s, i) => [s.countKey!, i === 0 ? got - (DEPLOYER_STAGES.length - 1) : 1])),
        signer: { address: async () => ADDR(1) }, log: { log: (_l: string, e: string, f: unknown) => logs.push({ event: e, ...(f as object) }) },
        run: async () => ({ code: 0, stdout: String(nonce), stderr: "" }), ...over,
      } as never,
    };
  };
  const manifest = (done: boolean | number, govern = false) => ({
    stages: { ...Object.fromEntries(DEPLOYER_STAGES.map((s, i) => [s.name, { status: (typeof done === "number" ? i < done : done) ? "done" : "started" }])), ...(govern ? { govern: { status: "started" } } : {}) },
  }) as never;
  const names = DEPLOYER_STAGES.map((s) => s.name);

  test("all deployer stages done and run: it checks and passes on the exact sum", async () => {
    const { ctx: c, logs } = ctx();
    expect(await finalNonceCheck(c, manifest(true), names)).toEqual({ checked: true, nonce, sum: nonce });
    expect(logs.some((l) => l.event === "run.nonce_ok")).toBe(true);
  });
  test("all done and a wrong nonce is a NONCE error", async () => {
    const { ctx: c } = ctx({}, nonce + 1);
    await expect(finalNonceCheck(c, manifest(true), names)).rejects.toMatchObject({ kind: "NONCE" });
  });
  test("a partial run does not check, even when the nonce would not match", async () => {
    const { ctx: c, logs } = ctx({}, nonce + 5);
    expect(await finalNonceCheck(c, manifest(DEPLOYER_STAGES.length - 1), names.slice(0, -1))).toEqual({ checked: false, reason: "deployer-stages-incomplete" });
    expect(logs.at(-1).reason).toBe("deployer-stages-incomplete");
  });
  test("a dry run does not check", async () => {
    const { ctx: c } = ctx({ dryRun: true });
    expect(await finalNonceCheck(c, manifest(true), names)).toEqual({ checked: false, reason: "dry-run" });
  });
  test("after govern started it does not check (the Safe execTransaction gas moved the nonce)", async () => {
    const { ctx: c } = ctx({}, nonce + 3);
    expect(await finalNonceCheck(c, manifest(true, true), names)).toEqual({ checked: false, reason: "govern-started" });
  });
  test("a run of other stages after the deployer stages finished does not repeat it", async () => {
    const { ctx: c } = ctx();
    expect(await finalNonceCheck(c, manifest(true), ["verify"])).toEqual({ checked: false, reason: "no-deployer-stage-ran" });
  });
  test("the real CLI: a partial deploy of one stage runs no nonce check, the full deploy runs it once", async () => {
    const part = world({ startNonce: 1 });
    expect(await part.run(["--stage", "libs"])).toBe(0);
    expect(part.logs().some((l) => l.event === "run.nonce_ok")).toBe(false);
    expect(part.logs().some((l) => l.event === "run.nonce_check_skipped" && l.reason === "deployer-stages-incomplete")).toBe(true);
    const full = world({ startNonce: 0 });
    expect(await full.run(["--stage", "deploy"])).toBe(0);
    expect(full.logs().filter((l) => l.event === "run.nonce_ok").length).toBe(1);
  });
});

describe("sheet floors: fee recipient, USDC constant, caps, exit fee", () => {
  test("FEE_RECIPIENT_ADDRESS: the deployer (ADMIN_ADDRESS) is refused, zero is refused, @safe and a treasury address pass", () => {
    const admin = parseSheet(sheetText({})).admin;
    expect(sheetErr({ FEE_RECIPIENT_ADDRESS: admin })).toContain("equals ADMIN_ADDRESS");
    expect(sheetErr({ FEE_RECIPIENT_ADDRESS: admin.toLowerCase() })).toContain("equals ADMIN_ADDRESS");
    expect(sheetErr({ FEE_RECIPIENT_ADDRESS: ADDR(0) })).toContain("zero address");
    expect(sheetErr({ FEE_RECIPIENT_ADDRESS: "@safe" })).toBe("");
    expect(sheetErr({ FEE_RECIPIENT_ADDRESS: ADDR(0x7e) })).toBe("");
  });
  test("USDC_ADDRESS is not a sheet value: the example has none, a wrong one is refused, the constant is accepted", () => {
    expect(sheetText({})).not.toContain("USDC_ADDRESS");
    const s = parseSheet(sheetText({}));
    expect(s.usdc.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(sheetErr({ USDC_ADDRESS: ADDR(0x1234) })).toContain("USDC_ADDRESS must be 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(sheetErr({ USDC_ADDRESS: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })).toBe("");
  });
  test("caps: a zero TVL cap is refused for every vault, per-deposit above TVL is refused, equal passes", () => {
    for (const k of ["USDC", "PROTO", "AGENT", "RWA"]) {
      expect(sheetErr({ [`VAULT_${k}_TVL_CAP`]: "0" })).toContain(`VAULT_${k}_TVL_CAP must be above 0`);
      expect(sheetErr({ [`VAULT_${k}_TVL_CAP`]: "5", [`VAULT_${k}_PER_DEPOSIT_CAP`]: "6" })).toContain("never above the TVL cap");
      expect(sheetErr({ [`VAULT_${k}_TVL_CAP`]: "5", [`VAULT_${k}_PER_DEPOSIT_CAP`]: "5" })).toBe("");
    }
  });
  test("exitFeeBps is bounded by MAX_EXIT_FEE_BPS read from the core contracts, with a named fallback", () => {
    const core = tmp("core-fee-");
    const vaults = { USDC: { exitFeeBps: 0n }, PROTO: { exitFeeBps: 100n }, AGENT: { exitFeeBps: 0n }, RWA: { exitFeeBps: 0n } } as never;
    expect(readMaxExitFeeBps(core)).toBeUndefined();
    expect(assertExitFeeBound(core, vaults)).toBe(FALLBACK_MAX_EXIT_FEE_BPS);
    mkdirSync(join(core, "contracts", "vaults"), { recursive: true });
    writeFileSync(join(core, "contracts", "RobotMoneyVault.sol"), "uint256 public constant MAX_EXIT_FEE_BPS = 50;\n");
    writeFileSync(join(core, "contracts", "vaults", "BasketVault.sol"), "uint256 public constant MAX_EXIT_FEE_BPS = 100; // 1%\n");
    expect(readMaxExitFeeBps(core)).toBe(50n);
    expect(() => assertExitFeeBound(core, vaults)).toThrow(/VAULT_PROTO_EXIT_FEE_BPS 100 is above the vault maximum MAX_EXIT_FEE_BPS 50/);
    expect(() => assertExitFeeBound(core, { ...(vaults as object), PROTO: { exitFeeBps: 50n } } as never)).not.toThrow();
  });
  test("the CLI refuses an exit fee above the core maximum before any send", async () => {
    const w = world({ startNonce: 0, sheet: { VAULT_PROTO_EXIT_FEE_BPS: "101" } });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.FLOOR);
    expect(lastError(w)!.message).toContain("MAX_EXIT_FEE_BPS 100");
    expect(w.state().calls.filter((c: any) => c.tool === "forge")).toEqual([]);
  });
});

describe("the Safe tool bounds updateDelay", () => {
  const handle = (chainId: number) => ({ chain: { chainId, rpcUrl: "http://x" }, logger: { log() {} } }) as never;
  const p = (newDelay: bigint, allowUnsafeDelay = false) => ({ timelock: "0x00000000000000000000000000000000000071e1", newDelay, phase: "schedule" as const, allowUnsafeDelay, delay: 0n }) as never;
  test("floor 172800 on 8453, at least 1 elsewhere, ceiling 2592000 on both, no flag lifts them", async () => {
    for (const unsafe of [false, true]) {
      await expect(updateTimelockDelay(handle(8453), p(172799n, unsafe))).rejects.toMatchObject({ code: "UNSAFE_DELAY" });
      await expect(updateTimelockDelay(handle(918453), p(0n, unsafe))).rejects.toMatchObject({ code: "UNSAFE_DELAY" });
      await expect(updateTimelockDelay(handle(8453), p(2592001n, unsafe))).rejects.toMatchObject({ code: "UNSAFE_DELAY" });
      await expect(updateTimelockDelay(handle(918453), p(2592001n, unsafe))).rejects.toMatchObject({ code: "UNSAFE_DELAY" });
    }
  });
  test("the boundary values pass the delay rules (they fail later on the missing client)", async () => {
    for (const [c, d] of [[8453, 172800n], [8453, 2592000n], [918453, 3600n], [918453, 2592000n]] as const) {
      await expect(updateTimelockDelay(handle(c), p(d))).rejects.not.toMatchObject({ code: "UNSAFE_DELAY" });
    }
    await expect(updateTimelockDelay(handle(918453), p(1n, true))).rejects.not.toMatchObject({ code: "UNSAFE_DELAY" });
  });
});

describe("frozen counts: nothing is committed, a missing file is a named error", () => {
  test("the message names the error, the --measure command, the Twin chain and the file", () => {
    const dir = tmp("frozen-");
    let err: PublishError | undefined;
    try { loadFrozen(dir, SHA); } catch (e) { err = e as PublishError; }
    expect(err!.kind).toBe("COUNTS_MISSING");
    expect(err!.message).toContain("FROZEN_COUNTS_MISSING");
    expect(err!.message).toContain("publish contracts --measure");
    expect(err!.message).toContain("918453");
    expect(err!.message).toContain(`${SHA}.json`);
  });
  test("the repository commits no frozen counts file", async () => {
    const { existsSync, readdirSync } = await import("node:fs");
    const d = join(import.meta.dir, "..", "..", "deployments", "frozen-counts");
    expect(existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")) : []).toEqual([]);
  });
});
