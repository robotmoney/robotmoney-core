#!/usr/bin/env bun
// The measured counts of one Twin chain rehearsal (core 1523). `publish` on the Twin chain measures the per-stage broadcast counts and writes
// <counts-dir>/<sha>.json. This tool turns that file plus the real deployer nonce into counts.json, and checks counts.json.
//   bun src/ci/rehearsal-counts.ts build --counts-dir DIR --sha SHA --nonce N --out FILE [--run-manifest publish-run.json] [--start-nonce N]
//   bun src/ci/rehearsal-counts.ts check --file FILE
// counts.json: { deploySha, chainId, counts: { <stage>: n }, deployerNonce }. The release procedure copies `counts` into deployments/frozen-counts/<sha>.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROOF_TX_NONCES, effectiveCounts, loadFrozen } from "../counts.ts";
import { loadStageTable } from "../stage-table.ts";
import { useStageTable, DEPLOYER_STAGES } from "../stages.ts";

/**
 * `adopted` (issue 1721): a stage the run adopted instead of running. `deployerTxs` is what this deployer really sent for it. `counts` keeps the stage's frozen (or, in a measuring run, unmeasured) count.
 * The nonce is the start plus the sum of the counts with each adopted stage counted at `deployerTxs`, plus the prove-control transaction. A counts.json with an adopted stage is never frozen and the drift check skips it.
 * `deployerStartNonce` (issue 1727, rehearsal kind only): the deployer was not fresh. Absent: a fresh deployer, start 0.
 */
export interface CountsJson { deploySha: string; chainId: number; counts: Record<string, number>; deployerNonce: number; adopted?: Record<string, { deployerTxs: number }>; deployerStartNonce?: number }


/** The adopted stages of a run manifest file (publish-run.json): stage -> the transactions this deployer sent for it. */
export function adoptedFromRunManifest(path: string): Record<string, { deployerTxs: number }> {
  if (!existsSync(path)) return {}; // no run manifest, nothing recorded as adopted: an adopted run would then fail the nonce check, loudly
  const m = JSON.parse(readFileSync(path, "utf8"));
  const out: Record<string, { deployerTxs: number }> = {};
  for (const [name, rec] of Object.entries<any>(m.stages ?? {})) if (rec?.status === "done" && rec.adopted === true && rec.adoption) out[name] = { deployerTxs: rec.adoption.deployerTxs };
  return out;
}

export function buildCountsJson(countsDir: string, sha: string, nonce: number, adopted: Record<string, { deployerTxs: number }> = {}, startNonce?: number): CountsJson {
  const f = loadFrozen(countsDir, sha, { allowAdopted: true }); // the measuring run of an adopted stage marks its file; counts.json carries the marker on
  return { deploySha: sha, chainId: f.measured.chainId, counts: f.counts, deployerNonce: nonce, ...(Object.keys(adopted).length ? { adopted } : {}), ...(startNonce ? { deployerStartNonce: startNonce } : {}) };
}

/** Returns the problems of a counts.json: the keys must equal the deployer stage names and the nonce the sum of the counts plus the prove-control transaction. */
export function checkCountsJson(j: CountsJson, stageKeys: string[]): string[] {
  const errs: string[] = [];
  const have = Object.keys(j.counts ?? {}).sort();
  const want = [...stageKeys].sort();
  for (const k of want) if (!have.includes(k)) errs.push(`counts has no entry for stage ${k}`);
  for (const k of have) if (!want.includes(k)) errs.push(`counts has an entry for ${k}, which is not a stage`);
  for (const [k, v] of Object.entries(j.counts ?? {})) if (!Number.isInteger(v) || v < 0) errs.push(`count of ${k} is not a non-negative integer`);
  let counts = j.counts ?? {};
  const adopted = Object.fromEntries(Object.entries(j.adopted ?? {}).map(([k, v]) => [k, (v as { deployerTxs: number }).deployerTxs]));
  try { counts = effectiveCounts(counts, adopted); } catch (e) { errs.push((e as Error).message); }
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  const adoptedNote = Object.keys(adopted).length ? ` (adopted stages counted at the transactions this deployer sent: ${Object.entries(adopted).map(([k, v]) => `${k} ${v}`).join(", ")})` : "";
  const start = j.deployerStartNonce ?? 0;
  if (!Number.isInteger(start) || start < 0) errs.push(`deployerStartNonce ${String(j.deployerStartNonce)} is not a non-negative integer`);
  else if (j.deployerNonce !== start + sum + PROOF_TX_NONCES) errs.push(`deployerNonce ${j.deployerNonce} differs from ${start ? `the start nonce ${start} plus ` : ""}the sum of counts ${sum} plus the prove-control transaction (${PROOF_TX_NONCES})${adoptedNote}`);
  return errs;
}

if (import.meta.main) {
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: { "counts-dir": { type: "string" }, sha: { type: "string" }, nonce: { type: "string" }, "start-nonce": { type: "string" }, out: { type: "string" }, file: { type: "string" }, "run-manifest": { type: "string" } } });
  try {
    if (positionals[0] === "build") {
      const nonce = Number(v.nonce);
      if (!v["counts-dir"] || !v.sha || !v.out || !Number.isInteger(nonce)) throw new Error("build needs --counts-dir --sha --nonce --out");
      writeFileSync(v.out, JSON.stringify(buildCountsJson(v["counts-dir"], v.sha, nonce, v["run-manifest"] ? adoptedFromRunManifest(v["run-manifest"]) : {}, v["start-nonce"] === undefined ? undefined : Number(v["start-nonce"])), null, 2) + "\n");
    } else if (positionals[0] === "check") {
      if (!v.file) throw new Error("check needs --file");
      const root = new URL("../../../", import.meta.url).pathname;
      useStageTable(loadStageTable(root));
      const errs = checkCountsJson(JSON.parse(readFileSync(v.file, "utf8")), DEPLOYER_STAGES.map((s) => s.countKey!));
      if (errs.length) throw new Error(errs.join("; "));
      console.log(`counts.json ok: ${v.file}`);
    } else throw new Error("usage: build|check");
  } catch (e) { console.error(`rehearsal-counts: ${(e as Error).message}`); process.exit(1); }
}
