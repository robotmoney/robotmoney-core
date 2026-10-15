// The per-vault deploy and governance rules (issue 1705), the one table loader for them: scripts/deploy/stage-table.json `vaults[]` in this checkout.
// govern.ts (the unpause rows), evidence-check.ts (the stage 13 steps), verify-stage.ts (the verifier's expected paused state and router eligibility) and sheet.ts
// read every per-vault difference from here. None of them names a vault key to treat it differently: the difference is a table field with its decision link.
import { readFileSync } from "node:fs";
import { PublishError } from "./errors.ts";
import { vaultRules, type TableVault, type TableVaultKey, type VaultRules } from "./stage-table.ts";

const TABLE_URL = new URL("../../scripts/deploy/stage-table.json", import.meta.url);

function load(): (TableVault & VaultRules)[] {
  let json: unknown;
  try { json = JSON.parse(readFileSync(TABLE_URL, "utf8")); } catch (e) { throw new PublishError("INPUT_MISSING", `the vault rules need ${TABLE_URL.pathname}: ${(e as Error).message}`); }
  return vaultRules(json as Parameters<typeof vaultRules>[0], TABLE_URL.pathname);
}

/** One rule row per vault, in table order (the deploy order). */
export const VAULT_RULES: readonly (TableVault & VaultRules)[] = load();

export const vaultRule = (key: TableVaultKey): TableVault & VaultRules => {
  const r = VAULT_RULES.find((v) => v.key === key);
  if (!r) throw new PublishError("INPUT_MISSING", `the stage table has no vault row for ${key}`);
  return r;
};

/** The vaults whose unpause row is a stage 13 row, in table order. */
export const STAGE13_UNPAUSE_VAULTS: readonly TableVaultKey[] = VAULT_RULES.filter((v) => v.unpauseInStage13).map((v) => v.key);
/** The stage 13 unpause rows, in table order. */
export const STAGE13_UNPAUSE_ROWS: readonly VaultRules["unpauseRow"][] = VAULT_RULES.filter((v) => v.unpauseInStage13).map((v) => v.unpauseRow);
/** Every vault's unpause row (stage 13 or the reopen after a pause-all), in table order. */
export const VAULT_UNPAUSE_ROWS: readonly VaultRules["unpauseRow"][] = VAULT_RULES.map((v) => v.unpauseRow);
/** The vault an unpause row opens. */
export const vaultOfUnpauseRow = (row: string): TableVaultKey | undefined => VAULT_RULES.find((v) => v.unpauseRow === row)?.key;
/** The vaults the router stage makes eligible (the base leg, first in every default vector), in table order. */
export const ROUTER_STAGE_ELIGIBLE: readonly TableVaultKey[] = VAULT_RULES.filter((v) => v.eligibilitySource === "router-stage").map((v) => v.key);
/** The vaults whose vault stage makes the seed deposit. */
export const SEEDED_VAULTS: readonly TableVaultKey[] = VAULT_RULES.filter((v) => v.seed !== null).map((v) => v.key);

/** The paused state a vault should read: paused when it deploys paused and its unpause row has not executed. */
export const expectPaused = (key: TableVaultKey, unpaused: readonly string[]): boolean => vaultRule(key).deployPaused && !unpaused.includes(key);
/** Router eligibility a vault should read: the router stage's base leg always, a basket when the sheet lists it in ELIGIBLE_VAULTS. */
export const routerEligible = (key: TableVaultKey, sheetEligible: readonly string[]): boolean =>
  vaultRule(key).eligibilitySource === "router-stage" || sheetEligible.includes(key);
