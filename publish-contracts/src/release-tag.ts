// The release tag of a DEPLOY_SHA (core 1524). The contracts-freeze gate: the mainnet plan job runs only at a SHA that an annotated
// `release/<version>` tag points at. A lightweight tag, a tag on another SHA and no tag are all "no release tag".
import { PublishError } from "./errors.ts";
import type { DeploymentKind } from "./chains.ts";

/** The suffix that makes a release tag a REHEARSAL tag (issue 1727): release/<version>-rehearsal. A production tag is release/<version> with no mention of rehearsal. */
export const REHEARSAL_TAG_SUFFIX = "-rehearsal";
/** `rehearsal`: ends in -rehearsal. `ambiguous`: mentions rehearsal anywhere else (satisfies neither kind). `production`: everything else. */
export function tagKind(tag: string): DeploymentKind | "ambiguous" {
  if (tag.endsWith(REHEARSAL_TAG_SUFFIX)) return "rehearsal";
  return /rehearsal/i.test(tag) ? "ambiguous" : "production";
}

export interface GitResult { code: number; stdout: string; stderr: string }
export type GitRunner = (args: string[]) => Promise<GitResult>;

export const spawnGit: GitRunner = async (args) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["git", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new PublishError("TOOL", `cannot start git: ${(e as Error).message}`);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code, stdout, stderr };
};

/** The annotated release/<version> tags of the core checkout that point at `sha`, sorted. Empty when none does. */
export async function releaseTagsFor(coreDir: string, sha: string, git: GitRunner = spawnGit): Promise<string[]> {
  // objecttype is "tag" for an annotated tag and "commit" for a lightweight one; *objectname is the object an annotated tag points at
  const r = await git(["-C", coreDir, "for-each-ref", "--format=%(refname)|%(objecttype)|%(*objectname)", "refs/tags/release/"]);
  if (r.code !== 0) throw new PublishError("USAGE", `git for-each-ref failed in ${coreDir}: ${(r.stderr || "").trim().split("\n").slice(-1)[0] ?? "unknown error"}`);
  const tags: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const [ref, type, target] = line.trim().split("|");
    if (ref && type === "tag" && target === sha) tags.push(ref.replace(/^refs\/tags\//, ""));
  }
  return tags.sort();
}

/** The first annotated release tag at `sha`, or null. */
export async function releaseTagFor(coreDir: string, sha: string, git: GitRunner = spawnGit): Promise<string | null> {
  return (await releaseTagsFor(coreDir, sha, git))[0] ?? null;
}

/** Test seam: the remote check of a found release tag. The real one is verifyRemoteTag against the core checkout's origin. */
export type RemoteTagCheck = (coreDir: string, tag: string) => Promise<void>;

/**
 * The local release tag must exist on the remote with the same tag object (core 1602). A pusher who moved or created a tag locally, or a
 * tag deleted or moved on the remote, is a refusal. An unreachable remote is a refusal too: the check is never skipped.
 * `remote` is a remote name or a URL.
 */
export async function verifyRemoteTag(coreDir: string, tag: string, remote = "origin", git: GitRunner = spawnGit): Promise<void> {
  const fail = (why: string, d: Record<string, unknown> = {}) => new PublishError("RELEASE_TAG_REMOTE_MISMATCH", `release tag ${tag} does not match the remote ${remote}: ${why}. Fetch the tags (git fetch --tags --force) or re-tag, then plan.`, { tag, remote, ...d });
  const ref = `refs/tags/${tag}`;
  const local = await git(["-C", coreDir, "rev-parse", "--verify", "-q", ref]);
  if (local.code !== 0) throw fail("the tag is not in the local checkout");
  const localObj = local.stdout.trim();
  const r = await git(["-C", coreDir, "ls-remote", "--tags", remote, ref]);
  if (r.code !== 0) throw fail(`the remote is unreachable (${(r.stderr || "").trim().split("\n").slice(-1)[0] ?? "git ls-remote failed"})`);
  const lines = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === ref);
  if (lines.length === 0) throw fail("the remote has no such tag");
  if (lines[0]![0] !== localObj) throw fail(`the remote tag object is ${lines[0]![0]}, the local one is ${localObj}`, { local: localObj, remoteObj: lines[0]![0] });
}
