#!/usr/bin/env bun
// Drift check (core 1523): the counts a rehearsal measured against the committed frozen counts of the same SHA.
//   bun src/counts-drift.ts --counts counts.json [--frozen-dir deployments/frozen-counts]
// Exit 0 when no frozen file exists for the SHA or every stage count is equal. Otherwise exit 1, naming each differing stage.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { FROZEN_DIR, frozenPath } from "./counts.ts";

export function driftErrors(measured: Record<string, number>, frozen: Record<string, number>): string[] {
  const errs: string[] = [];
  for (const k of [...new Set([...Object.keys(measured), ...Object.keys(frozen)])].sort())
    if (measured[k] !== frozen[k]) errs.push(`stage ${k}: measured ${measured[k] ?? "none"}, frozen ${frozen[k] ?? "none"}`);
  return errs;
}

if (import.meta.main) {
  const { values: v } = parseArgs({ options: { counts: { type: "string" }, "frozen-dir": { type: "string" } } });
  if (!v.counts) { console.error("counts-drift: --counts FILE is required"); process.exit(2); }
  const j = JSON.parse(readFileSync(v.counts, "utf8"));
  const dir = v["frozen-dir"] ?? resolve(import.meta.dir, "../..", FROZEN_DIR);
  const p = frozenPath(dir, j.deploySha);
  if (!existsSync(p)) { console.log(`counts-drift: no frozen counts for ${j.deploySha}, nothing to compare`); process.exit(0); }
  const errs = driftErrors(j.counts, JSON.parse(readFileSync(p, "utf8")).counts);
  if (errs.length) { console.error(`counts-drift: ${errs.length} stage(s) differ from ${p}\n  ${errs.join("\n  ")}`); process.exit(1); }
  console.log(`counts-drift: counts equal ${p}`);
}
