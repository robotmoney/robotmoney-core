#!/usr/bin/env bun
// Drift check (core 1523): the counts a rehearsal measured against the committed frozen counts of the same SHA.
//   bun src/counts-drift.ts --counts counts.json [--frozen-dir deployments/frozen-counts]
// Exit 0 when no frozen file exists for the SHA or every stage count is equal. Otherwise exit 1, naming each differing stage.
// Deploy 4: one frozen file per sha holds every system's keys. A counts.json that names its system (rehearsal-counts build --system fund) is compared with that
// system's stage counts of the file only; a counts.json that names none is compared with the whole file, as before.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { FROZEN_DIR, frozenPath } from "./counts.ts";
import { loadStageTable, type SystemName } from "./stage-table.ts";
import { systemCountKeys } from "./ci/rehearsal-counts.ts";

/** `adopted` (issue 1721): stages the rehearsal adopted instead of running. Nothing was measured for them, so they are not compared. */
export function driftErrors(measured: Record<string, number>, frozen: Record<string, number>, adopted: string[] = []): string[] {
  const errs: string[] = [];
  for (const k of [...new Set([...Object.keys(measured), ...Object.keys(frozen)])].sort())
    if (!adopted.includes(k) && measured[k] !== frozen[k]) errs.push(`stage ${k}: measured ${measured[k] ?? "none"}, frozen ${frozen[k] ?? "none"}`);
  return errs;
}

if (import.meta.main) {
  const { values: v } = parseArgs({ options: { counts: { type: "string" }, "frozen-dir": { type: "string" } } });
  if (!v.counts) { console.error("counts-drift: --counts FILE is required"); process.exit(2); }
  const j = JSON.parse(readFileSync(v.counts, "utf8"));
  const dir = v["frozen-dir"] ?? resolve(import.meta.dir, "../..", FROZEN_DIR);
  const p = frozenPath(dir, j.deploySha);
  if (!existsSync(p)) { console.log(`counts-drift: no frozen counts for ${j.deploySha}, nothing to compare`); process.exit(0); }
  const committed = JSON.parse(readFileSync(p, "utf8"));
  if (Array.isArray(committed.measured?.adopted) && committed.measured.adopted.length > 0) { console.error(`counts-drift: ${p} is marked as measured with adopted stage(s) ${committed.measured.adopted.join(", ")}: it is not a frozen file`); process.exit(1); }
  let frozen: Record<string, number> = JSON.parse(readFileSync(p, "utf8")).counts;
  if (j.system !== undefined) {
    if (!["vaults", "fund", "gateway"].includes(j.system)) { console.error(`counts-drift: ${v.counts} names an unknown system '${j.system}'`); process.exit(2); }
    const keys = systemCountKeys(loadStageTable(resolve(import.meta.dir, "../..")), j.system as SystemName);
    frozen = Object.fromEntries(Object.entries(frozen).filter(([k]) => keys.includes(k)));
  }
  const errs = driftErrors(j.counts, frozen, Object.keys(j.adopted ?? {}));
  if (errs.length) { console.error(`counts-drift: ${errs.length} stage(s) differ from ${p}\n  ${errs.join("\n  ")}`); process.exit(1); }
  console.log(`counts-drift: counts equal ${p}${j.system ? ` (the ${j.system} system's stages)` : ""}${Object.keys(j.adopted ?? {}).length ? ` (adopted, not compared: ${Object.keys(j.adopted).join(", ")})` : ""}`);
}
