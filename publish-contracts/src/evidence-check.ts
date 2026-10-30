#!/usr/bin/env bun
// Evidence check for a mainnet run. Reads evidence/<run-id>/evidence.json (template: publish-contracts/evidence.example.json).
// Usage: bun src/evidence-check.ts --upgrade-lifecycle FILE [--rpc URL]   (the Twin upgrade rehearsal: deploy upgradeable, governed upgrade, freeze, refused upgrade after the freeze, issue 1811)
//        bun src/evidence-check.ts --governed-upgrades RUN_MANIFEST --timelock ADDR [--governance ADDR] [--delay-floor SECONDS] [--rpc URL]   (proxy_upgrades read back from the chain, a typed migration included, issue 1910)
//        bun src/evidence-check.ts --vault-redeploys RUN_MANIFEST --registry ADDR --timelock ADDR [--delay-floor SECONDS] [--rpc URL]   (a single-vault redeploy of a rehearsal or a Twin run, issue 1796)
//        bun src/evidence-check.ts --vault-retirements RUN_MANIFEST --registry ADDR --timelock ADDR [--delay-floor SECONDS] [--rpc URL]   (the retire-vault row, issue 1912, ADR-0017)
//        bun src/evidence-check.ts --receipt-applications RUN_MANIFEST --consensus-receipt ADDR --governance ADDR --timelock ADDR [--delay-floor SECONDS] [--rpc URL]   (a Twin run; the floor defaults to the 8453 floor, a Twin run passes its own timelock min delay, issue 1696; on an --rpc of chain 8453 a floor under the 8453 floor is refused, issue 1701)
//        bun src/evidence-check.ts --evidence FILE [--frozen FILE --deploy-sha SHA] [--rpc URL [--record-chain-fixture OUT] | --chain-fixture FILE]
// Rejects: a wrong tx count against the frozen count, a missing tx hash, a failed receipt, a delay under 172800 s, a govern
// schedule-to-execute gap under 172800 s per operation, a govern operation that shares a transaction or a timelock operation id with another one, any
// operation scheduled on 8453 that is not a vault unpause (issue 1520) or a validated receipt release (issue 1611), a chain id other than 8453, owner exceptions recorded at or after plan approval.
// DEPLOYMENT KIND (issue 1727): the evidence is read as PRODUCTION unless `--deployment-kind rehearsal` is passed. Evidence carries `deployment_kind` (absent means production).
// A rehearsal evidence presented as production fails, and so does a production evidence presented as a rehearsal. Production keeps the 172800 s floor and the three unpauses.
// A rehearsal reads the 900 s floor, accepts the rehearsal-only `rehearsal_rows` (update-delay, batch, cancel) and counts the deployer nonce from `deployer_start_nonce`.
// Offline mode (no --rpc) checks the recorded JSON shape only. Online mode (--rpc URL, chain 8453) reads the chain with viem and
// does not trust the recorded numbers: deployer nonce, every receipt status, the timelock events and block timestamps of each
// govern step, registry.listVaults() against the recorded manifests, and depositsPaused() of the basket vaults against the unpause govern rows.
// Recorded-fixture mode (--chain-fixture FILE, with --frozen) runs the same chain checks over a fixture of what the chain returned, recorded at the end
// of the run with --rpc ... --record-chain-fixture OUT. CI uses it: acceptance criteria 2 (nonce and per-stage counts) and 3 (receipts, 48 hour gap)
// are checked with no RPC and no network. No secret is read or needed.
import { decodeEventLog, encodeFunctionData, keccak256, parseAbi, toBytes, type Hex } from "viem";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MAINNET_CHAIN_ID, MAINNET_DELAY_FLOOR, delayFloor, rehearsalDelayProblem } from "./floors.ts";
import { DEPLOYMENT_KINDS, kindLabel, type DeploymentKind } from "./chains.ts";
import { HISTORICAL_REGISTER_ROW, buildHistoricalRegisterCalls } from "./committee-register.ts";
import { REGISTER_ROW, buildRegisterCall } from "./submitter-register.ts";
import { CLEAR_ROW, clearCalldata } from "./clear-voted-weights.ts";
import { RETIRE_ROW, STAYING_KEYS, buildRetireCalls } from "./retire-vault.ts";
import { REDEPLOY_ROW, buildRedeployCalls, createdVaultProblems, vectorsFromFinal, type DeployReceipt } from "./redeploy-vault.ts";
import { assertOwnerExceptions } from "./plan.ts";
import { GATEWAY_EVIDENCE_STAGES, checkGatewayEvidence } from "./evidence-gateway.ts";
import { effectiveCounts, finalDeployerNonce } from "./counts.ts";
import { LIBS_STAGE, SAFE_STAGE } from "./core-wiring.ts";
import { loadStageTable, scopeTable, type StageTable, type TableVault, type VaultRules } from "./stage-table.ts";
import { STAGE13_UNPAUSE_ROWS, VAULT_RULES, VAULT_UNPAUSE_ROWS } from "./vault-rules.ts";
import { upgradeabilityEvidenceProblems, upgradeabilityOnChainProblems } from "./evidence-upgradeability.ts";
import { proxySpecs } from "./verify/upgradeability.ts";
import { FREEZE_ROW, UPGRADE_MIGRATIONS, UPGRADE_ROW, decodeUpgradeCall, pinnedMigrationData } from "./upgrade-rows.ts";
import { upgradeCalldata } from "./upgrade-lifecycle.ts";
import { upgradeLifecycleOnChainProblems, upgradeLifecycleProblems, type LifecycleChain } from "./upgrade-lifecycle.ts";

const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * Stage 13 on 8453 (issue 1520): the only operation after the timelock handover is the unpause of each of the three vaults (rmUSDC too since issue 1710: all three deploy paused). One govern entry per vault, each with
 * its own schedule transaction, its own execute transaction and its own timelock operation (never a shared one). All are scheduled in one sitting and wait
 * one delay: each execute is at least 172800 s after the same operation's schedule. update-delay, batch and cancel are Twin-only demonstrations of the
 * Safe tool: on 8453 they are rejected here. The names are the unpause rows of the govern CLI (src/govern.ts UNPAUSE_ROWS).
 */
export const GOVERN_STEPS: readonly string[] = STAGE13_UNPAUSE_ROWS;

/**
 * Issue 1667: a vault the tool paused (pause-all, any of the four) comes back through a Safe -> Timelock unpause round. Every unpause step is required (round 1,
 * stage 13) and may repeat as a numbered ROUND (`round`, default 1): a vault paused again after an executed unpause has a second round with its own schedule, execute
 * and operation id. The one call on any vault the evidence accepts is unpauseDeposits().
 */
export const UNPAUSE_STEPS: readonly string[] = VAULT_UNPAUSE_ROWS;
/** The evidence vault name (`rm<KEY>`) an unpause step targets, from the stage table's vault rules (issue 1705). */
const VAULT_OF_STEP: Record<string, string> = Object.fromEntries(VAULT_RULES.map((v) => [v.unpauseRow, `rm${v.key}`]));
const UNPAUSE_ABI = parseAbi(["function unpauseDeposits()"]);
export const unpauseCalldata = (): Hex => encodeFunctionData({ abi: UNPAUSE_ABI, functionName: "unpauseDeposits" });
const roundOf = (g: any): number => (g?.round === undefined ? 1 : g.round);
const stepLabel = (g: any): string => (roundOf(g) === 1 ? String(g?.step) : `${g?.step} round ${roundOf(g)}`);

/**
 * The one other operation the timelock may carry on 8453 (issue 1611): a post-launch consensus receipt release, recorded under `receipt_releases` (never
 * in `govern`, so stage 13 stays the three unpauses). One entry per receipt: one schedule and one execute at least MAINNET_DELAY_FLOOR apart, the target the
 * receipt contract (`consensus_receipt.address`), the calldata releaseReceipt(receipt_id). The list is optional. Any other operation fails.
 */
const RELEASE_ABI = parseAbi(["function releaseReceipt(bytes32 receiptId)"]);
export const releaseCalldata = (receiptId: string): Hex => encodeFunctionData({ abi: RELEASE_ABI, functionName: "releaseReceipt", args: [receiptId as Hex] });
const releaseLabel = (r: any) => `release-receipt ${r?.receipt_id}`;

/**
 * A post-launch receipt application (issue 1696, issue 1698, `govern --row apply-receipt`), recorded under `receipt_applications` (never in `govern`, so stage 13 stays the
 * four unpauses). One entry per receipt: ONE timelock call, applyReceipt(receipt_id, payload_digest, vaults, bps) on the weight setter (`governance.address`), which
 * releases the receipt and sets the router's active vector together, one schedule and one execute at least MAINNET_DELAY_FLOOR apart.
 * The Twin run writes the same entries into the run manifest and `--receipt-applications` checks them (a Twin run proves execution only, not mainnet governance).
 */
const APPLY_RECEIPT_ABI = parseAbi(["function applyReceipt(bytes32 receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps)"]);
export const applyCalldata = (receiptId: string, payloadDigest: string, vaults: string[], bps: number[]): Hex =>
  encodeFunctionData({ abi: APPLY_RECEIPT_ABI, functionName: "applyReceipt", args: [receiptId as Hex, payloadDigest as Hex, vaults as Hex[], bps.map(BigInt)] });
const applyLabel = (r: any) => `apply-receipt ${r?.receipt_id}`;

/** Operations built INSIDE this module for the rehearsal cancel row. Identity-based and never serialised: a `cancelled` field in evidence JSON means nothing. */
const INTERNAL_CANCELS = new WeakSet<object>();
/** Entries of govern, receipt_releases, receipt_applications and committee_registrations are executed operations: a cancel field there is a forgery attempt at the gap check. */
function forbidCancelFields(entries: any[], label: (e: any) => string, bad: (m: string) => void): void {
  for (const e of entries) for (const k of ["cancelled", "cancel_tx", "cancel_status"]) if (e && typeof e === "object" && k in e) bad(`${label(e)}: ${k} is not a field of an executed operation (only the rehearsal cancel row in rehearsal_rows has a cancel)`);
}

/** The checks every operation of the run shares: both transactions present with status 1, one delay apart, none shared with another operation. */
function operationProblems(operations: any[], bad: (m: string) => void, floor: number = MAINNET_DELAY_FLOOR): void {
  for (const field of ["schedule_tx", "execute_tx", "operation_id"]) {
    const seen = new Map<string, string>();
    for (const g of operations) {
      const h = typeof g?.[field] === "string" ? g[field].toLowerCase() : "";
      if (!(field === "operation_id" ? h !== "" : TX.test(h))) continue;
      const other = seen.get(h);
      if (other !== undefined) bad(`govern ${g.step}: ${field} is also the ${field} of step '${other}' (one operation per unpause, none shared)`);
      else seen.set(h, g.step);
    }
  }
  for (const g of operations) {
    if (!TX.test(g.schedule_tx ?? "")) bad(`govern ${g.step}: schedule_tx is missing`);
    if (g.schedule_status !== 1) bad(`govern ${g.step}: schedule receipt status is ${g.schedule_status}`);
    if (!TX.test(g.execute_tx ?? "")) bad(`govern ${g.step}: execute_tx is missing`);
    if (typeof g.schedule_tx === "string" && typeof g.execute_tx === "string" && lc(g.schedule_tx) === lc(g.execute_tx)) bad(`govern ${g.step}: execute_tx is also the schedule_tx`);
    if (g.execute_status !== 1) bad(`govern ${g.step}: execute receipt status is ${g.execute_status}`);
    if (INTERNAL_CANCELS.has(g)) continue; // only the rehearsal cancel row, built by rowOperations below, never executes. Nothing read from the evidence JSON can set this.
    const gap = Number(g.execute_block_timestamp) - Number(g.schedule_block_timestamp);
    if (!(gap >= floor)) bad(`govern ${g.step}: schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
}

/** The shape of the `receipt_applications` list and of each entry (no chain read). Also run on its own for a Twin run manifest. */
function applicationShapeProblems(ev: any, bad: (m: string) => void): any[] {
  const apps: any[] = ev?.receipt_applications === undefined ? [] : Array.isArray(ev.receipt_applications) ? ev.receipt_applications : (bad("receipt_applications is not a list"), []);
  if (apps.length > 0 && !ADDR.test(ev?.consensus_receipt?.address ?? "")) bad("consensus_receipt.address is missing: a receipt application names a receipt on it");
  if (apps.length > 0 && !ADDR.test(ev?.governance?.address ?? "")) bad("governance.address is missing: a receipt application has no applyReceipt target to check");
  const seen = new Set<string>();
  for (const r of apps) {
    const w = applyLabel(r);
    if (!TX.test(r?.receipt_id ?? "")) bad(`${w}: receipt_id is not a bytes32`);
    else if (seen.has(lc(r.receipt_id))) bad(`${w}: receipt_id has more than one evidence entry`);
    else seen.add(lc(r.receipt_id));
    if (r?.step !== undefined && r.step !== "apply-receipt") bad(`${w}: step '${r.step}' is not apply-receipt`);
    if (lc(r?.target ?? "") !== lc(ev?.governance?.address ?? "")) bad(`${w}: target ${r?.target} is not the weight setter ${ev?.governance?.address}: an application is one applyReceipt call`);
    if (lc(r?.governance ?? "") !== lc(ev?.governance?.address ?? "")) bad(`${w}: governance ${r?.governance} is not the governance contract ${ev?.governance?.address}`);
    if (!TX.test(r?.payload_digest ?? "")) bad(`${w}: payload_digest is not a bytes32`);
    const vaults: unknown[] = Array.isArray(r?.vaults) ? r.vaults : [];
    const bps: unknown[] = Array.isArray(r?.bps) ? r.bps : [];
    if (vaults.length === 0 || vaults.length !== bps.length || !vaults.every((v) => typeof v === "string" && ADDR.test(v)) || new Set(vaults.map((v) => lc(String(v)))).size !== vaults.length) bad(`${w}: vaults and bps are not a list of distinct addresses with one weight each`);
    else if (!bps.every((x) => Number.isInteger(x) && (x as number) >= 0) || (bps as number[]).reduce((t, x) => t + x, 0) !== 10000) bad(`${w}: bps do not sum to 10000`);
    if (releasedIds(ev).has(lc(r?.receipt_id ?? ""))) bad(`${w}: the receipt is also under receipt_releases: a receipt is released once`);
    effectiveReadBackProblems(w, r, vaults, bps, true, bad);
  }
  return apps;
}

/**
 * Issue 1743: the router's EFFECTIVE weights are what deposits route by, and the entry records what the read-back saw (`voted_weights_active`, `effective_vaults`, `effective_bps`).
 * `active` is the flag the round must leave: true after an application (applyReceipt sets the router's active vector, issue 1698), false after a clear or a redeploy (routing on
 * the default vector). `vaults` / `bps` are the vector the entry claims the router routes by; undefined for a clear entry, which only needs a well formed vector.
 */
function effectiveReadBackProblems(w: string, r: any, vaults: unknown[] | undefined, bps: unknown[] | undefined, active: boolean, bad: (m: string) => void): void {
  if (r?.voted_weights_active !== active) bad(`${w}: voted_weights_active is ${String(r?.voted_weights_active)}, want ${active}: ${active ? "the applied vector must be the router's active vector" : "the read-back must show no active vector overriding the default"} (issue 1743)`);
  const ev: unknown[] = Array.isArray(r?.effective_vaults) ? r.effective_vaults : [];
  const eb: unknown[] = Array.isArray(r?.effective_bps) ? r.effective_bps : [];
  if (ev.length === 0 || ev.length !== eb.length || !ev.every((v) => typeof v === "string" && ADDR.test(v)) || !eb.every((x) => Number.isInteger(x) && (x as number) >= 0) || (eb as number[]).reduce((t, x) => t + x, 0) !== 10000) {
    bad(`${w}: effective_vaults and effective_bps (the router's getEffectiveWeights after the round) are missing or not a vector summing to 10000`);
    return;
  }
  if (vaults !== undefined && bps !== undefined) {
    const key = (v: unknown[], b: unknown[]) => v.map((x, i) => `${lc(String(x))}:${b[i]}`).join(",");
    if (key(ev, eb) !== key(vaults, bps)) bad(`${w}: the effective weights [${key(ev, eb)}] differ from the applied vector [${key(vaults, bps)}]: routing did not change`);
  }
}

/**
 * A router voted-vector clear (issue 1743, `govern --row clear-voted-weights`), recorded under `voted_weights_clears` (never in `govern`, so stage 13 stays the three unpauses).
 * One entry per round: ONE timelock call, clearVotedWeights() on the governance contract (`governance.address`), one schedule and one execute at least the floor apart, and the
 * read-back: votedWeightsActive false and the effective weights recorded.
 */
const clearLabel = (r: any) => `${CLEAR_ROW} round ${r?.round ?? 1}`;
function clearShapeProblems(ev: any, bad: (m: string) => void): any[] {
  const clears: any[] = ev?.voted_weights_clears === undefined ? [] : Array.isArray(ev.voted_weights_clears) ? ev.voted_weights_clears : (bad("voted_weights_clears is not a list"), []);
  if (clears.length > 0 && !ADDR.test(ev?.governance?.address ?? "")) bad("governance.address is missing: a voted-weights clear has no target to check");
  const seen = new Set<number>();
  for (const r of clears) {
    const w = clearLabel(r);
    if (r?.step !== undefined && r.step !== CLEAR_ROW) bad(`${w}: step '${r.step}' is not ${CLEAR_ROW}`);
    if (r?.round !== undefined && !(Number.isInteger(r.round) && r.round >= 1)) bad(`${w}: round ${r.round} is not a positive integer`);
    const n = Number.isInteger(r?.round) ? r.round : 1;
    if (seen.has(n)) bad(`${w}: more than one evidence entry for this round`); else seen.add(n);
    if (lc(r?.governance ?? "") !== lc(ev?.governance?.address ?? "")) bad(`${w}: governance ${r?.governance} is not the governance contract ${ev?.governance?.address}`);
    if (!ADDR.test(r?.router ?? "")) bad(`${w}: router is not an address`);
    effectiveReadBackProblems(w, r, undefined, undefined, false, bad);
  }
  return clears;
}
/** Offline check of `voted_weights_clears` alone (shape, both transactions, statuses and the delay floor). An empty list is a pass. */
export function checkVotedWeightsClears(ev: any, floor: number = MAINNET_DELAY_FLOOR): string[] {
  const p: string[] = [];
  const clears = clearShapeProblems(ev, (m) => p.push(m));
  forbidCancelFields(clears, (e) => String(e?.step ?? "entry"), (m) => p.push(m));
  operationProblems(clears.map((r) => ({ ...r, step: clearLabel(r) })), (m) => p.push(m), floor);
  return p;
}

/**
 * A vault retirement (issue 1912, ADR-0017, `govern --row retire-vault`), recorded under `vault_retirements` (never in `govern`, so stage 13 stays the three unpauses). One entry per round:
 * ONE timelock batch of two calls, registry.migrateEligibility(vault, false, three legs) then registry.retire(vault), one schedule and one execute at least the floor apart, and the read-back:
 * the three-leg default vector (`vaults`, `bps`, 10000 bps, the retired vault out), voted_weights_active false and the router's effective weights equal to it. An entry with `applied_vector: true` (the row ran with `vector=applied`, issue 1980) instead records voted_weights_active true and the effective weights of the applied vector. Allowed in every kind: the row
 * is the governed path on the live production deployment.
 */
const retireLabel = (r: any) => `${RETIRE_ROW} ${r?.vault ?? "?"} round ${r?.round ?? 1}`;
function retireShapeProblems(ev: any, bad: (m: string) => void): any[] {
  const rs: any[] = ev?.vault_retirements === undefined ? [] : Array.isArray(ev.vault_retirements) ? ev.vault_retirements : (bad("vault_retirements is not a list"), []);
  if (rs.length > 0 && !ADDR.test(ev?.timelock?.address ?? "")) bad("timelock.address is missing: a vault retirement has no timelock to check");
  const seen = new Set<string>();
  for (const r of rs) {
    const w = retireLabel(r);
    if (r?.step !== undefined && r.step !== RETIRE_ROW) bad(`${w}: step '${r.step}' is not ${RETIRE_ROW}`);
    const id = `${lc(String(r?.vault))}:${r?.round ?? 1}`;
    if (seen.has(id)) bad(`${w}: more than one evidence entry for this round`); else seen.add(id);
    for (const k of ["vault", "registry", "router", "timelock"]) if (!ADDR.test(r?.[k] ?? "")) bad(`${w}: ${k} is not an address`);
    if (ADDR.test(r?.registry ?? "") && lc(r.registry) !== lc(ev?.registry?.address ?? "")) bad(`${w}: registry ${r.registry} is not the run's registry ${ev?.registry?.address}`);
    if (ADDR.test(r?.timelock ?? "") && lc(r.timelock) !== lc(ev?.timelock?.address ?? "")) bad(`${w}: timelock ${r.timelock} is not the run's timelock ${ev?.timelock?.address}`);
    const vaults: unknown[] = Array.isArray(r?.vaults) ? r.vaults : [];
    const bps: unknown[] = Array.isArray(r?.bps) ? r.bps : [];
    if (vaults.length !== STAYING_KEYS.length || vaults.length !== bps.length || !vaults.every((v) => typeof v === "string" && ADDR.test(v)) || new Set(vaults.map((v) => lc(String(v)))).size !== vaults.length) bad(`${w}: vaults and bps are not ${STAYING_KEYS.length} distinct addresses with one weight each`);
    else if (!bps.every((x) => Number.isInteger(x) && (x as number) >= 0) || (bps as number[]).reduce((t, x) => t + x, 0) !== 10000) bad(`${w}: bps do not sum to 10000`);
    else if (ADDR.test(r?.vault ?? "") && vaults.some((v) => lc(String(v)) === lc(r.vault))) bad(`${w}: the retired vault ${r.vault} is still in the default vector`);
    // applied_vector: the round accepted an active applied receipt vector (issue 1980). The router then routes by that vector, so the effective weights are not the default vector.
    const applied = r?.applied_vector === true;
    effectiveReadBackProblems(w, r, applied ? undefined : vaults, applied ? undefined : bps, applied, bad);
  }
  return rs;
}
/** Offline check of `vault_retirements` alone (shape, both transactions, statuses and the delay floor). An empty list is a pass. */
export function checkVaultRetirements(ev: any, floor: number = MAINNET_DELAY_FLOOR): string[] {
  const p: string[] = [];
  const rs = retireShapeProblems(ev, (m) => p.push(m));
  forbidCancelFields(rs, (e) => String(e?.step ?? "entry"), (m) => p.push(m));
  operationProblems(rs.map((r) => ({ ...r, step: retireLabel(r) })), (m) => p.push(m), floor);
  return p;
}

/**
 * A single-vault redeploy (issue 1796, the `redeploy-vault` verb and `govern --row redeploy-vault`), recorded under `vault_redeploys` (never in `govern`, so stage 13 stays the three unpauses).
 * One entry per redeploy: the deploy transactions the deployer sent (`deploy_tx_hashes`, `deploy_count`, all status 1), the vault it replaced (`old_vault`, now Retired) and the vault that replaced
 * it (`new_vault`, the address `vaults.<vault>.address` names), ONE timelock batch of five calls, one schedule and one execute at least the floor apart, and the read-back: the final default
 * vector (`vaults`, `bps`, 10000 bps, the new vault in and the old vault out), voted_weights_active false and the router's effective weights equal to it. A REHEARSAL evidence only: a production
 * evidence may carry none (the verb and the row are refused on 8453 in production).
 */
const redeployLabel = (r: any) => `${REDEPLOY_ROW} ${r?.vault ?? "?"} round ${Number.isInteger(r?.ordinal) ? r.ordinal : 1}`;
function redeployShapeProblems(ev: any, kind: DeploymentKind, bad: (m: string) => void): any[] {
  const rs: any[] = ev?.vault_redeploys === undefined ? [] : Array.isArray(ev.vault_redeploys) ? ev.vault_redeploys : (bad("vault_redeploys is not a list"), []);
  if (kind !== "rehearsal") {
    if (rs.length > 0) bad("vault_redeploys is present in a production evidence: redeploying one vault into a live deployment is an experiment on a rehearsal and is refused on 8453 in production (issue 1796)");
    return [];
  }
  const seen = new Set<string>();
  // QA plan v1 E1 (DT-2): a round at another sha than the deployment's (the evidence core_sha) is checked by ONE verify only: at that sha, with --prior-out of a
  // checkout at the deployment's sha. A verify that passed so writes verified_at_sha (the round's sha) and prior_out_sha (the deployment's) on every governed round
  // (verify-stage.ts), so evidence without them never ran that verify. Rounds at the deployment's sha alone need neither; a field present must still be right.
  // No evidence core_sha (a caller that names none): nothing to compare with, the evidence check itself requires it.
  const original: string | undefined = typeof ev?.core_sha === "string" && ev.core_sha !== "" ? ev.core_sha : undefined;
  const roundSha = (r: any): string | undefined => (typeof r?.core_sha === "string" && r.core_sha !== "" ? r.core_sha : original);
  const foreign = original === undefined ? [] : [...new Set(rs.map(roundSha).filter((x): x is string => x !== undefined && x !== original))];
  if (foreign.length > 1) bad(`vault_redeploys: rounds ran at ${foreign.join(", ")}, besides the deployment's ${original}: the verifier compares with two builds only (the checkout and --prior-out), so no verify can check them`);
  const verifiedAt = foreign.length === 1 ? foreign[0]! : original;
  for (const r of rs) {
    const w = redeployLabel(r);
    if (r?.step !== undefined && r.step !== REDEPLOY_ROW) bad(`${w}: step '${r.step}' is not ${REDEPLOY_ROW}`);
    if (typeof r?.vault !== "string" || !ADDR.test(ev?.vaults?.[r.vault]?.address ?? "")) bad(`${w}: vault '${String(r?.vault)}' is not one of the evidence's vaults`);
    const id = `${r?.vault}:${Number.isInteger(r?.ordinal) ? r.ordinal : 1}`;
    if (seen.has(id)) bad(`${w}: more than one evidence entry for this round`); else seen.add(id);
    for (const k of ["old_vault", "new_vault", "registry", "router", "timelock", "deployer", "asset"]) if (!ADDR.test(r?.[k] ?? "")) bad(`${w}: ${k} is not an address`);
    if (ADDR.test(r?.old_vault ?? "") && ADDR.test(r?.new_vault ?? "") && lc(r.old_vault) === lc(r.new_vault)) bad(`${w}: the old and the new vault are the same address`);
    if (ADDR.test(r?.new_vault ?? "") && lc(r.new_vault) !== lc(ev?.vaults?.[r?.vault]?.address ?? "")) bad(`${w}: new_vault ${r.new_vault} is not the address ${ev?.vaults?.[r?.vault]?.address} the evidence names for ${r?.vault}`);
    if (ADDR.test(r?.registry ?? "") && lc(r.registry) !== lc(ev?.registry?.address ?? "")) bad(`${w}: registry ${r.registry} is not the run's registry ${ev?.registry?.address}`);
    if (ADDR.test(r?.timelock ?? "") && lc(r.timelock) !== lc(ev?.timelock?.address ?? "")) bad(`${w}: timelock ${r.timelock} is not the run's timelock ${ev?.timelock?.address}`);
    if (typeof r?.router_vault_cap !== "string" || !/^[0-9]+$/.test(r.router_vault_cap)) bad(`${w}: router_vault_cap must record the approved old cap as a decimal string`);
    // QA plan v1 C2 (issue 1701): the new vault must be a CREATE by the run's deployer (checkVaultRedeploysOnChain reads the receipt's sender and created address)
    if (ADDR.test(r?.deployer ?? "") && ADDR.test(ev?.deployer ?? "") && lc(r.deployer) !== lc(ev.deployer)) bad(`${w}: deployer ${r.deployer} is not the run's deployer ${ev.deployer}: the new vault must be a CREATE by the run's deployer`);
    if (typeof r?.registry_name !== "string" || r.registry_name === "") bad(`${w}: registry_name is missing`);
    // QA plan v1 E1: the verify after the round compared every contract the redeploy did not replace with --prior-out, a build of the deployment's own sha
    if (r?.prior_out_sha !== undefined && original !== undefined && r.prior_out_sha !== original) bad(`${w}: prior_out_sha ${String(r.prior_out_sha)} is not the evidence core_sha ${original}: the contracts the redeploy did not replace are verified against the build of the original deployment sha`);
    if (foreign.length > 0) {
      const how = `a round ran at ${foreign.join(", ")}, not at the deployment's ${original}, so the verify after it runs at that sha with --prior-out of a checkout at ${original} and records it on every round`;
      if (r?.prior_out_sha === undefined) bad(`${w}: prior_out_sha is missing: ${how}`);
      if (r?.verified_at_sha === undefined) bad(`${w}: verified_at_sha is missing: ${how}`);
    } else if ((r?.verified_at_sha === undefined) !== (r?.prior_out_sha === undefined)) bad(`${w}: verified_at_sha and prior_out_sha are written together by a passing verify with --prior-out: one of them is missing`);
    if (r?.verified_at_sha !== undefined && verifiedAt !== undefined && foreign.length <= 1 && r.verified_at_sha !== verifiedAt) bad(`${w}: verified_at_sha ${String(r.verified_at_sha)} is not ${verifiedAt}: ${foreign.length ? `the replacing vault runs the build of ${verifiedAt}, the sha its round ran at` : "every round ran at the deployment's sha, so its verify runs there"}`);
    // the deploy half: every transaction the deployer sent for the vault, each with status 1
    const hashes: unknown[] = Array.isArray(r?.deploy_tx_hashes) ? r.deploy_tx_hashes : [];
    const st: unknown[] = Array.isArray(r?.deploy_receipt_statuses) ? r.deploy_receipt_statuses : [];
    if (!Number.isInteger(r?.deploy_count) || r.deploy_count < 1) bad(`${w}: deploy_count is not a positive integer`);
    else if (hashes.length !== r.deploy_count) bad(`${w}: ${hashes.length} deploy tx hashes for deploy_count ${r.deploy_count}`);
    hashes.forEach((h, i) => { if (typeof h !== "string" || !TX.test(h)) bad(`${w}: deploy tx hash ${i} is missing or malformed`); });
    if (st.length !== hashes.length) bad(`${w}: ${st.length} deploy receipt statuses for ${hashes.length} deploy tx hashes`);
    st.forEach((x, i) => { if (x !== 1) bad(`${w}: deploy receipt ${i} status is ${x}, not 1`); });
    // the govern half: the final vector and the read-back
    const vaults: unknown[] = Array.isArray(r?.vaults) ? r.vaults : [];
    const bps: unknown[] = Array.isArray(r?.bps) ? r.bps : [];
    if (vaults.length === 0 || vaults.length !== bps.length || !vaults.every((v) => typeof v === "string" && ADDR.test(v)) || new Set(vaults.map((v) => lc(String(v)))).size !== vaults.length) bad(`${w}: vaults and bps are not a list of distinct addresses with one weight each`);
    else if (!bps.every((x) => Number.isInteger(x) && (x as number) >= 0) || (bps as number[]).reduce((t, x) => t + x, 0) !== 10000) bad(`${w}: bps do not sum to 10000`);
    else {
      try { vectorsFromFinal({ finalVaults: vaults as string[], finalBps: bps as number[], oldVault: r.old_vault, newVault: r.new_vault }); } catch (e) { bad(`${w}: ${(e as Error).message}`); }
    }
    effectiveReadBackProblems(w, r, vaults, bps, false, bad);
    if (r?.old_vault_status !== "Retired") bad(`${w}: old_vault_status is ${String(r?.old_vault_status)}, want Retired`);
    if (r?.new_vault_status !== "Active") bad(`${w}: new_vault_status is ${String(r?.new_vault_status)}, want Active`);
  }
  return rs;
}
/** The deployer transactions the redeploys sent. They are outside every frozen stage count, so the final deployer nonce adds them. */
const redeployTxs = (ev: any): number => (Array.isArray(ev?.vault_redeploys) ? ev.vault_redeploys : []).reduce((t: number, r: any) => t + (Number.isInteger(r?.deploy_count) && r.deploy_count > 0 ? r.deploy_count : 0), 0);
/** The vaults a redeploy retired: still listed by the registry. */
const retiredVaults = (ev: any): string[] => (Array.isArray(ev?.vault_redeploys) ? ev.vault_redeploys : []).map((r: any) => lc(String(r?.old_vault ?? ""))).filter((a: string) => a !== "");
/** Offline check of `vault_redeploys` alone (shape, both transactions, statuses and the delay floor). An empty list is a pass. */
export function checkVaultRedeploys(ev: any, floor: number = MAINNET_DELAY_FLOOR, kind: DeploymentKind = "rehearsal"): string[] {
  const p: string[] = [];
  const rs = redeployShapeProblems(ev, kind, (m) => p.push(m));
  forbidCancelFields(rs, (e) => String(e?.step ?? "entry"), (m) => p.push(m));
  operationProblems(rs.map((r) => ({ ...r, step: redeployLabel(r) })), (m) => p.push(m), floor);
  return p;
}
const releasedIds = (ev: any): Set<string> => new Set<string>((Array.isArray(ev?.receipt_releases) ? ev.receipt_releases : []).map((r: any) => lc(String(r?.receipt_id ?? ""))));

/** Offline check of `receipt_applications` alone: the shape, both transactions, the statuses and the delay floor. Problems; an empty list is a pass. */
export function checkReceiptApplications(ev: any, floor: number = MAINNET_DELAY_FLOOR): string[] {
  const p: string[] = [];
  const apps = applicationShapeProblems(ev, (m) => p.push(m));
  operationProblems(apps.map((r) => ({ ...r, step: applyLabel(r) })), (m) => p.push(m), floor);
  return p;
}

/**
 * Issue 1910: the `migration` of a `proxy_upgrades` entry (govern --row upgrade-proxy --migration). Absent is a plain upgrade (empty data). Present, it must be a named typed
 * migration of THIS proxy whose function, selector, data and data hash are exactly the reviewed encoding for its releaser, and the releaser must be the deployment's
 * RouterGovernance when the evidence names one. Free hex never passes: the data is recomputed here from the name and the address.
 */
function migrationEntryProblems(e: any, w: string, governance: unknown, bad: (m: string) => void): void {
  const mg = e?.migration;
  if (mg === undefined) return;
  if (!mg || typeof mg !== "object" || Array.isArray(mg)) { bad(`${w}: migration is not an object`); return; }
  const def = Object.prototype.hasOwnProperty.call(UPGRADE_MIGRATIONS, String(mg.name)) ? UPGRADE_MIGRATIONS[String(mg.name)] : undefined;
  if (!def) { bad(`${w}: migration ${JSON.stringify(mg.name)} is not a known typed migration (${Object.keys(UPGRADE_MIGRATIONS).join(", ")})`); return; }
  if (def.proxy !== e?.proxy_name) bad(`${w}: migration ${mg.name} belongs to the ${def.proxy} proxy, not ${e?.proxy_name}`);
  if (mg.function !== def.functionName) bad(`${w}: migration function ${mg.function} is not ${def.functionName}`);
  if (!ADDR.test(mg.releaser ?? "")) { bad(`${w}: migration releaser is not an address`); return; }
  if (/^0x0{40}$/i.test(mg.releaser)) bad(`${w}: migration releaser is the zero address`);
  if (ADDR.test(String(governance ?? "")) && lc(mg.releaser) !== lc(String(governance))) bad(`${w}: migration releaser ${mg.releaser} is not RouterGovernance ${String(governance)}`);
  const want = pinnedMigrationData(String(mg.name), mg.releaser);
  if (lc(String(mg.data ?? "")) !== lc(want)) bad(`${w}: migration data is not ${def.functionName}(${mg.releaser}) of the reviewed signature`);
  if (lc(String(mg.selector ?? "")) !== lc(want.slice(0, 10))) bad(`${w}: migration selector ${mg.selector} is not ${want.slice(0, 10)}`);
  if (lc(String(mg.data_hash ?? "")) !== lc(keccak256(want))) bad(`${w}: migration data_hash ${mg.data_hash} is not the keccak256 of the migration data`);
}

/**
 * Issue 1859: `upgrade_freezes` (govern --row freeze-upgrades) and `proxy_upgrades` (govern --row upgrade-proxy), the governed-upgrade operations the run manifest records. Both
 * lists are optional. Each entry is ONE executed timelock operation: its id, the schedule and the execute transaction (status 1, at least the floor apart, none shared) and never
 * a cancel field. A transaction this tool did not send and could not recover from the timelock's log (an execution adopted from the chain) is null, with a null status and
 * timestamp, and the entry's `note` says why. A freeze names its targets (proxy, implementation, code hash); an upgrade names the proxy and both implementations.
 */
export function governedUpgradeProblems(ev: any, floor: number = MAINNET_DELAY_FLOOR, proxies: readonly string[] = repoProxyNames()): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const list = (k: string): any[] => (ev?.[k] === undefined ? [] : Array.isArray(ev[k]) ? ev[k] : (bad(`${k} is not a list`), []));
  const entries: [any, string][] = [...list("upgrade_freezes").map((e): [any, string] => [e, FREEZE_ROW]), ...list("proxy_upgrades").map((e): [any, string] => [e, UPGRADE_ROW])];
  const label = (e: any, step: string) => `${step}${step === UPGRADE_ROW ? ` ${e?.proxy_name}` : ""} ${e?.operation_id}`;
  for (const [e, step] of entries) forbidCancelFields([e], () => label(e, step), bad);
  const tl = ev?.timelock?.address;
  const seen = new Map<string, string>();
  for (const [e, step] of entries) {
    const w = label(e, step);
    if (e?.step !== step) bad(`${w}: step '${e?.step}' is not ${step}`);
    if (!ADDR.test(e?.timelock ?? "")) bad(`${w}: timelock is not an address`);
    else if (ADDR.test(tl ?? "") && lc(e.timelock) !== lc(tl)) bad(`${w}: timelock ${e.timelock} is not the deployed timelock ${tl}`);
    if (!TX.test(e?.operation_id ?? "")) bad(`${w}: operation_id is not a bytes32`);
    for (const k of ["operation_id", "schedule_tx", "execute_tx"]) {
      if (!TX.test(e?.[k] ?? "")) continue;
      const other = seen.get(`${k}:${lc(e[k])}`);
      if (other !== undefined) bad(`${w}: ${k} is also the ${k} of ${other} (one operation per freeze or upgrade, none shared)`);
      else seen.set(`${k}:${lc(e[k])}`, w);
    }
    for (const kind of ["schedule", "execute"]) {
      const tx = e?.[`${kind}_tx`], status = e?.[`${kind}_status`], at = e?.[`${kind}_block_timestamp`];
      if (tx === null) {
        if (status !== null || at !== null) bad(`${w}: ${kind}_tx is null, so ${kind}_status and ${kind}_block_timestamp must be null`);
        if (typeof e.note !== "string" || e.note.trim() === "") bad(`${w}: ${kind}_tx is null with no note: an unknown transaction is recorded only with the reason`);
        continue;
      }
      if (!TX.test(tx ?? "")) bad(`${w}: ${kind}_tx is missing`);
      if (status !== 1) bad(`${w}: ${kind} receipt status is ${status}`);
      if (!Number.isInteger(at)) bad(`${w}: ${kind}_block_timestamp is not a block timestamp`);
    }
    if (TX.test(e?.schedule_tx ?? "") && TX.test(e?.execute_tx ?? "")) {
      if (lc(e.schedule_tx) === lc(e.execute_tx)) bad(`${w}: execute_tx is also the schedule_tx`);
      else if (Number.isInteger(e.schedule_block_timestamp) && Number.isInteger(e.execute_block_timestamp) && !(e.execute_block_timestamp - e.schedule_block_timestamp >= floor)) bad(`${w}: schedule-to-execute gap ${e.execute_block_timestamp - e.schedule_block_timestamp} s is under ${floor} s`);
    }
    if (step === FREEZE_ROW) {
      const targets = e?.targets && typeof e.targets === "object" && !Array.isArray(e.targets) ? Object.entries<any>(e.targets) : [];
      if (targets.length === 0) bad(`${w}: targets name no proxy`);
      for (const [n, t] of targets) {
        if (!proxies.includes(n)) bad(`${w}: target ${n} is not a proxied core contract of the stage table`);
        if (!ADDR.test(t?.proxy ?? "") || !ADDR.test(t?.implementation ?? "")) bad(`${w}: target ${n} has no proxy or implementation address`);
        if (!TX.test(t?.implementation_code_hash ?? "")) bad(`${w}: target ${n} implementation_code_hash is not a bytes32`);
      }
    } else {
      if (!proxies.includes(e?.proxy_name)) bad(`${w}: proxy_name ${e?.proxy_name} is not a proxied core contract of the stage table`);
      for (const k of ["proxy", "from_implementation", "to_implementation"]) if (!ADDR.test(e?.[k] ?? "")) bad(`${w}: ${k} is not an address`);
      if (ADDR.test(e?.from_implementation ?? "") && lc(e.from_implementation) === lc(e?.to_implementation ?? "")) bad(`${w}: to_implementation equals from_implementation, nothing was upgraded`);
      if (!TX.test(e?.to_code_hash ?? "")) bad(`${w}: to_code_hash is not a bytes32`);
      if (e?.from_code_hash !== null && !TX.test(e?.from_code_hash ?? "")) bad(`${w}: from_code_hash is neither a bytes32 nor null`);
      const fields = e?.manifest_fields && typeof e.manifest_fields === "object" && !Array.isArray(e.manifest_fields) ? Object.values<unknown>(e.manifest_fields) : [];
      if (!fields.some((v) => typeof v === "string" && lc(v) === lc(String(e?.to_implementation ?? "")))) bad(`${w}: manifest_fields does not re-record the implementation field to ${e?.to_implementation}`);
      if (typeof e?.build !== "string" || e.build === "") bad(`${w}: build names no core checkout`);
      migrationEntryProblems(e, w, ev?.governance?.address, bad);
    }
  }
  return p;
}

/**
 * Issue 1888, the receipt path. `submitter_registrations`: one entry per submitter, ONE delayed timelock call (receipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter)), one schedule and one execute
 * at least the floor apart. `committee_registrations` is HISTORICAL (issues 1727 and 1750: the retired two-call gateway batch, step register-committee): it is still decoded so pinned releases and
 * rehearsal fixtures validate, and a new run never writes it. `recorded_receipts`: one entry per receipt the submitter Safe anchored directly on the receipt contract (receipt_id, payload_digest,
 * payload_uri, submitter ADDRESS, tx_hash, submitter_safe; never a key). All three may appear in any evidence kind. In a rehearsal every receipt_applications entry must trace to a recorded
 * receipt with the same digest, by a registered submitter.
 */
/**
 * The consensus receipt submitter is a Safe (issue 1750, owner decision 2026-10-10; on every chain and in every mode since issue 1888). An entry's `submitter_safe` names the Safe's threshold
 * (2 or more), owners and proxy code hash; a recorded receipt's also the Safe transaction hash, the nonce and the owners that signed (at least the threshold, all owners). An entry WITHOUT it is a
 * single key: refused everywhere, except for a HISTORICAL committee registration (and the receipts of a historical submitter) off 8453, which pinned rehearsal fixtures carry. The submitter may
 * be the governing Safe and its owners may be shared (issue 1888); it may not be the timelock or the deployer.
 */
function submitterSafeProblems(ev: any, r: any, w: string, recorded: boolean, bad: (m: string) => void, historical = false): void {
  const sub = String(r?.submitter ?? "");
  const roleKeys = new Map<string, string>([
    [lc(ev?.timelock?.address ?? ""), "the timelock"], [lc(ev?.deployer ?? ""), "the deployer (admin)"],
    ...(historical ? ((Array.isArray(ev?.safe?.owners) ? ev.safe.owners : []) as string[]).map((o, i) => [lc(o), `governing Safe owner ${i + 1}`] as [string, string]) : []),
    ...(historical ? [[lc(ev?.safe?.address ?? ""), "the governing Safe"] as [string, string]] : []),
  ]);
  roleKeys.delete("");
  const why = roleKeys.get(lc(sub));
  const sf = r?.submitter_safe;
  if (why) bad(`${w}: the submitter ${sub} is ${why}: the submitter is a Safe that holds RECEIPT_SUBMITTER_ROLE and nothing else`);
  if (sf === undefined) {
    if (!historical || ev?.chain_id === MAINNET_CHAIN_ID) bad(`${w}: no submitter_safe: the consensus receipt submitter is a multisig Safe on every chain, never a single key`);
    return;
  }
  const owners: string[] = Array.isArray(sf?.owners) ? sf.owners : [];
  if (!Number.isInteger(sf?.threshold) || sf.threshold < 2) bad(`${w}: submitter_safe.threshold is ${sf?.threshold}, want 2 or more`);
  if (owners.length === 0 || !owners.every((o) => ADDR.test(o ?? ""))) bad(`${w}: submitter_safe.owners is not a list of addresses`);
  else if (Number.isInteger(sf?.threshold) && owners.length < sf.threshold) bad(`${w}: submitter_safe has ${owners.length} owners, under its threshold ${sf.threshold}`);
  if (!TX.test(sf?.code_hash ?? "")) bad(`${w}: submitter_safe.code_hash is not a bytes32`);
  if (sf?.address !== undefined && ADDR.test(sub) && lc(sf.address) !== lc(sub)) bad(`${w}: submitter_safe.address ${sf.address} is not the submitter ${sub}`);
  if (!recorded || r?.already_recorded === true) return;
  if (!TX.test(sf?.safe_tx_hash ?? "")) bad(`${w}: submitter_safe.safe_tx_hash is not a bytes32`);
  if (!Number.isInteger(sf?.nonce) || sf.nonce < 0) bad(`${w}: submitter_safe.nonce is not a non-negative integer`);
  const signers: string[] = Array.isArray(sf?.signers) ? sf.signers : [];
  if (new Set(signers.map(lc)).size !== signers.length) bad(`${w}: submitter_safe.signers repeats an owner`);
  if (Number.isInteger(sf?.threshold) && signers.length < sf.threshold) bad(`${w}: submitter_safe.signers has ${signers.length} owners, under the threshold ${sf.threshold}`);
  const strangers = signers.filter((x) => !owners.some((o) => lc(o) === lc(x)));
  if (strangers.length) bad(`${w}: submitter_safe.signers ${strangers.join(", ")} are not owners of the submitter Safe`);
}
/**
 * PURE. A submitter Safe is registered once, except across the receipt migration: the v0.5.0 tool registered it with the historical two-call batch (`committee_registrations`), and
 * `migrateToSubmitterRoles` (the `receipt-submitter-roles` typed migration of runbook 4.15) leaves RECEIPT_SUBMITTER_ROLE with no holder, so the v0.6.0 `register-submitter` row grants it
 * again (`submitter_registrations`). Such a pair is valid only when a receipt upgrade with that migration executed after the historical registration and before the new one was scheduled.
 */
export function reRegistrationProblems(hist: any[], news: any[], upgrades: any[]): string[] {
  const out: string[] = [];
  for (const r of news) {
    const before = hist.filter((h) => ADDR.test(h?.submitter ?? "") && lc(h.submitter) === lc(r?.submitter ?? ""));
    if (before.length === 0) continue;
    // Timestamps are integers or the pair is refused: Number(null) and Number("") are 0 and would widen the window to everything before the new registration.
    const stamps = before.map((h) => h?.execute_block_timestamp);
    const from = Math.max(...stamps.map(Number)), to = Number(r?.schedule_block_timestamp);
    const migrated = stamps.every((t) => Number.isInteger(t)) && Number.isInteger(r?.schedule_block_timestamp)
      && upgrades.some((u) => u?.proxy_name === "receipt" && u?.migration?.name === "receipt-submitter-roles" && Number.isInteger(u?.execute_block_timestamp) && u.execute_block_timestamp >= from && u.execute_block_timestamp <= to);
    if (!migrated) out.push(`${regLabel(r)}: submitter is also a historical committee registration; a second registration is valid only after a receipt-submitter-roles migration executed between them`);
  }
  return out;
}
const regLabel = (r: any) => `${REGISTER_ROW} ${r?.submitter}`;
const histLabel = (r: any) => `${HISTORICAL_REGISTER_ROW} ${r?.submitter}`;
const recLabel = (r: any) => `recorded receipt ${r?.receipt_id}`;
function receiptPathProblems(ev: any, kind: DeploymentKind, applications: any[], bad: (m: string) => void): any[] {
  const hist: any[] = ev?.committee_registrations === undefined ? [] : Array.isArray(ev.committee_registrations) ? ev.committee_registrations : (bad("committee_registrations is not a list"), []);
  const news: any[] = ev?.submitter_registrations === undefined ? [] : Array.isArray(ev.submitter_registrations) ? ev.submitter_registrations : (bad("submitter_registrations is not a list"), []);
  const recs: any[] = ev?.recorded_receipts === undefined ? [] : Array.isArray(ev.recorded_receipts) ? ev.recorded_receipts : (bad("recorded_receipts is not a list"), []);
  const seenSub = new Set<string>();
  const histSub = new Set<string>();
  // HISTORICAL registrations (issues 1727, 1750): the retired gateway batch. Decoded as before so pinned evidence validates. A new run never writes them.
  for (const r of hist) {
    const w = histLabel(r);
    if (!ADDR.test(r?.submitter ?? "")) bad(`${w}: submitter is not an address`);
    else if (histSub.has(lc(r.submitter))) bad(`${w}: submitter has more than one evidence entry`);
    else { seenSub.add(lc(r.submitter)); histSub.add(lc(r.submitter)); }
    if (r?.step !== undefined && r.step !== HISTORICAL_REGISTER_ROW) bad(`${w}: step '${r.step}' is not ${HISTORICAL_REGISTER_ROW}`);
    for (const k of ["gateway", "ic_policy", "timelock"]) if (!ADDR.test(r?.[k] ?? "")) bad(`${w}: ${k} is not an address`);
    if (ADDR.test(r?.timelock ?? "") && lc(r.timelock) !== lc(ev?.timelock?.address ?? "")) bad(`${w}: timelock ${r.timelock} is not the run's timelock ${ev?.timelock?.address}`);
    submitterSafeProblems(ev, r, w, false, bad, true);
    if (typeof r?.agent_label !== "string" || r.agent_label === "") bad(`${w}: agent_label is missing`);
    if (!/^[0-9]+$/.test(String(r?.valid_until ?? ""))) bad(`${w}: valid_until is not a decimal timestamp`);
    // QA plan v1 B6: the submitter Safe's private self-authorization, as its three transactions (the chain check orders the hand-over before the schedule)
    const sa = r?.self_authorization;
    if (sa !== undefined) for (const k of ["commit_tx", "reveal_tx", "hand_over_tx"]) if (sa?.[k] !== undefined && !TX.test(String(sa[k]))) bad(`${w}: self_authorization.${k} is not a transaction hash`);
  }
  // The live registration (issue 1888): ONE receipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter), a Safe, on any chain and kind.
  const newSub = new Set<string>();
  for (const r of news) {
    const w = regLabel(r);
    if (!ADDR.test(r?.submitter ?? "")) bad(`${w}: submitter is not an address`);
    else if (newSub.has(lc(r.submitter))) bad(`${w}: submitter has more than one evidence entry`);
    else { newSub.add(lc(r.submitter)); seenSub.add(lc(r.submitter)); }
    if (r?.step !== undefined && r.step !== REGISTER_ROW) bad(`${w}: step '${r.step}' is not ${REGISTER_ROW}`);
    for (const k of ["receipt", "timelock"]) if (!ADDR.test(r?.[k] ?? "")) bad(`${w}: ${k} is not an address`);
    if (ADDR.test(r?.timelock ?? "") && lc(r.timelock) !== lc(ev?.timelock?.address ?? "")) bad(`${w}: timelock ${r.timelock} is not the run's timelock ${ev?.timelock?.address}`);
    if (ADDR.test(r?.receipt ?? "") && ADDR.test(ev?.consensus_receipt?.address ?? "") && lc(r.receipt) !== lc(ev.consensus_receipt.address)) bad(`${w}: receipt ${r.receipt} is not the run's receipt contract ${ev.consensus_receipt.address}`);
    submitterSafeProblems(ev, r, w, false, bad);
  }
  for (const m of reRegistrationProblems(hist, news, Array.isArray(ev?.proxy_upgrades) ? ev.proxy_upgrades : [])) bad(m);
  const seenRec = new Set<string>();
  for (const r of recs) {
    const w = recLabel(r);
    if (!TX.test(r?.receipt_id ?? "")) bad(`${w}: receipt_id is not a bytes32`);
    else if (seenRec.has(lc(r.receipt_id))) bad(`${w}: receipt_id has more than one evidence entry`);
    else seenRec.add(lc(r.receipt_id));
    if (!TX.test(r?.payload_digest ?? "")) bad(`${w}: payload_digest is not a bytes32`);
    if (typeof r?.payload_uri !== "string" || !/^https?:\/\//.test(r.payload_uri)) bad(`${w}: payload_uri is not an http(s) route`);
    if (!ADDR.test(r?.submitter ?? "")) bad(`${w}: submitter is not an address`);
    else if (kind === "rehearsal" && !seenSub.has(lc(r.submitter))) bad(`${w}: submitter ${r.submitter} has no submitter_registrations (or historical committee_registrations) entry: a receipt is recorded only by a registered submitter`);
    submitterSafeProblems(ev, r, w, true, bad, ADDR.test(r?.submitter ?? "") && histSub.has(lc(r.submitter)));
    if (r?.already_recorded !== true && !TX.test(r?.tx_hash ?? "")) bad(`${w}: tx_hash is missing`);
    if (r?.status !== 1) bad(`${w}: status is ${r?.status}`);
  }
  if (kind === "rehearsal") {
    for (const a of applications) {
      const rec = recs.find((x) => lc(x?.receipt_id ?? "") === lc(a?.receipt_id ?? ""));
      if (!rec) bad(`${applyLabel(a)}: the receipt was not recorded by the submitter Safe in this run (no recorded_receipts entry): a rehearsal applies a REAL recorded receipt`);
      else if (lc(rec.payload_digest ?? "") !== lc(a?.payload_digest ?? "")) bad(`${applyLabel(a)}: payload_digest ${a?.payload_digest} differs from the recorded receipt's ${rec.payload_digest}`);
    }
  }
  return [...hist, ...news];
}
const registrationOperations = (regs: any[]): any[] => regs.map((r) => ({ ...r, step: r?.step === REGISTER_ROW ? regLabel(r) : histLabel(r) }));

/** How the evidence is read (issue 1727). `kind` is the deployment kind the caller expects: production unless the operator passed --deployment-kind rehearsal. */
export interface EvidenceOpts {
  kind?: DeploymentKind;
  /** Issue 1809: the full proxied core set by verifier name (the stage table's proxies). Absent: read from this repo's stage table. */
  proxies?: readonly string[];
  /** Issue 1833 test seam: the per-vault rule rows. Absent: this checkout's stage table (vault-rules.ts). */
  vaultRules?: readonly (TableVault & VaultRules)[];
  /** Issue 1892: the stage names of each system, from the table. Absent: the gateway check uses its default list. */
  systemStages?: Partial<Record<"vaults" | "gateway", readonly string[]>>;
}
/** Issue 1809: the proxied core set of the stage table at the root of this checkout. */
export const repoProxyNames = (system: "vaults" | "legacy" = "legacy"): string[] => proxySpecs(scopeTable(loadStageTable(new URL("../../", import.meta.url).pathname), system)).map((s) => s.name); // issue 1892: the vaults system has no gateway proxy; legacy is the combined deployment
const kindOf = (o?: EvidenceOpts): DeploymentKind => o?.kind ?? "production";
/** The kind the evidence claims (absent: production) against the kind it is read as. A mismatch is always a problem, whichever way round. */
function kindProblems(ev: any, expected: DeploymentKind, bad: (m: string) => void): void {
  const claimed = ev?.deployment_kind ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(claimed)) { bad(`deployment_kind '${String(claimed)}' is not ${DEPLOYMENT_KINDS.join(" or ")}`); return; }
  if (claimed !== expected) bad(`deployment_kind is ${claimed}, the evidence is checked as ${expected}${claimed === "rehearsal" ? ": a rehearsal evidence is never production evidence (pass --deployment-kind rehearsal to check a rehearsal)" : ": a production evidence is not a rehearsal"}`);
}

/**
 * Issue 1727: the rehearsal-only govern rows on 8453, recorded under `rehearsal_rows` (never in `govern`, so stage 13 stays the three unpauses). update-delay and batch:
 * one schedule and one execute at least the floor apart. cancel: a schedule and a cancel_tx, no execute. Refused in production.
 */
export const REHEARSAL_ROWS = ["update-delay", "batch", "cancel"] as const;
const rowLabel = (r: any) => `rehearsal row ${r?.step}`;
function rehearsalRowProblems(ev: any, kind: DeploymentKind, bad: (m: string) => void): any[] {
  const rows: any[] = ev?.rehearsal_rows === undefined ? [] : Array.isArray(ev.rehearsal_rows) ? ev.rehearsal_rows : (bad("rehearsal_rows is not a list"), []);
  if (kind !== "rehearsal") {
    if (rows.length > 0) bad(`rehearsal_rows is present in a production evidence: update-delay, batch and cancel are refused on 8453 in production`);
    return [];
  }
  const seen = new Set<string>();
  for (const r of rows) {
    if (!(REHEARSAL_ROWS as readonly string[]).includes(r?.step)) bad(`${rowLabel(r)}: step '${r?.step}' is not one of ${REHEARSAL_ROWS.join(", ")}`);
    else if (seen.has(r.step)) bad(`${rowLabel(r)}: more than one evidence entry`);
    else seen.add(r.step);
    if (r?.step === "cancel") {
      if (!TX.test(r?.cancel_tx ?? "")) bad(`${rowLabel(r)}: cancel_tx is missing`);
      if (r?.cancel_status !== 1) bad(`${rowLabel(r)}: cancel receipt status is ${r?.cancel_status}`);
      if (r?.execute_tx !== undefined) bad(`${rowLabel(r)}: a cancelled operation has no execute_tx`);
    }
  }
  // schedule/execute shape, uniqueness across every operation of the evidence is checked by the caller together with the unpauses
  return rows;
}
/** The rows as operations for operationProblems: cancel maps its cancel transaction onto the execute fields and skips the gap. */
const rowOperations = (rows: any[]): any[] => rows.map((r) => {
  const op = { ...(r.step === "cancel" ? { ...r, execute_tx: r.cancel_tx, execute_status: r.cancel_status } : r), step: rowLabel(r) };
  if (r.step === "cancel") INTERNAL_CANCELS.add(op);
  return op;
});

/**
 * The deployer start nonce the final nonce is counted from. Production: 0, always (a fresh deployer; a `deployer_start_nonce` in a production evidence is refused).
 * Rehearsal: `deployer_start_nonce`, required, a non-negative integer (the run manifest's deployerStartNonce).
 */
function startNonceOf(ev: any, kind: DeploymentKind, bad: (m: string) => void): number {
  if (kind !== "rehearsal") {
    if (ev?.deployer_start_nonce !== undefined) bad("deployer_start_nonce is present in a production evidence: a production deployer is fresh, its nonce starts at 0");
    return 0;
  }
  if (!Number.isInteger(ev?.deployer_start_nonce) || ev.deployer_start_nonce < 0) { bad("deployer_start_nonce is missing: a rehearsal deployer is not fresh, the evidence records the nonce the run started at"); return 0; }
  return ev.deployer_start_nonce;
}

/**
 * An ADOPTED stage (issue 1721): a stage whose CREATE2 libraries already sat on chain (the libs stage: its one library; a basket stage: BasketAssetConfigGuard,
 * TwapTickMath, BasketViews), so the deployer sent fewer transactions than the frozen count. The stage entry carries
 * `adopted: { libraries: [{ name, address, code_hash }], deployer_txs }`. `deployer_txs` is what this deployer sent and is the stage's contribution to the
 * deployer nonce: between (frozen count - number of adopted libraries) and the frozen count (the libs stage may send none). The entry names at least one library.
 */
const adoptedOf = (s: any): any => (s?.adopted === undefined || s.adopted === null ? undefined : s.adopted);
/** stage -> deployer transactions, for the stages the evidence records as adopted. Malformed entries are skipped here and named by checkEvidence. */
export function adoptedTxsOfEvidence(ev: any): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of Array.isArray(ev?.stages) ? ev.stages : []) {
    const a = adoptedOf(s);
    if (a && Number.isInteger(a.deployer_txs)) out[s.stage] = a.deployer_txs;
  }
  return out;
}
/** The frozen counts with every adopted stage counted at the transactions the deployer sent. An impossible adopted entry leaves the counts as frozen, so the nonce check still fails on it. */
function effectiveForEvidence(ev: any, frozenCounts: Record<string, number>): Record<string, number> {
  // Issue 1892: an evidence that names its system is summed over that system's stages only (the frozen file holds both systems' counts).
  const scoped = ev?.system === undefined ? frozenCounts : Object.fromEntries(Object.entries(frozenCounts).filter(([k]) => k === SAFE_STAGE || (Array.isArray(ev?.stages) && ev.stages.some((s: any) => s?.stage === k))));
  try { return effectiveCounts(scoped, adoptedTxsOfEvidence(ev)); } catch { return scoped; }
}
const adoptedLibraries = (s: any): { name?: string; address?: string; code_hash?: string }[] => (Array.isArray(adoptedOf(s)?.libraries) ? adoptedOf(s).libraries : []);

/** stage -> how many libraries the stage table lets it adopt (libs: its linked libraries; a basket stage: its create2Libraries). The CLI passes it from the table. */
export type AdoptableLibraries = Record<string, number>;

export function checkEvidence(ev: any, frozenCounts?: Record<string, number>, adoptable?: AdoptableLibraries, opts?: EvidenceOpts): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const kind = kindOf(opts);
  // Issue 1892: a gateway system evidence is checked on its own; a vaults evidence that names its system carries none of the gateway system's stages. Absent system: the combined legacy evidence.
  if (ev?.system === "gateway") return checkGatewayEvidence(ev, frozenCounts, { kind, stages: opts?.systemStages?.gateway });
  if (ev?.system !== undefined && ev.system !== "vaults") return [`system '${String(ev.system)}' is not vaults or gateway`];
  if (ev?.system === "vaults") {
    for (const s of Array.isArray(ev?.stages) ? ev.stages : []) if (GATEWAY_EVIDENCE_STAGES.includes(s?.stage)) bad(`stage ${s.stage} belongs to the gateway system: a vaults evidence has no gateway stage`);
    if (ev?.gateway !== undefined) bad("'gateway' belongs to the gateway system's evidence: a vaults evidence has no gateway");
  }
  const floor = delayFloor(MAINNET_CHAIN_ID, kind);
  kindProblems(ev, kind, bad);
  if (ev?.chain_id !== MAINNET_CHAIN_ID) bad(`chain_id is ${ev?.chain_id}, evidence is read for ${MAINNET_CHAIN_ID}`);
  if (!/^[0-9a-f]{40}$/.test(ev?.core_sha ?? "") || /^0+$/.test(ev.core_sha)) bad("core_sha is missing or a placeholder");
  try { assertOwnerExceptions(ev?.owner_exceptions, ev?.plan_approved_at); } catch (e) { bad((e as Error).message); }

  const stages: any[] = Array.isArray(ev?.stages) ? ev.stages : [];
  if (stages.length === 0) bad("no stages recorded");
  for (const s of stages) {
    const hashes: unknown[] = Array.isArray(s.tx_hashes) ? s.tx_hashes : [];
    const st: unknown[] = Array.isArray(s.receipts_status) ? s.receipts_status : [];
    const adopted = adoptedOf(s);
    if (adopted !== undefined) {
      // an adopted stage sent no (or fewer) transactions: its frozen count is not demanded of the receipts, its deployer_txs is
      if (!Number.isInteger(adopted.deployer_txs) || adopted.deployer_txs < 0) bad(`stage ${s.stage}: adopted.deployer_txs is not a non-negative integer`);
      else {
        if (s.receipt_count !== adopted.deployer_txs) bad(`stage ${s.stage}: receipt_count ${s.receipt_count} differs from adopted.deployer_txs ${adopted.deployer_txs}`);
        if (s.frozen_count !== undefined && frozenCounts && s.stage in frozenCounts && frozenCounts[s.stage] !== s.frozen_count) bad(`stage ${s.stage}: frozen_count ${s.frozen_count} differs from the frozen file (${frozenCounts[s.stage]})`);
        if (frozenCounts && s.stage in frozenCounts && adopted.deployer_txs > frozenCounts[s.stage]!) bad(`stage ${s.stage}: adopted.deployer_txs ${adopted.deployer_txs} is above the frozen count ${frozenCounts[s.stage]}`);
        // a stage adopts at most one creation per adopted library: it cannot send fewer than the frozen count less that many (the libs stage may send none)
        if (frozenCounts && s.stage in frozenCounts && s.stage !== LIBS_STAGE && adopted.deployer_txs < frozenCounts[s.stage]! - adoptedLibraries(s).length) bad(`stage ${s.stage}: adopted.deployer_txs ${adopted.deployer_txs} is below the frozen count ${frozenCounts[s.stage]} less its ${adoptedLibraries(s).length} adopted librar${adoptedLibraries(s).length === 1 ? "y" : "ies"}`);
      }
      const libs = adoptedLibraries(s);
      if (libs.length === 0) bad(`stage ${s.stage}: adopted names no library`);
      // the list length sets the lowest allowed deposit count, so a longer list than the table allows would lower it: capped, and no repeat
      if (adoptable) {
        const cap = adoptable[s.stage] ?? 0;
        if (libs.length > cap) bad(`stage ${s.stage}: adopted lists ${libs.length} librar${libs.length === 1 ? "y" : "ies"}, the stage table lets this stage adopt ${cap}`);
        if (new Set(libs.map((l) => lc(String(l?.address ?? "")))).size !== libs.length || new Set(libs.map((l) => l?.name)).size !== libs.length) bad(`stage ${s.stage}: adopted lists a library twice`);
      }
      for (const l of libs) {
        if (!ADDR.test(l?.address ?? "")) bad(`stage ${s.stage}: adopted library ${l?.name} has no address`);
        if (!TX.test(l?.code_hash ?? "")) bad(`stage ${s.stage}: adopted library ${l?.name} has no code_hash (the keccak256 of its runtime code)`);
      }
    } else {
      if (s.frozen_count !== s.receipt_count) bad(`stage ${s.stage}: frozen_count ${s.frozen_count} differs from receipt_count ${s.receipt_count}`);
      if (frozenCounts && s.stage in frozenCounts && frozenCounts[s.stage] !== s.receipt_count) bad(`stage ${s.stage}: receipt_count ${s.receipt_count} differs from the frozen file (${frozenCounts[s.stage]})`);
    }
    if (hashes.length !== s.receipt_count) bad(`stage ${s.stage}: ${hashes.length} tx hashes for ${s.receipt_count} receipts`);
    hashes.forEach((h, i) => { if (typeof h !== "string" || !TX.test(h)) bad(`stage ${s.stage}: tx hash ${i} is missing or malformed`); });
    if (st.length !== hashes.length) bad(`stage ${s.stage}: ${st.length} receipt statuses for ${hashes.length} tx hashes`);
    st.forEach((x, i) => { if (x !== 1) bad(`stage ${s.stage}: receipt ${i} status is ${x}, not 1`); });
  }

  if (!ADDR.test(ev?.safe?.address ?? "") || !TX.test(ev?.safe?.creation_tx ?? "")) bad("safe address or creation_tx is missing");
  if (!ADDR.test(ev?.timelock?.address ?? "")) bad("timelock address is missing");
  if (!(ev?.timelock?.min_delay >= floor)) bad(`timelock min_delay ${ev?.timelock?.min_delay} is under ${floor} s${kind === "rehearsal" ? " (the rehearsal floor)" : ""}`);
  else if (kind === "rehearsal" && rehearsalDelayProblem(ev.timelock.min_delay)) bad(`timelock min_delay ${rehearsalDelayProblem(ev.timelock.min_delay)}: ${kindLabel(kind, ev.timelock.min_delay)} cannot be told from production`);
  if (!(ev?.safe?.owners?.length >= 3) || !(ev?.safe?.threshold >= 2)) bad("safe owners or threshold are under the floor (3 owners, threshold 2)");
  for (const v of VAULT_RULES) if (!ADDR.test(ev?.vaults?.[`rm${v.key}`]?.address ?? "")) bad(`vault rm${v.key} address is missing`);

  const govern: any[] = Array.isArray(ev?.govern) ? ev.govern : [];
  for (const step of GOVERN_STEPS) if (!govern.some((g) => g?.step === step)) bad(`govern step '${step}' of Stage 13 has no evidence entry`);
  for (const g of govern) if (!UNPAUSE_STEPS.includes(g?.step)) bad(`govern step '${g?.step}' is not a vault unpause: on 8453 the only operation after the handover is ${UNPAUSE_STEPS.join(", ")} (update-delay, batch and cancel are Twin-only)`);
  for (const g of govern) if (g?.round !== undefined && !(Number.isInteger(g.round) && g.round >= 1)) bad(`govern ${g?.step}: round ${g.round} is not a positive integer`);
  // one entry per (step, round); the rounds of a step are 1..n in order, and a later round is scheduled only after the earlier one executed
  for (const step of UNPAUSE_STEPS) {
    const entries = govern.filter((g) => g?.step === step && Number.isInteger(roundOf(g)) && roundOf(g) >= 1).sort((x, y) => roundOf(x) - roundOf(y));
    for (const [i, g] of entries.entries()) {
      if (i > 0 && roundOf(entries[i - 1]) === roundOf(g)) { bad(`govern step '${step}' has more than one evidence entry${roundOf(g) > 1 ? ` for round ${roundOf(g)}` : ""}`); continue; }
      if (roundOf(g) !== i + 1) bad(`govern step '${step}': rounds must be 1 to ${entries.length} in order, found round ${roundOf(g)} at position ${i + 1}`);
      const prev = entries[i - 1];
      if (prev && roundOf(prev) !== roundOf(g) && !(Number(g.schedule_block_timestamp) > Number(prev.execute_block_timestamp))) bad(`govern ${stepLabel(g)}: scheduled at ${g.schedule_block_timestamp}, not after round ${roundOf(prev)} executed at ${prev.execute_block_timestamp}`);
    }
  }
  const releases: any[] = ev?.receipt_releases === undefined ? [] : Array.isArray(ev.receipt_releases) ? ev.receipt_releases : (bad("receipt_releases is not a list"), []);
  if (releases.length > 0 && !ADDR.test(ev?.consensus_receipt?.address ?? "")) bad("consensus_receipt.address is missing: a receipt release has no target to check");
  // Issue 1888: once RouterGovernance holds RECEIPT_RELEASER_ROLE (the timelock manifest's roles.governance_has_receipt_release_role, copied to consensus_receipt.governance_has_release_role), the timelock cannot
  // release a receipt directly: a standalone release is impossible, and a release entry in such an evidence is a forgery. Historical evidence carries no such flag.
  if (releases.length > 0 && ev?.consensus_receipt?.governance_has_release_role === true) bad(`receipt_releases has ${releases.length} entr${releases.length === 1 ? "y" : "ies"} but RouterGovernance holds RECEIPT_RELEASER_ROLE on the receipt (consensus_receipt.governance_has_release_role): after the narrow-role handover a receipt is released only by apply-receipt`);
  const seenIds = new Set<string>();
  for (const r of releases) {
    const w = releaseLabel(r);
    if (!TX.test(r?.receipt_id ?? "")) bad(`${w}: receipt_id is not a bytes32`);
    else if (seenIds.has(lc(r.receipt_id))) bad(`${w}: receipt_id has more than one evidence entry`);
    else seenIds.add(lc(r.receipt_id));
    if (lc(r?.target ?? "") !== lc(ev?.consensus_receipt?.address ?? "")) bad(`${w}: target ${r?.target} is not the receipt contract ${ev?.consensus_receipt?.address}`);
    if (r?.step !== undefined && r.step !== "release-receipt") bad(`${w}: step '${r.step}' is not release-receipt`);
  }
  const applications = applicationShapeProblems(ev, bad);
  const clears = clearShapeProblems(ev, bad);
  const redeploys = redeployShapeProblems(ev, kind, bad);
  const retirements = retireShapeProblems(ev, bad);
  // one operation per unpause, release or application: no schedule or execute transaction, and no timelock operation id, is shared by two operations
  forbidCancelFields([...govern, ...releases, ...applications, ...clears, ...redeploys, ...retirements, ...(Array.isArray(ev?.committee_registrations) ? ev.committee_registrations : []), ...(Array.isArray(ev?.submitter_registrations) ? ev.submitter_registrations : [])], (e) => String(e?.step ?? "entry"), bad);
  const rrows = rehearsalRowProblems(ev, kind, bad);
  const regs = receiptPathProblems(ev, kind, applications, bad);
  operationProblems([...govern.map((g) => ({ ...g, step: stepLabel(g) })), ...releases.map((r) => ({ ...r, step: releaseLabel(r) })), ...applications.map((r) => ({ ...r, step: applyLabel(r) })), ...clears.map((r) => ({ ...r, step: clearLabel(r) })), ...retirements.map((r) => ({ ...r, step: retireLabel(r) })), ...redeploys.map((r) => ({ ...r, step: redeployLabel(r) })), ...rowOperations(rrows), ...registrationOperations(regs)], bad, floor);
  if (!ADDR.test(ev?.deployer ?? "")) bad("deployer address is missing");
  if (!ADDR.test(ev?.registry?.address ?? "")) bad("registry address is missing");
  if (!Number.isInteger(ev?.deployer_nonce_final)) bad("deployer_nonce_final is missing");
  const start = startNonceOf(ev, kind, bad);
  if (frozenCounts && ev?.deployer_nonce_final !== finalDeployerNonce(effectiveForEvidence(ev, frozenCounts), start) + redeployTxs(ev)) bad(`deployer_nonce_final ${ev?.deployer_nonce_final} differs from ${start ? `the start nonce ${start} plus ` : ""}the summed frozen counts plus the prove-control transaction${redeployTxs(ev) ? ` plus the ${redeployTxs(ev)} redeploy transaction(s)` : ""} ${finalDeployerNonce(effectiveForEvidence(ev, frozenCounts), start) + redeployTxs(ev)}${Object.keys(adoptedTxsOfEvidence(ev)).length ? " (adopted stages counted at the transactions the deployer sent)" : ""}`);
  if (ev?.verifier?.exit_code !== 0) bad("the verifier did not exit 0");
  if (ev?.verifier?.registry_list_vaults_equals_manifests !== true) bad("registry listVaults was not shown equal to the manifests");
  // explorer source verification is publishing, not a gate (owner decision 2026-10-19): the verifier's code labels prove the build from the chain
  p.push(...upgradeabilityEvidenceProblems(ev, opts?.proxies ?? repoProxyNames(ev?.system === "vaults" ? "vaults" : "legacy"), kind));
  p.push(...governedUpgradeProblems(ev, floor, opts?.proxies ?? repoProxyNames(ev?.system === "vaults" ? "vaults" : "legacy")));
  return p;
}

/** The slice of a viem PublicClient this check uses. A stub implements it in unit tests. */
export interface ChainReader {
  getChainId(): Promise<number>;
  getTransactionCount(a: { address: `0x${string}` }): Promise<number>;
  /** `from` and `contractAddress` (a CREATE's created contract, else null) are read for the redeploy deploy transactions only (QA plan v1 C2). */
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[]; from?: string; contractAddress?: string | null }>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  /** Runtime code at an address (viem getCode). Needed when the evidence records an adopted stage, and for the upgradeability record (issue 1809). */
  getCode?(a: { address: `0x${string}` }): Promise<Hex | undefined>;
  /** One storage word (viem getStorageAt). Needed for the upgradeability record's ERC-1967 implementation slots (issue 1809). */
  getStorageAt?(a: { address: `0x${string}`; slot: Hex }): Promise<Hex | undefined>;
  readContract(a: { address: `0x${string}`; abi: any; functionName: string }): Promise<unknown>;
}

const TIMELOCK_ABI = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
const REGISTRY_ABI = parseAbi(["function listVaults() view returns (address[])"]);
const PAUSED_ABI = parseAbi(["function depositsPaused() view returns (bool)"]);
const lc = (x: string) => x.toLowerCase();

function timelockEvents(rc: Awaited<ReturnType<ChainReader["getTransactionReceipt"]>>, timelock: string, name: "CallScheduled" | "CallExecuted") {
  const out: { id: string; index: bigint; delay?: bigint; target: string; data: string }[] = [];
  for (const l of rc.logs) {
    if (lc(l.address) !== lc(timelock)) continue;
    try {
      const d: any = decodeEventLog({ abi: TIMELOCK_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === name) out.push({ id: d.args.id as string, index: d.args.index as bigint, delay: d.args.delay as bigint | undefined, target: d.args.target as string, data: d.args.data as string });
    } catch { /* another event of the timelock */ }
  }
  return out;
}

/** Reads chain 8453 and checks the recorded evidence against it. Returns problems; an empty list is a pass. */
export async function checkEvidenceOnChain(ev: any, chain: ChainReader, frozenCounts: Record<string, number>, opts?: EvidenceOpts): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const kind = kindOf(opts);
  const FLOOR = delayFloor(MAINNET_CHAIN_ID, kind);
  kindProblems(ev, kind, bad);
  /** A delay on chain must agree with the kind: at least the floor, and for a rehearsal also below the production floor, so the chain tells the two apart. */
  const delayAgrees = (what: string, d: bigint | undefined) => {
    if (!(d !== undefined && d >= BigInt(FLOOR))) bad(`${what}: CallScheduled delay ${d} is under ${FLOOR} s`);
    else if (kind === "rehearsal" && rehearsalDelayProblem(d)) bad(`${what}: CallScheduled delay ${rehearsalDelayProblem(d)}: it does not read as a rehearsal on chain`);
  };
  const id = await chain.getChainId();
  if (id !== MAINNET_CHAIN_ID) { bad(`the RPC reports chain ${id}, evidence is read on ${MAINNET_CHAIN_ID}`); return p; }
  if (ev?.system === "gateway") {
    // Issue 1892: the gateway system's evidence is read on chain on its own: its stages' receipts, the deployer nonce from its recorded start, and the gateway's upgrade authority.
    const stages: any[] = Array.isArray(ev.stages) ? ev.stages : [];
    const wantNonce = (Number.isInteger(ev.deployer_start_nonce) ? ev.deployer_start_nonce : Number.NaN) + stages.reduce((a, s) => a + (frozenCounts[s?.stage] ?? 0), 0);
    const got = await chain.getTransactionCount({ address: ev.deployer });
    if (got !== wantNonce) bad(`deployer nonce on chain is ${got}, the start nonce plus the gateway frozen counts say ${wantNonce}`);
    for (const s of stages) for (const [i, h] of (s.tx_hashes ?? []).entries()) {
      try { const rc = await chain.getTransactionReceipt({ hash: h as Hex }); if (rc.status !== "success") bad(`stage ${s.stage} tx ${i}: receipt on chain is ${rc.status}`); } catch (e) { bad(`stage ${s.stage} tx ${i}: receipt not readable on chain (${(e as Error).message})`); }
    }
    try {
      const tl = await chain.readContract({ address: ev.gateway?.address, abi: parseAbi(["function upgradeTimelock() view returns (address)"]), functionName: "upgradeTimelock" });
      if (lc(String(tl)) !== lc(String(ev.gateway?.upgrade_timelock))) bad(`gateway upgradeTimelock() on chain is ${String(tl)}, the evidence records ${String(ev.gateway?.upgrade_timelock)}`);
    } catch (e) { bad(`gateway upgradeTimelock() is not readable on chain (${(e as Error).message})`); }
    return p;
  }
  const want = finalDeployerNonce(effectiveForEvidence(ev, frozenCounts), startNonceOf(ev, kind, bad)) + redeployTxs(ev);
  const nonce = await chain.getTransactionCount({ address: ev.deployer });
  if (nonce !== want) bad(`deployer nonce on chain is ${nonce}, the summed frozen counts plus the prove-control transaction${redeployTxs(ev) ? ` plus the ${redeployTxs(ev)} redeploy transaction(s)` : ""} say ${want}`);

  const status = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const s of ev.stages ?? []) for (const [i, h] of (s.tx_hashes ?? []).entries()) await status(`stage ${s.stage} tx ${i}`, h);
  // An adopted stage is believed only when the chain holds the recorded code: keccak256 of the runtime code at each adopted address equals the recorded code_hash.
  for (const s of ev.stages ?? []) for (const l of adoptedLibraries(s)) {
    if (!ADDR.test(l?.address ?? "") || !TX.test(l?.code_hash ?? "")) continue; // the offline check already named it
    if (!chain.getCode) { bad(`stage ${s.stage}: adopted library ${l.name}: this chain reader cannot read code, so the adoption is not proven`); continue; }
    try {
      const code = await chain.getCode({ address: l.address as `0x${string}` });
      if (!code || code === "0x") bad(`stage ${s.stage}: adopted library ${l.name} has no code at ${l.address} on chain`);
      else if (lc(keccak256(code)) !== lc(l.code_hash!)) bad(`stage ${s.stage}: adopted library ${l.name}: the code hash on chain at ${l.address} is ${keccak256(code)}, the evidence says ${l.code_hash}`);
    } catch (e) { bad(`stage ${s.stage}: adopted library ${l.name}: code not readable on chain (${(e as Error).message})`); }
  }
  if (ev.safe?.creation_tx) await status("safe creation", ev.safe.creation_tx);

  try {
    const listed = ((await chain.readContract({ address: ev.registry.address, abi: REGISTRY_ABI, functionName: "listVaults" })) as string[]).map(lc).sort();
    // a vault a redeploy retired is still listed by the registry (issue 1796)
    const recorded = [...Object.values(ev.vaults ?? {}).map((v: any) => lc(v?.address ?? "")), ...retiredVaults(ev)].sort();
    if (JSON.stringify(listed) !== JSON.stringify(recorded)) bad(`registry.listVaults() [${listed.join(",")}] differs from the manifest vaults [${recorded.join(",")}]`);
  } catch (e) { bad(`registry.listVaults() not readable (${(e as Error).message})`); }

  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const idsByStep = new Map<string, string>();
  const byStep = (ev.govern ?? []).slice().sort((x: any, y: any) => UNPAUSE_STEPS.indexOf(x?.step) - UNPAUSE_STEPS.indexOf(y?.step) || roundOf(x) - roundOf(y));
  for (const g0 of byStep) {
    if (!UNPAUSE_STEPS.includes(g0?.step)) { bad(`govern ${g0?.step}: not a vault unpause, no other operation may be scheduled on 8453`); continue; }
    const g = { ...g0, step: stepLabel(g0) };
    const vaultAddr = ev.vaults?.[VAULT_OF_STEP[g0.step]!]?.address as string | undefined;
    const sc = await status(`govern ${g.step} schedule`, g.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled");
    if (scheduled.length === 0) { bad(`govern ${g.step}: the schedule tx has no CallScheduled event from the timelock`); continue; }
    for (const e of scheduled) delayAgrees(`govern ${g.step}`, e.delay);
    // an unpause round is exactly one call: unpauseDeposits() on that step's own vault. Any other call on a vault (rmUSDC included) is refused.
    if (scheduled.length !== 1) bad(`govern ${g.step}: the schedule tx has ${scheduled.length} CallScheduled events, an unpause is exactly one call`);
    for (const e of scheduled) {
      // an unpause scheduled before a redeploy targeted the vault the redeploy later replaced (issue 1796): that vault is the entry's old_vault
      const earlier = (Array.isArray(ev.vault_redeploys) ? ev.vault_redeploys : []).filter((r: any) => r?.vault === VAULT_OF_STEP[g0.step]).map((r: any) => lc(String(r?.old_vault ?? "")));
      if (!vaultAddr || (lc(e.target) !== lc(vaultAddr) && !earlier.includes(lc(e.target)))) bad(`govern ${g.step}: CallScheduled target ${e.target} is not ${VAULT_OF_STEP[g0.step]} ${vaultAddr}`);
      else if (lc(e.data) !== lc(unpauseCalldata())) bad(`govern ${g.step}: CallScheduled calldata is not ${VAULT_OF_STEP[g0.step]}.unpauseDeposits(): the only call a govern round may make on a vault`);
    }
    // one operation per unpause: a timelock operation id belongs to one step only
    for (const e of scheduled) {
      const other = idsByStep.get(e.id);
      if (other !== undefined && other !== g.step) bad(`govern ${g.step}: the timelock operation ${e.id} is also the operation of step '${other}' (one operation per unpause, none shared)`);
      idsByStep.set(e.id, g.step);
    }
    const schedTs = await ts(sc);
    const ex = await status(`govern ${g.step} execute`, g.execute_tx);
    if (!ex) continue;
    if (!timelockEvents(ex, ev.timelock.address, "CallExecuted").some((e) => scheduled.some((s) => s.id === e.id))) bad(`govern ${g.step}: the execute tx has no CallExecuted event for the scheduled id`);
    const execTs = await ts(ex);
    const gap = execTs - schedTs;
    if (!(gap >= FLOOR)) bad(`govern ${g.step}: on-chain schedule-to-execute gap ${gap} s is under ${FLOOR} s`);
  }
  // Receipt releases (issue 1611): each is exactly one timelock call, releaseReceipt(receipt_id) on the receipt contract, one delay apart.
  for (const r of ev.receipt_releases ?? []) {
    const w = releaseLabel(r);
    if (!TX.test(r?.receipt_id ?? "") || !ADDR.test(ev.consensus_receipt?.address ?? "")) continue; // the offline check already named it
    const sc = await status(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled");
    if (scheduled.length === 0) { bad(`${w}: the schedule tx has no CallScheduled event from the timelock`); continue; }
    if (scheduled.length !== 1) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, a release is exactly one call`);
    const want = releaseCalldata(r.receipt_id);
    for (const e of scheduled) {
      if (lc(e.target) !== lc(ev.consensus_receipt.address)) bad(`${w}: CallScheduled target ${e.target} is not the receipt contract ${ev.consensus_receipt.address}`);
      else if (lc(e.data) !== lc(want)) bad(`${w}: CallScheduled calldata is not releaseReceipt(${r.receipt_id})`);
      delayAgrees(w, e.delay);
      const other = idsByStep.get(e.id);
      if (other !== undefined && other !== w) bad(`${w}: the timelock operation ${e.id} is also the operation of step '${other}' (one operation per step, none shared)`);
      idsByStep.set(e.id, w);
    }
    const schedTs = await ts(sc);
    const ex = await status(`${w} execute`, r.execute_tx);
    if (!ex) continue;
    if (!timelockEvents(ex, ev.timelock.address, "CallExecuted").some((e) => scheduled.some((s) => s.id === e.id) && lc(e.target) === lc(ev.consensus_receipt.address) && lc(e.data) === lc(want))) bad(`${w}: the execute tx has no CallExecuted event for the scheduled release`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= FLOOR)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${FLOOR} s`);
  }
  p.push(...(await upgradeabilityOnChainProblems(ev, chain)));
  p.push(...(await checkReceiptApplicationsOnChain(ev, chain, FLOOR)));
  p.push(...(await checkGovernedUpgradesOnChain(ev, chain)));
  p.push(...(await checkVotedWeightsClearsOnChain(ev, chain, FLOOR)));
  p.push(...(await checkVaultRedeploysOnChain(ev, chain, FLOOR)));
  p.push(...(await checkVaultRetirementsOnChain(ev, chain, FLOOR)));
  if (kind === "rehearsal") { p.push(...(await checkRehearsalRowsOnChain(ev, chain, FLOOR))); p.push(...(await checkReceiptPathOnChain(ev, chain, FLOOR))); }
  // The unpause govern rows and the depositsPaused() reads must tell one story: a vault is unpaused on chain exactly when its LATEST unpause round executed
  // (all three vaults deploy paused, issue 1710). Issue 1833: the unpaused-without-receipt alarm holds for every vault whatever the table's deployPaused says,
  // so a table edit to deployPaused=false can never silence it.
  for (const { key: b, unpauseRow } of opts?.vaultRules ?? VAULT_RULES) {
    const rows = (ev.govern ?? []).filter((g: any) => g?.step === unpauseRow).sort((x: any, y: any) => roundOf(x) - roundOf(y));
    const row = rows[rows.length - 1];
    const vault = ev.vaults?.[`rm${b}`]?.address;
    if (!vault) continue;
    let paused: unknown;
    try { paused = await chain.readContract({ address: vault, abi: PAUSED_ABI, functionName: "depositsPaused" }); }
    catch (e) { bad(`rm${b}.depositsPaused() not readable (${(e as Error).message})`); continue; }
    const executed = !!row && row.execute_status === 1 && TX.test(row.execute_tx ?? "");
    if (executed && paused !== false) bad(`govern unpause-${b} executed with receipt status 1, but rm${b}.depositsPaused() reads ${String(paused)} on chain, want false`);
    if (!executed && paused === false) bad(`rm${b}.depositsPaused() reads false on chain, but govern unpause-${b} has no executed receipt`);
  }
  return p;
}

/**
 * Chain check of `receipt_applications` (issue 1696, issue 1698). Each entry is ONE timelock call: the schedule tx has exactly one CallScheduled event (the recorded
 * operation_id), applyReceipt(receipt_id, payload_digest, vaults, bps) on the weight setter, with a delay of at least MAINNET_DELAY_FLOOR. The execute tx has the
 * matching CallExecuted event. The block gap is at least MAINNET_DELAY_FLOOR.
 * It does not read the chain id: a Twin run uses it too (run it with `--receipt-applications`).
 */
export async function checkReceiptApplicationsOnChain(ev: any, chain: ChainReader, floor: number = MAINNET_DELAY_FLOOR): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const status = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const r of Array.isArray(ev?.receipt_applications) ? ev.receipt_applications : []) {
    const w = applyLabel(r);
    if (!TX.test(r?.receipt_id ?? "") || !TX.test(r?.payload_digest ?? "") || !ADDR.test(ev.governance?.address ?? "") || !Array.isArray(r.vaults) || !Array.isArray(r.bps) || r.vaults.length !== r.bps.length) continue; // the offline check already named it
    const sc = await status(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    if (scheduled.length === 0) { bad(`${w}: the schedule tx has no CallScheduled event from the timelock`); continue; }
    const want = { target: ev.governance.address as string, data: applyCalldata(r.receipt_id, r.payload_digest, r.vaults, r.bps) };
    if (scheduled.length !== 1) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, an application is exactly one applyReceipt call`);
    const e = scheduled[0]!;
    if (lc(e.target) !== lc(want.target)) bad(`${w}: CallScheduled target ${e.target} is not the weight setter ${want.target}`);
    else if (lc(e.data) !== lc(want.data)) bad(`${w}: CallScheduled calldata is not applyReceipt(receipt_id, payload_digest, vaults, bps) of the recorded entry`);
    if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
    if (typeof r.operation_id === "string" && lc(r.operation_id) !== lc(scheduled[0]!.id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${scheduled[0]!.id}`);
    const schedTs = await ts(sc);
    const ex = await status(`${w} execute`, r.execute_tx);
    if (!ex) continue;
    if (!timelockEvents(ex, ev.timelock.address, "CallExecuted").some((x) => lc(x.id) === lc(e.id) && lc(x.target) === lc(want.target) && lc(x.data) === lc(want.data))) bad(`${w}: the execute tx has no CallExecuted event for the scheduled applyReceipt`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

/**
 * Issue 1910: chain check of `proxy_upgrades`. Each entry is ONE timelock call: the schedule tx has exactly one CallScheduled event whose id is the recorded operation, whose target
 * is the recorded proxy and whose data is `upgradeToAndCall(to_implementation, data)`, where `data` is the typed migration's pinned encoding when the entry names a migration and
 * EMPTY when it does not. An entry that claims no migration cannot hide one, and an entry that claims one cannot have scheduled other data. An entry without a schedule tx (an
 * execution adopted from the chain, with its note) is skipped: the offline check already required the note.
 */
export async function checkGovernedUpgradesOnChain(ev: any, chain: ChainReader): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  for (const e of Array.isArray(ev?.proxy_upgrades) ? ev.proxy_upgrades : []) {
    const w = `${UPGRADE_ROW} ${e?.proxy_name} ${e?.operation_id}`;
    if (!TX.test(e?.schedule_tx ?? "") || !ADDR.test(e?.proxy ?? "") || !ADDR.test(e?.to_implementation ?? "") || !ADDR.test(ev?.timelock?.address ?? "")) continue; // the offline check already named it
    let data = "0x";
    if (e.migration !== undefined) {
      const name = String(e.migration?.name);
      if (!Object.prototype.hasOwnProperty.call(UPGRADE_MIGRATIONS, name) || !ADDR.test(e.migration?.releaser ?? "")) continue; // the offline check already named it
      data = pinnedMigrationData(name, e.migration.releaser);
    }
    let sc;
    try {
      sc = await chain.getTransactionReceipt({ hash: e.schedule_tx as Hex });
      if (sc.status !== "success") bad(`${w}: schedule receipt on chain is ${sc.status}`);
    } catch (x) { bad(`${w}: schedule receipt not readable on chain (${(x as Error).message})`); continue; }
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled");
    if (scheduled.length !== 1) { bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, an upgrade is exactly one upgradeToAndCall`); continue; }
    const s = scheduled[0]!;
    const want = upgradeCalldata(e.to_implementation, data);
    if (lc(s.target) !== lc(e.proxy)) bad(`${w}: CallScheduled target ${s.target} is not the proxy ${e.proxy}`);
    if (lc(s.data) !== lc(want)) {
      const got = decodeUpgradeCall(s.data as Hex);
      bad(`${w}: CallScheduled calldata is not upgradeToAndCall(${e.to_implementation}, ${e.migration ? `${e.migration.function}(${e.migration.releaser})` : '""'}): ${got ? `it schedules upgradeToAndCall(${got.implementation}, ${got.data === "0x" ? '""' : got.data})` : "it is not an upgradeToAndCall"}`);
    }
    if (typeof e.operation_id === "string" && lc(e.operation_id) !== lc(s.id)) bad(`${w}: operation_id ${e.operation_id} is not the scheduled operation ${s.id}`);
  }
  return p;
}

/**
 * Chain check of `voted_weights_clears` (issue 1743). Each entry is ONE timelock call: the schedule tx has exactly one CallScheduled event (the recorded operation_id), target the
 * governance contract, calldata clearVotedWeights(), a delay of at least the floor. The execute tx has the matching CallExecuted event. The block gap is at least the floor.
 */
export async function checkVotedWeightsClearsOnChain(ev: any, chain: ChainReader, floor: number = MAINNET_DELAY_FLOOR): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const status = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  const want = clearCalldata();
  for (const r of Array.isArray(ev?.voted_weights_clears) ? ev.voted_weights_clears : []) {
    const w = clearLabel(r);
    if (!ADDR.test(ev.governance?.address ?? "") || !TX.test(r?.schedule_tx ?? "") || !TX.test(r?.execute_tx ?? "")) continue; // the offline check already named it
    const sc = await status(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled");
    if (scheduled.length !== 1) { bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, a clear is exactly one call`); continue; }
    const e = scheduled[0]!;
    if (lc(e.target) !== lc(ev.governance.address)) bad(`${w}: CallScheduled target ${e.target} is not the governance contract ${ev.governance.address}`);
    else if (lc(e.data) !== lc(want)) bad(`${w}: CallScheduled calldata is not clearVotedWeights()`);
    if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
    if (typeof r.operation_id === "string" && lc(r.operation_id) !== lc(e.id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${e.id}`);
    const schedTs = await ts(sc);
    const ex = await status(`${w} execute`, r.execute_tx);
    if (!ex) continue;
    if (!timelockEvents(ex, ev.timelock.address, "CallExecuted").some((x) => lc(x.id) === lc(e.id) && lc(x.target) === lc(ev.governance.address) && lc(x.data) === lc(want))) bad(`${w}: the execute tx has no CallExecuted event for the scheduled clear`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

/**
 * Chain check of `vault_retirements` (issue 1912). Each entry is ONE timelock batch of two calls with one operation id: the schedule tx has exactly two CallScheduled events, index 0 and 1,
 * whose targets and calldata are rebuilt from the recorded vault and vector (migrateEligibility(vault, false, three legs), retire(vault)), each with a delay of at least the floor. The execute tx has
 * the two matching CallExecuted events. The block gap is at least the floor. It does not read the chain id: a Twin run uses it too.
 */
export async function checkVaultRetirementsOnChain(ev: any, chain: ChainReader, floor: number = MAINNET_DELAY_FLOOR): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const status = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const r of Array.isArray(ev?.vault_retirements) ? ev.vault_retirements : []) {
    const w = retireLabel(r);
    if (!ADDR.test(r?.vault ?? "") || !ADDR.test(r?.registry ?? "") || !ADDR.test(ev?.timelock?.address ?? "") || !Array.isArray(r?.vaults) || !Array.isArray(r?.bps) || !TX.test(r?.schedule_tx ?? "") || !TX.test(r?.execute_tx ?? "")) continue; // the offline check already named it
    let want: ReturnType<typeof buildRetireCalls>;
    try { want = buildRetireCalls({ registry: r.registry, vault: r.vault, finalVaults: r.vaults, finalBps: r.bps }); } catch { continue; } // the offline check already named it
    const sc = await status(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    if (scheduled.length === 0) { bad(`${w}: the schedule tx has no CallScheduled event from the timelock`); continue; }
    if (scheduled.length !== want.length) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, a retire round is exactly ${want.length} calls in one batch`);
    scheduled.forEach((e, i) => {
      const c = want[i];
      if (c === undefined) { bad(`${w}: CallScheduled call ${i} is not part of a retire round`); return; }
      if (lc(e.target) !== lc(c.target)) bad(`${w}: CallScheduled call ${i} target ${e.target} is not ${c.target} (${c.label})`);
      else if (lc(e.data) !== lc(c.data)) bad(`${w}: CallScheduled call ${i} calldata is not ${c.label}`);
      if (e.index !== BigInt(i)) bad(`${w}: CallScheduled call ${i} has batch index ${e.index}`);
      if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
      if (lc(e.id) !== lc(scheduled[0]!.id)) bad(`${w}: the batch calls are not one operation (${e.id} and ${scheduled[0]!.id})`);
    });
    if (typeof r.operation_id === "string" && lc(r.operation_id) !== lc(scheduled[0]!.id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${scheduled[0]!.id}`);
    const schedTs = await ts(sc);
    const ex = await status(`${w} execute`, r.execute_tx);
    if (!ex) continue;
    const executed = timelockEvents(ex, ev.timelock.address, "CallExecuted").filter((e) => lc(e.id) === lc(scheduled[0]!.id)).sort((x, y) => Number(x.index - y.index));
    if (executed.length !== want.length || !executed.every((e, i) => lc(e.target) === lc(want[i]!.target) && lc(e.data) === lc(want[i]!.data))) bad(`${w}: the execute tx has no CallExecuted events for the two scheduled calls`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

/**
 * Chain check of `vault_redeploys` (issue 1796). Every deploy transaction succeeded, and one of them is the run deployer's CREATE of exactly `new_vault` (QA plan v1 C2,
 * issue 1701: the address is bound to the chain, never taken from the editable record alone). Each entry is ONE timelock batch of five calls with one operation id: the schedule tx has exactly five
 * CallScheduled events, index 0 to 4, whose targets and calldata are rebuilt from the recorded vaults (registerVault(new), migrateEligibility(new, true, five legs), migrateEligibility(old, false,
 * four legs), retire(old), the new vault's unpauseDeposits()), each with a delay of at least the floor. The execute tx has the five matching CallExecuted events. The block gap is at least the floor.
 * It does not read the chain id: a Twin run uses it too.
 */
export async function checkVaultRedeploysOnChain(ev: any, chain: ChainReader, floor: number = MAINNET_DELAY_FLOOR): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const status = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const r of Array.isArray(ev?.vault_redeploys) ? ev.vault_redeploys : []) {
    const w = redeployLabel(r);
    if (!ADDR.test(r?.old_vault ?? "") || !ADDR.test(r?.new_vault ?? "") || !ADDR.test(r?.registry ?? "") || !ADDR.test(r?.asset ?? "") || !Array.isArray(r?.vaults) || !Array.isArray(r?.bps) || typeof r?.registry_name !== "string" || !TX.test(r?.schedule_tx ?? "") || !TX.test(r?.execute_tx ?? "")) continue; // the offline check already named it
    // QA plan v1 C2 (issue 1701): new_vault is bound to the chain. One recorded deploy transaction must be the deployer's CREATE of exactly that address.
    const deployReceipts: DeployReceipt[] = [];
    for (const [i, h] of (Array.isArray(r.deploy_tx_hashes) ? r.deploy_tx_hashes : []).entries()) {
      const rc = await status(`${w} deploy tx ${i}`, h);
      deployReceipts.push(rc ? { hash: String(h), status: rc.status, from: rc.from, contractAddress: rc.contractAddress } : { hash: String(h), status: "not readable" });
    }
    // a failed or unreadable receipt is already named above; what is left is the binding itself
    for (const m of createdVaultProblems(r.new_vault, String(r.deployer ?? ""), deployReceipts)) if (!m.includes("receipt status")) bad(`${w}: new_vault ${m}`);
    let want: ReturnType<typeof buildRedeployCalls>;
    try { want = buildRedeployCalls({ router: r.router, routerVaultCap: BigInt(r.router_vault_cap), registry: r.registry, oldVault: r.old_vault, newVault: r.new_vault, registryName: r.registry_name, asset: r.asset, finalVaults: r.vaults, finalBps: r.bps }); } catch { continue; } // the offline check already named it
    const sc = await status(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    if (scheduled.length === 0) { bad(`${w}: the schedule tx has no CallScheduled event from the timelock`); continue; }
    if (scheduled.length !== want.length) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, a redeploy round is exactly ${want.length} calls in one batch`);
    scheduled.forEach((e, i) => {
      const c = want[i];
      if (c === undefined) { bad(`${w}: CallScheduled call ${i} is not part of a redeploy round`); return; }
      if (lc(e.target) !== lc(c.target)) bad(`${w}: CallScheduled call ${i} target ${e.target} is not ${c.target} (${c.label})`);
      else if (lc(e.data) !== lc(c.data)) bad(`${w}: CallScheduled call ${i} calldata is not ${c.label}`);
      if (e.index !== BigInt(i)) bad(`${w}: CallScheduled call ${i} has batch index ${e.index}`);
      if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
      if (lc(e.id) !== lc(scheduled[0]!.id)) bad(`${w}: the batch calls are not one operation (${e.id} and ${scheduled[0]!.id})`);
    });
    if (typeof r.operation_id === "string" && lc(r.operation_id) !== lc(scheduled[0]!.id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${scheduled[0]!.id}`);
    const schedTs = await ts(sc);
    const ex = await status(`${w} execute`, r.execute_tx);
    if (!ex) continue;
    const executed = timelockEvents(ex, ev.timelock.address, "CallExecuted").filter((e) => lc(e.id) === lc(scheduled[0]!.id)).sort((x, y) => Number(x.index - y.index));
    if (executed.length !== want.length || !executed.every((e, i) => lc(e.target) === lc(want[i]!.target) && lc(e.data) === lc(want[i]!.data))) bad(`${w}: the execute tx has no CallExecuted events for the five scheduled calls`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

/**
 * Chain check of `submitter_registrations`, the HISTORICAL `committee_registrations` and `recorded_receipts` (issues 1727, 1888). A registration is ONE grantRole call (below). A HISTORICAL registration is ONE batch: the schedule tx has exactly two CallScheduled events with one operation id,
 * setPolicy then committeeRegister on the gateway with the calldata rebuilt from the recorded submitter, label and validUntil; the execute tx has the two CallExecuted events;
 * the block gap is at least the floor. QA plan v1 B6: an entry that records the submitter Safe's private self-authorization (`self_authorization.hand_over_tx`) must have
 * handed the agent to the timelock in a block BEFORE the batch was scheduled, so the address was never public while unowned. A recorded receipt's transaction must have succeeded.
 */
export async function checkReceiptPathOnChain(ev: any, chain: ChainReader, floor: number): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const rcOf = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const r of Array.isArray(ev?.committee_registrations) ? ev.committee_registrations : []) {
    const w = histLabel(r);
    if (!ADDR.test(r?.submitter ?? "") || !ADDR.test(r?.gateway ?? "") || !ADDR.test(r?.timelock ?? "") || typeof r?.agent_label !== "string" || !/^[0-9]+$/.test(String(r?.valid_until ?? "")) || !TX.test(r?.schedule_tx ?? "")) continue; // the offline check already named it
    const sc = await rcOf(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    const want = buildHistoricalRegisterCalls(r.gateway, r.timelock, r.submitter, r.agent_label, BigInt(r.valid_until));
    if (scheduled.length !== want.length) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, a registration is exactly ${want.length} calls (setPolicy, committeeRegister) in one batch`);
    scheduled.forEach((e, i) => {
      const c = want[i];
      if (c === undefined) { bad(`${w}: CallScheduled call ${i} is not part of a registration`); return; }
      if (lc(e.target) !== lc(c.target)) bad(`${w}: CallScheduled call ${i} target ${e.target} is not the gateway ${c.target}`);
      else if (lc(e.data) !== lc(c.data)) bad(`${w}: CallScheduled call ${i} calldata is not ${c.label}`);
      if (e.index !== BigInt(i)) bad(`${w}: CallScheduled call ${i} has batch index ${e.index}`);
      if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
      else if (rehearsalDelayProblem(e.delay)) bad(`${w}: CallScheduled delay ${rehearsalDelayProblem(e.delay)}`);
      if (lc(e.id) !== lc(scheduled[0]!.id)) bad(`${w}: the batch calls are not one operation`);
    });
    if (scheduled[0] && typeof r.operation_id === "string" && lc(r.operation_id) !== lc(scheduled[0].id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${scheduled[0].id}`);
    // QA plan v1 B6: the private hand-over to the timelock came first, the public schedule after it
    const handOver = r?.self_authorization?.hand_over_tx;
    if (handOver !== undefined) {
      if (!TX.test(String(handOver))) bad(`${w}: self_authorization.hand_over_tx is not a transaction hash`);
      else {
        const ho = await rcOf(`${w} hand-over`, handOver);
        if (ho && !(ho.blockNumber < sc.blockNumber)) bad(`${w}: the submitter was handed to the timelock in block ${ho.blockNumber}, not before the batch was scheduled in block ${sc.blockNumber}: the address was public while unowned`);
      }
    }
    const schedTs = await ts(sc);
    const ex = await rcOf(`${w} execute`, r.execute_tx);
    if (!ex || !scheduled[0]) continue;
    const executed = timelockEvents(ex, ev.timelock.address, "CallExecuted").filter((e) => lc(e.id) === lc(scheduled[0]!.id));
    if (executed.length !== want.length) bad(`${w}: the execute tx has ${executed.length} CallExecuted events for the scheduled id, want ${want.length}`);
    if (!((await ts(ex)) - schedTs >= floor)) bad(`${w}: on-chain schedule-to-execute gap is under ${floor} s`);
  }
  // Issue 1888: a registration is ONE call: the schedule tx has exactly one CallScheduled event, receipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter), and the execute tx has its CallExecuted.
  for (const r of Array.isArray(ev?.submitter_registrations) ? ev.submitter_registrations : []) {
    const w = regLabel(r);
    if (!ADDR.test(r?.submitter ?? "") || !ADDR.test(r?.receipt ?? "") || !ADDR.test(r?.timelock ?? "") || !TX.test(r?.schedule_tx ?? "")) continue; // the offline check already named it
    const sc = await rcOf(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    const want = buildRegisterCall(r.receipt, r.submitter);
    if (scheduled.length !== 1) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, a registration is exactly one call (${want.label})`);
    const e = scheduled[0];
    if (e) {
      if (lc(e.target) !== lc(want.target)) bad(`${w}: CallScheduled target ${e.target} is not the receipt contract ${want.target}`);
      else if (lc(e.data) !== lc(want.data)) bad(`${w}: CallScheduled calldata is not ${want.label}`);
      if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
      else if (rehearsalDelayProblem(e.delay)) bad(`${w}: CallScheduled delay ${rehearsalDelayProblem(e.delay)}`);
      if (typeof r.operation_id === "string" && lc(r.operation_id) !== lc(e.id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${e.id}`);
    }
    const schedTs = await ts(sc);
    const ex = await rcOf(`${w} execute`, r.execute_tx);
    if (!ex || !e) continue;
    const executed = timelockEvents(ex, ev.timelock.address, "CallExecuted").filter((x) => lc(x.id) === lc(e.id));
    if (executed.length !== 1) bad(`${w}: the execute tx has ${executed.length} CallExecuted events for the scheduled id, want 1`);
    if (!((await ts(ex)) - schedTs >= floor)) bad(`${w}: on-chain schedule-to-execute gap is under ${floor} s`);
  }
  for (const r of Array.isArray(ev?.recorded_receipts) ? ev.recorded_receipts : []) {
    if (!TX.test(r?.tx_hash ?? "")) continue;
    const rc = await rcOf(`${recLabel(r)} tx`, r.tx_hash);
    // Issue 1750: a Safe submitter. The Safe itself emitted ExecutionSuccess for the recorded Safe transaction hash, and its threshold on chain is the recorded one.
    const sf = r?.submitter_safe;
    // Issue 1888: the receipt contract emitted ReceiptRecorded for this id in that transaction (a record is a receipt-contract event, not only a Safe success). Skipped for a HISTORICAL submitter (pinned fixtures).
    const historicalSubmitter = (Array.isArray(ev?.committee_registrations) ? ev.committee_registrations : []).some((x: any) => lc(x?.submitter ?? "") === lc(r?.submitter ?? ""));
    if (rc && !historicalSubmitter && ADDR.test(ev?.consensus_receipt?.address ?? "") && TX.test(r?.receipt_id ?? "")) {
      const recTopic = keccak256(toBytes("ReceiptRecorded(bytes32,address,uint256,bytes32,string,uint64)"));
      if (!rc.logs.some((l) => lc(l.address) === lc(ev.consensus_receipt.address) && l.topics[0] === recTopic && lc(l.topics[1] ?? "") === lc(r.receipt_id))) bad(`${recLabel(r)}: the receipt contract ${ev.consensus_receipt.address} emitted no ReceiptRecorded for ${r.receipt_id} in ${r.tx_hash}`);
    }
    if (!rc || !sf || !ADDR.test(r?.submitter ?? "") || !TX.test(sf?.safe_tx_hash ?? "")) continue;
    const topic0 = keccak256(toBytes("ExecutionSuccess(bytes32,uint256)"));
    const ok = rc.logs.some((l) => lc(l.address) === lc(r.submitter) && l.topics[0] === topic0 && lc(l.topics[1] ?? "") === lc(sf.safe_tx_hash));
    if (!ok) bad(`${recLabel(r)}: the submitter Safe ${r.submitter} emitted no ExecutionSuccess for Safe transaction ${sf.safe_tx_hash} in ${r.tx_hash}`);
    try {
      const thr = Number(await chain.readContract({ address: r.submitter, abi: parseAbi(["function getThreshold() view returns (uint256)"]), functionName: "getThreshold" }));
      if (thr !== sf.threshold) bad(`${recLabel(r)}: the submitter Safe's threshold on chain is ${thr}, the evidence says ${sf.threshold}`);
    } catch (e) { bad(`${recLabel(r)}: the submitter Safe's threshold cannot be read (${(e as Error).message})`); }
  }
  return p;
}

/**
 * Chain check of `rehearsal_rows` (issue 1727). update-delay: one CallScheduled on the timelock itself, updateDelay(new_delay). batch: two CallScheduled in one operation.
 * Both: the delay is the rehearsal floor or more (and below production), the CallExecuted event matches, the block gap is at least the floor. cancel: the schedule is
 * a single CallScheduled and the cancel transaction carries a Cancelled event for that id.
 */
export async function checkRehearsalRowsOnChain(ev: any, chain: ChainReader, floor: number): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const ts = async (rc: { blockNumber: bigint }) => Number((await chain.getBlock({ blockNumber: rc.blockNumber })).timestamp);
  const rcOf = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const r of Array.isArray(ev?.rehearsal_rows) ? ev.rehearsal_rows : []) {
    const w = rowLabel(r);
    if (!(REHEARSAL_ROWS as readonly string[]).includes(r?.step) || !TX.test(r?.schedule_tx ?? "")) continue; // the offline check already named it
    const sc = await rcOf(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    const wantCalls = r.step === "batch" ? 2 : 1;
    if (scheduled.length !== wantCalls) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, ${r.step} is ${wantCalls} call(s)`);
    for (const e of scheduled) {
      if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
      else if (rehearsalDelayProblem(e.delay)) bad(`${w}: CallScheduled delay ${rehearsalDelayProblem(e.delay)}`);
      if (lc(e.id) !== lc(scheduled[0]!.id)) bad(`${w}: the calls are not one operation`);
    }
    if (r.step !== "batch" && scheduled[0] && lc(scheduled[0].target) !== lc(ev.timelock.address) && r.step === "update-delay") bad(`${w}: CallScheduled target ${scheduled[0].target} is not the timelock itself`);
    if (scheduled[0] && typeof r.operation_id === "string" && lc(r.operation_id) !== lc(scheduled[0].id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${scheduled[0].id}`);
    if (r.step === "cancel") {
      const cx = await rcOf(`${w} cancel`, r.cancel_tx);
      if (!cx || !scheduled[0]) continue;
      const cancelled = cx.logs.some((l) => { if (lc(l.address) !== lc(ev.timelock.address)) return false; try { const d: any = decodeEventLog({ abi: TIMELOCK_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); return d.eventName === "Cancelled" && lc(d.args.id) === lc(scheduled[0]!.id); } catch { return false; } });
      if (!cancelled) bad(`${w}: the cancel tx has no Cancelled event for the scheduled id`);
      continue;
    }
    const schedTs = await ts(sc);
    const ex = await rcOf(`${w} execute`, r.execute_tx);
    if (!ex || !scheduled[0]) continue;
    const executed = timelockEvents(ex, ev.timelock.address, "CallExecuted").filter((e) => lc(e.id) === lc(scheduled[0]!.id));
    if (executed.length !== scheduled.length) bad(`${w}: the execute tx has ${executed.length} CallExecuted events for the scheduled id, want ${scheduled.length}`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

// ---- recorded chain fixture: the chain reads of one run, kept as data so the check can run offline ----

/** What a run's chain reads looked like. Every number is a decimal string or a JSON number; no secret is ever in it. */
export interface ChainFixture {
  chainId: number;
  nonces: Record<string, number>;
  /** A list with a `hash` field, not a map keyed by hash: the evidence secret scan reads a bare 64-hex key as key material. */
  receipts: { hash: string; status: "success" | "reverted"; blockNumber: string; logs: { address: string; topics: Hex[]; data: Hex }[]; from?: string; contractAddress?: string | null }[];
  blocks: Record<string, number>;
  reads: Record<string, unknown>;
  /** Runtime code by lower-case address, recorded for the adopted libraries (issue 1721) and the proxies and implementations (issue 1809). Optional: older fixtures have none. */
  codes?: Record<string, string>;
  /** Storage words by `<lower-case address>:<slot>`, recorded for the ERC-1967 implementation slots (issue 1809). Optional: older fixtures have none. */
  storage?: Record<string, string>;
}

const readKey = (address: string, fn: string) => `${lc(address)}:${fn}`;

/** A ChainReader that answers from a fixture. A read the fixture lacks is an error: an offline check never guesses. */
export function chainReaderFromFixture(fx: ChainFixture): ChainReader {
  const miss = (what: string): never => { throw new Error(`the chain fixture has no ${what}`); };
  return {
    getChainId: async () => fx.chainId,
    getTransactionCount: async ({ address }) => fx.nonces[lc(address)] ?? miss(`nonce of ${address}`),
    getTransactionReceipt: async ({ hash }) => {
      const r = fx.receipts.find((x) => lc(x.hash) === lc(hash)) ?? miss(`receipt ${hash}`);
      return { status: r.status, blockNumber: BigInt(r.blockNumber), logs: r.logs, ...(r.from !== undefined ? { from: r.from } : {}), ...(r.contractAddress !== undefined ? { contractAddress: r.contractAddress } : {}) };
    },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(fx.blocks[blockNumber.toString()] ?? miss(`block ${blockNumber}`)) }),
    getCode: async ({ address }) => (fx.codes?.[lc(address)] ?? miss(`code of ${address}`)) as Hex,
    getStorageAt: async ({ address, slot }) => (fx.storage?.[`${lc(address)}:${lc(slot)}`] ?? miss(`storage ${slot} of ${address}`)) as Hex,
    readContract: async ({ address, functionName }) => {
      const k = readKey(address, functionName);
      return k in fx.reads ? fx.reads[k] : miss(`read ${k}`);
    },
  };
}

/** Wraps a live reader and records every answer into a fixture. Run the real check through it once, then write `fixture` to disk. */
export function recordingChainReader(inner: ChainReader): { reader: ChainReader; fixture: ChainFixture } {
  const fixture: ChainFixture = { chainId: 0, nonces: {}, receipts: [], blocks: {}, reads: {} };
  const reader: ChainReader = {
    getChainId: async () => (fixture.chainId = await inner.getChainId()),
    getTransactionCount: async (a) => (fixture.nonces[lc(a.address)] = await inner.getTransactionCount(a)),
    getTransactionReceipt: async (a) => {
      const r = await inner.getTransactionReceipt(a);
      fixture.receipts = fixture.receipts.filter((x) => lc(x.hash) !== lc(a.hash));
      fixture.receipts.push({ hash: lc(a.hash), status: r.status, blockNumber: r.blockNumber.toString(), logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })), ...(r.from !== undefined ? { from: r.from } : {}), ...(r.contractAddress !== undefined ? { contractAddress: r.contractAddress } : {}) });
      return r;
    },
    getBlock: async (a) => {
      const b = await inner.getBlock(a);
      fixture.blocks[a.blockNumber.toString()] = Number(b.timestamp);
      return b;
    },
    getCode: async (a) => {
      const c = await inner.getCode!(a);
      (fixture.codes ??= {})[lc(a.address)] = c ?? "0x";
      return c;
    },
    getStorageAt: async (a) => {
      const v = await inner.getStorageAt!(a);
      (fixture.storage ??= {})[`${lc(a.address)}:${lc(a.slot)}`] = v ?? "0x";
      return v;
    },
    readContract: async (a) => {
      const v = await inner.readContract(a);
      fixture.reads[readKey(a.address, a.functionName)] = typeof v === "bigint" ? v.toString() : v;
      return v;
    },
  };
  return { reader, fixture };
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["64-hex value (private key shape)", /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}($|[^0-9a-fA-F])/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["keystore json", /"ciphertext"\s*:|"crypto"\s*:\s*\{/],
  ["mnemonic-like phrase", /\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b/],
  // Security round 1 (review-security-032): a secret name may carry a prefix (`CHAIN_SIGNER_PASSWORD=`, `ETH_KEYSTORE_PASSWORD=`, `ALCHEMY_API_KEY=`, `"passphrase":`). A leading
  // \b never matched there, because `_` is a word character. The name now starts after any non-alphanumeric character and may follow `WORD_` or `WORD-` parts. The
  // camelCase and quoted JSON key forms count too (`privateKey: …`, `"private_key": "…"`, `"authToken": "…"`). A value the logger redacted is not a secret. A bare
  // `token` names an ERC-20 too (the asset configs, `--admin-arg token=0x…`): its 20-byte address value is public.
  ["secret assignment", /(?<![A-Za-z0-9])(?:(?:[A-Za-z0-9]+[_-])*(?:PRIVATE[_-]?KEY|MNEMONIC|PASSWORD|PASSWD|PASSPHRASE|SECRET|API[_-]?KEY|(?:AUTH|ACCESS|REFRESH|BEARER|SESSION)[_-]?TOKEN)|BEARER|AUTHORIZATION|CREDENTIALS?)"?\s*[=:]\s*(?!"?\[redacted\])\S{6,}|\bTOKEN"?\s*[=:]\s*(?!"?\[redacted\])(?!"?0x[0-9a-fA-F]{40}(?![0-9a-fA-F]))\S{6,}/i],
];

const B32 = "0x[0-9a-fA-F]{64}(?![0-9a-fA-F])";
/** The log events whose operation id is a public timelock operation id (govern.ts, safe/timelock.ts). */
const OPERATION_ID_EVENTS = new Set(["govern.waiting", "timelock.effect"]);
/** A `"detail": "…"` line of a core config check report (scripts/ci/config-check.ts, written under evidence/core-config-check/ by verify). */
const CONFIG_CHECK_DETAIL = /^\s*"detail"\s*:\s*"/;
/** The labels config-check.ts gives a public on-chain hash: code hashes, pinned and live pool ids, hash(poolKey). */
const CONFIG_CHECK_HASH_LABELS = ["proxyCodeHash", "implementationCodeHash", "configured", "hash-of-poolKey", "hash\\(poolKey\\)", "poolId", "pinned", "live", "config"].join("|");

/**
 * Removes the known public 0x bytes32 shapes from one line, so the 64-hex rule sees only what is left. Never a general 64-hex allowance:
 * 1. the row name `apply-receipt-0x<receipt id>` (also a publish-run.json key), anywhere in a line;
 * 2. on a `govern.waiting` or `timelock.effect` JSON log line only: the `"id"`/`"ids"` operation id values and `operation 0x<id>` in the detail text;
 * 3. the value of a `"pool_id"` key, anywhere in a line: a Uniswap V4 pool id (or the zero id of a V3 pool) is a public on-chain identifier. A compact deployment manifest
 *    (one JSON object on one line) holds it, and such a file is committed verbatim, never re-formatted (deployments/8453/deploy-2/README.md).
 * 4. on a `"detail": "…"` line only (the core config check report verify writes): a value after one of the fixed labels of scripts/ci/config-check.ts that name
 *    a public on-chain hash (`proxyCodeHash=`, `implementationCodeHash=`, `pinned=`, `live=`, `poolId=`, `hash(poolKey)=` and the rest of CONFIG_CHECK_HASH_LABELS).
 * A bare 0x64-hex, an env or keystore shaped value, or the same shapes on any other line stay in the line and are flagged.
 */
export function stripPublicContexts(line: string): string {
  let out = line.replace(new RegExp(`apply-receipt-${B32}`, "g"), "apply-receipt-").replace(new RegExp(`("pool_id"\\s*:\\s*)"${B32}"`, "g"), '$1"pool"');
  if (CONFIG_CHECK_DETAIL.test(out)) out = out.replace(new RegExp(`(?<![A-Za-z0-9_()-])(${CONFIG_CHECK_HASH_LABELS})=${B32}`, "g"), "$1=hash");
  if (out.startsWith("{")) {
    let event: unknown;
    try { event = JSON.parse(out).event; } catch { /* not a JSON log line */ }
    if (typeof event === "string" && OPERATION_ID_EVENTS.has(event)) {
      out = out
        .replace(new RegExp(`("ids?"\\s*:\\s*\\[?\\s*)"${B32}"((?:\\s*,\\s*"${B32}")*)`, "g"), (_m, pre, rest) => `${pre}"op"${String(rest).replace(new RegExp(`"${B32}"`, "g"), '"op"')}`)
        .replace(new RegExp(`\\boperation ${B32}`, "g"), "operation op");
    }
  }
  return out;
}

/** A whole-line JSON string value that is one 0x bytes32 (a tx hash, a code hash, a `tx_hashes` element). A word on the line never exempts a hit. */
const B32_JSON_VALUE = /^\s*(?:"[^"]*"\s*:\s*)?"0x[0-9a-fA-F]{64}",?\s*$/;
/** One `"config/<file>": "sha256:<64 hex>"` entry of a pretty-printed isomorphism report (isomorphism.ts configHashes). */
const CONFIG_HASH_ENTRY = /^\s*"[^"]*"\s*:\s*"sha256:[0-9a-fA-F]{64}",?\s*$/;
const CONFIG_HASHES_OPEN = /^(\s*)"configHashes"\s*:\s*\{\s*$/;

/**
 * Scan one evidence folder for secrets. Transaction hashes are 64-hex by design: a line whose whole value is one 0x bytes32 JSON string is allowed.
 * A bare (un-prefixed) 64-hex is exempt only as a `sha256:` value directly under a `configHashes` key (issue 1689); a line that merely names a
 * hash word (tx, hash, salt, digest, sha) is scanned like any other. `strip` is the public-context allowance (a test swaps it to prove widening it is caught).
 */
export function scanEvidenceFolder(dir: string, strip: (line: string) => string = stripPublicContexts): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      const text = readFileSync(f, "utf8");
      let configIndent: string | undefined; // set while inside a `"configHashes": {` block, to its indent
      text.split("\n").forEach((line, i) => {
        const open = CONFIG_HASHES_OPEN.exec(line);
        if (configIndent !== undefined && line.startsWith(`${configIndent}}`)) configIndent = undefined;
        const configHash = configIndent !== undefined && CONFIG_HASH_ENTRY.test(line);
        if (open) configIndent = open[1];
        for (const [name, re] of SECRET_PATTERNS) {
          if (name.startsWith("64-hex") && (configHash || B32_JSON_VALUE.test(line))) continue;
          if (re.test(name.startsWith("64-hex") ? strip(line) : line)) hits.push(`${f}:${i + 1}: ${name}`);
        }
      });
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

/**
 * Issue 1701: the `--delay-floor` of the run-manifest checks. Any positive integer is accepted off 8453 (a Twin run passes its own timelock min delay). When the
 * --rpc chain id is 8453 a floor below that chain's floor for the kind (172800 s for production) is refused: a short floor would pass a mainnet batch that skipped the delay.
 * Empty string when the floor is acceptable.
 */
export function delayFloorArgProblem(floor: number, rpcChainId: number | undefined, kind: DeploymentKind): string {
  if (!Number.isInteger(floor) || floor < 1) return "--delay-floor must be a positive number of seconds";
  const min = delayFloor(MAINNET_CHAIN_ID, kind);
  if (rpcChainId === MAINNET_CHAIN_ID && floor < min) return `--delay-floor ${floor} is below the chain ${MAINNET_CHAIN_ID} floor ${min} s: the --rpc reads chain ${MAINNET_CHAIN_ID}, where every timelock batch waits at least ${min} s`;
  return "";
}

/** The floor of a run-manifest check: --delay-floor, else the 8453 floor of the kind. Exits 2 on a refused floor. With --rpc it reads the chain id first (issue 1701). */
async function floorArg(values: Record<string, string | boolean | undefined>, kind: DeploymentKind, reader: ChainReader | undefined): Promise<number> {
  if (typeof values["delay-floor"] !== "string") return delayFloor(MAINNET_CHAIN_ID, kind);
  const floor = Number(values["delay-floor"]);
  const why = delayFloorArgProblem(floor, reader ? await reader.getChainId() : undefined, kind);
  if (why) { console.error(`evidence: ${why}`); process.exit(2); }
  return floor;
}

/**
 * `--receipt-applications RUN_MANIFEST` (issue 1696): checks the `receipt_applications` entries a `govern --row apply-receipt` run wrote to its run manifest,
 * with the receipt, governance and timelock addresses of that run. Offline shape and delay checks, then (with --rpc) the timelock events on that chain.
 * The Twin rehearsal uses it: a Twin run proves the row executes on the real contracts, not that mainnet governance works.
 */
async function checkApplicationsMain(values: Record<string, string | boolean | undefined>, kind: DeploymentKind): Promise<void> {
  const need = ["consensus-receipt", "governance", "timelock"].filter((k) => typeof values[k] !== "string");
  if (need.length) { console.error(`evidence: --receipt-applications needs ${need.map((k) => `--${k}`).join(", ")}`); process.exit(2); }
  const m = JSON.parse(readFileSync(values["receipt-applications"] as string, "utf8"));
  const ev = { deployment_kind: kind, consensus_receipt: { address: values["consensus-receipt"] }, governance: { address: values.governance }, timelock: { address: values.timelock }, receipt_applications: m.receipt_applications, voted_weights_clears: m.voted_weights_clears,
    committee_registrations: m.committee_registrations, submitter_registrations: m.submitter_registrations, recorded_receipts: m.recorded_receipts,
    proxy_upgrades: m.proxy_upgrades }; // the re-registration rule reads the receipt migration the manifest records
  const { createPublicClient, http } = await import("viem");
  const reader = typeof values.rpc === "string" ? createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader : undefined;
  const floor = await floorArg(values, kind, reader);
  const problems = [...(Array.isArray(m.receipt_applications) && m.receipt_applications.length > 0 ? [] : ["the run manifest has no receipt_applications entry"]), ...checkReceiptApplications(ev, floor), ...checkVotedWeightsClears(ev, floor)];
  // issue 1727, 1888: the receipt path (registration, REAL recorded receipt, application) is checked in every kind; a rehearsal also must trace it end to end.
  {
    const regs = receiptPathProblems(ev, kind, Array.isArray(m.receipt_applications) ? m.receipt_applications : [], (x) => problems.push(x));
    operationProblems(registrationOperations(regs), (x) => problems.push(x), floor);
  }
  if (reader) {
    problems.push(...(await checkReceiptApplicationsOnChain(ev, reader, floor)));
    problems.push(...(await checkVotedWeightsClearsOnChain(ev, reader, floor)));
    problems.push(...(await checkReceiptPathOnChain(ev, reader, floor)));
  }
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (${m.receipt_applications.length} receipt application(s)${values.rpc ? ", chain read" : ", offline shape only"})`);
}

/**
 * `--vault-redeploys RUN_MANIFEST --registry ADDR --timelock ADDR` (issue 1796): checks the `vault_redeploys` entries a `redeploy-vault` run wrote to its run manifest (shape, the delay
 * floor, then with --rpc the five-call batch on the timelock). A rehearsal check only: a Twin run or a Base mainnet rehearsal proves the round executes on the real contracts.
 */
async function checkRedeploysMain(values: Record<string, string | boolean | undefined>, kind: DeploymentKind): Promise<void> {
  const need = ["registry", "timelock"].filter((k) => typeof values[k] !== "string");
  if (need.length) { console.error(`evidence: --vault-redeploys needs ${need.map((k) => `--${k}`).join(", ")}`); process.exit(2); }
  const m = JSON.parse(readFileSync(values["vault-redeploys"] as string, "utf8"));
  const entries: any[] = Array.isArray(m.vault_redeploys) ? m.vault_redeploys : [];
  // QA plan v1 E1: the run manifest's own sha is the deployment's, the one prior_out_sha must name (and verified_at_sha too, unless a round ran at another sha)
  const ev = { deployment_kind: kind, core_sha: m.coreSha, registry: { address: values.registry }, timelock: { address: values.timelock }, vault_redeploys: entries, vaults: Object.fromEntries(entries.map((r) => [r?.vault, { address: r?.new_vault }])) };
  const { createPublicClient, http } = await import("viem");
  const reader = typeof values.rpc === "string" ? createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader : undefined;
  const floor = await floorArg(values, kind, reader);
  const problems = [...(entries.length > 0 ? [] : ["the run manifest has no vault_redeploys entry"]), ...entries.filter((r) => r?.status !== "governed").map((r) => `${redeployLabel(r)}: status is ${String(r?.status)}, want governed`), ...checkVaultRedeploys(ev, floor, kind)];
  if (reader) problems.push(...(await checkVaultRedeploysOnChain(ev, reader, floor)));
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (${entries.length} vault redeploy entr${entries.length === 1 ? "y" : "ies"}${values.rpc ? ", chain read" : ", offline shape only"})`);
}

/**
 * `--vault-retirements RUN_MANIFEST --registry ADDR --timelock ADDR [--delay-floor S] [--rpc URL]` (issue 1912, ADR-0017): the `vault_retirements` entries a `govern --row retire-vault` run wrote.
 * Offline: the shape, the three-leg vector and the delays. With --rpc: each batch is read from the chain (two CallScheduled and two CallExecuted events with the rebuilt calldata). The Twin
 * upgrade rehearsal runs it on its retirement of a populated fourth vault.
 */
async function checkRetirementsMain(values: Record<string, string | boolean | undefined>, kind: DeploymentKind): Promise<void> {
  const need = ["registry", "timelock"].filter((k) => typeof values[k] !== "string");
  if (need.length) { console.error(`evidence: --vault-retirements needs ${need.map((k) => `--${k}`).join(", ")}`); process.exit(2); }
  const m = JSON.parse(readFileSync(values["vault-retirements"] as string, "utf8"));
  const entries: any[] = Array.isArray(m.vault_retirements) ? m.vault_retirements : [];
  const ev = { deployment_kind: kind, registry: { address: values.registry }, timelock: { address: values.timelock }, vault_retirements: entries };
  const { createPublicClient, http } = await import("viem");
  const reader = typeof values.rpc === "string" ? createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader : undefined;
  const floor = await floorArg(values, kind, reader);
  const problems = [...(entries.length > 0 ? [] : ["the run manifest has no vault_retirements entry"]), ...checkVaultRetirements(ev, floor)];
  if (reader) problems.push(...(await checkVaultRetirementsOnChain(ev, reader, floor)));
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (vault retirements: ${entries.length} retirement(s)${values.rpc ? ", chain read" : ", offline shape only"})`);
}

/** An eth_call that returns the revert data, or undefined when the call succeeds. Raw JSON-RPC: the revert data is the error's `data`. */
export function rpcCallRevert(url: string): LifecycleChain["callRevert"] {
  return async ({ from, to, data }) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ from, to, data }, "latest"] }) });
    const j = (await res.json()) as { result?: Hex; error?: { message?: string; data?: unknown } };
    if (!j.error) return undefined;
    const d = typeof j.error.data === "string" ? j.error.data : typeof (j.error.data as { data?: unknown })?.data === "string" ? (j.error.data as { data: string }).data : "";
    return (/^0x[0-9a-fA-F]*$/.test(d) ? d : "0x") as Hex;
  };
}

/**
 * `--upgrade-lifecycle FILE` (issue 1811): the record of the Twin upgrade rehearsal (src/ci/twin-upgrade-lifecycle.ts). Offline: the steps tell one story against the full
 * proxied core set of this checkout's stage table. With --rpc: every transaction, the refused operation and the final proxy record are read back from the chain.
 */
async function checkLifecycleMain(values: Record<string, string | boolean | undefined>): Promise<void> {
  const r = JSON.parse(readFileSync(values["upgrade-lifecycle"] as string, "utf8"));
  const problems = upgradeLifecycleProblems(r, repoProxyNames(r?.upgrade?.proxy === "gateway" ? "legacy" : "vaults"));
  if (problems.length === 0 && typeof values.rpc === "string") {
    const { createPublicClient, http } = await import("viem");
    const client = createPublicClient({ transport: http(values.rpc) });
    if ((await client.getChainId()) !== r.chain_id) problems.push(`upgrade-lifecycle: the --rpc chain id is ${await client.getChainId()}, the record is for ${r.chain_id}`);
    else problems.push(...(await upgradeLifecycleOnChainProblems(r, Object.assign(client as unknown as LifecycleChain, { callRevert: rpcCallRevert(values.rpc) }))));
  }
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (upgrade lifecycle: deploy upgradeable, governed upgrade, freeze of ${Object.keys(r.freeze.targets).length} proxies, refused upgrade${values.rpc ? ", chain read" : ", offline shape only"})`);
}

/** The per-stage cap from core's stage table in this checkout. The timelock stage may adopt the core timelock itself (issue 1835). */
export function adoptableFromTable(t: StageTable = loadStageTable(new URL("../../", import.meta.url).pathname)): AdoptableLibraries {
  return Object.fromEntries(t.stages.map((st) => [st.name, st.name === LIBS_STAGE ? t.libraries.length : (st.create2Libraries ?? []).length + (st.name === t.upgradeAuthority?.stage ? 1 : 0)]));
}

/**
 * `--governed-upgrades RUN_MANIFEST --timelock ADDR [--governance ADDR] [--delay-floor S] [--rpc URL]` (issue 1910): the `proxy_upgrades` and `upgrade_freezes` entries a govern run
 * wrote. Offline: the shape, the delays and every typed migration (governedUpgradeProblems). With --rpc: each upgrade's scheduled data is read from the chain and must equal
 * `upgradeToAndCall(impl, typed migration data)`. The Twin upgrade rehearsal runs it on its receipt migration.
 */
async function checkGovernedUpgradesMain(values: Record<string, string | boolean | undefined>, kind: DeploymentKind): Promise<void> {
  const need = ["timelock"].filter((k) => typeof values[k] !== "string");
  if (need.length) { console.error(`evidence: --governed-upgrades needs ${need.map((k) => `--${k}`).join(", ")}`); process.exit(2); }
  const m = JSON.parse(readFileSync(values["governed-upgrades"] as string, "utf8"));
  const ev: any = { deployment_kind: kind, timelock: { address: values.timelock }, proxy_upgrades: m.proxy_upgrades, upgrade_freezes: m.upgrade_freezes, ...(typeof values.governance === "string" ? { governance: { address: values.governance } } : {}) };
  const { createPublicClient, http } = await import("viem");
  const reader = typeof values.rpc === "string" ? createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader : undefined;
  const floor = await floorArg(values, kind, reader);
  const problems = [...((Array.isArray(m.proxy_upgrades) && m.proxy_upgrades.length > 0) ? [] : ["the run manifest has no proxy_upgrades entry"]), ...governedUpgradeProblems(ev, floor)];
  if (reader) problems.push(...(await checkGovernedUpgradesOnChain(ev, reader)));
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (governed upgrades: ${m.proxy_upgrades.length} upgrade(s), ${Array.isArray(m.proxy_upgrades) ? m.proxy_upgrades.filter((x: any) => x.migration).length : 0} with a typed migration${reader ? ", chain read" : ", offline shape only"})`);
}

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, "governed-upgrades": { type: "string" }, "receipt-applications": { type: "string" }, "delay-floor": { type: "string" }, "deployment-kind": { type: "string" }, "consensus-receipt": { type: "string" }, governance: { type: "string" }, timelock: { type: "string" }, frozen: { type: "string" }, "deploy-sha": { type: "string" }, rpc: { type: "string" }, "upgrade-lifecycle": { type: "string" }, "chain-fixture": { type: "string" }, "record-chain-fixture": { type: "string" }, "vault-redeploys": { type: "string" }, "vault-retirements": { type: "string" }, registry: { type: "string" } } });
  const kindArg = values["deployment-kind"] ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(kindArg)) { console.error(`evidence: --deployment-kind must be ${DEPLOYMENT_KINDS.join(" or ")}`); process.exit(2); }
  const kind = kindArg as DeploymentKind;
  if (values["upgrade-lifecycle"]) return checkLifecycleMain(values);
  if (values["governed-upgrades"]) return checkGovernedUpgradesMain(values, kind);
  if (values["receipt-applications"]) return checkApplicationsMain(values, kind);
  if (values["vault-redeploys"]) return checkRedeploysMain(values, kind);
  if (values["vault-retirements"]) return checkRetirementsMain(values, kind);
  if (!values.evidence) { console.error("missing --evidence FILE"); process.exit(2); }
  const ev = JSON.parse(readFileSync(values.evidence, "utf8"));
  let counts: Record<string, number> | undefined;
  if (values.frozen) {
    const j = JSON.parse(readFileSync(values.frozen, "utf8"));
    if (values["deploy-sha"] && j.deploySha !== values["deploy-sha"]) { console.error(`evidence: frozen file is for ${j.deploySha}, not ${values["deploy-sha"]}`); process.exit(1); }
    counts = j.counts ?? j;
  }
  const problems = [...checkEvidence(ev, counts, adoptableFromTable(), { kind }), ...scanEvidenceFolder(join(values.evidence, ".."))];
  if (values.rpc && values["chain-fixture"]) { console.error("evidence: give --rpc or --chain-fixture, not both"); process.exit(2); }
  if (values["record-chain-fixture"] && !values.rpc) { console.error("evidence: --record-chain-fixture needs --rpc"); process.exit(2); }
  if ((values.rpc || values["chain-fixture"]) && !counts) { console.error("evidence: reading the chain needs --frozen FILE (and --deploy-sha SHA): the nonce is checked against the frozen counts"); process.exit(2); }
  if (values["chain-fixture"] && !values["deploy-sha"]) { console.error("evidence: --chain-fixture needs --deploy-sha SHA, so the frozen file is the one for this deploy"); process.exit(2); }
  if (values.rpc) {
    const { createPublicClient, http } = await import("viem");
    const live = createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader;
    const rec = values["record-chain-fixture"] ? recordingChainReader(live) : undefined;
    problems.push(...(await checkEvidenceOnChain(ev, rec?.reader ?? live, counts!, { kind })));
    if (rec && problems.length === 0) { writeFileSync(values["record-chain-fixture"]!, JSON.stringify(rec.fixture, null, 2) + "\n"); console.error(`evidence: chain fixture written to ${values["record-chain-fixture"]}`); }
  } else if (values["chain-fixture"]) {
    problems.push(...(await checkEvidenceOnChain(ev, chainReaderFromFixture(JSON.parse(readFileSync(values["chain-fixture"], "utf8"))), counts!, { kind })));
  }
  if (problems.length) { for (const m of problems) console.error(`evidence: ${m}`); process.exit(1); }
  console.log(values.rpc ? "evidence ok (chain read)" : values["chain-fixture"] ? "evidence ok (recorded chain fixture, offline)" : "evidence ok (offline shape only)");
}
if (import.meta.main) main();
