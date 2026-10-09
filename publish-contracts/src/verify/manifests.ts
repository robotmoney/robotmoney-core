// Manifest loading. The manifests are written by the core deploy scripts (deployments/<chain>/*.json) and, for safe.json, by the Safe stage.
// Which files exist, which one holds which vault and which libraries are recorded all come from core's stage table.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VAULT_ADDRESS_FIELD, VAULT_KIND, LIBS_STAGE, SAFE_MANIFEST } from "../core-wiring.ts";
import { manifestBase, type StageTable } from "../stage-table.ts";
import { VAULT_NAME } from "../sheet.ts";
import { requiredManifests, stageManifestName } from "./constants.ts";
import type { Address, VaultKind } from "./types.ts";

export interface ManifestVault {
  /** rmUSDC, rmPROTO, rmAGENT or rmRWA. */
  key: string;
  kind: VaultKind;
  address: Address;
  /** The manifest file it was read from. */
  source: string;
  /** The forge artifact its runtime code must match (table `vaults[].artifact`). */
  artifact: string;
  /** The parsed vault manifest (seed fields live here for rmUSDC). */
  data: any;
}

export interface Manifests {
  /** Parsed manifests keyed by file name without .json (for example `vault`, `libs`, `protocol-asset-vault`, `safe`). */
  files: Record<string, any>;
  missing: string[];
  vaults: ManifestVault[];
  /** library name -> address */
  libraries: Record<string, Address>;
  /** library name -> forge artifact name */
  libraryArtifacts: Record<string, string>;
  safe?: Address;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s: unknown): s is Address => typeof s === "string" && ADDR.test(s);
export const lc = (s: string) => s.toLowerCase();

/**
 * Every vault in the table's `vaults` has its own manifest with `.vault`. Library addresses are in the libs stage manifest under
 * the table's `libraries[].manifestKey`. A vault whose manifest is missing is listed in `missing` and is not in `vaults`.
 */
export function loadManifests(dir: string, table: StageTable): Manifests {
  const files: Record<string, any> = {};
  const missing: string[] = [];
  for (const f of requiredManifests(table)) {
    const p = join(dir, `${f}.json`);
    if (!existsSync(p)) { missing.push(`${f}.json`); continue; }
    try { files[f] = JSON.parse(readFileSync(p, "utf8")); } catch { missing.push(`${f}.json (unparseable)`); }
  }
  const vaults: ManifestVault[] = [];
  for (const v of table.vaults) {
    const base = manifestBase(v.manifest);
    const addr = files[base]?.[VAULT_ADDRESS_FIELD];
    if (isAddress(addr)) vaults.push({ key: VAULT_NAME[v.key], kind: VAULT_KIND[v.key], address: addr, source: `${base}.json`, artifact: v.artifact, data: files[base] });
  }
  const libs: Record<string, Address> = {};
  const libraryArtifacts: Record<string, string> = {};
  const libManifest = files[stageManifestName(table, LIBS_STAGE)] ?? {};
  for (const l of table.libraries) {
    if (isAddress(libManifest[l.manifestKey])) { libs[l.name] = libManifest[l.manifestKey]; libraryArtifacts[l.name] = l.artifact; }
  }
  const safeName = manifestBase(SAFE_MANIFEST);
  const safe = isAddress(files[safeName]?.safe) ? files[safeName].safe : undefined;
  return { files, missing, vaults, libraries: libs, libraryArtifacts, safe };
}
