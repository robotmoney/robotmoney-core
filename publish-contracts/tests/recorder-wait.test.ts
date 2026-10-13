// Core 1676: the runner waits for the Uniswap V4 price recorder to hold a full TWAP window before the agent stage, and refuses the stage while
// the recorder's oldest snapshot is younger than the window. BasketVault.addAsset would revert InsufficientObservationHistory otherwise.
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPublishError } from "../src/errors.ts";
import { publishLogger } from "../src/log.ts";
import { RECORDER_WAIT_MARGIN_SECONDS, RECORDER_WINDOW_SECONDS, recorderWindowGate, type RunContext } from "../src/runner.ts";
import { stageByName } from "../src/stages.ts";
import type { ChainReader, Hex } from "../src/verify/types.ts";
import { NOW_TS, REPO, healthyPoolReader, tmp, writeCoreAssetConfig } from "./fixtures.ts";
import { world } from "./harness.ts";

const NEED = RECORDER_WINDOW_SECONDS + RECORDER_WAIT_MARGIN_SECONDS;
const RECORDER = "0x00000000000000000000000000000000000c0c0c";

/** A chain where time is a number the test moves. `oldest` is the recorder's oldest snapshot. */
function chainAt(state: { now: bigint; oldest: bigint; reads: string[] }): ChainReader {
  return {
    chainId: async () => 918453, blockNumber: async () => 1n, nonce: async () => 0, getStorageAt: async () => "0x" as Hex, getLogs: async () => [], getCode: async () => "0x6001" as Hex,
    blockTimestamp: async () => state.now,
    read: async (_to: string, sig: string) => { state.reads.push(sig); if (sig.includes("oldestObservation")) return state.oldest; throw new Error(`unexpected read ${sig}`); },
    callRaw: async () => { throw new Error("unused"); },
  } as unknown as ChainReader;
}

function setup(o: { chainId?: number; v4?: boolean; simRpc?: string } = {}) {
  const coreDir = tmp("pc-recwait-");
  const chainId = o.chainId ?? 918453;
  const m = join(coreDir, "deployments", String(chainId));
  mkdirSync(m, { recursive: true });
  writeFileSync(join(m, "recorder.json"), JSON.stringify({ chain_id: chainId, recorder: RECORDER }));
  writeCoreAssetConfig(coreDir);
  if (o.v4 !== false) copyFileSync(join(REPO, "config", "agent-token-shortlist.json"), join(coreDir, "config", "agent-token-shortlist.json"));
  const state = { now: 1_800_000_000n, oldest: 1_800_000_000n - 100n, reads: [] as string[] };
  const lines: string[] = [];
  const spawned: string[][] = [];
  const ctx = {
    coreDir, chainId, rpc: "http://rpc.test:8545", log: publishLogger((l) => lines.push(l)), baseEnv: {}, simRpc: o.simRpc,
    chainReader: () => chainAt(state),
    run: async (tool: string, args: string[]) => {
      spawned.push([tool, ...args]);
      // the dry-run warp: `cast rpc evm_increaseTime N` moves the fake chain clock
      if (tool === "cast" && args[0] === "rpc" && args[1] === "evm_increaseTime") state.now += BigInt(args[2]!);
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as RunContext;
  return { ctx, state, lines, spawned };
}
const agent = () => stageByName("agent");

describe("the recorder wait before the agent stage (core 1676)", () => {
  test("a recorder that already holds the window plus the margin lets the stage start, with no wait", async () => {
    const { ctx, state, lines } = setup();
    state.oldest = state.now - BigInt(NEED);
    await recorderWindowGate(ctx, agent(), { sleep: async () => { throw new Error("must not wait"); }, maxWaitMs: 0 });
    expect(lines.some((l) => l.includes("stage.recorder_ready"))).toBe(true);
  });

  test("one second short of the window plus the margin is refused: the oldest snapshot is younger than the window", async () => {
    const { ctx, state, spawned } = setup({ chainId: 8453 });
    state.oldest = state.now - BigInt(NEED - 1);
    let err: unknown;
    try { await recorderWindowGate(ctx, agent(), { maxWaitMs: 0, sleep: async () => {} }); } catch (e) { err = e; }
    expect(isPublishError(err, "RECORDER_HISTORY")).toBe(true);
    expect((err as Error).message).toContain("InsufficientObservationHistory");
    expect(spawned).toEqual([]);
  });

  test("a fresh recorder on Base mainnet is waited for by polling, then the stage starts", async () => {
    const { ctx, state, lines } = setup({ chainId: 8453 });
    state.oldest = state.now - 1200n; // 606 s short
    let slept = 0;
    await recorderWindowGate(ctx, agent(), { maxWaitMs: 3_600_000, pollMs: 15_000, sleep: async () => { slept++; state.now += 15n * 100n; } });
    expect(slept).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("stage.recorder_waiting"))).toBe(true);
    expect(lines.some((l) => l.includes("stage.recorder_ready"))).toBe(true);
  });

  test("a mainnet recorder that never ages is refused after the longest wait, not waited for forever", async () => {
    const { ctx, state } = setup({ chainId: 8453 });
    state.oldest = state.now - 10n;
    let err: unknown;
    try { await recorderWindowGate(ctx, agent(), { maxWaitMs: 0, sleep: async () => {} }); } catch (e) { err = e; }
    expect(isPublishError(err, "RECORDER_HISTORY")).toBe(true);
  });

  test("a dry run warps the local simulation chain by the missing seconds, once, then the stage starts", async () => {
    const { ctx, state, spawned } = setup({ chainId: 8453, simRpc: "http://127.0.0.1:18546" });
    state.oldest = state.now - 100n;
    await recorderWindowGate(ctx, agent());
    const warps = spawned.filter((c) => c[1] === "rpc" && c[2] === "evm_increaseTime");
    expect(warps).toHaveLength(1);
    expect(Number(warps[0]![3])).toBe(NEED - 100);
    expect(spawned.some((c) => c[1] === "rpc" && c[2] === "evm_mine")).toBe(true);
    expect(spawned.every((c) => c.includes("http://127.0.0.1:18546"))).toBe(true); // only the local chain is touched
  });

  test("the warp never reaches a non-loopback simulation chain", async () => {
    const { ctx, state } = setup({ simRpc: "http://rpc.example:8545" });
    state.oldest = state.now - 100n;
    await expect(recorderWindowGate(ctx, agent())).rejects.toThrow(/refusing to warp/);
  });

  test("a warp that does not give the recorder its history is refused (the clock did not move)", async () => {
    const { ctx, state } = setup({ simRpc: "http://127.0.0.1:18546" });
    state.oldest = state.now - 100n;
    (ctx as { run: unknown }).run = async () => ({ code: 0, stdout: "", stderr: "" }); // evm_increaseTime that moves nothing
    await expect(recorderWindowGate(ctx, agent())).rejects.toThrow(/holds .* s of history/);
  });

  test("a vault stage with no UniswapV4 asset (an empty agent list, the other baskets) never reads the recorder", async () => {
    const { ctx, state } = setup({ v4: false });
    await recorderWindowGate(ctx, agent(), { sleep: async () => { throw new Error("must not wait"); } });
    await recorderWindowGate(ctx, stageByName("proto"));
    expect(state.reads).toEqual([]);
  });

  test("a stage without a vault (the recorder stage itself) never waits", async () => {
    const { ctx, state } = setup();
    await recorderWindowGate(ctx, stageByName("recorder"));
    expect(state.reads).toEqual([]);
  });
});

describe("the runner refuses the agent stage while the recorder is young (full CLI run on stub forge)", () => {
  test("the agent script is never simulated or broadcast, and the run exits RECORDER_HISTORY", async () => {
    const w = world({ startNonce: 0 });
    copyFileSync(join(REPO, "config", "agent-token-shortlist.json"), join(w.coreDir, "config", "agent-token-shortlist.json"));
    // every V3 pool is healthy (the proto and rwa config-checks pass); the RM V4 pool is funded; the recorder holds only 60 s of history
    const base = healthyPoolReader();
    const reader: ChainReader = {
      ...base,
      read: async (_to: string, sig: string) => { if (sig.includes("oldestObservation")) return NOW_TS - 60n; throw new Error(`unexpected read ${sig}`); },
      callRaw: async (to: string, data: Hex, from?: string) => {
        if (data.startsWith("0xc815641c")) return { ok: true, data: `0x${[1n << 96n, 0n, 0n, 29100n].map((n) => n.toString(16).padStart(64, "0")).join("")}` as Hex };
        if (data.startsWith("0xfa6793d5")) return { ok: true, data: `0x${(10n ** 18n).toString(16).padStart(64, "0")}` as Hex };
        return base.callRaw(to as never, data, from as never);
      },
    } as ChainReader;
    const code = await w.run(["--stage", "deploy"], { chainReader: () => reader, recorderWait: { maxWaitMs: 0, sleep: async () => {} } });
    expect(code).not.toBe(0);
    const scripts = w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script").map((c: any) => String(c.args[1]));
    expect(scripts.some((s: string) => s.includes("DeployAgentTokenVault"))).toBe(false);
    expect(w.logs().some((l) => l.event === "run.failed" && l.kind === "RECORDER_HISTORY")).toBe(true);
  });
});
