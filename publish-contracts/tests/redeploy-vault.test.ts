// Issue 1796: redeploy ONE vault (rmPROTO) into a live deployment. The pure parts (vectors, the seven-call batch with the registry link first and the router cap copied, the before and after checks), the `redeploy-vault` verb
// (stub forge and cast, a fake chain reader), the govern row (the in-memory Safe and timelock of tests/govern-world.ts, which enforces the contract rules the batch order exists for),
// the verifier's retired-vault labels and the evidence entry. The real contracts run in contracts/test/RedeployProtocolAssetVault.t.sol and in the fork rehearsal.
// QA plan v1 E1 (review DT-2, QD-6): the sha model, last. The govern row and the verify run at the sha the verb ran at, against a deployment at the original sha, through main().
// QA plan v1 E3 (review F2, E7, QD-7): the cap parity. The batch copies router.vaultCap(old) to the new vault, the row reads it back, the evidence keeps it, the verifier labels it.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { EXIT_CODES, type PublishError } from "../src/errors.ts";
import { parseCli, USAGE } from "../src/cli.ts";
import { resolveCounts } from "../src/counts.ts";
import { GOVERN_ROWS, govRowRefusal, resumeCommand, runGovern, stageRows } from "../src/govern.ts";
import {
  REDEPLOY_ROW, REGISTRY_REDEPLOY_ABI, ROUTER_REDEPLOY_ABI, VAULT_REDEPLOY_ABI, buildRedeployCalls, oldVaultBuild, planRedeployVectors, redeployBeforeProblems, redeployReadBackProblems, redeployRecordKey, redeployRefusal,
  redeployShaPath, redeployShaRun, redeploysOf, vectorsFromFinal, type RedeployAfter, type RedeployBefore, type RedeployRecord,
} from "../src/redeploy-vault.ts";
import { loadRunManifest, measuredCounts, newManifest, saveRunManifest, type RunManifest } from "../src/runner.ts";
import { parseSheet } from "../src/sheet.ts";
import { DEPLOYER_STAGES, getStageTable, stageByName } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import { checkEvidence, checkVaultRedeploys, checkVaultRedeploysOnChain } from "../src/evidence-check.ts";
import { USDC_ADDRESS } from "../src/usdc.ts";
import { WEIGHT_SETTER_GATING_LABEL, verifyDeployment } from "../src/verify/index.ts";
import { A, addr, fakeTimelock, sender, setup, signers, writeGovernManifests } from "./govern-world.ts";
import { LENDING_ADAPTERS } from "../src/core-wiring.ts";
import { ADMIN, typedPrompt, world } from "./harness.ts";
import { COUNTS, MANIFEST_ADAPTER, SHA, SHA2, healthyPoolReader, tmp, writeCounts } from "./fixtures.ts";
import { DEPLOYER as WORLD_DEPLOYER, REGISTRY as WORLD_REGISTRY, ROUTER as WORLD_ROUTER, VAULTS as WORLD_VAULTS, buildWorld, failed as failedLabels } from "./verify/world.ts";
import type { ChainReader, VerifyOptions } from "../src/verify/types.ts";
import { ADMIN_ROLE } from "../src/verify/constants.ts";

const USDC = A.vaults.USDC, OLD = A.vaults.PROTO, AGENT = A.vaults.AGENT, RWA = A.vaults.RWA;
const NEW = addr(0x3012);
const DEF_VAULTS = [USDC, OLD, AGENT, RWA];
const DEF_BPS = [8550, 525, 575, 350];
/** QA plan v1 E3: the old vault's router.vaultCap (250 USDC). Any nonzero value: a new address reads 0, which the router treats as uncapped. */
const CAP = 250_000_000n;
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
  const inputs = { registry: A.registry, router: A.router, oldVault: OLD, newVault: NEW, registryName: "Robot Money Protocol", asset: addr(0xc0de), finalVaults: [USDC, NEW, AGENT, RWA], finalBps: DEF_BPS, vaultCap: CAP };
  const calls = () => buildRedeployCalls(inputs);
  test("seven calls in the one order the contracts allow: link the registry, register, copy the router cap, make the new vault eligible, drop the old one, retire it, open the new one", () => {
    const c = calls();
    expect(c.map((x) => x.target)).toEqual([NEW, A.registry, A.router, A.registry, A.registry, A.registry, NEW]);
    const link = decodeFunctionData({ abi: VAULT_REDEPLOY_ABI, data: c[0]!.data });
    expect(link.functionName).toBe("setRegistry");
    expect(link.args).toEqual([A.registry]);
    const d = [c[1]!, ...c.slice(3, 6)].map((x) => decodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, data: x.data }));
    expect(d.map((x) => x.functionName)).toEqual(["registerVault", "migrateEligibility", "migrateEligibility", "retire"]);
    expect(d[0]!.args).toEqual([NEW, { name: "Robot Money Protocol", asset: addr(0xc0de), registeredAt: 0n }]);
    expect(d[1]!.args).toEqual([NEW, true, [USDC, OLD, NEW, AGENT, RWA], [8550n, 525n, 0n, 575n, 350n]]);
    expect(d[2]!.args).toEqual([OLD, false, [USDC, NEW, AGENT, RWA], [8550n, 525n, 575n, 350n]]);
    expect(d[3]!.args).toEqual([OLD]);
    const cap = decodeFunctionData({ abi: ROUTER_REDEPLOY_ABI, data: c[2]!.data });
    expect(cap.functionName).toBe("setVaultCap");
    expect(cap.args).toEqual([NEW, CAP]);
    expect(decodeFunctionData({ abi: VAULT_REDEPLOY_ABI, data: c[6]!.data }).functionName).toBe("unpauseDeposits");
  });
  test("QA plan v1 E3 cap parity: router.setVaultCap(new, vaultCap(old)) lands after the registration and before the new vault is eligible; a plan's string cap is the same call, 0 stays uncapped, a bad cap is refused", () => {
    const names = calls().map((x) => x.label);
    const cap = names.indexOf("router.setVaultCap(new, vaultCap(old))");
    expect(cap).toBeGreaterThan(names.indexOf("registry.registerVault(new)"));
    expect(cap).toBeLessThan(names.findIndex((l) => l.includes("migrateEligibility(new")));
    // the plan and the evidence keep the cap as a decimal string: it builds the same calldata as the chain read, so the operation id survives a resume
    expect(buildRedeployCalls({ ...inputs, vaultCap: CAP.toString() })).toEqual(calls());
    // an uncapped old leg (0) gives an uncapped new leg: the call still runs, so the parity holds either way
    expect(decodeFunctionData({ abi: ROUTER_REDEPLOY_ABI, data: buildRedeployCalls({ ...inputs, vaultCap: "0" })[2]!.data }).args).toEqual([NEW, 0n]);
    for (const bad of ["-1", "1.5", "0x10", "", "01", (1n << 256n).toString()]) expect(() => buildRedeployCalls({ ...inputs, vaultCap: bad })).toThrow("is not a uint256");
  });
  test("the registry link is the first call, on the new vault, before it is registered: no vault deploy script links (core S5), the timelock does", () => {
    const names = calls().map((x) => x.label);
    expect(names[0]).toBe("new.setRegistry(registry)");
    expect(names.findIndex((l) => l.includes("setRegistry"))).toBeLessThan(names.findIndex((l) => l.includes("registerVault(new)")));
  });
  test("the old vault is made ineligible before it is retired (the registry reverts RetireWhileRouterEligible otherwise)", () => {
    const names = calls().map((x) => x.label);
    expect(names.findIndex((l) => l.includes("migrateEligibility(old"))).toBeLessThan(names.findIndex((l) => l.includes("retire(old)")));
  });
  test("the same inputs give the same calldata: the operation id survives a resume", () => expect(calls()).toEqual(calls()));
});

describe("the state before and after", () => {
  const before = (o: Partial<RedeployBefore> = {}): RedeployBefore => ({
    listed: [USDC, OLD, AGENT, RWA], oldStatus: 0, oldEligible: true, registryRouter: A.router, router: A.router, timelockIsRegistryAdmin: true, timelockIsRouterAdmin: true, votedWeightsActive: false,
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
    expect(p({ timelockIsRouterAdmin: false })).toContain("ADMIN_ROLE on the router");
    expect(p({ votedWeightsActive: true })).toContain("clear-voted-weights");
    expect(p({ defaultVaults: [USDC, AGENT, RWA], defaultBps: [9000, 600, 400] })).toContain("does not hold the old vault");
  });
  const v = vectorsFromFinal({ finalVaults: [USDC, NEW, AGENT, RWA], finalBps: DEF_BPS, oldVault: OLD, newVault: NEW });
  const after = (o: Partial<RedeployAfter> = {}): RedeployAfter => ({
    oldStatus: 2, newStatus: 0, oldEligible: false, newEligible: true, eligibleCount: 4, votedWeightsActive: false, defaultVaults: v.finalVaults, defaultBps: v.finalBps,
    effectiveVaults: v.finalVaults, effectiveBps: v.finalBps, newPaused: false, newLinked: true, oldRetiredFlag: true, oldHasCode: true, newVaultCap: CAP, oldVaultCap: CAP, ...o,
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
    expect(p({ newLinked: false })).toContain("not linked to the registry");
    expect(p({ oldRetiredFlag: false })).toContain("retired()");
    expect(p({ oldHasCode: false })).toContain("no code");
    // QA plan v1 E3: the new vault left uncapped (its setVaultCap did not land) while the old one is capped
    expect(p({ newVaultCap: 0n })).toContain(`router.vaultCap(new) is 0, router.vaultCap(old) is ${CAP}`);
    expect(redeployReadBackProblems(v, after({ newVaultCap: 0n, oldVaultCap: 0n }))).toEqual([]);
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
    for (const w of ["redeploy-vault", "--vault KEY", "--prior-out DIR", "--row redeploy-vault", "new.setRegistry(registry)", "router.setVaultCap(new, vaultCap(old))", "registry.retire(old)"]) expect(USAGE).toContain(w);
  });
});

// ---- the verb ----------------------------------------------------------------------------------------------------------------------

const SCRIPT = "RedeployProtocolAssetVault.s.sol";
const TL = A.timelock, REG = A.registry, ROUTER = A.router;

/** A read-only chain that answers the deployment's state, and the new vault's, on top of the healthy pool chain the config-check reads. */
function chainOf(o: { listed?: Address[]; oldStatus?: number; oldEligible?: boolean; voted?: boolean; defaultVaults?: Address[]; defaultBps?: number[]; newPaused?: boolean; newAdmin?: boolean; newLinked?: boolean; routerAdmin?: boolean } = {}): ChainReader {
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
        case "registry": return o.newLinked ? REG : addr(0); // the deploy leaves the vault unlinked: the govern batch links it
        case "hasRole": {
          const tl = lc(String(args[1])) === lc(TL);
          if (lc(at) === lc(REG)) return tl;
          if (lc(at) === lc(ROUTER)) return tl && (o.routerAdmin ?? true); // QA plan v1 E3: the batch's setVaultCap runs as the timelock on the router
          return tl ? (o.newAdmin ?? true) : false;
        }
      }
      throw new Error(`fake chain: ${fn}`);
    },
  } as unknown as ChainReader;
}

function verbWorld(o: { chainId?: number; sheet?: Record<string, string | null>; manifest?: Partial<RunManifest> | null } = {}) {
  const chainId = o.chainId ?? 918453;
  const w = world({ chainId, sheet: { ...ALL, ...(o.sheet ?? {}) } });
  const dir = join(w.coreDir, "deployments", String(chainId));
  writeGovernManifests(dir);
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
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(NEW);
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
    expect(await t.run(["--dry-run"], { makeSigner: undefined })).toBe(0);
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
    for (const bad of [{ oldEligible: false }, { oldStatus: 2 }, { voted: true }, { listed: [USDC, AGENT, RWA] }, { routerAdmin: false }] as Parameters<typeof chainOf>[0][]) {
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
  test("a deploy that leaves a vault the registry already lists, an open vault, a deployer admin or an already linked vault is not accepted, and the old manifest stays", async () => {
    for (const bad of [{ newPaused: false }, { newAdmin: false }, { newLinked: true }, { listed: [USDC, OLD, AGENT, RWA, NEW] }]) {
      const t = verbWorld();
      // the before-state check runs on a clean chain: only the AFTER reads differ (every read of the new vault, and the registry listing read after the deploy)
      let lists = 0;
      const after = (at: string, sig: string): boolean => lc(at) === lc(NEW) || (/function listVaults/.test(sig) && ++lists > 1);
      const reader = () => { const clean = chainOf(); const dirty = chainOf(bad); return { ...clean, read: async (...a: Parameters<ChainReader["read"]>) => (after(a[0], a[1]) ? dirty : clean).read(...a) } as ChainReader; };
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
  test("QA plan v1 C2: the new vault is the contract the broadcast CREATED, and the recorded statuses are the broadcast receipts' own", async () => {
    // forge's receipts name the deployer's CREATE of the vault the manifest names: accepted, the statuses are read from the receipts
    const ok = verbWorld();
    expect(await ok.run()).toBe(0);
    expect(redeploysOf(ok.manifest())[0]!.deploy_receipt_statuses).toEqual([1, 1, 1]);
    // the manifest names NEW but the CREATE receipt names another contract: refused before the manifest moves, the old vault untouched
    const forged = verbWorld();
    forged.w.cfg.createdOut = { [SCRIPT]: addr(0x9998) };
    expect(await forged.run()).toBe(EXIT_CODES.MANIFEST);
    expect(JSON.parse(readFileSync(join(forged.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    expect(redeploysOf(forged.manifest())[0]!).toMatchObject({ status: "started" });
    expect(redeploysOf(forged.manifest())[0]!.new_vault).toBeUndefined();
    expect(forged.w.logs().some((l) => l.event === "run.failed" && String(l.message).includes("is not the contract a recorded deploy transaction created"))).toBe(true);
    // a receipt that reads status 0 is never recorded as 1
    const reverted = verbWorld();
    reverted.w.cfg.revertedReceipt = { [SCRIPT]: 2 };
    expect(await reverted.run()).toBe(EXIT_CODES.MANIFEST);
    expect(redeploysOf(reverted.manifest())[0]!.deploy_receipt_statuses).toBeUndefined();
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
  // QA plan v1 E2 (review DT-4): the `started` record is saved AFTER the confirmation. Before, a refused confirmation left it open: every fresh run was refused
  // RESUME, --resume looped on a broadcast that never began, and the manifest had to be edited by hand.
  test("a refused confirmation leaves no open record; the next run starts fresh", async () => {
    const t = verbWorld();
    const broadcasts = () => t.forge().filter((c) => c.args.includes("--broadcast"));
    const untouched = () => {
      expect(broadcasts()).toEqual([]);
      expect(redeploysOf(t.manifest())).toEqual([]);
      expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
      expect(existsSync(join(t.dir, "protocol-asset-vault.redeploy.json"))).toBe(false);
    };
    // the operator does not type the stage name: refused after the simulation, nothing sent, nothing recorded
    expect(await t.run([], { prompt: async () => "no" })).toBe(EXIT_CODES.REFUSED);
    expect(t.forge()).toHaveLength(1);
    untouched();
    expect(t.w.logs().some((l) => l.event === "run.failed" && String(l.message).includes("the operator did not confirm"))).toBe(true);
    // the operator confirms, the reviewer does not: the same
    let asked = 0;
    expect(await t.run([], { prompt: async () => (++asked === 1 ? "redeploy-vault" : "no") })).toBe(EXIT_CODES.REFUSED);
    expect(asked).toBe(2);
    untouched();
    // the next run is a fresh round 1: no RESUME refusal, no forge --resume, the start nonce is the one the chain reads now
    expect(await t.run()).toBe(0);
    expect(broadcasts()).toHaveLength(1);
    expect(broadcasts()[0]!.args).not.toContain("--resume");
    const recs = redeploysOf(t.manifest());
    expect(recs).toHaveLength(1);
    expect(recs[0]!).toMatchObject({ ordinal: 1, status: "deployed", old_vault: OLD, new_vault: NEW, deploy_start_nonce: 40, deploy_end_nonce: 43, deploy_count: 3 });
  });
  test("QA plan v1 E2: once confirmed, the started record is saved before the broadcast; a broadcast that dies keeps it, a refused resume leaves it as it was, --resume finishes the round", async () => {
    const t = verbWorld();
    const broadcasts = () => t.forge().filter((c) => c.args.includes("--broadcast"));
    t.w.cfg.failBroadcast = SCRIPT; // the stub dies half way through the first broadcast
    expect(await t.run()).toBe(EXIT_CODES.BROADCAST);
    const started = redeploysOf(t.manifest());
    expect(started).toHaveLength(1);
    expect(started[0]!).toMatchObject({ ordinal: 1, status: "started", old_vault: OLD, deploy_start_nonce: 40 });
    expect(started[0]!.new_vault).toBeUndefined();
    // the round is open: a fresh run is refused before forge
    const n = t.forge().length;
    expect(await t.run()).toBe(EXIT_CODES.RESUME);
    expect(t.forge()).toHaveLength(n);
    // the resume is simulated, then its confirmation is refused: nothing is broadcast and the open record is the one the first run saved
    expect(await t.run(["--resume"], { prompt: async () => "no" })).toBe(EXIT_CODES.REFUSED);
    expect(broadcasts()).toHaveLength(1);
    expect(redeploysOf(t.manifest())).toEqual(started);
    // the confirmed resume continues the same round with forge --resume
    expect(await t.run(["--resume"])).toBe(0);
    expect(broadcasts()).toHaveLength(2);
    expect(broadcasts()[1]!.args).toContain("--resume");
    const recs = redeploysOf(t.manifest());
    expect(recs).toHaveLength(1);
    expect(recs[0]!).toMatchObject({ ordinal: 1, status: "deployed", new_vault: NEW, deploy_start_nonce: 40, deploy_end_nonce: 43, started_at: started[0]!.started_at });
  });

  // QA plan v1 E6 (issue 1723): the reads after the broadcast go through a load-balanced RPC. A node behind the deploy blocks answers the nonce from before the broadcast,
  // has no code at the new vault, or sits between two of its transactions. Each is read again, bounded (5 reads; the harness never really sleeps), and still fails closed.
  const nonceReadsAfterBroadcast = (t: ReturnType<typeof verbWorld>): string[] => {
    const calls = t.w.state().calls as { tool: string; args: string[] }[];
    const i = calls.findIndex((c) => c.tool === "forge" && c.args.includes("--broadcast"));
    return calls.slice(i + 1).filter((c) => c.tool === "cast" && c.args[0] === "nonce").map((c) => c.args[1]!);
  };
  const failedWith = (t: ReturnType<typeof verbWorld>, text: string) => t.w.logs().some((l) => l.event === "run.failed" && String(l.message).includes(text));

  test("QA plan v1 E6: a deployer nonce from a node behind the broadcast is read again until it shows the broadcast: the round is recorded, no false COUNT_MISMATCH", async () => {
    const t = verbWorld();
    t.w.cfg.staleNonceReads = { [SCRIPT]: 2 };
    expect(await t.run()).toBe(0);
    expect(nonceReadsAfterBroadcast(t)).toHaveLength(3);
    expect(redeploysOf(t.manifest())[0]!).toMatchObject({ status: "deployed", new_vault: NEW, deploy_start_nonce: 40, deploy_end_nonce: 43, deploy_count: 3 });
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(NEW);
  });

  test("QA plan v1 E6: a nonce that never shows the broadcast within the bound is still COUNT_MISMATCH, naming the reads and the RPC host; the old manifest stays", async () => {
    const t = verbWorld();
    t.w.cfg.staleNonceReads = { [SCRIPT]: 99 };
    expect(await t.run()).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(nonceReadsAfterBroadcast(t)).toHaveLength(5);
    expect(failedWith(t, "the deployer nonce read 40, 40, 40, 40, 40 in 5 reads from RPC rpc.test")).toBe(true);
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    expect(redeploysOf(t.manifest())[0]!.status).toBe("started");
  });

  test("QA plan v1 E6: the new vault read from a node with no code yet, then from one between two deploy transactions (not yet paused), then current: accepted on the third read", async () => {
    const t = verbWorld();
    let attempt = 0;
    const reader = () => {
      const clean = chainOf();
      const between = chainOf({ newPaused: false });
      return { ...clean, read: async (...a: Parameters<ChainReader["read"]>) => {
        if (lc(a[0]) !== lc(NEW)) return clean.read(...a);
        if (/function depositsPaused/.test(a[1])) attempt++; // the first read of each pass over the checks
        if (attempt === 1) throw new Error("execution reverted: returned no data (0x)"); // that node has no code at the new vault
        return (attempt === 2 ? between : clean).read(...a);
      } } as ChainReader;
    };
    expect(await t.run([], { chainReader: reader })).toBe(0);
    expect(attempt).toBe(3);
    expect(redeploysOf(t.manifest())[0]!).toMatchObject({ status: "deployed", new_vault: NEW });
  });

  test("QA plan v1 E6: a new vault that cannot be read for the whole bound is refused VERIFY (not a raw RPC error), and the old manifest stays", async () => {
    const t = verbWorld();
    let reads = 0;
    const reader = () => { const clean = chainOf(); return { ...clean, read: async (...a: Parameters<ChainReader["read"]>) => { if (lc(a[0]) !== lc(NEW)) return clean.read(...a); reads++; throw new Error("execution reverted: returned no data (0x)"); } } as ChainReader; };
    expect(await t.run([], { chainReader: reader })).toBe(EXIT_CODES.VERIFY);
    expect(reads).toBe(5);
    expect(failedWith(t, "the new vault cannot be read (execution reverted: returned no data (0x)) (5 reads from RPC rpc.test)")).toBe(true);
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.json"), "utf8")).vault).toBe(OLD);
    expect(redeploysOf(t.manifest())[0]!.status).toBe("started");
  });
});

// ---- the govern row ----------------------------------------------------------------------------------------------------------------

function rowWorld(chainId = 918453, sheetOver: Record<string, string | null> = {}) {
  const d = setup({ ...ALL, ...(chainId === 8453 ? REHEARSAL : {}), ...sheetOver }, chainId);
  const tl = fakeTimelock(d.sheet, 900n);
  tl.s.weights = { vaults: [...DEF_VAULTS], bps: DEF_BPS.map(BigInt) };
  tl.s.paused = new Set([NEW]); // the old vault was unpaused by stage 13; the new one deploys closed
  tl.s.governed.add(NEW); // the timelock holds ADMIN_ROLE on the new vault; it is NOT linked: the batch's first call links it
  tl.s.vaultCaps.set(lc(OLD), CAP); // QA plan v1 E3: the old vault's router cap; the new address reads 0 (uncapped) until the batch copies it
  // QA plan v1 C2: the round's first deploy transaction is the deployer's CREATE of the new vault (the chain receipt's contractAddress), the other two are calls
  const deployTxs = [`0x${"01".repeat(32)}`, `0x${"02".repeat(32)}`, `0x${"03".repeat(32)}`];
  deployTxs.forEach((h, i) => tl.s.txReceipts.set(h, { from: addr(0xa001), contractAddress: i === 0 ? NEW : null }));
  // the vault manifest names the new vault, as the verb leaves it
  writeFileSync(join(d.ctx.coreDir, "deployments", String(chainId), "protocol-asset-vault.json"), JSON.stringify({ vault: NEW }));
  const manifest = newManifest(d.ctx, addr(0xa001));
  const rec: RedeployRecord = {
    step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "deployed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: TL, deployer: addr(0xa001), core_sha: SHA,
    deploy_start_nonce: 40, deploy_end_nonce: 43, deploy_count: 3, deploy_tx_hashes: deployTxs, deploy_receipt_statuses: [1, 1, 1],
    retired_manifest: "protocol-asset-vault.retired-1.json", started_at: "x", deployed_at: "y",
  };
  manifest.vault_redeploys = [rec];
  const opts = (extra: object = {}) => ({ ownerSigners: signers(d.sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: 10_000_000, emit: () => {}, row: REDEPLOY_ROW, ...extra });
  const warpTo = async (sec: bigint) => { tl.s.clock += sec; };
  const go = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts({ warp: warpTo, ...extra }));
  return { ...d, tl, manifest, rec, opts, go, warpTo, deployTxs };
}

describe("the govern row", () => {
  test("it schedules ONE batch of seven calls, executes it after the delay and leaves the router on the new vault with the same split", async () => {
    const w = rowWorld();
    expect(w.tl.s.linked.has(NEW)).toBe(false);
    await w.go();
    expect(w.tl.s.events).toEqual(["scheduleBatch:redeploy-vault", "executeBatch:redeploy-vault"]);
    const sched = w.tl.s.scheduled.get("redeploy-vault")!;
    expect(sched.form).toBe("batch");
    expect(sched.calls).toHaveLength(7);
    expect(sched.calls.map((c) => c.target)).toEqual([NEW, A.registry, A.router, A.registry, A.registry, A.registry, NEW]);
    // the chain: the new vault is linked, listed, eligible and open, the old one retired and ineligible, the split unchanged across the new vault
    expect(w.tl.s.linked.has(NEW)).toBe(true);
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
    expect(rec).toMatchObject({ vaults: [USDC, NEW, AGENT, RWA], bps: DEF_BPS, router_vault_cap: CAP.toString(), voted_weights_active: false, effective_vaults: [USDC, NEW, AGENT, RWA], effective_bps: DEF_BPS, old_vault_status: "Retired", new_vault_status: "Active", schedule_status: 1, execute_status: 1 });
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
  test("QA plan v1 E3: refused before anything is scheduled: the timelock is not the router admin (the batch's setVaultCap would revert after the delay)", () => refuses((w) => { w.tl.s.timelockIsRouterAdmin = false; }, "ADMIN_ROLE on the router"));
  test("refused before anything is scheduled: the new vault is already open, already linked (the batch's set-once link would revert), or not governed by the timelock", async () => {
    await refuses((w) => w.tl.s.paused.delete(NEW), "is not deposit-paused");
    await refuses((w) => w.tl.s.linked.add(NEW), "already linked to the registry");
    await refuses((w) => w.tl.s.governed.delete(NEW), "does not hold ADMIN_ROLE on the new vault");
  });
  test("refused when the vault manifest and the run record name different vaults", async () => {
    const w = rowWorld();
    writeFileSync(join(w.ctx.coreDir, "deployments", "918453", "protocol-asset-vault.json"), JSON.stringify({ vault: addr(0x9999) }));
    await expect(w.go()).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("disagree") });
    expect(w.tl.s.events).toEqual([]);
  });
  test("QA plan v1 C2: refused before anything is scheduled when the new vault is not the contract the sheet's deployer created in the recorded deploy transactions", async () => {
    // the record and the vault manifest agree on NEW, but the chain's CREATE receipt names another contract (a hand-edited pair of files)
    await refuses((w) => w.tl.s.txReceipts.set(w.deployTxs[0]!, { from: addr(0xa001), contractAddress: addr(0x9998) }), "is not the contract a recorded deploy transaction created");
    // the contract was created by another sender than ADMIN_ADDRESS
    await refuses((w) => w.tl.s.txReceipts.set(w.deployTxs[0]!, { from: addr(0xbad), contractAddress: NEW }), "not by the deployer");
    // a recorded deploy transaction reverted
    await refuses((w) => w.tl.s.txReceipts.set(w.deployTxs[1]!, { from: addr(0xa001), contractAddress: null, status: "reverted" }), "not success");
    // no deploy transaction recorded at all
    await refuses((w) => { w.rec.deploy_tx_hashes = []; }, "no deploy transaction is recorded");
  });
  test("QA plan v1 C2: the Safe transactions the owners sign name the old and the new vault address, not only the call labels", async () => {
    const w = rowWorld();
    await w.go();
    const d = w.tl.s.scheduled.get("redeploy-vault")!.description!;
    expect(d).toContain(`old ${OLD} -> new ${NEW}`);
    expect(d).toContain("new.setRegistry(registry)");
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
  // QA plan v1 E3 (review F2, E7, QD-7): router.vaultCap is keyed by address and 0 is uncapped. Before, the batch had no cap call and the new rmPROTO took routed deposits uncapped.
  test("QA plan v1 E3 cap parity: the batch gives the new vault the old vault's router cap, read when the round is planned, and the evidence keeps it", async () => {
    const w = rowWorld();
    expect(w.tl.s.vaultCaps.get(lc(NEW))).toBeUndefined(); // the new address reads 0: uncapped
    await w.go();
    const call = w.tl.s.scheduled.get("redeploy-vault")!.calls[2]!;
    expect(call.target).toBe(A.router);
    const d = decodeFunctionData({ abi: ROUTER_REDEPLOY_ABI, data: call.data as Hex });
    expect(d.functionName).toBe("setVaultCap");
    expect(d.args).toEqual([NEW, CAP]);
    expect(w.tl.s.vaultCaps.get(lc(NEW))).toBe(CAP);
    expect(w.tl.s.vaultCaps.get(lc(OLD))).toBe(CAP);
    expect(w.tl.s.scheduled.get("redeploy-vault")!.description).toContain("router.setVaultCap(new, vaultCap(old))");
    expect(redeploysOf(w.manifest)[0]!.router_vault_cap).toBe(CAP.toString());
    // the evidence entry the row wrote rebuilds the same seven calls
    const r = redeploysOf(w.manifest)[0]!;
    const rebuilt = buildRedeployCalls({ registry: r.registry, router: r.router, oldVault: r.old_vault, newVault: r.new_vault!, registryName: r.registry_name!, asset: r.asset!, finalVaults: r.vaults!, finalBps: r.bps!, vaultCap: r.router_vault_cap! });
    expect(w.tl.s.scheduled.get("redeploy-vault")!.calls).toEqual(rebuilt.map(({ target, data }) => ({ target, data })));
  });
  test("QA plan v1 E3: a cap that moves on the old vault after the schedule fails the read-back (GOVERN), and nothing is recorded as governed", async () => {
    const w = rowWorld(8453);
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN_PENDING" });
    w.tl.s.clock += 901n;
    w.tl.s.vaultCaps.set(lc(OLD), CAP * 2n); // another operation changed the old vault's cap while the batch waited: the batch carries the planned cap
    await expect(w.go({ warp: false })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining(`router.vaultCap(new) is ${CAP}, router.vaultCap(old) is ${CAP * 2n}`) });
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

// ---- the evidence ------------------------------------------------------------------------------------------------------------------

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const EV = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
]);
const T0 = 5000;
const entry = () => ({
  step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: TL, deployer: addr(0xa001), core_sha: SHA,
  deploy_start_nonce: 40, deploy_end_nonce: 43, deploy_count: 3, deploy_tx_hashes: [h(1), h(2), h(3)], deploy_receipt_statuses: [1, 1, 1], registry_name: "Robot Money Protocol", asset: addr(0xc0de),
  vaults: [USDC, NEW, AGENT, RWA], bps: DEF_BPS, router_vault_cap: CAP.toString(), voted_weights_active: false, effective_vaults: [USDC, NEW, AGENT, RWA], effective_bps: DEF_BPS, old_vault_status: "Retired", new_vault_status: "Active",
  operation_id: h(77), schedule_tx: h(10), schedule_status: 1, schedule_block_timestamp: T0, execute_tx: h(11), execute_status: 1, execute_block_timestamp: T0 + 900,
});
const ev = (over: object = {}) => ({ deployment_kind: "rehearsal", registry: { address: REG }, timelock: { address: TL }, vaults: { rmPROTO: { address: NEW } }, vault_redeploys: [entry()], ...over });
const offline = (f: (e: ReturnType<typeof entry>) => void, floor = 900): string => { const e = entry(); f(e); return checkVaultRedeploys(ev({ vault_redeploys: [e] }), floor).join("\n"); };

function chainFor(e: ReturnType<typeof entry>, o: { calls?: number; delay?: bigint; gap?: number; data?: Hex; target?: Address; failedDeploy?: boolean; created?: Address; creator?: Address } = {}): Parameters<typeof checkVaultRedeploysOnChain>[1] {
  const want = buildRedeployCalls({ registry: e.registry as Address, router: e.router as Address, oldVault: e.old_vault as Address, newVault: e.new_vault as Address, registryName: e.registry_name, asset: e.asset as Address, finalVaults: e.vaults as Address[], finalBps: e.bps, vaultCap: e.router_vault_cap });
  const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; logs: { address: string; topics: readonly Hex[]; data: Hex }[]; from?: string; contractAddress?: string | null }>();
  const blocks = new Map<bigint, number>(); let bn = 1n;
  const add = (hash: string, logs: { address: string; topics: readonly Hex[]; data: Hex }[], ts: number, status: "success" | "reverted" = "success") => { receipts.set(hash, { status, blockNumber: bn, logs }); blocks.set(bn++, ts); };
  const sched = (i: number, c: { target: string; data: Hex }) => ({ address: TL, topics: encodeEventTopics({ abi: EV, eventName: "CallScheduled", args: { id: h(77) as Hex, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [(i === 0 && o.target ? o.target : c.target) as Address, 0n, i === 0 && o.data ? o.data : c.data, h(0) as Hex, o.delay ?? 900n]) });
  const exec = (i: number, c: { target: string; data: Hex }) => ({ address: TL, topics: encodeEventTopics({ abi: EV, eventName: "CallExecuted", args: { id: h(77) as Hex, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [c.target as Address, 0n, c.data]) });
  e.deploy_tx_hashes.forEach((x, i) => {
    add(x, [], 1, o.failedDeploy && i === 0 ? "reverted" : "success");
    // QA plan v1 C2: the first deploy transaction is the deployer's CREATE of the new vault, the others are calls
    Object.assign(receipts.get(x)!, { from: o.creator ?? e.deployer, contractAddress: i === 0 ? (o.created ?? e.new_vault) : null });
  });
  add(e.schedule_tx, want.slice(0, o.calls ?? want.length).map((c, i) => sched(i, c)), T0);
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
    // QA plan v1 E3: the cap the batch copied is evidence; a missing one, or a number that a JSON reader may have rounded, is named
    expect(offline((e) => { delete (e as { router_vault_cap?: string }).router_vault_cap; })).toContain("router_vault_cap undefined is not a decimal uint256 string");
    expect(offline((e) => { (e as { router_vault_cap: unknown }).router_vault_cap = 250000000; })).toContain("router_vault_cap 250000000 is not a decimal uint256 string");
  });
  test("a production evidence may carry none", () => {
    expect(checkVaultRedeploys(ev({ deployment_kind: "production" }), 172800, "production").join()).toContain("vault_redeploys is present in a production evidence");
  });
  test("the chain check rejects a batch of the wrong size, the wrong call, the wrong target, a short delay, a short gap and a failed deploy transaction", async () => {
    const e = entry();
    const on = async (o: Parameters<typeof chainFor>[1]) => (await checkVaultRedeploysOnChain(ev(), chainFor(e, o), 900)).join("\n");
    expect(await on({ calls: 6 })).toContain("exactly 7 calls");
    // QA plan v1 E3: the cap call the chain carried is not the cap the evidence names
    expect((await checkVaultRedeploysOnChain(ev(), chainFor({ ...e, router_vault_cap: "1" }), 900)).join("\n")).toContain("CallScheduled call 2 calldata is not router.setVaultCap(new, vaultCap(old))");
    expect(await on({ data: "0x12345678" })).toContain("calldata is not");
    expect(await on({ target: addr(0x31) })).toContain("target");
    expect(await on({ delay: 60n })).toContain("delay");
    expect(await on({ gap: 899 })).toContain("on-chain schedule-to-execute gap");
    expect(await on({ failedDeploy: true })).toContain("deploy tx 0: receipt on chain is reverted");
    // QA plan v1 C2: the governed vault must be the deployer's CREATE among the recorded deploy transactions
    expect(await on({ created: addr(0x9998) })).toContain(`new_vault ${NEW} is not the contract a recorded deploy transaction created`);
    expect(await on({ creator: addr(0xbad) })).toContain("not by the deployer");
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

// ---- the sha model (QA plan v1 E1, review DT-2 and QD-6) ----------------------------------------------------------------------------
// The deployment ran at ORIGINAL. The verb redeployed rmPROTO at FIX (the fix's tag) and recorded FIX as the round's core_sha. The govern row and the verify after it run
// at FIX: the run manifest of ORIGINAL is accepted, the counts are ORIGINAL's (no file for FIX), the replacing vault is compared with FIX's build (the checkout's out/) and
// every other contract with --prior-out (a checkout built at ORIGINAL). A verify the model cannot check is refused before any signer, so it never fails and pauses the vaults.

const ORIGINAL = SHA, FIX = SHA2, THIRD = "c".repeat(40);
const failure = (f: () => unknown): { kind?: string; message: string } => {
  try { f(); } catch (e) { return { kind: (e as PublishError).kind, message: (e as Error).message }; }
  return { message: "" };
};

describe("the sha model (QA plan v1 E1): which sha the govern row and the verify may name", () => {
  const round = (o: Partial<RedeployRecord> = {}): RedeployRecord => ({
    step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "governed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: TL, deployer: ADMIN as Address,
    core_sha: FIX, deploy_start_nonce: 60, started_at: "x", ...o,
  });
  const run = (...rounds: RedeployRecord[]) => ({ coreSha: ORIGINAL, vault_redeploys: rounds });

  test("only govern --row redeploy-vault and verify are covered", () => {
    expect(redeployShaPath({ verb: "govern", row: REDEPLOY_ROW })).toBe("govern-row");
    expect(redeployShaPath({ stage: "govern", row: REDEPLOY_ROW })).toBe("govern-row");
    expect(redeployShaPath({ verb: "verify" })).toBe("verify");
    expect(redeployShaPath({ stage: "verify" })).toBe("verify");
    for (const a of [{ verb: "govern" }, { verb: "govern", row: "unpause-PROTO" }, { verb: "publish" }, { verb: "redeploy-vault" }, { stage: "verify,govern" }, { stage: "all" }, {}]) expect(redeployShaPath(a)).toBeUndefined();
  });

  test("the govern row may name the round's sha (or the original one); any other sha is left to runStages, which refuses it", () => {
    const deployed = run(round({ status: "deployed" }));
    expect(redeployShaRun(deployed, { coreSha: FIX, path: "govern-row" })).toEqual({ originalSha: ORIGINAL, redeploySha: FIX });
    // a re-run after the round is governed finds the same round
    expect(redeployShaRun(run(round()), { coreSha: FIX, path: "govern-row" })).toEqual({ originalSha: ORIGINAL, redeploySha: FIX });
    expect(redeployShaRun(deployed, { coreSha: ORIGINAL, path: "govern-row" })).toBeUndefined();
    expect(redeployShaRun(deployed, { coreSha: THIRD, path: "govern-row" })).toBeUndefined();
    expect(redeployShaRun(run(), { coreSha: FIX, path: "govern-row" })).toBeUndefined();
    expect(redeployShaRun(undefined, { coreSha: FIX, path: "govern-row" })).toBeUndefined();
    expect(redeployShaRun(deployed, { coreSha: FIX, path: undefined })).toBeUndefined();
  });

  test("verify after a round at another sha runs at that sha with --prior-out of the original sha; rounds at the original sha need nothing", () => {
    expect(redeployShaRun(run(round()), { coreSha: FIX, path: "verify", priorOut: "/o", priorOutSha: ORIGINAL })).toEqual({ originalSha: ORIGINAL, redeploySha: FIX });
    // two rounds at FIX: still one other build
    expect(redeployShaRun(run(round(), round({ ordinal: 2, old_vault: NEW, new_vault: addr(0x3013) })), { coreSha: FIX, path: "verify", priorOut: "/o", priorOutSha: ORIGINAL })).toEqual({ originalSha: ORIGINAL, redeploySha: FIX });
    expect(redeployShaRun(run(round({ core_sha: ORIGINAL })), { coreSha: ORIGINAL, path: "verify" })).toBeUndefined();
    expect(redeployShaRun(run(), { coreSha: ORIGINAL, path: "verify" })).toBeUndefined();
    // a third sha is not this model's: runStages refuses it (RESUME)
    expect(redeployShaRun(run(round()), { coreSha: THIRD, path: "verify", priorOut: "/o", priorOutSha: ORIGINAL })).toBeUndefined();
  });

  test("verify is refused with USAGE when the model cannot check it: the original sha after a round at FIX, FIX without --prior-out, a --prior-out of another sha or outside a checkout, two other builds", () => {
    const usage = (m: ReturnType<typeof run>, i: Parameters<typeof redeployShaRun>[1], text: string) => expect(failure(() => redeployShaRun(m, i))).toMatchObject({ kind: "USAGE", message: expect.stringContaining(text) });
    usage(run(round()), { coreSha: ORIGINAL, path: "verify" }, `verify --core-sha ${FIX} --prior-out`);
    usage(run(round({ status: "deployed" })), { coreSha: ORIGINAL, path: "verify" }, "pauses all four vaults");
    usage(run(round()), { coreSha: FIX, path: "verify" }, "needs --prior-out");
    usage(run(round()), { coreSha: FIX, path: "verify", priorOut: "/o" }, "not inside a git checkout");
    usage(run(round()), { coreSha: FIX, path: "verify", priorOut: "/o", priorOutSha: FIX }, `not at the original deployment sha ${ORIGINAL}`);
    usage(run(), { coreSha: ORIGINAL, path: "verify", priorOut: "/o", priorOutSha: THIRD }, "not at the original deployment sha");
    usage(run(round(), round({ ordinal: 2, core_sha: THIRD })), { coreSha: THIRD, path: "verify", priorOut: "/o", priorOutSha: ORIGINAL }, "two builds only");
    usage(run(round(), round({ ordinal: 2, core_sha: ORIGINAL })), { coreSha: FIX, path: "verify", priorOut: "/o", priorOutSha: ORIGINAL }, "two builds only");
  });

  test("the retired vault of a later round runs the build of the round before it", () => {
    const r1 = round(), r2 = round({ ordinal: 2, old_vault: NEW, new_vault: addr(0x3013) });
    expect(oldVaultBuild([r1, r2], r1, ORIGINAL)).toBe("original");
    expect(oldVaultBuild([r1, r2], r2, ORIGINAL)).toBe("redeploy");
    expect(oldVaultBuild([round({ core_sha: ORIGINAL }), r2], r2, ORIGINAL)).toBe("original");
  });

  test("counts: a run at the redeploy sha takes the original sha's frozen file, else the run manifest's counts, and never asks for a file of its own (QD-6)", () => {
    const dir = tmp("pc-e1-counts-");
    const recorded = { ...COUNTS, timelock: 99 };
    const base = { dir, sha: FIX, measureFlag: false, dryRun: false, chainId: 8453 };
    // before: COUNTS_MISSING on 8453 for the redeploy sha
    expect(failure(() => resolveCounts(base))).toMatchObject({ kind: "COUNTS_MISSING" });
    const warned: string[] = [];
    expect(resolveCounts({ ...base, warn: (ev) => warned.push(ev), redeploy: { originalSha: ORIGINAL, recorded } })).toMatchObject({ frozen: recorded, measure: false, mode: "redeploy-sha" });
    expect(warned).toEqual(["counts.redeploy_sha"]);
    writeCounts(dir, ORIGINAL, COUNTS);
    expect(resolveCounts({ ...base, redeploy: { originalSha: ORIGINAL, recorded } })).toMatchObject({ frozen: COUNTS, measure: false, mode: "redeploy-sha" });
    // a --measure flag or the Twin chain never turns it into a measuring run
    expect(resolveCounts({ ...base, chainId: 918453, measureFlag: true, redeploy: { originalSha: ORIGINAL, recorded } })).toMatchObject({ measure: false, mode: "redeploy-sha" });
    expect(existsSync(join(dir, `${FIX}.json`))).toBe(false);
  });
});

/**
 * A deployment at ORIGINAL whose rmPROTO the verb replaced at FIX: the run manifest at ORIGINAL (every deployer stage done, stage 13 executed, the round deployed with
 * core_sha FIX), the core checkout at FIX, a --prior-out checkout built at ORIGINAL, and the fake Safe and timelock of govern-world.ts behind the govern row.
 */
function shaWorld(o: { chainId?: 918453 | 8453; frozen?: boolean } = {}) {
  const chainId = o.chainId ?? 918453;
  const w = world({ chainId, sheet: chainId === 8453 ? REHEARSAL : ALL, writeFrozen: o.frozen ?? true });
  writeFileSync(join(w.coreDir, ".git", "HEAD"), `${FIX}\n`);
  const dir = join(w.coreDir, "deployments", String(chainId));
  writeGovernManifests(dir);
  // the verb left the vault manifest naming the new vault; each basket manifest names the adapter its stage deployed (the verify sheet reads it)
  // issue 1705 C4: the rmUSDC manifest names its three lending adapters (the verify sheet reads them)
  const lending = (k: string) => Object.fromEntries((LENDING_ADAPTERS[k as keyof typeof LENDING_ADAPTERS]?.adapters ?? []).map((x, i) => [x.field, addr(0xada1 + i)]));
  for (const v of getStageTable().vaults) writeFileSync(join(dir, `${manifestBase(v.manifest)}.json`), JSON.stringify({ vault: v.key === "PROTO" ? NEW : A.vaults[v.key], ...(v.key === "USDC" ? lending(v.key) : { adapter: MANIFEST_ADAPTER }) }));
  const prior = join(tmp("pc-e1-prior-"), "core");
  mkdirSync(join(prior, ".git"), { recursive: true });
  mkdirSync(join(prior, "out"), { recursive: true });
  writeFileSync(join(prior, ".git", "HEAD"), `${ORIGINAL}\n`);
  const deployTxs = [1, 2, 3].map((n) => `0x${n.toString(16).padStart(64, "0")}`);
  const executed = { scheduled: { at: "x", tx_hash: `0x${"5c".repeat(32)}`, status: 1 }, executed: { at: "x", tx_hash: `0x${"e1".repeat(32)}`, status: 1 } };
  saveRunManifest(w.evidence, {
    version: 1, chainId, coreSha: ORIGINAL, deployer: ADMIN, environment: "local", startedAt: "2026-10-13T00:00:00Z", firstBlock: 1,
    ...(chainId === 8453 ? { deploymentKind: "rehearsal" as const, deployerStartNonce: 7 } : {}),
    stages: Object.fromEntries(DEPLOYER_STAGES.map((s) => [s.name, { status: "done", startedAt: "x", count: COUNTS[s.countKey!] ?? 1, lastBlock: 44 }])),
    govern: Object.fromEntries(["USDC", "PROTO", "AGENT", "RWA"].map((k) => [`unpause-${k}`, executed])),
    vault_redeploys: [{
      step: "redeploy-vault", vault: "rmPROTO", key: "PROTO", ordinal: 1, status: "deployed", old_vault: OLD, new_vault: NEW, registry: REG, router: ROUTER, timelock: TL, deployer: ADMIN as Address, core_sha: FIX,
      deploy_start_nonce: 60, deploy_end_nonce: 63, deploy_count: 3, deploy_tx_hashes: deployTxs, deploy_receipt_statuses: [1, 1, 1], retired_manifest: "protocol-asset-vault.retired-1.json", started_at: "x", deployed_at: "y",
    }],
  } as RunManifest);
  const sheet = parseSheet(readFileSync(w.sheetPath, "utf8"));
  const tl = fakeTimelock(sheet, sheet.timelockMinDelay);
  tl.s.weights = { vaults: [...DEF_VAULTS], bps: (chainId === 8453 ? [9500, 500, 0, 0] : DEF_BPS).map(BigInt) };
  tl.s.paused = new Set([NEW]); // stage 13 opened the four launch vaults; the new one deploys closed
  tl.s.governed.add(NEW);
  deployTxs.forEach((x, i) => tl.s.txReceipts.set(x, { from: ADMIN, contractAddress: i === 0 ? NEW : null }));
  let pauses = 0;
  const pauseAll = (async () => { pauses++; throw new Error("pause-all must not run"); }) as never;
  const govern = (g: object = {}) => ({ api: tl.api, ownerSigners: signers(sheet), sender, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, maxWaitSeconds: 10_000_000, emit: () => {}, warp: async (s: bigint) => { tl.s.clock += s; }, ...g });
  let seen: VerifyOptions | undefined;
  const verify = {
    verifyDeployment: async (x: VerifyOptions) => { seen = x; return { ok: true, checks: [{ label: "fixture", ok: true, detail: "" }] }; },
    verifySources: async () => ({ ok: true, checks: [] }), depositsPaused: async () => false, emit: () => {},
  };
  const priorOut = join(prior, "out");
  return {
    w, tl, priorOut, pauses: () => pauses, seen: () => seen, manifest: () => loadRunManifest(w.evidence)!,
    runGov: (g: object = {}) => w.run(["govern", "--row", REDEPLOY_ROW, "--core-sha", FIX], { govern: govern(g), pauseAll }),
    runVerify: (args: string[] = ["--core-sha", FIX, "--prior-out", priorOut], over: object = {}) => w.run(["verify", ...args], { verify, pauseAll, ...over }),
  };
}

describe("the sha model (QA plan v1 E1): the govern row and the verify through main()", () => {
  test("govern row and verify run at the redeploy SHA after a deployment at the original SHA: green, nothing paused", async () => {
    const t = shaWorld();
    // the govern row at the redeploy sha continues the run manifest of the original sha: ONE batch, scheduled and executed
    expect(await t.runGov()).toBe(0);
    expect(t.tl.s.events).toEqual(["scheduleBatch:redeploy-vault", "executeBatch:redeploy-vault"]);
    expect(redeploysOf(t.manifest())[0]!).toMatchObject({ status: "governed", core_sha: FIX, old_vault: OLD, new_vault: NEW });
    expect(t.manifest().coreSha).toBe(ORIGINAL);
    expect(t.w.logs().some((l) => l.event === "run.redeploy_sha" && l.path === "govern-row" && l.original_sha === ORIGINAL && l.redeploy_sha === FIX)).toBe(true);
    // the verify at the redeploy sha: the replacing vault against this checkout's build, every other contract against --prior-out (the original sha's build)
    expect(await t.runVerify()).toBe(0);
    const seen = t.seen()!;
    expect(seen.artifactsDir).toBe(join(t.w.coreDir, "out"));
    expect(seen.priorArtifactsDir).toBe(t.priorOut);
    expect(seen.redeploys).toEqual([{ vault: "rmPROTO", oldVault: OLD, newVault: NEW, oldBuild: "original" }]);
    expect(seen.redeployDeployerTxs).toBe(3);
    expect(seen.frozenCounts).toEqual(COUNTS); // the ORIGINAL sha's frozen file: the redeploy sha has none
    // green, nothing paused, and the evidence names both builds
    const m = t.manifest();
    expect(m.stages.verify).toMatchObject({ status: "done", core_sha: FIX, prior_out: { dir: t.priorOut, sha: ORIGINAL } });
    expect(redeploysOf(m)[0]!).toMatchObject({ verified_at_sha: FIX, prior_out_sha: ORIGINAL });
    expect(checkVaultRedeploys(ev({ core_sha: ORIGINAL, vault_redeploys: [{ ...entry(), core_sha: FIX, verified_at_sha: FIX, prior_out_sha: ORIGINAL }] }), 900)).toEqual([]);
    expect(t.pauses()).toBe(0);
    expect(t.w.logs().some((l) => l.event === "pause_all.auto")).toBe(false);
    // nothing was measured or written for the redeploy sha, and the deployment's isomorphism report is not rewritten at it
    expect(existsSync(join(t.w.countsDir, `${FIX}.json`))).toBe(false);
    expect(existsSync(join(t.w.evidence, "isomorphism-918453.json"))).toBe(false);
  });

  test("through main() on 8453 with no frozen file: the govern row exits pending and executes at the redeploy sha, the verify passes, nothing is paused", async () => {
    const t = shaWorld({ chainId: 8453, frozen: false });
    // 8453 never warps: the first run schedules and exits GOVERN_PENDING naming the redeploy sha; the same command after the delay executes
    expect(await t.runGov({ warp: false, maxWaitSeconds: 0 })).toBe(EXIT_CODES.GOVERN_PENDING);
    expect(t.tl.s.events).toEqual(["scheduleBatch:redeploy-vault"]);
    expect(String(t.w.logs().filter((l) => l.event === "run.failed").pop()?.message)).toContain(`--core-sha ${FIX}`);
    // QA plan v1 E4: the govern row on 8453 passed the release gate first (the rehearsal tag at FIX, green CI), with no counts file for the redeploy sha
    expect(t.w.logs().some((l) => l.event === "run.release_gate" && l.ok === true && l.tag === "release/1.0.0-rehearsal" && l.core_sha === FIX && l.counts === "none (redeploy sha)")).toBe(true);
    t.tl.s.clock += 901n;
    expect(await t.runGov({ warp: false, maxWaitSeconds: 0 })).toBe(0);
    expect(t.tl.s.events).toEqual(["scheduleBatch:redeploy-vault", "executeBatch:redeploy-vault"]);
    expect(await t.runVerify()).toBe(0);
    // no frozen file for either sha: never COUNTS_MISSING, the counts the run manifest recorded per stage stand in for the original sha's file
    expect(t.w.logs().some((l) => l.kind === "COUNTS_MISSING")).toBe(false);
    expect(t.w.logs().some((l) => l.event === "counts.redeploy_sha" && l.source === "run-manifest")).toBe(true);
    expect(t.seen()!.frozenCounts).toEqual(measuredCounts(t.manifest()));
    expect(t.manifest().stages.verify).toMatchObject({ status: "done", prior_out: { sha: ORIGINAL } });
    expect(redeploysOf(t.manifest())[0]!).toMatchObject({ status: "governed", prior_out_sha: ORIGINAL, verified_at_sha: FIX });
    expect(t.pauses()).toBe(0);
    expect(existsSync(join(t.w.countsDir, `${FIX}.json`))).toBe(false);
  });

  test("a verify the model cannot check is refused before any signer: the original sha after the round, the redeploy sha without --prior-out, a --prior-out of the wrong build", async () => {
    const t = shaWorld();
    expect(await t.runGov()).toBe(0);
    let built = 0;
    const noSigner = { makeSigner: () => { built++; throw new Error("no signer may be built"); } };
    const refused = async (args: string[], text: string) => {
      expect(await t.runVerify(args, noSigner)).toBe(EXIT_CODES.USAGE);
      expect(String(t.w.logs().filter((l) => l.event === "run.failed").pop()?.message)).toContain(text);
    };
    await refused(["--core-sha", FIX], "needs --prior-out");
    const wrong = join(tmp("pc-e1-wrong-"), "core");
    mkdirSync(join(wrong, ".git"), { recursive: true });
    writeFileSync(join(wrong, ".git", "HEAD"), `${FIX}\n`);
    await refused(["--core-sha", FIX, "--prior-out", join(wrong, "out")], `not at the original deployment sha ${ORIGINAL}`);
    // the checkout moved back to the original sha: the old way to run it, which used to compare the new vault with the old build, fail and pause all four vaults
    writeFileSync(join(t.w.coreDir, ".git", "HEAD"), `${ORIGINAL}\n`);
    await refused(["--core-sha", ORIGINAL, "--prior-out", t.priorOut], `verify --core-sha ${FIX} --prior-out`);
    expect(built).toBe(0);
    expect(t.seen()).toBeUndefined();
    expect(t.pauses()).toBe(0);
    expect(t.manifest().stages.verify).toBeUndefined();
  });

  test("a run at the redeploy sha that is not the row or the verify is held to the run manifest's sha (RESUME), and the govern row at the original sha names the same operation", async () => {
    const t = shaWorld();
    expect(await t.w.run(["govern", "--row", "unpause-PROTO", "--core-sha", FIX], { govern: { api: t.tl.api } })).toBe(EXIT_CODES.RESUME);
    expect(String(t.w.logs().filter((l) => l.event === "run.failed").pop()?.message)).toContain(`written at core SHA ${ORIGINAL}, this run names ${FIX}`);
    expect(t.tl.s.events).toEqual([]);
    // the row scheduled at the redeploy sha and resumed at the original sha: one operation (its salt is the round's sha, not the run's)
    expect(await t.runGov({ warp: false, maxWaitSeconds: 0 })).toBe(EXIT_CODES.GOVERN_PENDING);
    const id = t.tl.s.ids.get("redeploy-vault");
    t.tl.s.clock += 61n;
    writeFileSync(join(t.w.coreDir, ".git", "HEAD"), `${ORIGINAL}\n`);
    expect(await t.w.run(["govern", "--row", REDEPLOY_ROW, "--core-sha", ORIGINAL], { govern: { api: t.tl.api, ownerSigners: signers(parseSheet(readFileSync(t.w.sheetPath, "utf8"))), sender, sleep: async () => {}, pollMs: 0, warp: false, emit: () => {} } })).toBe(0);
    expect(t.tl.s.events).toEqual(["scheduleBatch:redeploy-vault", "executeBatch:redeploy-vault"]);
    expect(t.tl.s.ids.get("redeploy-vault")).toBe(id);
  });
});

describe("the sha model (QA plan v1 E1): the verifier compares each contract with the build that created it", () => {
  /** The verify world after a round at FIX: --prior-out is the original build, out-redeploy the FIX build, in which EVERY artifact differs from the original one. */
  function redeployedWorld() {
    const v = buildWorld();
    const ch = v.chain;
    const l = (x: string) => x.toLowerCase();
    const OLDV = WORLD_VAULTS.rmPROTO!.address;
    const NEWV = addr(0xb0012);
    // the retired vault must still serve redeemInKind: its build and its code carry the selector
    const SEL = toFunctionSelector("function redeemInKind(uint256 shares, address receiver, address owner)").slice(2);
    const prior = v.artifactsDir;
    const protoArt = join(prior, "ProtocolAssetVault.sol", "ProtocolAssetVault.json");
    const art = JSON.parse(readFileSync(protoArt, "utf8"));
    art.deployedBytecode.object += SEL;
    writeFileSync(protoArt, JSON.stringify(art));
    ch.codes.set(l(OLDV), `${ch.codes.get(l(OLDV))!}${SEL}` as Hex);
    // the redeploy sha's build: one byte right after the immutable range differs, in every artifact
    const flip = (hex: string): string => `${hex.slice(0, 82)}${hex.slice(82, 84) === "ee" ? "dd" : "ee"}${hex.slice(84)}`;
    const current = join(v.dir, "out-redeploy");
    for (const d of readdirSync(prior)) {
      const n = d.replace(/\.sol$/, "");
      const j = JSON.parse(readFileSync(join(prior, d, `${n}.json`), "utf8"));
      j.deployedBytecode.object = flip(j.deployedBytecode.object);
      mkdirSync(join(current, d), { recursive: true });
      writeFileSync(join(current, d, `${n}.json`), JSON.stringify(j));
    }
    // the replacing vault runs the redeploy build, with the configuration, roles and asset rows of the vault it replaced
    ch.codes.set(l(NEWV), flip(ch.codes.get(l(OLDV))!) as Hex);
    for (const [k, h] of [...ch.handlers]) if (k.startsWith(`${l(OLDV)}:`)) ch.handlers.set(`${l(NEWV)}:${k.slice(l(OLDV).length + 1)}`, h);
    for (const k of [...ch.roles]) if (k.startsWith(`${l(OLDV)}|`)) ch.roles.add(`${l(NEWV)}|${k.slice(l(OLDV).length + 1)}`);
    // and its role history: the redeploy script's constructor grants (issue 1705 C5 counts the emergency key from the RoleGranted logs)
    for (const lg of [...ch.logs]) if (l(lg.address) === l(OLDV)) ch.logs.push({ ...lg, address: NEWV });
    // the batch's effect: the old vault retired (still listed, out of the router, its retired flag set), the new one Active and in the old one's router slot
    ch.set(OLDV, "retired", true);
    ch.set(WORLD_REGISTRY, "listVaults", [...Object.values(WORLD_VAULTS).map((x) => x.address), NEWV]);
    ch.set(WORLD_REGISTRY, "vaultCount", 5n);
    ch.set(WORLD_REGISTRY, "isRouterEligible", (a: unknown[]) => l(String(a[0])) !== l(OLDV));
    ch.set(WORLD_REGISTRY, "getVault", (a: unknown[]) => [{ name: "Robot Money Protocol", asset: USDC_ADDRESS, registeredAt: 1n }, l(String(a[0])) === l(OLDV) ? 2 : 0]);
    // QA plan v1 E3: the batch's setVaultCap gave the new vault the old vault's router cap
    ch.set(WORLD_ROUTER, "vaultCap", CAP);
    return { v, ch, OLDV, NEWV, prior, current, l };
  }

  /** The verify options after the round executed: the router vectors hold the new vault in the old one's slot, the vault manifest names it, the deployer nonce counts the verb's transactions. */
  async function governedOpts(w: ReturnType<typeof redeployedWorld>): Promise<VerifyOptions> {
    const { v, ch, OLDV, NEWV, prior, current, l } = w;
    const [dv, db] = (await ch.read(WORLD_ROUTER, "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)")) as [Address[], bigint[]];
    const moved = dv.map((x) => (l(x) === l(OLDV) ? NEWV : x));
    ch.set(WORLD_ROUTER, "getDefaultWeights", [moved, db]);
    ch.set(WORLD_ROUTER, "getEffectiveWeights", [moved, db]);
    writeFileSync(join(v.manifestDir, "protocol-asset-vault.json"), JSON.stringify({ chain_id: 8453, vault: NEWV }));
    ch.noncesMap.set(l(WORLD_DEPLOYER), (ch.noncesMap.get(l(WORLD_DEPLOYER)) ?? 0) + 3); // the verb's three deploy transactions
    return { ...v.opts, artifactsDir: current, priorArtifactsDir: prior, redeploys: [{ vault: "rmPROTO", oldVault: OLDV, newVault: NEWV, oldBuild: "original" }], redeployDeployerTxs: 3 };
  }

  test("after a round at another sha every label passes: the replacing vault against the redeploy build, core, libraries, adapters, the other vaults and the retired vault against --prior-out", async () => {
    const w = redeployedWorld();
    const { prior } = w;
    const opts = await governedOpts(w);
    const r = await verifyDeployment(opts);
    expect(failedLabels(r)).toEqual([]);
    expect(r.checks.map((c) => c.label)).toContain("retired[rmPROTO]: runtime code equals the original build artifact (masked)");

    // without --prior-out every contract of the original deployment fails against the redeploy build; the replacing vault still passes
    const none = failedLabels(await verifyDeployment({ ...opts, priorArtifactsDir: undefined }));
    for (const x of ["router: runtime code equals build artifact (masked)", "vault[rmUSDC]: runtime code equals build artifact (masked)", "retired[rmPROTO]: runtime code equals the original build artifact (masked)", WEIGHT_SETTER_GATING_LABEL]) expect(none).toContain(x);
    expect(none).not.toContain("vault[rmPROTO]: runtime code equals build artifact (masked)");
    // the verify at the ORIGINAL sha's build (the review's DT-2 failure): only the replacing vault fails its code hash
    const atOriginal = failedLabels(await verifyDeployment({ ...opts, artifactsDir: prior }));
    expect(atOriginal.filter((x) => x.includes("runtime code"))).toEqual(["vault[rmPROTO]: runtime code equals build artifact (masked)"]);
    // a retired vault that an earlier round at the redeploy sha deployed is compared with the redeploy build (here it is the original one, so the label fails)
    expect(failedLabels(await verifyDeployment({ ...opts, redeploys: [{ ...opts.redeploys![0]!, oldBuild: "redeploy" }] }))).toContain("retired[rmPROTO]: runtime code equals the original build artifact (masked)");
  });

  // QA plan v1 E3 (review F2): router.vaultCap is keyed by address and 0 is uncapped, so a replacing vault the batch did not cap takes routed deposits with no per-leg bound
  test("QA plan v1 E3 cap parity: the label router.vaultCap(new) equals router.vaultCap(old) passes after the batch and is the one label that fails when the new vault is uncapped", async () => {
    const w = redeployedWorld();
    const opts = await governedOpts(w);
    const label = "redeploy[rmPROTO]: router.vaultCap(new) equals router.vaultCap(old)";
    const ok = await verifyDeployment(opts);
    expect(ok.checks.find((c) => c.label === label)).toMatchObject({ ok: true, detail: `router.vaultCap(new) ${CAP}, router.vaultCap(old) ${CAP}` });
    w.ch.set(WORLD_ROUTER, "vaultCap", (a: unknown[]) => (w.l(String(a[0])) === w.l(w.NEWV) ? 0n : CAP));
    expect(failedLabels(await verifyDeployment(opts))).toEqual([label]);
  });
});
