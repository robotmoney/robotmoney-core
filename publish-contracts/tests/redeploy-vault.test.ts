// Issue 1796: redeploy ONE vault (rmPROTO) into a live deployment. The pure parts (vectors, the five-call batch, the before and after checks), the `redeploy-vault` verb
// (stub forge and cast, a fake chain reader), the govern row (the in-memory Safe and timelock of tests/govern-world.ts, which enforces the contract rules the batch order exists for),
// the verifier's retired-vault labels and the evidence entry. The real contracts run in contracts/test/RedeployProtocolAssetVault.t.sol and in the fork rehearsal.
// QA plan v1 additions: the `started` record saved after the confirmation (E2), the new vault bound to the broadcast's CREATE receipt (C2, issue 1701), the reads right
// after the broadcast re-read on a load-balanced RPC (E6, issue 1723), the timelock's router admin checked first (E3) and the sha model of the row and the verify (E1), last.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, type Address, type Hex } from "viem";
import { EXIT_CODES, type PublishError } from "../src/errors.ts";
import { resolveCounts } from "../src/counts.ts";
import { STALE_READ_TRIES } from "../src/safe/index.ts";
import { parseCli, USAGE } from "../src/cli.ts";
import { GOVERN_ROWS, govRowRefusal, resumeCommand, runGovern, stageRows } from "../src/govern.ts";
import {
  REDEPLOY_ROW, REGISTRY_REDEPLOY_ABI, ROUTER_REDEPLOY_ABI, VAULT_REDEPLOY_ABI, buildRedeployCalls, buildRestoreOldCalls, createdVaultProblems, deployReceiptStatus, oldVaultBuild, planRedeployVectors,
  readBroadcastReceipts, redeployBeforeProblems, redeployReadBackProblems, redeployRecordKey, redeployRefusal, redeployShaPath, redeployShaRun, redeploysOf, vectorsFromFinal, verifyBuildRefusal,
  type RedeployAfter, type RedeployBefore, type RedeployRecord,
} from "../src/redeploy-vault.ts";
import { beginPauseEntry, loadRunManifest, newManifest, saveRunManifest, type RunManifest } from "../src/runner.ts";
import { stageByName } from "../src/stages.ts";
import { checkEvidence, checkReceiptApplications, checkVaultRedeploys, checkVaultRedeploysOnChain } from "../src/evidence-check.ts";
import { A, RETIRED_VAULT, addr, fakeTimelock, sender, setup, signers, writeGovernManifests } from "./govern-world.ts";
import { ADMIN, typedPrompt, world } from "./harness.ts";
import { COUNTS, SHA, SHA2, healthyPoolReader, tmp, writeCounts } from "./fixtures.ts";
import type { ChainReader } from "../src/verify/types.ts";
import { ADMIN_ROLE } from "../src/verify/constants.ts";

// The redeploy builders are generic in the number of legs. The fixture is the live four-vault v0.5.0 deployment (AGENT is its rmAGENT, a retired vault in the target state, ADR-0017).
const USDC = A.vaults.USDC, OLD = A.vaults.PROTO, AGENT = RETIRED_VAULT, RWA = A.vaults.RWA;
const NEW = addr(0x3012);
const DEF_VAULTS = [USDC, OLD, AGENT, RWA];
const DEF_BPS = [8550, 525, 575, 350];
const REHEARSAL = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "7" };
const ALL = { ELIGIBLE_VAULTS: "PROTO,RWA", GOVERN_UNPAUSE_VAULTS: "USDC,PROTO,RWA", ROUTER_WEIGHTS: "USDC:8550,PROTO:1100,RWA:350" };
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
    // QA plan v1 E3: the batch's setVaultCap runs as the timelock on the router; a caller that did not read the role (undefined) is not refused for it
    expect(p({ timelockIsRouterAdmin: false })).toContain("ADMIN_ROLE on the router");
    expect(redeployBeforeProblems(OLD, NEW, before({ timelockIsRouterAdmin: true }))).toEqual([]);
    expect(p({ votedWeightsActive: true })).toContain("nothing clears one (issue 1988)");
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
function chainOf(o: { listed?: readonly Address[]; oldStatus?: number; oldEligible?: boolean; voted?: boolean; defaultVaults?: Address[]; defaultBps?: number[]; newPaused?: boolean; newAdmin?: boolean; newLinked?: boolean; routerAdmin?: boolean } = {}): ChainReader {
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
  const w = world({ chainId, sheet: { ...ALL, ...(chainId === 8453 ? { ROUTER_WEIGHTS: "USDC:9500,PROTO:500,RWA:0" } : {}), ...(o.sheet ?? {}) } });
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
    // the other manifests are untouched
    expect(JSON.parse(readFileSync(join(t.dir, "vault.json"), "utf8")).vault).toBe(A.vaults.USDC);
    expect(JSON.parse(readFileSync(join(t.dir, "rwa-basket-vault.json"), "utf8")).vault).toBe(RWA);
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
    for (const bad of [{ oldEligible: false }, { oldStatus: 2 }, { voted: true }, { listed: [USDC, AGENT, RWA] }, { routerAdmin: false }] as const) {
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
      // the before-state check runs on a clean chain: only the AFTER reads differ (every read of the new vault, and the registry listing read after the deploy)
      let lists = 0;
      const after = (at: string, sig: string): boolean => lc(at) === lc(NEW) || (/function listVaults/.test(sig) && ++lists > 1);
      const reader = () => { const clean = chainOf(); const dirty = chainOf(bad); return { ...clean, read: async (...a: Parameters<ChainReader["read"]>) => (after(a[0], a[1]) ? dirty : clean).read(...a) } as ChainReader; };
      const code = await t.run([], { chainReader: reader });
      expect(code).toBe(EXIT_CODES.VERIFY); // after the bounded re-reads (QA plan v1 E6), never before the deploy
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
    expect(existsSync(join(forged.dir, "protocol-asset-vault.replacement-1.json"))).toBe(false);
    expect(redeploysOf(forged.manifest())[0]!).toMatchObject({ status: "started" });
    expect(redeploysOf(forged.manifest())[0]!.new_vault).toBeUndefined();
    expect(forged.w.logs().some((l) => l.event === "run.failed" && String(l.message).includes("is not the contract a recorded deploy transaction created"))).toBe(true);
    // a receipt that reads status 0 is never recorded as 1
    const reverted = verbWorld();
    reverted.w.cfg.revertedReceipt = { [SCRIPT]: 2 };
    expect(await reverted.run()).toBe(EXIT_CODES.MANIFEST);
    expect(redeploysOf(reverted.manifest())[0]!.deploy_receipt_statuses).toBeUndefined();
  });

  // QA plan v1 E2 (review DT-4): the `started` record is saved AFTER the confirmation. Before, a refused confirmation left it open: every fresh run was refused
  // RESUME, --resume looped on a broadcast that never began, and the manifest had to be edited by hand.
  test("QA plan v1 E2: a refused confirmation leaves no open record; the next run starts fresh", async () => {
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
  // has no code at the new vault, or sits between two of its transactions. Each is read again through safe/read-after-write.ts, bounded (STALE_READ_TRIES reads; the
  // harness's readRetry never really sleeps), and still fails closed.
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
    expect(JSON.parse(readFileSync(join(t.dir, "protocol-asset-vault.replacement-1.json"), "utf8")).vault).toBe(NEW);
  });
  test("QA plan v1 E6: a nonce that never shows the broadcast within the bound is still COUNT_MISMATCH, naming the reads and the RPC host; the old manifest stays", async () => {
    const t = verbWorld();
    t.w.cfg.staleNonceReads = { [SCRIPT]: 99 };
    expect(await t.run()).toBe(EXIT_CODES.COUNT_MISMATCH);
    expect(nonceReadsAfterBroadcast(t)).toHaveLength(STALE_READ_TRIES);
    expect(failedWith(t, "the deployer nonce never showed 43")).toBe(true);
    expect(failedWith(t, `last read 40, after ${STALE_READ_TRIES} read(s)`)).toBe(true);
    expect(failedWith(t, "from RPC rpc.test")).toBe(true);
    expect(existsSync(join(t.dir, "protocol-asset-vault.replacement-1.json"))).toBe(false);
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
    expect(reads).toBe(STALE_READ_TRIES);
    expect(failedWith(t, "the new vault cannot be read (an error (execution reverted: returned no data (0x)))")).toBe(true);
    expect(failedWith(t, `(${STALE_READ_TRIES} reads from RPC rpc.test`)).toBe(true);
    expect(existsSync(join(t.dir, "protocol-asset-vault.replacement-1.json"))).toBe(false);
    expect(redeploysOf(t.manifest())[0]!.status).toBe("started");
  });
});

// ---- the govern row ----------------------------------------------------------------------------------------------------------------

function rowWorld(chainId = 918453, sheetOver: Record<string, string | null> = {}) {
  const d = setup({ ...ALL, ...(chainId === 8453 ? REHEARSAL : {}), ...sheetOver }, chainId);
  const tl = fakeTimelock(d.sheet, 900n);
  tl.s.listed = [USDC, OLD, AGENT, RWA]; // the live four-vault v0.5.0 deployment
  tl.s.vaultCaps.set(OLD, 525000n);
  tl.s.weights = { vaults: [...DEF_VAULTS], bps: DEF_BPS.map(BigInt) };
  tl.s.paused = new Set([NEW]); // the old vault was unpaused by stage 13; the new one deploys closed
  tl.s.linked.add(NEW); tl.s.governed.add(NEW);
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
  const opts = (extra: object = {}) => ({ ownerSigners: signers(d.sheet), sender, api: tl.api, sleep: async () => { tl.s.clock += 30n; }, pollMs: 0, warp: false as const, maxWaitSeconds: chainId === 8453 ? 0 : 10_000_000, emit: () => {}, row: REDEPLOY_ROW, ...extra });
  const warpTo = async (sec: bigint) => { tl.s.clock += sec; };
  const go = (extra: object = {}) => runGovern(d.ctx, stageByName("govern"), manifest, opts({ warp: warpTo, ...extra }));
  return { ...d, tl, manifest, rec, opts, go, warpTo, deployTxs };
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
    const w = rowWorld(8453, { DEPLOYMENT_KIND: null, TIMELOCK_MIN_DELAY: "172800", GOVERN_NEW_DELAY: "172800", SAFE_SALT_NONCE: null, ELIGIBLE_VAULTS: "PROTO,RWA", ROUTER_WEIGHTS: "USDC:9500,PROTO:500,RWA:0" });
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
  test("refused before anything is scheduled: a voted vector is active", () => refuses((w) => { w.tl.s.voted = { vaults: [USDC], bps: [10000n] }; }, "nothing clears one (issue 1988)"));
  test("refused before anything is scheduled: the registry already lists the new vault", () => refuses((w) => w.tl.s.listed.push(NEW), "already lists the new vault"));
  test("refused before anything is scheduled: the registry is linked to another router", () => refuses((w) => { w.tl.s.registryRouter = addr(0x77); }, "RouterNotLinked"));
  test("refused before anything is scheduled: the timelock is not the registry admin", () => refuses((w) => { w.tl.s.timelockIsRegistryAdmin = false; }, "ADMIN_ROLE on the registry"));
  test("QA plan v1 E3: refused before anything is scheduled: the timelock is not the router admin (the batch's setVaultCap would revert after the delay)", () => refuses((w) => { w.tl.s.timelockIsRouterAdmin = false; }, "ADMIN_ROLE on the router"));
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
    expect(d).toContain("router.setVaultCap(new, approved old cap)");
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

function chainFor(e: ReturnType<typeof entry>, o: { calls?: number; delay?: bigint; gap?: number; data?: Hex; target?: Address; failedDeploy?: boolean; swap?: [number, number]; created?: Address; creator?: Address } = {}): Parameters<typeof checkVaultRedeploysOnChain>[1] {
  const want = buildRedeployCalls({ router: e.router as Address, routerVaultCap: BigInt(e.router_vault_cap), registry: e.registry as Address, oldVault: e.old_vault as Address, newVault: e.new_vault as Address, registryName: e.registry_name, asset: e.asset as Address, finalVaults: e.vaults as Address[], finalBps: e.bps });
  const receipts = new Map<string, { status: "success" | "reverted"; blockNumber: bigint; logs: { address: string; topics: readonly Hex[]; data: Hex }[]; from?: string; contractAddress?: string | null }>();
  const blocks = new Map<bigint, number>(); let bn = 1n;
  const add = (hash: string, logs: { address: string; topics: readonly Hex[]; data: Hex }[], ts: number, status: "success" | "reverted" = "success", tx: { from?: string; contractAddress?: string | null } = {}) => { receipts.set(hash, { status, blockNumber: bn, logs, ...tx }); blocks.set(bn++, ts); };
  const sched = (i: number, c: { target: string; data: Hex }) => ({ address: TL, topics: encodeEventTopics({ abi: EV, eventName: "CallScheduled", args: { id: h(77) as Hex, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [(i === 0 && o.target ? o.target : c.target) as Address, 0n, i === 0 && o.data ? o.data : c.data, h(0) as Hex, o.delay ?? 900n]) });
  const exec = (i: number, c: { target: string; data: Hex }) => ({ address: TL, topics: encodeEventTopics({ abi: EV, eventName: "CallExecuted", args: { id: h(77) as Hex, index: BigInt(i) } }) as Hex[], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [c.target as Address, 0n, c.data]) });
  // QA plan v1 C2: the first deploy transaction is the deployer's CREATE of the new vault (the receipt's contractAddress), the other two are calls
  e.deploy_tx_hashes.forEach((x, i) => add(x, [], 1, o.failedDeploy && i === 0 ? "reverted" : "success", { from: o.creator ?? e.deployer, contractAddress: i === 0 ? (o.created ?? e.new_vault) : null }));
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
  test("QA plan v1 C2: the chain check binds new_vault to the deployer's CREATE receipt among the recorded deploy transactions", async () => {
    const on = async (o: Parameters<typeof chainFor>[1]) => (await checkVaultRedeploysOnChain(ev(), chainFor(entry(), o), 900)).join("\n");
    expect(await on({ created: addr(0x9998) })).toContain("is not the contract a recorded deploy transaction created");
    expect(await on({ creator: addr(0xbad) })).toContain("not by the deployer");
  });
  test("the chain check names a batch whose calls are in another order, and one that opens the vault before the old vault is retired", async () => {
    for (const swap of [[0, 1], [3, 4], [4, 5]] as [number, number][]) {
      expect((await checkVaultRedeploysOnChain(ev(), chainFor(entry(), { swap }), 900)).length, `swap ${swap}`).toBeGreaterThan(0);
    }
  });
  test("a receipt application recorded before the cutover keeps its own vault set: adding a redeploy entry neither rewrites nor invalidates it", () => {
    const RID = `0x${"ab".repeat(32)}`;
    const app = { step: "apply-receipt", receipt_id: RID, target: addr(0x1005), governance: addr(0x1005), payload_digest: `0x${"cd".repeat(32)}`, vaults: [USDC, OLD, AGENT, RWA], bps: DEF_BPS, voted_weights_active: true, effective_vaults: [USDC, OLD, AGENT, RWA], effective_bps: DEF_BPS, operation_id: h(70), schedule_tx: h(620), schedule_status: 1, schedule_block_timestamp: T0 + 20, execute_tx: h(621), execute_status: 1, execute_block_timestamp: T0 + 20 + 900 };
    const before = JSON.stringify(app);
    const withBoth: ReturnType<typeof ev> & { receipt_applications?: object[] } = ev({ consensus_receipt: { address: addr(0x1006) }, governance: { address: addr(0x1005) }, receipt_applications: [app] });
    expect(checkReceiptApplications(withBoth, 900)).toEqual([]);
    expect(checkVaultRedeploys(withBoth, 900)).toEqual([]);
    expect(JSON.stringify(withBoth.receipt_applications![0])).toBe(before); // the evidence of the application is not rewritten to the new vault
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

// ---- the new vault and the deploy receipts (QA plan v1 C2) -----------------------------------------------------------------

describe("QA plan v1 C2: the new vault is bound to the deploy's CREATE receipt", () => {
  const ok = (o: object = {}) => [{ hash: h(1), status: "0x1", from: ADMIN, contractAddress: NEW, ...o }, { hash: h(2), status: "success", from: ADMIN, contractAddress: null }];
  test("one successful CREATE of the new vault by the deployer passes; each way it can fail is named", () => {
    expect(createdVaultProblems(NEW, ADMIN, ok())).toEqual([]);
    expect(createdVaultProblems(NEW, ADMIN, []).join()).toContain("no deploy transaction is recorded");
    expect(createdVaultProblems(NEW, ADMIN, ok({ contractAddress: addr(0x9998) })).join()).toContain("is not the contract a recorded deploy transaction created");
    expect(createdVaultProblems(NEW, ADMIN, ok({ from: addr(0xbad) })).join()).toContain("not by the deployer");
    expect(createdVaultProblems(NEW, ADMIN, ok({ status: "0x0" })).join()).toContain("not success");
    expect(createdVaultProblems(NEW, ADMIN, [...ok(), { hash: h(3), status: 1, from: ADMIN, contractAddress: NEW }]).join()).toContain("is not the contract");
  });
  test("a status is 1 only for a success; the broadcast receipts are matched by hash, never by position", () => {
    for (const x of ["success", "0x1", 1, "1"]) expect(deployReceiptStatus(x)).toBe(1);
    for (const x of ["reverted", "0x0", 0, undefined, "not readable"]) expect(deployReceiptStatus(x)).toBe(0);
    const f = join(tmp("pc-c2-broadcast-"), "run-latest.json");
    writeFileSync(f, JSON.stringify({ receipts: [{ transactionHash: h(2).toUpperCase().replace("0X", "0x"), status: "0x1", from: ADMIN, contractAddress: null }, { status: "0x1" }, { transactionHash: h(1), status: "0x0", from: ADMIN, contractAddress: NEW }] }));
    const m = readBroadcastReceipts(f);
    expect(m.size).toBe(2);
    expect(m.get(h(1))).toMatchObject({ status: "0x0", contractAddress: NEW });
    expect(m.get(h(2))).toMatchObject({ status: "0x1", contractAddress: null });
    expect(readBroadcastReceipts(join(tmp("pc-c2-none-"), "missing.json")).size).toBe(0);
  });
});

// ---- the sha model (QA plan v1 E1, review DT-2, QD-6) ---------------------------------------------------------------------------
// The deployment ran at ORIGINAL. The verb ran at FIX (the fix the round exists for) and recorded it as the round's core_sha. The govern row and the verify after the
// round may name FIX although the run manifest names ORIGINAL: the verify compares the replacing vault with the build of its own checkout (FIX) and every other contract
// with --prior-out (a checkout built at ORIGINAL). A verify the model cannot check is refused before any signer, so it never fails and pauses the vaults.

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

  test("govern --row redeploy-vault, the verify and every stage set that reaches the verify stage are covered", () => {
    expect(redeployShaPath({ verb: "govern", row: REDEPLOY_ROW })).toBe("govern-row");
    expect(redeployShaPath({ stage: "govern", row: REDEPLOY_ROW })).toBe("govern-row");
    expect(redeployShaPath({ verb: "verify" })).toBe("verify");
    expect(redeployShaPath({ stage: "verify" })).toBe("verify");
    // the default set (a --resume run skips the finished deployer stages, never verify), all, and a list naming verify reach the verify stage too
    for (const a of [{}, { stage: "all" }, { stage: "verify,govern" }, { stage: "timelock, verify" }]) expect(redeployShaPath(a)).toBe("stage-set");
    // never the verify stage: the other verbs, the deployer stages alone, govern alone; a dry run skips verify
    for (const a of [{ verb: "govern" }, { verb: "govern", row: "unpause-PROTO" }, { verb: "publish" }, { verb: "redeploy-vault" }, { verb: "pause-all" }, { stage: "deploy" }, { stage: "govern" }, { stage: "vault,timelock" }, { dryRun: true }, { stage: "all", dryRun: true }]) expect(redeployShaPath(a)).toBeUndefined();
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
    usage(run(round({ status: "deployed" })), { coreSha: ORIGINAL, path: "verify" }, "pauses all three vaults");
    usage(run(round()), { coreSha: FIX, path: "verify" }, "needs --prior-out");
    usage(run(round()), { coreSha: FIX, path: "verify", priorOut: "/o" }, "not inside a git checkout");
    usage(run(round()), { coreSha: FIX, path: "verify", priorOut: "/o", priorOutSha: FIX }, `not at the original deployment sha ${ORIGINAL}`);
    usage(run(), { coreSha: ORIGINAL, path: "verify", priorOut: "/o", priorOutSha: THIRD }, "not at the original deployment sha");
    usage(run(round(), round({ ordinal: 2, core_sha: THIRD })), { coreSha: THIRD, path: "verify", priorOut: "/o", priorOutSha: ORIGINAL }, "two builds only");
    usage(run(round(), round({ ordinal: 2, core_sha: ORIGINAL })), { coreSha: FIX, path: "verify", priorOut: "/o", priorOutSha: ORIGINAL }, "two builds only");
  });

  test("a stage set that reaches the verify stage after a round at FIX is refused with USAGE at the original sha and at FIX, and its --prior-out is checked; never a pair", () => {
    const usage = (m: ReturnType<typeof run> | undefined, i: Parameters<typeof redeployShaRun>[1], text: string) => expect(failure(() => redeployShaRun(m, i))).toMatchObject({ kind: "USAGE", message: expect.stringContaining(text) });
    // the original sha: its verify stage would compare the replacing vault with the original build, fail and pause all three vaults
    usage(run(round()), { coreSha: ORIGINAL, path: "stage-set" }, `verify --core-sha ${FIX} --prior-out`);
    usage(run(round()), { coreSha: ORIGINAL, path: "stage-set", priorOut: "/o", priorOutSha: ORIGINAL }, "pauses all three vaults");
    // the redeploy sha: only the verify alone may name it
    usage(run(round()), { coreSha: FIX, path: "stage-set", priorOut: "/o", priorOutSha: ORIGINAL }, "only the verify alone");
    // a --prior-out of the wrong build or outside a checkout, with or without a round, and before any run manifest exists
    usage(run(round()), { coreSha: ORIGINAL, path: "stage-set", priorOut: "/o", priorOutSha: FIX }, `not at the original deployment sha ${ORIGINAL}`);
    usage(run(), { coreSha: ORIGINAL, path: "stage-set", priorOut: "/o" }, "not inside a git checkout");
    usage(undefined, { coreSha: ORIGINAL, path: "stage-set", priorOut: "/o", priorOutSha: THIRD }, "not at the original deployment sha");
    usage(run(round(), round({ ordinal: 2, core_sha: THIRD })), { coreSha: ORIGINAL, path: "stage-set" }, "two builds only");
    // nothing to refuse: no round, rounds at the original sha only, a third sha (runStages refuses it, RESUME), no manifest
    expect(redeployShaRun(run(), { coreSha: ORIGINAL, path: "stage-set" })).toBeUndefined();
    expect(redeployShaRun(run(round({ core_sha: ORIGINAL })), { coreSha: ORIGINAL, path: "stage-set", priorOut: "/o", priorOutSha: ORIGINAL })).toBeUndefined();
    expect(redeployShaRun(run(round()), { coreSha: THIRD, path: "stage-set" })).toBeUndefined();
    expect(redeployShaRun(undefined, { coreSha: ORIGINAL, path: "stage-set" })).toBeUndefined();
  });

  test("the verify stage refuses a wrong build itself, marked so that nothing is paused: the original sha, no --prior-out, a --prior-out of another sha", () => {
    const m = run(round());
    const refusal = (ctx: Parameters<typeof verifyBuildRefusal>[1]) => verifyBuildRefusal(m, ctx);
    for (const [ctx, text] of [
      [{ coreSha: ORIGINAL, priorArtifactsDir: "/o", priorArtifactsSha: ORIGINAL }, `this run is at ${ORIGINAL}`],
      [{ coreSha: FIX }, "no --prior-out"],
      [{ coreSha: FIX, priorArtifactsDir: "/o", priorArtifactsSha: FIX }, `a build at ${FIX}, not at the original sha`],
      [{ coreSha: FIX, priorArtifactsDir: "/o" }, "a build at no git checkout"],
    ] as const) expect(refusal(ctx)).toMatchObject({ kind: "USAGE", message: expect.stringContaining(text), details: { refused_before_verify: true, original_sha: ORIGINAL, redeploy_shas: [FIX] } });
    expect(verifyBuildRefusal(run(round(), round({ ordinal: 2, core_sha: THIRD })), { coreSha: THIRD, priorArtifactsDir: "/o", priorArtifactsSha: ORIGINAL })?.message).toContain("two builds only");
    // the run the model accepts, and rounds at the original sha (one build serves all), pass
    expect(refusal({ coreSha: FIX, priorArtifactsDir: "/o", priorArtifactsSha: ORIGINAL })).toBeUndefined();
    expect(verifyBuildRefusal(run(round({ core_sha: ORIGINAL })), { coreSha: ORIGINAL })).toBeUndefined();
    expect(verifyBuildRefusal(run(), { coreSha: ORIGINAL })).toBeUndefined();
  });

  test("evidence: a round at another sha than the evidence core_sha needs the verify's verified_at_sha (that sha) and prior_out_sha (the deployment's)", () => {
    const at = (...rs: object[]) => checkVaultRedeploys(ev({ core_sha: ORIGINAL, vault_redeploys: rs.map((r, i) => ({ ...entry(), ordinal: i + 1, operation_id: h(77 + i), schedule_tx: h(10 + 2 * i), execute_tx: h(11 + 2 * i), ...r })) }), 900).join("\n");
    expect(at({ core_sha: FIX, verified_at_sha: FIX, prior_out_sha: ORIGINAL })).toBe("");
    // evidence that never ran the verify at FIX with --prior-out
    expect(at({ core_sha: FIX })).toContain("prior_out_sha is missing");
    expect(at({ core_sha: FIX })).toContain("verified_at_sha is missing");
    expect(at({ core_sha: FIX, prior_out_sha: ORIGINAL })).toContain("verified_at_sha is missing");
    expect(at({ core_sha: FIX, verified_at_sha: ORIGINAL, prior_out_sha: ORIGINAL })).toContain(`verified_at_sha ${ORIGINAL} is not ${FIX}`);
    expect(at({ core_sha: FIX, verified_at_sha: FIX, prior_out_sha: FIX })).toContain(`prior_out_sha ${FIX} is not the evidence core_sha ${ORIGINAL}`);
    // a later round at FIX after one at the original sha: the verify at FIX wrote both fields on both rounds
    expect(at({ core_sha: ORIGINAL, verified_at_sha: FIX, prior_out_sha: ORIGINAL }, { core_sha: FIX, verified_at_sha: FIX, prior_out_sha: ORIGINAL })).toBe("");
    expect(at({ core_sha: ORIGINAL }, { core_sha: FIX, verified_at_sha: FIX, prior_out_sha: ORIGINAL })).toContain("round 1: prior_out_sha is missing");
    // rounds at two other shas: no verify can check them
    expect(at({ core_sha: FIX, verified_at_sha: FIX, prior_out_sha: ORIGINAL }, { core_sha: THIRD, verified_at_sha: THIRD, prior_out_sha: ORIGINAL })).toContain("two builds only");
    // rounds at the deployment's sha need neither field; a field present must be right, and the two come together
    expect(at({ core_sha: ORIGINAL })).toBe("");
    expect(at({ core_sha: ORIGINAL, verified_at_sha: ORIGINAL, prior_out_sha: ORIGINAL })).toBe("");
    expect(at({ core_sha: ORIGINAL, verified_at_sha: FIX, prior_out_sha: ORIGINAL })).toContain(`verified_at_sha ${FIX} is not ${ORIGINAL}`);
    expect(at({ core_sha: ORIGINAL, verified_at_sha: ORIGINAL })).toContain("written together");
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
