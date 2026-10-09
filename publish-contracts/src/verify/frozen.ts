// Frozen per-stage transaction counts keyed by core DEPLOY_SHA. Counts are measured on a same-SHA rehearsal, then frozen
// in a reviewed data file. There are no hand-typed literals.
import { readFileSync } from "node:fs";

export type FrozenCounts = Record<string, number>;

/** File shape: { "<DEPLOY_SHA>": { "safe": 1, "libs": 4, ... }, ... } */
export function loadFrozenCounts(file: string, deploySha: string): FrozenCounts {
  const all = JSON.parse(readFileSync(file, "utf8"));
  const entry = all[deploySha];
  if (!entry || typeof entry !== "object") throw new Error(`no frozen counts for DEPLOY_SHA ${deploySha} in ${file}`);
  for (const [k, v] of Object.entries(entry)) if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`frozen count ${k} is not a non-negative integer`);
  return entry as FrozenCounts;
}

export const sumFrozenCounts = (c: FrozenCounts): number => Object.values(c).reduce((a, b) => a + b, 0);
