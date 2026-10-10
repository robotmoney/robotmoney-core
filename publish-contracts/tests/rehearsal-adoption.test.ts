// Issue 1727 with PR 1722: the relative start nonce of a rehearsal composes with adoption: the expected nonce is start + sum(effectiveCounts) + proof at every site.
// The start is recorded at the FIRST stage (safe), before libs is adopted. A rehearsal on 8453 where the libraries already exist: libs adopts at 0 transactions and proto adopts three
// CREATE2 libraries (7 transactions instead of 10). A stray deployer transaction before, between or after the adopted stages is refused.
import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROOF_TX_NONCES } from "../src/counts.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { buildCreate2Libraries, predictedLibraryAddress } from "../src/libs-adopt.ts";
import { getStageTable } from "../src/stages.ts";
import { COUNTS } from "./fixtures.ts";
import { SCRIPT, world, type World } from "./harness.ts";

const OUT = join(import.meta.dir, "fixtures", "build-out");
const BUILT = buildCreate2Libraries(getStageTable().create2Libraries!, OUT);
const THREE = [BUILT.get("BasketAssetConfigGuard")!, BUILT.get("TwapTickMath")!, BUILT.get("BasketViews")!];
const tickArt = JSON.parse(readFileSync(join(OUT, "TickMath.sol", "TickMath.json"), "utf8"));
const TICK = predictedLibraryAddress(tickArt.bytecode.object);
const A = "0x000000000000000000000000000000000000a001";
const REH = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "20261010" };
const START = 118;
const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);
const manifest = (w: World) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const failed = (w: World) => w.logs().filter((l) => l.event === "run.failed").pop();
const bump = (w: World, by = 1) => w.setNonce(w.state().nonces[A] + by);
/** The state of Base after the first rehearsal: TickMath and the three basket libraries are on chain. */
function adoptedWorld(startNonce = START, sheet: Record<string, string> = REH): World {
  const w = world({ startNonce, sheet });
  cpSync(OUT, join(w.coreDir, "out"), { recursive: true });
  w.cfg.counts[SCRIPT.proto] = COUNTS.proto! - 3;
  const codeAt: Record<string, string> = { [TICK.toLowerCase()]: `0x73${TICK.slice(2).toLowerCase()}${tickArt.deployedBytecode.object.slice(44)}` };
  for (const b of THREE) codeAt[b.address.toLowerCase()] = b.runtime;
  Object.assign(w.cfg, { zeroTx: SCRIPT.libs, libsAddress: TICK, codeAt, creates: { [SCRIPT.proto]: [] } });
  return w;
}
const PRE_PROTO = ["safe", "libs", "recorder", "vault", "registry", "router", "gateway", "governance", "ic-policy"];

describe("a rehearsal with a non-zero start and adopted stages", () => {
  test("libs adopted at 0 and proto at 7: start recorded at safe, the later stages start where the adopted ones left off, the final nonce is start + (sum - libs - 3) + proof", async () => {
    const w = adoptedWorld();
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(failed(w)).toBeUndefined();
    const m = manifest(w);
    expect(m.deployerStartNonce).toBe(START);
    expect(m.stages.safe.startNonce).toBe(START);
    expect(m.stages.libs).toMatchObject({ adopted: true });
    expect(m.stages.libs.adoption.deployerTxs).toBe(0);
    expect(m.stages.proto.adoption.deployerTxs).toBe(COUNTS.proto! - 3);
    expect(m.stages.recorder.startNonce).toBe(START + COUNTS.safe!); // libs contributed nothing
    expect(m.stages.agent.startNonce).toBe(m.stages.proto.startNonce + COUNTS.proto! - 3);
    const final = START + (sum - COUNTS.libs! - 3) + PROOF_TX_NONCES;
    expect(w.state().nonces[A]).toBe(final);
    expect(w.logs().some((l) => l.event === "run.nonce_ok" && l.deployer_start_nonce === START && l.summed_frozen_counts === sum - COUNTS.libs! - 3)).toBe(true);
  });
  test("production on the same chain state and the same start is refused (absolute accounting from 0 is unchanged)", async () => {
    const w = adoptedWorld(START, {});
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.NONCE);
  });
  test("a stray transaction BEFORE the adopted libs stage (after the start was recorded at safe) is refused", async () => {
    const w = adoptedWorld();
    expect(await w.run(["--stage", "safe"])).toBe(0);
    bump(w);
    expect(await w.run(["--stage", "libs", "--resume"])).toBe(EXIT_CODES.NONCE);
    expect(manifest(w).stages.libs).toBeUndefined();
  });
  test("a stray transaction BETWEEN the adopted libs stage and the adopted proto stage is refused before proto simulates a broadcast", async () => {
    const w = adoptedWorld();
    expect(await w.run(["--stage", PRE_PROTO.join(",")])).toBe(0);
    expect(manifest(w).stages.libs.adopted).toBe(true);
    bump(w);
    expect(await w.run(["--stage", "proto", "--resume"])).toBe(EXIT_CODES.NONCE);
    expect(w.state().calls.filter((c: any) => c.tool === "forge" && c.args.includes("--broadcast") && String(c.args[1]).includes(SCRIPT.proto!))).toEqual([]);
  });
  test("a stray transaction AFTER the adopted proto stage, before agent, is refused", async () => {
    const w = adoptedWorld();
    expect(await w.run(["--stage", [...PRE_PROTO, "proto"].join(",")])).toBe(0);
    expect(manifest(w).stages.proto.adopted).toBe(true);
    bump(w);
    expect(await w.run(["--stage", "agent", "--resume"])).toBe(EXIT_CODES.NONCE);
  });
  test("mutation: with no stray transaction the same resumes succeed and the run completes at the composed nonce", async () => {
    const w = adoptedWorld();
    expect(await w.run(["--stage", PRE_PROTO.join(",")])).toBe(0);
    expect(await w.run(["--stage", "proto,agent,rwa,prove-control,timelock", "--resume"])).toBe(0);
    expect(w.state().nonces[A]).toBe(START + (sum - COUNTS.libs! - 3) + PROOF_TX_NONCES);
  });
  test("the end-of-deploy check: start + sum(effective) + proof passes, one stray transaction after the last stage, a missing start and the production reading fail", async () => {
    const { finalNonceCheck } = await import("../src/runner.ts");
    const { DEPLOYER_STAGES } = await import("../src/stages.ts");
    const { parseSheet } = await import("../src/sheet.ts");
    const { sheetText } = await import("./fixtures.ts");
    const stages: any = Object.fromEntries(DEPLOYER_STAGES.map((s) => [s.name, { status: "done", count: COUNTS[s.countKey!] }]));
    stages.libs = { status: "done", count: COUNTS.libs, adopted: true, adoption: { libraries: [], factory: "0x0", deployerTxs: 0 } };
    stages.proto = { status: "done", count: COUNTS.proto, adopted: true, adoption: { libraries: [], factory: "0x0", deployerTxs: COUNTS.proto! - 3 } };
    const want = START + (sum - COUNTS.libs! - 3) + PROOF_TX_NONCES;
    const check = (nonce: number, kind: "rehearsal" | "production", start: number | null = START) => {
      const ctx = { dryRun: false, chainId: 918453, rpc: "http://x", baseEnv: {}, frozen: COUNTS, sheet: parseSheet(sheetText(kind === "rehearsal" ? REH : {})), signer: { address: async () => A }, log: { log() {} }, run: async () => ({ code: 0, stdout: String(nonce), stderr: "" }) } as never;
      return finalNonceCheck(ctx, { stages, ...(start === null ? {} : { deployerStartNonce: start }) } as never);
    };
    expect(await check(want, "rehearsal")).toMatchObject({ checked: true, nonce: want });
    await expect(check(want + 1, "rehearsal")).rejects.toMatchObject({ kind: "NONCE" });
    await expect(check(want - 1, "rehearsal")).rejects.toMatchObject({ kind: "NONCE" });
    await expect(check(want, "rehearsal", null)).rejects.toMatchObject({ kind: "MANIFEST" });
    await expect(check(want, "production")).rejects.toMatchObject({ kind: "NONCE" }); // production counts from 0: the same nonce is wrong
    expect(await check(want - START, "production")).toMatchObject({ checked: true });
  });
});
