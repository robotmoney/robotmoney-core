// Sheet diff: the stage sheet versus the production sheet differ only in parameter lines.
// Usage: bun scripts/stage/sheet-diff.ts <stage-sheet> <production-sheet>
// Exits non-zero on any difference outside the allow-list below.
// Canonical: core issue 1499 (principles 2, 24; S9, core 1488).
import { readFileSync } from "node:fs";

/** Keys whose VALUE may differ between stage and production (run parameters). */
export const PARAMETER_KEYS = new Set([
  "CHAIN_ID",
  "TIMELOCK_MIN_DELAY",
  "VOTING_PERIOD",
  "EXECUTION_DELAY",
  "QUORUM_THRESHOLD",
  "TVL_CAP",
  "PER_DEPOSIT_CAP",
  "SEED_DEPOSIT_USDC",
  "EXIT_FEE_BPS",
  "AGENT_MAX_PER_PAYMENT",
  "AGENT_MAX_PER_WINDOW",
  "AGENT_WINDOW_SECONDS",
  "SAFE_THRESHOLD",
]);

/** Identity lines (addresses only). They are generated per run on stage and typed per run on mainnet. */
export const IDENTITY_KEYS = new Set([
  "ADMIN_ADDRESS",
  "PAUSER_ADDRESS",
  "AGENT_ADDRESS",
  "AGENT_ADDRESSES",
  "SHARE_RECEIVER_ADDRESS",
  "EMERGENCY_ADDRESS",
  "RECEIPT_ADMIN_ADDRESS",
  "FEE_RECIPIENT",
  "SEED_SHARE_RECEIVER",
  "SAFE_OWNERS",
  "VOTER_ADDRESSES",
]);

/** Keys that must never appear in any sheet: they are escape hatches the one scheme removes. */
export const FORBIDDEN_KEYS = new Set([
  "REHEARSAL",
  "ALLOW_SHORT_TIMELOCK_DELAY",
  "SKIP_ROUTER_ADMIN_GRANT",
  "BASKET_VAULT_AUDIT_COMPLETE",
  "MOCK_ALL",
  "YES",
  "SAFE_ADDRESS",
]);

export type Sheet = Map<string, string>;

export function parseSheet(text: string): Sheet {
  const m: Sheet = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const mm = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!mm) continue;
    let v = mm[2]!.replace(/\s+#.*$/, "").trim();
    v = v.replace(/^["']|["']$/g, "");
    m.set(mm[1]!, v);
  }
  return m;
}

export interface SheetDiff {
  onlyStage: string[];
  onlyProd: string[];
  valueDiffs: string[];
}

export function diffSheets(stage: Sheet, prod: Sheet): SheetDiff {
  const onlyStage = [...stage.keys()].filter((k) => !prod.has(k)).sort();
  const onlyProd = [...prod.keys()].filter((k) => !stage.has(k)).sort();
  const valueDiffs = [...stage.keys()].filter((k) => prod.has(k) && prod.get(k) !== stage.get(k)).sort();
  return { onlyStage, onlyProd, valueDiffs };
}

/** One message per violation. Empty means the two sheets differ only in parameter lines. */
export function violations(stage: Sheet, prod: Sheet): string[] {
  const out: string[] = [];
  for (const [name, sheet] of [["stage", stage], ["production", prod]] as const)
    for (const k of sheet.keys()) if (FORBIDDEN_KEYS.has(k)) out.push(`${name} sheet carries forbidden key ${k}`);
  const d = diffSheets(stage, prod);
  const allowedAbsent = (k: string) => IDENTITY_KEYS.has(k);
  for (const k of d.onlyStage) if (!allowedAbsent(k)) out.push(`key ${k} is only in the stage sheet`);
  for (const k of d.onlyProd) if (!allowedAbsent(k)) out.push(`key ${k} is only in the production sheet`);
  for (const k of d.valueDiffs)
    if (!PARAMETER_KEYS.has(k) && !IDENTITY_KEYS.has(k)) out.push(`key ${k} differs and is not in the parameter allow-list`);
  return out;
}

if (import.meta.main) {
  const [stagePath, prodPath] = process.argv.slice(2);
  if (!stagePath || !prodPath) {
    console.error("usage: bun scripts/stage/sheet-diff.ts <stage-sheet> <production-sheet>");
    process.exit(64);
  }
  const v = violations(parseSheet(readFileSync(stagePath, "utf8")), parseSheet(readFileSync(prodPath, "utf8")));
  for (const m of v) console.error(`sheet-diff: ${m}`);
  if (v.length) process.exit(1);
  console.log("sheet-diff: the stage and production sheets differ only in parameter lines");
}
