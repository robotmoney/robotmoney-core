#!/usr/bin/env bun
// The measured counts of one Twin chain rehearsal (core 1523). `publish` on the Twin chain measures the per-stage broadcast counts and writes
// <counts-dir>/<sha>.json. This tool turns that file plus the real deployer nonce into counts.json, and checks counts.json.
//   bun src/ci/rehearsal-counts.ts build --counts-dir DIR --sha SHA --nonce N --out FILE [--run-manifest publish-run.json] [--start-nonce N] [--pin-block N]
//   bun src/ci/rehearsal-counts.ts check --file FILE
//   bun src/ci/rehearsal-counts.ts check-baseline --counts-dir DIR --sha SHA   (the strict 8453 load of a frozen file, issue 1733)
//   bun src/ci/rehearsal-counts.ts pair --a FILE --b FILE   (Deploy 4: the Twin pair, two clean runs at one sha measured the same counts)
// counts.json: { deploySha, chainId, counts: { <stage>: n }, deployerNonce }. The release procedure copies `counts` into deployments/frozen-counts/<sha>.json.
// Deploy 4: `build --system fund` keeps only the fund system's stage counts and writes `system: "fund"`, so a fund counts.json is never read as a vaults one; `check`
// and `pair` check a file against the stage keys of the system it names (absent: vaults, every counts.json from before the fund system). One frozen file per sha
// holds both systems' keys (counts.ts writeFrozen adds a system's counts to it).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { PROOF_TX_NONCES, effectiveCounts, loadFrozen } from "../counts.ts";
import type { SystemName } from "../stage-table.ts";
import { loadStageTable, type StageTable } from "../stage-table.ts";
import { useStageTable, DEPLOYER_STAGES, peekStageState, restoreStageState } from "../stages.ts";

/**
 * `adopted` (issue 1721): a stage the run adopted instead of running. `deployerTxs` is what this deployer really sent for it. `counts` keeps the stage's frozen (or, in a measuring run, unmeasured) count.
 * The nonce is the start plus the sum of the counts with each adopted stage counted at `deployerTxs`, plus the prove-control transaction. A counts.json with an adopted stage is never frozen and the drift check skips it.
 * `deployerStartNonce` (issue 1727, rehearsal kind only): the deployer was not fresh. Absent: a fresh deployer, start 0.
 */
export interface AdoptedRecord { deployerTxs: number; /** Issue 1733: the adoption record of the run (library, address, code hash) from which a baseline is rebuilt. */ libraries?: { name: string; artifact: string; address: string; codeHash: string }[]; factory?: string }
export interface CountsJson { deploySha: string; chainId: number; counts: Record<string, number>; deployerNonce: number; adopted?: Record<string, AdoptedRecord>; deployerStartNonce?: number; /** The Base block the Twin fork was pinned at (issue 1733). */ pinBlock?: number;
  /** Deploy 4: the system whose stages `counts` holds. Absent: the vaults system. */ system?: SystemName; /** The job's own conclusion, added after the run (freeze-counts reads it). */ rehearsal?: { conclusion?: string } }


/** The adopted stages of a run manifest file (publish-run.json): stage -> the transactions this deployer sent for it. */
export function adoptedFromRunManifest(path: string): Record<string, AdoptedRecord> {
  if (!existsSync(path)) return {}; // no run manifest, nothing recorded as adopted: an adopted run would then fail the nonce check, loudly
  const m = JSON.parse(readFileSync(path, "utf8"));
  const out: Record<string, AdoptedRecord> = {};
  for (const [name, rec] of Object.entries<any>(m.stages ?? {})) if (rec?.status === "done" && rec.adopted === true && rec.adoption) {
    const libs = rec.adoption.libraries;
    out[name] = { deployerTxs: rec.adoption.deployerTxs, ...(Array.isArray(libs) ? { libraries: libs.map((l: any) => ({ name: l.name, artifact: l.artifact, address: l.address, codeHash: l.codeHash })), ...(rec.adoption.factory ? { factory: rec.adoption.factory } : {}) } : {}) };
  }
  return out;
}

/** `system` (Deploy 4): keep only the counts of these stage keys and name the system in the file. Absent: every count of the file, no system named (the vaults behaviour). */
export function buildCountsJson(countsDir: string, sha: string, nonce: number, adopted: Record<string, AdoptedRecord> = {}, startNonce?: number, pinBlock?: number, system?: { name: SystemName; keys: string[] }): CountsJson {
  const f = loadFrozen(countsDir, sha, { allowAdopted: true }); // the measuring run of an adopted stage marks its file; counts.json carries the marker on
  const counts = system ? Object.fromEntries(Object.entries(f.counts).filter(([k]) => system.keys.includes(k))) : f.counts;
  return { deploySha: sha, chainId: f.measured.chainId, counts, deployerNonce: nonce, ...(Object.keys(adopted).length ? { adopted } : {}), ...(startNonce ? { deployerStartNonce: startNonce } : {}), ...(pinBlock ? { pinBlock } : {}), ...(system ? { system: system.name } : {}) };
}

/** The deployer stage count keys of a system in a table. */
export function systemCountKeys(table: StageTable, system: SystemName): string[] {
  const prior = peekStageState();
  try { useStageTable(table, system); return DEPLOYER_STAGES.map((s) => s.countKey!); } finally { restoreStageState(prior); }
}

/**
 * PURE (Deploy 4). The Twin pair: two clean runs at one sha. Each file must pass its own check, both must be green (rehearsal.conclusion success, written after the
 * run), and they must agree on the sha, the chain, the system and every stage count. A difference means the counts are not reproducible, so neither is frozen.
 */
export function pairProblems(a: CountsJson, b: CountsJson, keysOf: (system: SystemName) => string[]): string[] {
  const errs: string[] = [];
  for (const [n, j] of [["a", a], ["b", b]] as const) {
    for (const e of checkCountsJson(j, keysOf(j.system ?? "vaults"))) errs.push(`${n}: ${e}`);
    if (j.rehearsal?.conclusion !== "success") errs.push(`${n}: the run did not conclude success (rehearsal.conclusion is ${JSON.stringify(j.rehearsal?.conclusion ?? null)})`);
  }
  if (a.deploySha !== b.deploySha) errs.push(`the two runs are at different shas: ${a.deploySha} and ${b.deploySha}`);
  if (a.chainId !== b.chainId) errs.push(`the two runs are on different chains: ${a.chainId} and ${b.chainId}`);
  if ((a.system ?? "vaults") !== (b.system ?? "vaults")) errs.push(`the two runs are of different systems: ${a.system ?? "vaults"} and ${b.system ?? "vaults"}`);
  for (const k of [...new Set([...Object.keys(a.counts ?? {}), ...Object.keys(b.counts ?? {})])].sort()) if (a.counts?.[k] !== b.counts?.[k]) errs.push(`stage ${k}: ${a.counts?.[k] ?? "none"} in a, ${b.counts?.[k] ?? "none"} in b`);
  return errs;
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
  const { positionals, values: v } = parseArgs({ allowPositionals: true, options: { "counts-dir": { type: "string" }, sha: { type: "string" }, nonce: { type: "string" }, "start-nonce": { type: "string" }, "pin-block": { type: "string" }, out: { type: "string" }, file: { type: "string" }, "run-manifest": { type: "string" }, system: { type: "string" }, a: { type: "string" }, b: { type: "string" } } });
  const root = new URL("../../../", import.meta.url).pathname;
  const systemOf = (s: string | undefined): SystemName | undefined => {
    if (s === undefined) return undefined;
    if (s !== "vaults" && s !== "fund" && s !== "gateway") throw new Error(`--system is vaults, fund or gateway, got '${s}'`);
    return s;
  };
  try {
    if (positionals[0] === "build") {
      const nonce = Number(v.nonce);
      if (!v["counts-dir"] || !v.sha || !v.out || !Number.isInteger(nonce)) throw new Error("build needs --counts-dir --sha --nonce --out");
      const sys = systemOf(v.system);
      const system = sys ? { name: sys, keys: systemCountKeys(loadStageTable(root), sys) } : undefined;
      writeFileSync(v.out, JSON.stringify(buildCountsJson(v["counts-dir"], v.sha, nonce, v["run-manifest"] ? adoptedFromRunManifest(v["run-manifest"]) : {}, v["start-nonce"] === undefined ? undefined : Number(v["start-nonce"]), v["pin-block"] ? Number(v["pin-block"]) : undefined, system), null, 2) + "\n");
    } else if (positionals[0] === "check") {
      if (!v.file) throw new Error("check needs --file");
      const j = JSON.parse(readFileSync(v.file, "utf8")) as CountsJson;
      const sys = systemOf(j.system) ?? "vaults"; // a counts.json names its system; one from before the fund system is the vaults system's
      const errs = checkCountsJson(j, systemCountKeys(loadStageTable(root), sys));
      if (errs.length) throw new Error(errs.join("; "));
      console.log(`counts.json ok: ${v.file}${j.system ? ` (system ${j.system})` : ""}`);
    } else if (positionals[0] === "pair") {
      if (!v.a || !v.b) throw new Error("pair needs --a FILE --b FILE");
      const table = loadStageTable(root);
      const [a, b] = [v.a, v.b].map((f) => JSON.parse(readFileSync(f, "utf8")) as CountsJson);
      for (const j of [a!, b!]) systemOf(j.system);
      const errs = pairProblems(a!, b!, (s) => systemCountKeys(table, s));
      if (errs.length) throw new Error(`the Twin pair differs or is not green: ${errs.join("; ")}`);
      console.log(`twin pair ok: ${a!.system ?? "vaults"} system at ${a!.deploySha}, ${Object.keys(a!.counts).length} stage counts equal in both runs`);
    } else if (positionals[0] === "check-baseline") {
      // The strict load a run on 8453 does (no allowAdopted), for the file the freeze verb wrote. A marked or unverifiable file fails here.
      if (!v["counts-dir"] || !v.sha) throw new Error("check-baseline needs --counts-dir --sha");
      const root = new URL("../../../", import.meta.url).pathname;
      useStageTable(loadStageTable(root));
      const f = loadFrozen(v["counts-dir"], v.sha);
      console.log(`baseline ok: ${v.sha} loads as frozen counts${f.measured.reconstructed ? ` (reconstructed: ${f.measured.reconstructed.adopted.length} adopted creation(s))` : ""}`);
    } else throw new Error("usage: build|check|check-baseline|pair");
  } catch (e) { console.error(`rehearsal-counts: ${(e as Error).message}`); process.exit(1); }
}
