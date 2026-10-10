// The stage list AS DATA, built from core's stage table (scripts/deploy/stage-table.json at DEPLOY_SHA, see stage-table.ts).
// The forge rows (script, env, manifest, libraries, vault) come from the table. This file adds only the four orchestration rows that
// run no core script: safe (the real Safe through the Safe tool), prove-control (the Safe signs once, before the handover), verify and govern. One loop runs every stage on every chain.
// The expected tx count of a row is never typed here: it is read from deployments/frozen-counts/<sha>.json.
import { PROOF_TX_NONCES } from "./counts.ts";
import { PROOF_STAGE } from "./control-proof.ts";
import { PublishError } from "./errors.ts";
import { SAFE_MANIFEST, isVaultKey } from "./core-wiring.ts";
import type { VaultKey } from "./sheet.ts";
import { manifestFile, type StageTable, type TableCreate2Library, type TableLibrary } from "./stage-table.ts";

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
export function buildStages(table: StageTable): StageRow[] {
  const forge = table.stages.map((s): StageRow => ({
    name: s.name, kind: "forge", script: s.script, countKey: s.name, manifest: manifestFile(s.manifest),
    requiredEnv: s.requiredEnv, optionalEnv: s.optionalEnv,
    libraries: s.libraries.map((n) => table.libraries.find((l) => l.name === n)!),
    create2Libraries: (s.create2Libraries ?? []).map((n) => table.create2Libraries!.find((l) => l.name === n)!),
    ...(s.vault && isVaultKey(s.vault) ? { vault: s.vault } : {}),
  }));
  const handover = forge.findIndex((r) => r.name === "timelock");
  const ordered = handover < 0 ? [...forge, PROVE_ROW] : [...forge.slice(0, handover), PROVE_ROW, ...forge.slice(handover)];
  return [SAFE_ROW, ...ordered, VERIFY_ROW, GOVERN_ROW];
}

// Live bindings: set once by useStageTable() (the CLI, after it has the core checkout) and read everywhere else.
let table: StageTable | undefined;
export let STAGES: StageRow[] = [];
export let STAGE_NAMES: string[] = [];
/** Stages that send deployer transactions, in order. Their frozen counts sum to the deployer nonce at the end of the deploy. */
export let DEPLOYER_STAGES: StageRow[] = [];
/** The vault stages, one per vault, in table order. rmUSDC is first. */
export let VAULT_STAGES: { key: VaultKey; stage: string }[] = [];

export function useStageTable(t: StageTable): void {
  table = t;
  STAGES = buildStages(t);
  STAGE_NAMES = STAGES.map((s) => s.name);
  DEPLOYER_STAGES = STAGES.filter((s) => s.countKey !== null);
  VAULT_STAGES = t.vaults.map((v) => ({ key: v.key, stage: v.stage }));
}

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
  const m = stageByName(stage).manifest;
  if (!m) throw new Error(`stage ${stage} writes no manifest`);
  return `${m.replace(/\.json$/, "")}:${field}`;
};

/** The deployer transactions outside every stage count that precede a stage: the prove-control transaction, for every stage after it (core 1712). */
export function proofNoncesBefore(stage: string): number {
  const at = STAGE_NAMES.indexOf(stage);
  return at > STAGE_NAMES.indexOf(PROOF_STAGE) ? PROOF_TX_NONCES : 0;
}

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
  return n + PROOF_TX_NONCES;
}
