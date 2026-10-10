#!/usr/bin/env bun
// The measured counts of one Twin chain rehearsal (core 1523). `publish` on the Twin chain measures the per-stage broadcast counts and writes
// <counts-dir>/<sha>.json. This tool turns that file plus the real deployer nonce into counts.json, and checks counts.json.
//   bun src/ci/rehearsal-counts.ts build --counts-dir DIR --sha SHA --nonce N --out FILE
//   bun src/ci/rehearsal-counts.ts check --file FILE
// counts.json: { deploySha, chainId, counts: { <stage>: n }, deployerNonce }. The release procedure copies `counts` into deployments/frozen-counts/<sha>.json.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROOF_TX_NONCES, loadFrozen } from "../counts.ts";
import { loadStageTable } from "../stage-table.ts";
import { useStageTable, DEPLOYER_STAGES } from "../stages.ts";

/** `deployerStartNonce` (issue 1727, rehearsal kind only): the deployer was not fresh, so the nonce is that start plus the sum of the counts plus the prove-control transaction. Absent: a fresh deployer, start 0. */
export interface CountsJson { deploySha: string; chainId: number; counts: Record<string, number>; deployerNonce: number; deployerStartNonce?: number }

export function buildCountsJson(countsDir: string, sha: string, nonce: number, startNonce?: number): CountsJson {
  const f = loadFrozen(countsDir, sha);
  return { deploySha: sha, chainId: f.measured.chainId, counts: f.counts, deployerNonce: nonce, ...(startNonce ? { deployerStartNonce: startNonce } : {}) };
}

/** Returns the problems of a counts.json: the keys must equal the deployer stage names and the nonce the sum of the counts plus the prove-control transaction. */
export function checkCountsJson(j: CountsJson, stageKeys: string[]): string[] {
  const errs: string[] = [];
  const have = Object.keys(j.counts ?? {}).sort();
  const want = [...stageKeys].sort();
  for (const k of want) if (!have.includes(k)) errs.push(`counts has no entry for stage ${k}`);
  for (const k of have) if (!want.includes(k)) errs.push(`counts has an entry for ${k}, which is not a stage`);
  for (const [k, v] of Object.entries(j.counts ?? {})) if (!Number.isInteger(v) || v < 0) errs.push(`count of ${k} is not a non-negative integer`);
  const sum = Object.values(j.counts ?? {}).reduce((a, b) => a + b, 0);
  const start = j.deployerStartNonce ?? 0;
  if (!Number.isInteger(start) || start < 0) errs.push(`deployerStartNonce ${String(j.deployerStartNonce)} is not a non-negative integer`);
  else if (j.deployerNonce !== start + sum + PROOF_TX_NONCES) errs.push(`deployerNonce ${j.deployerNonce} differs from ${start ? `the start nonce ${start} plus ` : ""}the sum of counts ${sum} plus the prove-control transaction (${PROOF_TX_NONCES})`);
  return errs;
}

if (import.meta.main) {
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: { "counts-dir": { type: "string" }, sha: { type: "string" }, nonce: { type: "string" }, "start-nonce": { type: "string" }, out: { type: "string" }, file: { type: "string" } } });
  try {
    if (positionals[0] === "build") {
      const nonce = Number(v.nonce);
      if (!v["counts-dir"] || !v.sha || !v.out || !Number.isInteger(nonce)) throw new Error("build needs --counts-dir --sha --nonce --out");
      writeFileSync(v.out, JSON.stringify(buildCountsJson(v["counts-dir"], v.sha, nonce, v["start-nonce"] === undefined ? undefined : Number(v["start-nonce"])), null, 2) + "\n");
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
