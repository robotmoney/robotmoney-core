// The release tag of a DEPLOY_SHA (core 1524). The contracts-freeze gate: the mainnet plan job runs only at a SHA that an annotated
// `release/<version>` tag points at. A lightweight tag, a tag on another SHA and no tag are all "no release tag".
// Security round 3 (review: SECURITY_TRUST_ROOT): every git child here proves the checkout like the other proving calls (git-env.ts): no GIT_* variable of the
// caller, no system or global config, replace refs off (`--no-replace-objects`). Before, a `refs/replace/<tag object>` ref in the checkout made for-each-ref peel a
// genuine release tag to an untagged commit, and rev-parse and ls-remote still saw the genuine tag object, so the gate passed. The canonical check also asks the
// canonical repository itself, from outside the checkout, which commit the tag peels to (verifyCanonicalRemoteTag).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PublishError } from "./errors.ts";
import { gitEnv } from "./git-env.ts";
import type { DeploymentKind } from "./chains.ts";

/** The suffix that makes a release tag a REHEARSAL tag (issue 1727): release/<version>-rehearsal. A production tag is release/<version> with no mention of rehearsal. */
export const REHEARSAL_TAG_SUFFIX = "-rehearsal";
/** `rehearsal`: ends in -rehearsal. `ambiguous`: mentions rehearsal anywhere else (satisfies neither kind). `production`: everything else. */
export function tagKind(tag: string): DeploymentKind | "ambiguous" {
  if (tag.endsWith(REHEARSAL_TAG_SUFFIX)) return "rehearsal";
  return /rehearsal/i.test(tag) ? "ambiguous" : "production";
}

export interface GitResult { code: number; stdout: string; stderr: string }
/** `env`: variables added to the git child's scrubbed environment (the neutral ls-remote sets GIT_CEILING_DIRECTORIES). */
export type GitRunner = (args: string[], opts?: { env?: Record<string, string> }) => Promise<GitResult>;

/** The proxy variables an operator's network may need for the remote check. They cannot weaken TLS: git's own TLS settings come from config, which is off. */
const PROXY_VARS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"] as const;

/**
 * Security round 3: `git --no-replace-objects <args>` with gitEnv() (PATH and HOME only, every GIT_* variable dropped, system and global config off, replace refs off)
 * plus the proxy variables. Before, the child inherited the caller's whole environment and replace refs were on.
 */
export const spawnGit: GitRunner = async (args, opts) => {
  let p: ReturnType<typeof Bun.spawn>;
  const env: Record<string, string> = gitEnv();
  for (const k of PROXY_VARS) if (process.env[k]) env[k] = process.env[k]!;
  try {
    p = Bun.spawn(["git", "--no-replace-objects", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...env, ...(opts?.env ?? {}) } });
  } catch (e) {
    throw new PublishError("TOOL", `cannot start git: ${(e as Error).message}`);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code, stdout, stderr };
};

/**
 * The annotated release/<version> tags of the core checkout that point at `sha`, sorted. Empty when none does. Security round 3: the real runner peels with replace
 * refs off, so a `refs/replace` ref that swaps a genuine tag object for a forged one naming another commit is not followed.
 */
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

/**
 * Test seam: the remote check of a found release tag. The real one is verifyCanonicalRemoteTag: the core checkout's origin, which must be the canonical repository.
 * `sha` (security round 3): the commit the gate proves; the canonical repository must peel the tag to it.
 */
export type RemoteTagCheck = (coreDir: string, tag: string, sha?: string) => Promise<void>;

/**
 * Security round 2 (review: SECURITY_TRUST_ROOT): the repository a release tag must be on, in each URL form an operator's or a CI checkout's origin uses
 * (`git@github.com:robotmoney/robotmoney-core.git`, `ssh://git@github.com/...`, `https://github.com/...`, an https URL with a token in it). It is CORE_REPO of
 * release-gate.ts.
 */
export const CANONICAL_CORE_REMOTE = /^(?:https:\/\/(?:[^@\/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/)robotmoney\/robotmoney-core(?:\.git)?\/?$/i;
/** Security round 3: the URL the release gate reads a tag from: the canonical repository (public), never a remote the checkout names. */
export const CANONICAL_CORE_URL = "https://github.com/robotmoney/robotmoney-core";
/** A remote URL for a message: any user or token before the host is masked (the evidence secret scan reads every log line). */
export const redactRemote = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@\/\s]+@/i, "$1***@");

/**
 * Security round 2: the effective URL of the checkout's origin (`git ls-remote --get-url origin`, after any url.<base>.insteadOf rewrite in its config) must be the
 * canonical repository. Before, the tag was compared with whatever the checkout's origin named, so a fork carrying a release/* tag passed. Throws
 * RELEASE_TAG_REMOTE_MISMATCH otherwise, and when the URL cannot be read.
 */
export async function assertCanonicalOrigin(coreDir: string, git: GitRunner = spawnGit): Promise<string> {
  const r = await git(["-C", coreDir, "ls-remote", "--get-url", "origin"]);
  const url = r.stdout.trim();
  if (r.code !== 0 || url === "") throw new PublishError("RELEASE_TAG_REMOTE_MISMATCH", `the origin of ${coreDir} cannot be read (${redactRemote((r.stderr || "").trim().split("\n").slice(-1)[0] || "no origin")}): a release tag is checked on robotmoney/robotmoney-core only`, { checkout: coreDir });
  if (url === "origin" || !CANONICAL_CORE_REMOTE.test(url)) throw new PublishError("RELEASE_TAG_REMOTE_MISMATCH", `the origin of ${coreDir} is ${redactRemote(url)}, not robotmoney/robotmoney-core: a release tag on another repository (a fork, a local mirror) proves nothing about the reviewed release. Point origin at the canonical repository, fetch the tags, then plan.`, { checkout: coreDir, origin: redactRemote(url) });
  return url;
}

/**
 * The release gate's remote check (security round 2): the origin must be the canonical repository, and it must hold the same tag object.
 * Security round 3 (review: SECURITY_TRUST_ROOT): the tag is read from CANONICAL_CORE_URL in an empty directory outside every checkout (verifyRemoteTag `neutral`),
 * so no config of the checkout under test (url.<base>.insteadOf, core.sshCommand, http.proxy, http.sslVerify) can answer for GitHub. With `sha`, the canonical
 * repository must also peel the tag to that commit (`<tag>^{}`): the local peel is never the only proof that the tag names it.
 */
export async function verifyCanonicalRemoteTag(coreDir: string, tag: string, git: GitRunner = spawnGit, sha?: string): Promise<void> {
  await assertCanonicalOrigin(coreDir, git);
  await verifyRemoteTag(coreDir, tag, CANONICAL_CORE_URL, git, { neutral: true, ...(sha ? { sha } : {}) });
}

/** An empty directory outside every checkout, and the GIT_CEILING_DIRECTORIES that stops git's repository discovery above it. */
function neutralDir(): { dir: string; env: Record<string, string> } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rm-ls-remote-")));
  return { dir, env: { GIT_CEILING_DIRECTORIES: dirname(dir) } };
}

/**
 * The local release tag must exist on the remote with the same tag object (core 1602). A pusher who moved or created a tag locally, or a
 * tag deleted or moved on the remote, is a refusal. An unreachable remote is a refusal too: the check is never skipped.
 * `remote` is a remote name or a URL.
 */
export async function verifyRemoteTag(coreDir: string, tag: string, remote = "origin", git: GitRunner = spawnGit, opts: { neutral?: boolean; sha?: string } = {}): Promise<void> {
  const fail = (why: string, d: Record<string, unknown> = {}) => new PublishError("RELEASE_TAG_REMOTE_MISMATCH", `release tag ${tag} does not match the remote ${redactRemote(remote)}: ${why}. Fetch the tags (git fetch --tags --force) or re-tag, then plan.`, { tag, remote: redactRemote(remote), ...d });
  const ref = `refs/tags/${tag}`;
  const local = await git(["-C", coreDir, "rev-parse", "--verify", "-q", ref]);
  if (local.code !== 0) throw fail("the tag is not in the local checkout");
  const localObj = local.stdout.trim();
  // Security round 3: `neutral` runs ls-remote of a URL in an empty directory outside the checkout (no repo-local config answers); `sha` also asks for the peeled line
  const n = opts.neutral ? neutralDir() : undefined;
  let r: GitResult;
  try {
    r = await git(["-C", n?.dir ?? coreDir, "ls-remote", "--tags", remote, ref, ...(opts.sha ? [`${ref}^{}`] : [])], n ? { env: n.env } : undefined);
  } finally {
    if (n) rmSync(n.dir, { recursive: true, force: true });
  }
  if (r.code !== 0) throw fail(`the remote is unreachable (${redactRemote((r.stderr || "").trim().split("\n").slice(-1)[0] ?? "git ls-remote failed")})`);
  const rows = r.stdout.split("\n").map((l) => l.trim().split(/\s+/));
  const lines = rows.filter((p) => p[1] === ref);
  if (lines.length === 0) throw fail("the remote has no such tag");
  if (lines[0]![0] !== localObj) throw fail(`the remote tag object is ${lines[0]![0]}, the local one is ${localObj}`, { local: localObj, remoteObj: lines[0]![0] });
  if (opts.sha) {
    const peeled = rows.find((p) => p[1] === `${ref}^{}`)?.[0];
    if (peeled !== opts.sha) throw fail(`the remote peels the tag to ${peeled ?? "nothing (no annotated tag)"}, not to ${opts.sha}: the commit under the gate is not the release commit`, { sha: opts.sha, remotePeeled: peeled ?? null });
  }
}
