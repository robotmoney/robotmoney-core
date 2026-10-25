// The stage list AS DATA, built from core's stage table (scripts/deploy/stage-table.json at DEPLOY_SHA, see stage-table.ts).
// The forge rows (script, env, manifest, libraries, vault) come from the table. This file adds only the four orchestration rows that
// run no core script: safe (the real Safe through the Safe tool), prove-control (the Safe signs once, before the handover), verify and govern. One loop runs every stage on every chain.
// The expected tx count of a row is never typed here: it is read from deployments/frozen-counts/<sha>.json.
import { PROOF_TX_NONCES } from "./counts.ts";
import { PROOF_STAGE } from "./control-proof.ts";
import { PublishError } from "./errors.ts";
import { SAFE_MANIFEST, isVaultKey } from "./core-wiring.ts";
import type { VaultKey } from "./sheet.ts";
import { isRetiredVaultKey, type RetiredVaultKey } from "./vault-keys.ts";
import { manifestFile, type StageTable, type SystemName, type TableCreate2Library, type TableLibrary } from "./stage-table.ts";

export type StageKind = "safe" | "forge" | "prove" | "verify" | "govern";

export interface StageRow {
  name: string;
  kind: StageKind;
  /** forge script `path:Contract` relative to the core checkout. Absent for safe, verify and govern. */
  script?: string;
  /** Env names the script reads with no default (from the table). */
  requiredEnv: string[];
  /** Env names the script reads with a default (from the table). */
  optionalEnv: string[];
  /** Manifest file this stage writes, under deployments/<chainId>/ in the core checkout. */
  manifest?: string;
  /** Libraries to link with `forge script --libraries` (from the table). */
  libraries: TableLibrary[];
  /** Libraries forge deploys by itself through the CREATE2 factory inside this stage (issue 1721). Empty for the orchestration rows. */
  create2Libraries: TableCreate2Library[];
  /** Frozen-count key. Null: the stage sends no deployer transaction. */
  countKey: string | null;
  /** Vault stages: which vault's per-vault sheet values feed the caps and exit fee. */
  vault?: VaultKey;
  /** The signer is a Safe owner set, not the deployer. */
  usesSafeOwners?: boolean;
}

const SAFE_ROW: StageRow = { name: "safe", kind: "safe", countKey: "safe", manifest: SAFE_MANIFEST, requiredEnv: [], optionalEnv: [], libraries: [], create2Libraries: [] };
// The Safe control proof (core 1618): no core script, no deployer transaction. It sits just before the timelock stage (the handover).
const PROVE_ROW: StageRow = { name: PROOF_STAGE, kind: "prove", countKey: null, usesSafeOwners: true, requiredEnv: [], optionalEnv: [], libraries: [], create2Libraries: [] };
const VERIFY_ROW: StageRow = { name: "verify", kind: "verify", countKey: null, requiredEnv: [], optionalEnv: [], libraries: [], create2Libraries: [] };
const GOVERN_ROW: StageRow = { name: "govern", kind: "govern", countKey: null, usesSafeOwners: true, requiredEnv: [], optionalEnv: [], libraries: [], create2Libraries: [] };

/** The rows for a table: safe first (the Safe is an input of the vault fee recipient and the timelock), the table stages in order, then verify and govern. */
export function buildStages(table: StageTable, system: SystemName | "all-forge" = "vaults"): StageRow[] {
  const forge = table.stages.map((s): StageRow => ({
    name: s.name, kind: "forge", script: s.script, countKey: s.name, manifest: manifestFile(s.manifest),
    requiredEnv: s.requiredEnv, optionalEnv: s.optionalEnv,
    libraries: s.libraries.map((n) => table.libraries.find((l) => l.name === n)!),
    create2Libraries: (s.create2Libraries ?? []).map((n) => table.create2Libraries!.find((l) => l.name === n)!),
    ...(s.vault && isVaultKey(s.vault) ? { vault: s.vault } : {}),
  }));
  if (system === "all-forge") return forge;
  if (system === "gateway") {
    // Issue 1892: the gateway system deploys and hands over the gateway, then verifies. It creates no Safe, proves no control and governs nothing: the production authority
    // is an open decision (architecture 10) and the vaults system's Safe and timelock are not its inputs.
    return [...forge.filter((r) => table.stages.find((s) => s.name === r.name)?.system === "gateway"), VERIFY_ROW];
  }
  const own = table.systems ? forge.filter((r) => table.stages.find((s) => s.name === r.name)?.system === "vaults") : forge;
  const handover = own.findIndex((r) => r.name === "timelock");
  const ordered = handover < 0 ? [...own, PROVE_ROW] : [...own.slice(0, handover), PROVE_ROW, ...own.slice(handover)];
  return [SAFE_ROW, ...ordered, VERIFY_ROW, GOVERN_ROW];
}

/** Every forge row of the table whatever the system, for manifest references across systems (the gateway system reads the vaults system's manifests). */
const allForgeRows = (t: StageTable): StageRow[] => buildStages(t, "all-forge").filter((r) => r.kind === "forge");

// Live bindings: set once by useStageTable() (the CLI, after it has the core checkout) and read everywhere else.
let table: StageTable | undefined;
export let STAGES: StageRow[] = [];
export let STAGE_NAMES: string[] = [];
/** Stages that send deployer transactions, in order. Their frozen counts sum to the deployer nonce at the end of the deploy. */
export let DEPLOYER_STAGES: StageRow[] = [];
/** The vault stages, one per vault, in table order. rmUSDC is first. */
export let VAULT_STAGES: { key: VaultKey; stage: string }[] = [];
/** Issue 1927: the vault stages of a prior line's table this tool never deploys (rmAGENT of the live v0.5.0 deployment, RETIRED_VAULT_KEYS). Empty for this line's table. */
export let RETIRED_VAULT_STAGES: { key: RetiredVaultKey; stage: string; manifest: string; artifact: string }[] = [];

/** The system of this run (issue 1892). `vaults` is also the system of a table from before the split (one combined run). */
export let ACTIVE_SYSTEM: SystemName = "vaults";

export function useStageTable(t: StageTable, system: SystemName = "vaults"): void {
  if (system === "gateway" && !t.systems?.gateway) throw new PublishError("INPUT_MISSING", "the core stage table declares no gateway system: use a core DEPLOY_SHA from after the system split (issue 1892)");
  const unknown = t.vaults.find((v) => !isVaultKey(v.key) && !isRetiredVaultKey(v.key));
  if (unknown) throw new PublishError("INPUT_MISSING", `the core stage table names vault ${unknown.key}, which is neither a vault of this line nor a retired one`);
  table = t;
  ACTIVE_SYSTEM = system;
  STAGES = buildStages(t, system);
  STAGE_NAMES = STAGES.map((s) => s.name);
  DEPLOYER_STAGES = STAGES.filter((s) => s.countKey !== null);
  VAULT_STAGES = t.vaults.filter((v) => isVaultKey(v.key)).map((v) => ({ key: v.key, stage: v.stage }));
  RETIRED_VAULT_STAGES = t.vaults.filter((v) => isRetiredVaultKey(v.key)).map((v) => ({ key: v.key as unknown as RetiredVaultKey, stage: v.stage, manifest: v.manifest, artifact: v.artifact }));
}

/** Issue 1892: the stage list and the system are process-wide. A run that switches them (the gateway system) hands back what it found. */
export function peekStageState(): { table: StageTable | undefined; system: SystemName } { return { table, system: ACTIVE_SYSTEM }; }
export function restoreStageState(s: { table: StageTable | undefined; system: SystemName }): void { if (s.table) useStageTable(s.table, s.system); }

export function getStageTable(): StageTable {
  if (!table) throw new PublishError("INPUT_MISSING", "the core stage table is not loaded: loadStageTable(coreDir) then useStageTable()");
  return table;
}

export const stageByName = (n: string): StageRow => {
  const s = STAGES.find((x) => x.name === n);
  if (!s) throw new Error(`unknown stage '${n}'`);
  return s;
};

/** `file:field` reference of a stage's manifest field, in the form readManifestField reads. */
export const manifestRef = (stage: string, field: string): string => {
  const m = (STAGES.find((x) => x.name === stage) ?? (table ? allForgeRows(table).find((x) => x.name === stage) : undefined) ?? stageByName(stage)).manifest;
  if (!m) throw new Error(`stage ${stage} writes no manifest`);
  return `${m.replace(/\.json$/, "")}:${field}`;
};

/** The deployer transactions outside every stage count that precede a stage: the prove-control transaction, for every stage after it (core 1712). */
export function proofNoncesBefore(stage: string): number {
  if (ACTIVE_SYSTEM === "gateway") return 0; // the gateway system proves no Safe control (issue 1892)
  const at = STAGE_NAMES.indexOf(stage);
  return at > STAGE_NAMES.indexOf(PROOF_STAGE) ? PROOF_TX_NONCES : 0;
}

/** The deployer transactions outside every stage count over the whole run: the one prove-control transaction, none in the gateway system. */
export const proofTxNonces = (): number => (ACTIVE_SYSTEM === "gateway" ? 0 : PROOF_TX_NONCES);

/**
 * The deployer nonce a stage starts at: the frozen counts of every deployer stage before it, plus the prove-control transaction once it has been sent.
 * `startNonce` (issue 1727) is the nonce the run started at: 0 for a fresh deployer, and the only value production ever uses.
 */
export function expectedStartNonce(stage: string, counts: Record<string, number>, startNonce = 0): number {
  let n = startNonce;
  for (const s of DEPLOYER_STAGES) {
    if (s.name === stage) return n + proofNoncesBefore(stage);
    n += counts[s.countKey!] ?? 0;
  }
  return n + proofTxNonces();
}
