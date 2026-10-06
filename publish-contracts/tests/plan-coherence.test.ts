// Plan coherence fixes (pass 3, cohere-fix-devops): USDC constant, vault config gate, clean tree, nonce after govern, mainnet delay floor in the Safe tool.
import { describe, expect, test } from "bun:test";
import { PublishError } from "../src/errors.ts";
import { describeCalldata } from "../src/safe/index.ts";
import { updateTimelockDelay } from "../src/safe/timelock.ts";
import { parseSheet } from "../src/sheet.ts";
import { dirtyTreeLines } from "../src/isomorphism.ts";
import { encodeFunctionData } from "viem";
import { TIMELOCK_ABI } from "../src/safe/constants.ts";
import { governHasRun, spawnTool } from "../src/runner.ts";
import { deployEndNonce } from "../src/verify-stage.ts";
import { USDC_ADDRESS, assertUsdcCode, checkUsdcCode } from "../src/usdc.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { healthyPoolReader, sheetText, tmp } from "./fixtures.ts";
import { world } from "./harness.ts";

const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();

describe("USDC is a constant on every chain", () => {
  test("a sheet with another USDC_ADDRESS is refused", () => {
    expect(() => parseSheet(sheetText({ USDC_ADDRESS: "0x4200000000000000000000000000000000000006" }))).toThrow(/USDC_ADDRESS must be 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913/);
    expect(parseSheet(sheetText({ USDC_ADDRESS: USDC_ADDRESS.toLowerCase() })).usdc.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
  });
  test("code that is not the pinned FiatTokenProxy, or no code, is refused", () => {
    expect(checkUsdcCode("0x6001600155").ok).toBe(false);
    expect(checkUsdcCode("0x").ok).toBe(false);
    expect(() => assertUsdcCode("0x6001600155")).toThrow(PublishError);
    expect(() => assertUsdcCode("0x6001600155", "0x" + "00".repeat(32))).toThrow(/mock or changed token/);
  });
  test("the plan stage refuses a mock token before any signer is made", async () => {
    const w = world({ writeSafeManifest: false });
    let made = 0;
    const code = await w.run(["--stage", "plan"], { usdcCodeHash: "0x" + "11".repeat(32), makeSigner: () => { made++; throw new Error("no signer expected"); } });
    expect(code).not.toBe(0);
    expect(lastError(w)!.message).toContain("USDC check failed");
    expect(made).toBe(0);
  });
  test("a run with a mock token sends nothing", async () => {
    const w = world({ startNonce: 0 });
    const code = await w.run(["--stage", "deploy"], { usdcCodeHash: "0x" + "11".repeat(32) });
    expect(code).not.toBe(0);
    expect(w.state().calls.filter((c: any) => c.tool === "forge")).toEqual([]);
  });
});

describe("the config-check runs again right before each vault stage", () => {
  test("a failing pool stops the proto stage before its forge script, and earlier stages still ran", async () => {
    const w = world({ startNonce: 0 });
    const bad = healthyPoolReader();
    (bad as any).callRaw = async () => ({ ok: false, data: "0x", reason: "revert" });
    const code = await w.run(["--stage", "deploy"], { chainReader: () => bad });
    expect(code).not.toBe(0);
    const err = lastError(w)!;
    expect(err.kind).toBe("VERIFY");
    expect(err.message).toContain("config-check before stage proto");
    const ran = w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script" && c.args.includes("--broadcast")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
    expect(ran.some((s: string) => /Basket|Protocol/.test(s))).toBe(false);
    expect(w.logs().some((l) => l.event === "stage.config_check" && l.ok === false)).toBe(true);
  });
  test("the check reads the live RPC given to the run, and rmUSDC and the empty rmAGENT are not checked", async () => {
    const w = world({ startNonce: 0 });
    const seen: string[] = [];
    const code = await w.run(["--stage", "deploy"], { chainReader: (rpc) => { seen.push(rpc); return healthyPoolReader(); } });
    expect(code).toBe(0);
    expect(seen).toEqual(["http://rpc.test:8545", "http://rpc.test:8545"]); // proto and rwa
    expect(w.logs().some((l) => l.event === "stage.config_check_skipped" && /no configured assets/.test(l.reason))).toBe(true);
  });
});

describe("DEPLOY_SHA: the tree must be clean", () => {
  test("a dirty core checkout is a usage error and nothing is sent", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.gitDirty = [" M contracts/script/Deploy.s.sol", "?? stray.txt"];
    const code = await w.run(["--stage", "deploy"]);
    expect(code).not.toBe(0);
    expect(lastError(w)!.kind).toBe("USAGE");
    expect(lastError(w)!.message).toContain("uncommitted changes");
    expect(w.state().calls.filter((c: any) => c.tool === "forge")).toEqual([]);
  });
  test("dirtyTreeLines on a real repo: own manifests do not count, any other change does", async () => {
    const dir = tmp("dirty-");
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a]);
    Bun.spawnSync(["git", "init", "-q", dir]);
    writeFileSync(join(dir, "a.txt"), "x");
    git("add", "."); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c");
    expect(await dirtyTreeLines(spawnTool, dir, 918453, { PATH: process.env.PATH ?? "" })).toEqual([]);
    mkdirSync(join(dir, "deployments", "918453"), { recursive: true });
    writeFileSync(join(dir, "deployments", "918453", "vault.json"), "{}");
    expect(await dirtyTreeLines(spawnTool, dir, 918453, { PATH: process.env.PATH ?? "" })).toEqual([]);
    expect((await dirtyTreeLines(spawnTool, dir, 8453, { PATH: process.env.PATH ?? "" })).length).toBe(1);
    writeFileSync(join(dir, "a.txt"), "changed");
    expect(await dirtyTreeLines(spawnTool, dir, 918453, { PATH: process.env.PATH ?? "" })).toEqual([" M a.txt"]);
  });
});

describe("the deployer nonce check and govern", () => {
  const m = (stages: Record<string, unknown>, govern?: Record<string, unknown>) => ({ stages, govern }) as never;
  test("govern started or done means the final nonce check is skipped and the verifier uses the recorded nonce", () => {
    expect(governHasRun(m({}))).toBe(false);
    expect(governHasRun(m({ govern: { status: "done" } }))).toBe(true);
    expect(governHasRun(m({}, { "voting-power-quorum": {} }))).toBe(true);
    expect(deployEndNonce(m({ timelock: { endNonce: 56 } }))).toBeUndefined();
    expect(deployEndNonce(m({ timelock: { endNonce: 56 }, govern: { status: "done" } }))).toBe(56);
  });
});

describe("the mainnet delay floor in the Safe tool", () => {
  const handle = (chainId: number) => ({ chain: { chainId, rpcUrl: "http://x" }, logger: { log() {} } }) as never;
  const p = (newDelay: bigint, allowUnsafeDelay = false) => ({ timelock: "0x00000000000000000000000000000000000071e1", newDelay, phase: "schedule" as const, allowUnsafeDelay, delay: 0n });
  test("on 8453 a delay below 172800 is refused, with and without allowUnsafeDelay", async () => {
    for (const unsafe of [false, true]) await expect(updateTimelockDelay(handle(8453), p(3600n, unsafe) as never)).rejects.toMatchObject({ code: "UNSAFE_DELAY" });
    await expect(updateTimelockDelay(handle(8453), p(172799n, true) as never)).rejects.toMatchObject({ code: "UNSAFE_DELAY" });
  });
  test("on the Twin chain the old bounds apply and the 8453 floor does not", async () => {
    await expect(updateTimelockDelay(handle(918453), p(10n) as never)).rejects.toMatchObject({ code: "UNSAFE_DELAY" });
    // 3600 passes the bounds and the floor, so it proceeds past both checks and fails later on the missing client, not on a delay rule
    await expect(updateTimelockDelay(handle(918453), p(3600n) as never)).rejects.not.toMatchObject({ code: "UNSAFE_DELAY" });
  });
  test("describe warns about a delay below the floor on 8453 only", () => {
    const inner = encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "updateDelay", args: [86400n] });
    const data = encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "schedule", args: ["0x00000000000000000000000000000000000071e1", 0n, inner, `0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`, 0n] });
    expect(describeCalldata(data, 8453).join("\n")).toContain("below the 172800 second floor");
    expect(describeCalldata(data, 918453).join("\n")).not.toContain("floor");
    expect(describeCalldata(data).join("\n")).not.toContain("floor");
  });
});
