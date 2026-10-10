// Frozen transaction counts keyed by core DEPLOY_SHA. Counts are measured on a rehearsal at the same SHA, then frozen in a reviewed
// data file: deployments/frozen-counts/<sha>.json. There are no hand-typed literals. Plan principle 17.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PublishError } from "./errors.ts";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "./chains.ts";
import { verifyReconstruction, type Reconstruction } from "./counts-reconstruct.ts";
import { getStageTable } from "./stages.ts";

export type FrozenCounts = Record<string, number>;
export interface FrozenFile { deploySha: string; measured: { chainId: number; at: string; forge?: string; /** Stages the measuring run ADOPTED (issue 1721): their counts are not measurements. */ adopted?: string[];
  /** Issue 1733: a BASELINE rebuilt from an adopted measuring run (counts-reconstruct.ts). Not a pure measurement; verified against the stage table on every load. */
  reconstructed?: Reconstruction;
  /** Issue 1733: the earlier frozen file a reconstructed baseline was cross-checked against (its sha and the sha256 of its bytes). Mandatory when an earlier file exists. */
  crossChecked?: { sha: string; fileHash: string } }; counts: FrozenCounts }

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

/**
 * Reads and checks one frozen file (any path). The file must carry `sha`, must not be marked adopted, and a reconstructed baseline (issue 1733) must pass
 * verifyReconstruction against the loaded stage table. A reconstruction that cannot be checked (no stage table loaded) is refused: nothing is assumed.
 */
export function loadFrozenFile(p: string, sha: string, o: { allowAdopted?: boolean } = {}): FrozenFile {
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (j.deploySha !== sha) throw new PublishError("COUNTS_MISSING", `${p} is for DEPLOY_SHA ${j.deploySha}, not ${sha}`, { sha });
  if (!o.allowAdopted && Array.isArray(j.measured?.adopted) && j.measured.adopted.length > 0) throw new PublishError("COUNTS_MISSING", `${p} was written by a run that ADOPTED stage(s) ${j.measured.adopted.join(", ")} (already on chain, not run): their counts were never measured, so it is not a frozen file. Rebuild the baseline from the counts.json of that run: bun publish-contracts/scripts/freeze-counts.ts --from-adopted-run counts.json --sha ${sha} --rpc <url> (issue 1733). Delete this file before rerunning.`, { sha, adopted: j.measured.adopted });
  const file: FrozenFile = { deploySha: sha, measured: j.measured, counts: validateCounts(j.counts) };
  if (j.measured?.reconstructed !== undefined) {
    let table;
    try { table = getStageTable(); } catch { throw new PublishError("COUNTS_MISSING", `${p} is a reconstructed baseline but no stage table is loaded, so it cannot be verified: it is refused`, { sha }); }
    verifyReconstruction(file, table);
  }
  return file;
}

export const fileHashOf = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** The other frozen files of a directory (40 hex names, not `sha`), each loaded strictly. A file that does not load is an error: an anchor is never skipped. */
export function otherFrozenFiles(dir: string, sha: string): { sha: string; file: FrozenFile; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => /^[0-9a-f]{40}\.json$/.test(n) && n !== `${sha}.json`).sort().map((n) => {
    const path = join(dir, n), s = n.slice(0, 40);
    return { sha: s, file: loadFrozenFile(path, s), path };
  });
}

/** The most recent earlier frozen file (by `measured.at`) of the directory, or none. */
export function latestOtherFrozen(dir: string, sha: string, before?: string): { sha: string; file: FrozenFile; path: string } | undefined {
  return otherFrozenFiles(dir, sha).filter((o) => before === undefined || String(o.file.measured.at) < before).sort((a, b) => String(a.file.measured.at).localeCompare(String(b.file.measured.at))).pop();
}

/** Loads the frozen counts for a DEPLOY_SHA. A missing file or a file for another SHA fails. */
export function loadFrozen(dir: string, sha: string, o: { allowAdopted?: boolean } = {}): FrozenFile {
  const p = frozenPath(dir, sha);
  if (!existsSync(p)) throw new PublishError("COUNTS_MISSING", `FROZEN_COUNTS_MISSING: no frozen counts for DEPLOY_SHA ${sha}: ${p} does not exist. No counts file is committed for a SHA until its first Twin chain rehearsal has measured it. Run publish contracts --measure on the Twin chain (918453) at this SHA (refused on 8453), then commit ${FROZEN_DIR}/${sha}.json: review a measurement that ran every stage, or, when the run ADOPTED the CREATE2 libraries (every Twin fork since Base block 52401633), rebuild the baseline with freeze-counts --from-adopted-run (issue 1733). Nothing here guesses a count.`, { sha });
  const f = loadFrozenFile(p, sha, o);
  if (f.measured.reconstructed) {
    // Issue 1733: the counts of the stages that adopted nothing come from a Twin counts.json nobody can prove untampered offline. The earlier release is the independent anchor,
    // so a reconstructed baseline written while an earlier frozen file exists must say it was cross-checked against it (and the file must still be the one that was checked).
    const earlier = latestOtherFrozen(dir, sha, String(f.measured.at));
    const cc = f.measured.crossChecked;
    if (earlier && !cc) throw new PublishError("COUNTS_MISSING", `${p} is a reconstructed baseline with no crossChecked record, but the earlier frozen file ${earlier.sha} exists: rebuild it with freeze-counts --from-adopted-run (the cross-check against the previous release is mandatory)`, { sha, earlier: earlier.sha });
    if (cc) {
      const there = join(dir, `${cc.sha}.json`);
      if (existsSync(there) && fileHashOf(readFileSync(there)) !== cc.fileHash) throw new PublishError("COUNTS_MISSING", `${p} was cross-checked against ${cc.sha}, whose file has changed since (hash differs)`, { sha, against: cc.sha });
    }
  }
  return f;
}

export const sumCounts = (c: FrozenCounts, stages?: string[]): number => (stages ?? Object.keys(c)).reduce((a, s) => a + (c[s] ?? 0), 0);

/**
 * The deployer sends the prove-control transaction (the Safe execTransaction, core 1712) between stage 10 and the stage 11 handover. It is one
 * transaction outside every stage count, so every nonce at or after the handover is the summed frozen counts plus this.
 */
export const PROOF_TX_NONCES = 1;

/** The deployer nonce at the end of the deploy stages: the summed frozen counts plus the one prove-control transaction. */
export const finalDeployerNonce = (c: FrozenCounts, startNonce = 0): number => startNonce + sumCounts(c) + PROOF_TX_NONCES;

/**
 * Adopted stages (issue 1721). A stage whose contracts already sit on chain (the permissionless CREATE2 libraries) plans zero transactions, so the stage is
 * ADOPTED rather than run. `adopted` maps the stage to the number of transactions THIS deployer really sent for it: 0 on a Twin fork (the library came with the
 * pinned mainnet state), the whole frozen count on a resume where the deployer's own transaction had already landed.
 * The expected deployer nonce counts that number and not the frozen count. With nothing adopted the frozen counts come back untouched, so the normal path is unchanged.
 */
export type AdoptedTxs = Record<string, number>;
export function effectiveCounts(c: FrozenCounts, adopted: AdoptedTxs = {}): FrozenCounts {
  const keys = Object.keys(adopted);
  if (keys.length === 0) return c;
  const out: FrozenCounts = { ...c };
  for (const k of keys) {
    const sent = adopted[k];
    if (!(k in c)) throw new PublishError("LIBS_ADOPTION", `stage '${k}' is recorded as adopted but has no frozen count`, { stage: k });
    if (!Number.isInteger(sent) || sent! < 0 || sent! > c[k]!) throw new PublishError("LIBS_ADOPTION", `stage '${k}' is adopted with ${String(sent)} deployer transactions, outside 0 to its count ${c[k]}`, { stage: k, sent, count: c[k] });
    out[k] = sent!;
  }
  return out;
}

/** The count of one stage. A stage with no frozen entry fails: nothing is guessed. */
export function countFor(c: FrozenCounts, stage: string): number {
  const n = c[stage];
  if (n === undefined) throw new PublishError("COUNTS_MISSING", `the frozen counts have no entry for stage '${stage}'`, { stage });
  return n;
}

/**
 * The deployer nonce must equal the summed frozen counts plus the prove-control transaction (or, for a named subset of stages, their sum). Any difference fails.
 * `startNonce` (issue 1727) is the deployer nonce the run started at: 0 for a fresh deployer (production, always), the nonce the run manifest recorded at the
 * first deployer stage for a rehearsal that reuses a deployer.
 */
export function checkNonce(actual: number, c: FrozenCounts, stages?: string[], startNonce = 0): void {
  const want = startNonce + (stages ? sumCounts(c, stages) : sumCounts(c) + PROOF_TX_NONCES);
  if (actual !== want) throw new PublishError("NONCE", `the deployer nonce is ${actual}, the summed frozen counts say ${want}${startNonce ? ` (start nonce ${startNonce} recorded at the first stage)` : ""}${stages ? "" : ` (${PROOF_TX_NONCES} of them is the prove-control transaction)`}`, { actual, want, startNonce });
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
  // A Twin measuring run that adopted a stage marks its file (issue 1721). Its own follow-on verbs (verify, govern) read it back; on the Twin chain only (918453): every other chain, 8453 included, refuses it.
  if (existsSync(file)) return { frozen: loadFrozen(o.dir, o.sha, { allowAdopted: o.chainId === TWIN_CHAIN_ID }).counts, measure: false, mode: "frozen", file };
  if (o.dryRun) {
    o.warn?.("dry_run.counts_missing", { file, note: "no frozen counts for this SHA: the dry run measures them and writes nothing" });
    return { measure: true, mode: "dry-run-measure", file };
  }
  if (o.chainId === MAINNET_CHAIN_ID) return { frozen: loadFrozen(o.dir, o.sha).counts, measure: false, mode: "frozen", file }; // throws COUNTS_MISSING
  o.warn?.("counts.measuring", { file, note: "no frozen counts for this SHA on a non-8453 chain: this run measures them and writes the file under the counts dir (review it, then commit it)" });
  return { measure: true, mode: "twin-measure", file };
}
