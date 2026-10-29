// Redeploy ONE vault (rmPROTO) into a live deployment (issue 1796, owner decision 2026-10-13). Two halves, one record in the run manifest:
//   1. the `redeploy-vault` verb (runRedeployVault): the DEPLOYER signs the vault deploy script contracts/script/RedeployProtocolAssetVault.s.sol. The new vault is
//      deployed CLOSED and UNREGISTERED, linked to the registry, with ADMIN_ROLE on the timelock and EMERGENCY_ROLE on the emergency key. The old vault is not touched.
//   2. the govern row `redeploy-vault` (govern.ts): the Safe, through the timelock, in ONE batch: registerVault(new), migrateEligibility(new, true, ...),
//      migrateEligibility(old, false, ...), retire(old), new.unpauseDeposits(). This module builds the calls, plans the vectors and checks the read-back.
// WHY ONE BATCH. The registry refuses to retire a router-eligible vault (RetireWhileRouterEligible), and the router refuses a default vector whose length differs from
// the registry's eligible count. So the order is forced: make the NEW vault eligible first (a five-leg default vector: the old leg keeps its weight, the new leg takes 0),
// then drop the OLD vault (a four-leg vector: the new vault takes the old vault's weight in the old vault's slot), then retire the old vault, then open the new one.
// A timelock batch is atomic, so no observer, no deposit and no redeem ever sees the five-leg state, a router weighting a paused vault or a retired vault still eligible.
// The deliberate departure from the one-scheme rule (owner decision 2026-10-13): this path is an EXPERIMENT on a Base mainnet REHEARSAL deployment (sheet
// DEPLOYMENT_KIND=rehearsal, 900 s timelock). It is refused on 8453 in production. Whether the final deployment may use it is decided after the experiment.
// The pure parts (vectors, calls, read-back) read no chain and send nothing. runRedeployVault is the only function that spawns forge.
// QA plan v1 additions on top of the issue 1796 design: the sha model of the govern row and the verify after a round at another sha (E1), the `started` record saved
// only after the confirmation (E2), the timelock's router admin checked before the round (E3), the new vault bound to the deploy's CREATE receipt (C2, issue 1701)
// and the post-broadcast reads re-read on a load-balanced RPC (E6, issue 1723, with dev's safe/read-after-write.ts).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { DeploymentKind } from "./chains.ts";
import { PublishError } from "./errors.ts";
import { BASE_CHAIN_ID } from "./rehearsal/twin.ts";
import { SafeToolError, readAfterWrite } from "./safe/index.ts";
import {
  FEE_GUARD_MULTIPLE, broadcastFile, readRetryOf, rpcHostOf, castOut, childEnv, confirmStage, deployerNonce, feeGuardNeedWei, forgeFailureTail, failedBroadcastDetail, libraryArgs, loadRunManifest, manifestDir, manifestFilePath,
  outputSecrets, readTxCount, saveRunManifest, stageEnv, vaultConfigGate, type RunContext, type RunManifest,
} from "./runner.ts";
import { VAULT_NAME, type VaultKey } from "./sheet.ts";
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
  "function reactivate(address vault)",
  "function getVault(address vault) view returns ((string name, address asset, uint256 registeredAt) metadata, uint8 status)",
  "function listVaults() view returns (address[])",
  "function isRouterEligible(address vault) view returns (bool)",
  "function routerEligibleCount() view returns (uint256)",
  "function router() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
export const VAULT_REDEPLOY_ABI = parseAbi([
  "function unpauseDeposits()",
  "function depositsPaused() view returns (bool)",
  "function retired() view returns (bool)",
  "function registry() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
export const ROUTER_REDEPLOY_ABI = parseAbi([
  "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)",
  "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)",
  "function votedWeightsActive() view returns (bool)",
  "function vaultCap(address vault) view returns (uint256)",
  "function setVaultCap(address vault, uint256 cap)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);

const lc = (x: string): string => x.toLowerCase();
const ADDR = /^0x[0-9a-fA-F]{40}$/;

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
  /** Per deploy transaction, the status of the receipt forge's broadcast file holds (1 success, 0 anything else): read, never assumed (QA plan v1 C2). */
  deploy_receipt_statuses?: number[];
  deploy_first_block?: number;
  deploy_last_block?: number;
  /** The file the old vault's manifest was kept as (a name in the manifest directory). */
  retired_manifest?: string;
  replacement_manifest?: string;
  started_at: string;
  deployed_at?: string;
  // ---- govern half
  /** The registry name and asset the old vault was registered with. The new vault is registered with the same ones. */
  registry_name?: string;
  asset?: Address;
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
// A verify at the original sha after a round at another sha would compare the replacing vault with the wrong build, fail, and pause all three vaults: it is refused
// before any signer exists, and the refusal names the command that works. That holds for EVERY run that reaches the verify stage, not only the verify verb: the
// default stage set (on --resume every finished deployer stage is skipped, verify never is), `--stage all` and any list naming verify ("stage-set"). The verify stage
// checks it once more itself (verifyBuildRefusal), so a caller that skipped this model still cannot fail the verify on the wrong build and pause the three vaults.

/**
 * The runs the sha model covers. `stage-set`: a run of several stages that reaches the verify stage (the default set, `all`, a list naming verify and another
 * stage). It never names a redeploy sha (only the verify alone may), and it is refused at the original sha after a round at another sha.
 */
export type RedeployShaPath = "govern-row" | "verify" | "stage-set";

/**
 * `govern --row redeploy-vault` (the verb or `--stage govern`), `verify` (the verb, or a `--stage` list of verify alone) and a stage set that reaches verify (no verb:
 * the default set, `all`, or a list naming verify). Any other run: undefined: the other verbs never reach the verify stage, and a dry run skips it (runner.ts).
 */
export function redeployShaPath(a: { verb?: string; stage?: string; row?: string; dryRun?: boolean }): RedeployShaPath | undefined {
  const only = a.verb ?? a.stage;
  if (only === "govern" && a.row === REDEPLOY_ROW) return "govern-row";
  if (only === "verify") return "verify";
  if (a.verb !== undefined || a.dryRun) return undefined;
  if (a.stage === undefined || a.stage === "all") return "stage-set"; // the default set runs through verify, all runs every stage
  const names = a.stage.split(",").map((x) => x.trim());
  if (!names.includes("verify")) return undefined;
  return names.every((n) => n === "verify") ? "verify" : "stage-set";
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
 *   stage-set   never a pair. Refused with USAGE before any signer exists, like the verify: a --prior-out that is not a checkout of the original sha, and, after rounds
 *               at another sha, the original sha (its verify stage would compare the replacing vault with the wrong build, fail and pause all three vaults) and the
 *               redeploy sha (only the verify alone may name it). Rounds at the original sha only, or a third sha (runStages refuses it, RESUME): undefined.
 * No run manifest yet (a first run): a --prior-out must still be a checkout of this run's own sha, the sha the deployment will run.
 */
export function redeployShaRun(manifest: Pick<RunManifest, "coreSha" | "vault_redeploys"> | undefined, i: { coreSha: string; path: RedeployShaPath | undefined; priorOut?: string; priorOutSha?: string }): RedeployShaRun | undefined {
  if (i.path === undefined) return undefined;
  const original = manifest?.coreSha ?? i.coreSha;
  const recs = manifest ? redeploysOf(manifest) : [];
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
  const what = i.path === "stage-set" ? "a run of several stages that reaches the verify stage is" : "verify";
  if (foreign.length > 1 || shaOf(last) !== foreign[0]) throw new PublishError("USAGE", `${what} refused: the redeploy-vault rounds of this run were deployed at ${[...new Set(recs.map(shaOf))].join(", ")} (the last at ${shaOf(last)}), and the verifier compares with two builds only (the checkout and --prior-out). ${nothing}`);
  const redeploySha = foreign[0]!;
  const verifyAlone = `bun publish-contracts/src/cli.ts verify --core-sha ${redeploySha} --prior-out <forge out/ of a checkout at ${original}> (plus the same --chain, --rpc, --sheet, --signer, --environment and --evidence arguments)`;
  if (i.coreSha === original) throw new PublishError("USAGE", `${what} refused at the original sha ${original}: ${last.vault} was redeployed at ${redeploySha} (round ${last.ordinal}), so the build of this checkout is not the replacing vault's, and a failed verify pauses all three vaults. Run the verify ${i.path === "stage-set" ? "alone, " : ""}at the redeploy sha: ${verifyAlone}${i.path === "stage-set" ? `, and name the other stages with a --stage list without verify` : ""}. ${nothing}`);
  if (i.coreSha !== redeploySha) return undefined; // a third sha: runStages refuses it (RESUME)
  if (i.path === "stage-set") throw new PublishError("USAGE", `${what} refused at the redeploy sha ${redeploySha}: only the verify alone (the verify verb or --stage verify) may name the sha a redeploy-vault round was deployed at, every other stage runs at the original sha ${original}. Run the verify alone: ${verifyAlone}. ${nothing}`);
  if (i.priorOut === undefined) throw new PublishError("USAGE", `verify at the redeploy sha ${redeploySha} needs --prior-out <forge out/ of a checkout at the original sha ${original}>: every contract the redeploy did not replace runs that build. ${nothing}`);
  return { originalSha: original, redeploySha };
}

/**
 * QA plan v1 E1 (DT-2): the verify stage's own guard, behind redeployShaRun in cli.ts. After a governed round at another sha than the run manifest's, the verify
 * must run at that sha with --prior-out of a checkout at the original sha: the replacing vault runs the redeploy build, every other contract the original one.
 * Any other verify would compare a contract with the wrong build, fail and pause all three vaults. Returns that refusal (USAGE, `details.refused_before_verify`,
 * so cli.ts pauses nothing) or undefined. Rounds at the original sha only: undefined (one build serves all).
 */
export function verifyBuildRefusal(manifest: Pick<RunManifest, "coreSha" | "vault_redeploys">, ctx: { coreSha: string; priorArtifactsDir?: string; priorArtifactsSha?: string }): PublishError | undefined {
  const original = manifest.coreSha;
  const recs = redeploysOf(manifest);
  const shaOf = (r: RedeployRecord): string => r.core_sha || original;
  const foreign = [...new Set(recs.map(shaOf).filter((s) => s !== original))];
  if (foreign.length === 0) return undefined;
  const refuse = (why: string) => new PublishError("USAGE", `verify refused before the verifier ran: ${why}. A redeploy-vault round of this run was deployed at ${foreign.join(", ")}, the deployment at ${original}: run bun publish-contracts/src/cli.ts verify --core-sha ${foreign[0]} --prior-out <forge out/ of a checkout at ${original}>. Nothing was checked or paused.`, { refused_before_verify: true, original_sha: original, redeploy_shas: foreign });
  const last = recs[recs.length - 1]!;
  if (foreign.length > 1 || shaOf(last) !== foreign[0]) return refuse(`the rounds ran at ${[...new Set(recs.map(shaOf))].join(", ")} (the last at ${shaOf(last)}) and the verifier compares with two builds only`);
  if (ctx.coreSha !== foreign[0]) return refuse(`this run is at ${ctx.coreSha}, so its build is not the replacing vault's`);
  if (!ctx.priorArtifactsDir) return refuse("no --prior-out, so every contract the redeploy did not replace would be compared with the redeploy build");
  if (ctx.priorArtifactsSha !== original) return refuse(`--prior-out ${ctx.priorArtifactsDir} is a build at ${ctx.priorArtifactsSha ?? "no git checkout"}, not at the original sha`);
  return undefined;
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

export interface RedeployCallInputs { router: Address; routerVaultCap: bigint; registry: Address; oldVault: Address; newVault: Address; registryName: string; asset: Address; finalVaults: readonly string[]; finalBps: readonly (bigint | number)[] }

/** The six calls of the round, in the one order the contracts allow (see the header). The same builder serves govern and the evidence chain check. */
export function buildRedeployCalls(i: RedeployCallInputs): RedeployCall[] {
  if (typeof i.routerVaultCap !== "bigint" || i.routerVaultCap < 0n) throw new PublishError("GOVERN", "router vault cap must be an explicitly recorded non-negative bigint");
  const v = vectorsFromFinal({ finalVaults: i.finalVaults, finalBps: i.finalBps, oldVault: i.oldVault, newVault: i.newVault });
  const reg = (functionName: "registerVault" | "migrateEligibility" | "retire", args: unknown[]): Hex => encodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, functionName, args } as never);
  return [
    { label: "registry.registerVault(new)", target: i.registry, data: reg("registerVault", [i.newVault, { name: i.registryName, asset: i.asset, registeredAt: 0n }]) },
    { label: "router.setVaultCap(new, approved old cap)", target: i.router, data: encodeFunctionData({ abi: ROUTER_REDEPLOY_ABI, functionName: "setVaultCap", args: [i.newVault, i.routerVaultCap] }) },
    { label: "registry.migrateEligibility(new, true, five legs)", target: i.registry, data: reg("migrateEligibility", [i.newVault, true, v.fiveVaults, v.fiveBps.map(BigInt)]) },
    { label: "registry.migrateEligibility(old, false, four legs)", target: i.registry, data: reg("migrateEligibility", [i.oldVault, false, v.finalVaults, v.finalBps.map(BigInt)]) },
    { label: "registry.retire(old)", target: i.registry, data: reg("retire", [i.oldVault]) },
    { label: "new.unpauseDeposits()", target: i.newVault, data: encodeFunctionData({ abi: VAULT_REDEPLOY_ABI, functionName: "unpauseDeposits" }) },
  ];
}

export interface RestoreOldInputs { registry: Address; oldVault: Address; newVault: Address; currentVaults: readonly string[]; currentBps: readonly (bigint | number)[] }

/**
 * The approved RESTORE-OLD recovery (issue 1796): the inverse of the six-call batch, never automatic because the old vault keeps the known redeem defect. Four calls, one atomic
 * timelock batch, in the one order the contracts allow: reactivate(old) FIRST (Retired -> Active, deposits reopened), then TWO matching eligibility migrations (old in beside the
 * new vault at 0 bps, then the new vault out with the old vault back in its slot at the unchanged weight), then retire(new). Retiring the new vault halts its deposits only: its
 * holders keep redeem and redeemInKind. The same vector helper serves both directions with the roles swapped, so the two migrations mirror the forward ones exactly.
 */
export function buildRestoreOldCalls(i: RestoreOldInputs): RedeployCall[] {
  if (i.currentVaults.some((v) => lc(v) === lc(i.oldVault))) throw new PublishError("GOVERN", `restore-old: the router's default vector already holds the old vault ${i.oldVault}`);
  const restored = i.currentVaults.map((v) => (lc(v) === lc(i.newVault) ? i.oldVault : v));
  const v = vectorsFromFinal({ finalVaults: restored, finalBps: i.currentBps, oldVault: i.newVault, newVault: i.oldVault });
  const reg = (functionName: "migrateEligibility" | "retire" | "reactivate", args: unknown[]): Hex => encodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, functionName, args } as never);
  return [
    { label: "registry.reactivate(old)", target: i.registry, data: reg("reactivate", [i.oldVault]) },
    { label: "registry.migrateEligibility(old, true, five legs)", target: i.registry, data: reg("migrateEligibility", [i.oldVault, true, v.fiveVaults, v.fiveBps.map(BigInt)]) },
    { label: "registry.migrateEligibility(new, false, four legs)", target: i.registry, data: reg("migrateEligibility", [i.newVault, false, v.finalVaults, v.finalBps.map(BigInt)]) },
    { label: "registry.retire(new)", target: i.registry, data: reg("retire", [i.newVault]) },
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
  /**
   * QA plan v1 E3: does the timelock hold ADMIN_ROLE on the router (the batch's `setVaultCap` needs it; DeployTimelock grants it at stage 11). Optional: a caller that
   * did not read it checks nothing here, and the batch's setVaultCap would revert after the delay instead of before the schedule.
   */
  timelockIsRouterAdmin?: boolean;
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
  if (b.timelockIsRouterAdmin === false) bad.push("the timelock does not hold ADMIN_ROLE on the router: the batch's router.setVaultCap(new, approved old cap) would revert");
  if (b.votedWeightsActive) bad.push("router.votedWeightsActive() is true: an applied receipt vector (which still names the old vault) overrides the default, so the split the batch keeps is not the split deposits use. The redeploy row runs only on a deployment with no applied vector: nothing clears one (issue 1988)");
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
  oldRetiredFlag: boolean;
  oldHasCode: boolean;
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
  if (!a.oldRetiredFlag) bad.push("the old vault's retired() flag is false: its deposit halt did not run");
  if (!a.oldHasCode) bad.push("the old vault has no code: it must keep serving redeem and redeemInKind");
  return bad;
}

// ---- the new vault is the contract the deploy created (QA plan v1 C2, issue 1701) -----------------------------------------
// The run manifest and the vault manifest are files an operator can edit. The address the round registers, opens and routes deposits to is therefore bound to the
// chain: it must be the `contractAddress` of a successful CREATE receipt, sent by the deployer, among the round's recorded deploy transactions. The verb reads the
// receipts forge wrote into its broadcast file, the govern row and the evidence chain check read them from the chain. The new vault is an ERC1967Proxy the deployer
// creates with a plain CREATE (UpgradeAuthority._deployProxy), so its receipt names it.

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
  const latest = [...mine].reverse().find((r) => r.status === "governed");
  const currentPath = latest?.replacement_manifest ? join(dir, latest.replacement_manifest) : finalPath;
  const current = readJson(currentPath);
  const oldVault = (open?.old_vault ?? current.vault) as Address;
  if (typeof oldVault !== "string" || !ADDR.test(oldVault)) throw new PublishError("MANIFEST", `${finalPath} has no vault address`);
  const registry = String(readJson(join(dir, `${manifestBase(t.stages.find((s) => s.name === "registry")!.manifest)}.json`)).registry) as Address;
  const router = String(readJson(join(dir, `${manifestBase(t.stages.find((s) => s.name === "router")!.manifest)}.json`)).router) as Address;
  const timelock = String(readJson(join(dir, `${manifestBase(t.stages.find((s) => s.name === "timelock")!.manifest)}.json`)).timelock) as Address;
  const deployer = await ctx.signer.address();
  if (deployer.toLowerCase() !== ctx.sheet.admin.toLowerCase()) throw new PublishError("SIGNER", `the signer ${deployer} is not ADMIN_ADDRESS ${ctx.sheet.admin}`);

  // The deployment must be in the state the round starts from: the old vault live and eligible, no voted vector, the timelock the registry admin.
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
  // Deploy 3 (2026-10-18), as runner.ts runForgeStage: a resumed round keeps the manifest its own broadcast wrote. `forge script --resume` never runs the script
  // again, and the simulation below writes the addresses of the CURRENT nonce, so the manifest is put back before the broadcast.
  const kept = open && existsSync(tmpPath) ? readFileSync(tmpPath, "utf8") : undefined;
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
  rmSync(tmpPath, { force: true }); // a simulation also writes the manifest; the real run rewrites it, a resumed one keeps its own
  if (kept !== undefined) writeFileSync(tmpPath, kept);
  const est = /Estimated amount required:\s*([0-9]+\.[0-9]+)/.exec(sim.stdout);
  if (est) {
    const need = feeGuardNeedWei(Number(est[1]));
    const bal = BigInt(await castOut(ctx, ["balance", deployer]));
    if (bal < need) throw new PublishError("SIMULATION", `the deployer balance ${bal} wei is below ${need} wei (${FEE_GUARD_MULTIPLE}x the simulated cost plus the L1 allowance). Fund it.`, { stage: row.name });
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
  // before the broadcast: a false COUNT_MISMATCH on a round that landed. The nonce is read again (safe/read-after-write.ts, bounded) until it shows the broadcast's
  // count. A nonce above it is returned at once (another transaction moved the deployer). A nonce that never shows it is COUNT_MISMATCH as before, naming the reads.
  const host = rpcHostOf(ctx.rpc);
  const target = startNonce + sent.count;
  let nonce1: number;
  try {
    nonce1 = await readAfterWrite({
      what: `the deployer ${deployer} nonce after ${row.name}`, expected: String(target), rpcUrl: ctx.rpc, read: () => deployerNonce(ctx, deployer),
      judge: (n) => (n === target ? "fresh" : n < target ? "stale" : "wrong"), logger: ctx.log,
    }, readRetryOf(ctx));
  } catch (e) {
    if (!(e instanceof SafeToolError) || e.code !== "STALE_READ_TIMEOUT") throw e;
    throw new PublishError("COUNT_MISMATCH", `${row.name}: broadcast count ${sent.count}, simulated count ${dry.count}, and the deployer nonce never showed ${target} (RPC ${host}): ${e.message} The chain has changed or the RPC is behind: stop and read it.`, { stage: row.name, broadcast: sent.count, simulated: dry.count, expected_nonce: target, last: e.details.last });
  }
  const delta = nonce1 - startNonce;
  if (sent.count !== delta || (!open && sent.count !== dry.count)) throw new PublishError("COUNT_MISMATCH", `${row.name}: broadcast count ${sent.count}, nonce delta ${delta}, simulated count ${dry.count}. The chain has changed: stop and read it.`, { stage: row.name, broadcast: sent.count, delta, simulated: dry.count });
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

  // What the deploy must have left: a closed vault, no role on the deployer, the timelock admin, the registry link, and not listed yet.
  // QA plan v1 E6 (issue 1723): the deploy landed moments ago. A load-balanced RPC node behind it has no code at the new vault (every read reverts), or sits between two of
  // its transactions (the deployer's role not yet renounced, the vault not yet paused). So the checks are read again, bounded, until they all pass. What still fails after
  // the last read is refused as before, and a read that still throws is refused the same way, never passed through as a raw RPC error.
  const rd = async <T,>(sig: string, args: unknown[] = []): Promise<T> => chain.read(newVault, sig, args) as Promise<T>;
  let lastBad: string[] | undefined;
  const deployLeft = async (): Promise<string[]> => {
    lastBad = undefined; // a read that throws part-way leaves no verdict: the refusal then names the read error, never an older pass's problems
    const bad: string[] = [];
    if (!(await rd<boolean>("function depositsPaused() view returns (bool)"))) bad.push("the new vault is not deposit-paused");
    if (!(await rd<boolean>("function hasRole(bytes32 role, address account) view returns (bool)", [ADMIN_ROLE, timelock]))) bad.push("the timelock does not hold ADMIN_ROLE on the new vault");
    if (await rd<boolean>("function hasRole(bytes32 role, address account) view returns (bool)", [ADMIN_ROLE, deployer])) bad.push("the deployer still holds ADMIN_ROLE on the new vault");
    if (lc(await rd<string>("function registry() view returns (address)")) !== lc(registry)) bad.push("the new vault is not linked to the registry");
    if ((await chain.read(registry, "function listVaults() view returns (address[])") as string[]).some((v) => lc(v) === lc(newVault))) bad.push("the registry already lists the new vault");
    lastBad = bad;
    return bad;
  };
  try {
    await readAfterWrite({
      what: `the state the deploy left on the new ${VAULT_NAME[key]} ${newVault}`, expected: "closed, timelock admin, no deployer admin, linked, not listed", rpcUrl: ctx.rpc,
      read: deployLeft, judge: (b) => (b.length === 0 ? "fresh" : "stale"), show: (b) => b.join("; "), logger: ctx.log,
    }, readRetryOf(ctx));
  } catch (e) {
    if (!(e instanceof SafeToolError) || e.code !== "STALE_READ_TIMEOUT") throw e;
    const bad = lastBad && lastBad.length > 0 ? lastBad : [`the new vault cannot be read (${String(e.details.last)})`];
    throw new PublishError("VERIFY", `the new ${VAULT_NAME[key]} ${newVault} is not in the state the deploy must leave: ${bad.join("; ")} (${String(e.details.tries)} reads from RPC ${host}). The old vault was not touched. Do not run the govern row.`, { newVault, bad, reads: e.details.tries });
  }

  // The old vault's manifest is kept, then the new vault takes the vault's own manifest.
  const retiredName = `${manifestBase(own.manifest)}.retired-${ordinal}.json`;
  copyFileSync(currentPath, join(dir, retiredName));
  const replacementName = `${manifestBase(own.manifest)}.replacement-${ordinal}.json`;
  if (existsSync(join(dir, replacementName))) throw new PublishError("MANIFEST", "replacement manifest already exists; reconcile interrupted broadcast before retry");
  renameSync(tmpPath, join(dir, replacementName));
  Object.assign(rec, {
    status: "deployed" as const, new_vault: newVault, deploy_end_nonce: nonce1, deploy_count: sent.count, deploy_tx_hashes: sent.hashes, deploy_receipt_statuses: deployReceipts.map((r) => deployReceiptStatus(r.status)),
    deploy_first_block: sent.firstBlock, deploy_last_block: sent.lastBlock, retired_manifest: retiredName, replacement_manifest: replacementName, deployed_at: (ctx.now?.() ?? new Date()).toISOString(),
  });
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.done", { stage: row.name, new_vault: newVault, old_vault: oldVault, start_nonce: startNonce, end_nonce: nonce1, count: sent.count });
  return rec;
}
