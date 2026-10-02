#!/usr/bin/env bun
// Twin chain run report: prints what a publish contracts run on the Twin chain (918453) produced.
// Inputs are the run's artifacts only: the stage manifests the driver wrote, the run manifest
// (publish-run.json, per-stage transaction counts) and the verifier output (labels). The stage names,
// manifest file names and vault set come from scripts/deploy/stage-table.json, the one source of truth.
// Nothing is hard-coded here.
//
// Prints: stages (manifest present or missing, tx count), the vault set (key, artifact, address),
// the verifier labels (PASS and FAIL), and the merged manifest the assertion scripts read.
// Exit 0 when every stage manifest and every vault address is present and no label failed. Exit 1 otherwise.
// Exit 64 on usage.
//
// Usage:
//   bun scripts/stage/twin-run-report.ts --manifest-dir DIR [--run-manifest FILE] [--labels FILE]
//        [--table FILE] [--merged-out FILE] [--json-out FILE]
// Canonical: the one-deployment-scheme plan (S9; core 1488, 1485, 1486).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { keyOf, loadStageTable, mergeManifests, stagesFromTable, type StageTable } from "../deploy/core-stages.ts";
import { parseLabels } from "./label-diff.ts";

export interface StageRow {
  stage: string;
  manifest: string;
  present: boolean;
  txCount: number | null;
}
export interface VaultRow {
  key: string;
  artifact: string;
  address: string | null;
}
export interface LabelRow {
  label: string;
  ok: boolean;
}
export interface Report {
  stages: StageRow[];
  totalTx: number;
  vaults: VaultRow[];
  labels: LabelRow[];
  merged: Record<string, unknown>;
  problems: string[];
}

export interface Inputs {
  table: StageTable;
  /** stage manifest file name (basename) to parsed JSON. A missing file is absent from the map. */
  manifests: Record<string, Record<string, unknown>>;
  /** parsed publish-run.json, if any */
  runManifest?: { stages?: Record<string, { count?: number; broadcastCount?: number }> } | null;
  /** raw verifier output, if any */
  labelsText?: string | null;
}

/** Parse verifier output into pass/fail rows. A line that starts with FAIL is a failure. */
export function labelRows(text: string): LabelRow[] {
  const rows: LabelRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let ok: boolean | null = null;
    if (/^FAIL\s/.test(line)) ok = false;
    else if (/^PASS\s/.test(line)) ok = true;
    else if (line.startsWith("{")) {
      try {
        const j = JSON.parse(line);
        if (typeof j.label === "string") ok = j.ok !== false;
      } catch {
        // not a label row
      }
    }
    if (ok === null) continue;
    const label = parseLabels(line)[0];
    if (label) rows.push({ label, ok });
  }
  return rows;
}

/** Pure: build the report from parsed inputs. */
export function buildReport(inp: Inputs): Report {
  const problems: string[] = [];
  const stages: StageRow[] = [];
  const parts: Record<string, unknown>[] = [];
  const runStages = inp.runManifest?.stages ?? {};
  const runnerStages = stagesFromTable(inp.table);

  for (const row of inp.table.stages) {
    const file = row.manifest.split("/").pop()!;
    const m = inp.manifests[file];
    const rec = runStages[row.name];
    const txCount = rec ? (rec.count ?? rec.broadcastCount ?? null) : null;
    stages.push({ stage: row.name, manifest: file, present: !!m, txCount });
    if (!m) {
      problems.push(`stage ${row.name}: manifest ${file} is missing`);
      continue;
    }
    const rs = runnerStages.find((s) => s.name === row.name)!;
    const namespaced: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m)) namespaced[keyOf(rs, k)] = v;
    parts.push(namespaced);
  }
  let merged: Record<string, unknown> = {};
  try {
    merged = mergeManifests(parts);
  } catch (e) {
    problems.push(String((e as Error).message));
  }
  if (inp.runManifest) {
    const counted = stages.filter((s) => s.txCount !== null);
    if (counted.length === 0) problems.push("the run manifest holds no per-stage transaction counts");
  }

  const vaults: VaultRow[] = inp.table.vaults.map((v) => {
    const m = inp.manifests[v.manifest.split("/").pop()!];
    const addr = m && typeof m.vault === "string" && m.vault !== "" ? m.vault : null;
    if (!addr) problems.push(`vault ${v.key} (${v.artifact}): no address in ${v.manifest.split("/").pop()}`);
    return { key: v.key, artifact: v.artifact, address: addr };
  });

  const labels = inp.labelsText ? labelRows(inp.labelsText) : [];
  if (inp.labelsText !== undefined && inp.labelsText !== null) {
    if (labels.length === 0) problems.push("the verifier output holds no labels");
    for (const l of labels) if (!l.ok) problems.push(`verifier label failed: ${l.label}`);
  }
  const totalTx = stages.reduce((n, s) => n + (s.txCount ?? 0), 0);
  return { stages, totalTx, vaults, labels, merged, problems };
}

export function render(r: Report): string {
  const out: string[] = [];
  out.push("Twin chain run report (918453)");
  out.push("");
  out.push("Stages");
  for (const s of r.stages) out.push(`  ${s.stage.padEnd(11)} ${s.present ? "manifest" : "MISSING "} ${s.manifest.padEnd(26)} tx ${s.txCount ?? "n/a"}`);
  out.push(`  total transactions: ${r.totalTx}`);
  out.push("");
  out.push("Vault set");
  for (const v of r.vaults) out.push(`  ${v.key.padEnd(6)} ${v.artifact.padEnd(20)} ${v.address ?? "MISSING"}`);
  out.push("");
  const pass = r.labels.filter((l) => l.ok).length;
  out.push(`Verifier labels: ${pass} pass, ${r.labels.length - pass} fail`);
  for (const l of r.labels) out.push(`  ${l.ok ? "PASS" : "FAIL"} ${l.label}`);
  out.push("");
  out.push("A short-delay Twin chain run shows that the scripts execute and that only parameters differ.");
  out.push("It does not prove the real timelock delay. Governance timing is proven on 8453 at 48 hours.");
  if (r.problems.length) {
    out.push("");
    out.push("Problems");
    for (const p of r.problems) out.push(`  ${p}`);
  }
  return out.join("\n") + "\n";
}

function readJson(path: string): Record<string, unknown> | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

/** Reads every stage manifest the table names from `dir`. */
export function loadManifests(table: StageTable, dir: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const s of table.stages) {
    const file = s.manifest.split("/").pop()!;
    const m = readJson(join(dir, file));
    if (m) out[file] = m;
  }
  return out;
}

function main(): number {
  let v: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values: v } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        "manifest-dir": { type: "string" },
        "run-manifest": { type: "string" },
        labels: { type: "string" },
        table: { type: "string" },
        "merged-out": { type: "string" },
        "json-out": { type: "string" },
      },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\nusage: bun scripts/stage/twin-run-report.ts --manifest-dir DIR [--run-manifest F] [--labels F] [--merged-out F] [--json-out F]`);
    return 64;
  }
  if (!v["manifest-dir"]) {
    console.error("--manifest-dir is required");
    return 64;
  }
  const table = loadStageTable(v.table as string | undefined);
  let labelsText: string | null | undefined;
  if (v.labels) {
    if (!existsSync(v.labels as string)) {
      console.error(`verifier labels file ${v.labels} does not exist`);
      return 1;
    }
    labelsText = readFileSync(v.labels as string, "utf8");
  }
  const report = buildReport({
    table,
    manifests: loadManifests(table, v["manifest-dir"] as string),
    runManifest: v["run-manifest"] ? (readJson(v["run-manifest"] as string) as Inputs["runManifest"]) : null,
    labelsText,
  });
  if (v["merged-out"]) writeFileSync(v["merged-out"] as string, JSON.stringify({ ...report.merged, stages: report.stages.map((s) => ({ stage: s.stage, tx_count: s.txCount ?? 0 })) }, null, 2) + "\n");
  if (v["json-out"]) writeFileSync(v["json-out"] as string, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(render(report));
  return report.problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(main());
