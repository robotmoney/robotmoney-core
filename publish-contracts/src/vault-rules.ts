// The per-vault rules of the four vaults (issue 1705, QA plan v1 E9), read from this checkout's stage table: scripts/deploy/stage-table.json `vaults[]`.
// One table holds the rule for every dimension the four vaults are governed by: the deploy pause state, the unpause row and whether stage 13 runs it,
// the seed, where router eligibility comes from, the EMERGENCY_ROLE levers and where the registry name comes from. The govern rows (govern.ts), the
// evidence steps (evidence-check.ts), the verifier's sheet (verify-stage.ts) and the sheet parser derive the per-vault behaviour from here, never from a
// vault literal. A rule on which the vaults differ names its decision in the table's `vaultRuleDecisions`.
//
// The table is read when this module loads, from the checkout this tool lives in (publish-contracts lives inside core), so the row names are constants
// for every caller. The CLI then refuses a --core-dir checkout whose table carries other rules (vaultRulesProblem): the scripts it runs and the rows this
// tool schedules follow one rule set.
import { join } from "node:path";
import { PublishError } from "./errors.ts";
import { VAULT_RULE_FIELDS, loadStageTable, ruleValueOf, type StageTable, type TableVault, type TableVaultKey } from "./stage-table.ts";

/** The govern row that opens a vault: `unpause-<KEY>`. */
export type UnpauseRowName = `unpause-${TableVaultKey}`;

/** The repo root that holds this package (publish-contracts/src/.. /..). */
export const OWN_CORE_DIR = join(import.meta.dir, "..", "..");
const OWN: StageTable = loadStageTable(OWN_CORE_DIR);

/** Every vault row with its rules, in table order (rmUSDC first, then the baskets in deploy order). */
export const VAULT_RULES: readonly TableVault[] = OWN.vaults;
/** The decision behind each rule on which the vaults differ. */
export const VAULT_RULE_DECISIONS = OWN.vaultRuleDecisions;

export function vaultRule(key: TableVaultKey): TableVault {
  const v = VAULT_RULES.find((x) => x.key === key);
  if (!v) throw new PublishError("INPUT_MISSING", `the stage table has no vault ${key}`);
  return v;
}

/** Every vault's unpause row, in table order: stage 13 runs them, and after a pause-all each reopens its vault on demand (issue 1667). */
export const UNPAUSE_ROW_NAMES: readonly UnpauseRowName[] = VAULT_RULES.map((v) => v.unpauseRow);
/** The vaults whose unpause row is part of stage 13, in table order. On 8453 the sheet must list every one of them in GOVERN_UNPAUSE_VAULTS. */
export const STAGE13_UNPAUSE_VAULTS: readonly TableVaultKey[] = VAULT_RULES.filter((v) => v.unpauseInStage13).map((v) => v.key);
/** The stage 13 rows, in table order. */
export const STAGE13_UNPAUSE_ROWS: readonly UnpauseRowName[] = VAULT_RULES.filter((v) => v.unpauseInStage13).map((v) => v.unpauseRow);
/** The vault an unpause row opens, or undefined for any other row name. */
export const vaultOfUnpauseRow = (row: string): TableVaultKey | undefined => VAULT_RULES.find((v) => v.unpauseRow === row)?.key;

/** The vaults the router stage makes eligible (they are never in the sheet's ELIGIBLE_VAULTS), in table order. They lead the router default weights. */
export const ROUTER_STAGE_ELIGIBLE: readonly TableVaultKey[] = VAULT_RULES.filter((v) => v.eligibilitySource === "router-stage").map((v) => v.key);
/** True when the vault takes its router eligibility from the sheet's ELIGIBLE_VAULTS (in its own stage), false when the router stage sets it. */
export const eligibleFromSheet = (key: TableVaultKey): boolean => vaultRule(key).eligibilitySource === "sheet:ELIGIBLE_VAULTS";
/** Router eligibility the deployer leaves in place: the router-stage vaults always, every other vault when the sheet lists it. */
export const routerEligibleAtDeploy = (key: TableVaultKey, sheetEligible: readonly string[]): boolean => !eligibleFromSheet(key) || sheetEligible.includes(key);
/** True when the vault stage makes a seed deposit. */
export const isSeeded = (key: TableVaultKey): boolean => vaultRule(key).seed !== "none";
/** The paused state the vault reads before govern ran: the table's deployPaused, unless its unpause row has executed. */
export const expectPausedAfter = (key: TableVaultKey, unpaused: readonly string[]): boolean => vaultRule(key).deployPaused && !unpaused.includes(key);

/**
 * The difference between the vault rules of a core checkout's table and this tool's own, or undefined. The tool schedules its rows from its own table,
 * the forge scripts it runs come from the checkout, so a checkout whose rules differ (an older DEPLOY_SHA, a hand-edited table) is refused before any stage.
 */
export function vaultRulesProblem(t: Pick<StageTable, "vaults">, where: string): string | undefined {
  const keys = (x: readonly TableVault[]) => x.map((v) => v.key).join(",");
  if (keys(t.vaults) !== keys(VAULT_RULES)) return `${where} lists the vaults ${keys(t.vaults)}, this tool's table ${keys(VAULT_RULES)}`;
  const diff: string[] = [];
  for (const v of t.vaults) {
    const own = vaultRule(v.key);
    for (const f of VAULT_RULE_FIELDS) if (ruleValueOf(v, f) !== ruleValueOf(own, f)) diff.push(`${v.key}.${f} ${JSON.stringify(v[f])} (this tool: ${JSON.stringify(own[f])})`);
  }
  return diff.length === 0 ? undefined : `${where} carries other vault rules than this tool's stage table (issue 1705): ${diff.join("; ")}`;
}
