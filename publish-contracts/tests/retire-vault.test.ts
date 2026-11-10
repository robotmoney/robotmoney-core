// Issue 1912, ADR-0017, ADR-0009: the govern row `retire-vault` retires one vault (rmAGENT on the live v0.5.0 deployment) in ONE timelock batch,
// registry.migrateEligibility(vault, false, the legs that stay) then registry.retire(vault). In-memory Safe and timelock (tests/govern-world.ts). The fixture is the
// four vaults of the current table (rmHARD since ADR-0018) plus RETIRED_VAULT, listed and router-eligible with 0 bps.
import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { checkVaultRetirements, checkVaultRetirementsOnChain } from "../src/evidence-check.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { GOVERN_ROWS, govRowRefusal, resolveGovernRow, resumeCommand, runGovern, stageRows } from "../src/govern.ts";
import { parseCli } from "../src/cli.ts";
import { REGISTRY_REDEPLOY_ABI } from "../src/redeploy-vault.ts";
import { RETIRE_ROW, STAYING_KEYS, buildRetireCalls, parseRetireArgs, retireBeforeProblems, retireArgsText, retirePreviewLines, retireReadBackProblems, retireRecordKey } from "../src/retire-vault.ts";
import { newManifest } from "../src/runner.ts";
import { stageByName } from "../src/stages.ts";
import { A, RETIRED_VAULT, addr, fakeTimelock, sender, setup, signers } from "./govern-world.ts";

const DELAY = 172800n;
const ALL = { ELIGIBLE_VAULTS: "PROTO,RWA,HARD", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,RWA,HARD", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,RWA:0,HARD:0" };
const WEIGHTS = "USDC:9500,PROTO:500,RWA:0,HARD:0";
const ARGS = { vault: RETIRED_VAULT, weights: WEIGHTS };
/** The vaults that stay (the current table's four) and the live state with the retired vault as the third leg. */
const STAY = [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA, A.vaults.HARD];
const LIVE = [A.vaults.USDC, A.vaults.PROTO, RETIRED_VAULT, A.vaults.RWA, A.vaults.HARD];
const noWarp = async () => { throw new Error("no anvil_ or evm_ method on 8453"); };
const warpTo = (tl: ReturnType<typeof fakeTimelock>) => async (sec: bigint) => { tl.s.clock += sec; };
const opts = (sheet: ReturnType<typeof setup>["sheet"], tl: ReturnType<typeof fakeTimelock>, extra: object = {}) =>
  ({ ownerSigners: signers(sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000_000, emit: () => {}, ...extra });

/** The live state: five listed vaults, all router-eligible, the default vector 9500 / 500 / 0 / 0 / 0 (the retired vault is the third leg). */
function world(chainId = 918453, retire: Record<string, string> = ARGS) {
  const d = setup(ALL, chainId);
  const tl = fakeTimelock(d.sheet, DELAY);
  tl.s.listed = [...LIVE];
  tl.s.weights = { vaults: [...LIVE], bps: [9500n, 500n, 0n, 0n, 0n] };
  tl.s.paused = new Set();
  const manifest = newManifest(d.ctx, addr(0xa001));
  const run = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts(d.sheet, tl, { row: RETIRE_ROW, retire, ...extra }) as never);
  return { ...d, tl, manifest, run };
}

describe("the retire-vault arguments (issue 1912)", () => {
  test("a vault address and distinct staying-vault legs summing to 10000 parse (four here, three on v0.5.0), in the table's order whatever order they were typed in", () => {
    const w = parseRetireArgs({ vault: RETIRED_VAULT, weights: "HARD:0,RWA:0,PROTO:500,USDC:9500" });
    expect(w.vault.toLowerCase()).toBe(RETIRED_VAULT.toLowerCase());
    expect(w.weights).toEqual([{ key: "USDC", bps: 9500 }, { key: "PROTO", bps: 500 }, { key: "RWA", bps: 0 }, { key: "HARD", bps: 0 }]);
    expect(STAYING_KEYS).toEqual(["USDC", "PROTO", "RWA", "HARD"]);
    expect(retireArgsText(w)).toContain("--admin-arg weights=USDC:9500,PROTO:500,RWA:0,HARD:0");
    // the live v0.5.0 rmAGENT retire leaves three legs: a subset of the keys parses too, in VAULT_KEYS order (the chain check decides the right set)
    const three = parseRetireArgs({ vault: RETIRED_VAULT, weights: "RWA:0,PROTO:500,USDC:9500" });
    expect(three.weights).toEqual([{ key: "USDC", bps: 9500 }, { key: "PROTO", bps: 500 }, { key: "RWA", bps: 0 }]);
  });
  test("a vector that is not distinct known legs summing to 10000 is refused with USAGE", () => {
    const refuse = (a: Record<string, string>, why: string) => expect(() => parseRetireArgs(a), why).toThrow(/retire-vault/);
    refuse({ weights: WEIGHTS }, "no vault");
    refuse({ vault: "rmAGENT", weights: WEIGHTS }, "vault is not an address");
    refuse({ vault: RETIRED_VAULT }, "no weights");
    refuse({ vault: RETIRED_VAULT, weights: "USDC:9000,PROTO:500" }, "two legs summing to 9500");
    refuse({ vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:500,RWA:0,HARD:0,AGENT:0" }, "AGENT is not a key: the retired vault has no leg");
    refuse({ vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:500,NOPE:0" }, "an unknown key");
    refuse({ vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:500,RWA:1,HARD:0" }, "sums to 10001");
    refuse({ vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:400,RWA:0,HARD:0" }, "sums to 9900");
    refuse({ vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:250,PROTO:250,RWA:0,HARD:0" }, "a leg twice");
    refuse({ vault: RETIRED_VAULT, weights: "USDC:9500;PROTO:500;RWA:0;HARD:0" }, "not KEY:bps pairs");
    try { parseRetireArgs({ vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:500" }); } catch (e) { expect((e as { kind: string }).kind).toBe("USAGE"); }
  });
  test("the CLI refuses a bad row argument before any signer, and accepts a good one", () => {
    const base = ["govern", "--chain", "8453", "--core-sha", "a".repeat(40), "--rpc", "http://x", "--sheet", "s", "--signer", "ledger", "--row", RETIRE_ROW];
    const bad = [["--admin-arg", `vault=${RETIRED_VAULT}`], ["--admin-arg", `vault=${RETIRED_VAULT}`, "--admin-arg", "weights=USDC:9000,PROTO:500"], ["--admin-arg", `vault=${RETIRED_VAULT}`, "--admin-arg", "weights=USDC:9500,PROTO:500,AGENT:0"], ["--admin-arg", "colour=red"], []];
    for (const extra of bad) expect(() => parseCli([...base, ...extra])).toThrow();
    const ok = parseCli([...base, "--admin-arg", `vault=${RETIRED_VAULT}`, "--admin-arg", `weights=${WEIGHTS}`]);
    expect(ok.row).toBe(RETIRE_ROW);
    expect(ok.adminArgs).toEqual({ vault: RETIRED_VAULT, weights: WEIGHTS });
  });
  test("it is on demand: not a numbered row, not in the matrix, not part of stage 13, allowed in production on 8453", () => {
    expect([...GOVERN_ROWS]).not.toContain(RETIRE_ROW);
    expect([...stageRows(8453)]).not.toContain(RETIRE_ROW);
    expect(() => resolveGovernRow(RETIRE_ROW)).toThrow("on-demand");
    for (const kind of ["production", "rehearsal"] as const) for (const chain of [8453, 918453]) expect(govRowRefusal(RETIRE_ROW, chain, kind)).toBeUndefined();
  });
});

describe("the batch (issue 1912)", () => {
  const calls = () => buildRetireCalls({ registry: A.registry, vault: RETIRED_VAULT, finalVaults: STAY, finalBps: [9500, 500, 0, 0] });
  test("two calls to the registry in the one order the contracts allow: migrateEligibility(vault, false, the legs that stay) then retire(vault)", () => {
    const c = calls();
    expect(c.map((x) => x.target)).toEqual([A.registry, A.registry]);
    const a = decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: c[0]!.data });
    expect(a.functionName).toBe("migrateEligibility");
    expect(a.args).toEqual([RETIRED_VAULT, false, STAY, [9500n, 500n, 0n, 0n]]);
    const b = decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: c[1]!.data });
    expect(b.functionName).toBe("retire");
    expect(b.args).toEqual([RETIRED_VAULT]);
  });
  test("a vector that is not four distinct legs of 10000 bps, or that holds the retired vault, builds nothing", () => {
    const build = (v: readonly string[], b: readonly number[]) => () => buildRetireCalls({ registry: A.registry, vault: RETIRED_VAULT, finalVaults: v, finalBps: b });
    expect(build([], [])).toThrow("at least one leg");
    expect(build(STAY, [9500, 500, 0])).toThrow("one weight per leg");
    expect(build(STAY.slice(0, 3), [9500, 500, 0])).not.toThrow(); // a three-leg vector builds: the before check decides it against the chain
    expect(build([A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA, RETIRED_VAULT], [9500, 500, 0, 0])).toThrow("must not hold the vault being retired");
    expect(build([A.vaults.USDC, A.vaults.PROTO, A.vaults.PROTO, A.vaults.RWA], [9500, 400, 100, 0])).toThrow("lists a vault twice");
    expect(build(STAY, [9500, 500, 1, 0])).toThrow("sums to 10001");
  });
  test("the preview names the vault, the vector that stays and each call's target and data", () => {
    const want = parseRetireArgs(ARGS);
    const lines = retirePreviewLines(want, STAY, calls());
    expect(lines[0]).toContain("withdraw-only");
    expect(lines[1]).toContain(`USDC ${A.vaults.USDC} 9500 bps`);
    expect(lines.slice(2).map((l) => l.split(" -> ")[0])).toEqual(["call 1: registry.migrateEligibility(vault, false, the legs that stay)", "call 2: registry.retire(vault)"]);
  });
  test("the before check passes on the live state (four vaults plus the one to retire) and names each thing that would revert", () => {
    const want = parseRetireArgs(ARGS);
    const good = { listed: LIVE, status: 0, eligible: true, registryRouter: A.router, router: A.router, timelockIsRegistryAdmin: true, votedWeightsActive: false, defaultVaults: LIVE, hasCode: true };
    expect(retireBeforeProblems(want, STAY, good)).toEqual([]);
    const p = (o: object) => retireBeforeProblems(want, STAY, { ...good, ...o }).join("; ");
    expect(p({ hasCode: false })).toContain("has no code");
    expect(p({ listed: STAY })).toContain("does not list the vault");
    expect(p({ status: 2 })).toContain("want Active");
    expect(p({ eligible: false })).toContain("not router-eligible");
    expect(p({ registryRouter: addr(1) })).toContain("RouterNotLinked");
    expect(p({ timelockIsRegistryAdmin: false })).toContain("ADMIN_ROLE on the registry");
    expect(p({ votedWeightsActive: true })).toContain("clear-voted-weights");
    expect(p({ defaultVaults: STAY })).toContain("does not hold the vault");
    expect(p({ defaultVaults: [A.vaults.USDC, A.vaults.PROTO, RETIRED_VAULT, A.vaults.RWA, addr(0x7777)] })).toContain("LengthMismatch");
  });
  test("the chain decides the leg count: a three-leg vector passes when the default holds three vaults plus the retiree, and is refused when it holds four plus the retiree", () => {
    const three = parseRetireArgs({ vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:500,RWA:0" });
    const THREE_STAY = [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA];
    const V050 = [A.vaults.USDC, A.vaults.PROTO, RETIRED_VAULT, A.vaults.RWA];
    const before = { listed: V050, status: 0, eligible: true, registryRouter: A.router, router: A.router, timelockIsRegistryAdmin: true, votedWeightsActive: false, defaultVaults: V050, hasCode: true };
    expect(retireBeforeProblems(three, THREE_STAY, before)).toEqual([]);
    expect(retireBeforeProblems(three, THREE_STAY, { ...before, listed: LIVE, defaultVaults: LIVE }).join("; ")).toContain("LengthMismatch");
    // and the four-leg vector is refused on the three-vault state
    expect(retireBeforeProblems(parseRetireArgs(ARGS), STAY, before).join("; ")).toContain("LengthMismatch");
  });
  test("the read-back passes on the four-leg end state and names each difference", () => {
    const after = { status: 2, eligible: false, eligibleCount: 4, votedWeightsActive: false, defaultVaults: STAY, defaultBps: [9500, 500, 0, 0], effectiveVaults: STAY, effectiveBps: [9500, 500, 0, 0], retiredFlag: true, hasCode: true };
    expect(retireReadBackProblems(STAY, [9500, 500, 0, 0], after)).toEqual([]);
    const p = (o: object) => retireReadBackProblems(STAY, [9500, 500, 0, 0], { ...after, ...o }).join("; ");
    expect(p({ status: 0 })).toContain("want Retired");
    expect(p({ eligible: true })).toContain("still router-eligible");
    expect(p({ eligibleCount: 5 })).toContain("routerEligibleCount() is 5, want 4");
    expect(p({ votedWeightsActive: true })).toContain("votedWeightsActive");
    expect(p({ defaultBps: [9000, 1000, 0, 0] })).toContain("getDefaultWeights");
    expect(p({ effectiveVaults: LIVE, effectiveBps: [9500, 500, 0, 0, 0] })).toContain("getEffectiveWeights");
    expect(p({ retiredFlag: false })).toContain("retired() flag");
    expect(p({ hasCode: false })).toContain("no code");
  });
});

describe("the row, on the live state: four vaults plus the one to retire (issue 1912)", () => {
  test("one batch of two calls: eligible count 5 to 4, the default vector shrinks to four legs, the vault is Retired and the evidence entry is recorded", async () => {
    const w = world();
    const eligible = () => w.tl.s.listed.filter((v) => !w.tl.s.ineligible.has(v)).length;
    expect(eligible()).toBe(5);
    const res = await w.run({ warp: warpTo(w.tl) });
    expect(res.rows).toEqual([retireRecordKey(RETIRED_VAULT)]);
    expect(w.tl.s.events).toEqual(["scheduleBatch:retire-vault", "executeBatch:retire-vault"]);
    const sc = w.tl.s.scheduled.get(RETIRE_ROW)!;
    expect(sc.form).toBe("batch");
    expect(sc.calls).toEqual(buildRetireCalls({ registry: A.registry, vault: RETIRED_VAULT, finalVaults: STAY, finalBps: [9500, 500, 0, 0] }).map(({ target, data }) => ({ target, data })));
    expect(eligible()).toBe(4);
    expect(w.tl.s.weights).toEqual({ vaults: STAY, bps: [9500n, 500n, 0n, 0n] });
    expect(w.tl.s.statuses.get(RETIRED_VAULT)).toBe(2);
    expect(w.tl.s.retiredFlag.has(RETIRED_VAULT)).toBe(true);
    expect(w.manifest.stages.govern).toBeUndefined();
    const entries = (w.manifest as { vault_retirements?: any[] }).vault_retirements!;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ step: RETIRE_ROW, round: 1, vault: RETIRED_VAULT, registry: A.registry, router: A.router, timelock: A.timelock, vaults: STAY, bps: [9500, 500, 0, 0], voted_weights_active: false, effective_vaults: STAY, effective_bps: [9500, 500, 0, 0], schedule_status: 1, execute_status: 1 });
    expect(entries[0].execute_block_timestamp - entries[0].schedule_block_timestamp).toBeGreaterThanOrEqual(Number(DELAY));
  });
  test("the evidence entry passes the offline retirement check and a tampered one does not", async () => {
    const w = await (async () => { const x = world(); await x.run({ warp: warpTo(x.tl) }); return x; })();
    const entry = (w.manifest as { vault_retirements?: any[] }).vault_retirements![0];
    const ev = (e: any) => ({ registry: { address: A.registry }, timelock: { address: A.timelock }, vault_retirements: [e] });
    expect(checkVaultRetirements(ev(entry), 172800)).toEqual([]);
    const bad = (edit: (e: any) => void) => { const e = JSON.parse(JSON.stringify(entry)); edit(e); return checkVaultRetirements(ev(e), 172800).join("\n"); };
    expect(bad((e) => { e.vaults = [...e.vaults, addr(0x6666)]; e.bps = [...e.bps, 0]; })).toContain("1 to 4 distinct addresses");
    expect(bad((e) => { e.bps = [9500, 500, 1, 0]; })).toContain("sum to 10000");
    expect(bad((e) => { e.vaults[2] = e.vault; })).toContain("is still in the default vector");
    expect(bad((e) => { e.registry = addr(0x1); })).toContain("is not the run's registry");
    expect(bad((e) => { e.execute_block_timestamp = e.schedule_block_timestamp + 172799; })).toContain("gap");
    expect(bad((e) => { e.voted_weights_active = true; })).toContain("voted_weights_active is true");
    expect(bad((e) => { e.step = "unpause-USDC"; })).toContain("is not retire-vault");
    // a chain read back: the stub serves the two CallScheduled events and the two CallExecuted events of the batch
    expect(typeof checkVaultRetirementsOnChain).toBe("function");
  });
  test("on 8453 in production the first run schedules and exits GOVERN_PENDING with the resume command, the resume after the delay executes", async () => {
    const w = world(8453);
    await expect(w.run({ warp: noWarp, maxWaitSeconds: 0 })).rejects.toMatchObject({ kind: "GOVERN_PENDING", message: expect.stringContaining("--row retire-vault") });
    expect(w.tl.s.events).toEqual(["scheduleBatch:retire-vault"]);
    expect(w.tl.s.statuses.get(RETIRED_VAULT)).toBeUndefined();
    expect(resumeCommand(w.ctx, retireRecordKey(RETIRED_VAULT))).toContain(`--row ${RETIRE_ROW} --admin-arg K=V`);
    w.tl.s.clock += DELAY + 1n;
    await w.run({ warp: noWarp });
    expect(w.tl.s.events).toEqual(["scheduleBatch:retire-vault", "executeBatch:retire-vault"]);
    expect(w.tl.s.statuses.get(RETIRED_VAULT)).toBe(2);
  });
  test("a second run finds the round complete and sends nothing", async () => {
    const w = world();
    await w.run({ warp: warpTo(w.tl) });
    const events = w.tl.s.events.length;
    const res = await w.run({ warp: warpTo(w.tl) });
    expect(res.rows).toEqual([retireRecordKey(RETIRED_VAULT)]);
    expect(w.tl.s.events.length).toBe(events);
    expect((w.manifest as { vault_retirements?: unknown[] }).vault_retirements).toHaveLength(1);
  });
  test("it refuses (GOVERN) and schedules nothing from a state the batch would revert in", async () => {
    const cases: [string, (w: ReturnType<typeof world>) => void, string][] = [
      ["a vault the registry does not list", (w) => { w.tl.s.listed = [...STAY]; }, "does not list the vault"],
      ["a vault that is not router-eligible", (w) => { w.tl.s.ineligible.add(RETIRED_VAULT); w.tl.s.weights = { vaults: STAY, bps: [9500n, 500n, 0n, 0n] }; }, "not router-eligible"],
      ["a vault already Retired", (w) => { w.tl.s.statuses.set(RETIRED_VAULT, 2); }, "want Active"],
      ["an active (voted) vector that still names the vault", (w) => { w.tl.s.voted = { vaults: LIVE, bps: [9000n, 500n, 250n, 250n, 0n] }; }, "clear-voted-weights"],
      ["a router vector that is not the four that stay", (w) => { w.tl.s.weights = { vaults: [A.vaults.USDC, RETIRED_VAULT, addr(0x7777), A.vaults.RWA, A.vaults.HARD], bps: [9500n, 500n, 0n, 0n, 0n] }; }, "LengthMismatch or VaultNotActive"],
    ];
    for (const [what, arm, message] of cases) {
      const w = world();
      arm(w);
      await expect(w.run({ warp: warpTo(w.tl) }), what).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining(message) });
      expect(w.tl.s.events, what).toEqual([]);
    }
  });
  test("a three-leg vector on the four-vault deployment (rmHARD left out) is refused by the chain check (GOVERN), nothing scheduled", async () => {
    const w = world(918453, { vault: RETIRED_VAULT, weights: "USDC:9500,PROTO:500,RWA:0" });
    await expect(w.run({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining("LengthMismatch or VaultNotActive") });
    expect(w.tl.s.events).toEqual([]);
  });
  test("a vector with the wrong sum or an unknown or repeated leg is refused before the Safe is read, nothing scheduled", async () => {
    for (const weights of ["USDC:9000,PROTO:500", "USDC:9500,PROTO:500,RWA:1,HARD:0", "USDC:9500,PROTO:500,RWA:0,HARD:0,AGENT:0", "USDC:9500,PROTO:250,PROTO:250,RWA:0"]) {
      const w = world(918453, { vault: RETIRED_VAULT, weights });
      await expect(w.run({ warp: warpTo(w.tl) }), weights).rejects.toMatchObject({ kind: "USAGE", exitCode: EXIT_CODES.USAGE });
      expect(w.tl.s.events).toEqual([]);
    }
  });
  test("a read-back that finds the vault still eligible fails the round and records nothing as governed", async () => {
    const w = world();
    w.tl.s.reads.routerEligibleCount = 5n;
    await expect(w.run({ warp: warpTo(w.tl) })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("routerEligibleCount() is 5, want 4") });
    expect((w.manifest as { vault_retirements?: unknown[] }).vault_retirements).toBeUndefined();
  });
  test("the executed vault stays withdraw-only: nothing in the batch touches a holder (the calls are the two registry calls and no vault call)", () => {
    const c = buildRetireCalls({ registry: A.registry, vault: RETIRED_VAULT, finalVaults: STAY, finalBps: [9500, 500, 0, 0] });
    for (const x of c) expect(x.target).not.toBe(RETIRED_VAULT);
  });
});

// Issue 1927: runbook 4.15 runs the row with --core-dir the live v0.5.0 checkout. Its stage table (the committed copy in tests/fixtures/v050) has the agent stage and the ic-policy stage, and
// its manifest set names rmAGENT in agent-token-vault.json and the receipt in ic-policy.json. The row reads the registry, the router, the governance and the three vaults that stay from
// those manifests; the retired rmAGENT row of the table is not a vault the row governs (stages.ts RETIRED_VAULT_STAGES). Core 2008: the v0.5.0 line has no rmHARD, so the vector that stays
// is three legs, which the row accepts because the chain's default vector holds exactly those three plus rmAGENT.
describe("the row against a v0.5.0 manifest set (issue 1927)", () => {
  test("the four-vault v0.5.0 manifests: the batch retires rmAGENT, the three legs come from the v0.5.0 manifests and the evidence entry is recorded", async () => {
    const { loadStageTable } = await import("../src/stage-table.ts");
    const stages = await import("../src/stages.ts");
    const { RETIRE_WEIGHTS } = await import("../src/ci/upgrade-from-v050-commands.ts");
    const { peekStageState, restoreStageState, useStageTable } = stages;
    const { loadGovernAddrs } = await import("../src/govern.ts");
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const THREE_STAY = [A.vaults.USDC, A.vaults.PROTO, A.vaults.RWA];
    const V050 = [A.vaults.USDC, A.vaults.PROTO, RETIRED_VAULT, A.vaults.RWA];
    expect(RETIRE_WEIGHTS).toBe("USDC:9500,PROTO:500,RWA:0");
    const w = world(918453, { vault: RETIRED_VAULT, weights: RETIRE_WEIGHTS });
    w.tl.s.listed = [...V050];
    w.tl.s.weights = { vaults: [...V050], bps: [9500n, 500n, 0n, 0n] };
    const was = peekStageState();
    useStageTable(loadStageTable(join(import.meta.dir, "fixtures", "v050")));
    try {
      expect(stages.VAULT_STAGES.map((v) => v.key)).toEqual(["USDC", "PROTO", "RWA"]);
      expect(stages.RETIRED_VAULT_STAGES).toEqual([{ key: "AGENT", stage: "agent", manifest: "deployments/<chain>/agent-token-vault.json", artifact: "AgentTokenVault" }]);
      const dir = join(w.ctx.coreDir, "deployments", "918453");
      writeFileSync(join(dir, "agent-token-vault.json"), JSON.stringify({ vault: RETIRED_VAULT }));
      writeFileSync(join(dir, "ic-policy.json"), JSON.stringify({ consensus_receipt: A.receipt, policy: addr(0x1007) }));
      const a = loadGovernAddrs(w.ctx);
      expect(a.vaults as Record<string, string>).toEqual({ USDC: A.vaults.USDC, PROTO: A.vaults.PROTO, RWA: A.vaults.RWA });
      await w.run({ warp: warpTo(w.tl) });
      expect(w.tl.s.events).toEqual(["scheduleBatch:retire-vault", "executeBatch:retire-vault"]);
      expect(w.tl.s.statuses.get(RETIRED_VAULT)).toBe(2);
      expect(w.tl.s.weights).toEqual({ vaults: THREE_STAY, bps: [9500n, 500n, 0n] });
      expect((w.manifest as { vault_retirements?: any[] }).vault_retirements![0]).toMatchObject({ vault: RETIRED_VAULT, vaults: THREE_STAY, bps: [9500, 500, 0], registry: A.registry });
      // the historical three-leg evidence entry still passes the offline retirement check
      expect(checkVaultRetirements({ registry: { address: A.registry }, timelock: { address: A.timelock }, vault_retirements: (w.manifest as { vault_retirements?: any[] }).vault_retirements }, 60)).toEqual([]);
    } finally { restoreStageState(was); }
  });
});
