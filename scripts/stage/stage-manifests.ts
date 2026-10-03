// Manifest names for the Twin harness, read FROM scripts/deploy/stage-table.json (the single source
// of truth for what the deploy writes). Nothing here names a manifest file by hand.
// Every function takes the table as an argument so a test can hand it a renamed copy.
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import stageTable from "../deploy/stage-table.json";

export interface StageTableShape {
  stages: { name: string; manifest?: string | null }[];
  vaults: { key: string; stage: string; manifest: string }[];
}
export const STAGE_TABLE: StageTableShape = stageTable as StageTableShape;

/** The manifest file name (no directory) the table gives a stage. Throws when the stage has none. */
export function manifestOf(stage: string, table: StageTableShape = STAGE_TABLE): string {
  const row = table.stages.find((s) => s.name === stage);
  if (!row?.manifest) throw new Error(`stage-table.json: stage '${stage}' has no manifest`);
  return basename(row.manifest);
}

/** Every manifest a full publish writes: one per stage that has one. */
export function allManifests(table: StageTableShape = STAGE_TABLE): string[] {
  return table.stages.filter((s) => s.manifest).map((s) => basename(s.manifest as string));
}

export function expectedManifestCount(table: StageTableShape = STAGE_TABLE): number {
  return allManifests(table).length;
}

/** The vault manifests keyed rmUSDC, rmPROTO, ... (the table's vault key with the rm prefix). */
export function vaultManifests(table: StageTableShape = STAGE_TABLE): Record<string, string> {
  return Object.fromEntries(table.vaults.map((v) => [`rm${v.key}`, basename(v.manifest)]));
}

export function presentManifests(mdir: string, table: StageTableShape = STAGE_TABLE): string[] {
  return allManifests(table).filter((f) => existsSync(join(mdir, f)));
}

export function missingManifests(mdir: string, table: StageTableShape = STAGE_TABLE): string[] {
  return allManifests(table).filter((f) => !existsSync(join(mdir, f)));
}

/** Chain id the harness runs on. Only this chain gets the unattended publish environment. */
export const TWIN_CHAIN_ID = 918453;

/**
 * Environment for a publish contracts call. The devops CLI refuses an unattended publish without
 * YES=1 and refuses YES=1 on chain 8453. So: YES=1 and no CONFIRM on the Twin chain only, and no YES
 * (inherited ones included) on any other chain. An undefined value means "remove from the child env".
 */
export function publishEnv(chainId: number, manifestDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { PUBLISH_MANIFEST_DIR: manifestDir };
  if (chainId === TWIN_CHAIN_ID) {
    env.YES = "1";
    env.CONFIRM = undefined;
  } else {
    env.YES = undefined;
  }
  return env;
}
