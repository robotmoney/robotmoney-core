// The core stage table, read from the core checkout at DEPLOY_SHA: scripts/deploy/stage-table.json (version 1).
// Core owns it. This repo keeps no forge script path, required env name, artifact name, library name or manifest name of its own
// (issue devops 64, decision devops 66 recommended option). The only wiring kept here is core-wiring.ts.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PublishError } from "./errors.ts";

export const TABLE_REL = join("scripts", "deploy", "stage-table.json");

export type TableVaultKey = "USDC" | "PROTO" | "AGENT" | "RWA";

export interface TableStage {
  name: string;
  kind: "forge";
  /** `contracts/script/<File>.s.sol:<Contract>` relative to the core checkout. */
  script: string;
  requiredEnv: string[];
  optionalEnv: string[];
  /** Template `deployments/<chain>/<file>.json`. */
  manifest: string;
  /** Names from `libraries[]` to link with `forge script --libraries`. */
  libraries: string[];
  /** Names from the top-level `create2Libraries` that forge deploys by itself (CREATE2 through the factory, ahead of the stage's first transaction) because the stage deploys a contract that links them (issue 1721). Absent: none. */
  create2Libraries?: string[];
  vault: TableVaultKey | null;
}
export interface TableVault extends Partial<VaultRules> { key: TableVaultKey; stage: string; artifact: string; manifest: string }
/**
 * The per-vault deploy and governance rule (issue 1705), one row per vault in the table's `vaults[]`. Every tool that treats the vaults differently reads the
 * difference from here (vault-rules.ts), never from a literal vault key. A field whose value differs between vaults names its reason and decision in `vaultRuleDecisions`.
 */
export interface VaultRules {
  /** The vault stage leaves deposits paused. */
  deployPaused: boolean;
  /** The govern row that unpauses the vault through the Safe and the timelock: `unpause-<KEY>`. */
  unpauseRow: `unpause-${TableVaultKey}`;
  /** The unpause row is a stage 13 row (scheduled in the one sitting, required on 8453). */
  unpauseInStage13: boolean;
  /** The sheet name of the seed deposit the vault stage makes, or null for no seed. */
  seed: string | null;
  /** Where router eligibility comes from: the router stage (the base leg) or the vault stage's ROUTER_DEFAULT_BPS sheet value. */
  eligibilitySource: "router-stage" | "sheet:ROUTER_DEFAULT_BPS";
  /** Every function EMERGENCY_ROLE may call on the vault, with no timelock. */
  emergencyLevers: string[];
  /** Where the registry name comes from: a sheet name (`sheet:<NAME>`) or the vault script's constant. */
  registryNameSource: string;
}
export const VAULT_RULE_FIELDS = ["deployPaused", "unpauseRow", "unpauseInStage13", "seed", "eligibilitySource", "emergencyLevers", "registryNameSource"] as const;
export type VaultRuleField = (typeof VAULT_RULE_FIELDS)[number];
/** Why a rule field differs between vaults, and the issue that decided it. */
export interface VaultRuleDecision { reason: string; decision: string }
export interface TableLibrary { name: string; artifact: string; manifestKey: string; path: string }
/** A library forge deploys through the CREATE2 factory inside a stage (not linked with `--libraries`, no manifest key). It may link other `create2Libraries`. */
export interface TableCreate2Library { name: string; artifact: string; path: string }
/**
 * A single-vault redeploy into a live deployment (issue 1796): the forge script that deploys ONE vault after the timelock handover, with the env it reads.
 * It is NOT a stage: it has no frozen count and it runs only through the `redeploy-vault` verb. `manifest` is the vault stage's own manifest: the redeploy writes the new
 * vault there, after it has kept the old file as the retired vault's record.
 */
export interface TableRedeploy {
  vault: TableVaultKey;
  script: string;
  requiredEnv: string[];
  optionalEnv: string[];
  manifest: string;
  libraries: string[];
  create2Libraries?: string[];
}
export interface StageTable {
  version: 1;
  stages: TableStage[];
  vaults: TableVault[];
  libraries: TableLibrary[];
  create2Libraries?: TableCreate2Library[];
  /** Single-vault redeploys into a live deployment (issue 1796). Absent: none. */
  redeploys?: TableRedeploy[];
  /** One entry per vault rule field whose value differs between vaults (issue 1705). */
  vaultRuleDecisions?: Partial<Record<VaultRuleField, VaultRuleDecision>>;
  artifacts: Record<string, string>;
}

const bad = (msg: string): never => { throw new PublishError("INPUT_MISSING", `stage table: ${msg}`); };
const strList = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad(`${what} must be a list of strings`);
  return v as string[];
};

/** Validates the shape the rest of publish contracts relies on. A wrong shape is an error here, never a silent default. */
export function parseStageTable(json: unknown, where = "stage-table.json"): StageTable {
  const t = json as Partial<StageTable> | null;
  if (!t || typeof t !== "object") return bad(`${where} is not an object`);
  if (t.version !== 1) return bad(`${where} version ${String(t.version)} is not supported (this tool reads version 1)`);
  if (!Array.isArray(t.stages) || t.stages.length === 0) return bad(`${where} has no stages`);
  if (!Array.isArray(t.vaults) || !Array.isArray(t.libraries) || !t.artifacts || typeof t.artifacts !== "object") return bad(`${where} needs vaults, libraries and artifacts`);
  const names = new Set<string>();
  for (const s of t.stages) {
    if (typeof s?.name !== "string" || s.name === "") bad("a stage has no name");
    if (names.has(s.name)) bad(`stage ${s.name} is listed twice`);
    names.add(s.name);
    if (s.kind !== "forge") bad(`stage ${s.name}: kind '${String(s.kind)}' is not supported`);
    if (typeof s.script !== "string" || !/^contracts\/script\/\w+\.s\.sol:\w+$/.test(s.script)) bad(`stage ${s.name}: script must be contracts/script/<File>.s.sol:<Contract>`);
    strList(s.requiredEnv, `stage ${s.name} requiredEnv`); strList(s.optionalEnv, `stage ${s.name} optionalEnv`); strList(s.libraries, `stage ${s.name} libraries`);
    if (typeof s.manifest !== "string" || !/^deployments\/<chain>\/[\w.-]+\.json$/.test(s.manifest)) bad(`stage ${s.name}: manifest must be deployments/<chain>/<file>.json`);
  }
  const libNames = new Set(t.libraries.map((l) => l.name));
  for (const s of t.stages) for (const l of s.libraries) if (!libNames.has(l)) bad(`stage ${s.name} links unknown library '${l}'`);
  const c2 = t.create2Libraries ?? [];
  if (!Array.isArray(c2)) bad("create2Libraries must be a list");
  for (const l of c2) if (!l?.name || !l.artifact || !l.path) bad(`create2 library ${String(l?.name)} needs name, artifact and path`);
  const c2Names = new Set(c2.map((l) => l.name));
  for (const s of t.stages) if (s.create2Libraries !== undefined) { strList(s.create2Libraries, `stage ${s.name} create2Libraries`); for (const l of s.create2Libraries) if (!c2Names.has(l)) bad(`stage ${s.name} lists unknown create2 library '${l}'`); }
  for (const l of t.libraries) if (!l.name || !l.artifact || !l.manifestKey || !l.path) bad(`library ${String(l.name)} needs name, artifact, manifestKey and path`);
  const redeploys: unknown = t.redeploys;
  if (redeploys !== undefined) {
    if (!Array.isArray(redeploys)) bad("redeploys must be a list");
    const seen = new Set<string>();
    for (const r of redeploys as TableRedeploy[]) {
      const v = t.vaults.find((x) => x.key === r?.vault);
      if (!v) bad(`a redeploy names unknown vault '${String(r?.vault)}'`);
      if (seen.has(r.vault)) bad(`vault ${r.vault} has two redeploy rows`);
      seen.add(r.vault);
      if (typeof r.script !== "string" || !/^contracts\/script\/\w+\.s\.sol:\w+$/.test(r.script)) bad(`redeploy ${r.vault}: script must be contracts/script/<File>.s.sol:<Contract>`);
      strList(r.requiredEnv, `redeploy ${r.vault} requiredEnv`); strList(r.optionalEnv, `redeploy ${r.vault} optionalEnv`); strList(r.libraries, `redeploy ${r.vault} libraries`);
      if (r.manifest !== v!.manifest) bad(`redeploy ${r.vault}: manifest must be the vault stage's own manifest ${v!.manifest}`);
      for (const l of r.libraries) if (!libNames.has(l)) bad(`redeploy ${r.vault} links unknown library '${l}'`);
      if (r.create2Libraries !== undefined) { strList(r.create2Libraries, `redeploy ${r.vault} create2Libraries`); for (const l of r.create2Libraries) if (!c2Names.has(l)) bad(`redeploy ${r.vault} lists unknown create2 library '${l}'`); }
    }
  }
  for (const v of t.vaults) {
    if (!v.key || !v.artifact || !v.manifest) bad("a vault row needs key, stage, artifact and manifest");
    const st = t.stages.find((s) => s.name === v.stage);
    if (!st) bad(`vault ${v.key} names unknown stage '${v.stage}'`);
    else if (st.vault !== v.key || st.manifest !== v.manifest) bad(`vault ${v.key} disagrees with its stage ${v.stage}`);
  }
  return t as StageTable;
}

const DECISION_LINK = /^https:\/\/github\.com\/robotmoney\/robotmoney-(?:core|devops)\/issues\/\d+$/;
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The vault rows with every rule field (issue 1705), or INPUT_MISSING naming what is wrong. A field that differs between vaults must name its reason and a decision
 * link in `vaultRuleDecisions`; a decision for a field every vault agrees on is stale and is refused too.
 */
export function vaultRules(t: Pick<StageTable, "vaults" | "vaultRuleDecisions">, where = "stage-table.json"): (TableVault & VaultRules)[] {
  for (const v of t.vaults) {
    for (const f of VAULT_RULE_FIELDS) if (!(f in v)) bad(`${where}: vault ${v.key} has no ${f} (issue 1705 vault rules)`);
    if (typeof v.deployPaused !== "boolean" || typeof v.unpauseInStage13 !== "boolean") bad(`${where}: vault ${v.key} deployPaused and unpauseInStage13 must be booleans`);
    if (v.unpauseRow !== `unpause-${v.key}`) bad(`${where}: vault ${v.key} unpauseRow must be unpause-${v.key}`);
    if (v.unpauseInStage13 && !v.deployPaused) bad(`${where}: vault ${v.key} deploys open, so stage 13 has nothing to unpause`);
    if (v.seed !== null && (typeof v.seed !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(v.seed))) bad(`${where}: vault ${v.key} seed must be a sheet name or null`);
    if (v.eligibilitySource !== "router-stage" && v.eligibilitySource !== "sheet:ROUTER_DEFAULT_BPS") bad(`${where}: vault ${v.key} eligibilitySource must be router-stage or sheet:ROUTER_DEFAULT_BPS`);
    strList(v.emergencyLevers, `vault ${v.key} emergencyLevers`);
    if (typeof v.registryNameSource !== "string" || !/^(?:sheet:[A-Z][A-Z0-9_]*|script-constant)$/.test(v.registryNameSource)) bad(`${where}: vault ${v.key} registryNameSource must be sheet:<NAME> or script-constant`);
  }
  const decisions = t.vaultRuleDecisions ?? {};
  for (const f of VAULT_RULE_FIELDS) {
    // unpauseRow names the vault's own key by construction (checked above): the rule is the same when every row is unpause-<KEY>.
    const norm = (v: TableVault): unknown => (f === "unpauseRow" ? "unpause-<KEY>" : v[f]);
    const differs = t.vaults.some((v) => !sameValue(norm(v), norm(t.vaults[0]!)));
    const d = decisions[f];
    if (differs && (!d || typeof d.reason !== "string" || d.reason === "" || typeof d.decision !== "string" || !DECISION_LINK.test(d.decision))) bad(`${where}: vault rule ${f} differs between vaults, so vaultRuleDecisions.${f} must give a reason and a decision link (an issue URL)`);
    if (!differs && d) bad(`${where}: vaultRuleDecisions.${f} is stale: every vault has the same ${f}`);
  }
  for (const k of Object.keys(decisions)) if (!(VAULT_RULE_FIELDS as readonly string[]).includes(k)) bad(`${where}: vaultRuleDecisions names unknown field ${k}`);
  return t.vaults as (TableVault & VaultRules)[];
}

/** The redeploy row of a vault, or INPUT_MISSING naming the checkout that lacks it. */
export function redeployRow(t: StageTable, vault: TableVaultKey): TableRedeploy {
  const r = t.redeploys?.find((x) => x.vault === vault);
  if (!r) throw new PublishError("INPUT_MISSING", `the core stage table has no redeploys row for vault ${vault}: use a core DEPLOY_SHA that carries the redeploy script (issue 1796)`);
  return r;
}

export function loadStageTable(coreDir: string): StageTable {
  const p = join(coreDir, TABLE_REL);
  if (!existsSync(p)) throw new PublishError("INPUT_MISSING", `the core checkout ${coreDir} has no ${TABLE_REL}: use a core DEPLOY_SHA that carries the stage table (core scripts/deploy/README.md)`, { path: p });
  let j: unknown;
  try { j = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new PublishError("INPUT_MISSING", `${p} is not valid JSON: ${(e as Error).message}`); }
  return parseStageTable(j, p);
}

/** `deployments/<chain>/vault.json` -> `vault.json` */
export const manifestFile = (template: string): string => basename(template);
/** `deployments/<chain>/vault.json` -> `vault` */
export const manifestBase = (template: string): string => basename(template, ".json");
/** The template with the chain id filled in. */
export const manifestPathFor = (template: string, chainId: number | string): string => template.replace("<chain>", String(chainId));
