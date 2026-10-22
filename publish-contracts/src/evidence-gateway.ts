// The evidence of a gateway system run (issue 1892), checked on its own. A gateway evidence names `system: "gateway"` and carries the gateway run's two stages, the gateway and its
// handover, the explicit upgrade authority and the explicitly configured admin, the vaults system addresses it consumed, and the chain-backed "no agent at handover" result.
// It carries no Safe, no timelock of the vaults system, no govern entry and no receipt: those belong to the vaults system's evidence and are refused here. A vaults evidence
// (system absent or "vaults") is checked by checkEvidence in evidence-check.ts, which refuses the gateway stages in turn. The production gateway authority is an open decision
// (architecture 10): this check requires it to be named (nonzero) and never supplies one.
import { MAINNET_CHAIN_ID } from "./floors.ts";
import { DEPLOYMENT_KINDS, type DeploymentKind } from "./chains.ts";

const TX = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
const lc = (s: unknown): string => String(s ?? "").toLowerCase();

/** The stages of the gateway system, in order. The caller passes the table's list; this is the default of the offline check. */
export const GATEWAY_EVIDENCE_STAGES: readonly string[] = ["gateway", "gateway-handover"];
/** Evidence keys that belong to the vaults system only. */
export const VAULTS_ONLY_KEYS = ["safe", "timelock", "govern", "receipt_releases", "receipt_applications", "consensus_receipt", "registry", "vaults", "committee_registrations", "recorded_receipts"] as const;

export interface GatewayEvidenceOpts { kind?: DeploymentKind; stages?: readonly string[] }

export function checkGatewayEvidence(ev: any, frozenCounts?: Record<string, number>, opts: GatewayEvidenceOpts = {}): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(m);
  const want = opts.stages ?? GATEWAY_EVIDENCE_STAGES;
  const kind = opts.kind ?? "production";
  const claimed = ev?.deployment_kind ?? "production";
  if (!(DEPLOYMENT_KINDS as readonly string[]).includes(claimed)) bad(`deployment_kind '${String(claimed)}' is not ${DEPLOYMENT_KINDS.join(" or ")}`);
  else if (claimed !== kind) bad(`deployment_kind is ${claimed}, the evidence is checked as ${kind}`);
  if (ev?.system !== "gateway") bad(`system is ${String(ev?.system)}, a gateway evidence says "gateway"`);
  if (ev?.chain_id !== MAINNET_CHAIN_ID) bad(`chain_id is ${ev?.chain_id}, evidence is read for ${MAINNET_CHAIN_ID}`);
  if (!/^[0-9a-f]{40}$/.test(ev?.core_sha ?? "") || /^0+$/.test(ev.core_sha)) bad("core_sha is missing or a placeholder");
  for (const k of VAULTS_ONLY_KEYS) if (ev?.[k] !== undefined) bad(`'${k}' belongs to the vaults system's evidence: a gateway evidence carries none of it`);

  const stages: any[] = Array.isArray(ev?.stages) ? ev.stages : [];
  const names = stages.map((s) => s?.stage);
  if (JSON.stringify(names) !== JSON.stringify(want)) bad(`stages are [${names.join(", ")}], the gateway system runs [${want.join(", ")}] in that order (a stage of the vaults system, or a missing gateway stage, is the wrong system)`);
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

  const g = ev?.gateway;
  for (const f of ["address", "implementation", "upgrade_timelock", "admin"] as const) if (!ADDR.test(g?.[f] ?? "")) bad(`gateway.${f} is not an address`);
  if (ZERO.test(g?.upgrade_timelock ?? "")) bad("gateway.upgrade_timelock is the zero address: the gateway release names its own nonzero upgrade timelock");
  if (ZERO.test(g?.admin ?? "")) bad("gateway.admin is the zero address");
  if (g?.upgrade_mode !== "upgradeable" && g?.upgrade_mode !== "frozen") bad(`gateway.upgrade_mode '${String(g?.upgrade_mode)}' is not upgradeable or frozen`);
  if (ADDR.test(ev?.deployer ?? "") && lc(g?.admin) === lc(ev.deployer)) bad("gateway.admin is the deployer: the handover moved nothing");
  const vs = ev?.vaults_system;
  for (const f of ["router", "vault"] as const) if (!ADDR.test(vs?.[f] ?? "")) bad(`vaults_system.${f} is not an address: the gateway run records the vaults addresses it consumed`);
  if (vs?.manifests_unchanged !== true) bad("vaults_system.manifests_unchanged is not true: the gateway run left the vaults manifests changed or did not compare them");
  if (ev?.agents_at_handover !== 0) bad(`agents_at_handover is ${String(ev?.agents_at_handover)}, a gateway run leaves zero agents`);
  if (ev?.verifier?.exit_code !== 0) bad("the verifier did not exit 0");
  if (!ADDR.test(ev?.deployer ?? "")) bad("deployer address is missing");
  if (!Number.isInteger(ev?.deployer_start_nonce) || ev.deployer_start_nonce < 0) bad("deployer_start_nonce is missing: the gateway run follows the vaults run with a deployer that is not at nonce 0");
  if (!Number.isInteger(ev?.deployer_nonce_final)) bad("deployer_nonce_final is missing");
  else if (frozenCounts && Number.isInteger(ev?.deployer_start_nonce)) {
    const sum = want.reduce((a, s) => a + (frozenCounts[s] ?? 0), 0);
    if (ev.deployer_nonce_final !== ev.deployer_start_nonce + sum) bad(`deployer_nonce_final ${ev.deployer_nonce_final} differs from the start nonce ${ev.deployer_start_nonce} plus the gateway frozen counts ${sum}`);
  }
  return p;
}
