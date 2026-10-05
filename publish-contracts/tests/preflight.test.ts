// devops 58 (S11): the preflight simulates EVERY deployer stage and broadcasts nothing. The stub forge counts a broadcast only with
// --broadcast and moves the sender nonce only then, so "nonce unchanged" and "no --broadcast" are the same fact seen two ways.
// The blank local chain is a test double here (tests/harness.ts fakeChain); the real starter is src/preflight.ts startAnvil.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ADMIN, LOCAL_RPC, SCRIPT, world } from "./harness.ts";
import { impersonatedSender } from "../src/safe/index.ts";
import { topUpSimulationUsdc } from "../src/preflight.ts";
import { dryRunOrder, forgeFailureTail } from "../src/runner.ts";
import { STAGE_NAMES, stageByName } from "../src/stages.ts";

/** The forge contract a stage runs, from core's stage table. */
const contractOf = (stage: string): string => stageByName(stage).script!.split(":")[1]!;

const calls = (w: ReturnType<typeof world>) => w.state().calls as { tool: string; args: string[]; rpcEnv?: string }[];

describe("preflight (--dry-run)", () => {
  test("simulates every deployer stage including the vault stages, exits 0, leaves the nonce and sends no --broadcast", async () => {
    const w = world();
    w.setNonce(0);
    const code = await w.run(["--stage", "deploy", "--dry-run"]);
    expect(code).toBe(0);
    const forge = calls(w).filter((c) => c.tool === "forge" && c.args[0] === "script");
    const scripts = forge.map((c) => c.args[1]!.split(":")[1]);
    for (const st of ["vault", "proto", "agent", "rwa", "timelock", "gateway"]) expect(scripts).toContain(contractOf(st));
    expect(forge.filter((c) => !c.args.includes("--broadcast")).length).toBe(11);
    // a stage is applied to the local chain only (so the next stage finds its contracts), never to the target RPC
    for (const c of forge.filter((c) => c.args.includes("--broadcast"))) { expect(c.rpcEnv).toBe(LOCAL_RPC); expect(c.args).toContain("--unlocked"); }
    expect(w.logs().filter((l) => l.event === "stage.broadcast").length).toBe(0);
  });
  test("a vault stage alone still simulates the stages before it, in order, to make its inputs", async () => {
    const w = world();
    expect(await w.run(["--stage", "rwa", "--dry-run"])).toBe(0);
    const order = calls(w).filter((c) => c.tool === "forge" && c.args[0] === "script").map((c) => c.args[1]!.split(":")[1]);
    expect(order.at(-1)).toBe(contractOf("rwa"));
    expect(order).toContain(contractOf("registry"));
    expect(order).toContain(contractOf("router"));
    expect(order.indexOf(contractOf("vault"))).toBeLessThan(order.indexOf(contractOf("registry")));
  });
  test("forge simulates on the local chain, never on the target RPC, and the chain is started and stopped", async () => {
    const w = world();
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    for (const c of calls(w).filter((c) => c.tool === "forge" && c.args[0] === "script")) expect(c.rpcEnv).toBe(LOCAL_RPC);
    expect(w.chainEvents).toEqual(["start", "stop"]);
    expect(calls(w).some((c) => c.tool === "cast" && c.args[0] === "rpc" && c.args[1] === "anvil_setBalance" && c.args.includes(LOCAL_RPC))).toBe(true);
  });
  // Regression (publish / preflight, run 37350933028): the preflight ran on a BLANK anvil, so the vault stage died on "USDC_ADDRESS has no code"
  // and the registry stage on "VAULT_ADDRESS has no code". The simulation chain is a fork of the target, and each stage is applied to it.
  test("the local chain forks the target RPC, so the real USDC and venues exist there", async () => {
    const w = world();
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    expect(w.forkUrls.length).toBe(1);
    expect(w.forkUrls[0]).toBeDefined();
    expect(w.forkUrls[0]).not.toBe(LOCAL_RPC);
  });
  test("every simulated stage is applied to the local chain right after its simulation, in table order, and the Safe is created there too", async () => {
    const w = world();
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    const forge = calls(w).filter((c) => c.tool === "forge" && c.args[0] === "script");
    const seq = forge.map((c) => `${c.args[1]!.split(":")[1]}${c.args.includes("--broadcast") ? "+applied" : ""}`);
    const forgeStages = dryRunOrder(["timelock"]).filter((s) => s.kind === "forge");
    expect(seq).toEqual(forgeStages.flatMap((s) => [contractOf(s.name), `${contractOf(s.name)}+applied`]));
    expect(w.safeCalls).toContain("createSafe:local");
    expect(w.logs().filter((l) => l.event === "stage.sim_applied").length).toBe(forgeStages.length + 1);
    expect(w.logs().filter((l) => l.event === "stage.broadcast").length).toBe(0);
  });
  test("a stage that simulates but cannot be applied to the local chain fails the preflight", async () => {
    const w = world();
    w.cfg.failBroadcast = SCRIPT.vault;
    expect(await w.run(["--stage", "deploy", "--dry-run"])).not.toBe(0);
    expect(w.chainEvents).toEqual(["start", "stop"]);
  });
  test("the manifests the simulations wrote are removed and no run manifest is saved", async () => {
    const w = world();
    expect(await w.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    const dir = join(w.coreDir, "deployments", "918453");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(existsSync(join(w.evidence, "publish-run.json"))).toBe(false);
  });
  test("a failing simulation of one vault script fails the preflight and the chain is still stopped", async () => {
    const w = world();
    w.cfg.simFails = SCRIPT.agent;
    expect(await w.run(["--stage", "deploy", "--dry-run"])).not.toBe(0);
    expect(w.chainEvents).toEqual(["start", "stop"]);
  });
  test("an address: signer is accepted for a dry run and refused for a broadcast", async () => {
    const w = world();
    expect(await w.run(["--stage", "proto", "--dry-run"], { signer: `address:${ADMIN}`, makeSigner: undefined as never })).toBe(0);
    expect(await w.run(["--stage", "proto"], { signer: `address:${ADMIN}`, makeSigner: undefined as never })).not.toBe(0);
  });
  test("a dry run on 8453 still refuses a planted short delay", async () => {
    const w = world({ chainId: 8453, sheet: { TIMELOCK_MIN_DELAY: "60" } });
    expect(await w.run(["--stage", "deploy", "--dry-run"])).not.toBe(0);
    expect(calls(w).filter((c) => c.tool === "forge").length).toBe(0);
  });
  test("a forge failure that is only 'Error: EVM error' keeps the trace lines that say why", () => {
    const tail = forgeFailureTail("Traces:\n  [1] Foo::run()\n    └─ ← [Revert] USDC_ADDRESS has no code\nError: EVM error", "");
    expect(tail).toContain("USDC_ADDRESS has no code");
    const bare = forgeFailureTail("Compiling...\nTraces:\n  [2] Bar::go()\n    └─ ← custom error 0xdeadbeef\nError: EVM error", "");
    expect(bare).toContain("custom error 0xdeadbeef");
  });
  test("the impersonated sender and the USDC top-up refuse anything that is not the local anvil", async () => {
    expect(() => impersonatedSender(ADMIN as `0x${string}`, { rpcUrl: "https://mainnet.base.org", chainId: 8453 })).toThrow();
    expect(() => impersonatedSender(ADMIN as `0x${string}`, { rpcUrl: "http://127.0.0.1:8545", chainId: 8453 })).toThrow();
    expect(impersonatedSender(ADMIN as `0x${string}`, { rpcUrl: "http://127.0.0.1:8545", chainId: 918453 }).kind).toBe("address-only");
    await expect(topUpSimulationUsdc("http://127.0.0.1:1", ADMIN, 1n)).rejects.toThrow();
  });
  test("dryRunOrder names every deployer stage up to the last asked for and drops verify and govern", () => {
    expect(dryRunOrder(["rwa"]).map((s) => s.name)).toEqual(STAGE_NAMES.slice(0, STAGE_NAMES.indexOf("rwa") + 1));
    expect(dryRunOrder(["timelock", "verify"]).map((s) => s.name).slice(-2)).toEqual(["timelock", "verify"]);
  });
});
