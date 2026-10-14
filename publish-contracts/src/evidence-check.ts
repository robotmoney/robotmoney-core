#!/usr/bin/env bun
// Evidence check for a mainnet run. Reads evidence/<run-id>/evidence.json (template: publish-contracts/evidence.example.json).
// Usage: bun src/evidence-check.ts --vault-redeploys RUN_MANIFEST --registry ADDR --timelock ADDR [--delay-floor SECONDS] [--rpc URL]   (a single-vault redeploy of a rehearsal or a Twin run, issue 1796)
//        bun src/evidence-check.ts --receipt-applications RUN_MANIFEST --consensus-receipt ADDR --governance ADDR --timelock ADDR [--delay-floor SECONDS] [--rpc URL]   (a Twin run; the floor defaults to the 8453 floor, a Twin run passes its own timelock min delay, issue 1696)
//        bun src/evidence-check.ts --evidence FILE [--frozen FILE --deploy-sha SHA] [--rpc URL [--record-chain-fixture OUT] | --chain-fixture FILE]
// Rejects: a wrong tx count against the frozen count, a missing tx hash, a failed receipt, a delay under 172800 s, a govern
// schedule-to-execute gap under 172800 s per operation, a govern operation that shares a transaction or a timelock operation id with another one, any
// operation scheduled on 8453 that is not a vault unpause (issue 1520) or a validated receipt release (issue 1611), a chain id other than 8453, owner exceptions recorded at or after plan approval.
// DEPLOYMENT KIND (issue 1727): the evidence is read as PRODUCTION unless `--deployment-kind rehearsal` is passed. Evidence carries `deployment_kind` (absent means production).
// A rehearsal evidence presented as production fails, and so does a production evidence presented as a rehearsal. Production keeps the 172800 s floor and the four unpauses.
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
import { REGISTER_ROW, buildRegisterCalls } from "./committee-register.ts";
import { CLEAR_ROW, clearCalldata } from "./clear-voted-weights.ts";
import { applyCalldata } from "./apply-receipt.ts";
import { REDEPLOY_ROW, asVaultCap, buildRedeployCalls, createdVaultProblems, vectorsFromFinal, type DeployReceipt } from "./redeploy-vault.ts";
import { assertOwnerExceptions } from "./plan.ts";
import { effectiveCounts, finalDeployerNonce } from "./counts.ts";
import { LIBS_STAGE } from "./core-wiring.ts";
import { loadStageTable } from "./stage-table.ts";
import { VAULT_NAME } from "./sheet.ts";
import { STAGE13_UNPAUSE_ROWS, UNPAUSE_ROW_NAMES, VAULT_RULES, vaultOfUnpauseRow } from "./vault-rules.ts";

const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * Stage 13 on 8453 (issue 1520): the unpause of each of the four vaults (rmUSDC too since issue 1710: all four deploy paused). One govern entry per vault, each with
 * its own schedule transaction, its own execute transaction and its own timelock operation (never a shared one). All are scheduled in one sitting and wait
 * one delay: each execute is at least 172800 s after the same operation's schedule. update-delay, batch and cancel are Twin-only demonstrations of the
 * Safe tool: on 8453 they are rejected here. The steps are the stage table's vault rules (issue 1705, src/vault-rules.ts): every vault whose `unpauseInStage13`
 * is set, by its `unpauseRow`, the same names the govern CLI runs (src/govern.ts stageRows(8453)).
 */
export const GOVERN_STEPS: readonly string[] = STAGE13_UNPAUSE_ROWS;

/**
 * Issue 1667: a vault the tool paused (pause-all, any of the four) comes back through a Safe -> Timelock unpause round. Every unpause step is required (round 1,
 * stage 13) and may repeat as a numbered ROUND (`round`, default 1): a vault paused again after an executed unpause has a second round with its own schedule, execute
 * and operation id. The one call on any vault the evidence accepts is unpauseDeposits().
 */
export const UNPAUSE_STEPS: readonly string[] = UNPAUSE_ROW_NAMES;
/** The evidence vault name (rmUSDC, ...) an unpause step opens. */
const VAULT_OF_STEP: Record<string, string> = Object.fromEntries(UNPAUSE_ROW_NAMES.map((r) => [r, VAULT_NAME[vaultOfUnpauseRow(r)!]]));
const UNPAUSE_ABI = parseAbi(["function unpauseDeposits()"]);
export const unpauseCalldata = (): Hex => encodeFunctionData({ abi: UNPAUSE_ABI, functionName: "unpauseDeposits" });
const roundOf = (g: any): number => (g?.round === undefined ? 1 : g.round);
const stepLabel = (g: any): string => (roundOf(g) === 1 ? String(g?.step) : `${g?.step} round ${roundOf(g)}`);

/**
 * The one other operation the timelock may carry on 8453 (issue 1611): a post-launch consensus receipt release, recorded under `receipt_releases` (never
 * in `govern`, so stage 13 stays the four unpauses). One entry per receipt: one schedule and one execute at least MAINNET_DELAY_FLOOR apart, the target the
 * receipt contract (`consensus_receipt.address`), the calldata releaseReceipt(receipt_id). The list is optional. Any other operation fails.
 */
const RELEASE_ABI = parseAbi(["function releaseReceipt(bytes32 receiptId)"]);
export const releaseCalldata = (receiptId: string): Hex => encodeFunctionData({ abi: RELEASE_ABI, functionName: "releaseReceipt", args: [receiptId as Hex] });
const releaseLabel = (r: any) => `release-receipt ${r?.receipt_id}`;

/**
 * A post-launch receipt application (issue 1696, issue 1698, `govern --row apply-receipt`), recorded under `receipt_applications` (never in `govern`, so stage 13 stays
 * the four unpauses). One entry per receipt: ONE timelock call, applyReceipt(receipt_id, payload_digest, vaults, bps) on the governance contract (`governance.address`),
 * which releases the receipt on the receipt contract (`receipt`, equal to `consensus_receipt.address`) and writes the vector to the router in one transaction; one
 * schedule and one execute at least MAINNET_DELAY_FLOOR apart. The entry carries the `payload_digest` the call named (the chain refused any other).
 * The Twin run writes the same entries into the run manifest and `--receipt-applications` checks them (a Twin run proves execution only, not mainnet governance).
 */
export { applyCalldata };
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
    if (g.execute_status !== 1) bad(`govern ${g.step}: execute receipt status is ${g.execute_status}`);
    if (INTERNAL_CANCELS.has(g)) continue; // only the rehearsal cancel row, built by rowOperations below, never executes. Nothing read from the evidence JSON can set this.
    const gap = Number(g.execute_block_timestamp) - Number(g.schedule_block_timestamp);
    if (!(gap >= floor)) bad(`govern ${g.step}: schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
}

/** The shape of the `receipt_applications` list and of each entry (no chain read). Also run on its own for a Twin run manifest. */
function applicationShapeProblems(ev: any, bad: (m: string) => void): any[] {
  const apps: any[] = ev?.receipt_applications === undefined ? [] : Array.isArray(ev.receipt_applications) ? ev.receipt_applications : (bad("receipt_applications is not a list"), []);
  if (apps.length > 0 && !ADDR.test(ev?.consensus_receipt?.address ?? "")) bad("consensus_receipt.address is missing: a receipt application has no release target to check");
  if (apps.length > 0 && !ADDR.test(ev?.governance?.address ?? "")) bad("governance.address is missing: a receipt application has no weight-change target to check");
  const seen = new Set<string>();
  for (const r of apps) {
    const w = applyLabel(r);
    if (!TX.test(r?.receipt_id ?? "")) bad(`${w}: receipt_id is not a bytes32`);
    else if (seen.has(lc(r.receipt_id))) bad(`${w}: receipt_id has more than one evidence entry`);
    else seen.add(lc(r.receipt_id));
    if (r?.step !== undefined && r.step !== "apply-receipt") bad(`${w}: step '${r.step}' is not apply-receipt`);
    // issue 1698: the one call targets the governance contract; `receipt` names the register it released the receipt on (an older entry's `target` was that register)
    const receiptAddr = r?.receipt ?? r?.target;
    if (lc(receiptAddr ?? "") !== lc(ev?.consensus_receipt?.address ?? "")) bad(`${w}: receipt ${receiptAddr} is not the receipt contract ${ev?.consensus_receipt?.address}`);
    if (lc(r?.governance ?? "") !== lc(ev?.governance?.address ?? "")) bad(`${w}: governance ${r?.governance} is not the governance contract ${ev?.governance?.address}`);
    if (!TX.test(r?.payload_digest ?? "")) bad(`${w}: payload_digest is not a bytes32: the applyReceipt call names the digest the register stored, and the entry must carry it`);
    const vaults: unknown[] = Array.isArray(r?.vaults) ? r.vaults : [];
    const bps: unknown[] = Array.isArray(r?.bps) ? r.bps : [];
    if (vaults.length === 0 || vaults.length !== bps.length || !vaults.every((v) => typeof v === "string" && ADDR.test(v)) || new Set(vaults.map((v) => lc(String(v)))).size !== vaults.length) bad(`${w}: vaults and bps are not a list of distinct addresses with one weight each`);
    else if (!bps.every((x) => Number.isInteger(x) && (x as number) >= 0) || (bps as number[]).reduce((t, x) => t + x, 0) !== 10000) bad(`${w}: bps do not sum to 10000`);
    if (releasedIds(ev).has(lc(r?.receipt_id ?? ""))) bad(`${w}: the receipt is also under receipt_releases: a receipt is released once`);
    // an application makes its vector the ACTIVE one (votedWeightsActive reads true afterwards), so no voted flag is required of it: the effective vector is the proof
    effectiveReadBackProblems(w, r, vaults, bps, bad, false);
  }
  return apps;
}

/**
 * Issue 1743: the router's EFFECTIVE weights are what deposits route by. After an application or a clear the entry records what the read-back saw (`effective_vaults`,
 * `effective_bps`). A clear (and a redeploy) also records `voted_weights_active: false`: the active vector is gone and the default routes again (`wantVotedFalse`).
 * An application does not (issue 1698): its vector IS the active one, so the effective vector equal to the applied vector is the whole proof.
 * `vaults` / `bps` are the vector the entry claims the router holds (the applied one); undefined for a clear entry, which only needs a well formed vector.
 */
function effectiveReadBackProblems(w: string, r: any, vaults: unknown[] | undefined, bps: unknown[] | undefined, bad: (m: string) => void, wantVotedFalse = true): void {
  if (wantVotedFalse && r?.voted_weights_active !== false) bad(`${w}: voted_weights_active is ${String(r?.voted_weights_active)}, want false: the read-back must show no active vector overriding the default (issue 1743)`);
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
 * A router voted-vector clear (issue 1743, `govern --row clear-voted-weights`), recorded under `voted_weights_clears` (never in `govern`, so stage 13 stays the four unpauses).
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
    effectiveReadBackProblems(w, r, undefined, undefined, bad);
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
 * A single-vault redeploy (issue 1796, the `redeploy-vault` verb and `govern --row redeploy-vault`), recorded under `vault_redeploys` (never in `govern`, so stage 13 stays the four unpauses).
 * One entry per redeploy: the deploy transactions the deployer sent (`deploy_tx_hashes`, `deploy_count`, all status 1), the vault it replaced (`old_vault`, now Retired) and the vault that replaced
 * it (`new_vault`, the address `vaults.<vault>.address` names), ONE timelock batch of seven calls (QA plan v1 E3: the cap the batch copies is `router_vault_cap`, the old vault's
 * `router.vaultCap` when the round was planned, a decimal uint256), one schedule and one execute at least the floor apart, and the read-back: the final default
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
    if (ADDR.test(r?.deployer ?? "") && ADDR.test(ev?.deployer ?? "") && lc(r.deployer) !== lc(ev.deployer)) bad(`${w}: deployer ${r.deployer} is not the run's deployer ${ev.deployer}: the new vault must be a CREATE by the run's deployer`);
    if (typeof r?.registry_name !== "string" || r.registry_name === "") bad(`${w}: registry_name is missing`);
    // QA plan v1 E3: the cap the batch's router.setVaultCap(new, ...) carried, so the chain check can rebuild that call
    const capOk = typeof r?.router_vault_cap === "string" && (() => { try { asVaultCap(r.router_vault_cap); return true; } catch { return false; } })();
    if (!capOk) bad(`${w}: router_vault_cap ${String(r?.router_vault_cap)} is not a decimal uint256 string (the old vault's router.vaultCap, copied to the new vault by the batch)`);
    // QA plan v1 E1: the verify after the round compared every contract the redeploy did not replace with --prior-out, a build of the deployment's own sha
    if (r?.prior_out_sha !== undefined && r.prior_out_sha !== ev?.core_sha) bad(`${w}: prior_out_sha ${String(r.prior_out_sha)} is not the evidence core_sha ${String(ev?.core_sha)}: the contracts the redeploy did not replace are verified against the build of the original deployment sha`);
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
    effectiveReadBackProblems(w, r, vaults, bps, bad);
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
 * Issue 1727, the receipt path of a rehearsal. `committee_registrations`: one entry per submitter, ONE timelock batch (setPolicy, committeeRegister; QA plan v1 B6), one schedule and one execute at
 * least the floor apart. `recorded_receipts`: one entry per receipt the submitter anchored through the gateway (receipt_id, payload_digest, payload_uri, submitter ADDRESS, tx_hash; never a key).
 * Both are refused in a production evidence. In a rehearsal every receipt_applications entry must trace to a recorded receipt with the same digest, by a registered submitter.
 */
/**
 * Issue 1750 (owner decision 2026-10-10): the consensus receipt submitter is a multisig. An entry's `submitter_safe` names the Safe's threshold (2 or more), owners and proxy code
 * hash; a recorded receipt's also the Safe transaction hash, the nonce and the owners that signed (at least the threshold, all owners). An entry WITHOUT it is a single key:
 * refused on 8453, and refused anywhere when that key is a role key (the deployer/admin, a governing Safe owner) or when the submitter is the governing Safe or the timelock.
 */
function submitterSafeProblems(ev: any, r: any, w: string, recorded: boolean, bad: (m: string) => void): void {
  const sub = String(r?.submitter ?? "");
  const roleKeys = new Map<string, string>([
    [lc(ev?.safe?.address ?? ""), "the governing Safe"], [lc(ev?.timelock?.address ?? ""), "the timelock"], [lc(ev?.deployer ?? ""), "the deployer (admin)"],
    ...((Array.isArray(ev?.safe?.owners) ? ev.safe.owners : []) as string[]).map((o, i) => [lc(o), `governing Safe owner ${i + 1}`] as [string, string]),
  ]);
  roleKeys.delete("");
  const why = roleKeys.get(lc(sub));
  const sf = r?.submitter_safe;
  if (why) bad(`${w}: the submitter ${sub} is ${why}: the submitter is a separate multisig Safe that holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else`);
  if (sf === undefined) {
    if (ev?.chain_id === MAINNET_CHAIN_ID) bad(`${w}: no submitter_safe: on 8453 the consensus receipt submitter is a multisig Safe, never a single key`);
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
const regLabel = (r: any) => `${REGISTER_ROW} ${r?.submitter}`;
const recLabel = (r: any) => `recorded receipt ${r?.receipt_id}`;
function receiptPathProblems(ev: any, kind: DeploymentKind, applications: any[], bad: (m: string) => void): any[] {
  const regs: any[] = ev?.committee_registrations === undefined ? [] : Array.isArray(ev.committee_registrations) ? ev.committee_registrations : (bad("committee_registrations is not a list"), []);
  const recs: any[] = ev?.recorded_receipts === undefined ? [] : Array.isArray(ev.recorded_receipts) ? ev.recorded_receipts : (bad("recorded_receipts is not a list"), []);
  if (kind !== "rehearsal") {
    if (regs.length > 0) bad("committee_registrations is present in a production evidence: the production govern surface on 8453 is the four unpauses, release-receipt and apply-receipt");
    if (recs.length > 0) bad("recorded_receipts is present in a production evidence: production records receipts with rmpc and an HSM or KMS signer, outside this evidence");
    return [];
  }
  const seenSub = new Set<string>();
  for (const r of regs) {
    const w = regLabel(r);
    if (!ADDR.test(r?.submitter ?? "")) bad(`${w}: submitter is not an address`);
    else if (seenSub.has(lc(r.submitter))) bad(`${w}: submitter has more than one evidence entry`);
    else seenSub.add(lc(r.submitter));
    if (r?.step !== undefined && r.step !== REGISTER_ROW) bad(`${w}: step '${r.step}' is not ${REGISTER_ROW}`);
    for (const k of ["gateway", "ic_policy", "timelock"]) if (!ADDR.test(r?.[k] ?? "")) bad(`${w}: ${k} is not an address`);
    if (ADDR.test(r?.timelock ?? "") && lc(r.timelock) !== lc(ev?.timelock?.address ?? "")) bad(`${w}: timelock ${r.timelock} is not the run's timelock ${ev?.timelock?.address}`);
    submitterSafeProblems(ev, r, w, false, bad);
    if (typeof r?.agent_label !== "string" || r.agent_label === "") bad(`${w}: agent_label is missing`);
    if (!/^[0-9]+$/.test(String(r?.valid_until ?? ""))) bad(`${w}: valid_until is not a decimal timestamp`);
    // QA plan v1 B6: the submitter Safe's private self-authorization, as its three transactions (the chain check orders the hand-over before the schedule)
    const sa = r?.self_authorization;
    if (sa !== undefined) for (const k of ["commit_tx", "reveal_tx", "hand_over_tx"]) if (sa?.[k] !== undefined && !TX.test(String(sa[k]))) bad(`${w}: self_authorization.${k} is not a transaction hash`);
  }
  const seenRec = new Set<string>();
  for (const r of recs) {
    const w = recLabel(r);
    if (!TX.test(r?.receipt_id ?? "")) bad(`${w}: receipt_id is not a bytes32`);
    else if (seenRec.has(lc(r.receipt_id))) bad(`${w}: receipt_id has more than one evidence entry`);
    else seenRec.add(lc(r.receipt_id));
    if (!TX.test(r?.payload_digest ?? "")) bad(`${w}: payload_digest is not a bytes32`);
    if (typeof r?.payload_uri !== "string" || !/^https?:\/\//.test(r.payload_uri)) bad(`${w}: payload_uri is not an http(s) route`);
    if (!ADDR.test(r?.submitter ?? "")) bad(`${w}: submitter is not an address`);
    else if (!seenSub.has(lc(r.submitter))) bad(`${w}: submitter ${r.submitter} has no committee_registrations entry: a receipt is recorded only by a registered submitter`);
    submitterSafeProblems(ev, r, w, true, bad);
    if (r?.already_recorded !== true && !TX.test(r?.tx_hash ?? "")) bad(`${w}: tx_hash is missing`);
    if (r?.status !== 1) bad(`${w}: status is ${r?.status}`);
  }
  for (const a of applications) {
    const rec = recs.find((x) => lc(x?.receipt_id ?? "") === lc(a?.receipt_id ?? ""));
    if (!rec) bad(`${applyLabel(a)}: the receipt was not recorded through the gateway in this run (no recorded_receipts entry): a rehearsal applies a REAL recorded receipt`);
    else if (lc(rec.payload_digest ?? "") !== lc(a?.payload_digest ?? "")) bad(`${applyLabel(a)}: payload_digest ${a?.payload_digest} differs from the recorded receipt's ${rec.payload_digest}`);
  }
  return regs;
}
const registrationOperations = (regs: any[]): any[] => regs.map((r) => ({ ...r, step: regLabel(r) }));

/** How the evidence is read (issue 1727). `kind` is the deployment kind the caller expects: production unless the operator passed --deployment-kind rehearsal. */
export interface EvidenceOpts { kind?: DeploymentKind }
const kindOf = (o?: EvidenceOpts): DeploymentKind => o?.kind ?? "production";
/** The kind the evidence claims (absent: production) against the kind it is read as. A mismatch is always a problem, whichever way round. */
function kindProblems(ev: any, expected: DeploymentKind, bad: (m: string) => void): void {
  const claimed = ev?.deployment_kind ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(claimed)) { bad(`deployment_kind '${String(claimed)}' is not ${DEPLOYMENT_KINDS.join(" or ")}`); return; }
  if (claimed !== expected) bad(`deployment_kind is ${claimed}, the evidence is checked as ${expected}${claimed === "rehearsal" ? ": a rehearsal evidence is never production evidence (pass --deployment-kind rehearsal to check a rehearsal)" : ": a production evidence is not a rehearsal"}`);
}

/**
 * Issue 1727: the rehearsal-only govern rows on 8453, recorded under `rehearsal_rows` (never in `govern`, so stage 13 stays the four unpauses). update-delay and batch:
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
  try { return effectiveCounts(frozenCounts, adoptedTxsOfEvidence(ev)); } catch { return frozenCounts; }
}
const adoptedLibraries = (s: any): { name?: string; address?: string; code_hash?: string }[] => (Array.isArray(adoptedOf(s)?.libraries) ? adoptedOf(s).libraries : []);

/** stage -> how many libraries the stage table lets it adopt (libs: its linked libraries; a basket stage: its create2Libraries). The CLI passes it from the table. */
export type AdoptableLibraries = Record<string, number>;

export function checkEvidence(ev: any, frozenCounts?: Record<string, number>, adoptable?: AdoptableLibraries, opts?: EvidenceOpts): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const kind = kindOf(opts);
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
  for (const k of VAULT_RULES.map((v) => VAULT_NAME[v.key])) if (!ADDR.test(ev?.vaults?.[k]?.address ?? "")) bad(`vault ${k} address is missing`);

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
  // one operation per unpause, release or application: no schedule or execute transaction, and no timelock operation id, is shared by two operations
  forbidCancelFields([...govern, ...releases, ...applications, ...clears, ...redeploys, ...(Array.isArray(ev?.committee_registrations) ? ev.committee_registrations : [])], (e) => String(e?.step ?? "entry"), bad);
  const rrows = rehearsalRowProblems(ev, kind, bad);
  const regs = receiptPathProblems(ev, kind, applications, bad);
  operationProblems([...govern.map((g) => ({ ...g, step: stepLabel(g) })), ...releases.map((r) => ({ ...r, step: releaseLabel(r) })), ...applications.map((r) => ({ ...r, step: applyLabel(r) })), ...clears.map((r) => ({ ...r, step: clearLabel(r) })), ...redeploys.map((r) => ({ ...r, step: redeployLabel(r) })), ...rowOperations(rrows), ...registrationOperations(regs)], bad, floor);
  if (!ADDR.test(ev?.deployer ?? "")) bad("deployer address is missing");
  if (!ADDR.test(ev?.registry?.address ?? "")) bad("registry address is missing");
  if (!Number.isInteger(ev?.deployer_nonce_final)) bad("deployer_nonce_final is missing");
  const start = startNonceOf(ev, kind, bad);
  if (frozenCounts && ev?.deployer_nonce_final !== finalDeployerNonce(effectiveForEvidence(ev, frozenCounts), start) + redeployTxs(ev)) bad(`deployer_nonce_final ${ev?.deployer_nonce_final} differs from ${start ? `the start nonce ${start} plus ` : ""}the summed frozen counts plus the prove-control transaction${redeployTxs(ev) ? ` plus the ${redeployTxs(ev)} redeploy transaction(s)` : ""} ${finalDeployerNonce(effectiveForEvidence(ev, frozenCounts), start) + redeployTxs(ev)}${Object.keys(adoptedTxsOfEvidence(ev)).length ? " (adopted stages counted at the transactions the deployer sent)" : ""}`);
  if (ev?.verifier?.exit_code !== 0) bad("the verifier did not exit 0");
  if (ev?.verifier?.registry_list_vaults_equals_manifests !== true) bad("registry listVaults was not shown equal to the manifests");
  if (ev?.sources?.blockscout_all_verified !== true || ev?.sources?.sourcify_all_exact !== true) bad("source verification is not complete");
  return p;
}

/** The slice of a viem PublicClient this check uses. A stub implements it in unit tests. */
export interface ChainReader {
  getChainId(): Promise<number>;
  getTransactionCount(a: { address: `0x${string}` }): Promise<number>;
  /** `from` and `contractAddress` (a CREATE's created contract, else null) are read for the redeploy deploy transactions only (QA plan v1 C2). */
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[]; from?: string; contractAddress?: string | null }>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  /** Runtime code at an address (viem getCode). Needed only when the evidence records an adopted stage. */
  getCode?(a: { address: `0x${string}` }): Promise<Hex | undefined>;
  readContract(a: { address: `0x${string}`; abi: any; functionName: string }): Promise<unknown>;
}

const TIMELOCK_ABI = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
]);
/** QA plan v1 C2 (issue 1701): the event RouterGovernance.applyReceipt emits. An application's entry must be what the chain applied, not only what the timelock called. */
const GOVERNANCE_EVENTS_ABI = parseAbi(["event ReceiptApplied(bytes32 indexed receiptId, bytes32 payloadDigest, address[] vaults, uint256[] bps)"]);
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
  p.push(...(await checkReceiptApplicationsOnChain(ev, chain, FLOOR)));
  p.push(...(await checkVotedWeightsClearsOnChain(ev, chain, FLOOR)));
  p.push(...(await checkVaultRedeploysOnChain(ev, chain, FLOOR)));
  if (kind === "rehearsal") { p.push(...(await checkRehearsalRowsOnChain(ev, chain, FLOOR))); p.push(...(await checkReceiptPathOnChain(ev, chain, FLOOR))); }
  // The unpause govern rows and the depositsPaused() reads must tell one story: a vault is unpaused on chain exactly when its LATEST unpause round executed
  // (all four vaults deploy paused, issue 1710).
  // A vault the table deploys open (deployPaused false) reads unpaused with no row behind it; every vault does today (issue 1710).
  for (const v of VAULT_RULES) {
    const name = VAULT_NAME[v.key], step = v.unpauseRow;
    const rows = (ev.govern ?? []).filter((g: any) => g?.step === step).sort((x: any, y: any) => roundOf(x) - roundOf(y));
    const row = rows[rows.length - 1];
    const vault = ev.vaults?.[name]?.address;
    if (!vault) continue;
    let paused: unknown;
    try { paused = await chain.readContract({ address: vault, abi: PAUSED_ABI, functionName: "depositsPaused" }); }
    catch (e) { bad(`${name}.depositsPaused() not readable (${(e as Error).message})`); continue; }
    const executed = !!row && row.execute_status === 1 && TX.test(row.execute_tx ?? "");
    if (executed && paused !== false) bad(`govern ${step} executed with receipt status 1, but ${name}.depositsPaused() reads ${String(paused)} on chain, want false`);
    if (!executed && paused === false && v.deployPaused) bad(`${name}.depositsPaused() reads false on chain, but govern ${step} has no executed receipt`);
  }
  return p;
}

/**
 * Chain check of `receipt_applications` (issue 1696, issue 1698). Each entry is ONE timelock call: the schedule tx has exactly one CallScheduled event (the recorded
 * operation_id), target the governance contract, calldata applyReceipt(receipt_id, payload_digest, vaults, bps) rebuilt from the entry, a delay of at least
 * MAINNET_DELAY_FLOOR. The execute tx has the matching CallExecuted event. The block gap is at least MAINNET_DELAY_FLOOR.
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
    if (!TX.test(r?.receipt_id ?? "") || !ADDR.test(ev.consensus_receipt?.address ?? "") || !ADDR.test(ev.governance?.address ?? "") || !Array.isArray(r.vaults) || !Array.isArray(r.bps) || r.vaults.length !== r.bps.length) continue; // the offline check already named it
    if (!TX.test(r?.payload_digest ?? "")) continue; // the offline check already named it
    const sc = await status(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled");
    if (scheduled.length !== 1) { bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, an application is exactly one call, applyReceipt on the governance contract (issue 1698)`); continue; }
    const want = applyCalldata(r.receipt_id, r.payload_digest, r.vaults, r.bps);
    const e = scheduled[0]!;
    if (lc(e.target) !== lc(ev.governance.address)) bad(`${w}: CallScheduled target ${e.target} is not the governance contract ${ev.governance.address}`);
    else if (lc(e.data) !== lc(want)) bad(`${w}: CallScheduled calldata is not applyReceipt(${r.receipt_id}, ${r.payload_digest}, vaults, bps) of the recorded vector`);
    if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
    if (typeof r.operation_id === "string" && lc(r.operation_id) !== lc(e.id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${e.id}`);
    const schedTs = await ts(sc);
    const ex = await status(`${w} execute`, r.execute_tx);
    if (!ex) continue;
    if (!timelockEvents(ex, ev.timelock.address, "CallExecuted").some((x) => lc(x.id) === lc(e.id) && lc(x.target) === lc(ev.governance.address) && lc(x.data) === lc(want))) bad(`${w}: the execute tx has no CallExecuted event for the scheduled applyReceipt call`);
    receiptAppliedProblems(w, r, ex, ev.governance.address, bad);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

/**
 * QA plan v1 C2 (issue 1701): the entry is bound to the chain's own record of the application. The execute tx must carry the governance contract's ReceiptApplied event
 * for the entry's receipt, with the entry's digest and vector: a forged entry (another vector, another digest) is refused even when its transactions exist.
 */
function receiptAppliedProblems(w: string, r: any, ex: Awaited<ReturnType<ChainReader["getTransactionReceipt"]>>, governance: string, bad: (m: string) => void): void {
  const applied: { receiptId: string; payloadDigest: string; vaults: readonly string[]; bps: readonly bigint[] }[] = [];
  for (const l of ex.logs) {
    if (lc(l.address) !== lc(governance)) continue;
    try {
      const d: any = decodeEventLog({ abi: GOVERNANCE_EVENTS_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === "ReceiptApplied") applied.push(d.args);
    } catch { /* another event of the governance contract */ }
  }
  const key = (vs: readonly unknown[], bs: readonly unknown[]) => vs.map((v, i) => `${lc(String(v))}:${String(bs[i])}`).join(",");
  const mine = applied.filter((x) => lc(x.receiptId) === lc(r.receipt_id));
  if (mine.length !== 1) { bad(`${w}: the execute tx has ${mine.length} ReceiptApplied events from the governance contract ${governance} for receipt ${r.receipt_id}, want exactly one: the chain did not apply what the entry records`); return; }
  const x = mine[0]!;
  if (lc(x.payloadDigest) !== lc(r.payload_digest)) bad(`${w}: ReceiptApplied names payload digest ${x.payloadDigest}, the entry records ${r.payload_digest}`);
  if (key(x.vaults, x.bps) !== key(r.vaults, r.bps)) bad(`${w}: ReceiptApplied applied [${key(x.vaults, x.bps)}], the entry records [${key(r.vaults, r.bps)}]: the entry is not the vector the chain applied`);
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
    else if (lc(e.data) !== lc(want)) bad(`${w}: CallScheduled calldata is not clearVotedWeights()`); // the emergency lever: the active (applied receipt) vector is dropped
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
 * Chain check of `vault_redeploys` (issue 1796). Every deploy transaction succeeded. Each entry is ONE timelock batch of seven calls with one operation id: the schedule tx has exactly seven
 * CallScheduled events, index 0 to 6, whose targets and calldata are rebuilt from the recorded vaults and cap (the new vault's setRegistry(registry), registerVault(new),
 * router.setVaultCap(new, router_vault_cap) (QA plan v1 E3), migrateEligibility(new, true, five legs), migrateEligibility(old, false, four legs), retire(old), the new vault's
 * unpauseDeposits()), each with a delay of at least the floor. The execute tx has the seven matching CallExecuted events. The block gap is at least the floor.
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
    if (!ADDR.test(r?.old_vault ?? "") || !ADDR.test(r?.new_vault ?? "") || !ADDR.test(r?.registry ?? "") || !ADDR.test(r?.router ?? "") || !ADDR.test(r?.asset ?? "") || !Array.isArray(r?.vaults) || !Array.isArray(r?.bps) || typeof r?.registry_name !== "string" || !TX.test(r?.schedule_tx ?? "") || !TX.test(r?.execute_tx ?? "")) continue; // the offline check already named it
    // QA plan v1 C2 (issue 1701): new_vault is bound to the chain. One recorded deploy transaction must be the deployer's CREATE of exactly that address.
    const deployReceipts: DeployReceipt[] = [];
    for (const [i, h] of (Array.isArray(r.deploy_tx_hashes) ? r.deploy_tx_hashes : []).entries()) {
      const rc = await status(`${w} deploy tx ${i}`, h);
      deployReceipts.push(rc ? { hash: String(h), status: rc.status, from: rc.from, contractAddress: rc.contractAddress } : { hash: String(h), status: "not readable" });
    }
    // a failed or unreadable receipt is already named above; what is left is the binding itself
    for (const m of createdVaultProblems(r.new_vault, String(r.deployer ?? ""), deployReceipts)) if (!m.includes("receipt status")) bad(`${w}: new_vault ${m}`);
    let want: ReturnType<typeof buildRedeployCalls>;
    try { want = buildRedeployCalls({ registry: r.registry, router: r.router, oldVault: r.old_vault, newVault: r.new_vault, registryName: r.registry_name, asset: r.asset, finalVaults: r.vaults, finalBps: r.bps, vaultCap: r.router_vault_cap }); } catch { continue; } // the offline check already named it
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
    if (executed.length !== want.length || !executed.every((e, i) => lc(e.target) === lc(want[i]!.target) && lc(e.data) === lc(want[i]!.data))) bad(`${w}: the execute tx has no CallExecuted events for the ${want.length} scheduled calls`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

/**
 * Chain check of `committee_registrations` and `recorded_receipts` (issue 1727). A registration is ONE batch: the schedule tx has exactly two CallScheduled events with one operation id,
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
    const w = regLabel(r);
    if (!ADDR.test(r?.submitter ?? "") || !ADDR.test(r?.gateway ?? "") || !ADDR.test(r?.timelock ?? "") || typeof r?.agent_label !== "string" || !/^[0-9]+$/.test(String(r?.valid_until ?? "")) || !TX.test(r?.schedule_tx ?? "")) continue; // the offline check already named it
    const sc = await rcOf(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    const want = buildRegisterCalls(r.gateway, r.timelock, r.submitter, r.agent_label, BigInt(r.valid_until));
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
  for (const r of Array.isArray(ev?.recorded_receipts) ? ev.recorded_receipts : []) {
    if (!TX.test(r?.tx_hash ?? "")) continue;
    const rc = await rcOf(`${recLabel(r)} tx`, r.tx_hash);
    // Issue 1750: a Safe submitter. The Safe itself emitted ExecutionSuccess for the recorded Safe transaction hash, and its threshold on chain is the recorded one.
    const sf = r?.submitter_safe;
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
  /** Runtime code by lower-case address, recorded for the adopted libraries only (issue 1721). Optional: older fixtures have none. */
  codes?: Record<string, string>;
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
  // QA plan v1 E8: the camelCase and quoted JSON key forms too (`privateKey: …`, `"private_key": "…"`), not only `PRIVATE_KEY=…`. A value the logger redacted is not a secret.
  ["secret assignment", /\b(?:(?:PRIVATE[_-]?KEY|MNEMONIC|ETH_PASSWORD|PASSWORD|API[_-]?KEY)"?|TOKEN)\s*[=:]\s*(?!"?\[redacted\])\S{6,}/i],
];

const B32 = "0x[0-9a-fA-F]{64}(?![0-9a-fA-F])";

// ---- hash fields: where a 64-hex value is public (QA plan v1 E8, issue 1689) ----

/** Words of a label or key that name a public hash. `codehash` and `blockhash` are one word in some outputs. */
const PUBLIC_HASH_WORDS = new Set(["tx", "txs", "txn", "hash", "hashes", "codehash", "codehashes", "blockhash", "transaction", "transactions", "block", "salt", "digest", "digests"]);
/** Words of a label or key that name a secret. Any one of them wins over a hash word: `privateKeyHash` exempts nothing. */
const SECRET_WORDS = new Set(["private", "priv", "privkey", "secret", "secrets", "mnemonic", "seed", "password", "passwd", "passphrase", "pass", "pw", "key", "keys", "pk", "sk", "keystore"]);
/** The lower-case words of a key or label: camelCase, snake_case, kebab-case, dotted and `address:function` names are split. */
const nameWords = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const isSecretName = (name: string): boolean => nameWords(name).some((w) => SECRET_WORDS.has(w));
const isHashLabel = (name: string): boolean => !isSecretName(name) && nameWords(name).some((w) => PUBLIC_HASH_WORDS.has(w));

/** A label, then its 0x bytes32 value or an inline list of them: `"txHash": "0x…"`, `"tx_hashes": ["0x…", "0x…"]`, `Hash: 0x…`, `schedule_tx=0x…`. The label starts a word, never the tail of a longer one. */
const LABELLED_B32 = new RegExp(`(?<!\\w)([A-Za-z][\\w.-]*)"?[ \\t]*[:=]?[ \\t]*(?:\\[[ \\t]*)?"?${B32}(?:"[ \\t]*,[ \\t]*"${B32})*`, "g");
/** A pretty-printed JSON line holding one 0x bytes32 value, `"operation_id": "0x…",`. */
const KEYED_B32_LINE = new RegExp(`^\\s*"([^"]*)"\\s*:\\s*"${B32}",?\\s*$`);
/** A pretty-printed JSON line holding one 0x bytes32 list element, `"0x…",`. */
const ELEMENT_B32_LINE = new RegExp(`^\\s*"${B32}",?\\s*$`);
const SHA256_VALUE = "sha256:[0-9a-fA-F]{64}(?![0-9a-fA-F])";
const CONFIG_HASH_KEYS = new Set(["configHashes", "config_hashes"]);
/** The isomorphism report written on one line: the `configHashes` object and its `sha256:` values. */
const INLINE_CONFIG_HASHES = /"(?:configHashes|config_hashes)"\s*:\s*\{[^{}]*\}/g;
/** A pretty-printed `"config/<file>.json": "sha256:<64 hex>",` line. Public only directly under `configHashes` / `config_hashes`. */
const SHA256_LINE = new RegExp(`^\\s*"[^"]*"\\s*:\\s*"${SHA256_VALUE}",?\\s*$`);
/** The frozen counts anchor `crossChecked.fileHash`: the bare sha256 of a committed counts file (src/counts.ts fileHashOf). */
const FILE_HASH_LINE = /^\s*"fileHash"\s*:\s*"[0-9a-f]{64}",?\s*$/;

/** One open container of a pretty-printed JSON file (JSON.stringify(x, null, 2)): its key, if it has one, and whether it is a list. */
export type OpenContainer = { name?: string; list: boolean };

/** Updates the open containers after `line`: a line that starts with `}` or `]` closes one, a `"name": {`, `"name": [`, `{` or `[` line opens one. */
function trackContainers(open: OpenContainer[], line: string): void {
  const t = line.trim();
  if (/^[}\]]/.test(t)) open.pop();
  const m = /^(?:"([^"]*)"\s*:\s*)?([[{])$/.exec(t);
  if (m) open.push({ ...(m[1] !== undefined ? { name: m[1] } : {}), list: m[2] === "[" });
}

/**
 * Removes the 64-hex values of one line that sit in a public hash field, judged value by value, never by the line. `open` is the containers open at the line.
 * 1. a 0x bytes32 right after a label whose words name a public hash (tx, hash, transaction, block, salt, digest);
 * 2. a pretty-printed JSON line that is one 0x bytes32 value of a key, or one element of a named list (`"topics": [`), when that name is not a secret name;
 * 3. `sha256:<64 hex>` directly under `configHashes` / `config_hashes` (the isomorphism report, src/isomorphism.ts), pretty-printed or on one line;
 * 4. the bare sha256 of `crossChecked.fileHash` in a frozen counts file.
 * A label or key that names a secret (private, key, secret, seed, mnemonic, password) never exempts: `"privateKey": "0x…",` stays and is flagged. So does a bare
 * 64-hex anywhere else, and a key beside a tx hash on the same line: a hash word elsewhere on the line no longer skips it.
 */
export function stripHashFields(line: string, open: readonly OpenContainer[] = []): string {
  const top = open[open.length - 1];
  if (FILE_HASH_LINE.test(line) && top?.name === "crossChecked") return line.replace(/[0-9a-f]{64}/, "");
  if (SHA256_LINE.test(line) && top?.name !== undefined && CONFIG_HASH_KEYS.has(top.name)) return line.replace(new RegExp(SHA256_VALUE), "sha256:");
  const value = new RegExp(`"${B32}"(,?\\s*)$`);
  const keyed = KEYED_B32_LINE.exec(line);
  if (keyed && nameWords(keyed[1]!).length > 0 && !isSecretName(keyed[1]!)) return line.replace(value, '"0x"$1');
  if (ELEMENT_B32_LINE.test(line) && top?.list && top.name !== undefined && nameWords(top.name).length > 0 && !isSecretName(top.name)) return line.replace(value, '"0x"$1');
  return line
    .replace(INLINE_CONFIG_HASHES, (m) => m.replace(new RegExp(SHA256_VALUE, "g"), "sha256:"))
    .replace(LABELLED_B32, (m, label: string) => (isHashLabel(label) ? m.replace(new RegExp(B32, "g"), "0x") : m));
}

/** The log events whose operation id is a public timelock operation id (govern.ts, safe/timelock.ts). */
const OPERATION_ID_EVENTS = new Set(["govern.waiting", "timelock.effect"]);

/**
 * Removes the known public 0x bytes32 shapes from one line, so the 64-hex rule sees only what is left. Never a general 64-hex allowance:
 * 1. the row name `apply-receipt-0x<receipt id>` (also a publish-run.json key), anywhere in a line;
 * 2. on a `govern.waiting` or `timelock.effect` JSON log line only: the `"id"`/`"ids"` operation id values and `operation 0x<id>` in the detail text.
 * A bare 0x64-hex, an env or keystore shaped value, or the same shapes on any other line stay in the line and are flagged.
 */
export function stripPublicContexts(line: string): string {
  let out = line.replace(new RegExp(`apply-receipt-${B32}`, "g"), "apply-receipt-");
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

/**
 * Scan one evidence folder for secrets. Transaction hashes, codehashes, salts and digests are 64-hex by design: each value is allowed only in a hash field
 * (stripHashFields), never because its line names a hash word somewhere (QA plan v1 E8, issue 1689). `strip` is the public-context allowance (a test swaps it
 * to prove widening it is caught).
 */
export function scanEvidenceFolder(dir: string, strip: (line: string) => string = stripPublicContexts): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      const text = readFileSync(f, "utf8");
      const open: OpenContainer[] = [];
      text.split("\n").forEach((line, i) => {
        const rest = stripHashFields(strip(line), open);
        trackContainers(open, line);
        for (const [name, re] of SECRET_PATTERNS) {
          if (re.test(name.startsWith("64-hex") ? rest : line)) hits.push(`${f}:${i + 1}: ${name}`);
        }
      });
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
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
    ...(kind === "rehearsal" ? { committee_registrations: m.committee_registrations, recorded_receipts: m.recorded_receipts } : {}) };
  const floor = typeof values["delay-floor"] === "string" ? Number(values["delay-floor"]) : delayFloor(MAINNET_CHAIN_ID, kind);
  if (!Number.isInteger(floor) || floor < 1) { console.error("evidence: --delay-floor must be a positive number of seconds"); process.exit(2); }
  const problems = [...(Array.isArray(m.receipt_applications) && m.receipt_applications.length > 0 ? [] : ["the run manifest has no receipt_applications entry"]), ...checkReceiptApplications(ev, floor), ...checkVotedWeightsClears(ev, floor)];
  // issue 1727: a rehearsal's receipt path (registration, REAL recorded receipt, application) must trace end to end. A production run manifest has none of the first two.
  if (kind === "rehearsal") {
    receiptPathProblems(ev, kind, Array.isArray(m.receipt_applications) ? m.receipt_applications : [], (x) => problems.push(x));
    operationProblems((Array.isArray(m.committee_registrations) ? m.committee_registrations : []).map((r: any) => ({ ...r, step: regLabel(r) })), (x) => problems.push(x), floor);
  }
  if (typeof values.rpc === "string") {
    const { createPublicClient, http } = await import("viem");
    const reader = createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader;
    await refuseDelayFloorOnMainnet(reader, floor, kind);
    problems.push(...(await checkReceiptApplicationsOnChain(ev, reader, floor)));
    problems.push(...(await checkVotedWeightsClearsOnChain(ev, reader, floor)));
    if (kind === "rehearsal") problems.push(...(await checkReceiptPathOnChain(ev, reader, floor)));
  }
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (${m.receipt_applications.length} receipt application(s)${values.rpc ? ", chain read" : ", offline shape only"})`);
}

/**
 * Issue 1701: `--delay-floor` lowers the floor for a Twin run, whose timelock is shorter. Read against chain 8453 it is refused below the 8453 floor of the deployment
 * kind (172800 s production, the rehearsal floor for a rehearsal): it would accept a schedule-to-execute gap that no 8453 timelock of that kind allows. Undefined: accepted.
 */
export function delayFloorRefusal(floor: number, rpcChainId: number, kind: DeploymentKind): string | undefined {
  if (rpcChainId !== MAINNET_CHAIN_ID) return undefined;
  const min = delayFloor(MAINNET_CHAIN_ID, kind);
  return floor < min ? `--delay-floor ${floor} is below ${min} s, the ${kind} delay floor of chain 8453 that the --rpc reads: a shorter floor is for a Twin run only` : undefined;
}
/** Reads the --rpc chain id and exits 2 when `delayFloorRefusal` refuses the floor. */
async function refuseDelayFloorOnMainnet(reader: ChainReader, floor: number, kind: DeploymentKind): Promise<void> {
  const why = delayFloorRefusal(floor, await reader.getChainId(), kind);
  if (why) { console.error(`evidence: ${why}`); process.exit(2); }
}

/**
 * `--vault-redeploys RUN_MANIFEST --registry ADDR --timelock ADDR` (issue 1796): checks the `vault_redeploys` entries a `redeploy-vault` run wrote to its run manifest (shape, the delay
 * floor, then with --rpc the seven-call batch on the timelock). A rehearsal check only: a Twin run or a Base mainnet rehearsal proves the round executes on the real contracts.
 */
async function checkRedeploysMain(values: Record<string, string | boolean | undefined>, kind: DeploymentKind): Promise<void> {
  const need = ["registry", "timelock"].filter((k) => typeof values[k] !== "string");
  if (need.length) { console.error(`evidence: --vault-redeploys needs ${need.map((k) => `--${k}`).join(", ")}`); process.exit(2); }
  const m = JSON.parse(readFileSync(values["vault-redeploys"] as string, "utf8"));
  const entries: any[] = Array.isArray(m.vault_redeploys) ? m.vault_redeploys : [];
  const ev = { deployment_kind: kind, registry: { address: values.registry }, timelock: { address: values.timelock }, vault_redeploys: entries, vaults: Object.fromEntries(entries.map((r) => [r?.vault, { address: r?.new_vault }])) };
  const floor = typeof values["delay-floor"] === "string" ? Number(values["delay-floor"]) : delayFloor(MAINNET_CHAIN_ID, kind);
  if (!Number.isInteger(floor) || floor < 1) { console.error("evidence: --delay-floor must be a positive number of seconds"); process.exit(2); }
  const problems = [...(entries.length > 0 ? [] : ["the run manifest has no vault_redeploys entry"]), ...entries.filter((r) => r?.status !== "governed").map((r) => `${redeployLabel(r)}: status is ${String(r?.status)}, want governed`), ...checkVaultRedeploys(ev, floor, kind)];
  if (typeof values.rpc === "string") {
    const { createPublicClient, http } = await import("viem");
    const reader = createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader;
    await refuseDelayFloorOnMainnet(reader, floor, kind);
    problems.push(...(await checkVaultRedeploysOnChain(ev, reader, floor)));
  }
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (${entries.length} vault redeploy entr${entries.length === 1 ? "y" : "ies"}${values.rpc ? ", chain read" : ", offline shape only"})`);
}

/** The per-stage cap from core's stage table in this checkout. */
function adoptableFromTable(): AdoptableLibraries {
  const t = loadStageTable(new URL("../../", import.meta.url).pathname);
  return Object.fromEntries(t.stages.map((st) => [st.name, st.name === LIBS_STAGE ? t.libraries.length : (st.create2Libraries ?? []).length]));
}

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, "receipt-applications": { type: "string" }, "delay-floor": { type: "string" }, "deployment-kind": { type: "string" }, "consensus-receipt": { type: "string" }, governance: { type: "string" }, timelock: { type: "string" }, frozen: { type: "string" }, "deploy-sha": { type: "string" }, rpc: { type: "string" }, "chain-fixture": { type: "string" }, "record-chain-fixture": { type: "string" }, "vault-redeploys": { type: "string" }, registry: { type: "string" } } });
  const kindArg = values["deployment-kind"] ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(kindArg)) { console.error(`evidence: --deployment-kind must be ${DEPLOYMENT_KINDS.join(" or ")}`); process.exit(2); }
  const kind = kindArg as DeploymentKind;
  if (values["receipt-applications"]) return checkApplicationsMain(values, kind);
  if (values["vault-redeploys"]) return checkRedeploysMain(values, kind);
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
