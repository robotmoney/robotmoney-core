// Deploy 4 (owner exception 2026-11-12): the evidence of a fund system run, checked on its own. A fund evidence names `system: "fund"` and carries the fund run's stages (safe,
// the fund-system stages, the one prove-control transaction outside every count), its own Safe and timelock, the four proxies with their implementations and upgrade authority,
// the keeper and the verifier's exit. It carries nothing of the vaults or gateway systems: their stages and keys are refused here, and checkEvidence refuses the fund stages in a
// vaults evidence in turn.
import { MAINNET_CHAIN_ID, MAINNET_DELAY_FLOOR } from "./floors.ts";
import { DEPLOYMENT_KINDS, rehearsalDelayProblem, type DeploymentKind } from "./chains.ts";
import { GATEWAY_EVIDENCE_STAGES } from "./evidence-gateway.ts";

const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
const lc = (s: unknown): string => String(s ?? "").toLowerCase();

/** The deployer stages of a fund run, in order: the Safe, then the table's fund stages (the caller passes the table's list; this is the default of the offline check). */
export const FUND_EVIDENCE_STAGES: readonly string[] = ["safe", "fund-libs", "fund-receipt", "fund", "rebalancer", "fund-governance", "queue", "fund-wiring", "fund-timelock"];
/** The fund-system proxies the evidence names, each with its proxy, implementation and upgrade timelock. */
export const FUND_EVIDENCE_PROXIES = ["fund", "rebalancer", "governance", "queue", "consensus_receipt"] as const;
/** Evidence keys of the vaults and gateway systems a fund evidence never carries. */
export const NOT_FUND_KEYS = ["registry", "router", "vaults", "gateway", "vaults_system", "agents_at_handover", "committee_registrations", "receipt_releases"] as const;
/** The deployer transactions outside every stage count: the one prove-control transaction (core 1712). */
const PROOF_TXS = 1;

export interface FundEvidenceOpts { kind?: DeploymentKind; stages?: readonly string[] }

export function checkFundEvidence(ev: any, frozenCounts?: Record<string, number>, opts: FundEvidenceOpts = {}): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const want = opts.stages ?? FUND_EVIDENCE_STAGES;
  const kind = opts.kind ?? "production";
  const claimed = ev?.deployment_kind ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(claimed)) bad(`deployment_kind '${String(claimed)}' is not ${DEPLOYMENT_KINDS.join(" or ")}`);
  else if (claimed !== kind) bad(`deployment_kind is ${claimed}, the evidence is checked as ${kind}`);
  if (ev?.system !== "fund") bad(`system is ${String(ev?.system)}, a fund evidence says "fund"`);
  if (ev?.chain_id !== MAINNET_CHAIN_ID) bad(`chain_id is ${ev?.chain_id}, evidence is read for ${MAINNET_CHAIN_ID}`);
  if (!/^[0-9a-f]{40}$/.test(ev?.core_sha ?? "") || /^0+$/.test(ev.core_sha)) bad("core_sha is missing or a placeholder");
  for (const k of NOT_FUND_KEYS) if (ev?.[k] !== undefined) bad(`'${k}' belongs to the vaults or gateway system's evidence: a fund evidence carries none of it`);

  const stages: any[] = Array.isArray(ev?.stages) ? ev.stages : [];
  const names = stages.map((s) => s?.stage);
  if (JSON.stringify(names) !== JSON.stringify(want)) bad(`stages are [${names.join(", ")}], the fund system runs [${want.join(", ")}] in that order`);
  for (const s of stages) {
    const hashes: unknown[] = Array.isArray(s?.tx_hashes) ? s.tx_hashes : [];
    const st: unknown[] = Array.isArray(s?.receipts_status) ? s.receipts_status : [];
    if (s?.frozen_count !== s?.receipt_count) bad(`stage ${s?.stage}: frozen_count ${s?.frozen_count} differs from receipt_count ${s?.receipt_count}`);
    if (frozenCounts && s?.stage in frozenCounts && frozenCounts[s.stage] !== s.receipt_count) bad(`stage ${s.stage}: receipt_count ${s.receipt_count} differs from the frozen file (${frozenCounts[s.stage]})`);
    if (frozenCounts && !(s?.stage in frozenCounts)) bad(`stage ${s?.stage}: the frozen file has no count for it`);
    if (hashes.length !== s?.receipt_count) bad(`stage ${s?.stage}: ${hashes.length} tx hashes for ${s?.receipt_count} receipts`);
    hashes.forEach((h, i) => { if (typeof h !== "string" || !TX.test(h)) bad(`stage ${s?.stage}: tx hash ${i} is missing or malformed`); });
    if (st.length !== hashes.length) bad(`stage ${s?.stage}: ${st.length} receipt statuses for ${hashes.length} tx hashes`);
    st.forEach((x, i) => { if (x !== 1) bad(`stage ${s?.stage}: receipt ${i} status is ${x}, not 1`); });
  }

  // the Safe and the timelock: the fund system's own, the Safe the only proposer, the delay of the kind
  const safe = ev?.safe, tl = ev?.timelock;
  if (!ADDR.test(safe?.address ?? "") || ZERO.test(safe?.address ?? "")) bad("safe.address is not an address");
  if (!Array.isArray(safe?.owners) || safe.owners.length < 3 || !safe.owners.every((o: unknown) => ADDR.test(String(o)))) bad("safe.owners is not a list of at least 3 addresses");
  else if (!(Number.isInteger(safe?.threshold) && safe.threshold >= 2 && safe.threshold <= safe.owners.length - 1)) bad(`safe.threshold ${String(safe?.threshold)} is not 2 to ${safe.owners.length - 1}`);
  if (!ADDR.test(tl?.address ?? "") || ZERO.test(tl?.address ?? "")) bad("timelock.address is not an address");
  if (lc(tl?.proposer) !== lc(safe?.address)) bad("timelock.proposer is not the fund system's Safe");
  if (!Number.isInteger(tl?.min_delay)) bad("timelock.min_delay is missing");
  else if (kind === "rehearsal") { const why = rehearsalDelayProblem(BigInt(tl.min_delay)); if (why) bad(`timelock.min_delay ${why}`); }
  else if (tl.min_delay < MAINNET_DELAY_FLOOR) bad(`timelock.min_delay ${tl.min_delay} is under the ${MAINNET_DELAY_FLOOR} s production floor`);
  if (!TX.test(ev?.control_proof?.tx_hash ?? "")) bad("control_proof.tx_hash is missing: the Safe signs once before the handover (core 1618)");

  // the proxies: each names the fund-system timelock and a release mode
  for (const k of FUND_EVIDENCE_PROXIES) {
    const x = ev?.proxies?.[k];
    for (const f of ["address", "implementation", "upgrade_timelock"] as const) if (!ADDR.test(x?.[f] ?? "") || ZERO.test(x?.[f] ?? "")) bad(`proxies.${k}.${f} is not an address`);
    if (ADDR.test(x?.upgrade_timelock ?? "") && lc(x.upgrade_timelock) !== lc(tl?.address)) bad(`proxies.${k}.upgrade_timelock is not the fund system's timelock`);
    if (x?.upgrade_mode !== "upgradeable" && x?.upgrade_mode !== "frozen") bad(`proxies.${k}.upgrade_mode '${String(x?.upgrade_mode)}' is not upgradeable or frozen`);
  }

  // the operational keys: distinct, none of them the deployer
  const D = ev?.deployer;
  if (!ADDR.test(D ?? "")) bad("deployer address is missing");
  for (const k of ["keeper", "emergency"] as const) {
    if (!ADDR.test(ev?.[k] ?? "") || ZERO.test(ev?.[k] ?? "")) bad(`${k} is not an address`);
    else if (lc(ev[k]) === lc(D)) bad(`${k} is the deployer: the fund system's ${k} is its own key`);
  }
  if (ADDR.test(ev?.keeper ?? "") && lc(ev.keeper) === lc(ev?.emergency)) bad("keeper and emergency are the same key");
  if (ev?.verifier?.exit_code !== 0) bad("the verifier did not exit 0");

  // the deployer nonce at the handover: the start, every stage's frozen count and the one prove-control transaction
  if (!Number.isInteger(ev?.deployer_start_nonce) || ev.deployer_start_nonce < 0) bad("deployer_start_nonce is missing");
  if (!Number.isInteger(ev?.deployer_nonce_at_handover)) bad("deployer_nonce_at_handover is missing");
  else if (frozenCounts && Number.isInteger(ev?.deployer_start_nonce)) {
    const sum = want.reduce((a, s) => a + (frozenCounts[s] ?? 0), 0);
    if (ev.deployer_nonce_at_handover !== ev.deployer_start_nonce + sum + PROOF_TXS) bad(`deployer_nonce_at_handover ${ev.deployer_nonce_at_handover} differs from the start nonce ${ev.deployer_start_nonce} plus the fund frozen counts ${sum} plus the control proof`);
  }
  return p;
}

/** A vaults or gateway evidence never carries a fund stage (checkEvidence calls this for every non-fund evidence). */
export function fundStagesIn(ev: any): string[] {
  const fundOnly = FUND_EVIDENCE_STAGES.filter((s) => s !== "safe" && !GATEWAY_EVIDENCE_STAGES.includes(s));
  return (Array.isArray(ev?.stages) ? ev.stages : []).map((s: any) => s?.stage).filter((s: string) => fundOnly.includes(s));
}
