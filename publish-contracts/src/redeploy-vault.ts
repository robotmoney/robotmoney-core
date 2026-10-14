// Redeploy ONE vault (rmPROTO) into a live deployment (issue 1796, owner decision 2026-10-13). Two halves, one record in the run manifest:
//   1. the `redeploy-vault` verb (runRedeployVault): the DEPLOYER signs the vault deploy script contracts/script/RedeployProtocolAssetVault.s.sol. The new vault is
//      deployed CLOSED, UNREGISTERED and UNLINKED (registry() is zero), with ADMIN_ROLE on the timelock and EMERGENCY_ROLE on the emergency key. The old vault is not touched.
//   2. the govern row `redeploy-vault` (govern.ts): the Safe, through the timelock, in ONE batch of seven calls: new.setRegistry(registry), registerVault(new),
//      router.setVaultCap(new, vaultCap(old)), migrateEligibility(new, true, ...), migrateEligibility(old, false, ...), retire(old), new.unpauseDeposits(). This module builds
//      the calls, plans the vectors and checks the read-back.
// WHY THE LINK IS IN THE BATCH. `setRegistry` is set-once and ADMIN_ROLE-gated, and no vault deploy script may call it (core S5, scripts/ci/check-set-registry-owner.ts:
// DeployTimelock is the one script that links). The timelock holds ADMIN_ROLE on the new vault after the deploy, so it links as the first call of the batch: the vault is
// bound to the registry before it is registered, and the registry can retire it from then on.
// WHY THE CAP IS IN THE BATCH (QA plan v1 E3, review F2/E7/QD-7). `PortfolioRouter.vaultCap` is keyed by address and 0 means uncapped, so a new address starts with no per-leg
// cap at all. The batch copies the old vault's cap (read when the round is planned) to the new vault before the new vault becomes eligible, so no routed deposit ever reaches
// the new vault uncapped. The timelock holds the router's ADMIN_ROLE after stage 11 (DeployTimelock), which `setVaultCap` needs. The order is the spec's
// (docs/technical/single-vault-redeploy.md section 4): link, register, cap, eligibility, retire, open.
// WHY ONE BATCH. The registry refuses to retire a router-eligible vault (RetireWhileRouterEligible), and the router refuses a default vector whose length differs from
// the registry's eligible count. So the order is forced: make the NEW vault eligible first (a five-leg default vector: the old leg keeps its weight, the new leg takes 0),
// then drop the OLD vault (a four-leg vector: the new vault takes the old vault's weight in the old vault's slot), then retire the old vault, then open the new one.
// A timelock batch is atomic, so no observer, no deposit and no redeem ever sees the five-leg state, a router weighting a paused vault or a retired vault still eligible.
// The deliberate departure from the one-scheme rule (owner decision 2026-10-13): this path is an EXPERIMENT on a Base mainnet REHEARSAL deployment (sheet
// DEPLOYMENT_KIND=rehearsal, 900 s timelock). It is refused on 8453 in production. Whether the final deployment may use it is decided after the experiment.
// The pure parts (vectors, calls, read-back) read no chain and send nothing. runRedeployVault is the only function that spawns forge.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { DeploymentKind } from "./chains.ts";
import { PublishError } from "./errors.ts";
import { BASE_CHAIN_ID } from "./rehearsal/twin.ts";
import { awaitRead, rpcHost } from "./safe/index.ts";
import {
  broadcastFile, castOut, childEnv, confirmStage, deployerNonce, forgeFailureTail, failedBroadcastDetail, libraryArgs, loadRunManifest, manifestDir, manifestFilePath,
  outputSecrets, readTxCount, saveRunManifest, stageEnv, vaultConfigGate, type RunContext, type RunManifest,
} from "./runner.ts";
import { VAULT_NAME } from "./sheet.ts";
import { getStageTable, type StageRow } from "./stages.ts";
import { manifestBase, manifestFile, redeployRow as tableRedeployRow } from "./stage-table.ts";
import { viemReader } from "./verify/reader.ts";
import type { ChainReader } from "./verify/types.ts";
import { ADMIN_ROLE } from "./verify/constants.ts";

export const REDEPLOY_ROW = "redeploy-vault";
export const REDEPLOY_VERB = "redeploy-vault";
/** The vaults a redeploy exists for. Only rmPROTO: the redeploy script and the stage table row exist for it. */
export const REDEPLOY_KEYS = ["PROTO"] as const;
export type RedeployKey = (typeof REDEPLOY_KEYS)[number];
export const isRedeployKey = (k: string): k is RedeployKey => (REDEPLOY_KEYS as readonly string[]).includes(k);
export const BPS_TOTAL = 10_000;
/** `VaultRegistry.VaultStatus`. */
export const STATUS_ACTIVE = 0;
export const STATUS_RETIRED = 2;
export const STATUS_NAME = ["Active", "DepositsPaused", "Retired"] as const;

export const REGISTRY_REDEPLOY_ABI = parseAbi([
  "function registerVault(address vault, (string name, address asset, uint256 registeredAt) metadata)",
  "function migrateEligibility(address vault, bool eligible, address[] defaultVaults, uint256[] defaultBps)",
  "function retire(address vault)",
  "function getVault(address vault) view returns ((string name, address asset, uint256 registeredAt) metadata, uint8 status)",
  "function listVaults() view returns (address[])",
  "function isRouterEligible(address vault) view returns (bool)",
  "function routerEligibleCount() view returns (uint256)",
  "function router() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
export const VAULT_REDEPLOY_ABI = parseAbi([
  "function setRegistry(address newRegistry)",
  "function unpauseDeposits()",
  "function depositsPaused() view returns (bool)",
  "function retired() view returns (bool)",
  "function registry() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
export const ROUTER_REDEPLOY_ABI = parseAbi([
  "function setVaultCap(address vault, uint256 cap)",
  "function vaultCap(address vault) view returns (uint256)",
  "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)",
  "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)",
  "function votedWeightsActive() view returns (bool)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

const lc = (x: string): string => x.toLowerCase();
const ADDR = /^0x[0-9a-fA-F]{40}$/;
/** What `registry()` reads on a vault nobody has linked yet. */
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** The run-manifest key and the salt input of one redeploy round of a vault (`redeploy-vault-PROTO-1`). */
export const redeployRecordKey = (key: RedeployKey, ordinal: number): string => `${REDEPLOY_ROW}-${key}-${ordinal}`;

/** The refusal of the verb and the row on this chain and kind, or undefined: only a rehearsal deployment (or the Twin chain) may redeploy one vault. */
export function redeployRefusal(chainId: number, kind: DeploymentKind): string | undefined {
  return chainId === BASE_CHAIN_ID && kind !== "rehearsal"
    ? `${REDEPLOY_ROW} is refused on chain 8453 in production: redeploying one vault into a live deployment departs from the one deployment scheme, and is an experiment on a Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) and on the Twin chain only. Whether the final deployment may use it is an open owner decision (issue 1796).`
    : undefined;
}

// ---- the record in the run manifest (also the evidence entry) -----------------------------------------------------------------

/**
 * One redeploy of one vault. The deploy half writes the first block of fields (status `deployed`), the govern half adds the operation and the read-back (status `governed`).
 * The whole entry is the evidence-check `vault_redeploys` shape (evidence-check.ts), so the run manifest entry is copied into the evidence as is.
 */
export interface RedeployRecord {
  step: typeof REDEPLOY_ROW;
  /** `rmPROTO`. */
  vault: string;
  key: RedeployKey;
  /** 1 for the first redeploy of this vault in the run, 2 for the next. It is part of the salt of the timelock operation. */
  ordinal: number;
  status: "started" | "deployed" | "governed";
  old_vault: Address;
  /** The contract a CREATE receipt among `deploy_tx_hashes` names, sent by the deployer (QA plan v1 C2): the verb, the govern row and the evidence chain check each bind it. */
  new_vault?: Address;
  registry: Address;
  router: Address;
  timelock: Address;
  deployer: Address;
  core_sha: string;
  deploy_start_nonce: number;
  deploy_end_nonce?: number;
  deploy_count?: number;
  deploy_tx_hashes?: string[];
  /** Per deploy transaction, the status of the receipt forge's broadcast file holds (1 success, 0 anything else): read, never assumed. */
  deploy_receipt_statuses?: number[];
  deploy_first_block?: number;
  deploy_last_block?: number;
  /** The file the old vault's manifest was kept as (a name in the manifest directory). */
  retired_manifest?: string;
  started_at: string;
  deployed_at?: string;
  // ---- govern half
  /** The registry name and asset the old vault was registered with. The new vault is registered with the same ones. */
  registry_name?: string;
  asset?: Address;
  /**
   * QA plan v1 E3: `router.vaultCap(old)` when the round was planned, a decimal uint256 string (0 is uncapped). The batch's `router.setVaultCap(new, ...)` carries it, so the
   * evidence chain check rebuilds that call from it.
   */
  router_vault_cap?: string;
  /** The default vector the router holds after the round (four legs, the new vault in the old vault's slot). */
  vaults?: Address[];
  bps?: number[];
  voted_weights_active?: boolean;
  effective_vaults?: string[];
  effective_bps?: number[];
  old_vault_status?: string;
  new_vault_status?: string;
  operation_id?: string;
  schedule_tx?: string;
  schedule_status?: number;
  schedule_block_timestamp?: number;
  execute_tx?: string;
  execute_status?: number;
  execute_block_timestamp?: number;
  // ---- the verify after the round (QA plan v1 E1), written by a verify that passed
  /** The sha the verify ran at: the checkout whose build the replacing vault was compared with (this round's `core_sha` when it differs from the original). */
  verified_at_sha?: string;
  /** The sha of the checkout that holds the verify's --prior-out: the build every other contract was compared with. It must be the original deployment sha. */
  prior_out_sha?: string;
  [k: string]: unknown;
}

export const redeploysOf = (m: Pick<RunManifest, "vault_redeploys">): RedeployRecord[] => (Array.isArray(m.vault_redeploys) ? (m.vault_redeploys as RedeployRecord[]) : []);

// ---- the sha model (QA plan v1 E1, review DT-2 and QD-6) --------------------------------------------------------------------
// The deployment ran at the ORIGINAL sha: the run manifest names it, its frozen counts belong to it, and every contract it created runs its build. The verb runs at the
// REDEPLOY sha (the fix the round exists for) and records it as the round's `core_sha`. Two later runs may name that sha although the run manifest names the original
// one: the govern row that executes the round, and the verify after it. That verify compares the replacing vault with the build of its own checkout (the redeploy sha)
// and every other contract (core, libraries, adapters, the three vaults not replaced, the retired one) with --prior-out, the out/ of a checkout at the original sha.
// Neither run deploys anything, so neither needs a frozen counts file for the redeploy sha (counts.ts resolveCounts). Every other run names the original sha.
// A verify at the original sha after a round at another sha would compare the replacing vault with the wrong build, fail, and pause all four vaults: it is refused
// before any signer exists, and the refusal names the command that works.

/** The runs the sha model covers. */
export type RedeployShaPath = "govern-row" | "verify";

/** `govern --row redeploy-vault` (the verb or `--stage govern`) and `verify` (the verb or `--stage verify`). Any other run: undefined. */
export function redeployShaPath(a: { verb?: string; stage?: string; row?: string }): RedeployShaPath | undefined {
  const only = a.verb ?? a.stage;
  if (only === "govern" && a.row === REDEPLOY_ROW) return "govern-row";
  return only === "verify" ? "verify" : undefined;
}

/** A run at a redeploy round's sha: the sha the run manifest names (the original deployment's) and the round's sha this run names. */
export interface RedeployShaRun { originalSha: string; redeploySha: string }

/**
 * The sha a govern-row or verify run against this run manifest may name. undefined: the run is held to the run manifest's own sha, as every run is (runStages).
 * A pair: the run names a redeploy round's `core_sha`, runStages accepts the run manifest of the original sha and the counts are the original's (counts.ts).
 *   govern-row  the round the row executes (the deployed one, else the last governed one, as govern.ts picks it): its `core_sha`, or the original sha.
 *   verify      every round at the original sha: the original sha only, one build serves all. Rounds at ONE other sha, the last round among them: that sha, with
 *               --prior-out. Refused with USAGE before any signer exists (nothing sent, nothing paused): the original sha then, the redeploy sha without --prior-out,
 *               rounds at two other shas or an earlier round at another sha than the last (the verifier holds two builds), and a --prior-out that is not inside a
 *               git checkout of the original sha (`priorOutSha`: the HEAD of the checkout that holds it, undefined outside one).
 */
export function redeployShaRun(manifest: Pick<RunManifest, "coreSha" | "vault_redeploys"> | undefined, i: { coreSha: string; path: RedeployShaPath | undefined; priorOut?: string; priorOutSha?: string }): RedeployShaRun | undefined {
  if (!manifest || i.path === undefined) return undefined;
  const original = manifest.coreSha;
  const recs = redeploysOf(manifest);
  if (i.path === "govern-row") {
    const rec = recs.find((r) => r.status === "deployed") ?? [...recs].reverse().find((r) => r.status === "governed");
    return rec !== undefined && i.coreSha !== original && rec.core_sha === i.coreSha ? { originalSha: original, redeploySha: i.coreSha } : undefined;
  }
  const nothing = "No signer was built, nothing was sent or paused.";
  if (i.priorOut !== undefined) {
    if (i.priorOutSha === undefined) throw new PublishError("USAGE", `--prior-out ${i.priorOut} is not inside a git checkout, so the sha of its build cannot be checked or recorded: pass the out/ of a checkout of the original deployment sha ${original}, built with forge build. ${nothing}`);
    if (i.priorOutSha !== original) throw new PublishError("USAGE", `--prior-out ${i.priorOut} is the build of a checkout at ${i.priorOutSha}, not at the original deployment sha ${original}: the contracts the redeploy did not replace run the original build. ${nothing}`);
  }
  const shaOf = (r: RedeployRecord): string => r.core_sha || original; // a record without the field ran at the original sha
  const foreign = [...new Set(recs.map(shaOf).filter((s) => s !== original))];
  if (foreign.length === 0) return undefined;
  const last = recs[recs.length - 1]!;
  if (foreign.length > 1 || shaOf(last) !== foreign[0]) throw new PublishError("USAGE", `verify refused: the redeploy-vault rounds of this run were deployed at ${[...new Set(recs.map(shaOf))].join(", ")} (the last at ${shaOf(last)}), and the verifier compares with two builds only (the checkout and --prior-out). ${nothing}`);
  const redeploySha = foreign[0]!;
  if (i.coreSha === original) throw new PublishError("USAGE", `verify refused at the original sha ${original}: ${last.vault} was redeployed at ${redeploySha} (round ${last.ordinal}), so the build of this checkout is not the replacing vault's, and a failed verify pauses all four vaults. Run the verify at the redeploy sha: bun publish-contracts/src/cli.ts verify --core-sha ${redeploySha} --prior-out <forge out/ of a checkout at ${original}> (plus the same --chain, --rpc, --sheet, --signer, --environment and --evidence arguments). ${nothing}`);
  if (i.coreSha !== redeploySha) return undefined; // a third sha: runStages refuses it (RESUME)
  if (i.priorOut === undefined) throw new PublishError("USAGE", `verify at the redeploy sha ${redeploySha} needs --prior-out <forge out/ of a checkout at the original sha ${original}>: every contract the redeploy did not replace runs that build. ${nothing}`);
  return { originalSha: original, redeploySha };
}

/**
 * The build the OLD vault of a governed round runs (QA plan v1 E1): the build of the round that deployed it. The first round's old vault is the original deployment's
 * ("original", --prior-out); a later round's old vault is the vault the round before it deployed ("redeploy" when that round ran at another sha than the original).
 */
export function oldVaultBuild(recs: readonly RedeployRecord[], r: RedeployRecord, originalSha: string): "original" | "redeploy" {
  const before = recs.filter((x) => x.key === r.key && x.ordinal < r.ordinal).sort((x, y) => y.ordinal - x.ordinal)[0];
  return (before?.core_sha || originalSha) === originalSha ? "original" : "redeploy";
}

// ---- the vectors ------------------------------------------------------------------------------------------------------------

export interface RedeployVectors {
  /** The default vector after the round: the old vault's slot holds the new vault, the weights are unchanged. */
  finalVaults: Address[]; finalBps: number[];
  /** The default vector before the round: the old vault in its slot. */
  preVaults: Address[]; preBps: number[];
  /** The default vector while BOTH vaults are eligible (inside the batch only): the new vault right after the old one, with 0 bps. */
  fiveVaults: Address[]; fiveBps: number[];
}

const asBps = (x: bigint | number, what: string): number => {
  const n = typeof x === "bigint" ? Number(x) : x;
  if (!Number.isInteger(n) || n < 0) throw new PublishError("GOVERN", `${what}: ${String(x)} is not a non-negative integer weight`);
  return n;
};

/** From the vector AFTER the round: the vector before it and the five-leg step between. `finalVaults` holds the new vault once and not the old one. */
export function vectorsFromFinal(i: { finalVaults: readonly string[]; finalBps: readonly (bigint | number)[]; oldVault: string; newVault: string }): RedeployVectors {
  const { finalVaults, oldVault, newVault } = i;
  if (finalVaults.length === 0 || finalVaults.length !== i.finalBps.length) throw new PublishError("GOVERN", "the redeploy vector needs one weight per vault");
  const bps = i.finalBps.map((x, k) => asBps(x, `bps[${k}]`));
  if (bps.reduce((t, x) => t + x, 0) !== BPS_TOTAL) throw new PublishError("GOVERN", `the redeploy vector sums to ${bps.reduce((t, x) => t + x, 0)} bps, want ${BPS_TOTAL}`);
  if (lc(oldVault) === lc(newVault)) throw new PublishError("GOVERN", "the old and the new vault are the same address");
  const at = finalVaults.findIndex((v) => lc(v) === lc(newVault));
  if (at < 0 || finalVaults.filter((v) => lc(v) === lc(newVault)).length !== 1) throw new PublishError("GOVERN", `the final vector must hold the new vault ${newVault} exactly once`);
  if (finalVaults.some((v) => lc(v) === lc(oldVault))) throw new PublishError("GOVERN", `the final vector must not hold the old vault ${oldVault}`);
  if (new Set(finalVaults.map(lc)).size !== finalVaults.length) throw new PublishError("GOVERN", "the final vector lists a vault twice");
  const fv = [...finalVaults] as Address[];
  const pre = [...fv]; pre[at] = oldVault as Address;
  const fiveVaults = [...pre]; fiveVaults.splice(at + 1, 0, newVault as Address);
  const fiveBps = [...bps]; fiveBps.splice(at + 1, 0, 0); // the old leg keeps the weight, the new leg takes 0
  return { finalVaults: fv, finalBps: bps, preVaults: pre, preBps: [...bps], fiveVaults, fiveBps };
}

/** From the router's DEFAULT vector now: the old vault is replaced by the new one in its slot. Refuses a vector that does not hold the old vault once, or already holds the new one. */
export function planRedeployVectors(i: { defaultVaults: readonly string[]; defaultBps: readonly (bigint | number)[]; oldVault: string; newVault: string }): RedeployVectors {
  if (i.defaultVaults.length !== i.defaultBps.length) throw new PublishError("GOVERN", "router.getDefaultWeights() returned vaults and bps of different lengths");
  const at = i.defaultVaults.findIndex((v) => lc(v) === lc(i.oldVault));
  if (at < 0 || i.defaultVaults.filter((v) => lc(v) === lc(i.oldVault)).length !== 1) throw new PublishError("GOVERN", `the router's default vector does not hold the old vault ${i.oldVault} exactly once: [${i.defaultVaults.join(", ")}]`);
  if (i.defaultVaults.some((v) => lc(v) === lc(i.newVault))) throw new PublishError("GOVERN", `the router's default vector already holds the new vault ${i.newVault}`);
  const finalVaults = [...i.defaultVaults]; finalVaults[at] = i.newVault;
  return vectorsFromFinal({ finalVaults, finalBps: i.defaultBps, oldVault: i.oldVault, newVault: i.newVault });
}

// ---- the batch ---------------------------------------------------------------------------------------------------------------

export interface RedeployCall { label: string; target: Address; data: Hex }

export interface RedeployCallInputs {
  registry: Address; router: Address; oldVault: Address; newVault: Address; registryName: string; asset: Address; finalVaults: readonly string[]; finalBps: readonly (bigint | number)[];
  /** QA plan v1 E3: `router.vaultCap(old)`, a bigint read or the decimal string the plan and the evidence keep. */
  vaultCap: bigint | number | string;
}

const UINT256_MAX = (1n << 256n) - 1n;
/** A router vault cap as the batch carries it: a uint256 from a chain read (bigint) or from the plan and the evidence (a decimal string). Anything else is refused. */
export function asVaultCap(x: bigint | number | string | undefined, what = "router.vaultCap(old)"): bigint {
  const n = typeof x === "bigint" ? x : typeof x === "number" && Number.isSafeInteger(x) ? BigInt(x) : typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x) ? BigInt(x) : undefined;
  if (n === undefined || n < 0n || n > UINT256_MAX) throw new PublishError("GOVERN", `${what}: ${String(x)} is not a uint256`);
  return n;
}

/** The seven calls of the round, in the one order the contracts allow (see the header): the registry link first. The same builder serves govern and the evidence chain check. */
export function buildRedeployCalls(i: RedeployCallInputs): RedeployCall[] {
  const v = vectorsFromFinal({ finalVaults: i.finalVaults, finalBps: i.finalBps, oldVault: i.oldVault, newVault: i.newVault });
  const cap = asVaultCap(i.vaultCap);
  const reg = (functionName: "registerVault" | "migrateEligibility" | "retire", args: unknown[]): Hex => encodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, functionName, args } as never);
  return [
    { label: "new.setRegistry(registry)", target: i.newVault, data: encodeFunctionData({ abi: VAULT_REDEPLOY_ABI, functionName: "setRegistry", args: [i.registry] }) },
    { label: "registry.registerVault(new)", target: i.registry, data: reg("registerVault", [i.newVault, { name: i.registryName, asset: i.asset, registeredAt: 0n }]) },
    // QA plan v1 E3: a new address reads vaultCap 0 (uncapped). The cap is copied before the new vault becomes eligible, so no routed deposit reaches it uncapped.
    { label: "router.setVaultCap(new, vaultCap(old))", target: i.router, data: encodeFunctionData({ abi: ROUTER_REDEPLOY_ABI, functionName: "setVaultCap", args: [i.newVault, cap] }) },
    { label: "registry.migrateEligibility(new, true, five legs)", target: i.registry, data: reg("migrateEligibility", [i.newVault, true, v.fiveVaults, v.fiveBps.map(BigInt)]) },
    { label: "registry.migrateEligibility(old, false, four legs)", target: i.registry, data: reg("migrateEligibility", [i.oldVault, false, v.finalVaults, v.finalBps.map(BigInt)]) },
    { label: "registry.retire(old)", target: i.registry, data: reg("retire", [i.oldVault]) },
    { label: "new.unpauseDeposits()", target: i.newVault, data: encodeFunctionData({ abi: VAULT_REDEPLOY_ABI, functionName: "unpauseDeposits" }) },
  ];
}

// ---- the state before the round ----------------------------------------------------------------------------------------------

export interface RedeployBefore {
  listed: readonly string[];
  oldStatus: number;
  oldEligible: boolean;
  /** `registry.router()`: migrateEligibility reverts RouterNotLinked when it is not the router. */
  registryRouter: string;
  router: string;
  /** Does the timelock hold ADMIN_ROLE on the registry (the batch runs as the timelock). */
  timelockIsRegistryAdmin: boolean;
  /** QA plan v1 E3: does the timelock hold ADMIN_ROLE on the router (the batch's `setVaultCap` needs it; DeployTimelock grants it at stage 11). */
  timelockIsRouterAdmin: boolean;
  votedWeightsActive: boolean;
  defaultVaults: readonly string[];
  defaultBps: readonly (bigint | number)[];
  oldHasCode: boolean;
}

/** Why the round cannot start from this state. An empty list is a pass. Checked before the deploy (the verb) and again before the schedule (the row). */
export function redeployBeforeProblems(oldVault: string, newVault: string | undefined, b: RedeployBefore): string[] {
  const bad: string[] = [];
  if (!b.oldHasCode) bad.push(`the old vault ${oldVault} has no code`);
  if (!b.listed.some((v) => lc(v) === lc(oldVault))) bad.push(`the registry does not list the old vault ${oldVault}`);
  if (newVault !== undefined && b.listed.some((v) => lc(v) === lc(newVault))) bad.push(`the registry already lists the new vault ${newVault}: it was registered outside this row`);
  if (b.oldStatus !== STATUS_ACTIVE) bad.push(`the old vault's registry status is ${STATUS_NAME[b.oldStatus] ?? b.oldStatus}, want Active`);
  if (!b.oldEligible) bad.push("the old vault is not router-eligible: there is no router slot to move");
  if (lc(b.registryRouter) !== lc(b.router)) bad.push(`registry.router() is ${b.registryRouter}, not the deployment's router ${b.router}: migrateEligibility would revert RouterNotLinked`);
  if (!b.timelockIsRegistryAdmin) bad.push("the timelock does not hold ADMIN_ROLE on the registry: the batch would revert");
  if (!b.timelockIsRouterAdmin) bad.push("the timelock does not hold ADMIN_ROLE on the router: the batch's router.setVaultCap(new, vaultCap(old)) would revert");
  if (b.votedWeightsActive) bad.push("router.votedWeightsActive() is true: an applied receipt vector (which still names the old vault) overrides the default, so the split the batch keeps is not the split deposits use. Run --row clear-voted-weights first, then apply a receipt over the new vault set afterwards");
  if (!b.defaultVaults.some((v) => lc(v) === lc(oldVault))) bad.push(`the router's default vector does not hold the old vault: [${b.defaultVaults.join(", ")}]`);
  return bad;
}

// ---- the read-back after the round -----------------------------------------------------------------------------------------

export interface RedeployAfter {
  oldStatus: number;
  newStatus: number;
  oldEligible: boolean;
  newEligible: boolean;
  eligibleCount: number;
  votedWeightsActive: boolean;
  defaultVaults: readonly string[];
  defaultBps: readonly (bigint | number)[];
  effectiveVaults: readonly string[];
  effectiveBps: readonly (bigint | number)[];
  newPaused: boolean;
  /** `new.registry()` equals the deployment's registry: the batch's first call linked it. */
  newLinked: boolean;
  oldRetiredFlag: boolean;
  oldHasCode: boolean;
  /** QA plan v1 E3: `router.vaultCap(new)` and `router.vaultCap(old)`, read after the batch. They must be equal (0 on both is an uncapped leg kept uncapped). */
  newVaultCap: bigint;
  oldVaultCap: bigint;
}

const vkey = (v: readonly string[], b: readonly (bigint | number)[]): string => v.map((a, k) => `${lc(a)}:${b[k]}`).join(",");

/** What must hold after the batch executed. An empty list is a pass. The router's effective vector is what deposits route by: it must be the final vector with no applied receipt vector over it. */
export function redeployReadBackProblems(v: RedeployVectors, a: RedeployAfter): string[] {
  const bad: string[] = [];
  if (a.oldStatus !== STATUS_RETIRED) bad.push(`the old vault's registry status is ${STATUS_NAME[a.oldStatus] ?? a.oldStatus}, want Retired`);
  if (a.newStatus !== STATUS_ACTIVE) bad.push(`the new vault's registry status is ${STATUS_NAME[a.newStatus] ?? a.newStatus}, want Active`);
  if (a.oldEligible) bad.push("the old vault is still router-eligible");
  if (!a.newEligible) bad.push("the new vault is not router-eligible");
  if (a.eligibleCount !== v.finalVaults.length) bad.push(`registry.routerEligibleCount() is ${a.eligibleCount}, want ${v.finalVaults.length}`);
  if (a.votedWeightsActive) bad.push("router.votedWeightsActive() is true: an applied receipt vector overrides the default the batch left");
  const want = vkey(v.finalVaults, v.finalBps);
  if (vkey(a.defaultVaults, a.defaultBps) !== want) bad.push(`router.getDefaultWeights() is [${vkey(a.defaultVaults, a.defaultBps)}], want [${want}]`);
  if (vkey(a.effectiveVaults, a.effectiveBps) !== want) bad.push(`router.getEffectiveWeights() is [${vkey(a.effectiveVaults, a.effectiveBps)}], want [${want}]`);
  if (a.newPaused) bad.push("the new vault still reads depositsPaused true");
  if (!a.newLinked) bad.push("the new vault is not linked to the registry: the batch's setRegistry did not land");
  if (!a.oldRetiredFlag) bad.push("the old vault's retired() flag is false: its deposit halt did not run");
  if (!a.oldHasCode) bad.push("the old vault has no code: it must keep serving redeem and redeemInKind");
  if (a.newVaultCap !== a.oldVaultCap) bad.push(`router.vaultCap(new) is ${a.newVaultCap}, router.vaultCap(old) is ${a.oldVaultCap}: the replacing vault must carry the old vault's per-leg cap`);
  return bad;
}

// ---- the new vault is the contract the deploy created (QA plan v1 C2, issue 1701) -----------------------------------------
// The run manifest and the vault manifest are files an operator can edit. The address the round registers, opens and routes deposits to is therefore bound to the
// chain: it must be the `contractAddress` of a successful CREATE receipt, sent by the deployer, among the round's recorded deploy transactions. The verb reads the
// receipts forge wrote into its broadcast file, the govern row and the evidence chain check read them from the chain.

/** The receipt of one deploy transaction: from forge's broadcast file (the verb) or from the chain (the govern row, the evidence chain check). */
export interface DeployReceipt {
  hash: string;
  /** viem's "success" | "reverted", forge's "0x1" | "0x0", or the number. Anything else (undefined, a read error) is not a success. */
  status: unknown;
  from?: string | null;
  /** The created contract of a CREATE transaction; null or absent for a call. */
  contractAddress?: string | null;
}

/** 1 for a successful receipt, 0 for anything else: the number the `deploy_receipt_statuses` evidence field holds. */
export const deployReceiptStatus = (s: unknown): number => (s === "success" || s === "0x1" || s === 1 || s === "1" ? 1 : 0);

/**
 * Why `newVault` is not bound to the deploy. Every receipt must be a success, and exactly one of them must be the CREATE of `newVault`, sent by `deployer`
 * (the sheet's ADMIN_ADDRESS, the one signer the verb accepts). An empty list is a pass.
 */
export function createdVaultProblems(newVault: string, deployer: string, receipts: readonly DeployReceipt[]): string[] {
  if (receipts.length === 0) return [`no deploy transaction is recorded, so nothing shows that ${newVault} is the contract the deploy created`];
  const bad: string[] = [];
  for (const r of receipts) if (deployReceiptStatus(r.status) !== 1) bad.push(`deploy transaction ${r.hash} has receipt status ${String(r.status)}, not success`);
  const created = receipts.filter((r) => typeof r.contractAddress === "string" && ADDR.test(r.contractAddress));
  const mine = created.filter((r) => lc(r.contractAddress!) === lc(newVault));
  if (mine.length !== 1) bad.push(`${newVault} is not the contract a recorded deploy transaction created (the CREATE receipts name [${created.map((r) => r.contractAddress).join(", ")}])`);
  else if (lc(mine[0]!.from ?? "") !== lc(deployer)) bad.push(`${newVault} was created by ${mine[0]!.from ?? "an unknown sender"} in ${mine[0]!.hash}, not by the deployer ${deployer}`);
  return bad;
}

/** The receipts forge wrote into a broadcast file, by lower-case transaction hash (forge copies status, from and contractAddress from the chain). */
export function readBroadcastReceipts(path: string): Map<string, DeployReceipt> {
  const out = new Map<string, DeployReceipt>();
  if (!existsSync(path)) return out;
  const j = JSON.parse(readFileSync(path, "utf8")) as { receipts?: { transactionHash?: unknown; status?: unknown; from?: unknown; contractAddress?: unknown }[] };
  for (const r of Array.isArray(j.receipts) ? j.receipts : []) {
    if (typeof r?.transactionHash !== "string") continue; // a receipt is matched by its hash only, never by position
    out.set(lc(r.transactionHash), {
      hash: r.transactionHash, status: r.status, from: typeof r.from === "string" ? r.from : null, contractAddress: typeof r.contractAddress === "string" ? r.contractAddress : null,
    });
  }
  return out;
}

// ---- reading the chain (ChainReader) ----------------------------------------------------------------------------------------

/** The state of the deployment before the round, read with the verifier's read-only chain reader. */
export async function readRedeployBefore(chain: ChainReader, i: { registry: Address; router: Address; timelock: Address; oldVault: Address; newVault?: Address }): Promise<RedeployBefore & { registryName: string; asset: Address }> {
  const r = <T,>(at: Address, sig: string, args: unknown[] = []): Promise<T> => chain.read(at, sig, args) as Promise<T>;
  const listed = await r<string[]>(i.registry, "function listVaults() view returns (address[])");
  const [meta, status] = await r<[{ name: string; asset: Address }, number]>(i.registry, "function getVault(address vault) view returns ((string name, address asset, uint256 registeredAt) metadata, uint8 status)", [i.oldVault]);
  const [defaultVaults, defaultBps] = await r<[string[], bigint[]]>(i.router, "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)");
  return {
    listed, oldStatus: Number(status), registryName: meta.name, asset: meta.asset,
    oldEligible: await r<boolean>(i.registry, "function isRouterEligible(address vault) view returns (bool)", [i.oldVault]),
    registryRouter: await r<string>(i.registry, "function router() view returns (address)"), router: i.router,
    timelockIsRegistryAdmin: await r<boolean>(i.registry, "function hasRole(bytes32 role, address account) view returns (bool)", [ADMIN_ROLE, i.timelock]),
    votedWeightsActive: await r<boolean>(i.router, "function votedWeightsActive() view returns (bool)"),
    timelockIsRouterAdmin: await r<boolean>(i.router, "function hasRole(bytes32 role, address account) view returns (bool)", [ADMIN_ROLE, i.timelock]),
    defaultVaults, defaultBps, oldHasCode: (await chain.getCode(i.oldVault)).length > 2,
  };
}

// ---- the deploy half --------------------------------------------------------------------------------------------------------

/** The StageRow the runner's env, library and config-gate helpers take, built from the table's redeploy row. Its manifest is a temporary file next to the vault's own manifest. */
export function redeployStageRow(key: RedeployKey): StageRow {
  const t = getStageTable();
  const r = tableRedeployRow(t, key);
  const vaultRow = t.vaults.find((v) => v.key === key)!;
  const own = t.stages.find((s) => s.name === vaultRow.stage)!;
  return {
    name: `redeploy-${key.toLowerCase()}`, kind: "forge", script: r.script, requiredEnv: r.requiredEnv, optionalEnv: r.optionalEnv,
    manifest: `${manifestBase(r.manifest)}.redeploy.json`,
    libraries: r.libraries.map((n) => t.libraries.find((l) => l.name === n)!),
    create2Libraries: (r.create2Libraries ?? own.create2Libraries ?? []).map((n) => t.create2Libraries!.find((l) => l.name === n)!),
    countKey: null, vault: key,
  };
}

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
/** The RPC host for a message (a URL may carry an API key in its path). Never throws: a message is not where a bad URL is refused. */
const rpcHostOf = (url: string): string => { try { return rpcHost(url); } catch { return "the RPC"; } };

/**
 * The `redeploy-vault` verb. Needs the run manifest of the live deployment (its timelock stage done) and a signer that is the deployer (ADMIN_ADDRESS).
 * Simulates the script, checks the count, broadcasts, then keeps the old vault's manifest as `<vault manifest>.retired-N.json` and writes the new vault into the vault's own manifest.
 * `--dry-run` stops after the simulation: it sends nothing and writes nothing. A refused confirmation also writes nothing (QA plan v1 E2): the record is saved after it.
 * `--resume` continues a broadcast that died part-way (forge --resume).
 */
export async function runRedeployVault(ctx: RunContext, key: RedeployKey): Promise<RedeployRecord | undefined> {
  const refusal = redeployRefusal(ctx.chainId, ctx.sheet.kind);
  if (refusal) throw new PublishError("USAGE", refusal);
  const t = getStageTable();
  const manifest = loadRunManifest(ctx.evidenceDir);
  if (!manifest) throw new PublishError("RESUME", `no run manifest in ${ctx.evidenceDir}: ${REDEPLOY_VERB} redeploys into a deployment that exists. Pass the --evidence directory of the run that deployed it.`);
  if (manifest.stages["timelock"]?.status !== "done") throw new PublishError("RESUME", "the run manifest has no finished timelock stage: the handover has not happened, so there is nothing to redeploy into (a vault before the handover is the deploy stage's job)");
  const own = t.vaults.find((v) => v.key === key)!;
  const vaultManifest = manifestFile(own.manifest);
  const dir = manifestDir(ctx);
  const finalPath = join(dir, vaultManifest);
  const row = redeployStageRow(key);
  const tmpPath = manifestFilePath(ctx, row.manifest!);
  const records = redeploysOf(manifest);
  const mine = records.filter((r) => r.key === key);
  const open = mine.find((r) => r.status !== "governed");
  if (open?.status === "deployed") throw new PublishError("RESUME", `${VAULT_NAME[key]} was already redeployed to ${open.new_vault} (round ${open.ordinal}) and the govern row has not run: bun publish-contracts/src/cli.ts govern --row ${REDEPLOY_ROW} --chain ${ctx.chainId} --core-sha ${ctx.coreSha} (plus the same arguments). Nothing was sent.`);
  if (open?.status === "started" && !ctx.resume) throw new PublishError("RESUME", `an earlier ${REDEPLOY_VERB} of ${VAULT_NAME[key]} started at nonce ${open.deploy_start_nonce} and did not finish: continue it with --resume and the same arguments, never a fresh run`);
  if (!existsSync(finalPath)) throw new PublishError("MANIFEST", `${finalPath} is missing: the vault manifest of the live ${VAULT_NAME[key]}`);
  const current = readJson(finalPath);
  const oldVault = (open?.old_vault ?? current.vault) as Address;
  if (typeof oldVault !== "string" || !ADDR.test(oldVault)) throw new PublishError("MANIFEST", `${finalPath} has no vault address`);
  const registry = String(readJson(join(dir, `${manifestBase(t.stages.find((s) => s.name === "registry")!.manifest)}.json`)).registry) as Address;
  const router = String(readJson(join(dir, `${manifestBase(t.stages.find((s) => s.name === "router")!.manifest)}.json`)).router) as Address;
  const timelock = String(readJson(join(dir, `${manifestBase(t.stages.find((s) => s.name === "timelock")!.manifest)}.json`)).timelock) as Address;
  const deployer = await ctx.signer.address();
  if (deployer.toLowerCase() !== ctx.sheet.admin.toLowerCase()) throw new PublishError("SIGNER", `the signer ${deployer} is not ADMIN_ADDRESS ${ctx.sheet.admin}`);

  // The deployment must be in the state the round starts from: the old vault live and eligible, no voted vector, the timelock the registry and the router admin.
  const chain = (ctx.chainReader ?? viemReader)(ctx.rpc);
  const before = await readRedeployBefore(chain, { registry, router, timelock, oldVault });
  const problems = redeployBeforeProblems(oldVault, undefined, before);
  if (problems.length > 0 && !open) throw new PublishError("REFUSED", `${VAULT_NAME[key]} cannot be redeployed from the state on chain: ${problems.join("; ")}. Nothing was sent.`, { problems });

  await vaultConfigGate(ctx, row);
  const env = stageEnv(ctx, row);
  const nonce0 = await deployerNonce(ctx, deployer);
  const ordinal = open?.ordinal ?? mine.length + 1;
  const startNonce = open?.deploy_start_nonce ?? nonce0;
  const script = row.script!;
  const signerArgs = await ctx.signer.forgeArgs();
  const base = ["script", script, "--chain", String(ctx.chainId), ...signerArgs, "--slow", ...libraryArgs(ctx, row)];
  const fenv = childEnv(ctx, env);
  mkdirSync(dir, { recursive: true });
  rmSync(tmpPath, { force: true });
  rmSync(dirname(broadcastFile(ctx, script, true)), { recursive: true, force: true });
  ctx.log.log("info", "stage.start", { stage: row.name, script, start_nonce: nonce0, resume: !!open });
  const sim = await ctx.run("forge", base, { env: fenv, cwd: ctx.coreDir, interactive: true });
  if (sim.code !== 0 || !sim.stdout.includes("SIMULATION COMPLETE")) throw new PublishError("SIMULATION", `simulation of ${row.name} failed (exit ${sim.code}). Nothing was sent. ${forgeFailureTail(sim.stdout, sim.stderr, outputSecrets(ctx))}`, { stage: row.name });
  const dry = readTxCount(broadcastFile(ctx, script, true));
  if (!dry || dry.count === 0) throw new PublishError("SIMULATION", `the simulation of ${row.name} planned no transaction`, { stage: row.name });
  ctx.log.log("info", "stage.simulated", { stage: row.name, dry_run_count: dry.count });
  if (ctx.dryRun) {
    rmSync(tmpPath, { force: true });
    ctx.log.log("info", "stage.dry_run_done", { stage: row.name, dry_run_count: dry.count, simulated_on: "target-rpc (read only, nothing sent)" });
    return undefined;
  }
  rmSync(tmpPath, { force: true }); // a simulation also writes the manifest; the real run rewrites it
  const est = /Estimated amount required:\s*([0-9]+\.[0-9]+)/.exec(sim.stdout);
  if (est) {
    const need = BigInt(Math.ceil(Number(est[1]) * 3 * 1e18)) + 100_000_000_000_000n;
    const bal = BigInt(await castOut(ctx, ["balance", deployer]));
    if (bal < need) throw new PublishError("SIMULATION", `the deployer balance ${bal} wei is below ${need} wei (3x the simulated cost plus the L1 allowance). Fund it.`, { stage: row.name });
  }

  // QA plan v1 E2 (review DT-4): confirm FIRST, then save the `started` record, then broadcast. A refused confirmation sends nothing, so it must leave no open
  // record: a saved `started` round would refuse every fresh run (RESUME), send --resume into a broadcast that never began, and hold verify, until the manifest
  // was edited by hand. Once confirmed, the record is saved before forge sends anything, so a broadcast that dies part-way is always continued with --resume.
  // A resumed round's record was saved by the run that started it: a refused confirmation of the resume leaves it as it was.
  await confirmStage(ctx, REDEPLOY_VERB, `${row.name}: ${dry.count} transactions from ${deployer}, a new ${VAULT_NAME[key]} to replace ${oldVault}`);
  const rec: RedeployRecord = open ?? {
    step: REDEPLOY_ROW, vault: VAULT_NAME[key], key, ordinal, status: "started", old_vault: oldVault, registry, router, timelock, deployer, core_sha: ctx.coreSha,
    deploy_start_nonce: startNonce, started_at: (ctx.now?.() ?? new Date()).toISOString(),
  };
  manifest.vault_redeploys = [...records.filter((r) => r !== open && !(r.key === key && r.ordinal === ordinal)), rec];
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.broadcast", { stage: row.name, resume: !!open });
  const run = await ctx.run("forge", [...base, "--broadcast", ...(open ? ["--resume"] : [])], { env: fenv, cwd: ctx.coreDir, interactive: true });
  if (run.code !== 0 || !run.stdout.includes("ONCHAIN EXECUTION COMPLETE")) {
    const nonce1 = await deployerNonce(ctx, deployer);
    const forgeSaid = forgeFailureTail(run.stdout, run.stderr, outputSecrets(ctx));
    const failedTx = await failedBroadcastDetail(ctx, script, run.stdout, run.stderr);
    ctx.log.log("error", "stage.broadcast_failed", { stage: row.name, exit: run.code, forge: forgeSaid, failed_tx: failedTx || undefined });
    throw new PublishError("BROADCAST", `the broadcast of ${row.name} did not complete (exit ${run.code}). Do NOT rerun fresh. Continue with --resume and the same arguments. Deployer nonce is now ${nonce1}. forge: ${forgeSaid}${failedTx ? ` | ${failedTx}` : ""}`, { stage: row.name, nonce: nonce1 });
  }
  const sent = readTxCount(broadcastFile(ctx, script, false));
  if (!sent) throw new PublishError("MANIFEST", `forge wrote no broadcast file for ${row.name}`, { stage: row.name });
  // QA plan v1 E6 (issue 1723): forge saw every receipt, but a load-balanced RPC may answer `cast nonce` from a node behind the last deploy block, with the nonce from
  // before the broadcast: a false COUNT_MISMATCH on a round that landed. The nonce is read again, bounded, until it shows the broadcast's count. A nonce above it stops at
  // once (another transaction moved the deployer). A delta that still differs after the last read fails as before, naming the reads and the RPC host.
  const host = rpcHostOf(ctx.rpc);
  const nonceReads = await awaitRead(() => deployerNonce(ctx, deployer), (n) => n === startNonce + sent.count, ctx.readRetry, (n) => n > startNonce + sent.count);
  if (nonceReads.error !== undefined) throw nonceReads.error;
  const nonce1 = nonceReads.last!;
  const delta = nonce1 - startNonce;
  const nonceSeen = nonceReads.reads > 1 ? ` (the deployer nonce read ${nonceReads.seen.join(", ")} in ${nonceReads.reads} reads from RPC ${host})` : "";
  if (sent.count !== delta || (!open && sent.count !== dry.count)) throw new PublishError("COUNT_MISMATCH", `${row.name}: broadcast count ${sent.count}, nonce delta ${delta}, simulated count ${dry.count}${nonceSeen}. The chain has changed: stop and read it.`, { stage: row.name, broadcast: sent.count, delta, simulated: dry.count, nonce_reads: nonceReads.seen });
  if (!existsSync(tmpPath) || readFileSync(tmpPath, "utf8").trim() === "") throw new PublishError("MANIFEST", `manifest ${tmpPath} was not written by ${row.name}`, { stage: row.name });
  const written = readJson(tmpPath);
  const newVault = written.vault as Address;
  if (typeof newVault !== "string" || !ADDR.test(newVault) || lc(newVault) === lc(oldVault)) throw new PublishError("MANIFEST", `${tmpPath} has no new vault address (or it is the old one)`, { stage: row.name });
  // QA plan v1 C2 (issue 1701): the manifest is a file. The vault it names must be the contract this broadcast CREATED (a successful CREATE receipt sent by the deployer),
  // and the statuses the record keeps are the receipts' own, never assumed.
  const broadcastReceipts = readBroadcastReceipts(broadcastFile(ctx, script, false));
  const deployReceipts: DeployReceipt[] = sent.hashes.map((h) => broadcastReceipts.get(lc(h)) ?? { hash: h, status: "no receipt in the broadcast file" });
  const unbound = createdVaultProblems(newVault, deployer, deployReceipts);
  if (unbound.length > 0) throw new PublishError("MANIFEST", `${tmpPath} names the new vault ${newVault}, but the broadcast receipts do not show the deployer created it: ${unbound.join("; ")}. The old vault was not touched. Do not run the govern row.`, { stage: row.name, newVault, problems: unbound });

  // What the deploy must have left: a closed vault, no role on the deployer, the timelock admin, NO registry link (the batch's first call sets it), and not listed yet.
  // QA plan v1 E6 (issue 1723): the deploy landed moments ago. A load-balanced RPC node behind it has no code at the new vault (every read reverts), or sits between two of
  // its transactions (the deployer's role not yet renounced, the vault not yet paused). So the checks are read again, bounded, until they all pass. What still fails after
  // the last read is refused as before, and a read that still throws is refused the same way, never passed through as a raw RPC error.
  const rd = async <T,>(sig: string, args: unknown[] = []): Promise<T> => chain.read(newVault, sig, args) as Promise<T>;
  const deployLeft = async (): Promise<string[]> => {
    const bad: string[] = [];
    if (!(await rd<boolean>("function depositsPaused() view returns (bool)"))) bad.push("the new vault is not deposit-paused");
    if (!(await rd<boolean>("function hasRole(bytes32 role, address account) view returns (bool)", [ADMIN_ROLE, timelock]))) bad.push("the timelock does not hold ADMIN_ROLE on the new vault");
    if (await rd<boolean>("function hasRole(bytes32 role, address account) view returns (bool)", [ADMIN_ROLE, deployer])) bad.push("the deployer still holds ADMIN_ROLE on the new vault");
    const link = await rd<string>("function registry() view returns (address)");
    if (lc(link) !== lc(ZERO)) bad.push(`the new vault is already linked to ${link}: the govern batch links the registry (set-once), the deploy must leave it unlinked`);
    if ((await chain.read(registry, "function listVaults() view returns (address[])") as string[]).some((v) => lc(v) === lc(newVault))) bad.push("the registry already lists the new vault");
    return bad;
  };
  const left = await awaitRead(deployLeft, (b) => b.length === 0, ctx.readRetry);
  if (!left.ok) {
    const bad = left.error !== undefined ? [`the new vault cannot be read (${left.error instanceof Error ? left.error.message : String(left.error)})`] : left.last!;
    throw new PublishError("VERIFY", `the new ${VAULT_NAME[key]} ${newVault} is not in the state the deploy must leave: ${bad.join("; ")} (${left.reads} reads from RPC ${host}). The old vault was not touched. Do not run the govern row.`, { newVault, bad, reads: left.reads });
  }

  // The old vault's manifest is kept, then the new vault takes the vault's own manifest.
  const retiredName = `${manifestBase(own.manifest)}.retired-${ordinal}.json`;
  copyFileSync(finalPath, join(dir, retiredName));
  renameSync(tmpPath, finalPath);
  Object.assign(rec, {
    status: "deployed" as const, new_vault: newVault, deploy_end_nonce: nonce1, deploy_count: sent.count, deploy_tx_hashes: sent.hashes, deploy_receipt_statuses: deployReceipts.map((r) => deployReceiptStatus(r.status)),
    deploy_first_block: sent.firstBlock, deploy_last_block: sent.lastBlock, retired_manifest: retiredName, deployed_at: (ctx.now?.() ?? new Date()).toISOString(),
  });
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.done", { stage: row.name, new_vault: newVault, old_vault: oldVault, start_nonce: startNonce, end_nonce: nonce1, count: sent.count });
  return rec;
}
