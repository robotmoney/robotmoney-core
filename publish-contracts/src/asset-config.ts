// Core's launch asset config, read from the core checkout at the DEPLOY_SHA. Used by the verifier (expected asset config of each vault,
// never read from the chain it is checking) and by the config-check (pools against the live chain). Static config has no adapter:
// the adapter is deployed per run, so callers add it from the vault manifest.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSET_CONFIG_FILES, VENUE_INDEX } from "./core-wiring.ts";
import { PublishError } from "./errors.ts";
import { VAULT_NAME, type VaultKey } from "./sheet.ts";
import type { Address } from "./verify/types.ts";

export interface ConfigAsset { symbol?: string; token: Address; pool: Address; swapFee: number; venue: number }

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** The configured assets of one vault. USDC holds none. AGENT lists RM only at launch (core 1554), and its list may be empty (tokens are added through the timelock), PROTO and RWA may not. */
export function loadConfigAssets(coreDir: string, key: VaultKey): ConfigAsset[] {
  const spec = ASSET_CONFIG_FILES[key];
  if (!spec) return [];
  const p = join(coreDir, spec.file);
  if (!existsSync(p)) throw new PublishError("INPUT_MISSING", `${spec.file} is missing in the core checkout: the expected asset config of ${VAULT_NAME[key]} is read from it (nothing is skipped)`, { path: p });
  const j = JSON.parse(readFileSync(p, "utf8"));
  const list = j[spec.list];
  if (!Array.isArray(list)) throw new PublishError("INPUT_MISSING", `${spec.file} has no ${spec.list} list (an empty list is written as [])`, { key });
  if (key !== "AGENT" && list.length === 0) throw new PublishError("INPUT_MISSING", `${spec.file}: ${VAULT_NAME[key]} must list its assets`, { key });
  return list.map((a: Record<string, unknown>, i: number): ConfigAsset => {
    const at = `${spec.file} ${spec.list}[${i}]`;
    if (typeof a.token !== "string" || !ADDR.test(a.token)) throw new PublishError("INPUT_MISSING", `${at}: token is not an address`, { key });
    if (typeof a.pool !== "string" || !ADDR.test(a.pool)) throw new PublishError("INPUT_MISSING", `${at}: pool is not an address`, { key });
    if (typeof a.poolFee !== "number" || !Number.isInteger(a.poolFee) || a.poolFee <= 0) throw new PublishError("INPUT_MISSING", `${at}: poolFee is not a positive integer`, { key });
    const venue = VENUE_INDEX[String(a.venue)];
    if (venue === undefined) throw new PublishError("INPUT_MISSING", `${at}: venue '${String(a.venue)}' is not one of ${Object.keys(VENUE_INDEX).join(", ")}`, { key });
    return { symbol: typeof a.symbol === "string" ? a.symbol : undefined, token: a.token as Address, pool: a.pool as Address, swapFee: a.poolFee, venue };
  });
}

/** BasketVault.sol and RobotMoneyVault.sol define the same constant: the highest exit fee a vault accepts. */
export const VAULT_MAX_EXIT_FEE_FILES = ["contracts/RobotMoneyVault.sol", "contracts/vaults/BasketVault.sol"] as const;
/** Used only when core does not define MAX_EXIT_FEE_BPS in those files (the value core defines today). */
export const FALLBACK_MAX_EXIT_FEE_BPS = 100n;

/** The vault exit-fee ceiling from the core contracts at the DEPLOY_SHA: the lowest MAX_EXIT_FEE_BPS found. Undefined when none is defined. */
export function readMaxExitFeeBps(coreDir: string): bigint | undefined {
  const found: bigint[] = [];
  for (const f of VAULT_MAX_EXIT_FEE_FILES) {
    const p = join(coreDir, f);
    if (!existsSync(p)) continue;
    const m = /\bMAX_EXIT_FEE_BPS\s*=\s*([0-9_]+)\s*;/.exec(readFileSync(p, "utf8"));
    if (m) found.push(BigInt(m[1]!.replace(/_/g, "")));
  }
  return found.length ? found.reduce((a, b) => (a < b ? a : b)) : undefined;
}

/** Refuse a sheet whose exitFeeBps is above the vault ceiling. Throws SHEET-class FLOOR error naming the vault. */
export function assertExitFeeBound(coreDir: string, vaults: Record<VaultKey, { exitFeeBps: bigint }>): bigint {
  const max = readMaxExitFeeBps(coreDir) ?? FALLBACK_MAX_EXIT_FEE_BPS;
  for (const [k, v] of Object.entries(vaults)) {
    if (v.exitFeeBps > max) throw new PublishError("FLOOR", `VAULT_${k}_EXIT_FEE_BPS ${v.exitFeeBps} is above the vault maximum MAX_EXIT_FEE_BPS ${max} read from the core contracts`, { vault: k, exitFeeBps: Number(v.exitFeeBps), max: Number(max) });
  }
  return max;
}
