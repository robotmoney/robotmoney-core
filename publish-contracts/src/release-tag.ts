// The release tag of a DEPLOY_SHA (core 1524). The contracts-freeze gate: the mainnet plan job runs only at a SHA that an annotated
// `release/<version>` tag points at. A lightweight tag, a tag on another SHA and no tag are all "no release tag".
import { PublishError } from "./errors.ts";

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
