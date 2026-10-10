// The contracts-freeze gate of the mainnet plan job (core 1524). On chain 8453 the plan refuses unless, in this order:
//   1. an annotated release/<version> tag points at DEPLOY_SHA, and the remote holds the same tag object (RELEASE_SHA_UNTAGGED, RELEASE_TAG_REMOTE_MISMATCH)
//      The TAG KIND must match the deployment kind of the sheet (issue 1727): a production plan needs release/<version>, a rehearsal plan needs release/<version>-rehearsal.
//      A rehearsal tag never satisfies a production plan and the reverse (RELEASE_TAG_KIND).
//   2. deployments/frozen-counts/<sha>.json exists for it                 (COUNTS_MISSING)
//   3. a GitHub token is present and scripts/ci/check-sha-green.ts exits 0 (CI_NOT_GREEN)
// Each refusal happens before any signer is built. On the Twin chain none of these apply, so rehearsals keep measuring.
import { join } from "node:path";
import { loadFrozen, type FrozenFile } from "./counts.ts";
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
