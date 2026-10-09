// Frozen transaction counts keyed by core DEPLOY_SHA. Counts are measured on a rehearsal at the same SHA, then frozen in a reviewed
// data file: deployments/frozen-counts/<sha>.json. There are no hand-typed literals. Plan principle 17.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PublishError } from "./errors.ts";
import { MAINNET_CHAIN_ID } from "./chains.ts";

export type FrozenCounts = Record<string, number>;
export interface FrozenFile { deploySha: string; measured: { chainId: number; at: string; forge?: string }; counts: FrozenCounts }

export const FROZEN_DIR = "deployments/frozen-counts";
const SHA = /^[0-9a-f]{40}$/;
export function assertSha(sha: string): string {
  if (!SHA.test(sha)) throw new PublishError("USAGE", `core DEPLOY_SHA must be 40 lowercase hex characters, got '${sha}'`);
  return sha;
}
export const frozenPath = (dir: string, sha: string): string => join(dir, `${assertSha(sha)}.json`);

export function validateCounts(counts: unknown): FrozenCounts {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) throw new PublishError("COUNTS_MISSING", "frozen counts must be an object of stage name to count");
  for (const [k, v] of Object.entries(counts)) if (!Number.isInteger(v) || (v as number) < 0) throw new PublishError("COUNTS_MISSING", `frozen count '${k}' is not a non-negative integer`);
  return counts as FrozenCounts;
}

/** Loads the frozen counts for a DEPLOY_SHA. A missing file or a file for another SHA fails. */
export function loadFrozen(dir: string, sha: string): FrozenFile {
  const p = frozenPath(dir, sha);
  if (!existsSync(p)) throw new PublishError("COUNTS_MISSING", `FROZEN_COUNTS_MISSING: no frozen counts for DEPLOY_SHA ${sha}: ${p} does not exist. No counts file is committed for a SHA until its first Twin chain rehearsal has measured it. Run publish contracts --measure on the Twin chain (918453) at this SHA (refused on 8453), review ${FROZEN_DIR}/${sha}.json, then commit it. Nothing here guesses a count.`, { sha });
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (j.deploySha !== sha) throw new PublishError("COUNTS_MISSING", `${p} is for DEPLOY_SHA ${j.deploySha}, not ${sha}`, { sha });
  return { deploySha: sha, measured: j.measured, counts: validateCounts(j.counts) };
}

export const sumCounts = (c: FrozenCounts, stages?: string[]): number => (stages ?? Object.keys(c)).reduce((a, s) => a + (c[s] ?? 0), 0);

/**
 * The deployer sends the prove-control transaction (the Safe execTransaction, core 1712) between stage 10 and the stage 11 handover. It is one
 * transaction outside every stage count, so every nonce at or after the handover is the summed frozen counts plus this.
 */
export const PROOF_TX_NONCES = 1;

/** The deployer nonce at the end of the deploy stages: the summed frozen counts plus the one prove-control transaction. */
export const finalDeployerNonce = (c: FrozenCounts): number => sumCounts(c) + PROOF_TX_NONCES;

/** The count of one stage. A stage with no frozen entry fails: nothing is guessed. */
export function countFor(c: FrozenCounts, stage: string): number {
  const n = c[stage];
  if (n === undefined) throw new PublishError("COUNTS_MISSING", `the frozen counts have no entry for stage '${stage}'`, { stage });
  return n;
}

/** The deployer nonce must equal the summed frozen counts plus the prove-control transaction (or, for a named subset of stages, their sum). Any difference fails. */
export function checkNonce(actual: number, c: FrozenCounts, stages?: string[]): void {
  const want = stages ? sumCounts(c, stages) : finalDeployerNonce(c);
  if (actual !== want) throw new PublishError("NONCE", `the deployer nonce is ${actual}, the summed frozen counts say ${want}${stages ? "" : ` (${PROOF_TX_NONCES} of them is the prove-control transaction)`}`, { actual, want });
}

/** Writes a measured counts file. Refuses to change an existing file: a frozen file is reviewed data. */
export function writeFrozen(dir: string, sha: string, counts: FrozenCounts, measured: FrozenFile["measured"]): string {
  const p = frozenPath(dir, sha);
  validateCounts(counts);
  const body: FrozenFile = { deploySha: sha, measured, counts };
  if (existsSync(p)) {
    const old = JSON.parse(readFileSync(p, "utf8"));
    if (JSON.stringify(old.counts) !== JSON.stringify(counts)) throw new PublishError("COUNT_MISMATCH", `${p} already holds different counts for this SHA: a frozen file is never rewritten, review the difference`, { sha });
    return p;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", { mode: 0o644 });
  return p;
}

export type CountsMode = "frozen" | "measure-flag" | "dry-run-measure" | "twin-measure";
export interface ResolvedCounts { frozen?: FrozenCounts; measure: boolean; mode: CountsMode; file: string }

/**
 * Which counts a run uses.
 *  - a frozen file for the SHA exists: it is used (a disagreement with the dry run or the broadcast is COUNT_MISMATCH in the runner);
 *  - --measure: none (the run learns them);
 *  - the file is missing and the run is a --dry-run: none, a WARN names it (a dry run is the step that measures; nothing is written);
 *  - the file is missing, no dry run (so a dry run on 8453 preflights too) and the chain is not 8453: the run measures and writes the file under the counts dir;
 *  - the file is missing on 8453 and the run broadcasts: COUNTS_MISSING, a hard error.
 */
export function resolveCounts(o: { dir: string; sha: string; measureFlag: boolean; dryRun: boolean; chainId: number; warn?: (event: string, f: Record<string, unknown>) => void }): ResolvedCounts {
  const file = frozenPath(o.dir, o.sha);
  if (o.measureFlag) return { measure: true, mode: "measure-flag", file };
  if (existsSync(file)) return { frozen: loadFrozen(o.dir, o.sha).counts, measure: false, mode: "frozen", file };
  if (o.dryRun) {
    o.warn?.("dry_run.counts_missing", { file, note: "no frozen counts for this SHA: the dry run measures them and writes nothing" });
    return { measure: true, mode: "dry-run-measure", file };
  }
  if (o.chainId === MAINNET_CHAIN_ID) return { frozen: loadFrozen(o.dir, o.sha).counts, measure: false, mode: "frozen", file }; // throws COUNTS_MISSING
  o.warn?.("counts.measuring", { file, note: "no frozen counts for this SHA on a non-8453 chain: this run measures them and writes the file under the counts dir (review it, then commit it)" });
  return { measure: true, mode: "twin-measure", file };
}
