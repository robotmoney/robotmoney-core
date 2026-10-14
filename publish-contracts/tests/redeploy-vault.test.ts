// Issue 1796: redeploy ONE vault (rmPROTO) into a live deployment. The pure parts (vectors, the five-call batch, the before and after checks), the `redeploy-vault` verb
// (stub forge and cast, a fake chain reader), the govern row (the in-memory Safe and timelock of tests/govern-world.ts, which enforces the contract rules the batch order exists for),
// the verifier's retired-vault labels and the evidence entry. The real contracts run in contracts/test/RedeployProtocolAssetVault.t.sol and in the fork rehearsal.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { EXIT_CODES } from "../src/errors.ts";
import { parseCli, USAGE } from "../src/cli.ts";
import { GOVERN_ROWS, govRowRefusal, resumeCommand, runGovern, stageRows } from "../src/govern.ts";
import {
  REDEPLOY_ROW, REGISTRY_REDEPLOY_ABI, ROUTER_REDEPLOY_ABI, VAULT_REDEPLOY_ABI, buildRedeployCalls, buildRestoreOldCalls, planRedeployVectors, redeployBeforeProblems, redeployReadBackProblems, redeployRecordKey, redeployRefusal,
  redeploysOf, vectorsFromFinal, type RedeployAfter, type RedeployBefore, type RedeployRecord,
} from "../src/redeploy-vault.ts";
import { beginPauseEntry, loadRunManifest, newManifest, saveRunManifest, type RunManifest } from "../src/runner.ts";
import { stageByName } from "../src/stages.ts";
import { checkEvidence, checkVaultRedeploys, checkVaultRedeploysOnChain } from "../src/evidence-check.ts";
import { A, addr, fakeTimelock, sender, setup, signers, writeGovernManifests } from "./govern-world.ts";
import { ADMIN, typedPrompt, world } from "./harness.ts";
import { SHA, healthyPoolReader } from "./fixtures.ts";
import type { ChainReader } from "../src/verify/types.ts";
import { ADMIN_ROLE } from "../src/verify/constants.ts";

const USDC = A.vaults.USDC, OLD = A.vaults.PROTO, AGENT = A.vaults.AGENT, RWA = A.vaults.RWA;
const NEW = addr(0x3012);
const DEF_VAULTS = [USDC, OLD, AGENT, RWA];
const DEF_BPS = [8550, 525, 575, 350];
const REHEARSAL = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "7" };
const ALL = { ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:8550,PROTO:525,AGENT:575,RWA:350" };
const lc = (x: string) => x.toLowerCase();

describe("the vectors", () => {
  test("the new vault takes the old vault's slot and weight; the five-leg step keeps the old leg and gives the new leg 0", () => {
    const v = planRedeployVectors({ defaultVaults: DEF_VAULTS, defaultBps: DEF_BPS.map(BigInt), oldVault: OLD, newVault: NEW });
    expect(v.finalVaults).toEqual([USDC, NEW, AGENT, RWA]);
    expect(v.finalBps).toEqual(DEF_BPS);
    expect(v.preVaults).toEqual(DEF_VAULTS);
    expect(v.fiveVaults).toEqual([USDC, OLD, NEW, AGENT, RWA]);
    expect(v.fiveBps).toEqual([8550, 525, 0, 575, 350]);
    for (const b of [v.finalBps, v.fiveBps]) expect(b.reduce((t, x) => t + x, 0)).toBe(10000);
  });
  test("the five-leg and the pre vectors are rebuilt from the final vector alone (the evidence check has nothing else)", () => {
    const a = planRedeployVectors({ defaultVaults: DEF_VAULTS, defaultBps: DEF_BPS, oldVault: OLD, newVault: NEW });
    expect(vectorsFromFinal({ finalVaults: a.finalVaults, finalBps: a.finalBps, oldVault: OLD, newVault: NEW })).toEqual(a);
  });
  test("a vault in the first or the last slot works the same", () => {
    const first = planRedeployVectors({ defaultVaults: [OLD, USDC], defaultBps: [1000, 9000], oldVault: OLD, newVault: NEW });
    expect(first.fiveVaults).toEqual([OLD, NEW, USDC]);
    expect(first.fiveBps).toEqual([1000, 0, 9000]);
    const last = planRedeployVectors({ defaultVaults: [USDC, OLD], defaultBps: [9000, 1000], oldVault: OLD, newVault: NEW });
    expect(last.fiveVaults).toEqual([USDC, OLD, NEW]);
    expect(last.finalVaults).toEqual([USDC, NEW]);
  });
  test("refused: the old vault is absent or twice in the vector, the new vault is already in it, the sum is not 10000, lengths differ, old equals new", () => {
    const base = { defaultVaults: DEF_VAULTS, defaultBps: DEF_BPS, oldVault: OLD, newVault: NEW };
    expect(() => planRedeployVectors({ ...base, oldVault: addr(0x9) })).toThrow("does not hold the old vault");
    expect(() => planRedeployVectors({ ...base, defaultVaults: [USDC, OLD, OLD, RWA] })).toThrow("exactly once");
    expect(() => planRedeployVectors({ ...base, defaultVaults: [USDC, OLD, NEW, RWA] })).toThrow("already holds the new vault");
    expect(() => planRedeployVectors({ ...base, defaultBps: [8550, 525, 575, 351] })).toThrow("10000");
    expect(() => planRedeployVectors({ ...base, defaultBps: [8550, 525] })).toThrow("different lengths");
    expect(() => vectorsFromFinal({ finalVaults: [USDC, OLD], finalBps: [9000, 1000], oldVault: OLD, newVault: OLD })).toThrow("same address");
    expect(() => vectorsFromFinal({ finalVaults: [USDC, OLD], finalBps: [9000, 1000], oldVault: OLD, newVault: NEW })).toThrow("exactly once");
    expect(() => vectorsFromFinal({ finalVaults: [USDC, NEW, OLD], finalBps: [9000, 500, 500], oldVault: OLD, newVault: NEW })).toThrow("must not hold the old vault");
  });
});

describe("the batch", () => {
  const calls = () => buildRedeployCalls({ router: A.router, routerVaultCap: 525000n, registry: A.registry, oldVault: OLD, newVault: NEW, registryName: "Robot Money Protocol", asset: addr(0xc0de), finalVaults: [USDC, NEW, AGENT, RWA], finalBps: DEF_BPS });
  test("six calls in the one order the contracts allow: register, make the new vault eligible, drop the old one, retire it, open the new one", () => {
    const c = calls();
    expect(c.map((x) => x.target)).toEqual([A.registry, A.router, A.registry, A.registry, A.registry, NEW]);
    const d = c.filter((x) => x.target === A.registry).map((x) => decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: x.data }));
    expect(d.map((x) => x.functionName)).toEqual(["registerVault", "migrateEligibility", "migrateEligibility", "retire"]);
    expect(decodeFunctionData({ abi: ROUTER_REDEPLOY_ABI, data: c[1]!.data }).args).toEqual([NEW, 525000n]);
    expect(d[0]!.args).toEqual([NEW, { name: "Robot Money Protocol", asset: getAddress(addr(0xc0de)), registeredAt: 0n }]);
    expect(d[1]!.args).toEqual([NEW, true, [USDC, OLD, NEW, AGENT, RWA], [8550n, 525n, 0n, 575n, 350n]]);
    expect(d[2]!.args).toEqual([OLD, false, [USDC, NEW, AGENT, RWA], [8550n, 525n, 575n, 350n]]);
    expect(d[3]!.args).toEqual([OLD]);
    expect(decodeFunctionData({ abi: VAULT_REDEPLOY_ABI, data: c[5]!.data }).functionName).toBe("unpauseDeposits");
  });
  test("the old vault is made ineligible before it is retired (the registry reverts RetireWhileRouterEligible otherwise)", () => {
    const names = calls().map((x) => x.label);
    expect(names.findIndex((l) => l.includes("migrateEligibility(old"))).toBeLessThan(names.findIndex((l) => l.includes("retire(old)")));
  });
  test("the same inputs give the same calldata: the operation id survives a resume", () => expect(calls()).toEqual(calls()));
});

describe("the state before and after", () => {
  const before = (o: Partial<RedeployBefore> = {}): RedeployBefore => ({
    listed: [USDC, OLD, AGENT, RWA], oldStatus: 0, oldEligible: true, registryRouter: A.router, router: A.router, timelockIsRegistryAdmin: true, votedWeightsActive: false,
    defaultVaults: DEF_VAULTS, defaultBps: DEF_BPS, oldHasCode: true, ...o,
  });
  test("the deployment as Deploy 2 left it passes", () => expect(redeployBeforeProblems(OLD, NEW, before())).toEqual([]));
  test("each way the round cannot start is named", () => {
    const p = (o: Partial<RedeployBefore>) => redeployBeforeProblems(OLD, NEW, before(o)).join("|");
    expect(p({ oldHasCode: false })).toContain("has no code");
    expect(p({ listed: [USDC, AGENT, RWA] })).toContain("does not list the old vault");
    expect(p({ listed: [USDC, OLD, NEW] })).toContain("already lists the new vault");
    expect(p({ oldStatus: 2 })).toContain("Retired, want Active");
    expect(p({ oldEligible: false })).toContain("not router-eligible");
    expect(p({ registryRouter: addr(0x77) })).toContain("RouterNotLinked");
    expect(p({ timelockIsRegistryAdmin: false })).toContain("ADMIN_ROLE on the registry");
    expect(p({ votedWeightsActive: true })).toContain("clear-voted-weights");
    expect(p({ defaultVaults: [USDC, AGENT, RWA], defaultBps: [9000, 600, 400] })).toContain("does not hold the old vault");
  });
  const v = vectorsFromFinal({ finalVaults: [USDC, NEW, AGENT, RWA], finalBps: DEF_BPS, oldVault: OLD, newVault: NEW });
  const after = (o: Partial<RedeployAfter> = {}): RedeployAfter => ({
    oldStatus: 2, newStatus: 0, oldEligible: false, newEligible: true, eligibleCount: 4, votedWeightsActive: false, defaultVaults: v.finalVaults, defaultBps: v.finalBps,
    effectiveVaults: v.finalVaults, effectiveBps: v.finalBps, newPaused: false, oldRetiredFlag: true, oldHasCode: true, ...o,
  });
  test("the state the batch must leave passes, and each deviation is named", () => {
    expect(redeployReadBackProblems(v, after())).toEqual([]);
    const p = (o: Partial<RedeployAfter>) => redeployReadBackProblems(v, after(o)).join("|");
    expect(p({ oldStatus: 0 })).toContain("want Retired");
    expect(p({ newStatus: 1 })).toContain("want Active");
    expect(p({ oldEligible: true })).toContain("still router-eligible");
    expect(p({ newEligible: false })).toContain("not router-eligible");
    expect(p({ eligibleCount: 5 })).toContain("routerEligibleCount");
    expect(p({ votedWeightsActive: true })).toContain("votedWeightsActive");
    expect(p({ defaultBps: [8550, 525, 575, 351] })).toContain("getDefaultWeights");
    expect(p({ effectiveVaults: [USDC, OLD, AGENT, RWA] })).toContain("getEffectiveWeights");
    expect(p({ newPaused: true })).toContain("depositsPaused");
    expect(p({ oldRetiredFlag: false })).toContain("retired()");
    expect(p({ oldHasCode: false })).toContain("no code");
  });
});

describe("where it may run", () => {
  test("refused on 8453 in production, allowed on a rehearsal and on the Twin chain", () => {
    expect(redeployRefusal(8453, "production")).toContain("refused on chain 8453 in production");
    expect(redeployRefusal(8453, "rehearsal")).toBeUndefined();
    expect(redeployRefusal(918453, "production")).toBeUndefined();
    expect(govRowRefusal(REDEPLOY_ROW, 8453, "production")).toContain("open owner decision");
    expect(govRowRefusal(REDEPLOY_ROW, 8453, "rehearsal")).toBeUndefined();
  });
  test("the row is on demand: it is not one of the govern matrix rows and not part of stage 13", () => {
    expect(GOVERN_ROWS as readonly string[]).not.toContain(REDEPLOY_ROW);
    expect(stageRows(8453) as readonly string[]).not.toContain(REDEPLOY_ROW);
  });
  test("the resume command names the row, not the per-round key", () => {
    expect(resumeCommand({ chainId: 8453, coreSha: SHA }, redeployRecordKey("PROTO", 1))).toContain(`govern --row ${REDEPLOY_ROW} --chain 8453`);
    expect(resumeCommand({ chainId: 8453, coreSha: SHA }, redeployRecordKey("PROTO", 1))).not.toContain("PROTO-1");
  });
});

describe("the command line", () => {
  const base = ["--chain", "918453", "--rpc", "http://x", "--sheet", "s.env", "--core-sha", SHA, "--signer", "keystore:/k"];
  test("the verb needs --vault PROTO", () => {
    expect(parseCli(["redeploy-vault", "--vault", "PROTO", ...base])).toMatchObject({ verb: "redeploy-vault", vault: "PROTO" });
    expect(() => parseCli(["redeploy-vault", ...base])).toThrow("needs --vault");
    expect(() => parseCli(["redeploy-vault", "--vault", "AGENT", ...base])).toThrow("cannot be redeployed");
    expect(() => parseCli(["publish", "--vault", "PROTO", ...base])).toThrow("goes with the redeploy-vault verb only");
  });
  test("--row redeploy-vault parses with the govern verb and is refused elsewhere", () => {
    expect(parseCli(["govern", "--row", "redeploy-vault", ...base])).toMatchObject({ verb: "govern", row: "redeploy-vault" });
    expect(() => parseCli(["publish", "--row", "redeploy-vault", ...base])).toThrow("--row applies to the govern verb");
  });
  test("--prior-out goes with verify only", () => {
    expect(parseCli(["verify", "--prior-out", "/o", ...base]).priorOut).toBe("/o");
    expect(() => parseCli(["govern", "--prior-out", "/o", ...base])).toThrow("--prior-out goes with the verify");
  });
  test("the usage text documents the verb, the row and both arguments", () => {
    for (const w of ["redeploy-vault", "--vault KEY", "--prior-out DIR", "--row redeploy-vault", "registry.retire(old)"]) expect(USAGE).toContain(w);
  });
});

// ---- the verb ----------------------------------------------------------------------------------------------------------------------

const SCRIPT = "RedeployProtocolAssetVault.s.sol";
const TL = A.timelock, REG = A.registry, ROUTER = A.router;

/** A read-only chain that answers the deployment's state, and the new vault's, on top of the healthy pool chain the config-check reads. */
function chainOf(o: { listed?: readonly Address[]; oldStatus?: number; oldEligible?: boolean; voted?: boolean; defaultVaults?: Address[]; defaultBps?: number[]; newPaused?: boolean; newAdmin?: boolean; newLinked?: boolean } = {}): ChainReader {
  const listed = o.listed ?? [USDC, OLD, AGENT, RWA];
  const base = healthyPoolReader();
  return {
    ...base,
    read: async (at: string, sig: string, args: unknown[] = []) => {
      const fn = /function (\w+)/.exec(sig)![1]!;
      switch (fn) {
        case "listVaults": return listed;
        case "getVault": return [{ name: "Robot Money Protocol", asset: addr(0xc0de), registeredAt: 1n }, o.oldStatus ?? 0];
        case "isRouterEligible": return o.oldEligible ?? true;
        case "router": return ROUTER;
        case "votedWeightsActive": return o.voted ?? false;
        case "getDefaultWeights": return [o.defaultVaults ?? DEF_VAULTS, (o.defaultBps ?? DEF_BPS).map(BigInt)];
        case "depositsPaused": return o.newPaused ?? true;
        case "registry": return o.newLinked === false ? addr(0) : REG;
        case "hasRole": return lc(at) === lc(REG) ? lc(String(args[1])) === lc(TL) : lc(String(args[1])) === lc(TL) ? (o.newAdmin ?? true) : false;
      }
      throw new Error(`fake chain: ${fn}`);
    },
  } as unknown as ChainReader;
}

function verbWorld(o: { chainId?: number; sheet?: Record<string, string | null>; manifest?: Partial<RunManifest> | null } = {}) {
  const chainId = o.chainId ?? 918453;
  const w = world({ chainId, sheet: { ...ALL, ...(chainId === 8453 ? { ROUTER_WEIGHTS: "USDC:9500,PROTO:500,AGENT:0,RWA:0" } : {}), ...(o.sheet ?? {}) } });
  const dir = join(w.coreDir, "deployments", String(chainId));
  writeGovernManifests(dir);
  writeFileSync(join(dir, "libs.json"), JSON.stringify({ tick_math: addr(0x7001) }));
  w.cfg.counts[SCRIPT] = 3;
  w.cfg.vaultOut = { [SCRIPT]: NEW };
  if (o.manifest !== null) saveRunManifest(w.evidence, { version: 1, chainId, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "2026-10-13T00:00:00Z", stages: { timelock: { status: "done", startedAt: "x" } }, ...(o.manifest ?? {}) } as RunManifest);
  w.setNonce(40);
  const run = (extra: string[] = [], over: object = {}) => w.run(["redeploy-vault", "--vault", "PROTO", ...extra], { chainReader: () => chainOf(), prompt: typedPrompt(), env: { PATH: `${join(import.meta.dir, "stubs")}:${process.env.PATH}`, STUB_STATE: w.statePath, STUB_CONFIG: w.cfgPath, GITHUB_TOKEN: "t" }, ...over });
  const forge = () => (w.state().calls as { tool: string; args: string[]; env: Record<string, string> }[]).filter((c) => c.tool === "forge");
  return { w, dir, run, forge, manifest: () => loadRunManifest(w.evidence)! };
}

describe("the redeploy-vault verb", () => {
  test("it deploys the new vault, keeps the old vault's manifest, writes the new one and records the round", async () => {
    const t = verbWorld();
    expect(await t.run()).toBe(0);
    const rec = redeploysOf(t.manifest())[0]!;
    expect(rec).toMatchObject({ step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "deployed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: TL, deployer: ADMIN, deploy_start_nonce: 40, deploy_end_nonce: 43, deploy_count: 3 });
    expect(rec.deploy_tx_hashes).toHaveLength(3);
    expect(rec.deploy_receipt_statuses).toEqual([1, 1, 1]);
    // the vault manifest names the new vault, the retired one is kept, no temporary file is left
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.replacement-1.json"), "utf8")).vault).toBe(NEW);
    expect(rec.retired_manifest).toBe("protocol-asset-vault.retired-1.json");
    expect(JSON.parse(readFileSync(join(t.dir, rec.retired_manifest!), "utf8")).vault).toBe(OLD);
    expect(existsSync(join(t.dir, "protocol-asset-vault.redeploy.json"))).toBe(false);
    // the other three manifests are untouched
    expect(JSON.parse(readFileSync(join(t.dir, "agent-token-vault.json"), "utf8")).vault).toBe(AGENT);
  });
  test("forge runs the redeploy script with the timelock, the emergency key and the deployer, simulated first, then broadcast once", async () => {
    const t = verbWorld();
    await t.run();
    const f = t.forge();
    expect(f).toHaveLength(2);
    expect(f.every((c) => c.args[1]!.endsWith(`${SCRIPT}:RedeployProtocolAssetVault`))).toBe(true);
    expect(f[0]!.args).not.toContain("--broadcast");
    expect(f[1]!.args).toContain("--broadcast");
    expect(f[1]!.args).not.toContain("--resume");
    expect(f[1]!.args.join(" ")).toContain("--libraries");
    const env = f[1]!.env;
    expect(env.TIMELOCK_ADDRESS).toBe(TL);
    expect(env.REGISTRY_ADDRESS).toBe(REG);
    expect(env.ADMIN_ADDRESS.toLowerCase()).toBe(ADMIN.toLowerCase());
    expect(env.EMERGENCY_ADDRESS).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(env.DEPLOYMENT_OUT).toMatch(/protocol-asset-vault\.redeploy\.json$/);
    expect(env.ROUTER_DEFAULT_BPS).toBeUndefined(); // the redeploy never touches eligibility
  });
  test("--dry-run simulates only: nothing is broadcast, no record, the vault manifest is unchanged", async () => {
    const t = verbWorld();
    expect(await t.run(["--dry-run"])).toBe(0);
    expect(t.forge().filter((c) => c.args.includes("--broadcast"))).toHaveLength(0);
    expect(redeploysOf(t.manifest())).toEqual([]);
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    expect(existsSync(join(t.dir, "protocol-asset-vault.redeploy.json"))).toBe(false);
  });
  test("refused on 8453 in production before any signer exists, and nothing is spawned but cast", async () => {
    const t = verbWorld({ chainId: 8453, manifest: null });
    let signerBuilt = false;
    expect(await t.run([], { makeSigner: () => { signerBuilt = true; throw new Error("no signer"); } })).toBe(EXIT_CODES.USAGE);
    expect(signerBuilt).toBe(false);
    expect(t.forge()).toEqual([]);
  });
  test("a rehearsal on 8453 needs a release tag of its kind and green CI, and no frozen counts of its own", async () => {
    const t = verbWorld({ chainId: 8453, sheet: REHEARSAL, manifest: { chainId: 8453 } as Partial<RunManifest> });
    const calls: string[] = [];
    const code = await t.run([], { releaseTags: async () => ["release/1.0.0-rehearsal"], releaseTag: undefined, checkShaGreen: async () => { calls.push("green"); return { code: 0, output: "" }; }, remoteTag: async () => { calls.push("remote"); }, chainReader: () => chainOf(), caller: undefined });
    // 8453 refuses YES=1 and needs a typed confirmation: the typed prompt answers it
    expect([0, EXIT_CODES.REFUSED]).toContain(code);
    expect(calls).toEqual(["remote", "green"]);
    // a production tag never satisfies a rehearsal
    const u = verbWorld({ chainId: 8453, sheet: REHEARSAL, manifest: { chainId: 8453 } as Partial<RunManifest> });
    expect(await u.run([], { releaseTags: async () => ["release/1.0.0"], releaseTag: undefined })).toBe(EXIT_CODES.RELEASE_TAG_KIND);
    expect(u.forge()).toEqual([]);
  });
  test("it needs the run manifest of the deployment and its finished timelock stage", async () => {
    const none = verbWorld({ manifest: null });
    expect(await none.run()).toBe(EXIT_CODES.RESUME);
    const early = verbWorld({ manifest: { stages: { vault: { status: "done", startedAt: "x" } } } });
    expect(await early.run()).toBe(EXIT_CODES.RESUME);
    expect(early.forge()).toEqual([]);
  });
  test("it refuses a deployment that is not in the state the round starts from, and sends nothing", async () => {
    for (const bad of [{ oldEligible: false }, { oldStatus: 2 }, { voted: true }, { listed: [USDC, AGENT, RWA] }] as const) {
      const t = verbWorld();
      expect(await t.run([], { chainReader: () => chainOf(bad) })).toBe(EXIT_CODES.REFUSED);
      expect(t.forge()).toEqual([]);
      expect(redeploysOf(t.manifest())).toEqual([]);
    }
  });
  test("a signer that is not the deployer of the sheet is refused", async () => {
    const t = verbWorld({ sheet: { ADMIN_ADDRESS: "0x000000000000000000000000000000000000a0ff", RECEIPT_ADMIN_ADDRESS: "0x000000000000000000000000000000000000a0ff" } });
    expect(await t.run()).toBe(EXIT_CODES.SIGNER);
    expect(t.forge()).toEqual([]);
  });
  test("a deploy that leaves a vault the registry already lists, an open vault or a deployer admin is not accepted, and the old manifest stays", async () => {
    for (const bad of [{ newPaused: false }, { newAdmin: false }, { newLinked: false }, { listed: [USDC, OLD, AGENT, RWA, NEW] }]) {
      const t = verbWorld();
      // the before-state check runs with the listing as given: only the AFTER reads differ, so the chain answers the first reads cleanly
      let n = 0;
      const reader = () => { const clean = chainOf(); const dirty = chainOf(bad); return { ...clean, read: async (...a: Parameters<ChainReader["read"]>) => (++n <= 7 ? clean : dirty).read(...a) } as ChainReader; };
      const code = await t.run([], { chainReader: reader });
      expect([EXIT_CODES.VERIFY, EXIT_CODES.REFUSED]).toContain(code);
      expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    }
  });
  test("a broadcast count that differs from the simulation stops the run before the manifest moves", async () => {
    const t = verbWorld();
    t.w.cfg.sent = { [SCRIPT]: 2 };
    expect(await t.run()).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    expect(redeploysOf(t.manifest())[0]!.status).toBe("started");
  });
  test("a second run while the first round waits for govern is refused with the govern command, and one that died part-way needs --resume", async () => {
    const t = verbWorld();
    expect(await t.run()).toBe(0);
    const n = t.forge().length;
    expect(await t.run()).toBe(EXIT_CODES.RESUME);
    expect(t.forge()).toHaveLength(n);
    const died = verbWorld({ manifest: { vault_redeploys: [{ step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "started", old_vault: OLD, registry: REG, router: ROUTER, timelock: TL, deployer: ADMIN, core_sha: SHA, deploy_start_nonce: 40, started_at: "x" } as RedeployRecord] } });
    expect(await died.run()).toBe(EXIT_CODES.RESUME);
    expect(died.forge()).toEqual([]);
  });
});

// ---- the govern row ----------------------------------------------------------------------------------------------------------------

function rowWorld(chainId = 918453, sheetOver: Record<string, string | null> = {}) {
  const d = setup({ ...ALL, ...(chainId === 8453 ? REHEARSAL : {}), ...sheetOver }, chainId);
  const tl = fakeTimelock(d.sheet, 900n);
  tl.s.vaultCaps.set(OLD, 525000n);
  tl.s.weights = { vaults: [...DEF_VAULTS], bps: DEF_BPS.map(BigInt) };
  tl.s.paused = new Set([NEW]); // the old vault was unpaused by stage 13; the new one deploys closed
  tl.s.linked.add(NEW); tl.s.governed.add(NEW);
  // the vault manifest names the new vault, as the verb leaves it
  writeFileSync(join(d.ctx.coreDir, "deployments", String(chainId), "protocol-asset-vault.json"), JSON.stringify({ vault: NEW }));
  const manifest = newManifest(d.ctx, addr(0xa001));
  const rec: RedeployRecord = {
    step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "deployed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: TL, deployer: addr(0xa001), core_sha: SHA,
    deploy_start_nonce: 40, deploy_end_nonce: 43, deploy_count: 3, deploy_tx_hashes: [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`], deploy_receipt_statuses: [1, 1, 1],
    retired_manifest: "protocol-asset-vault.retired-1.json", started_at: "x", deployed_at: "y",
  };
  manifest.vault_redeploys = [rec];
  const opts = (extra: object = {}) => ({ ownerSigners: signers(d.sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: chainId === 8453 ? 0 : 10_000_000, emit: () => {}, row: REDEPLOY_ROW, ...extra });
  const warpTo = async (sec: bigint) => { tl.s.clock += sec; };
  const go = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts({ warp: warpTo, ...extra }));
  return { ...d, tl, manifest, rec, opts, go, warpTo };
}

describe("the govern row", () => {
  test("it schedules ONE batch of six calls, executes it after the delay and leaves the router on the new vault with the same split", async () => {
    const w = rowWorld();
    await w.go();
    expect(w.tl.s.events).toEqual(["scheduleBatch:redeploy-vault", "executeBatch:redeploy-vault"]);
    const sched = w.tl.s.scheduled.get("redeploy-vault")!;
    expect(sched.form).toBe("batch");
    expect(sched.calls).toHaveLength(6);
    expect(sched.calls.map((c) => c.target)).toEqual([A.registry, A.router, A.registry, A.registry, A.registry, NEW]);
    // the chain: the new vault is listed, eligible and open, the old one retired and ineligible, the split unchanged across the new vault
    expect(w.tl.s.listed).toEqual([USDC, OLD, AGENT, RWA, NEW]);
    expect(w.tl.s.ineligible.has(OLD)).toBe(true);
    expect(w.tl.s.ineligible.has(NEW)).toBe(false);
    expect(w.tl.s.statuses.get(OLD)).toBe(2);
    expect(w.tl.s.retiredFlag.has(OLD)).toBe(true);
    expect(w.tl.s.paused.has(NEW)).toBe(false);
    expect(w.tl.s.weights).toEqual({ vaults: [USDC, NEW, AGENT, RWA], bps: [8550n, 525n, 575n, 350n] });
  });
  test("the run manifest holds the evidence entry: the final vector, the read-back, both transactions and the operation", async () => {
    const w = rowWorld();
    await w.go();
    const rec = redeploysOf(w.manifest)[0]!;
    expect(rec.status).toBe("governed");
    expect(rec).toMatchObject({ vaults: [USDC, NEW, AGENT, RWA], bps: DEF_BPS, voted_weights_active: false, effective_vaults: [USDC, NEW, AGENT, RWA], effective_bps: DEF_BPS, old_vault_status: "Retired", new_vault_status: "Active", schedule_status: 1, execute_status: 1 });
    expect(rec.operation_id).toBe(w.tl.s.ids.get("redeploy-vault"));
    expect(rec.schedule_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(rec.execute_tx).not.toBe(rec.schedule_tx);
    expect(Number(rec.execute_block_timestamp) - Number(rec.schedule_block_timestamp)).toBeGreaterThanOrEqual(900);
    expect(redeploysOf(loadRunManifest(w.ctx.evidenceDir)!)[0]!.status).toBe("governed");
  });
  test("a second run finds the round complete and sends nothing", async () => {
    const w = rowWorld();
    await w.go();
    const n = w.tl.s.events.length;
    await w.go();
    expect(w.tl.s.events).toHaveLength(n);
  });
  test("on 8453 it exits GOVERN_PENDING after the schedule, the same command executes it after the delay, and the schedule is sent once", async () => {
    const w = rowWorld(8453);
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN_PENDING", message: expect.stringContaining(`govern --row ${REDEPLOY_ROW}`) });
    expect(w.tl.s.events).toEqual(["scheduleBatch:redeploy-vault"]);
    expect(w.tl.s.listed).toEqual([USDC, OLD, AGENT, RWA]); // nothing changed yet
    w.tl.s.clock += 901n;
    await w.go({ warp: false });
    expect(w.tl.s.events).toEqual(["scheduleBatch:redeploy-vault", "executeBatch:redeploy-vault"]);
    expect(redeploysOf(w.manifest)[0]!.status).toBe("governed");
  });
  test("a resume after the state moved on chain does not re-plan: the recorded vector is the one executed", async () => {
    const w = rowWorld(8453);
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    w.tl.s.clock += 901n;
    w.tl.s.weights = { vaults: [USDC, OLD, AGENT, RWA], bps: [8550n, 525n, 575n, 350n] };
    await w.go({ warp: false });
    expect(w.tl.s.weights.vaults).toEqual([USDC, NEW, AGENT, RWA]);
  });
  test("the operator cancels the scheduled operation through the Safe and names the row again: the same round is scheduled again", async () => {
    const w = rowWorld(8453);
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    const id = w.tl.s.ids.get("redeploy-vault")!;
    w.tl.s.ops.delete(id); // cancelled through the Safe on the timelock
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual(["scheduleBatch:redeploy-vault", "scheduleBatch:redeploy-vault"]);
  });
  test("refused on 8453 in production, with nothing scheduled", async () => {
    const w = rowWorld(8453, { DEPLOYMENT_KIND: null, TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800", SAFE_SALT_NONCE: null, ELIGIBLE_VAULTS: "PROTO,AGENT,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,AGENT:0,RWA:0" });
    await expect(w.go()).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("refused on chain 8453 in production") });
    expect(w.tl.s.events).toEqual([]);
  });
  const refuses = async (arm: (w: ReturnType<typeof rowWorld>) => void, text: string) => {
    const w = rowWorld();
    arm(w);
    await expect(w.go()).rejects.toMatchObject({ kind: "GOVERN", exitCode: EXIT_CODES.GOVERN, message: expect.stringContaining(text) });
    expect(w.tl.s.events).toEqual([]);
    expect(redeploysOf(w.manifest)[0]!.status).toBe("deployed");
  };
  test("refused before anything is scheduled: the old vault is not eligible", () => refuses((w) => w.tl.s.ineligible.add(OLD), "not router-eligible"));
  test("refused before anything is scheduled: the old vault is already retired", () => refuses((w) => w.tl.s.statuses.set(OLD, 2), "want Active"));
  test("refused before anything is scheduled: a voted vector is active", () => refuses((w) => { w.tl.s.voted = { vaults: [USDC], bps: [10000n] }; }, "clear-voted-weights"));
  test("refused before anything is scheduled: the registry already lists the new vault", () => refuses((w) => w.tl.s.listed.push(NEW), "already lists the new vault"));
  test("refused before anything is scheduled: the registry is linked to another router", () => refuses((w) => { w.tl.s.registryRouter = addr(0x77); }, "RouterNotLinked"));
  test("refused before anything is scheduled: the timelock is not the registry admin", () => refuses((w) => { w.tl.s.timelockIsRegistryAdmin = false; }, "ADMIN_ROLE on the registry"));
  test("refused before anything is scheduled: the new vault is already open, not linked, or not governed by the timelock", async () => {
    await refuses((w) => w.tl.s.paused.delete(NEW), "is not deposit-paused");
    await refuses((w) => w.tl.s.linked.delete(NEW), "not linked to the registry");
    await refuses((w) => w.tl.s.governed.delete(NEW), "does not hold ADMIN_ROLE on the new vault");
  });
  test("refused when the vault manifest and the run record name different vaults", async () => {
    const w = rowWorld();
    writeFileSync(join(w.ctx.coreDir, "deployments", "918453", "protocol-asset-vault.json"), JSON.stringify({ vault: addr(0x9999) }));
    await expect(w.go()).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("disagree") });
    expect(w.tl.s.events).toEqual([]);
  });
  test("refused when no redeploy was deployed", async () => {
    const w = rowWorld();
    w.manifest.vault_redeploys = [];
    await expect(w.go()).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("needs a vault the redeploy-vault verb has deployed") });
  });
  test("a read-back that finds the old vault still routed fails the round (GOVERN) and records nothing as governed", async () => {
    const w = rowWorld();
    w.tl.s.reads.getEffectiveWeights = [[USDC, OLD, AGENT, RWA], [8550n, 525n, 575n, 350n]];
    await expect(w.go()).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("getEffectiveWeights") });
    expect(redeploysOf(w.manifest)[0]!.status).toBe("deployed");
  });
  test("a second redeploy of the same vault is its own round with its own operation", async () => {
    const w = rowWorld();
    await w.go();
    const first = w.tl.s.ids.get("redeploy-vault");
    expect(redeployRecordKey("PROTO", 1)).not.toBe(redeployRecordKey("PROTO", 2));
    expect(first).toBeDefined();
  });
});


// ---- failure, retry and recovery (issue 1796) ----------------------------------------------------------------------------------

describe("interrupted broadcast versus atomic execution", () => {
  test("a deploy broadcast that dies part-way is NOT atomic: the round stays started, the manifest stays, a fresh run is refused and --resume completes it", async () => {
    const t = verbWorld();
    t.w.cfg.failBroadcast = SCRIPT;
    expect(await t.run()).toBe(EXIT_CODES.BROADCAST);
    expect(redeploysOf(t.manifest())[0]!.status).toBe("started");
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    // a part-way broadcast moved the deployer nonce (some transactions landed): never rerun fresh
    const n = t.forge().length;
    expect(await t.run()).toBe(EXIT_CODES.RESUME);
    expect(t.forge()).toHaveLength(n);
    // --resume continues the same broadcast and the round completes
    expect(await t.run(["--resume"])).toBe(0);
    expect(t.forge().at(-1)!.args).toContain("--resume");
    const rec = redeploysOf(t.manifest())[0]!;
    expect(rec.status).toBe("deployed");
    expect(rec.new_vault).toBe(NEW);
  });
  test("a timelock batch is atomic: a call that reverts leaves the chain exactly as it was, the round is not recorded, and the retry executes all six calls", async () => {
    const w = rowWorld();
    const before = { listed: [...w.tl.s.listed], weights: JSON.stringify({ v: w.tl.s.weights.vaults, b: w.tl.s.weights.bps.map(String) }) };
    // the 5th call (retire) reverts
    w.tl.s.failOn = (c) => c.target === A.registry && c.data.startsWith("0x") && decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: c.data }).functionName === "retire";
    await expect(w.go()).rejects.toThrow();
    expect(w.tl.s.listed).toEqual(before.listed); // registerVault of call 1 was undone
    expect(JSON.stringify({ v: w.tl.s.weights.vaults, b: w.tl.s.weights.bps.map(String) })).toBe(before.weights);
    expect(w.tl.s.vaultCaps.has(NEW)).toBe(false); // the cap of call 2 was undone
    expect(w.tl.s.ineligible.has(OLD)).toBe(false);
    expect(w.tl.s.paused.has(NEW)).toBe(true);
    expect(redeploysOf(w.manifest)[0]!.status).toBe("deployed");
    // the failure is fixed: the same command executes the same operation
    w.tl.s.failOn = undefined;
    await w.go();
    expect(redeploysOf(w.manifest)[0]!.status).toBe("governed");
    expect(w.tl.s.listed).toEqual([USDC, OLD, AGENT, RWA, NEW]);
    expect(w.tl.s.vaultCaps.get(NEW)).toBe(525000n);
  });
});

describe("a pause-all or a changed deployment makes a scheduled round stale", () => {
  test("a pause-all recorded after the schedule stops the redeploy batch from executing (its last call unpauses the new vault), and nothing is sent", async () => {
    const w = rowWorld(8453);
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    beginPauseEntry(w.ctx.evidenceDir, { at: new Date().toISOString(), trigger: "verify", reason: "test" });
    w.tl.s.clock += 901n;
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("will NOT execute") });
    expect(w.tl.s.events).toEqual(["scheduleBatch:redeploy-vault"]);
    expect(w.tl.s.paused.has(NEW)).toBe(true);
    expect(redeploysOf(w.manifest)[0]!.status).toBe("deployed");
  });
  test("an unpause of rmPROTO scheduled for the OLD vault is rejected once the manifest names the new vault: it is a different operation, so the tool will not execute it", async () => {
    const w = rowWorld(8453);
    const manifestFile = join(w.ctx.coreDir, "deployments", "8453", "protocol-asset-vault.json");
    writeFileSync(manifestFile, JSON.stringify({ vault: OLD }));
    w.tl.s.paused.add(OLD); // paused again by a pause-all before the cutover
    await expect(w.go({ warp: false, row: "unpause-PROTO" })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    expect(w.tl.s.events).toEqual(["schedule:unpause-PROTO"]);
    writeFileSync(manifestFile, JSON.stringify({ vault: NEW }));
    w.tl.s.clock += 901n;
    await expect(w.go({ warp: false, row: "unpause-PROTO" })).rejects.toThrow("is not pending");
    expect(w.tl.s.events).toEqual(["schedule:unpause-PROTO"]);
    expect(w.tl.s.paused.has(OLD)).toBe(true); // the old vault was never reopened by the stale operation
  });
  test("a deployment that moved on after the schedule (the old vault was made ineligible, or the vector changed, or the new vault was opened) is refused at execute time", async () => {
    for (const arm of [(w: ReturnType<typeof rowWorld>) => w.tl.s.ineligible.add(OLD), (w: ReturnType<typeof rowWorld>) => { w.tl.s.weights = { vaults: [USDC, OLD, AGENT, RWA], bps: [8000n, 1075n, 575n, 350n] }; }, (w: ReturnType<typeof rowWorld>) => w.tl.s.paused.delete(NEW)]) {
      const w = rowWorld(8453);
      await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
      arm(w);
      w.tl.s.clock += 901n;
      await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN" });
      expect(w.tl.s.events).toEqual(["scheduleBatch:redeploy-vault"]);
    }
  });
});

describe("restore-old recovery", () => {
  const CURRENT = [USDC, NEW, AGENT, RWA];
  const calls = () => buildRestoreOldCalls({ registry: REG, oldVault: OLD, newVault: NEW, currentVaults: CURRENT, currentBps: DEF_BPS });
  const dec = (i: number) => decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: calls()[i]!.data }) as unknown as { functionName: string; args: any[] };
  test("four calls in the one order the contracts allow: reactivate old, two matching eligibility migrations, retire new", () => {
    const c = calls();
    expect(c.map((x) => dec(c.indexOf(x)).functionName)).toEqual(["reactivate", "migrateEligibility", "migrateEligibility", "retire"]);
    expect(c.every((x) => x.target === REG)).toBe(true);
    expect(dec(0).args).toEqual([OLD]);
    expect(dec(3).args).toEqual([NEW]);
  });
  test("reactivation comes before any eligibility change, and old is made eligible before the new vault is dropped and retired", () => {
    const names = [0, 1, 2, 3].map((i) => `${dec(i).functionName}:${String(dec(i).args[0]) === OLD ? "old" : "new"}`);
    expect(names).toEqual(["reactivate:old", "migrateEligibility:old", "migrateEligibility:new", "retire:new"]);
    expect(dec(1).args[1]).toBe(true);
    expect(dec(2).args[1]).toBe(false);
  });
  test("the two migrations are the mirror of the forward ones: five legs with old at 0 bps right after new, then the launch vector with old in its slot", () => {
    const five = dec(1).args as [string, boolean, string[], bigint[]];
    expect(five[2]).toEqual([USDC, NEW, OLD, AGENT, RWA]);
    expect(five[3]).toEqual([8550n, 525n, 0n, 575n, 350n]);
    const four = dec(2).args as [string, boolean, string[], bigint[]];
    expect(four[2]).toEqual(DEF_VAULTS);
    expect(four[3]).toEqual(DEF_BPS.map(BigInt));
    // the forward batch's final migration is the same shape with the roles swapped
    const fwd = buildRedeployCalls({ router: ROUTER, routerVaultCap: 525000n, registry: REG, oldVault: OLD, newVault: NEW, registryName: "n", asset: addr(0xc0de), finalVaults: CURRENT, finalBps: DEF_BPS });
    const fwdFour = decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: fwd[3]!.data }).args as [string, boolean, string[], bigint[]];
    expect(fwdFour[2]).toEqual(CURRENT);
    expect(four[2]).toEqual(DEF_VAULTS);
  });
  test("it is deterministic and refuses a vector that already holds the old vault", () => {
    expect(calls()).toEqual(calls());
    expect(() => buildRestoreOldCalls({ registry: REG, oldVault: OLD, newVault: NEW, currentVaults: [USDC, OLD, NEW, RWA], currentBps: DEF_BPS })).toThrow("already holds the old vault");
  });
});

// ---- the evidence ------------------------------------------------------------------------------------------------------------------

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const EV = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
]);
const T0 = 5000;
const entry = () => ({
  step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: TL, deployer: addr(0xa001), core_sha: SHA,
  deploy_start_nonce: 40, deploy_end_nonce: 43, deploy_count: 3, deploy_tx_hashes: [h(1), h(2), h(3)], deploy_receipt_statuses: [1, 1, 1], router_vault_cap: "525000", registry_name: "Robot Money Protocol", asset: addr(0xc0de),
  vaults: [USDC, NEW, AGENT, RWA], bps: DEF_BPS, voted_weights_active: false, effective_vaults: [USDC, NEW, AGENT, RWA], effective_bps: DEF_BPS, old_vault_status: "Retired", new_vault_status: "Active",
  operation_id: h(77), schedule_tx: h(10), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(11), execute_status: 1, execute_block_timestamp: T0 + 900,
});
const ev = (over: object = {}) => ({ deployment_kind: "rehearsal", registry: { address: REG }, timelock: { address: TL }, vaults: { rmPROTO: { address: NEW } }, vault_redeploys: [entry()], ...over });
const offline = (f: (e: ReturnType<typeof entry>) => void, floor = 900): string => { const e = entry(); f(e); return checkVaultRedeploys(ev({ vault_redeploys: [e] }), floor).join("\n"); };

function chainFor(e: ReturnType<typeof entry>, o: { calls?: number; delay?: bigint; gap?: number; data?: Hex; target?: Address; failedDeploy?: boolean; swap?: [number, number] } = {}): Parameters<typeof checkVaultRedeploysOnChain>[1] {
  const want = buildRedeployCalls({ router: e.router as Address, routerVaultCap: BigInt(e.router_vault_cap), registry: e.registry as Address, oldVault: e.old_vault as Address, newVault: e.new_vault as Address, registryName: e.registry_name, asset: e.asset as Address, finalVaults: e.vaults as Address[], finalBps: e.bps });
  const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; logs: { address: string; topics: readonly Hex[]; data: Hex }[] }>();
  const blocks = new Map<bigint, number>(); let bn = 1n;
  const add = (hash: string, logs: { address: string; topics: readonly Hex[]; data: Hex }[], ts: number, status: "success" | "reverted" = "success") => { receipts.set(hash, { status, blockNumber: bn, logs }); blocks.set(bn++, ts); };
  const sched = (i: number, c: { target: string; data: Hex }) => ({ address: TL, topics: encodeEventTopics({ abi: EV, eventName: "CallScheduled", args: { id: h(77) as Hex, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [(i === 0 && o.target ? o.target : c.target) as Address, 0n, i === 0 && o.data ? o.data : c.data, h(0) as Hex, o.delay ?? 900n]) });
  const exec = (i: number, c: { target: string; data: Hex }) => ({ address: TL, topics: encodeEventTopics({ abi: EV, eventName: "CallExecuted", args: { id: h(77) as Hex, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [c.target as Address, 0n, c.data]) });
  e.deploy_tx_hashes.forEach((x, i) => add(x, [], 1, o.failedDeploy && i === 0 ? "reverted" : "success"));
  const scheduledCalls = want.slice(0, o.calls ?? 6);
  if (o.swap) [scheduledCalls[o.swap[0]], scheduledCalls[o.swap[1]]] = [scheduledCalls[o.swap[1]]!, scheduledCalls[o.swap[0]]!];
  add(e.schedule_tx, scheduledCalls.map((c, i) => sched(i, c)), T0);
  add(e.execute_tx, want.map((c, i) => exec(i, c)), T0 + (o.gap ?? 900));
  return {
    getChainId: async () => 8453, getTransactionCount: async () => 0,
    getTransactionReceipt: async ({ hash }) => { const r = receipts.get(hash); if (!r) throw new Error("not found"); return r; },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(blocks.get(blockNumber)!) }),
    readContract: async () => { throw new Error("unused"); },
  };
}

describe("the evidence entry", () => {
  test("a governed entry passes the offline shape check and the chain check", async () => {
    expect(checkVaultRedeploys(ev(), 900)).toEqual([]);
    expect(await checkVaultRedeploysOnChain(ev(), chainFor(entry()), 900)).toEqual([]);
  });
  test("the offline check names a wrong vector, a missing deploy transaction, a failed status, a wrong vault, a short gap and a shared operation", () => {
    expect(offline((e) => { e.bps = [8550, 525, 575, 351]; })).toContain("bps do not sum to 10000");
    expect(offline((e) => { e.vaults = [USDC, OLD, AGENT, RWA]; e.effective_vaults = [USDC, OLD, AGENT, RWA]; })).toContain("exactly once");
    expect(offline((e) => { e.deploy_tx_hashes = [h(1)]; })).toContain("deploy tx hashes for deploy_count");
    expect(offline((e) => { e.deploy_receipt_statuses = [1, 0, 1]; })).toContain("deploy receipt 1 status is 0");
    expect(offline((e) => { e.new_vault = addr(0x9999); })).toContain("is not the address");
    expect(offline((e) => { e.old_vault = e.new_vault; })).toContain("same address");
    expect(offline((e) => { e.execute_block_timestamp = T0 + 899; })).toContain("gap");
    expect(offline((e) => { e.voted_weights_active = true; })).toContain("voted_weights_active is true");
    expect(offline((e) => { e.effective_bps = [8550, 500, 600, 350]; })).toContain("differ from the applied vector");
    expect(offline((e) => { e.old_vault_status = "Active"; })).toContain("want Retired");
    expect(offline((e) => { (e as any).cancelled = true; })).toContain("cancelled is not a field");
    expect(offline((e) => { e.registry = addr(0x99); })).toContain("is not the run's registry");
    expect(offline((e) => { e.execute_tx = e.schedule_tx; })).toContain("also the");
  });
  test("a production evidence may carry none", () => {
    expect(checkVaultRedeploys(ev({ deployment_kind: "production" }), 172800, "production").join()).toContain("vault_redeploys is present in a production evidence");
  });
  test("the chain check rejects a batch of the wrong size, the wrong call, the wrong target, a short delay, a short gap and a failed deploy transaction", async () => {
    const e = entry();
    const on = async (o: Parameters<typeof chainFor>[1]) => (await checkVaultRedeploysOnChain(ev(), chainFor(e, o), 900)).join("\n");
    expect(await on({ calls: 4 })).toContain("exactly 6 calls");
    expect(await on({ data: "0x12345678" })).toContain("calldata is not");
    expect(await on({ target: addr(0x31) })).toContain("target");
    expect(await on({ delay: 60n })).toContain("delay");
    expect(await on({ gap: 899 })).toContain("on-chain schedule-to-execute gap");
    expect(await on({ failedDeploy: true })).toContain("deploy tx 0: receipt on chain is reverted");
  });
  test("the chain check names a batch whose calls are in another order, and one that opens the vault before the old vault is retired", async () => {
    for (const swap of [[0, 1], [3, 4], [4, 5]] as [number, number][]) {
      expect((await checkVaultRedeploysOnChain(ev(), chainFor(entry(), { swap }), 900)).length, `swap ${swap}`).toBeGreaterThan(0);
    }
  });
  test("the final deployer nonce counts the redeploy transactions and the vault list counts the retired vault", () => {
    const base = {
      chain_id: 8453, core_sha: "ab".repeat(20), plan_approved_at: "2026-10-05T10:00:00Z", owner_exceptions: [], deployment_kind: "rehearsal", deployer_start_nonce: 7,
      stages: [{ stage: "safe", frozen_count: 2, receipt_count: 2, tx_hashes: [h(1), h(2)], receipts_status: [1, 1] }],
    };
    const problems = (e: object) => checkEvidence({ ...base, ...e }, { safe: 2 }, undefined, { kind: "rehearsal" }).filter((x) => x.includes("deployer_nonce_final"));
    // start 7 + frozen 2 + proof 1 = 10 without a redeploy, 13 with the three redeploy transactions
    const full = { deployer_nonce_final: 10, vaults: { rmPROTO: { address: NEW } }, vault_redeploys: [] };
    expect(problems(full)).toEqual([]);
    expect(problems({ ...full, deployer_nonce_final: 13, vault_redeploys: [entry()] })).toEqual([]);
    expect(problems({ ...full, deployer_nonce_final: 10, vault_redeploys: [entry()] }).join()).toContain("3 redeploy transaction(s)");
  });
});
