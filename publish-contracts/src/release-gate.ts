// The contracts-freeze gate of the mainnet plan job (core 1524). On chain 8453 the plan refuses unless, in this order:
//   1. an annotated release/<version> tag points at DEPLOY_SHA, and the remote holds the same tag object (RELEASE_SHA_UNTAGGED, RELEASE_TAG_REMOTE_MISMATCH)
//      The TAG KIND must match the deployment kind of the sheet (issue 1727): a production plan needs release/<version>, a rehearsal plan needs release/<version>-rehearsal.
//      A rehearsal tag never satisfies a production plan and the reverse (RELEASE_TAG_KIND).
//   2. deployments/frozen-counts/<sha>.json exists for it                 (COUNTS_MISSING)
//   3. a GitHub token is present and scripts/ci/check-sha-green.ts exits 0 (CI_NOT_GREEN)
// Each refusal happens before any signer is built. On the Twin chain none of these apply, so rehearsals keep measuring.
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { anchorChainOf, fileHashOf, loadFrozen, type FrozenFile } from "./counts.ts";
import { PublishError } from "./errors.ts";
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
   * Issue 1733: proves the anchor file of a reconstructed baseline (measured.crossChecked) is COMMITTED at the checkout's HEAD with the bytes that were checked, so deleting or
   * swapping it in the working tree cannot hide the cross-check. Required when the file has a crossChecked record (COUNTS_MISSING without it). Default seam in the CLI: gitAnchorCommitted.
   */
  anchorCommitted?: (anchorPath: string, expectedHash: string) => Promise<void>;
  /**
   * Issue 1733: the counts dir of a reconstructed baseline must be INSIDE the core checkout and hold every frozen file tracked at HEAD (a tracked file missing from the dir is a
   * deleted anchor). Required for any reconstructed file. Default seam in the CLI: gitFrozenDirCommitted.
   */
  frozenDirCommitted?: (countsDir: string) => Promise<void>;
}

/** The counts dir must lie inside the git checkout `coreDir`, and every `<40 hex>.json` tracked in it at HEAD must exist in the working dir. */
export async function gitFrozenDirCommitted(coreDir: string, countsDir: string, git = "git"): Promise<void> {
  const rel = relative(resolve(coreDir), resolve(countsDir));
  if (rel.startsWith("..") || rel === "") throw new PublishError("COUNTS_MISSING", `the counts dir ${countsDir} is outside the core checkout ${coreDir}: a reconstructed baseline needs the committed frozen-counts dir of the checkout, so its anchors can be proven committed`);
  const r = spawnSync(git, ["-C", coreDir, "ls-tree", "--name-only", "HEAD", `${rel}/`], { maxBuffer: 1 << 24 });
  if (r.error || r.status === null) throw new PublishError("COUNTS_MISSING", `git could not run (${r.error?.message ?? "killed by a signal"}): the frozen files tracked in ${rel} cannot be listed`);
  if (r.status !== 0) throw new PublishError("COUNTS_MISSING", `git ls-tree HEAD ${rel} failed in ${coreDir}: ${String(r.stderr).trim().split("\n").pop() ?? ""}`);
  for (const line of String(r.stdout).split("\n")) {
    const name = line.split("/").pop() ?? "";
    if (/^[0-9a-f]{40}\.json$/.test(name) && !existsSync(resolve(countsDir, name))) throw new PublishError("COUNTS_MISSING", `${name} is tracked in ${rel} at HEAD but missing from the counts dir ${countsDir}: restore it (git checkout)`);
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

/** The anchor file at `abs` must be a tracked file of the git checkout `coreDir`, equal at HEAD to the bytes whose sha256 is `expectedHash`. */
export async function gitAnchorCommitted(coreDir: string, abs: string, expectedHash: string, git = "git"): Promise<void> {
  const rel = relative(resolve(coreDir), resolve(abs));
  if (rel.startsWith("..") || rel === "") throw new PublishError("COUNTS_MISSING", `the anchor file ${abs} is outside the core checkout ${coreDir}: it cannot be proven committed`);
  const r = spawnSync(git, ["-C", coreDir, "show", `HEAD:${rel}`], { maxBuffer: 1 << 24 });
  if (r.error || r.status === null) throw new PublishError("COUNTS_MISSING", `git could not run (${r.error?.message ?? "killed by a signal"}): the anchor file ${rel} cannot be proven committed`);
  if (r.status !== 0) throw new PublishError("COUNTS_MISSING", `the anchor file ${rel} is not committed at HEAD of ${coreDir} (git show: ${String(r.stderr).trim().split("\n").pop() ?? ""}): commit the earlier frozen file the baseline was cross-checked against`);
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
