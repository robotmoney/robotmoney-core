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
  vault: TableVaultKey | null;
}
export interface TableVault { key: TableVaultKey; stage: string; artifact: string; manifest: string }
export interface TableLibrary { name: string; artifact: string; manifestKey: string; path: string }
export interface StageTable {
  version: 1;
  stages: TableStage[];
  vaults: TableVault[];
  libraries: TableLibrary[];
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
  for (const l of t.libraries) if (!l.name || !l.artifact || !l.manifestKey || !l.path) bad(`library ${String(l.name)} needs name, artifact, manifestKey and path`);
  for (const v of t.vaults) {
    if (!v.key || !v.artifact || !v.manifest) bad("a vault row needs key, stage, artifact and manifest");
    const st = t.stages.find((s) => s.name === v.stage);
    if (!st) bad(`vault ${v.key} names unknown stage '${v.stage}'`);
    else if (st.vault !== v.key || st.manifest !== v.manifest) bad(`vault ${v.key} disagrees with its stage ${v.stage}`);
  }
  return t as StageTable;
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
