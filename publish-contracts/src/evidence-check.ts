#!/usr/bin/env bun
// Evidence check for a mainnet run. Reads evidence/<run-id>/evidence.json (template: publish-contracts/evidence.example.json).
// Usage: bun src/evidence-check.ts --receipt-applications RUN_MANIFEST --consensus-receipt ADDR --governance ADDR --timelock ADDR [--delay-floor SECONDS] [--rpc URL]   (a Twin run; the floor defaults to the 8453 floor, a Twin run passes its own timelock min delay, issue 1696)
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
import { decodeEventLog, encodeFunctionData, parseAbi, type Hex } from "viem";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MAINNET_CHAIN_ID, MAINNET_DELAY_FLOOR, delayFloor, rehearsalDelayProblem } from "./floors.ts";
import { DEPLOYMENT_KINDS, kindLabel, type DeploymentKind } from "./chains.ts";
import { REGISTER_ROW, buildRegisterCalls } from "./committee-register.ts";
import { assertOwnerExceptions } from "./plan.ts";
import { finalDeployerNonce } from "./counts.ts";

const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * Stage 13 on 8453 (issue 1520): the only operation after the timelock handover is the unpause of each of the four vaults (rmUSDC too since issue 1710: all four deploy paused). One govern entry per vault, each with
 * its own schedule transaction, its own execute transaction and its own timelock operation (never a shared one). All are scheduled in one sitting and wait
 * one delay: each execute is at least 172800 s after the same operation's schedule. update-delay, batch and cancel are Twin-only demonstrations of the
 * Safe tool: on 8453 they are rejected here. The names are the unpause rows of the govern CLI (src/govern.ts UNPAUSE_ROWS).
 */
export const BASKETS = ["PROTO", "AGENT", "RWA"] as const;
export const VAULTS = ["USDC", ...BASKETS] as const;
export const GOVERN_STEPS: readonly string[] = VAULTS.map((b) => `unpause-${b}`);

/**
 * Issue 1667: a vault the tool paused (pause-all, any of the four) comes back through a Safe -> Timelock unpause round. Every unpause step is required (round 1,
 * stage 13) and may repeat as a numbered ROUND (`round`, default 1): a vault paused again after an executed unpause has a second round with its own schedule, execute
 * and operation id. The one call on any vault the evidence accepts is unpauseDeposits().
 */
export const USDC_STEP = "unpause-USDC";
export const UNPAUSE_STEPS: readonly string[] = GOVERN_STEPS;
const VAULT_OF_STEP: Record<string, string> = { "unpause-USDC": "rmUSDC", "unpause-PROTO": "rmPROTO", "unpause-AGENT": "rmAGENT", "unpause-RWA": "rmRWA" };
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
 * A post-launch receipt application (issue 1696, `govern --row apply-receipt`), recorded under `receipt_applications` (never in `govern`, so stage 13 stays the
 * four unpauses). One entry per receipt: ONE timelock batch of exactly two calls, releaseReceipt(receipt_id) on the receipt contract (`consensus_receipt.address`)
 * then setDefaultWeights(vaults, bps) on the governance contract (`governance.address`), one schedule and one execute at least MAINNET_DELAY_FLOOR apart.
 * The Twin run writes the same entries into the run manifest and `--receipt-applications` checks them (a Twin run proves execution only, not mainnet governance).
 */
const APPLY_WEIGHTS_ABI = parseAbi(["function setDefaultWeights(address[] vaults, uint256[] bps)"]);
export const applyCalldata = (receiptId: string, vaults: string[], bps: number[]): [Hex, Hex] => [
  releaseCalldata(receiptId),
  encodeFunctionData({ abi: APPLY_WEIGHTS_ABI, functionName: "setDefaultWeights", args: [vaults as Hex[], bps.map(BigInt)] }),
];
const applyLabel = (r: any) => `apply-receipt ${r?.receipt_id}`;

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
    if (g.cancelled === true) continue; // a cancelled operation never executes: there is no gap to check (rehearsal cancel row)
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
    if (lc(r?.target ?? "") !== lc(ev?.consensus_receipt?.address ?? "")) bad(`${w}: target ${r?.target} is not the receipt contract ${ev?.consensus_receipt?.address}`);
    if (lc(r?.governance ?? "") !== lc(ev?.governance?.address ?? "")) bad(`${w}: governance ${r?.governance} is not the governance contract ${ev?.governance?.address}`);
    const vaults: unknown[] = Array.isArray(r?.vaults) ? r.vaults : [];
    const bps: unknown[] = Array.isArray(r?.bps) ? r.bps : [];
    if (vaults.length === 0 || vaults.length !== bps.length || !vaults.every((v) => typeof v === "string" && ADDR.test(v)) || new Set(vaults.map((v) => lc(String(v)))).size !== vaults.length) bad(`${w}: vaults and bps are not a list of distinct addresses with one weight each`);
    else if (!bps.every((x) => Number.isInteger(x) && (x as number) >= 0) || (bps as number[]).reduce((t, x) => t + x, 0) !== 10000) bad(`${w}: bps do not sum to 10000`);
    if (releasedIds(ev).has(lc(r?.receipt_id ?? ""))) bad(`${w}: the receipt is also under receipt_releases: a receipt is released once`);
  }
  return apps;
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
 * Issue 1727, the receipt path of a rehearsal. `committee_registrations`: one entry per submitter, ONE timelock batch (authorizeAgent, committeeRegister), one schedule and one execute at
 * least the floor apart. `recorded_receipts`: one entry per receipt the submitter anchored through the gateway (receipt_id, payload_digest, payload_uri, submitter ADDRESS, tx_hash; never a key).
 * Both are refused in a production evidence. In a rehearsal every receipt_applications entry must trace to a recorded receipt with the same digest, by a registered submitter.
 */
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
    if (typeof r?.agent_label !== "string" || r.agent_label === "") bad(`${w}: agent_label is missing`);
    if (!/^[0-9]+$/.test(String(r?.valid_until ?? ""))) bad(`${w}: valid_until is not a decimal timestamp`);
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
const rowOperations = (rows: any[]): any[] => rows.map((r) => ({ ...(r.step === "cancel" ? { ...r, execute_tx: r.cancel_tx, execute_status: r.cancel_status, cancelled: true } : r), step: rowLabel(r) }));

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

export function checkEvidence(ev: any, frozenCounts?: Record<string, number>, opts?: EvidenceOpts): string[] {
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
    if (s.frozen_count !== s.receipt_count) bad(`stage ${s.stage}: frozen_count ${s.frozen_count} differs from receipt_count ${s.receipt_count}`);
    if (frozenCounts && s.stage in frozenCounts && frozenCounts[s.stage] !== s.receipt_count) bad(`stage ${s.stage}: receipt_count ${s.receipt_count} differs from the frozen file (${frozenCounts[s.stage]})`);
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
  for (const k of ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA"]) if (!ADDR.test(ev?.vaults?.[k]?.address ?? "")) bad(`vault ${k} address is missing`);

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
  // one operation per unpause, release or application: no schedule or execute transaction, and no timelock operation id, is shared by two operations
  const rrows = rehearsalRowProblems(ev, kind, bad);
  const regs = receiptPathProblems(ev, kind, applications, bad);
  operationProblems([...govern.map((g) => ({ ...g, step: stepLabel(g) })), ...releases.map((r) => ({ ...r, step: releaseLabel(r) })), ...applications.map((r) => ({ ...r, step: applyLabel(r) })), ...rowOperations(rrows), ...registrationOperations(regs)], bad, floor);
  if (!ADDR.test(ev?.deployer ?? "")) bad("deployer address is missing");
  if (!ADDR.test(ev?.registry?.address ?? "")) bad("registry address is missing");
  if (!Number.isInteger(ev?.deployer_nonce_final)) bad("deployer_nonce_final is missing");
  const start = startNonceOf(ev, kind, bad);
  if (frozenCounts && ev?.deployer_nonce_final !== finalDeployerNonce(frozenCounts, start)) bad(`deployer_nonce_final ${ev?.deployer_nonce_final} differs from ${start ? `the start nonce ${start} plus ` : ""}the summed frozen counts plus the prove-control transaction ${finalDeployerNonce(frozenCounts, start)}`);
  if (ev?.verifier?.exit_code !== 0) bad("the verifier did not exit 0");
  if (ev?.verifier?.registry_list_vaults_equals_manifests !== true) bad("registry listVaults was not shown equal to the manifests");
  if (ev?.sources?.blockscout_all_verified !== true || ev?.sources?.sourcify_all_exact !== true) bad("source verification is not complete");
  return p;
}

/** The slice of a viem PublicClient this check uses. A stub implements it in unit tests. */
export interface ChainReader {
  getChainId(): Promise<number>;
  getTransactionCount(a: { address: `0x${string}` }): Promise<number>;
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] }>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
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
  const want = finalDeployerNonce(frozenCounts, startNonceOf(ev, kind, bad));
  const nonce = await chain.getTransactionCount({ address: ev.deployer });
  if (nonce !== want) bad(`deployer nonce on chain is ${nonce}, the summed frozen counts plus the prove-control transaction say ${want}`);

  const status = async (what: string, hash: string) => {
    try {
      const rc = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (rc.status !== "success") bad(`${what}: receipt on chain is ${rc.status}`);
      return rc;
    } catch (e) { bad(`${what}: receipt not readable on chain (${(e as Error).message})`); return undefined; }
  };
  for (const s of ev.stages ?? []) for (const [i, h] of (s.tx_hashes ?? []).entries()) await status(`stage ${s.stage} tx ${i}`, h);
  if (ev.safe?.creation_tx) await status("safe creation", ev.safe.creation_tx);

  try {
    const listed = ((await chain.readContract({ address: ev.registry.address, abi: REGISTRY_ABI, functionName: "listVaults" })) as string[]).map(lc).sort();
    const recorded = Object.values(ev.vaults ?? {}).map((v: any) => lc(v?.address ?? "")).sort();
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
      if (!vaultAddr || lc(e.target) !== lc(vaultAddr)) bad(`govern ${g.step}: CallScheduled target ${e.target} is not ${VAULT_OF_STEP[g0.step]} ${vaultAddr}`);
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
  if (kind === "rehearsal") { p.push(...(await checkRehearsalRowsOnChain(ev, chain, FLOOR))); p.push(...(await checkReceiptPathOnChain(ev, chain, FLOOR))); }
  // The unpause govern rows and the depositsPaused() reads must tell one story: a vault is unpaused on chain exactly when its LATEST unpause round executed
  // (all four vaults deploy paused, issue 1710).
  for (const b of VAULTS) {
    const rows = (ev.govern ?? []).filter((g: any) => g?.step === `unpause-${b}`).sort((x: any, y: any) => roundOf(x) - roundOf(y));
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
 * Chain check of `receipt_applications` (issue 1696). Each entry is ONE timelock batch: the schedule tx has exactly two CallScheduled events with one operation
 * id (the recorded operation_id), index 0 releaseReceipt(receipt_id) on the receipt contract, index 1 setDefaultWeights(vaults, bps) on the governance contract,
 * each with a delay of at least MAINNET_DELAY_FLOOR. The execute tx has the two matching CallExecuted events. The block gap is at least MAINNET_DELAY_FLOOR.
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
    const sc = await status(`${w} schedule`, r.schedule_tx);
    if (!sc) continue;
    const scheduled = timelockEvents(sc, ev.timelock.address, "CallScheduled").sort((x, y) => Number(x.index - y.index));
    if (scheduled.length === 0) { bad(`${w}: the schedule tx has no CallScheduled event from the timelock`); continue; }
    const [relData, wData] = applyCalldata(r.receipt_id, r.vaults, r.bps);
    const wantCalls = [{ target: ev.consensus_receipt.address as string, data: relData, what: `releaseReceipt(${r.receipt_id})` }, { target: ev.governance.address as string, data: wData, what: "setDefaultWeights(vaults, bps) of the recorded vector" }];
    if (scheduled.length !== wantCalls.length) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, an application is exactly ${wantCalls.length} calls (release, then weights) in one batch`);
    scheduled.forEach((e, i) => {
      const want = wantCalls[i];
      if (want === undefined) { bad(`${w}: CallScheduled call ${i} is not part of an application`); return; }
      if (lc(e.target) !== lc(want.target)) bad(`${w}: CallScheduled call ${i} target ${e.target} is not ${want.target}`);
      else if (lc(e.data) !== lc(want.data)) bad(`${w}: CallScheduled call ${i} calldata is not ${want.what}`);
      if (e.index !== BigInt(i)) bad(`${w}: CallScheduled call ${i} has batch index ${e.index}`);
      if (!(e.delay !== undefined && e.delay >= BigInt(floor))) bad(`${w}: CallScheduled delay ${e.delay} is under ${floor} s`);
      if (lc(e.id) !== lc(scheduled[0]!.id)) bad(`${w}: the batch calls are not one operation (${e.id} and ${scheduled[0]!.id})`);
    });
    if (typeof r.operation_id === "string" && lc(r.operation_id) !== lc(scheduled[0]!.id)) bad(`${w}: operation_id ${r.operation_id} is not the scheduled operation ${scheduled[0]!.id}`);
    const schedTs = await ts(sc);
    const ex = await status(`${w} execute`, r.execute_tx);
    if (!ex) continue;
    const executed = timelockEvents(ex, ev.timelock.address, "CallExecuted").filter((e) => lc(e.id) === lc(scheduled[0]!.id)).sort((x, y) => Number(x.index - y.index));
    if (executed.length !== wantCalls.length || !executed.every((e, i) => lc(e.target) === lc(wantCalls[i]!.target) && lc(e.data) === lc(wantCalls[i]!.data))) bad(`${w}: the execute tx has no CallExecuted events for the scheduled release and weight change`);
    const gap = (await ts(ex)) - schedTs;
    if (!(gap >= floor)) bad(`${w}: on-chain schedule-to-execute gap ${gap} s is under ${floor} s`);
  }
  return p;
}

/**
 * Chain check of `committee_registrations` and `recorded_receipts` (issue 1727). A registration is ONE batch: the schedule tx has exactly two CallScheduled events with one operation id,
 * authorizeAgent then committeeRegister on the gateway with the calldata rebuilt from the recorded submitter, label and validUntil; the execute tx has the two CallExecuted events;
 * the block gap is at least the floor. A recorded receipt's transaction must have succeeded.
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
    if (scheduled.length !== want.length) bad(`${w}: the schedule tx has ${scheduled.length} CallScheduled events, a registration is exactly ${want.length} calls (authorizeAgent, committeeRegister) in one batch`);
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
    const schedTs = await ts(sc);
    const ex = await rcOf(`${w} execute`, r.execute_tx);
    if (!ex || !scheduled[0]) continue;
    const executed = timelockEvents(ex, ev.timelock.address, "CallExecuted").filter((e) => lc(e.id) === lc(scheduled[0]!.id));
    if (executed.length !== want.length) bad(`${w}: the execute tx has ${executed.length} CallExecuted events for the scheduled id, want ${want.length}`);
    if (!((await ts(ex)) - schedTs >= floor)) bad(`${w}: on-chain schedule-to-execute gap is under ${floor} s`);
  }
  for (const r of Array.isArray(ev?.recorded_receipts) ? ev.recorded_receipts : []) {
    if (TX.test(r?.tx_hash ?? "")) await rcOf(`${recLabel(r)} tx`, r.tx_hash);
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
  receipts: { hash: string; status: "success" | "reverted"; blockNumber: string; logs: { address: string; topics: Hex[]; data: Hex }[] }[];
  blocks: Record<string, number>;
  reads: Record<string, unknown>;
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
      return { status: r.status, blockNumber: BigInt(r.blockNumber), logs: r.logs };
    },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(fx.blocks[blockNumber.toString()] ?? miss(`block ${blockNumber}`)) }),
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
      fixture.receipts.push({ hash: lc(a.hash), status: r.status, blockNumber: r.blockNumber.toString(), logs: r.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })) });
      return r;
    },
    getBlock: async (a) => {
      const b = await inner.getBlock(a);
      fixture.blocks[a.blockNumber.toString()] = Number(b.timestamp);
      return b;
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
  ["secret assignment", /\b(PRIVATE_KEY|MNEMONIC|ETH_PASSWORD|PASSWORD|API_KEY|TOKEN)\s*[=:]\s*\S{6,}/i],
];

/** Scan one evidence folder for secrets. Transaction hashes are 64-hex by design: they are allowed in the fields that name a tx. */
export function scanEvidenceFolder(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) { walk(f); continue; }
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, i) => {
        for (const [name, re] of SECRET_PATTERNS) {
          if (name.startsWith("64-hex") && /(tx|hash|transaction|block|codehash|salt|digest|sha|0x[0-9a-fA-F]{64}",?\s*$)/i.test(line)) continue;
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${name}`);
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
  const ev = { deployment_kind: kind, consensus_receipt: { address: values["consensus-receipt"] }, governance: { address: values.governance }, timelock: { address: values.timelock }, receipt_applications: m.receipt_applications,
    ...(kind === "rehearsal" ? { committee_registrations: m.committee_registrations, recorded_receipts: m.recorded_receipts } : {}) };
  const floor = typeof values["delay-floor"] === "string" ? Number(values["delay-floor"]) : delayFloor(MAINNET_CHAIN_ID, kind);
  if (!Number.isInteger(floor) || floor < 1) { console.error("evidence: --delay-floor must be a positive number of seconds"); process.exit(2); }
  const problems = [...(Array.isArray(m.receipt_applications) && m.receipt_applications.length > 0 ? [] : ["the run manifest has no receipt_applications entry"]), ...checkReceiptApplications(ev, floor)];
  // issue 1727: a rehearsal's receipt path (registration, REAL recorded receipt, application) must trace end to end. A production run manifest has none of the first two.
  if (kind === "rehearsal") {
    receiptPathProblems(ev, kind, Array.isArray(m.receipt_applications) ? m.receipt_applications : [], (x) => problems.push(x));
    operationProblems((Array.isArray(m.committee_registrations) ? m.committee_registrations : []).map((r: any) => ({ ...r, step: regLabel(r) })), (x) => problems.push(x), floor);
  }
  if (typeof values.rpc === "string") {
    const { createPublicClient, http } = await import("viem");
    const reader = createPublicClient({ transport: http(values.rpc) }) as unknown as ChainReader;
    problems.push(...(await checkReceiptApplicationsOnChain(ev, reader, floor)));
    if (kind === "rehearsal") problems.push(...(await checkReceiptPathOnChain(ev, reader, floor)));
  }
  if (problems.length) { for (const x of problems) console.error(`evidence: ${x}`); process.exit(1); }
  console.log(`evidence ok (${m.receipt_applications.length} receipt application(s)${values.rpc ? ", chain read" : ", offline shape only"})`);
}

async function main() {
  const { values } = parseArgs({ options: { evidence: { type: "string" }, "receipt-applications": { type: "string" }, "delay-floor": { type: "string" }, "deployment-kind": { type: "string" }, "consensus-receipt": { type: "string" }, governance: { type: "string" }, timelock: { type: "string" }, frozen: { type: "string" }, "deploy-sha": { type: "string" }, rpc: { type: "string" }, "chain-fixture": { type: "string" }, "record-chain-fixture": { type: "string" } } });
  const kindArg = values["deployment-kind"] ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(kindArg)) { console.error(`evidence: --deployment-kind must be ${DEPLOYMENT_KINDS.join(" or ")}`); process.exit(2); }
  const kind = kindArg as DeploymentKind;
  if (values["receipt-applications"]) return checkApplicationsMain(values, kind);
  if (!values.evidence) { console.error("missing --evidence FILE"); process.exit(2); }
  const ev = JSON.parse(readFileSync(values.evidence, "utf8"));
  let counts: Record<string, number> | undefined;
  if (values.frozen) {
    const j = JSON.parse(readFileSync(values.frozen, "utf8"));
    if (values["deploy-sha"] && j.deploySha !== values["deploy-sha"]) { console.error(`evidence: frozen file is for ${j.deploySha}, not ${values["deploy-sha"]}`); process.exit(1); }
    counts = j.counts ?? j;
  }
  const problems = [...checkEvidence(ev, counts, { kind }), ...scanEvidenceFolder(join(values.evidence, ".."))];
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
