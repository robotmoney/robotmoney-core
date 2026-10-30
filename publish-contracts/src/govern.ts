// Stage 13 govern: the post-handover operations through the REAL Safe and the REAL timelock, with the Safe tool (src/safe).
// After the timelock stage the deployer holds no role. Everything here is a Safe transaction that schedules, executes or cancels a timelock operation.
// STAGE 13 IS THE UNPAUSE OF EACH OF THE THREE VAULTS (issue 1520, issue 1710: all three deploy paused). The rows come from the stage table's vault rules
// (scripts/deploy/stage-table.json vaults[], `unpauseRow` and `unpauseInStage13`, issue 1705), never from a vault key typed here. An unpause
// needs ADMIN_ROLE through the timelock (docs/technical/security-model.md, the pause-key abuse and pause-trigger rows). The vault
// setters, router eligibility and the router default weights are DEPLOY-TIME configuration the deployer sets before the handover (the basket vault
// stages), and the verify stage asserts them against the sheet. There is no voting by anyone: RouterGovernance has no propose, vote or execute (issue 1698).
// ROUTER WEIGHTS CHANGE ON DEMAND THROUGH ONE ROW, apply-receipt (core 1696): the Safe, through the timelock, is the only body that changes any
// contract configuration, router weights included. WEIGHT_SETTER_ROLE is the only authority over router weights and it submits the Investment
// Committee's consensus receipt; that submission is the rebalance: ONE timelock call, RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps),
// which releases the receipt and sets the router's active vector together, read back as isReleased and the router weights. Never part of stage 13.
// The rows (GOVERN_ROWS):
//   unpause-USDC, unpause-PROTO, unpause-RWA   one timelock operation per unpause (never a shared operation), all scheduled in ONE sitting.
//                                               All three vaults deploy paused (issue 1710), so stage 13 opens all three. After a pause-all the same rows reopen a vault
//                                               on demand (`--row unpause-X`, a new numbered round, issue 1667).
//   update-delay, batch, cancel                 Demonstrations of the Safe tool. Refused with USAGE on 8453, except in a REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal, issue 1727):
//                                               there they run on 8453 as explicit `--row` runs, in order after the three unpauses, never as part of stage 13.
// A run schedules every unpause the sheet asks for (GOVERN_UNPAUSE_VAULTS), waits ONE timelock delay, then executes each and reads depositsPaused() back.
// An operation declared dependent on another carries that operation's id as the timelock predecessor and runs in the same resume (no second wait).
// On demand, outside the matrix (it never blocks or completes the govern stage):
//   safe-add-owner, safe-remove-owner, safe-swap-owner, safe-change-threshold   (issue 1645) Safe self-administration: one direct Safe transaction to the Safe itself.
//   timelock-grant-role, timelock-revoke-role                                   (issue 1645) a Safe -> Timelock self-call: the timelock calls itself after the delay.
// The self-administration rows are TWIN-ONLY until the owner decides otherwise (owner question 2, default (a)): refused with USAGE on 8453, before the Safe is read.
// SHEET AND ROSTER (QA plan v1 B4): every other row refuses (GOVERN) when the Safe's live owners or threshold differ from the sheet's SAFE_OWNERS / SAFE_THRESHOLD. The
// self-administration rows are exempt, because their purpose is that change: they read back against their own arguments (safeAdminEffect), before the send (a change
// already in effect is reprinted from its record or recorded as skipped, never sent twice) and after it. The operator then updates the sheet (runbook section 9). The
// Safe's own rules (GS201 threshold above owner count, GS203, GS204) are checked before anything is proposed. A record is keyed on the row, the calldata and the
// Safe nonce (selfAdminRecordKey), so add X, remove X, add X is three transactions, while a rerun of a change still in effect sends nothing.
// A Safe module, guard or fallback-handler change has no row and is refused by name (refuseSafeConfigChange): the Safe contract itself would accept a
// well-formed one from two owners, so the control is this tool plus the verifier (no module, no guard, the canonical handler), not the contract.
// The Safe's own timelock role is given up by timelock-revoke-role, which waits the delay. The tool never builds renounceRole (owner question 1, default (b)), and it refuses
// timelock-revoke-role PROPOSER_ROLE for the last holder before anything is sent (assertNotLastProposer): the deployed timelock is a ProposerFloorTimelock, which reverts that
// revoke (and a renounce) with LastProposerFloor, so the governed contracts can never be left with no proposer (QA plan v1 B3, CS-3). Grant a second proposer first.
//   release-receipt              ConsensusRecommendationReceipt.releaseReceipt(receiptId), one round per receipt id (--receipt-id)
// The receipt contract's ADMIN_ROLE is held by the TimelockController after the timelock stage (INV-3), so the release is the same Safe ->
// Timelock round as every other row. It runs on the Twin chain AND on 8453 (issue 1611): on 8453 it is a standalone post-launch action, its own
// timelock operation with its own 48-hour delay, never part of stage 13 (stageRows stays the three unpauses). The first run schedules and exits
// GOVERN_PENDING with the resume command, the resume after the delay executes and reads isReleased back. Its run-manifest key and salt are `release-receipt-<receiptId>`.
// Issue 1831: REFUSED with USAGE (nothing read past the role, nothing sent) once RouterGovernance holds the receipt contract's ADMIN_ROLE, which every deploy since issue 1698
// grants. A release alone would burn the receipt (applyReceipt then reverts ReceiptAlreadyReleased), so the message points at apply-receipt.
//   apply-receipt                the rebalance (issue 1696, issue 1698): ONE timelock call, RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps) for the
// receipt's vector (--receipt-id, --payload FILE). Before anything is sent it checks: the receipt is recorded, it was recorded after RouterGovernance.lastAppliedRecordedAt
// (issue 1831: applyReceipt is monotonic, so an older receipt can never replace a newer vector; an execute that finds a newer receipt applied meanwhile refuses GOVERN), its stored digest equals the receipt digest (keccak256 of the domain line + the canonical bytes, receipt-digest.ts) of the payload bytes, the
// vector sums to 10000 bps and lists exactly the registry's router-eligible vaults in registry order, and the receipt is not released. After the real delay the Safe executes
// the call and the tool reads isReleased and the router weights back. No vote. Never part of stage 13: on 8453 only `--row apply-receipt` names it (own 172800 s delay).
// Its run-manifest key and salt are `apply-receipt-<receiptId>`. A Twin run proves the row executes on the real contracts, not that mainnet governance works.
// apply-receipt sets the router's ACTIVE vector (setWeights through the weight setter), so its read-back checks getWeights and the EFFECTIVE weights (what deposits route
// by, issue 1743) equal the receipt's vector, with votedWeightsActive true. The default vector is untouched and stays the fallback.
//   clear-voted-weights          on demand (issue 1743), no arguments: ONE timelock call, RouterGovernance.clearVotedWeights() (ADMIN_ROLE, the timelock), which clears the router's active vector
// so routing falls back to the default. It reads votedWeightsActive false and effective == default back. Refused (GOVERN, nothing scheduled) when no active vector is in effect. Runs on 8453 in
// production and in a rehearsal, never in stage 13, with its own delay. A later applied receipt that sets an active vector again opens round 2 with the same explicit `--row`.
//   set-unwind-guard             on demand (QA plan v1 D7, review E5, issue 1705 Q2), `--admin-arg vault=PROTO|RWA token=0x..|all min-usdc-out=N max-loss-bps=N [override-allowed=true|false]`:
// ONE timelock operation on one basket vault, BasketVault.setEmergencyUnwindGuard(token, minUsdcOut, overrideAllowed, maxLossBps) per token (ADMIN_ROLE, the timelock). Before it no stage
// and no row set the guard, so the oracle-free unwind and emergencyUnwindWithOverride could not run. overrideAllowed defaults to true, set by the Safe only (QA plan v1 Decisions D3).
// Refused (GOVERN, nothing scheduled) for a token that is not an active asset or a vault whose ADMIN_ROLE the timelock does not hold; a guard already in effect is recorded as
// skipped. It reads each guard back. Runs on 8453 in production and in a rehearsal, and on the Twin chain, never in stage 13. unwind-guard.ts has the why.
// Evidence: the run manifest's `unwind_guards` (a record).
//   retire-vault                on demand (issue 1912, ADR-0017, ADR-0009), `--admin-arg vault=0x.. weights=USDC:9500,PROTO:500,RWA:0`: the Safe, through the timelock, retires ONE vault of the live
// deployment (rmAGENT on v0.5.0) in ONE batch of two calls, registry.migrateEligibility(vault, false, three legs) then registry.retire(vault). The order is forced by the contracts (retire reverts
// RetireWhileRouterEligible, and the router's default vector must span the eligible set), see retire-vault.ts. The preview is logged before the schedule, the vector is refused unless it is the router's
// current default vector without the vault, and the read-back checks the registry status, the eligible count, the router's DEFAULT and EFFECTIVE vectors and the vault's retired() flag. Production,
// rehearsal and the Twin chain. Never part of stage 13. Its run-manifest key and salt are `retire-vault-<the vault address, 40 lower-case hex digits>`; the evidence entry is `vault_retirements`.
//   redeploy-vault              on demand (issue 1796), no arguments: the Safe, through the timelock, replaces ONE vault of the live deployment (rmPROTO) with the one the `redeploy-vault`
// verb deployed. ONE timelock batch of five calls (registry.registerVault(new), registry.migrateEligibility(new, true, five legs), registry.migrateEligibility(old, false, four legs),
// registry.retire(old), new.unpauseDeposits()) so no observer sees a router that weights a paused or retired vault. The order is forced by the contracts (a vault must be made
// router-ineligible before it is retired, and the router's default vector must span the eligible set), see redeploy-vault.ts. The read-back checks the registry statuses, the
// eligibility, the router's DEFAULT and EFFECTIVE vectors and the vaults' deposit state. Rehearsal (DEPLOYMENT_KIND=rehearsal) and the Twin chain only: refused on 8453 in production.
// The new vault is bound to the chain, not to the run manifest (QA plan v1 C2): it must be the contract a recorded deploy transaction of the sheet's deployer CREATED (the
// receipt's contractAddress), and the Safe transaction's description names the old and the new address. The salt takes the round's own `core_sha` (QA plan v1 E1), so a
// schedule and a resume name one operation whichever sha the row runs at.
// Never part of stage 13. Its run-manifest key and salt are `redeploy-vault-<KEY>-<ordinal>`; the evidence entry is the `vault_redeploys` entry the verb started.
// ROUNDS (issue 1667): every unpause row is a numbered round. The salt carries the round, so a vault that is paused again after an executed unpause
// gets a NEW timelock operation id on its next `--row unpause-X` run, instead of re-hitting the operation that is already done. The earlier round's
// record is kept in the run manifest under `<row>:round-<n>`. Only an explicit `--row` opens a new round: a default run that finds an executed row
// whose vault reads paused again refuses (GOVERN) and names the row command, so a script can never reopen a vault the operators paused.
// PAUSE-ALL AFTER A SCHEDULE (issue 1686): pause-all records an entry (monotonic `seq`) in the run manifest. Every schedule record carries a `seq` from the same
// counter. The execute phase of an unpause refuses (GOVERN, exit 14) before it sends anything when a pause entry has a higher seq than the round's schedule,
// and prints the cancel-through-the-Safe instruction. There is no tool cancel on 8453: the operator cancels the operation through the Safe on the timelock, then
// `--row unpause-X` finds the cancelled operation and schedules the same round again (a cancelled id may be scheduled again), which gets a newer seq and executes.
// A vault the sheet does not list in GOVERN_UNPAUSE_VAULTS is recorded as skipped (it stays paused). This module decides nothing about pause semantics.
// The wait is the timelock's real delay. On a Twin fork (chain id is not 8453 and the RPC answers anvil_nodeInfo) it runs by ONE time warp to one second
// past the latest ready time. On 8453 there is no warp and no long sleep: the run exits GOVERN_PENDING once, with the ready time and the exact next
// command, and the same command resumes the stage.
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiItem, toBytes, toHex, type Address, type Hex } from "viem";
import { receiptPayloadDigest } from "./receipt-digest.ts";
import { APPLY_ROW, GOVERNANCE_LAST_APPLIED_ABI, REGISTRY_ELIGIBLE_ABI, RECEIPT_RECORD_ABI, ROUTER_WEIGHTS_ABI, applyReadBackProblems, applyRecordKey, buildApplyCall, notNewerMessage, planApply } from "./apply-receipt.ts";
import { CLEAR_ROW, buildClearCall, clearReadBackProblems } from "./clear-voted-weights.ts";
import {
  REDEPLOY_ROW, REGISTRY_REDEPLOY_ABI, ROUTER_REDEPLOY_ABI, VAULT_REDEPLOY_ABI, STATUS_NAME, buildRedeployCalls, createdVaultProblems, planRedeployVectors, redeployBeforeProblems,
  redeployReadBackProblems, redeployRecordKey, redeployRefusal, redeploysOf, vectorsFromFinal, type DeployReceipt, type RedeployRecord, type RedeployVectors,
} from "./redeploy-vault.ts";
import {
  UNWIND_GUARD_ROW, VAULT_UNWIND_GUARD_ABI, buildUnwindGuardCalls, parseUnwindGuardArgs, unwindGuardArgsText, unwindGuardProblems, unwindGuardRecordKey, unwindGuardTargets,
  type GuardRead, type UnwindGuardArgs, type UnwindGuardWant,
} from "./unwind-guard.ts";
import {
  RETIRE_ROW, buildRetireCalls, parseRetireArgs, retireBeforeProblems, retireReadBackProblems, retireRecordKey, retirePreviewLines, type RetireArgs, type RetireWant,
} from "./retire-vault.ts";
import { PublishError } from "./errors.ts";
import {
  FREEZE_ROW, GOVERNED_PROXY_ABI, UPGRADE_MIGRATIONS, UPGRADE_ROW, buildFreezeCalls, buildMigration, buildUpgradeCall, codeHashOf, freezeSpecsFor, freezeTargets, layoutGateProblems, migrationNameProblems,
  pendingUpgrades, rerecordProxyManifest, runtimeCodeProblems, upgradeRecordKey, type MigrationRecord,
} from "./upgrade-rows.ts";
import { proxySpecs } from "./verify/upgradeability.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "./verify/codehash.ts";
import { UPGRADEABILITY_MANIFEST } from "./verify-stage.ts";
import { getStageTable } from "./stages.ts";
import { manifestBase } from "./stage-table.ts";
import { REGISTER_ROW, RECEIPT_ROLE_ABI, assertSubmitter, buildRegisterCall, registerReadBackProblems, registerRecordKey } from "./submitter-register.ts";
import { ADMIN_ROLE, RECEIPT_RELEASER_ROLE, RECEIPT_SUBMITTER_ROLE } from "./verify/constants.ts";
import { forbiddenSubmitters, inspectSubmitterSafe, chainFromClient, submitterSafeEvidence, type SubmitterSafeEvidence, type SubmitterSafeInfo } from "./submitter-safe.ts";
import type { DeploymentKind } from "./chains.ts";
import { BASE_CHAIN_ID, httpRpc, isTwinFork, warpBy } from "./rehearsal/twin.ts";
import { manifestDir, loadRunManifest, readManifestField, reserveManifestSeq, saveRunManifest, type PauseEntry, type RunContext, type RunManifest } from "./runner.ts";
import { BASKET_KEYS, VAULT_NAME, type Sheet, type VaultKey } from "./sheet.ts";
import { STAGE13_UNPAUSE_ROWS, VAULT_UNPAUSE_ROWS } from "./vault-rules.ts";
import { VAULT_STAGES, manifestRef, receiptRef, type StageRow } from "./stages.ts";
import {
  cancelOnTimelock, connectSafe, executeOnTimelock, executeTx, operationId, operationState, proposeTx, roleId, scheduleOnTimelock, signTx, timelockMinDelay,
  updateTimelockDelay, TIMELOCK_ROLES, verifyTimelockEffect, type Signer, type SafeHandle, type SafeTxBundle, type TimelockCall,
} from "./safe/index.ts";

export const VAULT_ABI = parseAbi([
  "function setPerDepositCap(uint256 newCap)",
  "function unpauseDeposits()",
  "function depositsPaused() view returns (bool)",
  "function perDepositCap() view returns (uint256)",
]);
export const RECEIPT_ABI = parseAbi([
  "function releaseReceipt(bytes32 receiptId)",
  "function isRecorded(bytes32 receiptId) view returns (bool)",
  "function isReleased(bytes32 receiptId) view returns (bool)",
]);
const TL_ABI = parseAbi(["function updateDelay(uint256 newDelay)"]);
export const SAFE_ADMIN_ABI = parseAbi([
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 _threshold)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const ROLE_ABI = parseAbi(["function grantRole(bytes32 role, address account)", "function revokeRole(bytes32 role, address account)", "function hasRole(bytes32 role, address account) view returns (bool)"]);

export interface GovernAddrs {
  timelock: Address; safe: Address; registry: Address; router: Address; governance: Address;
  vaults: Record<VaultKey, Address>;
}

export function loadGovernAddrs(ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): GovernAddrs {
  const r = (ref: string) => readManifestField(ctx, ref) as Address;
  return {
    timelock: r(manifestRef("timelock", "timelock")), safe: r(manifestRef("safe", "safe")),
    registry: r(manifestRef("registry", "registry")), router: r(manifestRef("router", "router")), governance: r(manifestRef("governance", "governance")),
    vaults: Object.fromEntries(VAULT_STAGES.map((v) => [v.key, r(manifestRef(v.stage, "vault"))])) as Record<VaultKey, Address>,
  };
}

export interface LabelledCall extends TimelockCall { label: string }

/**
 * The mainnet rows: one unpause per vault, each its own timelock operation, all scheduled in one sitting. Derived from the stage table's vault rules
 * (issue 1705, `unpauseRow` where `unpauseInStage13`): all three vaults deploy paused (issue 1710), so stage 13 is the three unpauses.
 */
export { BASKET_KEYS };
export const UNPAUSE_ROWS: readonly UnpauseRow[] = STAGE13_UNPAUSE_ROWS;
export type UnpauseRow = `unpause-${VaultKey}`;
/** Demonstrations of the Safe tool. They exist only as Twin-fork runs and are refused with USAGE on 8453. */
export const TWIN_ONLY_ROWS = ["update-delay", "batch", "cancel"] as const;
/** The govern rows in run order: every vault's unpause row (table order), then the Twin-only demonstrations. `--row` takes the 1-based number or the name. */
export const GOVERN_ROWS: readonly GovernRowName[] = [...VAULT_UNPAUSE_ROWS, ...TWIN_ONLY_ROWS];
export type GovernRowName = UnpauseRow | (typeof TWIN_ONLY_ROWS)[number];
/** A row that runGovern can plan: every matrix row. */
export type PlannedRow = GovernRowName;
export const governRowNames = (): readonly string[] => GOVERN_ROWS;
export const isTwinOnlyRow = (row: string): boolean => (TWIN_ONLY_ROWS as readonly string[]).includes(row);
/**
 * Issue 1727: update-delay, batch and cancel are refused on 8453 UNLESS the sheet is a rehearsal (DEPLOYMENT_KIND=rehearsal). Each is a no-op or a bounded delay
 * change through the real Safe and the real timelock, so a rehearsal exercises the Safe tool on real contracts. Production keeps them refused. On a rehearsal they
 * are explicit `--row` runs: stage 13 on 8453 stays the three unpauses, and the later rows keep their order (update-delay, batch, cancel) after the unpauses.
 */
export const twinOnlyRefused = (row: string, chainId: number, kind: DeploymentKind): boolean => isTwinOnlyRow(row) && chainId === BASE_CHAIN_ID && kind !== "rehearsal";
/**
 * The refusal of a `--row` on this chain and kind, or undefined. ONE place: the CLI applies it right after the floors, BEFORE any signer or passphrase prompt (review of PR 1728:
 * production keeps refusing update-delay, batch and cancel on 8453 without asking for a single passphrase), and runGovern applies it again.
 */
export function govRowRefusal(row: string | undefined, chainId: number, kind: DeploymentKind): string | undefined {
  if (row === REDEPLOY_ROW) return redeployRefusal(chainId, kind);
  if (row === undefined || row === RECEIPT_ROW || row === REGISTER_ROW || row === APPLY_ROW || row === CLEAR_ROW || row === RETIRE_ROW || row === UNWIND_GUARD_ROW || row === FREEZE_ROW || row === UPGRADE_ROW) return undefined;
  let name: string;
  try { name = resolveGovernRow(row); } catch { return undefined; } // an unknown row is a usage error raised where it always was
  return twinOnlyRefused(name, chainId, kind)
    ? `--row ${name} is a demonstration of the Safe tool: it runs on a Twin fork only and is refused on chain 8453 (the only mainnet govern stage operation is the vault unpause; the other mainnet actions are --row ${RECEIPT_ROW}, --row ${APPLY_ROW}, --row ${CLEAR_ROW} and --row ${UNWIND_GUARD_ROW}). A Base mainnet REHEARSAL (DEPLOYMENT_KIND=rehearsal in the sheet) may run it.`
    : undefined;
}

/** The rows a stage run needs on a chain: the unpauses on 8453, every row elsewhere. */
export const stageRows = (chainId: number): readonly GovernRowName[] => (chainId === BASE_CHAIN_ID ? UNPAUSE_ROWS : GOVERN_ROWS);
/**
 * Declared dependencies between rows (row to the row it must follow). The dependent operation carries the other's operation id as the timelock
 * predecessor, so both run in the same resume with no second wait. The unpauses are independent: none is declared.
 */
export const GOVERN_DEPENDENCIES: Readonly<Record<string, string>> = {};

/**
 * The on-demand row: release one consensus receipt. Not in GOVERN_ROWS (the ordered matrix): it needs a receipt id, runs any number of times
 * (once per receipt), and neither waits for nor completes the matrix. It is still one round through the real Safe and the real timelock.
 */
export const RECEIPT_ROW = "release-receipt";
const RECEIPT_ID = /^0x[0-9a-fA-F]{64}$/;

/** `--receipt-id` value check: a 0x-prefixed bytes32. */
export function assertReceiptId(id: string): Hex {
  if (!RECEIPT_ID.test(id)) throw new PublishError("USAGE", `--receipt-id must be a 0x-prefixed bytes32 (64 hex), got '${id}'`);
  return id.toLowerCase() as Hex;
}

/** The run-manifest key, salt input and description prefix of one receipt's release round. One receipt id is one operation. */
export const releaseRecordKey = (receiptId: Hex): string => `${RECEIPT_ROW}-${receiptId.toLowerCase()}`;

/** The one call of a release round: releaseReceipt(receiptId) on the deployed ConsensusRecommendationReceipt. */
export function buildReleaseCall(receipt: Address, receiptId: Hex): LabelledCall {
  return { label: `receipt.releaseReceipt(${receiptId})`, target: receipt, data: encodeFunctionData({ abi: RECEIPT_ABI, functionName: "releaseReceipt", args: [receiptId] }) };
}

/** The deployed ConsensusRecommendationReceipt, from the receipt stage manifest (field consensus_receipt). */
export const loadReceiptAddr = (ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): Address => readManifestField(ctx, receiptRef()) as Address;

// ---- Safe and timelock self-administration (issue 1645) --------------------------------------------------------------------

/** Safe self-administration: each is ONE Safe transaction to the Safe itself. */
export const SAFE_ADMIN_ROWS = ["safe-add-owner", "safe-remove-owner", "safe-swap-owner", "safe-change-threshold"] as const;
/** Timelock self-administration: each is a Safe -> Timelock round whose target is the timelock itself. The delay change is the existing `update-delay` row. */
export const TIMELOCK_ADMIN_ROWS = ["timelock-grant-role", "timelock-revoke-role"] as const;
/** On demand and Twin-only: not in GOVERN_ROWS, so no default run, stage run or numbered `--row` reaches them. */
export const SELF_ADMIN_ROWS = [...SAFE_ADMIN_ROWS, ...TIMELOCK_ADMIN_ROWS] as const;
export type SelfAdminRow = (typeof SELF_ADMIN_ROWS)[number];
export const isSelfAdminRow = (row: string): row is SelfAdminRow => (SELF_ADMIN_ROWS as readonly string[]).includes(row);

/** The arguments of a self-administration row. Each row names the ones it needs. */
export interface SelfAdminArgs {
  /** safe-add-owner: the owner to add. safe-remove-owner: the owner to remove. */
  owner?: string;
  /** safe-swap-owner: the owner to replace, and the owner that takes its place. */
  oldOwner?: string; newOwner?: string;
  /** safe-add-owner, safe-remove-owner, safe-change-threshold: the threshold after the change. */
  threshold?: number | string;
  /** timelock-grant-role, timelock-revoke-role: the role name (PROPOSER_ROLE, EXECUTOR_ROLE or CANCELLER_ROLE) and the account. */
  role?: string; account?: string;
}

/** The Safe functions that change what can act as the Safe. No row builds them: the Safe accepts a well-formed call from two owners at once, outside the timelock. */
const REFUSED_SAFE_CONFIG = ["enableModule", "disableModule", "setGuard", "setModuleGuard", "setFallbackHandler"] as const;
const SAFE_CONFIG_ABI = parseAbi([
  "function enableModule(address module)", "function disableModule(address prevModule, address module)", "function setGuard(address guard)",
  "function setModuleGuard(address moduleGuard)", "function setFallbackHandler(address handler)",
]);
/** Throws USAGE when `data` is a Safe module, guard or fallback-handler change. Every self-administration call passes through here before it is proposed. */
export function refuseSafeConfigChange(data: Hex): void {
  let fn: string | undefined;
  try { fn = decodeFunctionData({ abi: SAFE_CONFIG_ABI, data }).functionName; } catch { /* not one of them */ }
  if (fn && (REFUSED_SAFE_CONFIG as readonly string[]).includes(fn)) {
    throw new PublishError("USAGE", `${fn} is refused: a Safe module, guard or fallback-handler change is not a govern row. The Safe contract would accept it from two owners at once, so the verifier (no module, no guard, the canonical fallback handler) is the only check`, { function: fn });
  }
}

/** Twin-only gate for the self-administration rows (owner question 2, default (a)). Called before the Safe is read or anything is sent. */
export function assertSelfAdminAllowed(chainId: number, row: string): void {
  if (chainId === BASE_CHAIN_ID) throw new PublishError("USAGE", `--row ${row} is Safe or timelock self-administration: it runs on a Twin fork only and is refused on chain 8453 until the owner decides otherwise (issue 1645)`, { row });
}

/** The deployed timelock is a ProposerFloorTimelock (contracts/ProposerFloorTimelock.sol): it counts PROPOSER_ROLE holders and reverts a revoke or renounce of the last one. */
const PROPOSER_FLOOR_ABI = parseAbi(["function proposerCount() view returns (uint256)"]);
/**
 * Owner question 1 of issue 1645, default (b), and QA plan v1 B3 (CS-3): the Safe gives up PROPOSER_ROLE through the delay and never as the last holder. The contract
 * floors it (LastProposerFloor at execute, after the Safe transaction and the delay); the tool refuses the same revoke before anything is sent. Any other role, and
 * any account that does not hold PROPOSER_ROLE, passes through: the chain decides those.
 */
export async function assertNotLastProposer(rd: Rd, timelock: Address, role: Hex, account: Address): Promise<void> {
  if (role.toLowerCase() !== roleId("PROPOSER_ROLE").toLowerCase()) return;
  if (!(await rd<boolean>(timelock, ROLE_ABI, "hasRole", [role, account]))) return;
  const count = await rd<bigint>(timelock, PROPOSER_FLOOR_ABI, "proposerCount");
  if (count === 1n) {
    throw new PublishError("GOVERN", `--row timelock-revoke-role PROPOSER_ROLE ${account}: it is the last proposer, and the timelock (ProposerFloorTimelock) reverts the revoke with LastProposerFloor at execute. Nothing is scheduled. Grant PROPOSER_ROLE to another account first (--row timelock-grant-role), then revoke this one`, { row: "timelock-revoke-role", account, proposer_count: 1 });
  }
}

const need = (v: string | undefined, row: string, flag: string): string => {
  if (v === undefined) throw new PublishError("USAGE", `--row ${row} needs ${flag}`, { row });
  return v;
};
const addrArg = (v: string | undefined, row: string, flag: string): Address => {
  const s = need(v, row, flag);
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new PublishError("USAGE", `${flag} must be an address, got '${s}'`, { row });
  return getAddress(s);
};
const thresholdArg = (v: number | string | undefined, row: string): bigint => {
  const s = need(v === undefined ? undefined : String(v), row, "--admin-arg threshold=N");
  if (!/^[1-9][0-9]*$/.test(s)) throw new PublishError("USAGE", `threshold must be a positive integer, got '${s}'`, { row });
  return BigInt(s);
};

/** The Safe's linked-list head marker (`SENTINEL_OWNERS` in OwnerManager): the predecessor of the first owner, and never an owner itself. */
export const SAFE_SENTINEL_OWNER = "0x0000000000000000000000000000000000000001" as Address;

/**
 * The arguments of a Safe self-administration row, parsed and checksummed (USAGE on bad input). This is what the row wants and what its read-back
 * checks (safeAdminEffect): the sheet is not consulted, because the row's purpose is to make the sheet's SAFE_OWNERS / SAFE_THRESHOLD stale. The
 * predecessor the Safe's linked list needs (`prevOwner`) is chain state, not an argument: buildSelfAdminCall reads it from the live owner list.
 */
export type SafeAdminWant =
  | { row: "safe-add-owner"; owner: Address; threshold: bigint }
  | { row: "safe-remove-owner"; owner: Address; threshold: bigint }
  | { row: "safe-swap-owner"; oldOwner: Address; newOwner: Address }
  | { row: "safe-change-threshold"; threshold: bigint };
export type SafeAdminRow = (typeof SAFE_ADMIN_ROWS)[number];
export type TimelockAdminRow = (typeof TIMELOCK_ADMIN_ROWS)[number];
export const isSafeAdminRow = (row: string): row is SafeAdminRow => (SAFE_ADMIN_ROWS as readonly string[]).includes(row);

export function parseSafeAdminArgs(row: SafeAdminRow, args: SelfAdminArgs): SafeAdminWant {
  switch (row) {
    case "safe-add-owner": return { row, owner: addrArg(args.owner, row, "--admin-arg owner=0x.."), threshold: thresholdArg(args.threshold, row) };
    case "safe-remove-owner": return { row, owner: addrArg(args.owner, row, "--admin-arg owner=0x.."), threshold: thresholdArg(args.threshold, row) };
    case "safe-swap-owner": return { row, oldOwner: addrArg(args.oldOwner, row, "--admin-arg old-owner=0x.."), newOwner: addrArg(args.newOwner, row, "--admin-arg new-owner=0x..") };
    case "safe-change-threshold": return { row, threshold: thresholdArg(args.threshold, row) };
  }
}

/** The stable text of what a self-administration row wants (lower-case addresses): the run manifest keeps it per record so a rerun can find the record of the same change. */
export function selfAdminWantKey(want: SafeAdminWant | { row: TimelockAdminRow; role: Hex; account: Address }): string {
  const lc = (x: string) => x.toLowerCase();
  switch (want.row) {
    case "safe-add-owner": case "safe-remove-owner": return `${want.row}:${lc(want.owner)}:${want.threshold}`;
    case "safe-swap-owner": return `${want.row}:${lc(want.oldOwner)}:${lc(want.newOwner)}`;
    case "safe-change-threshold": return `${want.row}:${want.threshold}`;
    case "timelock-grant-role": case "timelock-revoke-role": return `${want.row}:${lc(want.role)}:${lc(want.account)}`;
  }
}

/** The state a Safe self-administration row leaves behind, in words (log lines and refusals). */
export function describeSafeAdminWant(want: SafeAdminWant): string {
  switch (want.row) {
    case "safe-add-owner": return `${want.owner} is an owner and the threshold is ${want.threshold}`;
    case "safe-remove-owner": return `${want.owner} is not an owner and the threshold is ${want.threshold}`;
    case "safe-swap-owner": return `${want.newOwner} is an owner in place of ${want.oldOwner}`;
    case "safe-change-threshold": return `the threshold is ${want.threshold}`;
  }
}

/** The Safe's owner list and threshold as the chain reports them (getOwners, getThreshold). */
export interface SafeRoster { owners: readonly Address[]; threshold: bigint }

/**
 * The read-back of a Safe self-administration row against its own arguments: what the live roster says about the owner change and about the threshold.
 * Both true: the change is in effect (a rerun sends nothing). Before the send the same reading decides whether there is anything to send.
 */
export function safeAdminEffect(want: SafeAdminWant, live: SafeRoster): { owner: boolean; threshold: boolean; problems: string[] } {
  const has = (x: string) => live.owners.some((y) => y.toLowerCase() === x.toLowerCase());
  const problems: string[] = [];
  let owner = true, threshold = true;
  switch (want.row) {
    case "safe-add-owner": owner = has(want.owner); if (!owner) problems.push(`${want.owner} is not an owner`); break;
    case "safe-remove-owner": owner = !has(want.owner); if (!owner) problems.push(`${want.owner} is still an owner`); break;
    case "safe-swap-owner": owner = !has(want.oldOwner) && has(want.newOwner); if (!owner) problems.push(`the swap ${want.oldOwner} -> ${want.newOwner} is not in effect`); break;
    case "safe-change-threshold": break;
  }
  if ("threshold" in want) { threshold = live.threshold === want.threshold; if (!threshold) problems.push(`getThreshold is ${live.threshold}, want ${want.threshold}`); }
  return { owner, threshold, problems };
}

/**
 * The rules the Safe contract (OwnerManager) enforces on the change, checked here so a transaction the Safe would revert is never proposed or signed:
 * GS201 (threshold above the owner count after the change), GS203 (the zero address, the sentinel or the Safe itself as an owner), GS204 (already an owner).
 * Returns the problem, or undefined when the Safe would accept the call.
 */
export function safeRuleProblem(want: SafeAdminWant, live: SafeRoster, safe: Address): string | undefined {
  const has = (x: string) => live.owners.some((y) => y.toLowerCase() === x.toLowerCase());
  const invalid = (x: Address) => x.toLowerCase() === "0x0000000000000000000000000000000000000000" || x.toLowerCase() === SAFE_SENTINEL_OWNER.toLowerCase() || x.toLowerCase() === safe.toLowerCase();
  const n = BigInt(live.owners.length);
  switch (want.row) {
    case "safe-add-owner":
      if (invalid(want.owner)) return `${want.owner} cannot be an owner (GS203)`;
      if (has(want.owner)) return `${want.owner} is already an owner (GS204)`;
      if (want.threshold > n + 1n) return `threshold ${want.threshold} is above the owner count after the change (${n + 1n}) (GS201)`;
      return undefined;
    case "safe-remove-owner":
      if (want.threshold > n - 1n) return `threshold ${want.threshold} is above the owner count after the change (${n - 1n}) (GS201)`;
      return undefined;
    case "safe-swap-owner":
      if (invalid(want.newOwner)) return `${want.newOwner} cannot be an owner (GS203)`;
      if (has(want.newOwner)) return `${want.newOwner} is already an owner (GS204)`;
      return undefined;
    case "safe-change-threshold":
      if (want.threshold > n) return `threshold ${want.threshold} is above the owner count (${n}) (GS201)`;
      return undefined;
  }
}

/**
 * The live Safe roster against the sheet's SAFE_OWNERS and SAFE_THRESHOLD: the differences found, an empty list is a match. Every govern row but the
 * self-administration rows refuses on a difference; after a self-administration row the operator updates the sheet (runbook section 9).
 */
export function sheetRosterProblems(live: { owners: readonly string[]; threshold: number | bigint }, sheet: Pick<Sheet, "safeOwners" | "safeThreshold">): string[] {
  const sorted = (xs: readonly string[]) => xs.map((x) => x.toLowerCase()).sort().join(",");
  const bad: string[] = [];
  if (sorted(live.owners) !== sorted(sheet.safeOwners)) bad.push(`owners on chain ${sorted(live.owners)}, sheet SAFE_OWNERS ${sorted(sheet.safeOwners)}`);
  if (BigInt(live.threshold) !== BigInt(sheet.safeThreshold)) bad.push(`threshold on chain ${live.threshold}, sheet SAFE_THRESHOLD ${sheet.safeThreshold}`);
  return bad;
}

/** The one call of a self-administration row. `owners` is the Safe's owner list on chain (for the predecessor the Safe's linked list needs). */
export function buildSelfAdminCall(row: SelfAdminRow, a: Pick<GovernAddrs, "safe" | "timelock">, args: SelfAdminArgs, owners: readonly Address[]): LabelledCall {
  const prevOf = (o: Address): Address => {
    const i = owners.findIndex((x) => x.toLowerCase() === o.toLowerCase());
    if (i < 0) throw new PublishError("USAGE", `${o} is not an owner of the Safe`, { row });
    return i === 0 ? SAFE_SENTINEL_OWNER : owners[i - 1]!;
  };
  let call: LabelledCall;
  switch (row) {
    case "safe-add-owner": {
      const w = parseSafeAdminArgs(row, args) as Extract<SafeAdminWant, { row: "safe-add-owner" }>;
      call = { label: `safe.addOwnerWithThreshold(${w.owner}, ${w.threshold})`, target: a.safe, data: encodeFunctionData({ abi: SAFE_ADMIN_ABI, functionName: "addOwnerWithThreshold", args: [w.owner, w.threshold] }) };
      break;
    }
    case "safe-remove-owner": {
      const w = parseSafeAdminArgs(row, args) as Extract<SafeAdminWant, { row: "safe-remove-owner" }>;
      call = { label: `safe.removeOwner(${w.owner}, ${w.threshold})`, target: a.safe, data: encodeFunctionData({ abi: SAFE_ADMIN_ABI, functionName: "removeOwner", args: [prevOf(w.owner), w.owner, w.threshold] }) };
      break;
    }
    case "safe-swap-owner": {
      const w = parseSafeAdminArgs(row, args) as Extract<SafeAdminWant, { row: "safe-swap-owner" }>;
      call = { label: `safe.swapOwner(${w.oldOwner} -> ${w.newOwner})`, target: a.safe, data: encodeFunctionData({ abi: SAFE_ADMIN_ABI, functionName: "swapOwner", args: [prevOf(w.oldOwner), w.oldOwner, w.newOwner] }) };
      break;
    }
    case "safe-change-threshold": {
      const w = parseSafeAdminArgs(row, args) as Extract<SafeAdminWant, { row: "safe-change-threshold" }>;
      call = { label: `safe.changeThreshold(${w.threshold})`, target: a.safe, data: encodeFunctionData({ abi: SAFE_ADMIN_ABI, functionName: "changeThreshold", args: [w.threshold] }) };
      break;
    }
    case "timelock-grant-role":
    case "timelock-revoke-role": {
      const roleName = need(args.role, row, "--admin-arg role=PROPOSER_ROLE|EXECUTOR_ROLE|CANCELLER_ROLE");
      if (!(TIMELOCK_ROLES as readonly string[]).includes(roleName)) throw new PublishError("USAGE", `role must be one of ${TIMELOCK_ROLES.join(", ")}, got '${roleName}'`, { row });
      const account = addrArg(args.account, row, "--admin-arg account=0x..");
      const fn = row === "timelock-grant-role" ? "grantRole" : "revokeRole";
      call = { label: `timelock.${fn}(${roleName}, ${account})`, target: a.timelock, data: encodeFunctionData({ abi: ROLE_ABI, functionName: fn, args: [roleId(roleName as (typeof TIMELOCK_ROLES)[number]), account] }) };
      break;
    }
  }
  refuseSafeConfigChange(call.data);
  return call;
}

/**
 * The run-manifest key of a self-administration record: the row, the calldata and the Safe nonce the transaction was proposed at (issue 1645, QA plan v1 B4).
 * One row name serves many different changes (the calldata), and the same change can be made again after it was undone (add X, remove X, add X: the nonce),
 * so no later change ever adopts an earlier record and reprints it unsent. A rerun of a change still in effect finds its record by `selfAdminWantKey`.
 */
export const selfAdminRecordKey = (row: SelfAdminRow, data: Hex, nonce: number): string => `${row}-${keccak256(data).slice(2, 10)}-n${nonce}`;

/** `--row` value to a row name: a 1-based number or a name. Anything else is a usage error. */
export function resolveGovernRow(row: string): PlannedRow {
  if (row === RECEIPT_ROW) throw new PublishError("USAGE", `--row ${RECEIPT_ROW} is the on-demand receipt release: it needs --receipt-id 0x<bytes32>`);
  if (row === REGISTER_ROW) throw new PublishError("USAGE", `--row ${REGISTER_ROW} is the on-demand receipt submitter registration (one delayed receipt.grantRole): it needs --submitter 0x<the submitter Safe>`);
  if (row === APPLY_ROW) throw new PublishError("USAGE", `--row ${APPLY_ROW} is the on-demand receipt application: it needs --receipt-id 0x<bytes32> and --payload FILE`);
  if (row === CLEAR_ROW) throw new PublishError("USAGE", `--row ${CLEAR_ROW} is the on-demand clear of the router's voted weight vector: it is run by name only (runGovern)`);
  if (row === REDEPLOY_ROW) throw new PublishError("USAGE", `--row ${REDEPLOY_ROW} is the on-demand replacement of one redeployed vault: it is run by name only (runGovern)`);
  if (row === RETIRE_ROW) throw new PublishError("USAGE", `--row ${RETIRE_ROW} is the on-demand retirement of one vault (ADR-0017): it needs --admin-arg vault=0x<address> and --admin-arg weights=USDC:9500,PROTO:500,RWA:0`);
  if (row === UNWIND_GUARD_ROW) throw new PublishError("USAGE", `--row ${UNWIND_GUARD_ROW} is the on-demand emergency unwind guard of one basket vault: it needs --admin-arg vault=PROTO|RWA token=0x..|all min-usdc-out=N max-loss-bps=N`);
  if (row === FREEZE_ROW) throw new PublishError("USAGE", `--row ${FREEZE_ROW} is the on-demand freeze of every core proxy (issue 1842): it is run by name only (runGovern)`);
  if (row === UPGRADE_ROW) throw new PublishError("USAGE", `--row ${UPGRADE_ROW} is the on-demand governed upgrade of one core proxy (issue 1842): it needs --proxy NAME --implementation 0x<address>`);
  if (/^[0-9]+$/.test(row)) {
    const n = Number(row);
    const name = GOVERN_ROWS[n - 1];
    if (name === undefined) throw new PublishError("USAGE", `--row ${row}: there are ${GOVERN_ROWS.length} govern rows (1 to ${GOVERN_ROWS.length})`);
    return name;
  }
  if ((GOVERN_ROWS as readonly string[]).includes(row)) return row as GovernRowName;
  throw new PublishError("USAGE", `unknown govern row '${row}' (${GOVERN_ROWS.join(", ")}, or 1 to ${GOVERN_ROWS.length}; on demand: ${RECEIPT_ROW} --receipt-id 0x<bytes32>, ${APPLY_ROW} --receipt-id 0x<bytes32> --payload FILE, ${CLEAR_ROW}, ${UNWIND_GUARD_ROW} --admin-arg K=V)`);
}

/** The calls of one unpause row. Empty means the sheet does not ask for it (the vault stays paused): the row is skipped. */
export function buildStepCalls(sheet: Sheet, a: GovernAddrs, row: PlannedRow): LabelledCall[] {
  const calls: LabelledCall[] = [];
  if (row.startsWith("unpause-")) {
    const k = row.slice("unpause-".length) as VaultKey;
    if (sheet.govern.unpauseVaults.includes(k)) calls.push({ label: `${VAULT_NAME[k]}.unpauseDeposits`, target: a.vaults[k], data: encodeFunctionData({ abi: VAULT_ABI, functionName: "unpauseDeposits" }) });
  }
  return calls;
}

export const governSalt = (coreSha: string, chainId: number, label: string): Hex => keccak256(toBytes(`publish-contracts:govern:${coreSha}:${chainId}:${label}`));

/** The salt label and manifest archive key of round `round` of an unpause row. Round 1 and round 2 are two different timelock operations. */
export const roundKey = (row: string, round: number): string => `${row}:round-${round}`;

// ---- Safe API (injectable) ------------------------------------------------------------------------------------------------

export interface GovernApi {
  connectSafe: typeof connectSafe;
  scheduleOnTimelock: typeof scheduleOnTimelock;
  executeOnTimelock: typeof executeOnTimelock;
  cancelOnTimelock: typeof cancelOnTimelock;
  updateTimelockDelay: typeof updateTimelockDelay;
  operationId: typeof operationId;
  operationState: typeof operationState;
  timelockMinDelay: typeof timelockMinDelay;
  signTx: typeof signTx;
  executeTx: typeof executeTx;
  verifyTimelockEffect: typeof verifyTimelockEffect;
  /** Issue 1750: what the --submitter is on chain. `null`: no code (a single key). A contract that is not a canonical SafeL2 1.4.1 multisig throws USAGE. Reads only. */
  inspectSubmitter: (handle: SafeHandle, submitter: Address, forbidden: ReadonlyMap<string, string>) => Promise<SubmitterSafeInfo | null>;
  /** Safe self-administration only (issue 1645). Absent in a test world that does not exercise it: the real one is used. */
  proposeTx?: typeof proposeTx;
  /** Issue 1842: every call scheduled on the timelock from `fromBlock` (CallScheduled logs), for the freeze row's pending-upgrade refusal. Absent: the real log scan. */
  scheduledCalls?: (handle: SafeHandle, timelock: Address, fromBlock: bigint) => Promise<{ id: Hex; target: Address; data: Hex }[]>;
  /**
   * Issue 1859: the transaction of the timelock's first CallScheduled or CallExecuted log of operation `id` from `fromBlock`, undefined when there is none. The freeze and upgrade
   * rows read it when the phase was adopted from the chain (an earlier run crashed after the send, or another signer executed through the Safe UI). Absent: the real log scan.
   */
  operationTx?: (handle: SafeHandle, timelock: Address, id: Hex, event: TimelockEvent, fromBlock: bigint) => Promise<Hex | undefined>;
}

const CALL_SCHEDULED = parseAbiItem("event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)");
/** The timelock's CallScheduled logs from `fromBlock` to the head, in 2000-block chunks (the public Base RPC's cap). A failed chunk throws: none is read as "no calls". */
export async function scanScheduledCalls(handle: SafeHandle, timelock: Address, fromBlock: bigint): Promise<{ id: Hex; target: Address; data: Hex }[]> {
  const head = await handle.client.getBlockNumber();
  const out: { id: Hex; target: Address; data: Hex }[] = [];
  for (let lo = fromBlock; lo <= head; lo += 2000n) {
    const hi = lo + 1999n < head ? lo + 1999n : head;
    for (const l of await handle.client.getLogs({ address: timelock, event: CALL_SCHEDULED, fromBlock: lo, toBlock: hi })) out.push({ id: l.args.id!, target: l.args.target!, data: l.args.data! });
  }
  return out;
}
export type TimelockEvent = "CallScheduled" | "CallExecuted";
const CALL_EXECUTED = parseAbiItem("event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)");
/** Issue 1859: the transaction of the first `event` log of operation `id` on the timelock from `fromBlock` to the head, in 2000-block chunks. A failed chunk throws: none is read as "no log". */
export async function scanOperationTx(handle: SafeHandle, timelock: Address, id: Hex, event: TimelockEvent, fromBlock: bigint): Promise<Hex | undefined> {
  const head = await handle.client.getBlockNumber();
  for (let lo = fromBlock; lo <= head; lo += 2000n) {
    const hi = lo + 1999n < head ? lo + 1999n : head;
    const logs = event === "CallExecuted"
      ? await handle.client.getLogs({ address: timelock, event: CALL_EXECUTED, args: { id }, fromBlock: lo, toBlock: hi })
      : await handle.client.getLogs({ address: timelock, event: CALL_SCHEDULED, args: { id }, fromBlock: lo, toBlock: hi });
    if (logs[0]?.transactionHash) return logs[0].transactionHash;
  }
  return undefined;
}
export const realGovernApi: GovernApi = { connectSafe, scheduleOnTimelock, executeOnTimelock, cancelOnTimelock, updateTimelockDelay, operationId, operationState, timelockMinDelay, signTx, executeTx, verifyTimelockEffect, proposeTx, scheduledCalls: scanScheduledCalls, operationTx: scanOperationTx,
  inspectSubmitter: (handle, submitter, forbidden) => inspectSubmitterSafe(chainFromClient(handle.client as never), submitter, forbidden) };

export type GovernPhase = "scheduled" | "executed" | "cancelled";

/** One stdout line per round event, the contract core's harness parses: {"row":"..","phase":"scheduled","txHash":"0x..","status":1,"readyAt":1700000000}. */
export interface GovernRowLine { row: string; phase: GovernPhase; txHash: string; status: 0 | 1; readyAt: number }

export interface GovernOpts {
  /** With --row register-submitter only (issue 1888): the submitter Safe's address. */
  submitter?: string;
  ownerSigners: Signer[];
  /** Pays gas for execTransaction. Holds no role. */
  sender: Signer;
  api?: GovernApi;
  /** Longest wait this process accepts for a timelock delay, in seconds (default 3600, and never more than 3600 on 8453). Longer: exit GOVERN_PENDING. */
  maxWaitSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /**
   * Moves chain time forward by this many seconds. Default: on a Twin fork only (eth_chainId is not 8453 and the RPC answers anvil_nodeInfo)
   * the anvil time warp, so the 48 hour waits run in seconds. On Base mainnet there is no warp: the run exits GOVERN_PENDING.
   * `false` turns the warp off (tests with a stub chain).
   */
  warp?: ((seconds: bigint) => Promise<void>) | false;
  /** Run one row only, by number or name. A Twin-only row needs the rows before it done first. `release-receipt` and `apply-receipt` (with `receiptId`) are on demand. */
  row?: string;
  /** Declared dependencies (row to the row it follows), default GOVERN_DEPENDENCIES. The dependent carries the other's operation id as predecessor. */
  dependsOn?: Readonly<Record<string, string>>;
  /** With row `release-receipt` or `apply-receipt`: the bytes32 receipt id. */
  receiptId?: string;
  /** With row `apply-receipt` only: the receipt payload file. Its receipt digest (receipt-digest.ts) must equal the digest the receipt stored on chain. */
  payload?: string;
  /** Where a row line goes. Default: stdout (console.log). */
  emit?: (line: string) => void;
  /**
   * Twin chain only: one generic Safe -> Timelock call (schedule, real delay by warp, execute) instead of a govern row. Test fixtures use it for
   * actions that are not mainnet govern rows (gateway unpause, agent revoke or authorize). Refused on chain 8453. Not combined with `row`.
   */
  call?: TwinCall;
  /** With a self-administration row (`--row safe-add-owner` and the others): the arguments of that row. Twin chain only. */
  selfAdmin?: SelfAdminArgs;
  /** With `--row set-unwind-guard` only (QA plan v1 D7): the vault, the token (or `all`) and the guard values, as `--admin-arg` gave them. */
  unwindGuard?: UnwindGuardArgs;
  /** With `--row retire-vault` only (issue 1912): the vault to retire and the three-leg default vector that stays, as `--admin-arg` gave them. */
  retire?: RetireArgs;
  /** With `--row upgrade-proxy` only (issue 1842): the verifier name of the proxy (gateway, registry, vault[rmUSDC], ...) and the new implementation's address. */
  proxy?: string;
  implementation?: string;
  /**
   * With `--row upgrade-proxy` only: a core checkout at the commit the new implementation was built from, after `forge build` (its out/ and its storage-layout snapshots).
   * Absent: the DEPLOY_SHA checkout itself (a new copy of the release implementation, as the Twin rehearsal deploys).
   */
  upgradeBuild?: string;
  /**
   * With `--row upgrade-proxy` only (issue 1910): the name of a typed migration (UPGRADE_MIGRATIONS) run in the same upgradeToAndCall. The tool builds the data from the build ABI
   * and the deployment's manifest. There is no raw data option.
   */
  migration?: string;
}

/** One generic timelock call, named by `label` (the manifest key, the salt input and the `row` of the output lines). */
export interface TwinCall { label: string; target: Address; data: Hex }

interface PhaseRecord { seq?: number; tx_hash?: string; safe_tx_hash?: string; status?: number; at: string; operation_id?: string; ready_at?: string; note?: string; [k: string]: unknown }
/** A self-administration record's identity (issue 1645, QA plan v1 B4): the calldata sent (none for a skip), the Safe nonce it was proposed at, and the row's arguments as `selfAdminWantKey` spells them. */
export interface SelfAdminRecord { data?: Hex; nonce: number; want: string }
/** `guard` (QA plan v1 D7): what a set-unwind-guard round sets, written before its schedule so a resume and the evidence entry name the same values. */
export interface GuardRecord { vault: string; vault_address: string; tokens: string[]; min_usdc_out: string; override_allowed: boolean; max_loss_bps: number }
/** What the run manifest keeps per row. A row is complete when it is skipped, executed or (for cancel) cancelled. */
export interface RowRecord { round?: number; admin?: SelfAdminRecord; guard?: GuardRecord; apply?: { vaults: string[]; bps: number[]; payload_digest: string }; observed?: { voted_weights_active: boolean; effective_vaults: string[]; effective_bps: number[] }; skipped?: { at: string; reason: string }; scheduled?: PhaseRecord; executed?: PhaseRecord; cancelled?: PhaseRecord }
type GovernState = Record<string, RowRecord>;
/** The `register` part of a register-submitter record: what the grant was built from, and the submitter Safe's facts. */
interface RegisterState { submitter: string; receipt: string; submitter_safe: SubmitterSafeEvidence }

const rowComplete = (r: RowRecord | undefined): boolean => !!r && !!(r.skipped || r.executed || r.cancelled);

async function chainTime(handle: SafeHandle): Promise<bigint> {
  return (await handle.client.getBlock({ blockTag: "latest" })).timestamp;
}

async function signAndExecute(ctx: RunContext, o: GovernOpts, api: GovernApi, handle: SafeHandle, bundle: SafeTxBundle): Promise<SafeTxBundle> {
  let b = bundle;
  const owners = new Set(handle.owners.map((x) => x.toLowerCase()));
  let signed = 0;
  for (const s of o.ownerSigners) {
    if (signed >= handle.threshold) break;
    const who = (await s.address()).toLowerCase();
    if (!owners.has(who)) continue;
    b = await api.signTx(handle, b, s);
    signed++;
  }
  if (signed < handle.threshold) throw new PublishError("GOVERN", `only ${signed} of the ${handle.threshold} required Safe owner signers are available: pass --owner-signer for each`, { have: signed, need: handle.threshold });
  const res = await api.executeTx(handle, b, o.sender);
  ctx.log.log("info", "govern.safe_tx", { action: b.action, tx_hash: res.txHash, safe_tx_hash: b.safe_tx_hash, nonce: b.nonce });
  return res.bundle;
}

/** The warp to use for a wait: the injected one, else the anvil warp when the RPC is a Twin fork, else none (Base mainnet never warps). */
async function warpFor(ctx: RunContext, o: GovernOpts): Promise<((seconds: bigint) => Promise<void>) | undefined> {
  if (ctx.chainId === BASE_CHAIN_ID) return undefined;
  if (o.warp === false) return undefined;
  if (o.warp) return o.warp;
  const rpc = httpRpc(ctx.rpc);
  let twin = detected.get(ctx);
  if (twin === undefined) { twin = await isTwinFork(rpc); detected.set(ctx, twin); }
  return twin ? async (s) => { await warpBy(rpc, s); } : undefined;
}
const detected = new WeakMap<object, boolean>();

/**
 * The exact command that resumes a pending run. Arguments that carry no secret are spelled out, the rest are the same as this run's. No row: the whole stage.
 * `guard`: the arguments of a set-unwind-guard run (QA plan v1 D7), spelled out as its `--admin-arg` flags.
 * Security round 1 (review-security-033): the evidence dir is spelled out as an absolute path. It holds the run manifest and its pause-all entries (issue 1686); the default
 * is relative to the working directory, so a resume from another shell directory used to start a fresh manifest that knew no pause. The counts flags are named too when the
 * run has them: on 8453 the release gate of the resume needs them.
 */
export function resumeCommand(ctx: Pick<RunContext, "chainId" | "coreSha"> & { evidenceDir?: string; countsDir?: string; countsRequireOriginDev?: boolean }, row?: string, payload?: string, guard?: UnwindGuardWant): string {
  const selfAdmin = row === undefined ? undefined : SELF_ADMIN_ROWS.find((r) => row!.startsWith(`${r}-`));
  const same = "--admin-arg K=V (the same --admin-arg values as this run)";
  if (row?.startsWith(`${UNWIND_GUARD_ROW}-`)) row = `${UNWIND_GUARD_ROW} ${guard ? unwindGuardArgsText(guard) : same}`;
  else if (row?.startsWith(`${RECEIPT_ROW}-`)) row = `${RECEIPT_ROW} --receipt-id ${row.slice(RECEIPT_ROW.length + 1)}`;
  else if (row?.startsWith(`${REGISTER_ROW}-`)) row = `${REGISTER_ROW} --submitter ${row.slice(REGISTER_ROW.length + 1)}`;
  else if (row?.startsWith(`${REDEPLOY_ROW}-`)) row = REDEPLOY_ROW;
  else if (row?.startsWith(`${RETIRE_ROW}-`)) row = `${RETIRE_ROW} ${same}`;
  else if (row?.startsWith(`${APPLY_ROW}-`)) row = `${APPLY_ROW} --receipt-id ${row.slice(APPLY_ROW.length + 1)}${payload === undefined ? " --payload FILE" : ` --payload ${payload}`}`;
  else if (selfAdmin !== undefined) row = `${selfAdmin} ${same}`; // the record key carries the calldata hash and the Safe nonce, not the arguments
  const evidence = ctx.evidenceDir ? ` --evidence ${resolve(ctx.evidenceDir)}` : " --evidence DIR (this run's own evidence directory)";
  const counts = `${ctx.countsDir ? ` --counts-dir ${resolve(ctx.countsDir)}` : ""}${ctx.countsRequireOriginDev ? " --counts-require-origin-dev" : ""}`;
  return `bun publish-contracts/src/cli.ts govern${row === undefined ? "" : ` --row ${row}`} --chain ${ctx.chainId} --core-sha ${ctx.coreSha}${evidence}${counts} (plus the same --rpc, --sheet, --signer, --environment${ctx.countsDir ? "" : ", --counts-dir"} and --owner-signer arguments as this run)`;
}

/**
 * Waits until every operation is ready (or done), with ONE wait for the whole set: on a Twin fork one warp to one second past the latest ready
 * time, on 8453 the run exits GOVERN_PENDING once with that latest ready time. `resumeRow` is the `--row` of the resume command (none: the stage).
 */
async function waitReady(ctx: RunContext, o: GovernOpts, api: GovernApi, handle: SafeHandle, timelock: Address, ops: { id: Hex; row: string }[], resumeRow?: string, resumePayload?: string): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = ctx.chainId === BASE_CHAIN_ID ? Math.min(o.maxWaitSeconds ?? 3600, 3600) : (o.maxWaitSeconds ?? 3600);
  for (;;) {
    let latest = 0n;
    for (const op of ops) {
      const st = await api.operationState(handle, timelock, op.id);
      if (st.ready || st.done) continue;
      if (!st.pending) throw new PublishError("GOVERN", `operation ${op.id} (${op.row}) is not pending: it was cancelled or never scheduled${op.row.startsWith("unpause-") ? `. If it was cancelled through the Safe, open a fresh round: ${resumeCommand(ctx, op.row)}` : ""}`, { id: op.id });
      if (st.readyAt > latest) latest = st.readyAt;
    }
    if (latest === 0n) return;
    const remaining = Number(latest - (await chainTime(handle)));
    const rows = ops.map((x) => x.row);
    const warp = remaining > 0 ? await warpFor(ctx, o) : undefined;
    if (warp) {
      const seconds = remaining + 1;
      await warp(BigInt(seconds));
      ctx.log.log("info", "govern.warped", { rows, seconds });
      continue;
    }
    if (remaining > maxWait) {
      const guard = resumeRow?.startsWith(`${UNWIND_GUARD_ROW}-`) && o.unwindGuard !== undefined ? parseUnwindGuardArgs(o.unwindGuard) : undefined;
      const next = resumeCommand(ctx, resumeRow, resumePayload, guard);
      const what = rows.length === 1 ? `govern row ${rows[0]} is scheduled` : `govern rows ${rows.join(", ")} are scheduled`;
      throw new PublishError("GOVERN_PENDING", `${what} and become${rows.length === 1 ? "s" : ""} ready at ${latest} (${new Date(Number(latest) * 1000).toISOString()}, in about ${remaining} s). After that time run: ${next}`,
        { ids: ops.map((x) => x.id), row: rows[0], rows, ready_at: latest.toString(), remaining, next_command: next });
    }
    ctx.log.log("info", "govern.waiting", { rows, remaining_s: remaining });
    await sleep(o.pollMs ?? 5000);
  }
}

/** Prints the line of a phase that sent a Safe transaction. A phase adopted from the chain (no transaction of its own) prints none. */
function emitPhase(o: GovernOpts, row: string, phase: GovernPhase, rec: PhaseRecord): void {
  if (!rec.tx_hash) return;
  // executeTx throws on a reverted receipt, so a recorded transaction (even one from an earlier run) has status 1 unless the record says otherwise
  const line: GovernRowLine = { row, phase, txHash: rec.tx_hash, status: rec.status === 0 ? 0 : 1, readyAt: Number(rec.ready_at ?? 0) };
  (o.emit ?? ((l: string) => console.log(l)))(JSON.stringify(line));
}

type Rd = <T>(address: Address, abi: readonly unknown[], functionName: string, args?: unknown[]) => Promise<T>;
const reader = (handle: SafeHandle): Rd => (address, abi, functionName, args = []) =>
  handle.client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<never>;

/** Read-back of one unpause row: the problems found on chain after the round executed. An empty list is a pass. */
export async function readBackStep(handle: SafeHandle, a: GovernAddrs, row: PlannedRow): Promise<string[]> {
  const bad: string[] = [];
  const rd = reader(handle);
  if (row.startsWith("unpause-")) {
    const k = row.slice("unpause-".length) as VaultKey;
    if (await rd<boolean>(a.vaults[k], VAULT_ABI, "depositsPaused")) bad.push(`${VAULT_NAME[k]}.depositsPaused`);
  }
  return bad;
}

/** One round, ready to run: the operation, how to send each phase, and how to check the effect. */
interface RoundPlan {
  id: Hex;
  /** The row whose operation this one follows (the timelock predecessor). */
  dependsOn?: string;
  schedule: () => Promise<SafeTxBundle>;
  /** Absent for the cancel round: its second phase is the cancel. */
  execute?: () => Promise<SafeTxBundle>;
  cancel?: () => Promise<SafeTxBundle>;
  readBack: () => Promise<string[]>;
  description: string;
}

export interface GovernResult { rows: string[]; skipped: string[]; opIds: Record<string, Hex> }

export async function runGovern(ctx: RunContext, row: StageRow, manifest: RunManifest, o: GovernOpts): Promise<GovernResult> {
  const api = o.api ?? realGovernApi;
  // Usage errors first, before the Safe is read or anything is sent.
  if (o.call && ctx.chainId === BASE_CHAIN_ID) throw new PublishError("USAGE", "a generic timelock call is a Twin-chain test verb: it is refused on chain 8453");
  if (o.call && o.row !== undefined) throw new PublishError("USAGE", "a generic timelock call and --row are mutually exclusive");
  if (o.receiptId !== undefined && o.row !== RECEIPT_ROW && o.row !== APPLY_ROW) throw new PublishError("USAGE", `--receipt-id goes with --row ${RECEIPT_ROW} only (or --row ${APPLY_ROW})`);
  if (o.payload !== undefined && o.row !== APPLY_ROW) throw new PublishError("USAGE", `--payload goes with --row ${APPLY_ROW} only`);
  if (o.call && o.payload !== undefined) throw new PublishError("USAGE", "a generic timelock call and --payload are mutually exclusive");
  if (o.call && o.receiptId !== undefined) throw new PublishError("USAGE", "a generic timelock call and --receipt-id are mutually exclusive");
  if (o.selfAdmin !== undefined && !(o.row !== undefined && isSelfAdminRow(o.row))) throw new PublishError("USAGE", "--admin-arg goes with a self-administration row only (" + SELF_ADMIN_ROWS.join(", ") + ")");
  const selfAdminRow = o.row !== undefined && isSelfAdminRow(o.row) ? o.row : undefined;
  if (selfAdminRow !== undefined) assertSelfAdminAllowed(ctx.chainId, selfAdminRow);
  const releasing = o.row === RECEIPT_ROW;
  const applying = o.row === APPLY_ROW;
  const registering = o.row === REGISTER_ROW;
  const clearing = o.row === CLEAR_ROW;
  const redeploying = o.row === REDEPLOY_ROW;
  const guarding = o.row === UNWIND_GUARD_ROW;
  const retiring = o.row === RETIRE_ROW;
  const freezing = o.row === FREEZE_ROW;
  const upgrading = o.row === UPGRADE_ROW;
  if ((o.proxy !== undefined || o.implementation !== undefined || o.upgradeBuild !== undefined || o.migration !== undefined) && !upgrading) throw new PublishError("USAGE", `--proxy, --implementation, --upgrade-build and --migration go with --row ${UPGRADE_ROW} only`);
  if (o.submitter !== undefined && !registering) throw new PublishError("USAGE", `--submitter goes with --row ${REGISTER_ROW} only`);
  if (o.unwindGuard !== undefined && !guarding) throw new PublishError("USAGE", `--admin-arg vault, token, min-usdc-out, max-loss-bps and override-allowed go with --row ${UNWIND_GUARD_ROW} only`);
  if (o.retire !== undefined && !retiring) throw new PublishError("USAGE", `--admin-arg vault and weights go with --row ${RETIRE_ROW} only`);
  // issue 1912: the retire row's arguments (an address and exactly three legs summing to 10000) are checked before the Safe is read or anything is sent
  const retireWant = retiring ? parseRetireArgs(o.retire) : undefined;
  // QA plan v1 D7: the row's arguments are checked before the Safe is read or anything is sent
  const guardWant = guarding ? parseUnwindGuardArgs(o.unwindGuard) : undefined;
  const early = govRowRefusal(o.row, ctx.chainId, ctx.sheet.kind);
  if (early !== undefined) throw new PublishError("USAGE", early);
  const selected: PlannedRow | undefined = o.row === undefined || releasing || applying || registering || clearing || redeploying || retiring || guarding || freezing || upgrading || selfAdminRow !== undefined ? undefined : resolveGovernRow(o.row);
  // Issue 1842: the upgrade row's arguments are checked before the Safe is read.
  const upgradeSpec = upgrading ? proxySpecs(getStageTable()).find((x) => x.name === o.proxy) : undefined;
  if (upgrading) {
    if (!upgradeSpec) throw new PublishError("USAGE", `--row ${UPGRADE_ROW} needs --proxy NAME, one of ${proxySpecs(getStageTable()).map((x) => x.name).join(", ")}; got ${String(o.proxy)}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.implementation ?? "")) throw new PublishError("USAGE", `--row ${UPGRADE_ROW} needs --implementation 0x<address> (the new implementation, already deployed), got ${String(o.implementation)}`);
    // Issue 1910: an unknown migration, or one on a proxy that has none, is refused before the Safe is read.
    if (o.migration !== undefined) {
      const bad = migrationNameProblems(o.migration, upgradeSpec.name);
      if (bad.length) throw new PublishError("USAGE", `--row ${UPGRADE_ROW}: ${bad.join("; ")}. Nothing was scheduled.`, { row: UPGRADE_ROW, migration: o.migration });
    }
  }
  const a = loadGovernAddrs(ctx);
  const sheet = ctx.sheet;
  const handle = await api.connectSafe({ rpcUrl: ctx.rpc, chainId: ctx.chainId, safeAddress: a.safe, logger: ctx.log });
  // The sheet's SAFE_OWNERS and SAFE_THRESHOLD must describe the live Safe for every row but the self-administration rows, whose purpose is to change the live
  // roster: those read back against their own arguments (safeAdminEffect) and the operator updates the sheet afterwards (runbook section 9, QA plan v1 B4).
  const stale = sheetRosterProblems(handle, sheet);
  if (stale.length && selfAdminRow === undefined) {
    throw new PublishError("GOVERN", `the Safe's owners or threshold on chain differ from the sheet: ${stale.join("; ")}. After a Safe self-administration row (${SAFE_ADMIN_ROWS.join(", ")}) update SAFE_OWNERS and SAFE_THRESHOLD in the sheet to what the chain reads (runbook section 9)`, { problems: stale });
  }
  if (stale.length) ctx.log.log("warn", "govern.sheet_stale", { row: selfAdminRow, problems: stale, hint: "update SAFE_OWNERS and SAFE_THRESHOLD in the sheet to what the chain reads after this change (runbook section 9)" });
  ctx.log.log("info", "stage.start", { stage: row.name, safe: a.safe, timelock: a.timelock });
  const state = (manifest.govern ??= {}) as GovernState;
  const salt = (name: string) => governSalt(ctx.coreSha, ctx.chainId, name);
  const note = (b: SafeTxBundle) => ({ tx_hash: b.executed?.tx_hash, safe_tx_hash: b.safe_tx_hash, status: b.executed?.status });
  const save = () => saveRunManifest(ctx.evidenceDir, manifest);
  const opIds: Record<string, Hex> = {};
  const ran: string[] = [];
  const skipped: string[] = [];
  const dependsOn = o.dependsOn ?? GOVERN_DEPENDENCIES;
  for (const [dep, pre] of Object.entries(dependsOn)) {
    const di = (GOVERN_ROWS as readonly string[]).indexOf(dep), pi = (GOVERN_ROWS as readonly string[]).indexOf(pre);
    if (di < 0 || pi < 0 || pi >= di) throw new PublishError("USAGE", `row ${dep} cannot follow ${pre}: both must be govern rows and the predecessor comes first`, { dep, pre });
  }

  /** The salt label of a row's current round: round 1 until the row's record says otherwise. */
  const labelOf = (name: string): string => roundKey(name, state[name]?.round ?? 1);

  /** The plan of a row, or a reason to skip it. A declared predecessor must be a row of this run with an operation id. */
  async function plan(name: PlannedRow): Promise<RoundPlan | string> {
    const pre = dependsOn[name];
    let predecessor: Hex | undefined;
    if (pre !== undefined) {
      predecessor = opIds[pre];
      if (predecessor === undefined) throw new PublishError("GOVERN", `govern row ${name} follows ${pre}, which has no operation in this run (skipped or not selected)`, { row: name, depends_on: pre });
    }
    const orderedPlan = async (calls: LabelledCall[], saltName: string, readBack: () => Promise<string[]>, description: string): Promise<RoundPlan> => {
      const form = calls.length === 1 ? ("single" as const) : ("batch" as const);
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(saltName), form, ...(predecessor ? { predecessor } : {}) };
      return {
        id: await api.operationId(handle, p), readBack, description, ...(pre !== undefined ? { dependsOn: pre } : {}),
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${name} (${calls.length} calls): ${calls.map((c) => c.label).join("; ")}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${name} execute` }),
      };
    };
    if (name === "update-delay") {
      const newDelay = sheet.govern.newDelay;
      const s = salt(name);
      const inner = { target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [newDelay] }) };
      return {
        id: await api.operationId(handle, { timelock: a.timelock, calls: [inner], salt: s, form: "single" }),
        description: `updateDelay to ${newDelay}`,
        schedule: () => api.updateTimelockDelay(handle, { timelock: a.timelock, newDelay, phase: "schedule", salt: s, deploymentKind: sheet.kind, description: `update-delay: updateDelay to ${newDelay}` }),
        execute: () => api.updateTimelockDelay(handle, { timelock: a.timelock, newDelay, phase: "execute", salt: s, deploymentKind: sheet.kind, description: `update-delay: execute updateDelay to ${newDelay}` }),
        readBack: async () => { const now = await api.timelockMinDelay(handle, a.timelock); return now === newDelay ? [] : [`getMinDelay is ${now}, want ${newDelay}`]; },
      };
    }
    if (name === "batch") {
      // one scheduleBatch round that changes nothing: the delay set to itself and rmUSDC's cap set to the value it holds ON CHAIN now (not the sheet's, which may differ after a setter ran)
      const delay = await api.timelockMinDelay(handle, a.timelock);
      const liveCap = await reader(handle)<bigint>(a.vaults.USDC, VAULT_ABI, "perDepositCap");
      const calls: LabelledCall[] = [
        { label: "timelock.updateDelay(unchanged)", target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [delay] }) },
        { label: "rmUSDC.setPerDepositCap(unchanged)", target: a.vaults.USDC, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "setPerDepositCap", args: [liveCap] }) },
      ];
      return orderedPlan(calls, name, async () => {
        const bad: string[] = [];
        if ((await api.timelockMinDelay(handle, a.timelock)) !== delay) bad.push("getMinDelay changed");
        if ((await reader(handle)<bigint>(a.vaults.USDC, VAULT_ABI, "perDepositCap")) !== liveCap) bad.push("rmUSDC.perDepositCap changed");
        return bad;
      }, "batch scheduling proof");
    }
    if (name === "cancel") {
      const delay = await api.timelockMinDelay(handle, a.timelock);
      const p = { timelock: a.timelock, calls: [{ target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [delay] }) }], salt: salt(name), form: "single" as const };
      const id = await api.operationId(handle, p);
      return {
        id, description: "a no-op operation that the Safe cancels",
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: "cancel: a no-op operation that the Safe cancels" }),
        cancel: () => api.cancelOnTimelock(handle, { timelock: a.timelock, id, description: "cancel: cancel the no-op" }),
        readBack: async () => { const st = await api.operationState(handle, a.timelock, id); return st.pending || st.exists ? ["the cancelled operation is still on the timelock"] : []; },
      };
    }
    const calls = buildStepCalls(sheet, a, name);
    if (calls.length === 0) return `${name.slice("unpause-".length)} is not in GOVERN_UNPAUSE_VAULTS: it stays paused`;
    return orderedPlan(calls, labelOf(name), () => readBackStep(handle, a, name), `${calls.length} call(s)`);
  }

  /** Phase 1 of a round: schedule (or, for an operation already on the timelock, adopt it). `emitAs` is the `row` of the printed lines. */
  async function schedulePhase(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    opIds[name] = p.id;
    const rec: RowRecord = state[name] ?? { round: 1 };
    if (rec.scheduled) {
      ctx.log.log("info", "govern.phase_skipped", { row: name, phase: "scheduled" });
      emitPhase(o, emitAs, "scheduled", rec.scheduled);
      return;
    }
    const st = await api.operationState(handle, a.timelock, p.id);
    let sched: PhaseRecord;
    if (st.exists) sched = { at: new Date().toISOString(), operation_id: p.id, ready_at: st.readyAt.toString(), note: "already scheduled by an earlier run", seq: 0 }; // seq 0: the schedule time is unknown, so ANY recorded pause-all is newer (issue 1686)
    else {
      const seq = reserveManifestSeq(ctx.evidenceDir, manifest); // issue 1688: fixed BEFORE the send, so a pause-all landing before the next save still orders correctly
      const done = await signAndExecute(ctx, o, api, handle, await p.schedule());
      const after = await api.operationState(handle, a.timelock, p.id);
      sched = { at: new Date().toISOString(), operation_id: p.id, ready_at: after.readyAt.toString(), seq, ...note(done) };
    }
    rec.scheduled = sched;
    state[name] = rec;
    save();
    ctx.log.log("info", "govern.phase_done", { row: name, phase: "scheduled" });
    emitPhase(o, emitAs, "scheduled", sched);
  }

  /** Phase 2 of a cancel round: the Safe cancels the scheduled operation. */
  async function cancelPhase(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    const rec = state[name]!;
    if (rec.cancelled) { emitPhase(o, emitAs, "cancelled", rec.cancelled); return; }
    let cancelled: PhaseRecord;
    if (!(await api.operationState(handle, a.timelock, p.id)).exists) cancelled = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, note: "already cancelled by an earlier run" };
    else cancelled = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, ...note(await signAndExecute(ctx, o, api, handle, await p.cancel!())) };
    const bad = await p.readBack();
    if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back failed: ${bad.join(", ")}`, { bad });
    rec.cancelled = cancelled;
    save();
    emitPhase(o, emitAs, "cancelled", rec.cancelled);
  }

  /** The pause entries on disk (pause-all may have written one since this process loaded the manifest) merged with the in-memory ones. */
  function livePauses(): PauseEntry[] {
    let disk: PauseEntry[] = [];
    try { disk = loadRunManifest(ctx.evidenceDir)?.pauses ?? []; } catch { /* an unreadable manifest is not a reason to execute: the in-memory entries still count */ }
    const bySeq = new Map<number, PauseEntry>();
    for (const e of [...(manifest.pauses ?? []), ...disk]) bySeq.set(e.seq, e);
    manifest.pauses = [...bySeq.values()].sort((x, y) => x.seq - y.seq);
    return manifest.pauses;
  }

  /**
   * Issue 1686: refuses to execute an unpause whose schedule is older (lower seq) than a recorded pause-all. Sends nothing, changes no manifest row.
   * An operation already done on chain is left to the read-back (there is nothing left to cancel). Other rows (Twin-only, receipt, generic) are not unpauses.
   */
  async function refuseIfPausedSince(name: string, p: RoundPlan): Promise<void> {
    // The redeploy batch ends with new.unpauseDeposits(): a pause-all recorded after its schedule makes it stale in the same way (issue 1796).
    const redeployRound = name.startsWith(`${REDEPLOY_ROW}-`);
    if (!name.startsWith("unpause-") && !redeployRound) return;
    const rec = state[name];
    if (!rec?.scheduled || rec.executed) return;
    const newest = livePauses().filter((e) => e.seq > (rec.scheduled!.seq ?? 0)).pop();
    if (!newest) return;
    const st = await api.operationState(handle, a.timelock, p.id);
    if (st.done || !st.exists) return; // done: nothing left to cancel, the read-back decides. Gone: already cancelled, waitReady names the fresh-round command.
    const next = resumeCommand(ctx, name);
    throw new PublishError("GOVERN", `govern row ${name} (round ${rec.round ?? 1}) will NOT execute: operation ${p.id} was scheduled (sequence ${rec.scheduled.seq ?? 0}) before pause-all #${newest.seq} (${newest.trigger}, ${newest.at}), which paused the vaults on purpose. Executing it would reopen ${redeployRound ? "the redeployed vault (its last call is unpauseDeposits)" : VAULT_NAME[name.slice("unpause-".length) as VaultKey]}. Nothing was sent. First cancel the operation through the Safe on the timelock, with a Safe transaction that calls cancel(${p.id}) on ${a.timelock} (the tool has no cancel on chain ${ctx.chainId}). Then open a fresh round: ${next}`,
      { row: name, round: rec.round ?? 1, operation_id: p.id, timelock: a.timelock, pause_seq: newest.seq, pause_at: newest.at, pause_trigger: newest.trigger, scheduled_seq: rec.scheduled.seq ?? 0, next_command: next });
  }

  /** Phase 2 of an executing round, once the delay has passed: execute (or adopt an execution already on chain), read back, record. */
  async function executePhase(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    const rec = state[name]!;
    if (rec.executed) { emitPhase(o, emitAs, "executed", rec.executed); return; }
    await refuseIfPausedSince(name, p);
    let ex: PhaseRecord;
    if ((await api.operationState(handle, a.timelock, p.id)).done) {
      const bad = await p.readBack();
      if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back differs from the sheet: ${bad.join(", ")}`, { bad });
      ex = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, note: "already executed by an earlier run" };
    } else {
      const done = await signAndExecute(ctx, o, api, handle, await p.execute!());
      const eff = await api.verifyTimelockEffect(handle, done);
      if (!eff.ok) throw new PublishError("GOVERN", `govern row ${name} effect not observed: ${eff.detail}`);
      const bad = await p.readBack();
      if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back differs from the sheet: ${bad.join(", ")}`, { bad });
      ex = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, ...note(done) };
    }
    rec.executed = ex;
    save();
    ctx.log.log("info", "govern.phase_done", { row: name, phase: "executed" });
    emitPhase(o, emitAs, "executed", ex);
  }

  /** One round on its own: schedule, then cancel or wait for the real delay and execute. The receipt release, the generic call and the Twin-only rows. */
  async function round(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    await schedulePhase(name, p, emitAs);
    if (p.cancel) return cancelPhase(name, p, emitAs);
    if (state[name]!.executed) return executePhase(name, p, emitAs);
    await waitReady(ctx, o, api, handle, a.timelock, [{ id: p.id, row: name }], name, o.payload);
    await executePhase(name, p, emitAs);
  }

  /** Reprint the lines of a row that is already complete. */
  function reprint(name: string): void {
    const r = state[name]!;
    if (r.scheduled) emitPhase(o, name, "scheduled", r.scheduled);
    if (r.executed) emitPhase(o, name, "executed", r.executed);
    if (r.cancelled) emitPhase(o, name, "cancelled", r.cancelled);
  }

  /**
   * The unpause rows as one set: every operation scheduled in one sitting (each its own timelock operation and its own Safe transaction), ONE wait
   * for the latest ready time, then each executed in order and read back. A resume finds the schedules recorded and goes straight to the wait.
   */
  async function runSet(names: readonly PlannedRow[], resumeRow?: string): Promise<void> {
    const live: { name: PlannedRow; p: RoundPlan }[] = [];
    const pausedNow = async (name: PlannedRow): Promise<boolean> => reader(handle)<boolean>(a.vaults[name.slice("unpause-".length) as VaultKey], VAULT_ABI, "depositsPaused");
    for (const name of names) {
      // Issue 1686: the operator cancelled this round's operation through the Safe and named the row. The same round is scheduled again (a cancelled id is free).
      const cur = state[name];
      if (selected === name && cur?.scheduled?.operation_id && !rowComplete(cur)) {
        const st = await api.operationState(handle, a.timelock, cur.scheduled.operation_id as Hex);
        if (!st.exists && !st.done) {
          const n = cur.round ?? 1;
          let k = 1;
          while (state[`${roundKey(name, n)}:cancelled-${k}`]) k++;
          state[`${roundKey(name, n)}:cancelled-${k}`] = cur;
          state[name] = { round: n };
          save();
          ctx.log.log("info", "govern.round_rescheduled", { row: name, round: n, cancelled_operation: cur.scheduled.operation_id });
        }
      }
      if (rowComplete(state[name])) {
        const prev = state[name]!;
        // An executed round whose vault reads paused again (pause-all ran after it) needs a NEW round, and only a named row opens one.
        if (prev.executed && (await pausedNow(name))) {
          if (selected !== name) throw new PublishError("GOVERN", `govern row ${name} executed in round ${prev.round ?? 1}, but ${VAULT_NAME[name.slice("unpause-".length) as VaultKey]} reads depositsPaused true again. A default run never reopens a paused vault: to open round ${(prev.round ?? 1) + 1} run ${resumeCommand(ctx, name)}`, { row: name, round: prev.round ?? 1, next_command: resumeCommand(ctx, name) });
          const done = prev.round ?? 1;
          state[roundKey(name, done)] = prev;
          state[name] = { round: done + 1 };
          save();
          ctx.log.log("info", "govern.round_opened", { row: name, round: done + 1 });
        } else {
          ctx.log.log("info", "govern.row_complete", { row: name });
          const doneId = prev.scheduled?.operation_id;
          if (doneId) opIds[name] = doneId as Hex; // a dependent row of this run still needs its predecessor's id
          reprint(name);
          continue;
        }
      }
      const p = await plan(name);
      if (typeof p === "string") {
        state[name] = { skipped: { at: new Date().toISOString(), reason: p } };
        save();
        skipped.push(name);
        ctx.log.log("info", "govern.row_skipped", { row: name, reason: p });
        continue;
      }
      // Nothing of this round is on the timelock yet: refuse to schedule an unpause for a vault that is already open (nothing to reopen).
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, p.id)).exists && !(await pausedNow(name))) {
        throw new PublishError("GOVERN", `govern row ${name}: ${VAULT_NAME[name.slice("unpause-".length) as VaultKey]} already reads depositsPaused false: there is nothing to unpause, so no round is scheduled`, { row: name });
      }
      await schedulePhase(name, p);
      live.push({ name, p });
    }
    // refuse BEFORE the wait and before the first execute (executePhase checks again, so a pause-all that lands during the wait is caught before its send)
    for (const { name, p } of live) await refuseIfPausedSince(name, p);
    await waitReady(ctx, o, api, handle, a.timelock, live.map((x) => ({ id: x.p.id, row: x.name })), resumeRow);
    for (const { name, p } of live) {
      await executePhase(name, p);
      ran.push(name);
      ctx.log.log("info", "govern.row_done", { row: name });
    }
  }

  /** The evidence entry of an executed registration round (`submitter_registrations` of the run manifest, checked by evidence-check). */
  async function recordRegistration(name: string): Promise<void> {
    const r = state[name] as (RowRecord & { register?: RegisterState }) | undefined;
    if (!r?.executed?.tx_hash || !r.scheduled?.tx_hash || !r.register) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    const entry = {
      step: REGISTER_ROW, ...r.register, timelock: a.timelock,
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    };
    const list = ((manifest as { submitter_registrations?: { submitter?: string }[] }).submitter_registrations ??= []);
    const i = list.findIndex((x) => x.submitter?.toLowerCase() === entry.submitter.toLowerCase());
    if (i >= 0) list[i] = entry; else list.push(entry);
    save();
  }

  if (registering) {
    // Issue 1888: ONE delayed timelock call, ConsensusRecommendationReceipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter). No private half, no batch, no gateway. Never part of the
    // matrix. Every chain and kind. submitter-register.ts has the why. Every pre-check runs BEFORE the timelock round is scheduled, so a refused submitter spends no delay.
    const submitter = assertSubmitter(o.submitter);
    const receipt = loadReceiptAddr(ctx);
    const name = registerRecordKey(submitter);
    const rd = reader(handle);
    const read = async <T,>(addr: Address, abi: readonly unknown[], fn: string, args: unknown[] = []): Promise<T> => rd<T>(addr, abi, fn, args);
    const c = buildRegisterCall(receipt, submitter);
    const p = { timelock: a.timelock, calls: [{ target: c.target, data: c.data }], salt: salt(name), form: "single" as const };
    const id = await api.operationId(handle, p);
    // One submitter is one operation: a record under this key for a different operation (another receipt contract, say) would adopt the wrong round.
    const prior = state[name]?.scheduled?.operation_id;
    if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: REGISTER_ROW, submitter, prior, id });
    const readBack = async () => registerReadBackProblems({ submitterRole: await read<boolean>(receipt, RECEIPT_ROLE_ABI, "hasRole", [RECEIPT_SUBMITTER_ROLE, submitter]) });
    if (!rowComplete(state[name])) {
      let submitterSafe = (state[name] as { register?: RegisterState } | undefined)?.register?.submitter_safe;
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, id)).exists) {
        // Nothing of this round is on the timelock yet: refuse what can only revert or can never record, before the Safe schedules it and the delay is spent.
        // The submitter MAY be the governing Safe and its owners may be shared (issue 1888). It may not be the timelock or a deployment role address.
        const kind = await api.inspectSubmitter(handle, submitter, forbiddenSubmitters({ timelock: a.timelock, admin: sheet.admin, pauser: sheet.pauser, emergency: sheet.emergency }));
        if (kind === null) throw new PublishError("USAGE", `--submitter ${submitter} has no code: it is a single key. The consensus receipt submitter is a multisig on every chain (a SafeL2 1.4.1 proxy with threshold 2 or more). Nothing scheduled.`, { submitter });
        submitterSafe = submitterSafeEvidence(kind);
        const roleAdmin = await read<Hex>(receipt, RECEIPT_ROLE_ABI, "getRoleAdmin", [RECEIPT_SUBMITTER_ROLE]);
        if (!(await read<boolean>(receipt, RECEIPT_ROLE_ABI, "hasRole", [roleAdmin, a.timelock]))) throw new PublishError("GOVERN", `the timelock ${a.timelock} does not hold the admin role of RECEIPT_SUBMITTER_ROLE (${roleAdmin}) on the receipt ${receipt}: the grant would revert after the delay. Nothing scheduled.`, { receipt, role_admin: roleAdmin });
        if (await read<boolean>(receipt, RECEIPT_ROLE_ABI, "hasRole", [RECEIPT_SUBMITTER_ROLE, submitter])) throw new PublishError("GOVERN", `${submitter} already holds RECEIPT_SUBMITTER_ROLE on the receipt ${receipt}: it is registered already, nothing to schedule`, { submitter });
      }
      state[name] = { ...(state[name] ?? { round: 1 }), register: { submitter, receipt, ...(submitterSafe ? { submitter_safe: submitterSafe } : {}) } } as RowRecord;
      save();
      await round(name, {
        id, description: `register receipt submitter ${submitter}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${REGISTER_ROW}: ${c.label}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${REGISTER_ROW} execute` }),
      }, REGISTER_ROW);
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, REGISTER_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, REGISTER_ROW, "executed", r.executed);
    }
    await recordRegistration(name);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: REGISTER_ROW, submitter });
    return { rows: [name], skipped: [], opIds };
  }

  /** The evidence entry of an executed clear round (`voted_weights_clears` of the run manifest, checked by evidence-check). */
  async function recordClear(name: string, governance: Address): Promise<void> {
    const r = state[name];
    if (!r?.executed?.tx_hash || !r.scheduled?.tx_hash) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    const entry = {
      step: CLEAR_ROW, round: r.round ?? 1, governance, router: a.router,
      voted_weights_active: r.observed?.voted_weights_active, effective_vaults: r.observed?.effective_vaults, effective_bps: r.observed?.effective_bps,
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    };
    const list = ((manifest as { voted_weights_clears?: { operation_id?: string }[] }).voted_weights_clears ??= []);
    const i = list.findIndex((x) => x.operation_id?.toLowerCase() === String(entry.operation_id).toLowerCase());
    if (i >= 0) list[i] = entry; else list.push(entry);
    save();
  }

  if (clearing) {
    // Issue 1743: ONE timelock call, RouterGovernance.clearVotedWeights(). Never part of the matrix. On 8453 in production and in a rehearsal, and on the Twin chain.
    const name = CLEAR_ROW;
    const governance = a.governance;
    const rd = reader(handle);
    const votedNow = () => rd<boolean>(a.router, ROUTER_WEIGHTS_ABI, "votedWeightsActive");
    const prev = state[name];
    if (prev?.scheduled?.operation_id && !rowComplete(prev)) {
      // The operator cancelled this round's operation through the Safe and named the row again: the same round is scheduled again (a cancelled id is free).
      const st = await api.operationState(handle, a.timelock, prev.scheduled.operation_id as Hex);
      if (!st.exists && !st.done) {
        const n = prev.round ?? 1;
        let k = 1;
        while (state[`${roundKey(name, n)}:cancelled-${k}`]) k++;
        state[`${roundKey(name, n)}:cancelled-${k}`] = prev;
        state[name] = { round: n };
        save();
        ctx.log.log("info", "govern.round_rescheduled", { row: CLEAR_ROW, round: n, cancelled_operation: prev.scheduled.operation_id });
      }
    } else if (rowComplete(prev)) {
      // An executed round, and the router reads an active vector again (a receipt was applied since): a NEW round, a new operation.
      if (!(await votedNow())) throw new PublishError("GOVERN", `govern row ${CLEAR_ROW} executed in round ${prev!.round ?? 1} and router.votedWeightsActive() reads false: there is nothing to clear`, { row: CLEAR_ROW, round: prev!.round ?? 1 });
      const done = prev!.round ?? 1;
      state[roundKey(name, done)] = prev!;
      state[name] = { round: done + 1 };
      save();
      ctx.log.log("info", "govern.round_opened", { row: CLEAR_ROW, round: done + 1 });
    }
    if (!rowComplete(state[name])) {
      const c = buildClearCall(governance);
      const p = { timelock: a.timelock, calls: [{ target: c.target, data: c.data }], salt: salt(labelOf(name)), form: "single" as const };
      const id = await api.operationId(handle, p);
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, id)).exists && !(await votedNow())) {
        throw new PublishError("GOVERN", `govern row ${CLEAR_ROW}: router.votedWeightsActive() already reads false: there is no voted vector to clear, so no round is scheduled`, { row: CLEAR_ROW });
      }
      const readBack = async () => {
        const [defaultVaults, defaultBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_WEIGHTS_ABI, "getDefaultWeights");
        const [effectiveVaults, effectiveBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_WEIGHTS_ABI, "getEffectiveWeights");
        const votedWeightsActive = await votedNow();
        const bad = clearReadBackProblems({ votedWeightsActive, defaultVaults, defaultBps, effectiveVaults, effectiveBps });
        if (bad.length === 0) state[name]!.observed = { voted_weights_active: votedWeightsActive, effective_vaults: [...effectiveVaults], effective_bps: effectiveBps.map(Number) };
        return bad;
      };
      state[name] = { ...(state[name] ?? { round: 1 }) };
      await round(name, {
        id, description: "clear the router's voted weight vector", readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${CLEAR_ROW}: ${c.label}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${CLEAR_ROW} execute` }),
      }, CLEAR_ROW);
    } else {
      reprint(name);
    }
    await recordClear(name, governance);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: CLEAR_ROW });
    return { rows: [name], skipped: [], opIds };
  }

  /** The evidence entry of an executed retire round (`vault_retirements` of the run manifest, checked by evidence-check). */
  async function recordRetire(name: string, want: RetireWant, vaults: readonly Address[], bps: readonly number[]): Promise<void> {
    const r = state[name]!;
    if (!r?.executed?.tx_hash || !r.scheduled?.tx_hash) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    const entry = {
      step: RETIRE_ROW, round: r.round ?? 1, vault: want.vault, registry: a.registry, router: a.router, timelock: a.timelock, vaults: [...vaults], bps: [...bps],
      voted_weights_active: r.observed?.voted_weights_active, effective_vaults: r.observed?.effective_vaults, effective_bps: r.observed?.effective_bps,
      ...(want.appliedVector && r.observed?.voted_weights_active === true ? { applied_vector: true } : {}),
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    };
    const list = ((manifest as { vault_retirements?: { operation_id?: string }[] }).vault_retirements ??= []);
    const i = list.findIndex((x) => x.operation_id?.toLowerCase() === String(entry.operation_id).toLowerCase());
    if (i >= 0) list[i] = entry; else list.push(entry);
    save();
  }

  if (retiring) {
    // Issue 1912 (ADR-0017, ADR-0009): ONE timelock batch, registry.migrateEligibility(vault, false, three legs) then registry.retire(vault). Never part of the matrix. On 8453 in production
    // and in a rehearsal, and on the Twin chain. retire-vault.ts has the why. Every pre-check runs BEFORE the round is scheduled, so a refused vector spends no delay.
    const want = retireWant!;
    const name = retireRecordKey(want.vault);
    const rd = reader(handle);
    const finalVaults = want.weights.map((w) => a.vaults[w.key]);
    const finalBps = want.weights.map((w) => w.bps);
    const calls = buildRetireCalls({ registry: a.registry, vault: want.vault, finalVaults, finalBps });
    const before = async () => {
      const [listed, [, status], eligible, registryRouter, tlAdmin, voted, [defaultVaults]] = await Promise.all([
        rd<Address[]>(a.registry, REGISTRY_REDEPLOY_ABI, "listVaults"),
        rd<[unknown, number]>(a.registry, REGISTRY_REDEPLOY_ABI, "getVault", [want.vault]),
        rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "isRouterEligible", [want.vault]),
        rd<Address>(a.registry, REGISTRY_REDEPLOY_ABI, "router"),
        rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "hasRole", [ADMIN_ROLE, a.timelock]),
        rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "votedWeightsActive"),
        rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getDefaultWeights"),
      ]);
      const code = await handle.client.getCode({ address: want.vault });
      return retireBeforeProblems(want, finalVaults, {
        listed, status: Number(status), eligible, registryRouter, router: a.router, timelockIsRegistryAdmin: tlAdmin, votedWeightsActive: voted, defaultVaults, hasCode: !!code && code !== "0x",
      });
    };
    const prev = state[name];
    if (prev?.scheduled?.operation_id && !rowComplete(prev)) {
      // The operator cancelled this round's operation through the Safe and named the row again: the same round is scheduled again (a cancelled id is free).
      const st = await api.operationState(handle, a.timelock, prev.scheduled.operation_id as Hex);
      if (!st.exists && !st.done) {
        const n = prev.round ?? 1;
        let k = 1;
        while (state[`${roundKey(name, n)}:cancelled-${k}`]) k++;
        state[`${roundKey(name, n)}:cancelled-${k}`] = prev;
        state[name] = { round: n };
        save();
        ctx.log.log("info", "govern.round_rescheduled", { row: RETIRE_ROW, key: name, round: n, cancelled_operation: prev.scheduled.operation_id });
      }
    }
    if (!rowComplete(state[name])) {
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(labelOf(name)), form: "batch" as const };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: RETIRE_ROW, prior, id });
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, id)).exists) {
        const problems = await before();
        if (problems.length > 0) throw new PublishError("GOVERN", `govern row ${RETIRE_ROW} cannot start from the state on chain: ${problems.join("; ")}. Nothing was scheduled.`, { row: RETIRE_ROW, problems });
      }
      for (const line of retirePreviewLines(want, finalVaults, calls)) ctx.log.log("info", "govern.retire_preview", { line });
      const readBack = async () => {
        const [, status] = await rd<[unknown, number]>(a.registry, REGISTRY_REDEPLOY_ABI, "getVault", [want.vault]);
        const [defaultVaults, defaultBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getDefaultWeights");
        const [effectiveVaults, effectiveBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getEffectiveWeights");
        const votedWeightsActive = await rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "votedWeightsActive");
        const code = await handle.client.getCode({ address: want.vault });
        const bad = retireReadBackProblems(finalVaults, finalBps, {
          status: Number(status), eligible: await rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "isRouterEligible", [want.vault]),
          eligibleCount: Number(await rd<bigint>(a.registry, REGISTRY_REDEPLOY_ABI, "routerEligibleCount")), votedWeightsActive,
          defaultVaults, defaultBps, effectiveVaults, effectiveBps, retiredFlag: await rd<boolean>(want.vault, VAULT_REDEPLOY_ABI, "retired"), hasCode: !!code && code !== "0x",
        }, want.appliedVector === true);
        if (bad.length === 0) state[name]!.observed = { voted_weights_active: votedWeightsActive, effective_vaults: [...effectiveVaults], effective_bps: effectiveBps.map(Number) };
        return bad;
      };
      state[name] = { ...(state[name] ?? { round: 1 }) };
      await round(name, {
        id, description: `retire vault ${want.vault}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${RETIRE_ROW} ${want.vault}: ${calls.map((c) => c.label).join("; ")}` }),
        execute: async () => {
          // Re-read immediately before public execution: a saved plan is no authority to execute stale state.
          const problems = await before();
          if (problems.length > 0) throw new PublishError("GOVERN", `govern row ${RETIRE_ROW} will NOT execute: the state on chain changed since the schedule: ${problems.join("; ")}. Nothing was sent.`, { row: RETIRE_ROW, problems });
          return api.executeOnTimelock(handle, { ...p, description: `${RETIRE_ROW} execute ${want.vault}` });
        },
      }, RETIRE_ROW);
    } else {
      reprint(name);
    }
    await recordRetire(name, want, finalVaults, finalBps);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: RETIRE_ROW, vault: want.vault });
    return { rows: [name], skipped: [], opIds };
  }

  /** The evidence entry of an executed set-unwind-guard round (`unwind_guards` of the run manifest). A record: the verifier reads each guard from the chain, never from here. */
  async function recordUnwindGuard(name: string): Promise<void> {
    const r = state[name];
    if (!r?.executed?.tx_hash || !r.scheduled?.tx_hash || !r.guard) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    const entry = {
      step: UNWIND_GUARD_ROW, key: name, round: r.round ?? 1, ...r.guard, timelock: a.timelock,
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    };
    const list = ((manifest as { unwind_guards?: { operation_id?: string }[] }).unwind_guards ??= []);
    const i = list.findIndex((x) => x.operation_id?.toLowerCase() === String(entry.operation_id).toLowerCase());
    if (i >= 0) list[i] = entry; else list.push(entry);
    save();
  }

  if (guarding) {
    // QA plan v1 D7 (review E5, issue 1705 Q2): ONE timelock operation, setEmergencyUnwindGuard per token on one basket vault. Never part of the matrix. On 8453 in production and
    // in a rehearsal, and on the Twin chain. unwind-guard.ts has the why and the values.
    const want = guardWant!;
    const vault = a.vaults[want.vault];
    const vname = VAULT_NAME[want.vault];
    const rd = reader(handle);
    // The vault's active asset rows in its own order (assets(i) reverts past the end of the list).
    const active: Address[] = [];
    for (let i = 0; i < 64; i++) {
      let r: readonly unknown[];
      try { r = await rd<readonly unknown[]>(vault, VAULT_UNWIND_GUARD_ABI, "assets", [BigInt(i)]); } catch { break; }
      if (r[3] === true) active.push(getAddress(String(r[0])));
    }
    const targets = unwindGuardTargets(want, active);
    if (typeof targets === "string") throw new PublishError("GOVERN", `govern row ${UNWIND_GUARD_ROW}: ${targets}. Nothing was sent`, { row: UNWIND_GUARD_ROW, vault: want.vault, active });
    const calls = buildUnwindGuardCalls(vault, want, targets);
    const name = unwindGuardRecordKey(want.vault, calls);
    const guardsNow = async (): Promise<GuardRead[]> => {
      const out: GuardRead[] = [];
      for (const token of targets) {
        const [minUsdcOut, overrideAllowed, maxLossBps] = await rd<readonly [bigint, boolean, bigint]>(vault, VAULT_UNWIND_GUARD_ABI, "emergencyUnwindGuard", [token]);
        out.push({ token, minUsdcOut, overrideAllowed, maxLossBps });
      }
      return out;
    };
    const show = (g: readonly GuardRead[]) => g.map((x) => `${x.token} (${x.minUsdcOut}, ${x.overrideAllowed}, ${x.maxLossBps})`).join(", ");
    const prev = state[name];
    if (prev?.scheduled?.operation_id && !rowComplete(prev)) {
      // The operator cancelled this round's operation through the Safe and named the row again: the same round is scheduled again (a cancelled id is free).
      const st = await api.operationState(handle, a.timelock, prev.scheduled.operation_id as Hex);
      if (!st.exists && !st.done) {
        const n = prev.round ?? 1;
        let k = 1;
        while (state[`${roundKey(name, n)}:cancelled-${k}`]) k++;
        state[`${roundKey(name, n)}:cancelled-${k}`] = prev;
        state[name] = { round: n };
        save();
        ctx.log.log("info", "govern.round_rescheduled", { row: UNWIND_GUARD_ROW, key: name, round: n, cancelled_operation: prev.scheduled.operation_id });
      }
    } else if (rowComplete(prev) && unwindGuardProblems(want, await guardsNow()).length > 0) {
      // Executed (or skipped) earlier, and the chain reads other values now (a later run set them): setting these values again is a NEW round, a new operation.
      const done = prev!.round ?? 1;
      state[roundKey(name, done)] = prev!;
      state[name] = { round: done + 1 };
      save();
      ctx.log.log("info", "govern.round_opened", { row: UNWIND_GUARD_ROW, key: name, round: done + 1 });
    }
    if (!rowComplete(state[name])) {
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(labelOf(name)), form: calls.length === 1 ? ("single" as const) : ("batch" as const) };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: UNWIND_GUARD_ROW, prior, id });
      const before = await guardsNow();
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, id)).exists) {
        // Nothing of this round is on the timelock yet. A guard already in effect is recorded as skipped and nothing is sent; a call the vault would revert after the delay is refused.
        if (unwindGuardProblems(want, before).length === 0) {
          const reason = `already in effect on chain: ${vname} ${show(before)}`;
          state[name] = { ...(state[name] ?? { round: 1 }), skipped: { at: new Date().toISOString(), reason } };
          save();
          ctx.log.log("info", "govern.row_skipped", { row: UNWIND_GUARD_ROW, key: name, reason });
          return { rows: [name], skipped: [name], opIds };
        }
        if (!(await rd<boolean>(vault, VAULT_UNWIND_GUARD_ABI, "hasRole", [ADMIN_ROLE, a.timelock]))) {
          throw new PublishError("GOVERN", `govern row ${UNWIND_GUARD_ROW}: the timelock ${a.timelock} does not hold ADMIN_ROLE on ${vname} ${vault}, so setEmergencyUnwindGuard would revert after the delay. Nothing was sent`, { row: UNWIND_GUARD_ROW, vault: want.vault });
        }
      }
      const readBack = async () => unwindGuardProblems(want, await guardsNow());
      state[name] = {
        ...(state[name] ?? { round: 1 }),
        guard: { vault: want.vault, vault_address: vault, tokens: [...targets], min_usdc_out: want.minUsdcOut.toString(), override_allowed: want.overrideAllowed, max_loss_bps: Number(want.maxLossBps) },
      };
      // The Safe transaction names the guard before and after, so the signers see what changes.
      await round(name, {
        id, description: `${vname} emergency unwind guard`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${UNWIND_GUARD_ROW}: ${vname} ${vault} from ${show(before)}: ${calls.map((c) => c.label).join("; ")}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${UNWIND_GUARD_ROW} execute` }),
      }, UNWIND_GUARD_ROW);
    } else {
      // a completed round whose values the chain still reads: reprint its lines, send nothing
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, UNWIND_GUARD_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, UNWIND_GUARD_ROW, "executed", r.executed);
    }
    await recordUnwindGuard(name);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: UNWIND_GUARD_ROW, key: name, vault: want.vault });
    return { rows: [name], skipped: state[name]?.skipped && !state[name]?.executed ? [name] : [], opIds };
  }

  /** The evidence entry of an executed redeploy round: the `vault_redeploys` entry the verb started, completed with the operation and the read-back (checked by evidence-check). */
  async function recordRedeploy(name: string, rec: RedeployRecord, vec: RedeployVectors): Promise<void> {
    const r = state[name] as (RowRecord & { observed?: { effective_vaults?: string[]; effective_bps?: number[]; voted_weights_active?: boolean; old_status?: string; new_status?: string } }) | undefined;
    if (!r?.executed?.tx_hash || !r.scheduled?.tx_hash) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    Object.assign(rec, {
      router_vault_cap: (state[name] as RowRecord & { redeploy?: { router_vault_cap: string } }).redeploy?.router_vault_cap,
      status: "governed" as const, vaults: vec.finalVaults, bps: vec.finalBps,
      voted_weights_active: r.observed?.voted_weights_active, effective_vaults: r.observed?.effective_vaults, effective_bps: r.observed?.effective_bps,
      old_vault_status: r.observed?.old_status, new_vault_status: r.observed?.new_status,
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    });
    save();
  }

  /** Issue 1842: the latest upgradeability.json verify wrote for this deployment. */
  function upgradeabilityRecord(rowName: string): any {
    const path = join(manifestDir(ctx), UPGRADEABILITY_MANIFEST);
    if (!existsSync(path)) throw new PublishError("INPUT_MISSING", `--row ${rowName} reads ${path}, which does not exist: run verify first`, { row: rowName, path });
    const rec = JSON.parse(readFileSync(path, "utf8"));
    if (rec.chain_id !== undefined && Number(rec.chain_id) !== ctx.chainId) throw new PublishError("GOVERN", `${path} is for chain ${rec.chain_id}, not ${ctx.chainId}`, { row: rowName });
    return rec;
  }
  const implOf = async (proxy: Address): Promise<Address> => `0x${((await handle.client.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT })) ?? "0x").replace(/^0x/, "").padStart(64, "0").slice(24)}` as Address;
  const codeOf = async (x: Address): Promise<Hex> => ((await handle.client.getCode({ address: x })) ?? "0x") as Hex;
  const frozenNow = (proxy: Address) => reader(handle)<boolean>(proxy, GOVERNED_PROXY_ABI, "upgradesFrozen");
  /** The block the timelock scan starts at: the timelock stage's first block, else the deployment's. */
  const scanStart = (): bigint => {
    const u = getStageTable().upgradeAuthority;
    const b = (u ? manifest.stages[u.stage]?.firstBlock : undefined) ?? manifest.firstBlock;
    if (b === undefined) throw new PublishError("INPUT_MISSING", "the run manifest has no first deploy block: the scan for pending timelock operations needs it", {});
    return BigInt(b);
  };
  const blockTime = async (hash: string): Promise<number> => {
    const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
    return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  };
  /**
   * Issue 1859: the operation and transaction fields of an executed freeze or upgrade for its evidence entry. A phase this tool sent carries its transaction. A phase adopted from
   * the chain (an earlier run crashed after the send was mined, or another signer executed through the Safe UI) has none: it is recovered from the timelock's CallScheduled or
   * CallExecuted log of the operation (only a successful transaction emits one, so status 1), else recorded null with a `note`, which evidence-check accepts.
   * `prior`: the entry an earlier run wrote, whose recovered transactions are reused instead of a second scan.
   */
  async function operationEvidence(r: RowRecord, prior: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
    const id = r.scheduled!.operation_id as Hex;
    const notes: string[] = [];
    const phase = async (kind: "schedule" | "execute", rec: PhaseRecord, event: TimelockEvent, fromBlock: bigint): Promise<{ tx?: Hex; fields: Record<string, unknown> }> => {
      let tx = rec.tx_hash as Hex | undefined;
      if (!tx) {
        const earlier = prior?.[`${kind}_tx`];
        tx = typeof earlier === "string" ? (earlier as Hex) : await (api.operationTx ?? scanOperationTx)(handle, a.timelock, id, event, fromBlock);
        notes.push(tx ? `${kind}_tx recovered from the timelock's ${event} log of operation ${id}: this tool did not send the ${kind}` : `${kind}_tx unknown: this tool did not send the ${kind} and the timelock has no ${event} log of operation ${id} from block ${fromBlock}`);
      }
      if (!tx) return { fields: { [`${kind}_tx`]: null, [`${kind}_status`]: null, [`${kind}_block_timestamp`]: null } };
      return { tx, fields: { [`${kind}_tx`]: tx, [`${kind}_status`]: rec.tx_hash ? rec.status ?? 1 : 1, [`${kind}_block_timestamp`]: await blockTime(tx) } };
    };
    const sched = await phase("schedule", r.scheduled!, "CallScheduled", scanStart());
    const from = sched.tx ? (await handle.client.getTransactionReceipt({ hash: sched.tx })).blockNumber : scanStart();
    const exec = await phase("execute", r.executed!, "CallExecuted", from);
    return { operation_id: id, ...sched.fields, ...exec.fields, ...(notes.length ? { note: notes.join("; ") } : {}) };
  }

  if (freezing) {
    // Issue 1842: ONE timelock batch, freezeUpgrades(implementation, implementation_code_hash) on every unfrozen core proxy, bound to the record verify wrote. Never part of
    // the matrix. On 8453 in production and in a rehearsal, and on the Twin chain. The freeze is one-way: a rerun of a done row reprints it.
    const name = FREEZE_ROW;
    type Freeze = { targets: Record<string, { proxy: string; implementation: string; implementation_code_hash: string }> };
    if (!rowComplete(state[name])) {
      let plan = (state[name] as { freeze?: Freeze } | undefined)?.freeze;
      if (!plan) {
        const rec = upgradeabilityRecord(name);
        if (rec.mode !== "upgradeable") throw new PublishError("GOVERN", `--row ${FREEZE_ROW}: upgradeability.json says mode ${String(rec.mode)}. Only an upgradeable release has proxies to freeze. Nothing was scheduled.`, { row: name });
        // Issue 1892: the gateway system's proxy is frozen by its own release (its own upgrade timelock). It joins this freeze only when the record lists it, a record of the combined deployment.
        const freezeTable = getStageTable();
        const freezeSpecs = freezeSpecsFor(proxySpecs(freezeTable), (stage) => freezeTable.stages.find((x) => x.name === stage)?.system, rec);
        const { targets, problems } = freezeTargets(rec, freezeSpecs);
        if (problems.length) throw new PublishError("GOVERN", `--row ${FREEZE_ROW}: upgradeability.json cannot bind the freeze: ${problems.join("; ")}. Run verify, then this row again. Nothing was scheduled.`, { row: name, problems });
        // each target must still be what the record says (else freezeUpgrades reverts FreezeTargetMismatch), and a proxy already frozen is left out (it would revert UpgradesAreFrozen)
        const open: typeof targets = {};
        const stale: string[] = [];
        for (const [n, t] of Object.entries(targets)) {
          if (await frozenNow(t.proxy as Address)) continue;
          const impl = await implOf(t.proxy as Address), hash = codeHashOf(await codeOf(impl));
          if (impl.toLowerCase() !== t.implementation.toLowerCase() || (hash ?? "").toLowerCase() !== t.implementation_code_hash.toLowerCase()) stale.push(`${n}: live implementation ${impl} (code hash ${hash}), upgradeability.json ${t.implementation} (${t.implementation_code_hash})`);
          open[n] = t;
        }
        if (stale.length) throw new PublishError("GOVERN", `--row ${FREEZE_ROW}: upgradeability.json is stale: ${stale.join("; ")}. Run verify, then this row again. Nothing was scheduled.`, { row: name, stale });
        if (Object.keys(open).length === 0) throw new PublishError("GOVERN", `--row ${FREEZE_ROW}: every core proxy already reads upgradesFrozen() true. Nothing to freeze, nothing was scheduled.`, { row: name });
        // an upgrade still pending on the timelock would either run before the freeze (and break its binding) or be stranded: refuse until it is executed or cancelled
        const scheduled = await (api.scheduledCalls ?? scanScheduledCalls)(handle, a.timelock, scanStart());
        const pendingIds = new Map<string, boolean>();
        for (const c of scheduled) pendingIds.set(c.id, (await api.operationState(handle, a.timelock, c.id)).pending);
        const queued = pendingUpgrades(scheduled, Object.values(targets).map((t) => t.proxy), (id) => pendingIds.get(id) === true);
        if (queued.length) throw new PublishError("GOVERN", `--row ${FREEZE_ROW} is refused: upgrade operation(s) still pending on the timelock ${a.timelock}: ${queued.map((q) => `${q.id} on ${q.target}`).join(", ")}. Execute or cancel each through the Safe first. Nothing was scheduled.`, { row: name, pending: queued });
        plan = { targets: open };
        // the preview the signers compare with what they sign: every proxy, the implementation and the code hash it is frozen at
        for (const [n, t] of Object.entries(open)) ctx.log.log("info", "govern.preview", { row: name, proxy_name: n, proxy: t.proxy, expected_implementation: t.implementation, expected_code_hash: t.implementation_code_hash });
        state[name] = { ...(state[name] ?? { round: 1 }), freeze: plan } as RowRecord;
        save();
      }
      const calls = buildFreezeCalls(plan.targets);
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(name), form: "batch" as const };
      const id = await api.operationId(handle, p);
      const readBack = async () => {
        const bad: string[] = [];
        for (const [n, t] of Object.entries(plan!.targets)) if (!(await frozenNow(t.proxy as Address))) bad.push(`${n} (${t.proxy}) reads upgradesFrozen() false`);
        return bad;
      };
      await round(name, {
        id, description: `freeze ${calls.length} core proxies`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${FREEZE_ROW}: ${calls.length} freezeUpgrades calls` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${FREEZE_ROW} execute` }),
      }, FREEZE_ROW);
    } else {
      reprint(name);
    }
    // the evidence entry (`upgrade_freezes` of the run manifest): the targets, the operation and its two transactions. An execution adopted from the chain passed the
    // upgradesFrozen read-back in executePhase before it was recorded (issue 1859), so it is written too.
    const r = state[name] as RowRecord & { freeze?: Freeze };
    if (r.executed && r.scheduled?.operation_id && r.freeze) {
      const list = ((manifest as { upgrade_freezes?: Record<string, unknown>[] }).upgrade_freezes ??= []);
      const i = list.findIndex((x) => x.operation_id === r.scheduled!.operation_id);
      const entry = { step: FREEZE_ROW, timelock: a.timelock, targets: r.freeze.targets, ...(await operationEvidence(r, list[i])) };
      if (i >= 0) list[i] = entry; else list.push(entry);
    }
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: FREEZE_ROW, next: "run verify: it records the freeze block and transaction of every proxy" });
    return { rows: [name], skipped: [], opIds };
  }

  if (upgrading) {
    // Issue 1842: ONE timelock call, upgradeToAndCall(new, "") on one core proxy, through the Safe. Refused before scheduling when the proxy is frozen, when the new
    // implementation's layout does not extend the deployed snapshot, or when its code is not the build. After the execute the stage manifest is re-recorded.
    const spec = upgradeSpec!;
    const implementation = getAddress(o.implementation!) as Address;
    const name = upgradeRecordKey(spec.name, implementation, o.migration);
    const t = getStageTable();
    const manifestPath = join(manifestDir(ctx), `${manifestBase(t.stages.find((x) => x.name === spec.stage)!.manifest)}.json`);
    type Upgrade = { proxy: string; from_implementation: string; from_code_hash: string | null; to_implementation: string; to_code_hash: string; build: string; migration?: MigrationRecord };
    if (!rowComplete(state[name])) {
      let plan = (state[name] as { upgrade?: Upgrade } | undefined)?.upgrade;
      if (!plan) {
        const rec = upgradeabilityRecord(name);
        const r = rec.proxies?.[spec.name];
        if (!r?.proxy) throw new PublishError("GOVERN", `--row ${UPGRADE_ROW}: upgradeability.json has no ${spec.name}. Run verify first. Nothing was scheduled.`, { row: UPGRADE_ROW });
        const proxy = getAddress(r.proxy) as Address;
        const m = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (String(m[spec.field]).toLowerCase() !== proxy.toLowerCase()) throw new PublishError("GOVERN", `--row ${UPGRADE_ROW}: ${manifestPath} names ${spec.field} ${String(m[spec.field])}, upgradeability.json ${proxy}. Nothing was scheduled.`, { row: UPGRADE_ROW });
        if (await frozenNow(proxy)) throw new PublishError("GOVERN", `--row ${UPGRADE_ROW}: ${spec.name} (${proxy}) reads upgradesFrozen() true. A frozen proxy is never upgraded again. Nothing was scheduled.`, { row: UPGRADE_ROW, proxy });
        const from = await implOf(proxy);
        if (from.toLowerCase() === implementation.toLowerCase()) throw new PublishError("GOVERN", `--row ${UPGRADE_ROW}: ${spec.name} already runs ${implementation}. Nothing was scheduled.`, { row: UPGRADE_ROW });
        const build = o.upgradeBuild ?? ctx.coreDir;
        const u = t.upgradeAuthority;
        if (!u) throw new PublishError("GOVERN", "the stage table has no upgradeAuthority (layout pins)", { row: UPGRADE_ROW });
        const layout = layoutGateProblems(spec, ctx.coreDir, build, u.layoutPins, r.layout_id);
        if (layout.length) throw new PublishError("GOVERN", `--row ${UPGRADE_ROW}: the storage layout gate refuses ${implementation} for ${spec.name}: ${layout.join("; ")}. Nothing was scheduled.`, { row: UPGRADE_ROW, layout });
        let code: string[];
        try { code = await runtimeCodeProblems(codeOf, implementation, join(build, "out"), spec.contract); } catch (e) { code = [(e as Error).message]; }
        if (code.length) throw new PublishError("GOVERN", `--row ${UPGRADE_ROW}: ${implementation} is not the build's ${spec.contract} (${join(build, "out")}): ${code.join("; ")}. Nothing was scheduled.`, { row: UPGRADE_ROW, code });
        // Issue 1910: a typed migration. The data is built here from the build ABI and the deployment's own manifest (the stage that holds the argument), never from operator hex.
        let migration: MigrationRecord | undefined;
        if (o.migration !== undefined) {
          const mig = UPGRADE_MIGRATIONS[o.migration]!;
          const argStage = t.stages.find((x) => x.name === mig.argument.manifest);
          let argument: string | undefined;
          if (argStage) {
            const argPath = join(manifestDir(ctx), `${manifestBase(argStage.manifest)}.json`);
            if (existsSync(argPath)) argument = JSON.parse(readFileSync(argPath, "utf8"))[mig.argument.field];
          }
          try { migration = buildMigration(o.migration, spec.name, join(build, "out"), argument); } catch (e) { throw new PublishError("GOVERN", `--row ${UPGRADE_ROW}: ${(e as Error).message}. Nothing was scheduled.`, { row: UPGRADE_ROW, migration: o.migration }); }
        }
        plan = { proxy, from_implementation: from, from_code_hash: codeHashOf(await codeOf(from)), to_implementation: implementation, to_code_hash: codeHashOf(await codeOf(implementation))!, build, ...(migration ? { migration } : {}) };
        ctx.log.log("info", "govern.preview", { row: UPGRADE_ROW, proxy_name: spec.name, proxy, old_implementation: plan.from_implementation, old_code_hash: plan.from_code_hash, new_implementation: implementation, new_code_hash: plan.to_code_hash,
          ...(migration ? { migration: migration.name, migration_function: `${migration.function}(${migration.argument} = ${migration.releaser})`, migration_selector: migration.selector, migration_data_hash: migration.data_hash } : { migration: null }) });
        state[name] = { ...(state[name] ?? { round: 1 }), upgrade: plan } as RowRecord;
        save();
      }
      const c = buildUpgradeCall(spec.name, plan.proxy as Address, implementation, plan.migration);
      const p = { timelock: a.timelock, calls: [{ target: c.target, data: c.data }], salt: salt(name), form: "single" as const };
      const id = await api.operationId(handle, p);
      const readBack = async () => ((await implOf(plan!.proxy as Address)).toLowerCase() === implementation.toLowerCase() ? [] : [`${spec.name} implementation slot reads ${await implOf(plan!.proxy as Address)}, want ${implementation}`]);
      await round(name, {
        id, description: `upgrade ${spec.name} to ${implementation}${plan.migration ? ` with ${plan.migration.function}` : ""}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${UPGRADE_ROW}: ${c.label}` }),
        execute: async () => {
          // a proxy frozen since the schedule would revert UpgradesAreFrozen on chain: refuse before the Safe signs
          if (await frozenNow(plan!.proxy as Address)) throw new PublishError("GOVERN", `${spec.name} was frozen after this upgrade was scheduled: the operation can never execute. Cancel it through the Safe.`, { row: UPGRADE_ROW });
          return api.executeOnTimelock(handle, { ...p, description: `${UPGRADE_ROW} execute` });
        },
      }, UPGRADE_ROW);
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, UPGRADE_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, UPGRADE_ROW, "executed", r.executed);
    }
    // the re-record (runbook 4.12, "After a governed upgrade") and the evidence entry (`proxy_upgrades` of the run manifest). Issue 1859: both are gated on the live
    // implementation slot. A rerun of this row after a later upgrade (B to C, then the B row again) finds the proxy on C: it leaves the manifest and the entry as they are,
    // so the manifest never names an implementation the proxy no longer runs. An execution adopted from the chain passed the same slot read-back in executePhase.
    const r = state[name] as RowRecord & { upgrade?: Upgrade };
    if (r.executed && r.scheduled?.operation_id && r.upgrade) {
      const live = await implOf(r.upgrade.proxy as Address);
      if (live.toLowerCase() !== implementation.toLowerCase()) {
        ctx.log.log("warn", "govern.manifest_not_rerecorded", { row: UPGRADE_ROW, proxy: spec.name, live_implementation: live, row_implementation: implementation, manifest: manifestPath, reason: "the proxy runs another implementation now (a later upgrade): the manifest and the evidence entry are left unchanged" });
      } else {
        const implHash = codeHashOf(await codeOf(implementation))!, proxyHash = codeHashOf(await codeOf(r.upgrade.proxy as Address))!;
        const fields = rerecordProxyManifest(manifestPath, spec, implementation, implHash, proxyHash);
        ctx.log.log("info", "govern.manifest_rerecorded", { row: UPGRADE_ROW, manifest: manifestPath, fields, next: "run verify: it re-records upgradeability.json" });
        const list = ((manifest as { proxy_upgrades?: Record<string, unknown>[] }).proxy_upgrades ??= []);
        const i = list.findIndex((x) => x.operation_id === r.scheduled!.operation_id);
        const entry = { step: UPGRADE_ROW, proxy_name: spec.name, ...r.upgrade, timelock: a.timelock, manifest_fields: fields, ...(await operationEvidence(r, list[i])) };
        if (i >= 0) list[i] = entry; else list.push(entry);
      }
    }
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: UPGRADE_ROW, proxy: spec.name, implementation });
    return { rows: [name], skipped: [], opIds };
  }

  if (redeploying) {
    // Issue 1796: ONE timelock batch (register, make the new vault eligible, drop and retire the old one, open the new one). Never part of the matrix.
    const records = redeploysOf(manifest);
    const rec = records.find((x) => x.status === "deployed") ?? [...records].reverse().find((x) => x.status === "governed");
    if (!rec || !rec.new_vault) throw new PublishError("USAGE", `--row ${REDEPLOY_ROW} needs a vault the redeploy-vault verb has deployed: the run manifest holds none (run: bun publish-contracts/src/cli.ts redeploy-vault --vault PROTO ...)`, { row: REDEPLOY_ROW });
    const name = redeployRecordKey(rec.key, rec.ordinal);
    const newVault = rec.new_vault, oldVault = rec.old_vault;
    if (rec.replacement_manifest) {
      const replacement = JSON.parse(readFileSync(join(manifestDir(ctx), rec.replacement_manifest), "utf8"));
      if (String(replacement.vault).toLowerCase() !== newVault.toLowerCase()) throw new PublishError("GOVERN", "replacement manifest differs from the migration record");
      a.vaults[rec.key] = newVault;
    }
    if (a.vaults[rec.key].toLowerCase() !== newVault.toLowerCase()) throw new PublishError("GOVERN", `the ${VAULT_NAME[rec.key]} manifest names ${a.vaults[rec.key]}, the redeploy record names ${newVault}: the manifests and the run manifest disagree, nothing was scheduled`, { row: REDEPLOY_ROW });
    // QA plan v1 C2 (issue 1701): both files above are editable. The vault the batch registers, opens and routes deposits to must be the contract the sheet's deployer
    // CREATED in the round's recorded deploy transactions: their receipts are read from the chain, every run, before anything is scheduled or executed.
    const deployReceipts: DeployReceipt[] = [];
    for (const hash of rec.deploy_tx_hashes ?? []) {
      try {
        const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
        deployReceipts.push({ hash, status: rc.status, from: rc.from, contractAddress: rc.contractAddress });
      } catch (e) { deployReceipts.push({ hash, status: `not readable (${(e as Error).message})` }); }
    }
    const unbound = createdVaultProblems(newVault, sheet.admin, deployReceipts);
    if (unbound.length > 0) throw new PublishError("GOVERN", `govern row ${REDEPLOY_ROW}: the run manifest names the new vault ${newVault}, and the chain does not show the deployer ${sheet.admin} created it: ${unbound.join("; ")}. Nothing was scheduled or executed by this run.`, { row: REDEPLOY_ROW, problems: unbound });
    const rd = reader(handle);
    // The operator cancelled this round's operation through the Safe and named the row again: the same round is scheduled again (a cancelled id is free).
    const prev = state[name];
    if (prev?.scheduled?.operation_id && !rowComplete(prev)) {
      const st = await api.operationState(handle, a.timelock, prev.scheduled.operation_id as Hex);
      if (!st.exists && !st.done) {
        let k = 1;
        while (state[`${name}:cancelled-${k}`]) k++;
        const keep = (prev as { redeploy?: unknown }).redeploy;
        state[`${name}:cancelled-${k}`] = prev;
        state[name] = { round: prev.round ?? 1, ...(keep ? { redeploy: keep } : {}) } as RowRecord;
        save();
        ctx.log.log("info", "govern.round_rescheduled", { row: REDEPLOY_ROW, cancelled_operation: prev.scheduled.operation_id });
      }
    }
    const conflicts = Object.entries(state).filter(([key, r]) => key !== name && !key.includes(":cancelled-") && r?.scheduled && !r.executed && !r.cancelled);
    if (conflicts.length) throw new PublishError("GOVERN", `cancel conflicting recorded governance operations before cutover: ${conflicts.map(([key]) => key).join(", ")}`);
    type Plan = { router_vault_cap: string; registry_name: string; asset: Address; vaults: Address[]; bps: number[] };
    let vec: RedeployVectors;
    if (!rowComplete(state[name])) {
      let plan = (state[name] as { redeploy?: Plan } | undefined)?.redeploy;
      if (!plan) {
        // First plan of the round: the state the batch starts from must be the state the deploy was made for, or nothing is scheduled.
        const [listed, [meta, status0], eligible0, registryRouter, tlAdmin, tlRouterAdmin, voted, [defVaults, defBps]] = await Promise.all([
          rd<Address[]>(a.registry, REGISTRY_REDEPLOY_ABI, "listVaults"),
          rd<[{ name: string; asset: Address }, number]>(a.registry, REGISTRY_REDEPLOY_ABI, "getVault", [oldVault]),
          rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "isRouterEligible", [oldVault]),
          rd<Address>(a.registry, REGISTRY_REDEPLOY_ABI, "router"),
          rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "hasRole", [ADMIN_ROLE, a.timelock]),
          // QA plan v1 E3: the batch's router.setVaultCap needs ADMIN_ROLE on the router too; DeployTimelock grants it at the timelock stage.
          rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "hasRole", [ADMIN_ROLE, a.timelock]),
          rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "votedWeightsActive"),
          rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getDefaultWeights"),
        ]);
        const oldCode = await handle.client.getCode({ address: oldVault });
        const problems = redeployBeforeProblems(oldVault, newVault, {
          listed, oldStatus: Number(status0), oldEligible: eligible0, registryRouter, router: a.router, timelockIsRegistryAdmin: tlAdmin, timelockIsRouterAdmin: tlRouterAdmin, votedWeightsActive: voted,
          defaultVaults: defVaults, defaultBps: defBps, oldHasCode: !!oldCode && oldCode !== "0x",
        });
        // the new vault must be what the deploy left: closed, unregistered (above), linked, governed by the timelock
        if (!(await rd<boolean>(newVault, VAULT_REDEPLOY_ABI, "depositsPaused"))) problems.push(`the new vault ${newVault} is not deposit-paused`);
        if (!(await rd<boolean>(newVault, VAULT_REDEPLOY_ABI, "hasRole", [ADMIN_ROLE, a.timelock]))) problems.push(`the timelock does not hold ADMIN_ROLE on the new vault ${newVault}: the batch's unpause would revert`);
        if ((await rd<Address>(newVault, VAULT_REDEPLOY_ABI, "registry")).toLowerCase() !== a.registry.toLowerCase()) problems.push(`the new vault ${newVault} is not linked to the registry`);
        if (problems.length > 0) throw new PublishError("GOVERN", `govern row ${REDEPLOY_ROW} cannot start from the state on chain: ${problems.join("; ")}. Nothing was scheduled.`, { row: REDEPLOY_ROW, problems });
        const v = planRedeployVectors({ defaultVaults: defVaults, defaultBps: defBps, oldVault, newVault });
        plan = { router_vault_cap: String(await rd<bigint>(a.router, ROUTER_REDEPLOY_ABI, "vaultCap", [oldVault])), registry_name: meta.name, asset: meta.asset, vaults: v.finalVaults, bps: v.finalBps };
        state[name] = { ...(state[name] ?? { round: 1 }), redeploy: plan } as RowRecord;
        save();
      }
      vec = vectorsFromFinal({ finalVaults: plan.vaults, finalBps: plan.bps, oldVault, newVault });
      const calls = buildRedeployCalls({ router: a.router, routerVaultCap: BigInt(plan.router_vault_cap), registry: a.registry, oldVault, newVault, registryName: plan.registry_name, asset: plan.asset, finalVaults: plan.vaults, finalBps: plan.bps });
      // QA plan v1 E1: the salt is the ROUND's sha (the one the verb deployed at), never the run's: a schedule at one sha and a resume at another name the same operation.
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: governSalt(rec.core_sha || ctx.coreSha, ctx.chainId, name), form: "batch" as const };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: REDEPLOY_ROW, prior, id });
      // QA plan v1 C2: the Safe transaction the owners sign names both addresses, not only the call labels.
      const swap = `${VAULT_NAME[rec.key]} old ${oldVault} -> new ${newVault}`;
      const readBack = async () => {
        const [oldMeta, oldStatus] = await rd<[unknown, number]>(a.registry, REGISTRY_REDEPLOY_ABI, "getVault", [oldVault]);
        const [, newStatus] = await rd<[unknown, number]>(a.registry, REGISTRY_REDEPLOY_ABI, "getVault", [newVault]);
        void oldMeta;
        const [defaultVaults, defaultBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getDefaultWeights");
        const [effectiveVaults, effectiveBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getEffectiveWeights");
        const votedWeightsActive = await rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "votedWeightsActive");
        const oldCode = await handle.client.getCode({ address: oldVault });
        const bad = redeployReadBackProblems(vec, {
          oldStatus: Number(oldStatus), newStatus: Number(newStatus),
          oldEligible: await rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "isRouterEligible", [oldVault]), newEligible: await rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "isRouterEligible", [newVault]),
          eligibleCount: Number(await rd<bigint>(a.registry, REGISTRY_REDEPLOY_ABI, "routerEligibleCount")), votedWeightsActive,
          defaultVaults, defaultBps, effectiveVaults, effectiveBps,
          newPaused: await rd<boolean>(newVault, VAULT_REDEPLOY_ABI, "depositsPaused"), oldRetiredFlag: await rd<boolean>(oldVault, VAULT_REDEPLOY_ABI, "retired"), oldHasCode: !!oldCode && oldCode !== "0x",
        });
        if (await rd<bigint>(a.router, ROUTER_REDEPLOY_ABI, "vaultCap", [newVault]) !== BigInt(plan!.router_vault_cap)) bad.push("new router cap differs from the approved old cap");
        if (bad.length === 0) (state[name] as { observed?: unknown }).observed = { voted_weights_active: votedWeightsActive, effective_vaults: [...effectiveVaults], effective_bps: effectiveBps.map(Number), old_status: STATUS_NAME[Number(oldStatus)], new_status: STATUS_NAME[Number(newStatus)] };
        return bad;
      };
      await round(name, {
        id, description: `redeploy ${VAULT_NAME[rec.key]}: ${oldVault} to ${newVault}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${REDEPLOY_ROW} ${swap}: ${calls.map((c) => c.label).join("; ")}` }),
        execute: async () => {
          // Re-read immediately before public execution; a saved plan is no authority to execute stale state.
          const [listed, [, status], eligible, voted, [defaults, weights]] = await Promise.all([
            rd<Address[]>(a.registry, REGISTRY_REDEPLOY_ABI, "listVaults"),
            rd<[unknown, number]>(a.registry, REGISTRY_REDEPLOY_ABI, "getVault", [oldVault]),
            rd<boolean>(a.registry, REGISTRY_REDEPLOY_ABI, "isRouterEligible", [oldVault]),
            rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "votedWeightsActive"),
            rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getDefaultWeights"),
          ]);
          if (listed.some((v) => v.toLowerCase() === newVault.toLowerCase()) || Number(status) !== 0 || !eligible || voted || JSON.stringify(defaults.map((v) => v.toLowerCase())) !== JSON.stringify(vec.preVaults.map((v) => v.toLowerCase())) || weights.map(String).join() !== vec.preBps.map(String).join() || !(await rd<boolean>(newVault, VAULT_REDEPLOY_ABI, "depositsPaused")) || String(await rd<bigint>(a.router, ROUTER_REDEPLOY_ABI, "vaultCap", [oldVault])) !== plan!.router_vault_cap) throw new PublishError("GOVERN", "cutover preflight changed after schedule; cancel the stale operation before repair");
          return api.executeOnTimelock(handle, { ...p, description: `${REDEPLOY_ROW} execute ${swap}` });
        },
      }, REDEPLOY_ROW);
    } else {
      const done = state[name] as RowRecord & { redeploy?: Plan };
      if (!done.redeploy) throw new PublishError("GOVERN", `the run manifest holds an executed ${name} with no recorded vector: it cannot be read back`, { row: REDEPLOY_ROW });
      vec = vectorsFromFinal({ finalVaults: done.redeploy.vaults, finalBps: done.redeploy.bps, oldVault, newVault });
      if (done.scheduled) emitPhase(o, REDEPLOY_ROW, "scheduled", done.scheduled);
      if (done.executed) emitPhase(o, REDEPLOY_ROW, "executed", done.executed);
    }
    await recordRedeploy(name, rec, vec);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: REDEPLOY_ROW, old_vault: oldVault, new_vault: newVault });
    return { rows: [name], skipped: [], opIds };
  }

  if (applying) {
    // Issue 1696, issue 1698: ONE timelock call, RouterGovernance.applyReceipt, which releases the receipt and sets the router's active vector together. Never part of the
    // matrix, on 8453 only when named with a receipt id and a payload.
    if (o.receiptId === undefined) throw new PublishError("USAGE", `--row ${APPLY_ROW} needs --receipt-id 0x<bytes32>`);
    if (o.payload === undefined) throw new PublishError("USAGE", `--row ${APPLY_ROW} needs --payload FILE (the receipt payload, whose receipt digest, keccak256 of the domain line + the canonical bytes, is the digest the receipt stored)`);
    const receiptId = assertReceiptId(o.receiptId);
    let payload: Uint8Array;
    try { payload = new Uint8Array(readFileSync(o.payload)); } catch (e) { throw new PublishError("USAGE", `--payload ${o.payload} is not readable: ${(e as Error).message}`); }
    const receipt = loadReceiptAddr(ctx);
    const governance = a.governance;
    const name = applyRecordKey(receiptId);
    // The operator cancelled this round's operation through the Safe and named the row again: the same round is scheduled again (a cancelled id is free), with a newer seq.
    const cur = state[name];
    if (cur?.scheduled?.operation_id && !rowComplete(cur)) {
      const st = await api.operationState(handle, a.timelock, cur.scheduled.operation_id as Hex);
      if (!st.exists && !st.done) {
        let k = 1;
        while (state[`${name}:cancelled-${k}`]) k++;
        state[`${name}:cancelled-${k}`] = cur;
        state[name] = { round: cur.round ?? 1 };
        save();
        ctx.log.log("info", "govern.round_rescheduled", { row: APPLY_ROW, receipt_id: receiptId, cancelled_operation: cur.scheduled.operation_id });
      }
    }
    const rd = reader(handle);
    if (!rowComplete(state[name])) {
      const recorded = await rd<boolean>(receipt, RECEIPT_ABI, "isRecorded", [receiptId]);
      const released = recorded ? await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId]) : false;
      const rec = recorded ? await rd<{ payloadDigest: Hex; recordedAt: bigint }>(receipt, RECEIPT_RECORD_ABI, "getReceiptById", [receiptId]) : undefined;
      const stored = rec?.payloadDigest;
      // Issue 1831: applyReceipt is monotonic in recordedAt. A receipt not recorded after the last applied one is refused here, before the Safe schedules it.
      const lastApplied = recorded ? await rd<bigint>(governance, GOVERNANCE_LAST_APPLIED_ABI, "lastAppliedRecordedAt") : undefined;
      const listed = await rd<Address[]>(a.registry, REGISTRY_ELIGIBLE_ABI, "listVaults");
      const eligible: Address[] = [];
      for (const v of listed) if (await rd<boolean>(a.registry, REGISTRY_ELIGIBLE_ABI, "isRouterEligible", [v])) eligible.push(v);
      const vec = planApply({ receiptId, payload, recorded, released, storedDigest: stored, recordedAt: rec?.recordedAt, lastAppliedRecordedAt: lastApplied, eligible, vaultOf: a.vaults, inFlight: state[name]?.scheduled !== undefined });
      const call = buildApplyCall(governance, receiptId, receiptPayloadDigest(payload), vec);
      const p = { timelock: a.timelock, calls: [{ target: call.target, data: call.data }], salt: salt(name), form: "single" as const };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: APPLY_ROW, receipt_id: receiptId, prior, id });
      const readBack = async () => {
        const [activeVaults, activeBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_WEIGHTS_ABI, "getWeights");
        const [effectiveVaults, effectiveBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_WEIGHTS_ABI, "getEffectiveWeights");
        const votedWeightsActive = await rd<boolean>(a.router, ROUTER_WEIGHTS_ABI, "votedWeightsActive");
        const bad = applyReadBackProblems(receiptId, await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId]), { activeVaults, activeBps, effectiveVaults, effectiveBps, votedWeightsActive }, vec);
        // the evidence records what the read-back saw, so a later change of the router never rewrites the entry
        if (bad.length === 0) state[name]!.observed = { voted_weights_active: votedWeightsActive, effective_vaults: [...effectiveVaults], effective_bps: effectiveBps.map(Number) };
        return bad;
      };
      state[name] = { ...(state[name] ?? { round: 1 }), apply: { vaults: vec.vaults, bps: vec.bps, payload_digest: receiptPayloadDigest(payload) } };
      await round(name, {
        id, description: `apply receipt ${receiptId}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${APPLY_ROW}: ${call.label}` }),
        execute: async () => {
          // Issue 1796: the operation is not done, so a receipt that reads released was released by another path after the schedule (a stale operation): applyReceipt would revert.
          if (await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId])) throw new PublishError("GOVERN", `govern row ${name} will NOT execute: receipt ${receiptId} was released after operation ${id} was scheduled. Nothing was sent. Cancel the operation through the Safe on the timelock.`, { row: APPLY_ROW, receipt_id: receiptId, operation_id: id });
          // Issue 1831: a newer receipt was applied after this one was scheduled, so applyReceipt would revert ReceiptNotNewerThanApplied.
          const at = (await rd<{ recordedAt: bigint }>(receipt, RECEIPT_RECORD_ABI, "getReceiptById", [receiptId])).recordedAt;
          const last = await rd<bigint>(governance, GOVERNANCE_LAST_APPLIED_ABI, "lastAppliedRecordedAt");
          if (at <= last) throw new PublishError("GOVERN", `govern row ${name} will NOT execute: ${notNewerMessage(receiptId, at, last)} Cancel operation ${id} through the Safe on the timelock.`, { row: APPLY_ROW, receipt_id: receiptId, operation_id: id });
          return api.executeOnTimelock(handle, { ...p, description: `${APPLY_ROW} execute` });
        },
      }, APPLY_ROW);
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, APPLY_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, APPLY_ROW, "executed", r.executed);
    }
    await recordApplication(name, receiptId, governance);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: APPLY_ROW, receipt_id: receiptId });
    return { rows: [name], skipped: [], opIds };
  }

  /**
   * The evidence entry of an executed apply round (`receipt_applications` of the run manifest, checked by evidence-check). The block timestamps are read from
   * the chain, from the receipt of each Safe transaction. A round adopted from the chain with no transaction of its own writes no entry.
   */
  async function recordApplication(name: string, receiptId: Hex, governance: Address): Promise<void> {
    const r = state[name]!;
    if (!r.executed?.tx_hash || !r.scheduled?.tx_hash || !r.apply) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    const entry = {
      step: APPLY_ROW, receipt_id: receiptId, target: governance, governance, vaults: r.apply.vaults, bps: r.apply.bps, payload_digest: r.apply.payload_digest,
      // issue 1743: the EFFECTIVE weights the read-back saw after the execute, and the active-vector flag (true: applyReceipt sets the active vector, issue 1698)
      voted_weights_active: r.observed?.voted_weights_active, effective_vaults: r.observed?.effective_vaults, effective_bps: r.observed?.effective_bps,
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    };
    const list = ((manifest as { receipt_applications?: { receipt_id?: string }[] }).receipt_applications ??= []);
    const i = list.findIndex((x) => x.receipt_id?.toLowerCase() === receiptId.toLowerCase());
    if (i >= 0) list[i] = entry; else list.push(entry);
    save();
  }

  if (releasing) {
    if (o.receiptId === undefined) throw new PublishError("USAGE", `--row ${RECEIPT_ROW} needs --receipt-id 0x<bytes32>`);
    const receiptId = assertReceiptId(o.receiptId);
    const receipt = loadReceiptAddr(ctx);
    // Issue 1831, amended by issue 1888: RouterGovernance holds the receipt's RECEIPT_RELEASER_ROLE (the narrow role, never ADMIN_ROLE), so a receipt is released only by applying
    // it: the timelock holds no release role, and a release alone would burn the receipt (applyReceipt then reverts ReceiptAlreadyReleased). A proxy not yet migrated still has
    // RouterGovernance as an ADMIN_ROLE holder, which refuses for the same reason. Refused before anything is scheduled.
    const rdRole = reader(handle);
    const narrow = await rdRole<boolean>(receipt, ROLE_ABI, "hasRole", [RECEIPT_RELEASER_ROLE, a.governance]);
    if (narrow || await rdRole<boolean>(receipt, ROLE_ABI, "hasRole", [ADMIN_ROLE, a.governance])) {
      throw new PublishError("USAGE", `--row ${RECEIPT_ROW} is refused: RouterGovernance ${a.governance} holds the receipt contract's ${narrow ? "RECEIPT_RELEASER_ROLE" : "ADMIN_ROLE"}, so a receipt is released only by applying it (the timelock cannot release directly). A release alone would burn receipt ${receiptId} (applyReceipt then reverts ReceiptAlreadyReleased). Use --row ${APPLY_ROW} --receipt-id ${receiptId} --payload FILE. Nothing was sent.`, { row: RECEIPT_ROW, receipt_id: receiptId, governance: a.governance });
    }
    const name = releaseRecordKey(receiptId);
    const c = buildReleaseCall(receipt, receiptId);
    const p = { timelock: a.timelock, calls: [{ target: c.target, data: c.data }], salt: salt(name), form: "single" as const };
    const id = await api.operationId(handle, p);
    // The receipt id is the salt input, so one receipt is one operation. A record under this key for a different operation (another receipt
    // contract, say) would adopt the wrong round: refuse it, as the generic call refuses a reused label with different calldata.
    const prior = state[name]?.scheduled?.operation_id;
    if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: RECEIPT_ROW, receipt_id: receiptId, prior, id });
    const rd = reader(handle);
    const readBack = async () => ((await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId])) ? [] : [`receipt.isReleased(${receiptId}) is false`]);
    if (!rowComplete(state[name])) {
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, id)).exists) {
        // Nothing of this round exists yet. Refuse a round whose execute can only revert, before the Safe schedules it and the delay is spent.
        if (!(await rd<boolean>(receipt, RECEIPT_ABI, "isRecorded", [receiptId]))) throw new PublishError("GOVERN", `receipt ${receiptId} is not recorded on ${receipt}: nothing to release`, { receipt_id: receiptId });
        if (await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId])) throw new PublishError("GOVERN", `receipt ${receiptId} is already released on ${receipt}, not by this row's operation: nothing to schedule`, { receipt_id: receiptId });
      }
      await round(name, {
        id, description: `release receipt ${receiptId}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${RECEIPT_ROW}: ${c.label}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${RECEIPT_ROW} execute` }),
      }, RECEIPT_ROW);
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, RECEIPT_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, RECEIPT_ROW, "executed", r.executed);
    }
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: RECEIPT_ROW, receipt_id: receiptId });
    return { rows: [name], skipped: [], opIds };
  }

  if (o.call) {
    const { label, target, data } = o.call;
    if (!/^[A-Za-z0-9._-]+$/.test(label) || (GOVERN_ROWS as readonly string[]).includes(label) || label === RECEIPT_ROW || label === APPLY_ROW || label === REGISTER_ROW || label === CLEAR_ROW || label === REDEPLOY_ROW || label === RETIRE_ROW || label === UNWIND_GUARD_ROW) throw new PublishError("USAGE", `call label '${label}': letters, digits, . _ - only, and not a govern row name`);
    const name = `call-${label}`;
    const p = { timelock: a.timelock, calls: [{ target, data }], salt: salt(name), form: "single" as const };
    const id = await api.operationId(handle, p);
    // The label is the salt, so one label is one operation. A second, different call under a used label would adopt the first call's record (and its spent or reverted operation): refuse it.
    const prior = state[name]?.scheduled?.operation_id;
    if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `call label '${label}' was already used for a different call (operation ${prior}, this call is ${id}): use a unique label per call`, { label, prior, id });
    if (!rowComplete(state[name])) {
      await round(name, {
        id, description: `generic call ${label} to ${target}`,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${name}: ${label}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${name} execute` }),
        readBack: async () => [],
      });
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, name, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, name, "executed", r.executed);
    }
    save();
    return { rows: [name], skipped: [], opIds };
  }

  if (selfAdminRow !== undefined) {
    const args = o.selfAdmin ?? {};
    const rd = reader(handle);
    const live: SafeRoster = { owners: await rd<Address[]>(a.safe, SAFE_ADMIN_ABI, "getOwners"), threshold: await rd<bigint>(a.safe, SAFE_ADMIN_ABI, "getThreshold") };
    /** The records of this row that want the same change (`selfAdminWantKey`), newest Safe nonce first. */
    const recordsOf = (wantKey: string) => Object.entries(state).filter(([k, r]) => k.startsWith(`${selfAdminRow}-`) && r.admin?.want === wantKey).sort(([, x], [, y]) => (y.admin?.nonce ?? 0) - (x.admin?.nonce ?? 0));
    /** A change that already reads in effect with no record of it (another tool made it, or this tool crashed between the execute and the save): nothing to send. */
    const skipInEffect = (wantKey: string, nonce: number, reason: string): GovernResult => {
      const name = `${selfAdminRow}-${keccak256(toBytes(wantKey)).slice(2, 10)}-n${nonce}`;
      state[name] = { admin: { nonce, want: wantKey }, skipped: { at: new Date().toISOString(), reason } };
      save();
      ctx.log.log("info", "govern.row_skipped", { row: name, reason });
      return { rows: [name], skipped: [name], opIds };
    };
    if (isSafeAdminRow(selfAdminRow)) {
      const want = parseSafeAdminArgs(selfAdminRow, args);
      const wantKey = selfAdminWantKey(want);
      const nonce = await handle.nonce();
      // The read-back against the row's own arguments, BEFORE the send: a change already in effect is a rerun (reprint its record) or a skip (no record), never a second transaction.
      const before = safeAdminEffect(want, live);
      if (before.owner && before.threshold) {
        const prior = recordsOf(wantKey)[0];
        if (prior) { reprint(prior[0]); save(); return { rows: [prior[0]], skipped: [], opIds }; }
        return skipInEffect(wantKey, nonce, `already in effect on chain: ${describeSafeAdminWant(want)} (no record of it in this run manifest)`);
      }
      if (before.owner && !before.threshold && "threshold" in want && want.row !== "safe-change-threshold") {
        throw new PublishError("USAGE", `--row ${selfAdminRow}: the owner change is already in effect (${describeSafeAdminWant(want)}), only the threshold differs (${before.problems.join(", ")}). The Safe would revert the call: run --row safe-change-threshold --admin-arg threshold=${want.threshold} instead`, { row: selfAdminRow, problems: before.problems });
      }
      // The Safe's own rules (OwnerManager), checked before anything is proposed or signed: a call the Safe would revert is never sent.
      const rule = safeRuleProblem(want, live, a.safe);
      if (rule !== undefined) throw new PublishError("USAGE", `--row ${selfAdminRow} would be reverted by the Safe: ${rule}. Nothing was sent`, { row: selfAdminRow, problem: rule, owners: live.owners.length, threshold: live.threshold.toString() });
      const c = buildSelfAdminCall(selfAdminRow, a, args, live.owners);
      const name = selfAdminRecordKey(selfAdminRow, c.data, nonce);
      const bundle = await (api.proposeTx ?? proposeTx)(handle, { to: a.safe, data: c.data, action: selfAdminRow, description: c.label });
      const done = await signAndExecute(ctx, o, api, handle, bundle);
      const after: SafeRoster = { owners: await rd<Address[]>(a.safe, SAFE_ADMIN_ABI, "getOwners"), threshold: await rd<bigint>(a.safe, SAFE_ADMIN_ABI, "getThreshold") };
      const bad = safeAdminEffect(want, after).problems;
      if (bad.length) throw new PublishError("GOVERN", `govern row ${selfAdminRow} read-back failed: ${bad.join(", ")}`, { bad });
      const ex: PhaseRecord = { at: new Date().toISOString(), ...note(done) };
      state[name] = { admin: { data: c.data, nonce, want: wantKey }, executed: ex };
      save();
      ctx.log.log("info", "govern.sheet_update_needed", { row: selfAdminRow, owners: after.owners, threshold: after.threshold.toString(), hint: "update SAFE_OWNERS and SAFE_THRESHOLD in the sheet to these values (runbook section 9)" });
      emitPhase(o, selfAdminRow, "executed", ex);
      save();
      return { rows: [name], skipped: [], opIds };
    }
    const c = buildSelfAdminCall(selfAdminRow, a, args, live.owners);
    const decoded = decodeFunctionData({ abi: ROLE_ABI, data: c.data });
    const [role, account] = decoded.args as [Hex, Address];
    const wantKey = selfAdminWantKey({ row: selfAdminRow, role, account });
    const readBack = async () => {
      const has = await rd<boolean>(a.timelock, ROLE_ABI, "hasRole", [role, account]);
      return has === (selfAdminRow === "timelock-grant-role") ? [] : [`timelock.hasRole(${role}, ${account}) is ${has}`];
    };
    // A round scheduled by an earlier run and not yet executed resumes under its own key (the salt, so the operation id, is the key's).
    const open = recordsOf(wantKey).find(([, r]) => !rowComplete(r));
    let name: string;
    if (open) name = open[0];
    else {
      const inEffect = (await readBack()).length === 0;
      if (inEffect) {
        const prior = recordsOf(wantKey)[0];
        if (prior) { reprint(prior[0]); save(); return { rows: [prior[0]], skipped: [], opIds }; }
        return skipInEffect(wantKey, await handle.nonce(), `already in effect on chain: ${c.label} (no record of it in this run manifest)`);
      }
      // The chain would refuse it too (ProposerFloorTimelock.LastProposerFloor), at execute, after a Safe transaction and a delay: refuse before anything is sent (QA plan v1 B3).
      if (selfAdminRow === "timelock-revoke-role") await assertNotLastProposer(rd, a.timelock, role, account);
      const nonce = await handle.nonce();
      name = selfAdminRecordKey(selfAdminRow, c.data, nonce);
      // saved before the schedule is sent: a crash between the send and the phase record still finds this key, so the resume adopts the operation (same salt) instead of scheduling a second one
      state[name] = { admin: { data: c.data, nonce, want: wantKey } };
      save();
    }
    const p = { timelock: a.timelock, calls: [{ target: c.target, data: c.data }], salt: salt(name), form: "single" as const };
    const id = await api.operationId(handle, p);
    await round(name, {
      id, description: c.label,
      schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${selfAdminRow}: ${c.label}` }),
      execute: () => api.executeOnTimelock(handle, { ...p, description: `${selfAdminRow} execute` }),
      readBack,
    }, selfAdminRow);
    save();
    return { rows: [name], skipped: [], opIds };
  }

  // The unpauses are one set: they have no order among themselves. A single --row unpause-X is the set of one.
  const wanted: readonly PlannedRow[] = selected === undefined ? stageRows(ctx.chainId) : [selected];
  const unpauses = wanted.filter((n) => !isTwinOnlyRow(n));
  if (unpauses.length) await runSet(unpauses, selected);
  // The Twin-only demonstrations run one round at a time, in order, after every unpause is complete.
  for (const name of wanted.filter((n) => isTwinOnlyRow(n))) {
    if (rowComplete(state[name])) { ctx.log.log("info", "govern.row_complete", { row: name }); reprint(name); continue; }
    const idx = GOVERN_ROWS.indexOf(name as GovernRowName);
    const open = GOVERN_ROWS.slice(0, idx).find((n) => !rowComplete(state[n]));
    if (open) throw new PublishError("GOVERN", `govern row ${name} cannot start: row ${open} is not complete. The Twin-only rows run one round at a time, after the unpauses. Run ${open} first.`, { row: name, blocked_by: open });
    const p = await plan(name);
    if (typeof p === "string") throw new PublishError("GOVERN", `govern row ${name} has nothing to run: ${p}`, { row: name });
    await round(name, p);
    ran.push(name);
    ctx.log.log("info", "govern.row_done", { row: name });
  }

  // a single-row run leaves the stage open: only a run that finds every row of this chain complete marks govern done
  if (stageRows(ctx.chainId).every((n) => rowComplete(state[n]))) {
    if (!manifest.stages[row.name] || manifest.stages[row.name]!.status !== "done") {
      manifest.stages[row.name] = { status: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: Object.keys(state).length };
    }
  }
  save();
  ctx.log.log("info", selected === undefined ? "stage.done" : "govern.row_run_done", { stage: row.name, row: selected });
  return { rows: ran, skipped, opIds };
}
