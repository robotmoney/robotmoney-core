// The contracts-freeze gate of the mainnet plan job (core 1524). On chain 8453 the plan refuses unless, in this order:
//   1. an annotated release/<version> tag points at DEPLOY_SHA, and the remote holds the same tag object (RELEASE_SHA_UNTAGGED, RELEASE_TAG_REMOTE_MISMATCH)
//   2. deployments/frozen-counts/<sha>.json exists for it                 (COUNTS_MISSING)
//   3. a GitHub token is present and scripts/ci/check-sha-green.ts exits 0 (CI_NOT_GREEN)
// Each refusal happens before any signer is built. On the Twin chain none of these apply, so rehearsals keep measuring.
import { join } from "node:path";
import { loadFrozen } from "./counts.ts";
import { PublishError } from "./errors.ts";
import { releaseTagFor, verifyRemoteTag, type RemoteTagCheck } from "./release-tag.ts";

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
  /** Test seams. Defaults: the real git tag read and the real check-sha-green. */
  releaseTag?: (coreDir: string, sha: string) => Promise<string | null>;
  checkShaGreen?: CheckShaGreen;
  /** Default: the tag must exist on the origin of the core checkout with the same tag object (RELEASE_TAG_REMOTE_MISMATCH). */
  remoteTag?: RemoteTagCheck;
}

/** Returns the release tag name. Throws RELEASE_SHA_UNTAGGED, COUNTS_MISSING or CI_NOT_GREEN. */
export async function assertReleaseGate(i: ReleaseGateInput): Promise<string> {
  const tag = await (i.releaseTag ?? releaseTagFor)(i.coreDir, i.sha);
  if (!tag) throw new PublishError("RELEASE_SHA_UNTAGGED", `DEPLOY_SHA ${i.sha} is not a release SHA: no annotated release/<version> tag in ${i.coreDir} points at it. Tag the release SHA, rehearse on the Twin chain at that SHA, commit its frozen counts, then plan.`, { sha: i.sha });
  await (i.remoteTag ?? ((d, t) => verifyRemoteTag(d, t)))(i.coreDir, tag);
  loadFrozen(i.countsDir, i.sha); // throws COUNTS_MISSING
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
