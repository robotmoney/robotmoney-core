// Stage 13 govern: the post-handover operations through the REAL Safe and the REAL timelock, with the Safe tool (src/safe).
// After the timelock stage the deployer holds no role. Everything here is a Safe transaction that schedules, executes or cancels a timelock operation.
// STAGE 13 IS THE FOUR VAULT UNPAUSES (issue 1520 retired the older 13-row stage 13; issue 1710 added rmUSDC: all four deploy paused). The rows come from the
// stage table's vault rules (issue 1705, src/vault-rules.ts), never from a vault literal here. Unpause needs ADMIN_ROLE through the timelock
// (docs/technical/security-model.md, the pause-key abuse and pause-trigger rows). The on-demand rows below (apply-receipt, set-unwind-guard, ...) are not stage 13. The vault
// setters, router eligibility and the router default weights are DEPLOY-TIME configuration the deployer sets before the handover (the basket vault
// stages), and the verify stage asserts them against the sheet. The governance stage deploys the weight setter (RouterGovernance) with no voting surface
// (issue 1698): no voter list, voting power, quorum, voting period or execution delay exists on the contract, and the sheet's legacy names for them are ignored. There is no voting by anyone.
// ROUTER WEIGHTS CHANGE ON DEMAND THROUGH ONE ROW, apply-receipt (core 1696, issue 1698): the Safe, through the timelock, is the only body that changes any
// contract configuration, router weights included. WEIGHT_SETTER_ROLE is the only authority over router weights and it applies the Investment
// Committee's consensus receipt; that application is the rebalance: ONE timelock call, RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps),
// which releases the receipt on the register and writes the vector to the router in one transaction, read back as isReleased and the router's EFFECTIVE weights. Never part of stage 13.
// The rows (GOVERN_ROWS):
//   unpause-USDC, unpause-PROTO, unpause-AGENT, unpause-RWA   one timelock operation per unpause (never a shared operation), all scheduled in ONE sitting.
//                                               All four vaults deploy paused (issue 1710), so stage 13 opens all four. After a pause-all the same rows reopen a vault
//                                               on demand (`--row unpause-X`, a new numbered round, issue 1667).
//   update-delay, batch, cancel                 Demonstrations of the Safe tool. Refused with USAGE on 8453, except in a REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal, issue 1727):
//                                               there they run on 8453 as explicit `--row` runs, in order after the four unpauses, never as part of stage 13.
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
// revoke (and a renounce) with LastProposerFloor, so the governed contracts can never be left with no proposer (CS-3). Grant a second proposer first.
//   release-receipt              ConsensusRecommendationReceipt.releaseReceipt(receiptId), one round per receipt id (--receipt-id)
// The receipt contract's ADMIN_ROLE is held by the TimelockController after the timelock stage (INV-3), so the release is the same Safe ->
// Timelock round as every other row. It runs on the Twin chain AND on 8453 (issue 1611): on 8453 it is a standalone post-launch action, its own
// timelock operation with its own 48-hour delay, never part of stage 13 (stageRows stays the four unpauses). The first run schedules and exits
// GOVERN_PENDING with the resume command, the resume after the delay executes and reads isReleased back. Its run-manifest key and salt are `release-receipt-<receiptId>`.
//   apply-receipt                the rebalance (issue 1696, issue 1698): ONE timelock call, RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps) (--receipt-id, --payload FILE),
// which releases the receipt on the register and writes the receipt's vector to the router (setWeights) in one transaction. Before anything is sent it checks: the receipt is recorded, its
// stored digest equals the receipt digest (keccak256 of the domain line + the canonical bytes, receipt-digest.ts) of the payload bytes, the vector sums to 10000 bps and lists exactly the
// registry's router-eligible vaults in registry order, and the receipt is not released. It also checks, before the schedule and again before the execute, that the weight setter is
// wired to that register (receiptContract() names it and governance holds its ADMIN_ROLE; GOVERN, nothing sent), so a miss is not a revert one delay later.
// The chain checks the receipt state and the digest again (ReceiptDigestMismatch). After the real delay
// the Safe executes the call and the tool reads isReleased and the router's EFFECTIVE weights (what deposits route by, issue 1743) back. No vote. Never part of stage 13: on 8453 only
// `--row apply-receipt` names it (own 172800 s delay). Its run-manifest key and salt are `apply-receipt-<receiptId>`. A Twin run proves the row executes on the real contracts, not that
// mainnet governance works. The applied vector is the router's ACTIVE vector (votedWeightsActive reads true afterwards; the storage keeps its pre-1698 name): an active vector from an
// earlier receipt is replaced, never a refusal. The DEFAULT vector (the deploy-time fallback) is not touched.
//   clear-voted-weights          on demand (issue 1743), no arguments: ONE timelock call, RouterGovernance.clearVotedWeights() (ADMIN_ROLE, the timelock), which drops the router's active
// (applied receipt) vector so routing falls back to the default: the emergency lever. It reads votedWeightsActive false and effective == default back. Refused (GOVERN, nothing scheduled)
// when no active vector is set. Runs on 8453 in production and in a rehearsal, never in stage 13, with its own delay. A later applied receipt opens round 2 with the same explicit `--row`.
//   set-unwind-guard             on demand (QA plan v1 D7, review E5, issue 1705 Q2), `--admin-arg vault=PROTO|AGENT|RWA token=0x..|all min-usdc-out=N max-loss-bps=N [override-allowed=true|false]`:
// ONE timelock operation on one basket vault, BasketVault.setEmergencyUnwindGuard(token, minUsdcOut, overrideAllowed, maxLossBps) per token (ADMIN_ROLE, the timelock). Before it no stage
// and no row set the guard, so the oracle-free unwind and emergencyUnwindWithOverride could not run. overrideAllowed defaults to true, set by the Safe only (QA plan v1 Decisions D3).
// Refused (GOVERN, nothing scheduled) for a token that is not an active asset or a vault whose ADMIN_ROLE the timelock does not hold; a guard already in effect is recorded as
// skipped. It reads each guard back. Runs on 8453 in production and in a rehearsal, never in stage 13; the stage 12 verifier requires a non-zero minUsdcOut on every active asset
// of an OPEN basket, so it runs in the same sitting as the unpauses. unwind-guard.ts has the why. Evidence: the run manifest's `unwind_guards` (a record).
//   upgrade-proxy                on demand (issue 1809, ADR-0014 §4), `--admin-arg proxy=<name> implementation=0x.. [call=0x..] [build=DIR]`: ONE timelock operation,
// proxy.upgradeToAndCall(implementation, call) on one governed proxy (the timelock is its upgrade authority, set once; no role and no EOA can upgrade). Refused (GOVERN, nothing
// scheduled) when the proxy is frozen, its authority is not the timelock, an ERC-1967 admin or beacon slot is set, or the target has no code, is no UUPS implementation, has
// unlocked initializers or differs from the build artifact (DIR, default the checkout's out/). An implementation the proxy already runs is recorded as skipped. It reads the
// implementation slot back. Every chain and kind, never in stage 13; the 48 hour delay is the holders' window, withdrawals stay open the whole time (ADR-0014 §6).
// Evidence: the run manifest's `proxy_upgrades`.
//   freeze-proxy                 on demand (issue 1809, ADR-0014 §5), `--admin-arg proxy=<name>|all [build=DIR]`: ONE timelock operation, proxy.freezeUpgrades(liveImplementation,
// liveCodeHash) on one proxy or (all) on every proxy not yet frozen, the arguments read from the chain when the round is planned. One-way: nothing unfreezes. Refused when the live
// implementation is not the reviewed build, the authority is not the timelock, an admin or beacon slot is set, or an upgrade-proxy round of the proxy is scheduled and not executed.
// A proxy already frozen (frozen-at-deploy) is skipped. It reads upgradesFrozen() back. Every chain and kind, never in stage 13. Evidence: the run manifest's `proxy_freezes`.
// upgrade-rows.ts has the checks. The stage 12 verifier then expects each upgraded proxy's slot on the upgrade's target and each frozen proxy frozen.
//   redeploy-vault              on demand (issue 1796), no arguments: the Safe, through the timelock, replaces ONE vault of the live deployment (rmPROTO) with the one the `redeploy-vault`
// verb deployed. ONE timelock batch of seven calls (new.setRegistry(registry), registry.registerVault(new), router.setVaultCap(new, vaultCap(old)), registry.migrateEligibility(new, true,
// five legs), registry.migrateEligibility(old, false, four legs), registry.retire(old), new.unpauseDeposits()) so no observer sees a router that weights a paused, retired or uncapped vault.
// The registry link is the batch's, not the deploy script's (core S5: only DeployTimelock links from a script), and the timelock holds the ADMIN_ROLE that gates it. The cap is the old
// vault's `router.vaultCap`, read when the round is planned and kept in the plan (QA plan v1 E3): a new address reads 0, uncapped. The order is forced by the contracts (a vault must be made
// router-ineligible before it is retired, and the router's default vector must span the eligible set), see redeploy-vault.ts. The read-back checks the registry statuses, the
// eligibility, the new vault's registry link, router.vaultCap(new) == router.vaultCap(old), the router's DEFAULT and EFFECTIVE vectors and the vaults' deposit state. Rehearsal (DEPLOYMENT_KIND=rehearsal) and the Twin chain only: refused on 8453 in production.
// The new vault is bound to the chain, not to the run manifest (QA plan v1 C2): it must be the contract a recorded deploy transaction of the sheet's deployer CREATED (the
// receipt's contractAddress), and the Safe transaction's description names the old and the new address. Never part of stage 13. Its run-manifest key and salt are `redeploy-vault-<KEY>-<ordinal>`; the evidence entry is the `vault_redeploys` entry the verb started.
// It runs at the original deployment sha or at the sha the verb ran at (the round's `core_sha`, QA plan v1 E1); the salt takes the round's sha, so both name one operation.
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
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiItem, toBytes, toHex, type AbiFunction, type Address, type Hex } from "viem";
import { receiptPayloadDigest } from "./receipt-digest.ts";
import {
  APPLY_ROW, GOVERNANCE_WIRING_ABI, REGISTRY_ELIGIBLE_ABI, RECEIPT_RECORD_ABI, RECEIPT_ROLE_ABI, ROUTER_WEIGHTS_ABI, applyReadBackProblems, applyRecordKey, applyWiringProblems, buildApplyCalls, planApply,
} from "./apply-receipt.ts";
import { CLEAR_ROW, buildClearCall, clearReadBackProblems } from "./clear-voted-weights.ts";
import {
  UNWIND_GUARD_ROW, VAULT_UNWIND_GUARD_ABI, buildUnwindGuardCalls, parseUnwindGuardArgs, unwindGuardArgsText, unwindGuardProblems, unwindGuardRecordKey, unwindGuardTargets,
  type GuardRead, type UnwindGuardArgs, type UnwindGuardWant,
} from "./unwind-guard.ts";
import {
  REDEPLOY_ROW, REGISTRY_REDEPLOY_ABI, ROUTER_REDEPLOY_ABI, VAULT_REDEPLOY_ABI, STATUS_NAME, ZERO, buildRedeployCalls, createdVaultProblems, planRedeployVectors, redeployBeforeProblems, redeployReadBackProblems,
  redeployRecordKey, redeployRefusal, redeploysOf, vectorsFromFinal, type DeployReceipt, type RedeployRecord, type RedeployVectors,
} from "./redeploy-vault.ts";
import { PublishError } from "./errors.ts";
import {
  FREEZE_KEYS, FREEZE_ROW, UPGRADE_KEYS, UPGRADE_ROW, buildFreezeCall, buildUpgradeCall, freezeArgsText, freezeReadBackProblems, freezeRecordKey, freezeRefusals, freezeTargetOf, parseFreezeArgs,
  parseUpgradeArgs, upgradeArgsText, upgradeReadBackProblems, upgradeRecordKey, upgradeRefusals, type FreezeArgs, type FreezeWant, type ImplementationRead, type UpgradeArgs, type UpgradeWant,
} from "./upgrade-rows.ts";
import { INITIALIZABLE_SLOT, PROXIABLE_UUID_SIG, ZERO_WORD, initializableOf, readProxyState, type ProxyState } from "./proxies.ts";
import { proxyByName, tableProxies, type TableProxy } from "./stage-table.ts";
import { compareCodeAndLinks, loadArtifact, type CodeHashResult } from "./verify/codehash.ts";
import type { ChainReader } from "./verify/types.ts";
import { join } from "node:path";
import {
  REGISTER_ROW, COMMIT_EXPIRY_BLOCKS, COMMIT_REVEAL_MARGIN_BLOCKS, GATEWAY_REGISTER_ABI, IC_REGISTER_ABI, SUBMITTER_POLICY_SECONDS, assertAgentLabel, assertSubmitter, buildRegisterCalls,
  buildSelfAuthCalls, registerReadBackProblems, registerRecordKey, selfAuthCommitHash, selfAuthCommitmentKey, selfAuthEvidence, selfAuthPolicyProblems, selfAuthStateOf,
  type RegisterCall, type SelfAuthPhase, type SelfAuthRecord,
} from "./committee-register.ts";
import { ADMIN_ROLE, AGENT_ROLE, DEPOSIT_PAUSER_ROLE } from "./verify/constants.ts";
import { COMMITTEE_AGENT_ROLE } from "./record-receipt.ts";
import { forbiddenSubmitters, inspectSubmitterSafe, chainFromClient, submitterSafeEvidence, type SubmitterSafeEvidence, type SubmitterSafeInfo } from "./submitter-safe.ts";
import type { DeploymentKind } from "./chains.ts";
import { BASE_CHAIN_ID, httpRpc, isTwinFork, warpBy } from "./rehearsal/twin.ts";
import { loadRunManifest, readManifestField, reserveManifestSeq, saveRunManifest, type PauseEntry, type RunContext, type RunManifest } from "./runner.ts";
import { BASKET_KEYS, VAULT_NAME, type Sheet, type VaultKey } from "./sheet.ts";
import { VAULT_STAGES, getStageTable, manifestRef, type StageRow } from "./stages.ts";
import { STAGE13_UNPAUSE_ROWS, UNPAUSE_ROW_NAMES, vaultOfUnpauseRow } from "./vault-rules.ts";
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
 * The unpause rows: one per vault, each its own timelock operation, all scheduled in one sitting. Derived from the stage table's vault rules (issue 1705,
 * src/vault-rules.ts): every vault's `unpauseRow`, in table order. No vault is a special case here: rmUSDC deploys paused like the baskets (issue 1710).
 */
export { BASKET_KEYS };
export const UNPAUSE_ROWS: readonly UnpauseRowName[] = UNPAUSE_ROW_NAMES;
/** Demonstrations of the Safe tool. They exist only as Twin-fork runs and are refused with USAGE on 8453. */
export const TWIN_ONLY_ROWS = ["update-delay", "batch", "cancel"] as const;
export type UnpauseRowName = `unpause-${VaultKey}`;
export type GovernRowName = UnpauseRowName | (typeof TWIN_ONLY_ROWS)[number];
/** The govern rows in run order: the unpauses, then the Twin-only demonstrations. `--row` takes the 1-based number or the name. */
export const GOVERN_ROWS: readonly GovernRowName[] = [...UNPAUSE_ROWS, ...TWIN_ONLY_ROWS];
/** A row that runGovern can plan: every matrix row. */
export type PlannedRow = GovernRowName;
export const governRowNames = (): readonly string[] => GOVERN_ROWS;
export const isTwinOnlyRow = (row: string): boolean => (TWIN_ONLY_ROWS as readonly string[]).includes(row);
/**
 * Issue 1727: update-delay, batch and cancel are refused on 8453 UNLESS the sheet is a rehearsal (DEPLOYMENT_KIND=rehearsal). Each is a no-op or a bounded delay
 * change through the real Safe and the real timelock, so a rehearsal exercises the Safe tool on real contracts. Production keeps them refused. On a rehearsal they
 * are explicit `--row` runs: stage 13 on 8453 stays the four unpauses, and the later rows keep their order (update-delay, batch, cancel) after the unpauses.
 */
export const twinOnlyRefused = (row: string, chainId: number, kind: DeploymentKind): boolean => isTwinOnlyRow(row) && chainId === BASE_CHAIN_ID && kind !== "rehearsal";
/**
 * The refusal of a `--row` on this chain and kind, or undefined. ONE place: the CLI applies it right after the floors, BEFORE any signer or passphrase prompt (review of PR 1728:
 * production keeps refusing update-delay, batch, cancel and register-committee on 8453 without asking for a single passphrase), and runGovern applies it again.
 */
export function govRowRefusal(row: string | undefined, chainId: number, kind: DeploymentKind): string | undefined {
  if (row === REDEPLOY_ROW) return redeployRefusal(chainId, kind);
  if (row === undefined || row === RECEIPT_ROW || row === APPLY_ROW || row === CLEAR_ROW || row === UNWIND_GUARD_ROW || row === UPGRADE_ROW || row === FREEZE_ROW) return undefined;
  if (row === REGISTER_ROW) {
    return chainId === BASE_CHAIN_ID && kind !== "rehearsal"
      ? `--row ${REGISTER_ROW} is refused on chain 8453 in production: the production govern surface is the four unpauses, ${RECEIPT_ROW}, ${APPLY_ROW}, ${CLEAR_ROW} and ${UNWIND_GUARD_ROW}. It runs on a Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) and on the Twin chain.`
      : undefined;
  }
  let name: string;
  try { name = resolveGovernRow(row); } catch { return undefined; } // an unknown row is a usage error raised where it always was
  return twinOnlyRefused(name, chainId, kind)
    ? `--row ${name} is a demonstration of the Safe tool: it runs on a Twin fork only and is refused on chain 8453 (the only mainnet govern stage operation is the vault unpause; the other mainnet actions are --row ${RECEIPT_ROW}, --row ${APPLY_ROW}, --row ${CLEAR_ROW} and --row ${UNWIND_GUARD_ROW}). A Base mainnet REHEARSAL (DEPLOYMENT_KIND=rehearsal in the sheet) may run it.`
    : undefined;
}

/** The rows a stage run needs on a chain: on 8453 the unpause rows the stage table puts in stage 13 (`unpauseInStage13`), every row elsewhere. */
export const stageRows = (chainId: number): readonly GovernRowName[] => (chainId === BASE_CHAIN_ID ? STAGE13_UNPAUSE_ROWS : GOVERN_ROWS);
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

/** The deployed ConsensusRecommendationReceipt, from the ic-policy stage manifest (field consensus_receipt). */
export const loadReceiptAddr = (ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): Address => readManifestField(ctx, manifestRef("ic-policy", "consensus_receipt")) as Address;

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
 * Owner question 1 of issue 1645, default (b), and CS-3: the Safe gives up PROPOSER_ROLE through the delay and never as the last holder. The contract floors it
 * (LastProposerFloor at execute, after the Safe transaction and the delay); the tool refuses the same revoke before anything is sent. Any other role, and
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
export type TimelockAdminRow = (typeof TIMELOCK_ADMIN_ROWS)[number];

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
  if (row === REGISTER_ROW) throw new PublishError("USAGE", `--row ${REGISTER_ROW} is the on-demand committee submitter registration: it needs --submitter 0x<address>`);
  if (row === APPLY_ROW) throw new PublishError("USAGE", `--row ${APPLY_ROW} is the on-demand receipt application: it needs --receipt-id 0x<bytes32> and --payload FILE`);
  if (row === CLEAR_ROW) throw new PublishError("USAGE", `--row ${CLEAR_ROW} is the on-demand clear of the router's voted weight vector: it is run by name only (runGovern)`);
  if (row === REDEPLOY_ROW) throw new PublishError("USAGE", `--row ${REDEPLOY_ROW} is the on-demand replacement of one redeployed vault: it is run by name only (runGovern)`);
  if (row === UNWIND_GUARD_ROW) throw new PublishError("USAGE", `--row ${UNWIND_GUARD_ROW} is the on-demand emergency unwind guard of one basket vault: it needs --admin-arg vault=PROTO|AGENT|RWA token=0x..|all min-usdc-out=N max-loss-bps=N`);
  if (row === UPGRADE_ROW) throw new PublishError("USAGE", `--row ${UPGRADE_ROW} is the on-demand upgrade of one governed proxy (issue 1809): it needs --admin-arg proxy=<name> implementation=0x<address> [call=0x..] [build=DIR]`);
  if (row === FREEZE_ROW) throw new PublishError("USAGE", `--row ${FREEZE_ROW} is the on-demand permanent freeze of governed proxies (issue 1809): it needs --admin-arg proxy=<name>|all [build=DIR]`);
  if (/^[0-9]+$/.test(row)) {
    const n = Number(row);
    const name = GOVERN_ROWS[n - 1];
    if (name === undefined) throw new PublishError("USAGE", `--row ${row}: there are ${GOVERN_ROWS.length} govern rows (1 to ${GOVERN_ROWS.length})`);
    return name;
  }
  if ((GOVERN_ROWS as readonly string[]).includes(row)) return row as GovernRowName;
  throw new PublishError("USAGE", `unknown govern row '${row}' (${GOVERN_ROWS.join(", ")}, or 1 to ${GOVERN_ROWS.length}; on demand: ${RECEIPT_ROW} --receipt-id 0x<bytes32>, ${APPLY_ROW} --receipt-id 0x<bytes32> --payload FILE, ${CLEAR_ROW}, ${UNWIND_GUARD_ROW} --admin-arg K=V, ${UPGRADE_ROW} --admin-arg K=V, ${FREEZE_ROW} --admin-arg K=V)`);
}

/** The calls of one unpause row. Empty means the sheet does not ask for it (the vault stays paused): the row is skipped. */
export function buildStepCalls(sheet: Sheet, a: GovernAddrs, row: PlannedRow): LabelledCall[] {
  const calls: LabelledCall[] = [];
  const k = vaultOfUnpauseRow(row);
  if (k) {
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
  /** Safe self-administration only (issue 1645). Absent in a test world that does not exercise it: the real one is used. */
  proposeTx?: typeof proposeTx;
  /** Issue 1750: what the --submitter is on chain. `null`: no code (a single key). A contract that is not a canonical SafeL2 1.4.1 multisig throws USAGE. Reads only. */
  inspectSubmitter: (handle: SafeHandle, submitter: Address, forbidden: ReadonlyMap<string, string>) => Promise<SubmitterSafeInfo | null>;
}
export const realGovernApi: GovernApi = { connectSafe, scheduleOnTimelock, executeOnTimelock, cancelOnTimelock, updateTimelockDelay, operationId, operationState, timelockMinDelay, signTx, executeTx, verifyTimelockEffect, proposeTx,
  inspectSubmitter: (handle, submitter, forbidden) => inspectSubmitterSafe(chainFromClient(handle.client as never), submitter, forbidden) };

export type GovernPhase = "scheduled" | "executed" | "cancelled";

/** One stdout line per round event, the contract core's harness parses: {"row":"..","phase":"scheduled","txHash":"0x..","status":1,"readyAt":1700000000}. */
export interface GovernRowLine { row: string; phase: GovernPhase; txHash: string; status: 0 | 1; readyAt: number }

export interface GovernOpts {
  /** With --row register-committee only (issue 1727): the submitter's address and its label on the IC policy. */
  submitter?: string;
  agentLabel?: string;
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
  /** With `--row upgrade-proxy` only (issue 1809): the proxy, the new implementation, the reinitializer calldata and the build, as `--admin-arg` gave them. */
  proxyUpgrade?: UpgradeArgs;
  /** With `--row freeze-proxy` only (issue 1809): the proxy (or `all`) and the build, as `--admin-arg` gave them. */
  proxyFreeze?: FreezeArgs;
}

/** One generic timelock call, named by `label` (the manifest key, the salt input and the `row` of the output lines). */
export interface TwinCall { label: string; target: Address; data: Hex }

interface PhaseRecord { seq?: number; tx_hash?: string; safe_tx_hash?: string; status?: number; at: string; operation_id?: string; ready_at?: string; note?: string; [k: string]: unknown }
/** A self-administration record's identity (issue 1645, B4): the calldata sent (none for a skip), the Safe nonce it was proposed at, and the row's arguments as `selfAdminWantKey` spells them. */
export interface SelfAdminRecord { data?: Hex; nonce: number; want: string }
/** What the run manifest keeps per row. A row is complete when it is skipped, executed or (for cancel) cancelled. */
/** `observed`: the read-back after the execute. `voted_weights_active` is recorded by the clear and redeploy rows (they prove the active vector is gone); an application records the effective vector only (issue 1698: its vector IS the active one). */
/** `guard` (QA plan v1 D7): what a set-unwind-guard round sets, written before its schedule so a resume and the evidence entry name the same values. */
export interface GuardRecord { vault: string; vault_address: string; tokens: string[]; min_usdc_out: string; override_allowed: boolean; max_loss_bps: number }
/** Issue 1809: what an upgrade-proxy round sets and a freeze-proxy round fixes, written before its schedule so a resume and the evidence entry name the same values. */
export interface UpgradeRecord { proxy: string; proxy_address: string; from_implementation: string; implementation: string; implementation_code_hash: string; call_data: string; build_dir: string; core_sha: string }
export interface FreezeRecord { proxies: { name: string; proxy: string; implementation: string; code_hash: string }[]; build_dirs: Record<string, string>; core_sha: string }
export interface RowRecord { round?: number; admin?: SelfAdminRecord; guard?: GuardRecord; upgrade?: UpgradeRecord; freeze?: FreezeRecord; apply?: { vaults: string[]; bps: number[]; payload_digest: string }; observed?: { voted_weights_active?: boolean; effective_vaults: string[]; effective_bps: number[] }; skipped?: { at: string; reason: string }; scheduled?: PhaseRecord; executed?: PhaseRecord; cancelled?: PhaseRecord }
type GovernState = Record<string, RowRecord>;
/** The `register` part of a register-committee record: what the batch was built from, and (QA plan v1 B6) the private self-authorization with its salt. */
interface RegisterState { submitter: string; agent_label: string; gateway: string; ic_policy: string; valid_until: string; submitter_safe?: SubmitterSafeEvidence; self_authorization?: SelfAuthRecord }

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
 */
export function resumeCommand(ctx: Pick<RunContext, "chainId" | "coreSha">, row?: string, payload?: string, guard?: UnwindGuardWant, proxyRow?: { upgrade?: UpgradeWant; freeze?: FreezeWant }): string {
  const selfAdmin = row === undefined ? undefined : SELF_ADMIN_ROWS.find((r) => row!.startsWith(`${r}-`));
  const same = "--admin-arg K=V (the same --admin-arg values as this run)";
  if (row?.startsWith(`${UNWIND_GUARD_ROW}-`)) row = `${UNWIND_GUARD_ROW} ${guard ? unwindGuardArgsText(guard) : same}`;
  else if (row?.startsWith(`${UPGRADE_ROW}-`)) row = `${UPGRADE_ROW} ${proxyRow?.upgrade ? upgradeArgsText(proxyRow.upgrade) : same}`;
  else if (row?.startsWith(`${FREEZE_ROW}-`)) row = `${FREEZE_ROW} ${proxyRow?.freeze ? freezeArgsText(proxyRow.freeze) : same}`;
  else if (row?.startsWith(`${RECEIPT_ROW}-`)) row = `${RECEIPT_ROW} --receipt-id ${row.slice(RECEIPT_ROW.length + 1)}`;
  else if (row?.startsWith(`${REDEPLOY_ROW}-`)) row = REDEPLOY_ROW;
  else if (row?.startsWith(`${APPLY_ROW}-`)) row = `${APPLY_ROW} --receipt-id ${row.slice(APPLY_ROW.length + 1)}${payload === undefined ? " --payload FILE" : ` --payload ${payload}`}`;
  else if (selfAdmin !== undefined) row = `${selfAdmin} --admin-arg K=V (the same --admin-arg values as this run)`; // the record key carries the calldata hash and the Safe nonce, not the arguments
  return `bun publish-contracts/src/cli.ts govern${row === undefined ? "" : ` --row ${row}`} --chain ${ctx.chainId} --core-sha ${ctx.coreSha} (plus the same --rpc, --sheet, --signer, --environment and --owner-signer arguments as this run)`;
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
      const names = (): string[] => { try { return tableProxies(getStageTable()).map((x) => x.name); } catch { return []; } };
      const proxyRow = resumeRow?.startsWith(`${UPGRADE_ROW}-`) && o.proxyUpgrade !== undefined ? { upgrade: parseUpgradeArgs(o.proxyUpgrade, names()) }
        : resumeRow?.startsWith(`${FREEZE_ROW}-`) && o.proxyFreeze !== undefined ? { freeze: parseFreezeArgs(o.proxyFreeze, names()) } : undefined;
      const next = resumeCommand(ctx, resumeRow, resumePayload, guard, proxyRow);
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
  const k = vaultOfUnpauseRow(row);
  if (k) {
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
  const upgrading = o.row === UPGRADE_ROW;
  const freezing = o.row === FREEZE_ROW;
  if ((o.submitter !== undefined || o.agentLabel !== undefined) && !registering) throw new PublishError("USAGE", `--submitter and --agent-label go with --row ${REGISTER_ROW} only`);
  if (o.unwindGuard !== undefined && !guarding) throw new PublishError("USAGE", `--admin-arg vault, token, min-usdc-out, max-loss-bps and override-allowed go with --row ${UNWIND_GUARD_ROW} only`);
  if (o.proxyUpgrade !== undefined && !upgrading) throw new PublishError("USAGE", `--admin-arg ${UPGRADE_KEYS.join(", ")} go with --row ${UPGRADE_ROW} only`);
  if (o.proxyFreeze !== undefined && !freezing) throw new PublishError("USAGE", `--admin-arg ${FREEZE_KEYS.join(", ")} go with --row ${FREEZE_ROW} only`);
  // QA plan v1 D7: the row's arguments are checked before the Safe is read or anything is sent
  const guardWant = guarding ? parseUnwindGuardArgs(o.unwindGuard) : undefined;
  // issue 1809: so are the upgrade and freeze rows', against the stage table's proxies
  const proxyNames = upgrading || freezing ? tableProxies(getStageTable()).map((x) => x.name) : [];
  const upgradeWant = upgrading ? parseUpgradeArgs(o.proxyUpgrade, proxyNames) : undefined;
  const freezeWant = freezing ? parseFreezeArgs(o.proxyFreeze, proxyNames) : undefined;
  const early = govRowRefusal(o.row, ctx.chainId, ctx.sheet.kind);
  if (early !== undefined) throw new PublishError("USAGE", early);
  const selected: PlannedRow | undefined = o.row === undefined || releasing || applying || registering || clearing || redeploying || guarding || upgrading || freezing || selfAdminRow !== undefined ? undefined : resolveGovernRow(o.row);
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
    if (!name.startsWith("unpause-")) return;
    const rec = state[name];
    if (!rec?.scheduled || rec.executed) return;
    const newest = livePauses().filter((e) => e.seq > (rec.scheduled!.seq ?? 0)).pop();
    if (!newest) return;
    const st = await api.operationState(handle, a.timelock, p.id);
    if (st.done || !st.exists) return; // done: nothing left to cancel, the read-back decides. Gone: already cancelled, waitReady names the fresh-round command.
    const next = resumeCommand(ctx, name);
    throw new PublishError("GOVERN", `govern row ${name} (round ${rec.round ?? 1}) will NOT execute: operation ${p.id} was scheduled (sequence ${rec.scheduled.seq ?? 0}) before pause-all #${newest.seq} (${newest.trigger}, ${newest.at}), which paused the vaults on purpose. Executing it would reopen ${VAULT_NAME[name.slice("unpause-".length) as VaultKey]}. Nothing was sent. First cancel the operation through the Safe on the timelock, with a Safe transaction that calls cancel(${p.id}) on ${a.timelock} (the tool has no cancel on chain ${ctx.chainId}). Then open a fresh round: ${next}`,
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

  /** The evidence entry of an executed registration round (`committee_registrations` of the run manifest, checked by evidence-check). */
  async function recordRegistration(name: string): Promise<void> {
    const r = state[name] as (RowRecord & { register?: RegisterState }) | undefined;
    if (!r?.executed?.tx_hash || !r.scheduled?.tx_hash || !r.register) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    // QA plan v1 B6: the private self-authorization goes into the evidence as its three transactions; the salt stays in the govern state only
    const { self_authorization: sa, ...reg } = r.register;
    const selfAuthorization = selfAuthEvidence(sa);
    const entry = {
      step: REGISTER_ROW, ...reg, ...(selfAuthorization ? { self_authorization: selfAuthorization } : {}), timelock: a.timelock,
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    };
    const list = ((manifest as { committee_registrations?: { submitter?: string }[] }).committee_registrations ??= []);
    const i = list.findIndex((x) => x.submitter?.toLowerCase() === entry.submitter.toLowerCase());
    if (i >= 0) list[i] = entry; else list.push(entry);
    save();
  }

  if (registering) {
    // Issue 1727, QA plan v1 B6 (review CS-2): the submitter Safe first authorizes ITSELF in private (commit, reveal, hand-over to the timelock), THEN one public timelock batch,
    // setPolicy + committeeRegister, which nothing a stranger does during the delay can break. Never part of the matrix. Rehearsal and Twin only. committee-register.ts has the why.
    const submitter = assertSubmitter(o.submitter);
    const agentLabel = assertAgentLabel(o.agentLabel);
    const gateway = readManifestField(ctx, manifestRef("gateway", "gateway")) as Address;
    const icPolicy = readManifestField(ctx, manifestRef("ic-policy", "policy")) as Address;
    const name = registerRecordKey(submitter);
    const rd = reader(handle);
    const read = async <T,>(addr: Address, abi: readonly unknown[], fn: string, args: unknown[] = []): Promise<T> => rd<T>(addr, abi, fn, args);
    if (!rowComplete(state[name])) {
      const cur = state[name];
      const prevReg = (cur as { register?: Partial<RegisterState> } | undefined)?.register;
      let submitterSafe: SubmitterSafeEvidence | undefined = prevReg?.submitter_safe;
      // validUntil is fixed at the FIRST plan (the private reveal uses it too) and read back from the manifest after that, so a resume rebuilds the same calldata and finds the same operation id
      const validUntil = BigInt(prevReg?.valid_until ?? (await chainTime(handle)) + BigInt(SUBMITTER_POLICY_SECONDS));
      const selfAuth: SelfAuthRecord = { ...(prevReg?.self_authorization ?? {}) };
      const keep = (): void => {
        state[name] = { ...(state[name] ?? { round: 1 }), register: { submitter, agent_label: agentLabel, gateway, ic_policy: icPolicy, valid_until: validUntil.toString(), ...(submitterSafe ? { submitter_safe: submitterSafe } : {}), ...(Object.keys(selfAuth).length ? { self_authorization: selfAuth } : {}) } } as RowRecord;
        save();
      };
      /** The reveal must land in a later block than the commit (CommitmentTooRecent), and executeTx simulates it at the head first: wait until the head is past `block`. */
      const waitPastBlock = async (block: bigint): Promise<void> => {
        const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        for (let i = 0; i < 120; i++) {
          if ((await handle.client.getBlockNumber({ cacheTime: 0 })) > block) return; // no cached head: a warp or a new block must be seen at once
          const warp = await warpFor(ctx, o);
          if (warp) { await warp(1n); continue; } // a Twin fork mines on demand: one second, one block
          await sleep(o.pollMs ?? 2000);
        }
        throw new PublishError("GOVERN", `the chain head did not move past block ${block}, the block of the submitter Safe's commit: the reveal needs a later block. Nothing was scheduled. Run the row again: the commitment is revealed while its window lasts`, { submitter, block: block.toString() });
      };
      /**
       * QA plan v1 B6, the PRIVATE half: before the batch is visible on the timelock the submitter Safe authorizes itself on the gateway (a commit that names no agent,
       * a reveal at least one block later) and hands the agent to the timelock. Each step is a submitter-Safe transaction signed by its owners (--owner-signer) and paid by
       * --signer. Resumable from the chain: agentOwner(submitter) says which steps are done, and a stored commitment is reused while enough of its window is left.
       */
      const selfAuthorize = async (isSafe: boolean): Promise<void> => {
        const ownerNow = async () => read<string>(gateway, GATEWAY_REGISTER_ABI, "agentOwner", [submitter]);
        const stateNow = async () => selfAuthStateOf({ owner: await ownerNow(), agentRole: await read<boolean>(gateway, GATEWAY_REGISTER_ABI, "hasRole", [AGENT_ROLE, submitter]), submitter, timelock: a.timelock });
        let st = await stateNow();
        if (st === "squatted") throw new PublishError("GOVERN", `${submitter} already has an agent owner on the gateway, ${await ownerNow()}, that is neither the submitter Safe nor the timelock: another account authorized this address first, and the gateway has no way to take it back. This Safe can never be the submitter. Nothing was scheduled. Create a NEW submitter Safe and run the row with it`, { submitter });
        if (st === "foreign-role") throw new PublishError("GOVERN", `${submitter} already holds AGENT_ROLE on the gateway with no agent owner: the role came from elsewhere, nothing to schedule`, { submitter });
        if (st === "handed-over") {
          // The timelock owns it: this row's own hand-over (an earlier run), or another agent the timelock owns. Only the signalling-only policy shape is taken as this submitter's.
          const [, , maxPerPayment, maxPerWindow, shareReceiver, , maxWithdrawPerPayment, maxWithdrawPerWindow] = await read<readonly [boolean, bigint, bigint, bigint, Address, Address, bigint, bigint]>(gateway, GATEWAY_REGISTER_ABI, "agents", [submitter]);
          const bad = selfAuthPolicyProblems({ maxPerPayment, maxPerWindow, shareReceiver, maxWithdrawPerPayment, maxWithdrawPerWindow }, submitter, a.timelock);
          if (bad.length) throw new PublishError("GOVERN", `${submitter} already holds AGENT_ROLE on the gateway and the timelock owns it, but its policy is not the submitter's signalling-only one (${bad.join("; ")}): it is another agent, a depositor's. Nothing to schedule`, { submitter, problems: bad });
          ctx.log.log("info", "govern.self_authorized", { row: REGISTER_ROW, submitter, owner: a.timelock });
          return;
        }
        if (!isSafe) {
          throw new PublishError("GOVERN", `--submitter ${submitter} is a single key and this tool cannot sign for it. Before the batch is scheduled the key authorizes itself in private: gateway.commitAuthorization(keccak256(abi.encode(${submitter}, ${submitter}, salt))) with a random salt, at least one block later gateway.revealAuthorization(${submitter}, salt, a policy paying shares to itself), then gateway.transferAgentOwnership(${submitter}, ${a.timelock}). Run this row again after that. Nothing scheduled.`, { submitter });
        }
        const sub = await api.connectSafe({ rpcUrl: ctx.rpc, chainId: ctx.chainId, safeAddress: submitter, logger: ctx.log });
        if (sub.address.toLowerCase() !== submitter.toLowerCase()) throw new PublishError("GOVERN", `the Safe the tool connected to (${sub.address}) is not --submitter ${submitter}: nothing sent`, { submitter, connected: sub.address });
        const propose = api.proposeTx ?? proposeTx;
        const send = async (call: RegisterCall, action: string): Promise<SelfAuthPhase> => {
          const b = await signAndExecute(ctx, o, api, sub, await propose(sub, { to: call.target, data: call.data, action, description: `${REGISTER_ROW} private ${action}: ${call.label}` }));
          if (!b.executed?.tx_hash) throw new PublishError("GOVERN", `the submitter Safe transaction ${action} (${call.label}) was not sent`, { submitter, action });
          const block = Number((await handle.client.getTransactionReceipt({ hash: b.executed.tx_hash as Hex })).blockNumber);
          return { tx_hash: b.executed.tx_hash, safe_tx_hash: b.safe_tx_hash, status: b.executed.status, at: new Date().toISOString(), block };
        };
        // the hand-over carries no salt: a Safe whose reveal was made outside this run (no stored salt) is handed over all the same
        const callsFor = (s: Hex | undefined) => buildSelfAuthCalls(gateway, a.timelock, submitter, s ?? `0x${"00".repeat(32)}`, validUntil);
        if (st === "fresh") {
          let live = false;
          if (selfAuth.salt && selfAuth.commit?.block !== undefined) {
            const [committer] = await read<readonly [Address, bigint]>(gateway, GATEWAY_REGISTER_ABI, "commitments", [selfAuthCommitmentKey(selfAuthCommitHash(submitter, selfAuth.salt), submitter)]);
            const head = await handle.client.getBlockNumber({ cacheTime: 0 });
            live = committer.toLowerCase() === submitter.toLowerCase() && head + COMMIT_REVEAL_MARGIN_BLOCKS <= BigInt(selfAuth.commit.block) + COMMIT_EXPIRY_BLOCKS;
          }
          if (!live) {
            // a new random salt hides the agent until the reveal; it is on disk BEFORE the commit is sent, so a run that dies after the commit lands can still reveal
            selfAuth.salt = toHex(randomBytes(32));
            delete selfAuth.commit; delete selfAuth.reveal;
            keep();
            selfAuth.commit = await send(callsFor(selfAuth.salt).commit, "submitter-commit");
            keep();
          }
          await waitPastBlock(BigInt(selfAuth.commit!.block ?? 0));
          selfAuth.reveal = await send(callsFor(selfAuth.salt).reveal, "submitter-reveal");
          keep();
          st = await stateNow();
          if (st !== "self-owned") throw new PublishError("GOVERN", `after the reveal ${submitter} reads '${st}' on the gateway (owner ${await ownerNow()}), not owned by itself. Nothing was scheduled. A squatter that won the reveal race makes this Safe unusable: create a NEW submitter Safe`, { submitter, state: st });
        }
        selfAuth.hand_over = await send(callsFor(selfAuth.salt).handOver, "submitter-hand-over");
        keep();
        st = await stateNow();
        if (st !== "handed-over") throw new PublishError("GOVERN", `after the hand-over ${submitter} reads '${st}' on the gateway (owner ${await ownerNow()}), not owned by the timelock ${a.timelock}. Nothing was scheduled`, { submitter, state: st });
        ctx.log.log("info", "govern.self_authorized", { row: REGISTER_ROW, submitter, owner: a.timelock, commit_tx: selfAuth.commit?.tx_hash, reveal_tx: selfAuth.reveal?.tx_hash, hand_over_tx: selfAuth.hand_over.tx_hash });
      };
      if (cur?.scheduled === undefined) {
        // Nothing of this round is on the timelock yet: refuse what can only revert, before the Safe schedules it and the delay is spent.
        const owners = new Set([...sheet.safeOwners, sheet.admin, sheet.pauser, sheet.emergency, a.safe, a.timelock].map((x) => x.toLowerCase()));
        if (owners.has(submitter.toLowerCase())) throw new PublishError("USAGE", `--submitter ${submitter} is a Safe owner, a role key, the Safe or the timelock: the submitter holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else`, { submitter });
        // Issue 1750 (owner decision 2026-10-10): the submitter is a multisig, a separate canonical SafeL2 1.4.1 Safe. On 8453 a key (no code) is refused.
        const kind = await api.inspectSubmitter(handle, submitter, forbiddenSubmitters({ governingSafe: a.safe, timelock: a.timelock, admin: sheet.admin, pauser: sheet.pauser, emergency: sheet.emergency }));
        if (kind === null && ctx.chainId === BASE_CHAIN_ID) throw new PublishError("USAGE", `--submitter ${submitter} has no code: it is a single key. On 8453 the consensus receipt submitter is a multisig (a SafeL2 1.4.1 proxy with threshold 2 or more, separate from the governing Safe). Nothing scheduled.`, { submitter });
        submitterSafe = kind === null ? undefined : submitterSafeEvidence(kind);
        if ((await read<Address>(gateway, GATEWAY_REGISTER_ABI, "icPolicy")).toLowerCase() !== icPolicy.toLowerCase()) throw new PublishError("GOVERN", `the gateway's icPolicy is not the run's IC policy ${icPolicy}: committeeRegister would reach another contract`, { icPolicy });
        for (const [nm, r] of [["ADMIN_ROLE", ADMIN_ROLE], ["DEPOSIT_PAUSER_ROLE", DEPOSIT_PAUSER_ROLE]] as const) {
          if (await read<boolean>(gateway, GATEWAY_REGISTER_ABI, "hasRole", [r, submitter])) throw new PublishError("GOVERN", `${submitter} holds ${nm} on the gateway: role separation refuses it as an agent`, { submitter });
        }
        if (await read<boolean>(icPolicy, IC_REGISTER_ABI, "hasRole", [COMMITTEE_AGENT_ROLE, submitter])) throw new PublishError("GOVERN", `${submitter} already holds COMMITTEE_AGENT_ROLE on the IC policy: it is registered already, nothing to schedule`, { submitter });
        await selfAuthorize(kind !== null);
      }
      const calls = buildRegisterCalls(gateway, a.timelock, submitter, agentLabel, validUntil);
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(name), form: "batch" as const };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: REGISTER_ROW, submitter, prior, id });
      const readBack = async () => registerReadBackProblems({
        agentRole: await read<boolean>(gateway, GATEWAY_REGISTER_ABI, "hasRole", [AGENT_ROLE, submitter]), committeeRole: await read<boolean>(icPolicy, IC_REGISTER_ABI, "hasRole", [COMMITTEE_AGENT_ROLE, submitter]),
        label: await read<string>(icPolicy, IC_REGISTER_ABI, "agentId", [submitter]), wantLabel: agentLabel, owner: await read<string>(gateway, GATEWAY_REGISTER_ABI, "agentOwner", [submitter]), timelock: a.timelock,
        shareReceiver: (await read<readonly unknown[]>(gateway, GATEWAY_REGISTER_ABI, "agents", [submitter]))[4] as string,
      });
      keep();
      await round(name, {
        id, description: `register committee submitter ${submitter}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${REGISTER_ROW}: ${calls.map((c) => c.label).join("; ")}` }),
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

  // ---- issue 1809: the governed proxies (ADR-0014 §4-§5) -----------------------------------------------------------------------------------------------------

  /** The read-only surface proxies.ts reads a proxy through, over the Safe handle's client. */
  const proxyChain: Pick<ChainReader, "getCode" | "getStorageAt" | "read"> = {
    getCode: async (address) => ((await handle.client.getCode({ address })) ?? "0x") as Hex,
    getStorageAt: async (address, slot) => ((await handle.client.getStorageAt({ address, slot })) ?? ZERO_WORD) as Hex,
    read: async (address, signature, args = []) => { const item = parseAbiItem(signature) as AbiFunction; return handle.client.readContract({ address, abi: [item], functionName: item.name, args } as never); },
  };
  const proxyAddressOf = (px: TableProxy): Address => readManifestField(ctx, manifestRef(px.stage, px.field)) as Address;
  /** The build a proxy's implementation is compared with: the row's `build=`, else the build of the proxy's last executed upgrade round, else this checkout's out/. */
  const buildDirFor = (px: TableProxy, given: string | undefined): string => {
    if (given !== undefined) return given;
    const last = [...((manifest as { proxy_upgrades?: { proxy?: string; build_dir?: string; execute_tx?: string }[] }).proxy_upgrades ?? [])].reverse().find((e) => e?.proxy === px.name && typeof e.execute_tx === "string");
    return last?.build_dir ?? join(ctx.coreDir, "out");
  };
  /**
   * The runtime code at `address` against the build artifact of `artifact` in `dir` (immutables and links masked), then every library it links against that
   * library's build (ADR-0014 §9: a masked link would otherwise pass unreviewed library code). A missing artifact is a mismatch, never a pass.
   */
  const againstBuild = async (code: Hex, dir: string, artifact: string): Promise<CodeHashResult> => {
    try { return await compareCodeAndLinks(proxyChain.getCode, code, loadArtifact(dir, artifact), dir); } catch (e) { return { ok: false, detail: `no build to compare with: ${(e as Error).message}` }; }
  };
  /** Block timestamp of a recorded transaction, for the evidence entries. */
  const txTime = async (hash: string): Promise<number> => {
    const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
    return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  };
  /** A round whose operation the operator cancelled through the Safe is scheduled again under the same round (a cancelled id is free), like set-unwind-guard. */
  const reopenCancelled = async (name: string, rowName: string): Promise<void> => {
    const prev = state[name];
    if (!prev?.scheduled?.operation_id || rowComplete(prev)) return;
    const st = await api.operationState(handle, a.timelock, prev.scheduled.operation_id as Hex);
    if (st.exists || st.done) return;
    const n = prev.round ?? 1;
    let k = 1;
    while (state[`${roundKey(name, n)}:cancelled-${k}`]) k++;
    state[`${roundKey(name, n)}:cancelled-${k}`] = prev;
    state[name] = { round: n };
    save();
    ctx.log.log("info", "govern.round_rescheduled", { row: rowName, key: name, round: n, cancelled_operation: prev.scheduled.operation_id });
  };

  if (upgrading) {
    // ONE timelock operation: proxy.upgradeToAndCall(implementation, call). upgrade-rows.ts has every refusal and why.
    const want = upgradeWant!;
    const px = proxyByName(getStageTable(), want.proxy);
    const proxy = proxyAddressOf(px);
    const name = upgradeRecordKey(want);
    const call = buildUpgradeCall(px.name, proxy, want);
    const buildDir = buildDirFor(px, want.build);
    await reopenCancelled(name, UPGRADE_ROW);
    if (!rowComplete(state[name])) {
      const p = { timelock: a.timelock, calls: [{ target: call.target, data: call.data }], salt: salt(labelOf(name)), form: "single" as const };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: UPGRADE_ROW, prior, id });
      const live = await readProxyState(proxyChain, proxy);
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, id)).exists) {
        // Nothing of this round is on the timelock yet: an implementation already in place is recorded as skipped; anything the contract would revert after the delay is refused.
        if (live.implementation.toLowerCase() === want.implementation.toLowerCase()) {
          const reason = `${px.name} ${proxy} already runs ${want.implementation}`;
          state[name] = { ...(state[name] ?? { round: 1 }), skipped: { at: new Date().toISOString(), reason } };
          save();
          ctx.log.log("info", "govern.row_skipped", { row: UPGRADE_ROW, key: name, reason });
          return { rows: [name], skipped: [name], opIds };
        }
        const code = await proxyChain.getCode(want.implementation);
        let uuid: Hex | null = null;
        try { uuid = (await proxyChain.read(want.implementation, PROXIABLE_UUID_SIG)) as Hex; } catch { uuid = null; }
        const target: ImplementationRead = { address: want.implementation, code, initializerVersion: initializableOf(await proxyChain.getStorageAt(want.implementation, INITIALIZABLE_SLOT)).version, proxiableUUID: uuid };
        const refusals = upgradeRefusals({ name: px.name, live, target, build: await againstBuild(code, buildDir, px.artifact), timelock: a.timelock });
        if (refusals.length) throw new PublishError("GOVERN", `govern row ${UPGRADE_ROW}: ${refusals.join("; ")}. Nothing was sent`, { row: UPGRADE_ROW, proxy: px.name, problems: refusals });
        state[name] = {
          ...(state[name] ?? { round: 1 }),
          upgrade: { proxy: px.name, proxy_address: proxy, from_implementation: live.implementation, implementation: want.implementation, implementation_code_hash: keccak256(code), call_data: want.call, build_dir: buildDir, core_sha: ctx.coreSha },
        };
        save();
      }
      const readBack = async () => upgradeReadBackProblems(px.name, await readProxyState(proxyChain, proxy), want, a.timelock);
      // The Safe transaction names the proxy, the implementation it runs now and the one it will run, so the signers see what changes.
      await round(name, {
        id, description: `${px.name} upgrade to ${want.implementation}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${UPGRADE_ROW}: ${px.name} ${proxy} from ${live.implementation} to ${want.implementation}: ${call.label}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${UPGRADE_ROW} execute` }),
      }, UPGRADE_ROW);
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, UPGRADE_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, UPGRADE_ROW, "executed", r.executed);
    }
    // The evidence entry (`proxy_upgrades`): a record. The verifier reads the slot and the code from the chain.
    const r = state[name];
    if (r?.executed?.tx_hash && r.scheduled?.tx_hash && r.upgrade) {
      const entry = {
        step: UPGRADE_ROW, key: name, round: r.round ?? 1, ...r.upgrade, timelock: a.timelock,
        operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await txTime(r.scheduled.tx_hash),
        execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await txTime(r.executed.tx_hash),
      };
      const list = ((manifest as { proxy_upgrades?: { operation_id?: string }[] }).proxy_upgrades ??= []);
      const i = list.findIndex((x) => x.operation_id?.toLowerCase() === String(entry.operation_id).toLowerCase());
      if (i >= 0) list[i] = entry; else list.push(entry);
    }
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: UPGRADE_ROW, key: name, proxy: px.name });
    return { rows: [name], skipped: state[name]?.skipped && !state[name]?.executed ? [name] : [], opIds };
  }

  if (freezing) {
    // ONE timelock operation: freezeUpgrades(liveImplementation, liveCodeHash) per proxy not yet frozen. upgrade-rows.ts has every refusal and why.
    const want = freezeWant!;
    const t = getStageTable();
    const pxs = want.proxy === "all" ? tableProxies(t) : [proxyByName(t, want.proxy)];
    const reads: { px: TableProxy; proxy: Address; live: ProxyState }[] = [];
    for (const px of pxs) { const proxy = proxyAddressOf(px); reads.push({ px, proxy, live: await readProxyState(proxyChain, proxy) }); }
    const prefix = `${FREEZE_ROW}-${want.proxy}-`;
    // A round planned earlier and not complete is resumed with ITS targets (the ones the Safe signed), never re-planned from the chain.
    const open = Object.entries(state).filter(([k, r]) => k.startsWith(prefix) && !k.includes(":") && r?.freeze && !rowComplete(r));
    let name: string;
    let targets: FreezeRecord["proxies"];
    if (open.length > 0) {
      [name] = open[open.length - 1]!;
      targets = state[name]!.freeze!.proxies;
    } else {
      const toFreeze = reads.filter((r) => r.live.frozen !== true);
      if (toFreeze.length === 0) {
        // Every named proxy reads frozen: an executed round is reprinted; a proxy frozen at deploy (or by hand) is recorded as skipped. Nothing is sent.
        const done = Object.entries(state).filter(([k, r]) => k.startsWith(prefix) && !k.includes(":") && r?.executed).pop();
        if (done) {
          name = done[0];
          const r = done[1];
          if (r.scheduled) emitPhase(o, FREEZE_ROW, "scheduled", r.scheduled);
          if (r.executed) emitPhase(o, FREEZE_ROW, "executed", r.executed);
          targets = r.freeze?.proxies ?? [];
        } else {
          name = `${prefix}already-frozen`;
          const reason = `${pxs.map((x) => x.name).join(", ")} already read${pxs.length === 1 ? "s" : ""} upgradesFrozen() true`;
          state[name] = { round: 1, skipped: { at: new Date().toISOString(), reason } };
          save();
          ctx.log.log("info", "govern.row_skipped", { row: FREEZE_ROW, key: name, reason });
          return { rows: [name], skipped: [name], opIds };
        }
      } else {
        // Plan now, from the chain: each proxy's live implementation and its code hash. Refused before anything is scheduled when the contract would revert after the delay,
        // or when the live implementation is not the reviewed build (the freeze would fix it forever).
        const upgradesPending = (proxyName: string): string | undefined =>
          Object.entries(state).find(([k, r]) => k.startsWith(`${UPGRADE_ROW}-${proxyName}-`) && !k.includes(":") && r?.scheduled && !rowComplete(r))?.[0];
        const refusals: string[] = [];
        const dirs: Record<string, string> = {};
        for (const r of toFreeze) {
          dirs[r.px.name] = buildDirFor(r.px, want.build);
          refusals.push(...freezeRefusals({ name: r.px.name, live: r.live, build: await againstBuild(r.live.implementationCode, dirs[r.px.name]!, r.px.artifact), timelock: a.timelock, pendingUpgrade: upgradesPending(r.px.name) }));
        }
        if (refusals.length) throw new PublishError("GOVERN", `govern row ${FREEZE_ROW}: ${refusals.join("; ")}. Nothing was sent`, { row: FREEZE_ROW, proxy: want.proxy, problems: refusals });
        targets = toFreeze.map((r) => { const f = freezeTargetOf(r.live); return { name: r.px.name, proxy: r.proxy, implementation: f.implementation, code_hash: f.codeHash }; });
        name = freezeRecordKey(want.proxy, targets.map((x) => buildFreezeCall(x.name, x.proxy as Address, x.implementation as Address, x.code_hash as Hex)));
        if (!state[name]?.freeze) { state[name] = { ...(state[name] ?? { round: 1 }), freeze: { proxies: targets, build_dirs: dirs, core_sha: ctx.coreSha } }; save(); }
      }
    }
    // a round the operator cancelled through the Safe is scheduled again with the targets it was planned with (the record survives the reopen)
    const planned = state[name]?.freeze;
    await reopenCancelled(name, FREEZE_ROW);
    if (planned && !state[name]?.freeze) { state[name] = { ...state[name]!, freeze: planned }; save(); }
    if (!rowComplete(state[name])) {
      const calls = targets.map((x) => buildFreezeCall(x.name, x.proxy as Address, x.implementation as Address, x.code_hash as Hex));
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(labelOf(name)), form: calls.length === 1 ? ("single" as const) : ("batch" as const) };
      const id = await api.operationId(handle, p);
      const readBack = async () => freezeReadBackProblems(targets.map((x) => ({ name: x.name, implementation: x.implementation as Address })), await Promise.all(targets.map((x) => readProxyState(proxyChain, x.proxy as Address))));
      // The Safe transaction names every proxy, the implementation it freezes on and that code hash: the signers see exactly what is fixed forever.
      await round(name, {
        id, description: `freeze ${targets.map((x) => x.name).join(", ")}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${FREEZE_ROW}: PERMANENT, no upgrade can ever run again on ${targets.map((x) => `${x.name} ${x.proxy}`).join(", ")}: ${calls.map((c) => c.label).join("; ")}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${FREEZE_ROW} execute` }),
      }, FREEZE_ROW);
    }
    // The evidence entry (`proxy_freezes`): a record. The verifier reads upgradesFrozen() from the chain.
    const r = state[name];
    if (r?.executed?.tx_hash && r.scheduled?.tx_hash && r.freeze) {
      const entry = {
        step: FREEZE_ROW, key: name, round: r.round ?? 1, proxies: r.freeze.proxies, build_dirs: r.freeze.build_dirs, core_sha: r.freeze.core_sha, timelock: a.timelock,
        operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await txTime(r.scheduled.tx_hash),
        execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await txTime(r.executed.tx_hash),
      };
      const list = ((manifest as { proxy_freezes?: { operation_id?: string }[] }).proxy_freezes ??= []);
      const i = list.findIndex((x) => x.operation_id?.toLowerCase() === String(entry.operation_id).toLowerCase());
      if (i >= 0) list[i] = entry; else list.push(entry);
    }
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: FREEZE_ROW, key: name, proxies: targets.map((x) => x.name) });
    return { rows: [name], skipped: [], opIds };
  }

  /** The evidence entry of an executed redeploy round: the `vault_redeploys` entry the verb started, completed with the operation and the read-back (checked by evidence-check). */
  async function recordRedeploy(name: string, rec: RedeployRecord, vec: RedeployVectors, vaultCap: string): Promise<void> {
    const r = state[name] as (RowRecord & { observed?: { effective_vaults?: string[]; effective_bps?: number[]; voted_weights_active?: boolean; old_status?: string; new_status?: string } }) | undefined;
    if (!r?.executed?.tx_hash || !r.scheduled?.tx_hash) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    Object.assign(rec, {
      status: "governed" as const, vaults: vec.finalVaults, bps: vec.finalBps, router_vault_cap: vaultCap,
      voted_weights_active: r.observed?.voted_weights_active, effective_vaults: r.observed?.effective_vaults, effective_bps: r.observed?.effective_bps,
      old_vault_status: r.observed?.old_status, new_vault_status: r.observed?.new_status,
      operation_id: r.scheduled.operation_id, schedule_tx: r.scheduled.tx_hash, schedule_status: r.scheduled.status ?? 1, schedule_block_timestamp: await at(r.scheduled.tx_hash),
      execute_tx: r.executed.tx_hash, execute_status: r.executed.status ?? 1, execute_block_timestamp: await at(r.executed.tx_hash),
    });
    save();
  }

  if (redeploying) {
    // Issue 1796: ONE timelock batch (register, make the new vault eligible, drop and retire the old one, open the new one). Never part of the matrix.
    const records = redeploysOf(manifest);
    const rec = records.find((x) => x.status === "deployed") ?? [...records].reverse().find((x) => x.status === "governed");
    if (!rec || !rec.new_vault) throw new PublishError("USAGE", `--row ${REDEPLOY_ROW} needs a vault the redeploy-vault verb has deployed: the run manifest holds none (run: bun publish-contracts/src/cli.ts redeploy-vault --vault PROTO ...)`, { row: REDEPLOY_ROW });
    const name = redeployRecordKey(rec.key, rec.ordinal);
    const newVault = rec.new_vault, oldVault = rec.old_vault;
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
    // QA plan v1 E3: `vault_cap` is router.vaultCap(old) when the round was planned (a decimal string), the value the batch's setVaultCap gives the new vault.
    type Plan = { registry_name: string; asset: Address; vaults: Address[]; bps: number[]; vault_cap?: string };
    const oldVaultCap = async (): Promise<string> => String(await rd<bigint>(a.router, ROUTER_REDEPLOY_ABI, "vaultCap", [oldVault]));
    let vec: RedeployVectors;
    let vaultCap: string;
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
          rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "hasRole", [ADMIN_ROLE, a.timelock]),
          rd<boolean>(a.router, ROUTER_REDEPLOY_ABI, "votedWeightsActive"),
          rd<[Address[], bigint[]]>(a.router, ROUTER_REDEPLOY_ABI, "getDefaultWeights"),
        ]);
        const oldCode = await handle.client.getCode({ address: oldVault });
        const problems = redeployBeforeProblems(oldVault, newVault, {
          listed, oldStatus: Number(status0), oldEligible: eligible0, registryRouter, router: a.router, timelockIsRegistryAdmin: tlAdmin, timelockIsRouterAdmin: tlRouterAdmin, votedWeightsActive: voted,
          defaultVaults: defVaults, defaultBps: defBps, oldHasCode: !!oldCode && oldCode !== "0x",
        });
        // the new vault must be what the deploy left: closed, unregistered (above), UNLINKED (the batch's first call links it, set-once), governed by the timelock
        if (!(await rd<boolean>(newVault, VAULT_REDEPLOY_ABI, "depositsPaused"))) problems.push(`the new vault ${newVault} is not deposit-paused`);
        if (!(await rd<boolean>(newVault, VAULT_REDEPLOY_ABI, "hasRole", [ADMIN_ROLE, a.timelock]))) problems.push(`the timelock does not hold ADMIN_ROLE on the new vault ${newVault}: the batch's setRegistry and unpause would revert`);
        const link = await rd<Address>(newVault, VAULT_REDEPLOY_ABI, "registry");
        if (link.toLowerCase() !== ZERO) problems.push(link.toLowerCase() === a.registry.toLowerCase()
          ? `the new vault ${newVault} is already linked to the registry: the batch's setRegistry would revert RegistryAlreadySet (the link was sent outside this row)`
          : `the new vault ${newVault} is linked to ${link}, not the deployment's registry ${a.registry}: the link is set-once, so this vault cannot be used; redeploy`);
        if (problems.length > 0) throw new PublishError("GOVERN", `govern row ${REDEPLOY_ROW} cannot start from the state on chain: ${problems.join("; ")}. Nothing was scheduled.`, { row: REDEPLOY_ROW, problems });
        const v = planRedeployVectors({ defaultVaults: defVaults, defaultBps: defBps, oldVault, newVault });
        plan = { registry_name: meta.name, asset: meta.asset, vaults: v.finalVaults, bps: v.finalBps, vault_cap: await oldVaultCap() };
        state[name] = { ...(state[name] ?? { round: 1 }), redeploy: plan } as RowRecord;
        save();
      }
      if (plan.vault_cap === undefined) {
        // A plan written before QA plan v1 E3 has no cap: read it now. If that plan's six-call batch was already scheduled, the operation id differs below and the row
        // refuses (USAGE): cancel that operation through the Safe and run the row again, which schedules the seven-call batch.
        plan = { ...plan, vault_cap: await oldVaultCap() };
        state[name] = { ...(state[name] ?? { round: 1 }), redeploy: plan } as RowRecord;
        save();
      }
      vaultCap = plan.vault_cap!;
      vec = vectorsFromFinal({ finalVaults: plan.vaults, finalBps: plan.bps, oldVault, newVault });
      const calls = buildRedeployCalls({ registry: a.registry, router: a.router, oldVault, newVault, registryName: plan.registry_name, asset: plan.asset, finalVaults: plan.vaults, finalBps: plan.bps, vaultCap });
      // QA plan v1 E1: the row may run at the original sha or at the round's own sha (redeploy-vault.ts redeployShaRun), so the salt is the ROUND's sha, never the
      // run's: a schedule at one and a resume at the other name the same operation.
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: governSalt(rec.core_sha || ctx.coreSha, ctx.chainId, name), form: "batch" as const };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: REDEPLOY_ROW, prior, id });
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
          newPaused: await rd<boolean>(newVault, VAULT_REDEPLOY_ABI, "depositsPaused"), newLinked: (await rd<Address>(newVault, VAULT_REDEPLOY_ABI, "registry")).toLowerCase() === a.registry.toLowerCase(),
          oldRetiredFlag: await rd<boolean>(oldVault, VAULT_REDEPLOY_ABI, "retired"), oldHasCode: !!oldCode && oldCode !== "0x",
          newVaultCap: await rd<bigint>(a.router, ROUTER_REDEPLOY_ABI, "vaultCap", [newVault]), oldVaultCap: await rd<bigint>(a.router, ROUTER_REDEPLOY_ABI, "vaultCap", [oldVault]),
        });
        if (bad.length === 0) (state[name] as { observed?: unknown }).observed = { voted_weights_active: votedWeightsActive, effective_vaults: [...effectiveVaults], effective_bps: effectiveBps.map(Number), old_status: STATUS_NAME[Number(oldStatus)], new_status: STATUS_NAME[Number(newStatus)] };
        return bad;
      };
      // QA plan v1 C2: the Safe transaction the owners sign names both addresses, not only the call labels.
      const swap = `${VAULT_NAME[rec.key]} old ${oldVault} -> new ${newVault}`;
      await round(name, {
        id, description: `redeploy ${VAULT_NAME[rec.key]}: ${oldVault} to ${newVault}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${REDEPLOY_ROW} ${swap}: ${calls.map((c) => c.label).join("; ")}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${REDEPLOY_ROW} execute ${swap}` }),
      }, REDEPLOY_ROW);
    } else {
      const done = state[name] as RowRecord & { redeploy?: Plan };
      if (!done.redeploy) throw new PublishError("GOVERN", `the run manifest holds an executed ${name} with no recorded vector: it cannot be read back`, { row: REDEPLOY_ROW });
      vec = vectorsFromFinal({ finalVaults: done.redeploy.vaults, finalBps: done.redeploy.bps, oldVault, newVault });
      // a round executed before QA plan v1 E3 carried no cap call: its evidence keeps the old vault's cap as it reads now, and the evidence chain check names the six-call batch
      vaultCap = done.redeploy.vault_cap ?? await oldVaultCap();
      if (done.scheduled) emitPhase(o, REDEPLOY_ROW, "scheduled", done.scheduled);
      if (done.executed) emitPhase(o, REDEPLOY_ROW, "executed", done.executed);
    }
    await recordRedeploy(name, rec, vec, vaultCap);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: REDEPLOY_ROW, old_vault: oldVault, new_vault: newVault });
    return { rows: [name], skipped: [], opIds };
  }

  if (applying) {
    // Issue 1696, issue 1698: ONE timelock call, RouterGovernance.applyReceipt (release + the router weight change in one transaction). Never part of the matrix, on 8453 only when named with a receipt id and a payload.
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
      // Issue 1698: the stage 11 wiring the one call needs, before the schedule and again before the execute (a wiring change while the call waits is caught here,
      // not as a revert after the delay). Nothing is sent on a miss.
      const wiring = {
        receiptContract: await rd<Address>(governance, GOVERNANCE_WIRING_ABI, "receiptContract").catch(() => undefined),
        governanceIsReceiptAdmin: await rd<boolean>(receipt, RECEIPT_ROLE_ABI, "hasRole", [ADMIN_ROLE, governance]),
      };
      const unwired = applyWiringProblems(receipt, governance, wiring);
      if (unwired.length > 0) throw new PublishError("GOVERN", `govern row ${APPLY_ROW}: the weight setter is not wired to the consensus receipt register: ${unwired.join("; ")}. Nothing was sent. The timelock stage wires it (setReceiptContract and the register ADMIN_ROLE); fix that wiring through the Safe and the timelock, then run the row again`, { row: APPLY_ROW, receipt_id: receiptId, problems: unwired });
      const recorded = await rd<boolean>(receipt, RECEIPT_ABI, "isRecorded", [receiptId]);
      const released = recorded ? await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId]) : false;
      const stored = recorded ? (await rd<{ payloadDigest: Hex }>(receipt, RECEIPT_RECORD_ABI, "getReceiptById", [receiptId])).payloadDigest : undefined;
      const listed = await rd<Address[]>(a.registry, REGISTRY_ELIGIBLE_ABI, "listVaults");
      const eligible: Address[] = [];
      for (const v of listed) if (await rd<boolean>(a.registry, REGISTRY_ELIGIBLE_ABI, "isRouterEligible", [v])) eligible.push(v);
      // Issue 1698: an active vector from an earlier receipt is no refusal. applyReceipt writes the ACTIVE vector, so this receipt replaces it; the default is untouched.
      const vec = planApply({ receiptId, payload, recorded, released, storedDigest: stored, eligible, vaultOf: a.vaults, inFlight: state[name]?.scheduled !== undefined });
      const payloadDigest = receiptPayloadDigest(payload); // planApply proved it equals the stored digest; the chain checks it again (ReceiptDigestMismatch)
      const calls = buildApplyCalls(governance, receiptId, payloadDigest, vec);
      // ONE call: `schedule`, never `scheduleBatch`. The form is part of the operation id, so a resume after the contract change cannot adopt a pre-1698 batch.
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(name), form: "single" as const };
      const id = await api.operationId(handle, p);
      const prior = state[name]?.scheduled?.operation_id;
      if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: APPLY_ROW, receipt_id: receiptId, prior, id });
      const readBack = async () => {
        const [effectiveVaults, effectiveBps] = await rd<[Address[], bigint[]]>(a.router, ROUTER_WEIGHTS_ABI, "getEffectiveWeights");
        const bad = applyReadBackProblems(receiptId, await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId]), { effectiveVaults, effectiveBps }, vec);
        // the evidence records what the read-back saw, so a later change of the router never rewrites the entry
        if (bad.length === 0) state[name]!.observed = { effective_vaults: [...effectiveVaults], effective_bps: effectiveBps.map(Number) };
        return bad;
      };
      state[name] = { ...(state[name] ?? { round: 1 }), apply: { vaults: vec.vaults, bps: vec.bps, payload_digest: payloadDigest } };
      await round(name, {
        id, description: `apply receipt ${receiptId}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${APPLY_ROW}: ${calls.map((c) => c.label).join("; ")}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${APPLY_ROW} execute` }),
      }, APPLY_ROW);
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, APPLY_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, APPLY_ROW, "executed", r.executed);
    }
    await recordApplication(name, receiptId, receipt, governance);
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: APPLY_ROW, receipt_id: receiptId });
    return { rows: [name], skipped: [], opIds };
  }

  /**
   * The evidence entry of an executed apply round (`receipt_applications` of the run manifest, checked by evidence-check). The block timestamps are read from
   * the chain, from the receipt of each Safe transaction. A round adopted from the chain with no transaction of its own writes no entry.
   */
  async function recordApplication(name: string, receiptId: Hex, receipt: Address, governance: Address): Promise<void> {
    const r = state[name]!;
    if (!r.executed?.tx_hash || !r.scheduled?.tx_hash || !r.apply) return;
    const at = async (hash: string): Promise<number> => {
      const rc = await handle.client.getTransactionReceipt({ hash: hash as Hex });
      return Number((await handle.client.getBlock({ blockNumber: rc.blockNumber })).timestamp);
    };
    const entry = {
      // issue 1698: the one call targets `governance`; `receipt` is the register it released the receipt on (read back as isReleased), and `payload_digest` is what the call named
      step: APPLY_ROW, receipt_id: receiptId, governance, receipt, vaults: r.apply.vaults, bps: r.apply.bps, payload_digest: r.apply.payload_digest,
      // issue 1743: the EFFECTIVE weights the read-back saw after the execute (the applied vector is the active one, so no voted flag is recorded)
      effective_vaults: r.observed?.effective_vaults, effective_bps: r.observed?.effective_bps,
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
    if (!/^[A-Za-z0-9._-]+$/.test(label) || (GOVERN_ROWS as readonly string[]).includes(label) || label === RECEIPT_ROW || label === APPLY_ROW || label === REGISTER_ROW || label === CLEAR_ROW || label === REDEPLOY_ROW || label === UNWIND_GUARD_ROW) throw new PublishError("USAGE", `call label '${label}': letters, digits, . _ - only, and not a govern row name`);
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
      // The chain would refuse it too (ProposerFloorTimelock.LastProposerFloor), at execute, after a Safe transaction and a delay: refuse before anything is sent.
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
