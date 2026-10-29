// Frozen transaction counts keyed by core DEPLOY_SHA. Counts are measured on a rehearsal at the same SHA, then frozen in a reviewed
// data file: deployments/frozen-counts/<sha>.json. There are no hand-typed literals. Plan principle 17.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { PublishError } from "./errors.ts";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "./chains.ts";
import { crossCheckDiff, verifyReconstruction, type Reconstruction } from "./counts-reconstruct.ts";
import { DEPLOYER_STAGES, getStageTable, proofTxNonces } from "./stages.ts";
import { TABLE_REL, parseStageTable, type StageTable } from "./stage-table.ts";
import { gitEnv } from "./git-env.ts";

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
 * Issue 1926: the stage table a HISTORICAL frozen file was written for, read from git at the file's own DEPLOY_SHA (`git show <sha>:scripts/deploy/stage-table.json`
 * in the repository that holds the file). Undefined when that repository or commit is not available (a scratch copy of the directory, a shallow clone): the caller
 * then checks against the loaded table, as before.
 */
export function stageTableAtSha(fileDir: string, sha: string): StageTable | undefined {
  let r: ReturnType<typeof Bun.spawnSync>;
  try { r = Bun.spawnSync(["git", "--no-replace-objects", "-C", fileDir, "show", `${assertSha(sha)}:${TABLE_REL}`], { stdout: "pipe", stderr: "pipe", env: gitEnv() }); } catch { return undefined; }
  if (r.exitCode !== 0) return undefined;
  let json: unknown;
  try { json = JSON.parse(r.stdout!.toString()); } catch { return undefined; }
  return parseStageTable(json, `${sha}:${TABLE_REL}`); // a table that does not parse is an error, never skipped
}

/**
 * Reads and checks one frozen file (any path). The file must carry `sha`, must not be marked adopted, and a reconstructed baseline (issue 1733) must pass
 * verifyReconstruction against the loaded stage table. A reconstruction that cannot be checked (no stage table loaded) is refused: nothing is assumed.
 * `historical` (issue 1926): the file is an EARLIER release's (another file of the directory, an anchor, a --cross-check reference), not the DEPLOY_SHA being
 * loaded. It is verified against the stage table of its own DEPLOY_SHA when git can read it: a stage the table later removed (the retired `agent`, `ic-policy`,
 * `recorder`) is not an error in a file written before the removal. Without git history it is verified against the loaded table, as before (fails closed).
 */
export function loadFrozenFile(p: string, sha: string, o: { allowAdopted?: boolean; historical?: boolean } = {}): FrozenFile {
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (j.deploySha !== sha) throw new PublishError("COUNTS_MISSING", `${p} is for DEPLOY_SHA ${j.deploySha}, not ${sha}`, { sha });
  if (!o.allowAdopted && Array.isArray(j.measured?.adopted) && j.measured.adopted.length > 0) throw new PublishError("COUNTS_MISSING", `${p} was written by a run that ADOPTED stage(s) ${j.measured.adopted.join(", ")} (already on chain, not run): their counts were never measured, so it is not a frozen file. Rebuild the baseline from the counts.json of that run: bun publish-contracts/scripts/freeze-counts.ts --from-adopted-run counts.json --sha ${sha} --rpc <url> (issue 1733). Delete this file before rerunning.`, { sha, adopted: j.measured.adopted });
  const file: FrozenFile = { deploySha: sha, measured: j.measured, counts: validateCounts(j.counts) };
  if (j.measured?.reconstructed !== undefined) {
    const own = o.historical ? stageTableAtSha(dirname(p), sha) : undefined;
    let table;
    if (own) table = own;
    else try { table = getStageTable(); } catch { throw new PublishError("COUNTS_MISSING", `${p} is a reconstructed baseline but no stage table is loaded, so it cannot be verified: it is refused`, { sha }); }
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
    return { sha: s, file: loadFrozenFile(path, s, { historical: true }), path };
  });
}

/** The most recent earlier frozen file (by `measured.at`) of the directory, or none. */
export function latestOtherFrozen(dir: string, sha: string, before?: string): { sha: string; file: FrozenFile; path: string } | undefined {
  return otherFrozenFiles(dir, sha).filter((o) => before === undefined || String(o.file.measured.at) < before).sort((a, b) => String(a.file.measured.at).localeCompare(String(b.file.measured.at))).pop();
}

/** The anchors a (loaded) reconstructed file depends on, nearest first: { sha, fileHash } per hop, ending at the plain file. Empty for a plain file or a first-ever baseline. */
export function anchorChainOf(dir: string, sha: string): { sha: string; fileHash: string }[] {
  const out: { sha: string; fileHash: string }[] = [];
  let cur = sha;
  for (let i = 0; i <= MAX_ANCHOR_DEPTH; i++) {
    const cc = loadFrozenFile(frozenPath(dir, cur), cur, { historical: cur !== sha }).measured.crossChecked;
    if (!cc) return out;
    out.push({ sha: cc.sha, fileHash: cc.fileHash });
    cur = cc.sha;
  }
  throw new PublishError("COUNTS_MISSING", `the anchor chain of ${sha} is deeper than ${MAX_ANCHOR_DEPTH}: refused`, { sha });
}

/** Loads the frozen counts for a DEPLOY_SHA. A missing file or a file for another SHA fails. */
export const MAX_ANCHOR_DEPTH = 8;
export function loadFrozen(dir: string, sha: string, o: { allowAdopted?: boolean } = {}): FrozenFile {
  return loadFrozenChain(dir, sha, o, []);
}

/**
 * The full load. A reconstructed file's ANCHOR is loaded with these same rules, recursively (cycle-checked, depth-bounded): an anchor that is itself reconstructed needs its own
 * crossChecked, its own anchor and counts equal to it. The chain therefore ends at a plain measured file of the dir; a link that does not load refuses the whole chain.
 */
function loadFrozenChain(dir: string, sha: string, o: { allowAdopted?: boolean }, seen: string[]): FrozenFile {
  if (seen.includes(sha)) throw new PublishError("COUNTS_MISSING", `the anchor chain of ${seen[0]} loops back to ${sha} (${[...seen, sha].map((x) => x.slice(0, 8)).join(" -> ")}): a baseline's chain must end at a plain measured file`, { sha });
  if (seen.length >= MAX_ANCHOR_DEPTH) throw new PublishError("COUNTS_MISSING", `the anchor chain of ${seen[0]} is deeper than ${MAX_ANCHOR_DEPTH}: refused`, { sha });
  const p = frozenPath(dir, sha);
  if (!existsSync(p)) throw new PublishError("COUNTS_MISSING", `FROZEN_COUNTS_MISSING: no frozen counts for DEPLOY_SHA ${sha}: ${p} does not exist. No counts file is committed for a SHA until its first Twin chain rehearsal has measured it. Run publish contracts --measure on the Twin chain (918453) at this SHA (refused on 8453), then commit ${FROZEN_DIR}/${sha}.json: review a measurement that ran every stage, or, when the run ADOPTED the CREATE2 libraries (every Twin fork since Base block 52401633), rebuild the baseline with freeze-counts --from-adopted-run (issue 1733). Nothing here guesses a count.`, { sha });
  const f = loadFrozenFile(p, sha, { ...o, historical: seen.length > 0 }); // an anchor is an earlier release's file (issue 1926)
  if (f.measured.reconstructed) {
    // Issue 1733: the counts of the stages that adopted nothing come from a Twin counts.json nobody can prove untampered offline. The earlier release is the independent anchor.
    // The rule does NOT trust `measured.at` (it can be backdated): a reconstructed file must carry crossChecked whenever ANY other frozen file exists in the dir, and the
    // anchor it names must still be there with the bytes that were checked. One malformed <sha>.json in the dir fails this load too (fails closed).
    const others = otherFrozenFiles(dir, sha);
    const cc = f.measured.crossChecked;
    if (others.length > 0 && !cc) throw new PublishError("COUNTS_MISSING", `${p} is a reconstructed baseline with no crossChecked record, but other frozen file(s) exist (${others.map((o) => o.sha.slice(0, 8)).join(", ")}): rebuild it with freeze-counts --from-adopted-run (the cross-check against the previous release is mandatory)`, { sha });
    if (cc) {
      const there = join(dir, `${cc.sha}.json`);
      if (!existsSync(there)) throw new PublishError("COUNTS_MISSING", `${p} was cross-checked against ${cc.sha}, whose file ${there} is missing: restore the anchor file (git checkout it). A reconstructed baseline never loads without its anchor`, { sha, against: cc.sha });
      // the counts must still be the anchor's counts apart from the differences that were reviewed and accepted: a forged file that names the real anchor is caught here
      const anchor = loadFrozenChain(dir, cc.sha, {}, [...seen, sha]); // the anchor must itself load, by the same rules, down to a plain file
      if (fileHashOf(readFileSync(there)) !== cc.fileHash) throw new PublishError("COUNTS_MISSING", `${p} was cross-checked against ${cc.sha}, whose file has changed since (hash differs): restore the committed bytes (git checkout ${there}); an autocrlf or reformat change trips this too`, { sha, against: cc.sha });
      const diff = JSON.stringify(crossCheckDiff(f.counts, anchor.counts)), accepted = JSON.stringify(f.measured.reconstructed.crossCheck?.accepted ?? []);
      if (diff !== accepted) throw new PublishError("COUNTS_MISSING", `${p} differs from its anchor ${cc.sha} at ${diff}, the file records ${accepted} as the accepted differences`, { sha, against: cc.sha });
    }
  }
  return f;
}

export const sumCounts = (c: FrozenCounts, stages?: string[]): number => (stages ?? activeCountKeys(c)).reduce((a, s) => a + (c[s] ?? 0), 0);
/** Issue 1892: a run sums the counts of its own system's stages only (the file carries every system's keys). Without a loaded table: every key. */
function activeCountKeys(c: FrozenCounts): string[] { try { return DEPLOYER_STAGES.length === 0 ? Object.keys(c) : DEPLOYER_STAGES.map((s) => s.countKey!).filter((k) => k in c); } catch { return Object.keys(c); } }

/**
 * The deployer sends the prove-control transaction (the Safe execTransaction, core 1712) between stage 10 and the stage 11 handover. It is one
 * transaction outside every stage count, so every nonce at or after the handover is the summed frozen counts plus this.
 */
export const PROOF_TX_NONCES = 1;

/** The deployer nonce at the end of the deploy stages: the summed frozen counts plus the one prove-control transaction. */
export const finalDeployerNonce = (c: FrozenCounts, startNonce = 0): number => startNonce + sumCounts(c) + proofTxNonces();

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
  const want = startNonce + (stages ? sumCounts(c, stages) : sumCounts(c) + proofTxNonces());
  if (actual !== want) throw new PublishError("NONCE", `the deployer nonce is ${actual}, the summed frozen counts say ${want}${startNonce ? ` (start nonce ${startNonce} recorded at the first stage)` : ""}${stages ? "" : ` (${PROOF_TX_NONCES} of them is the prove-control transaction)`}`, { actual, want, startNonce });
}

/** Writes a measured counts file. Refuses to change an existing file: a frozen file is reviewed data. */
export function writeFrozen(dir: string, sha: string, counts: FrozenCounts, measured: FrozenFile["measured"]): string {
  const p = frozenPath(dir, sha);
  validateCounts(counts);
  const body: FrozenFile = { deploySha: sha, measured, counts };
  if (existsSync(p)) {
    const old = JSON.parse(readFileSync(p, "utf8"));
    if (!mergeable(old.counts, counts)) throw new PublishError("COUNT_MISMATCH", `${p} already holds different counts for this SHA: a frozen file is never rewritten, review the difference`, { sha });
    const extra = Object.keys(counts).filter((k) => !(k in old.counts));
    if (extra.length > 0) { writeFileSync(p, JSON.stringify({ ...old, counts: { ...old.counts, ...Object.fromEntries(extra.map((k) => [k, counts[k]])) } }, null, 2) + "\n"); return p; } // issue 1892: another system's counts are added, none changed
    return p;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", { mode: 0o644 });
  return p;
}

export type CountsMode = "frozen" | "measure-flag" | "dry-run-measure" | "twin-measure" | "redeploy-sha";
export interface ResolvedCounts { frozen?: FrozenCounts; measure: boolean; mode: CountsMode; file: string }

/**
 * Which counts a run uses.
 *  - a run at a single-vault redeploy's sha (QA plan v1 E1, `redeploy`): the counts of the ORIGINAL deployment sha, never a file for the redeploy sha (below);
 *  - a frozen file for the SHA exists: it is used (a disagreement with the dry run or the broadcast is COUNT_MISMATCH in the runner);
 *  - --measure: none (the run learns them);
 *  - the file is missing and the run is a --dry-run: none, a WARN names it (a dry run is the step that measures; nothing is written);
 *  - the file is missing, no dry run (so a dry run on 8453 preflights too) and the chain is not 8453: the run measures and writes the file under the counts dir;
 *  - the file is missing on 8453 and the run broadcasts: COUNTS_MISSING, a hard error.
 */
export function resolveCounts(o: {
  dir: string; sha: string; measureFlag: boolean; dryRun: boolean; chainId: number; warn?: (event: string, f: Record<string, unknown>) => void;
  /**
   * QA plan v1 E1 (QD-6, issue 1796): `govern --row redeploy-vault` and `verify --prior-out` at the sha a redeploy round was deployed at. They deploy nothing, so the redeploy
   * sha needs no frozen file (it never has one: the verb sends no counted stage). The deployment's counts are those of the original sha: its frozen file when the counts dir
   * holds it, else the per-stage counts the run manifest recorded (each was checked against that frozen file when its stage ran). Nothing is measured, nothing is written.
   */
  redeploy?: { originalSha: string; recorded: FrozenCounts };
}): ResolvedCounts {
  if (o.redeploy) {
    const original = frozenPath(o.dir, o.redeploy.originalSha);
    if (existsSync(original)) return { frozen: loadFrozen(o.dir, o.redeploy.originalSha, { allowAdopted: o.chainId === TWIN_CHAIN_ID }).counts, measure: false, mode: "redeploy-sha", file: original };
    o.warn?.("counts.redeploy_sha", { file: original, source: "run-manifest", note: "no frozen counts file for the original deployment sha in the counts dir: the counts the run manifest recorded per stage stand in for it (each was checked against that file when its stage ran)" });
    return { frozen: o.redeploy.recorded, measure: false, mode: "redeploy-sha", file: original };
  }
  const file = frozenPath(o.dir, o.sha);
  if (o.measureFlag) return { measure: true, mode: "measure-flag", file };
  // A Twin measuring run that adopted a stage marks its file (issue 1721). Its own follow-on verbs (verify, govern) read it back; on the Twin chain only (918453): every other chain, 8453 included, refuses it.
  if (existsSync(file)) {
    const f = loadFrozen(o.dir, o.sha, { allowAdopted: o.chainId === TWIN_CHAIN_ID }).counts;
    // Issue 1892: one frozen file per sha holds the counts of both systems. A run of a system whose stages the file does not name yet measures them (never on 8453) and adds them.
    if (o.chainId !== MAINNET_CHAIN_ID && missingOwnKeys(f).length > 0) {
      if (o.dryRun) return { measure: true, mode: "dry-run-measure", file };
      o.warn?.("counts.measuring_system", { file, missing: missingOwnKeys(f), note: "the frozen file names no count for these stages of this system: this run measures them and adds them to the file" });
      return { measure: true, mode: "twin-measure", file };
    }
    return { frozen: f, measure: false, mode: "frozen", file };
  }
  if (o.dryRun) {
    o.warn?.("dry_run.counts_missing", { file, note: "no frozen counts for this SHA: the dry run measures them and writes nothing" });
    return { measure: true, mode: "dry-run-measure", file };
  }
  if (o.chainId === MAINNET_CHAIN_ID) return { frozen: loadFrozen(o.dir, o.sha).counts, measure: false, mode: "frozen", file }; // throws COUNTS_MISSING
  o.warn?.("counts.measuring", { file, note: "no frozen counts for this SHA on a non-8453 chain: this run measures them and writes the file under the counts dir (review it, then commit it)" });
  return { measure: true, mode: "twin-measure", file };
}

/** Issue 1892: the stage keys of this run's system that a counts object does not name yet. Empty without a loaded table. */
function missingOwnKeys(c: FrozenCounts): string[] {
  try { return DEPLOYER_STAGES.map((s) => s.countKey!).filter((k) => !(k in c)); } catch { return []; }
}

/**
 * Issue 1892: whether `next` may be written over a file that holds `old`. A table with systems keeps one file per sha for both systems, so a run of one system names only its own stages:
 * every key both name must be equal, and either may name keys the other lacks. A table from before the split needs the two to be identical.
 */
function mergeable(old: FrozenCounts, next: FrozenCounts): boolean {
  let systems = false;
  try { systems = getStageTable().systems !== undefined; } catch { /* no table loaded: the strict rule */ }
  if (!systems) return JSON.stringify(old) === JSON.stringify(next);
  return Object.keys(next).every((k) => !(k in old) || old[k] === next[k]);
}
