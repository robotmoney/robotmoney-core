// The contracts-freeze gate of the mainnet plan job (core 1524). On chain 8453 the plan refuses unless, in this order:
//   1. an annotated release/<version> tag points at DEPLOY_SHA, and the remote holds the same tag object (RELEASE_SHA_UNTAGGED, RELEASE_TAG_REMOTE_MISMATCH)
//      The TAG KIND must match the deployment kind of the sheet (issue 1727): a production plan needs release/<version>, a rehearsal plan needs release/<version>-rehearsal.
//      A rehearsal tag never satisfies a production plan and the reverse (RELEASE_TAG_KIND).
//   2. deployments/frozen-counts/<sha>.json exists for it                 (COUNTS_MISSING). A reconstructed baseline is also proven committed in the COUNTS checkout (issue 1740, gitFrozenDirCommitted)
//   3. a GitHub token is present and scripts/ci/check-sha-green.ts exits 0 (CI_NOT_GREEN)
// Each refusal happens before any signer is built. On the Twin chain none of these apply, so rehearsals keep measuring.
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { anchorChainOf, fileHashOf, loadFrozen, type FrozenFile } from "./counts.ts";
import { PublishError } from "./errors.ts";
import { gitEnv } from "./git-env.ts";
import { releaseTagsFor, tagKind, verifyRemoteTag, type RemoteTagCheck } from "./release-tag.ts";
import type { DeploymentKind } from "./chains.ts";

export const CHECK_SHA_GREEN_SCRIPT = join("scripts", "ci", "check-sha-green.ts");
export interface CiGreenResult { code: number; output: string }
/** Test seam. The real one runs `bun scripts/ci/check-sha-green.ts <sha>` in the core checkout with the caller's GitHub token. */
export type CheckShaGreen = (i: { coreDir: string; sha: string; env: Record<string, string> }) => Promise<CiGreenResult>;

export const spawnCheckShaGreen: CheckShaGreen = async (i) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["bun", CHECK_SHA_GREEN_SCRIPT, i.sha], { cwd: i.coreDir, env: i.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new PublishError("TOOL", `cannot start bun for check-sha-green: ${(e as Error).message}`);
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code, output: `${out}${err}` };
};

export interface ReleaseGateInput {
  sha: string; coreDir: string; countsDir: string; env: Record<string, string | undefined>;
  /** The deployment kind of the sheet (issue 1727). Required: there is no default, so a caller cannot forget it. */
  kind: DeploymentKind;
  /** Test seams. Defaults: the real git tag read and the real check-sha-green. `releaseTag` names the one tag found at the sha (or none); `releaseTags` names every tag found. */
  releaseTag?: (coreDir: string, sha: string) => Promise<string | null>;
  releaseTags?: (coreDir: string, sha: string) => Promise<string[]>;
  checkShaGreen?: CheckShaGreen;
  /** Default: the tag must exist on the origin of the core checkout with the same tag object (RELEASE_TAG_REMOTE_MISMATCH). */
  remoteTag?: RemoteTagCheck;
  /**
   * Issue 1733: re-verifies a RECONSTRUCTED baseline (counts-reconstruct.ts) against the build and the chain at plan time. Required when the frozen file is a reconstruction:
   * without it the gate refuses (COUNTS_MISSING), because an offline load proves only the arithmetic, not the adoption records.
   */
  verifyReconstructed?: (file: FrozenFile) => Promise<void>;
  /**
   * Issue 1733: proves the anchor file of a reconstructed baseline (measured.crossChecked) is COMMITTED at the HEAD of the counts checkout with the bytes that were checked, so deleting or
   * swapping it in the working tree cannot hide the cross-check. Required when the file has a crossChecked record (COUNTS_MISSING without it). Default seam in the CLI: gitAnchorCommitted.
   */
  anchorCommitted?: (anchorPath: string, expectedHash: string) => Promise<void>;
  /**
   * Issue 1733 and 1740: the counts dir of a reconstructed baseline must be a clean dir of a checkout at the release sha or a descendant of it, tracking every frozen file in it with the
   * same bytes (gitFrozenDirCommitted). Required for any reconstructed file. Default seam in the CLI: gitFrozenDirCommitted.
   */
  frozenDirCommitted?: (countsDir: string) => Promise<void>;
}

const DUBIOUS = "git refuses a checkout owned by another user (safe.directory): the counts checkout must be owned by the operator";
/** `git --no-replace-objects -C dir args`: the output, or the refusal. A git that cannot run, and a git that fails, are told apart. */
function gitRead(git: string, dir: string, args: string[], what: string): { ok: boolean; out: Buffer; err: string } {
  const r = spawnSync(git, ["--no-replace-objects", "-C", dir, ...args], { maxBuffer: 1 << 24, env: gitEnv() });
  if (r.error || r.status === null) throw new PublishError("COUNTS_MISSING", `git could not run (${r.error?.message ?? "killed by a signal"}): ${what}`);
  const stderr = String(r.stderr);
  const last = stderr.trim().split("\n").pop() ?? "";
  return { ok: r.status === 0, out: r.stdout, err: /dubious ownership/.test(stderr) ? `${last} (${DUBIOUS})` : last };
}

export interface FrozenDirOptions { git?: string; /** Also require HEAD of the counts checkout to be an ancestor of (or equal to) its local refs/remotes/origin/dev. */ requireOriginDev?: boolean }

/**
 * Issue 1740: the counts dir of a reconstructed baseline is a directory of a git checkout of THIS repository, and that checkout proves the dir.
 * A baseline is named by the DEPLOY sha X, so its file can never be in the checkout at X (it holds X, the hash of a tree that would hold it). The release flow tags X, then merges the file
 * as a data-only commit Y after the tag. The operator runs the code from a clean checkout at X (`coreDir`) and the counts from a clean checkout at Y or later (`countsDir`). The proofs,
 * all run in the COUNTS checkout, nothing is read from the core checkout but its HEAD:
 *   1. countsDir is inside a git work tree, and the HEAD of that work tree is X or a descendant of X (so it holds X's whole history: the same repository, and the data came after the tag);
 *   2. every `<40 hex>.json` in the dir is tracked at HEAD with the same bytes (the baseline X.json, every anchor, any extra file), and every one tracked at HEAD is in the dir (no deleted anchor);
 *   3. the dir is clean: nothing modified and nothing untracked under it.
 */
export async function gitFrozenDirCommitted(coreDir: string, countsDir: string, opt: FrozenDirOptions | string = {}): Promise<void> {
  const o: FrozenDirOptions = typeof opt === "string" ? { git: opt } : opt;
  const git = o.git ?? "git";
  const head = gitRead(git, coreDir, ["rev-parse", "HEAD"], `the commit of the core checkout ${coreDir} cannot be read`);
  const x = head.out.toString().trim();
  if (!head.ok || !/^[0-9a-f]{40}$/.test(x)) throw new PublishError("COUNTS_MISSING", `cannot read HEAD of the core checkout ${coreDir}: ${head.err}`);
  const top = gitRead(git, countsDir, ["rev-parse", "--is-inside-work-tree"], `the counts dir ${countsDir} cannot be proven committed`);
  if (!top.ok) throw new PublishError("COUNTS_MISSING", `the counts dir ${countsDir} is not inside a git work tree (${top.err}): a reconstructed baseline needs the committed frozen-counts dir of a checkout of this repository at the release sha ${x} or a later commit`);
  const anc = gitRead(git, countsDir, ["merge-base", "--is-ancestor", x, "HEAD"], `the history of the counts checkout ${countsDir} cannot be read`);
  if (!anc.ok) throw new PublishError("COUNTS_MISSING", `HEAD of the counts checkout ${countsDir} is not a descendant of the release sha ${x} of the core checkout (or does not contain it): the counts come from a checkout of the same repository at ${x} or a later commit (the data-only commit that adds the baseline), not from an older or another repository`);
  const ls = gitRead(git, countsDir, ["ls-tree", "--name-only", "HEAD"], `the frozen files tracked in ${countsDir} cannot be listed`);
  if (!ls.ok) throw new PublishError("COUNTS_MISSING", `git ls-tree HEAD failed in ${countsDir}: ${ls.err}`);
  const frozen = /^[0-9a-f]{40}\.json$/;
  const tracked = new Set(ls.out.toString().split("\n").filter((n) => frozen.test(n)));
  const onDisk = readdirSync(resolve(countsDir)).filter((n) => frozen.test(n));
  for (const name of tracked) if (!onDisk.includes(name)) throw new PublishError("COUNTS_MISSING", `${name} is tracked at HEAD of ${countsDir} but missing from the counts dir: restore it (git checkout)`);
  for (const name of onDisk) {
    if (!tracked.has(name)) throw new PublishError("COUNTS_MISSING", `${name} in the counts dir ${countsDir} is not tracked at HEAD: commit it (the data-only commit after the release tag) and run from that checkout`);
    const committed = gitRead(git, countsDir, ["show", `HEAD:./${name}`], `${name} cannot be compared with its committed bytes`);
    if (!committed.ok || !committed.out.equals(readFileSync(resolve(countsDir, name)))) throw new PublishError("COUNTS_MISSING", `${name} in the counts dir ${countsDir} differs from the committed bytes at HEAD: restore the committed bytes (git checkout)`);
  }
  const st = gitRead(git, countsDir, ["status", "--porcelain", "--untracked-files=all", "--ignored", "--", "."], `the counts dir ${countsDir} cannot be checked for changes`);
  if (!st.ok) throw new PublishError("COUNTS_MISSING", `git status failed in ${countsDir}: ${st.err}`);
  const dirty = st.out.toString().split("\n").filter((l) => l.trim() !== "");
  if (dirty.length > 0) throw new PublishError("COUNTS_MISSING", `the counts dir ${countsDir} is not clean (${dirty.length}): ${dirty.slice(0, 5).join("; ")}. Commit or remove it (ignored files count too), the counts are read from a clean checkout`);
  if (o.requireOriginDev) {
    const od = gitRead(git, countsDir, ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/dev"], `the counts checkout ${countsDir} cannot be compared with origin/dev`);
    if (!od.ok) throw new PublishError("COUNTS_MISSING", `HEAD of the counts checkout ${countsDir} is not reachable from its origin/dev (--counts-require-origin-dev): run 'git fetch origin dev' there and use a reviewed commit that is merged to dev (${od.err || "no refs/remotes/origin/dev"})`);
  }
}

/** The proofs a reconstructed baseline needs before anything is signed: the dir is the committed one, and every anchor of its chain is committed with the checked bytes. */
export async function assertBaselineCommitted(o: { countsDir: string; sha: string; frozen: FrozenFile; frozenDirCommitted?: (d: string) => Promise<void>; anchorCommitted?: (p: string, h: string) => Promise<void> }): Promise<void> {
  if (!o.frozen.measured.reconstructed) return;
  if (!o.frozenDirCommitted) throw new PublishError("COUNTS_MISSING", `the reconstructed baseline ${o.sha} needs a proof that the counts dir is the committed one and none was given: refused`, { sha: o.sha });
  await o.frozenDirCommitted(o.countsDir);
  for (const hop of anchorChainOf(o.countsDir, o.sha)) {
    if (!o.anchorCommitted) throw new PublishError("COUNTS_MISSING", `the reconstructed baseline names the anchor ${hop.sha} and there is no way to prove it is committed: refused`, { sha: o.sha });
    await o.anchorCommitted(join(o.countsDir, `${hop.sha}.json`), hop.fileHash);
  }
}

/** The anchor file at `abs` must be a tracked file of the git checkout that holds it, equal at HEAD to the bytes whose sha256 is `expectedHash` (the counts checkout, not the core checkout). */
export async function gitAnchorCommitted(abs: string, expectedHash: string, git = "git"): Promise<void> {
  const file = resolve(abs);
  const rel = basename(file);
  const r = spawnSync(git, ["--no-replace-objects", "-C", dirname(file), "show", `HEAD:./${rel}`], { maxBuffer: 1 << 24, env: gitEnv() });
  if (r.error || r.status === null) throw new PublishError("COUNTS_MISSING", `git could not run (${r.error?.message ?? "killed by a signal"}): the anchor file ${rel} cannot be proven committed`);
  if (r.status !== 0) throw new PublishError("COUNTS_MISSING", `the anchor file ${file} is not committed at HEAD of its checkout (git show: ${String(r.stderr).trim().split("\n").pop() ?? ""}): commit the earlier frozen file the baseline was cross-checked against`);
  if (fileHashOf(r.stdout) !== expectedHash) throw new PublishError("COUNTS_MISSING", `the anchor file ${rel} committed at HEAD differs from the bytes the baseline was cross-checked against: restore the committed bytes`);
}

/**
 * The release tag of the sha that satisfies the deployment kind. Throws RELEASE_SHA_UNTAGGED when no annotated release tag points at the sha, and
 * RELEASE_TAG_KIND when tags exist but none is of the kind the sheet asks for.
 */
export async function tagForKind(i: Pick<ReleaseGateInput, "sha" | "coreDir" | "kind" | "releaseTag" | "releaseTags">): Promise<string | null> {
  const found = i.releaseTags ? await i.releaseTags(i.coreDir, i.sha) : i.releaseTag ? [await i.releaseTag(i.coreDir, i.sha)].filter((t): t is string => !!t) : await releaseTagsFor(i.coreDir, i.sha);
  if (found.length === 0) return null;
  const match = found.filter((t) => tagKind(t) === i.kind).sort()[0];
  if (match) return match;
  const want = i.kind === "rehearsal" ? "release/<version>-rehearsal" : "release/<version> (no -rehearsal suffix)";
  const have = found.map((t) => `${t} (${tagKind(t)})`).join(", ");
  throw new PublishError("RELEASE_TAG_KIND", `the sheet says DEPLOYMENT_KIND ${i.kind} and needs an annotated ${want} tag at ${i.sha}, but the tag(s) there are: ${have}. A rehearsal tag never satisfies a production deployment and a production tag never satisfies a rehearsal.`, { sha: i.sha, kind: i.kind, tags: found });
}

/** Returns the release tag name. Throws RELEASE_SHA_UNTAGGED, RELEASE_TAG_KIND, COUNTS_MISSING or CI_NOT_GREEN. */
export async function assertReleaseGate(i: ReleaseGateInput): Promise<string> {
  const tag = await tagForKind(i);
  if (!tag) throw new PublishError("RELEASE_SHA_UNTAGGED", `DEPLOY_SHA ${i.sha} is not a release SHA: no annotated release/<version>${i.kind === "rehearsal" ? "-rehearsal" : ""} tag in ${i.coreDir} points at it. Tag the release SHA, rehearse on the Twin chain at that SHA, commit its frozen counts, then plan.`, { sha: i.sha });
  await (i.remoteTag ?? ((d, t) => verifyRemoteTag(d, t)))(i.coreDir, tag);
  const frozen = loadFrozen(i.countsDir, i.sha); // throws COUNTS_MISSING; a reconstructed baseline is also verified against the stage table here
  if (frozen.measured.reconstructed) {
    if (!i.verifyReconstructed) throw new PublishError("COUNTS_MISSING", `deployments/frozen-counts/${i.sha}.json is a reconstructed baseline (issue 1733) and the gate has no way to re-verify it on chain: it is refused`, { sha: i.sha });
    await i.verifyReconstructed(frozen); // throws LIBS_ADOPTION when a record differs from the build or the chain
    await assertBaselineCommitted({ countsDir: i.countsDir, sha: i.sha, frozen, frozenDirCommitted: i.frozenDirCommitted, anchorCommitted: i.anchorCommitted });
  }
  const token = i.env.GITHUB_TOKEN || i.env.GH_TOKEN;
  if (!token) throw new PublishError("CI_NOT_GREEN", `cannot check that CI is green at ${i.sha}: GITHUB_TOKEN is not set. The check is never skipped on 8453.`, { sha: i.sha });
  const env: Record<string, string> = { GITHUB_TOKEN: token };
  for (const k of ["PATH", "HOME", "GITHUB_REPOSITORY"]) if (i.env[k]) env[k] = i.env[k]!;
  const r = await (i.checkShaGreen ?? spawnCheckShaGreen)({ coreDir: i.coreDir, sha: i.sha, env });
  if (r.code !== 0) {
    const lines = r.output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    throw new PublishError("CI_NOT_GREEN", `CI is not green at ${i.sha} (check-sha-green exit ${r.code}): ${lines.slice(0, 12).join(" | ")}`, { sha: i.sha, exit: r.code });
  }
  return tag;
}
