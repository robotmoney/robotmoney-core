// core 1524: the release tag of a DEPLOY_SHA, read from a real temporary git repo.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_CORE_URL, releaseTagFor, releaseTagsFor, verifyCanonicalRemoteTag, verifyRemoteTag, type GitRunner } from "../src/release-tag.ts";
import { tmp } from "./fixtures.ts";

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
function repo(): { dir: string; first: string; second: string } {
  const dir = tmp("pc-git-");
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a"), "1");
  git(dir, "add", "a");
  git(dir, "commit", "-q", "-m", "one");
  const first = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "a"), "2");
  git(dir, "commit", "-q", "-am", "two");
  return { dir, first, second: git(dir, "rev-parse", "HEAD") };
}

describe("release tag", () => {
  test("an annotated release tag at the SHA is found", async () => {
    const r = repo();
    git(r.dir, "tag", "-a", "release/1.0.0", "-m", "release", r.second);
    expect(await releaseTagFor(r.dir, r.second)).toBe("release/1.0.0");
  });
  test("a lightweight tag at the SHA is refused", async () => {
    const r = repo();
    git(r.dir, "tag", "release/1.0.0", r.second);
    expect(await releaseTagFor(r.dir, r.second)).toBeNull();
  });
  test("an annotated tag on another SHA is refused", async () => {
    const r = repo();
    git(r.dir, "tag", "-a", "release/1.0.0", "-m", "release", r.first);
    expect(await releaseTagFor(r.dir, r.second)).toBeNull();
    expect(await releaseTagFor(r.dir, r.first)).toBe("release/1.0.0");
  });
  test("no tag at all is refused, and a tag outside release/ does not count", async () => {
    const r = repo();
    expect(await releaseTagFor(r.dir, r.second)).toBeNull();
    git(r.dir, "tag", "-a", "v1.0.0", "-m", "version", r.second);
    expect(await releaseTagFor(r.dir, r.second)).toBeNull();
  });
  test("every annotated release tag at the SHA is listed", async () => {
    const r = repo();
    git(r.dir, "tag", "-a", "release/1.0.1", "-m", "b", r.second);
    git(r.dir, "tag", "-a", "release/1.0.0", "-m", "a", r.second);
    expect(await releaseTagsFor(r.dir, r.second)).toEqual(["release/1.0.0", "release/1.0.1"]);
  });
  test("a directory that is not a git repo fails loudly", async () => {
    await expect(releaseTagFor(tmp("pc-nogit-"), "a".repeat(40))).rejects.toThrow();
  });
});

/** A real repo with an annotated release/1.0 on X (`first`) and an untagged commit Y (`second`), and a refs/replace ref that swaps the genuine tag object for a forged one on Y. */
function replacedTag(): { dir: string; x: string; y: string; tagObj: string } {
  const r = repo();
  git(r.dir, "tag", "-a", "release/1.0", "-m", "release", r.first);
  const tagObj = git(r.dir, "rev-parse", "refs/tags/release/1.0");
  const forged = execFileSync("git", ["-C", r.dir, "mktag"], { input: `object ${r.second}\ntype commit\ntag release/1.0\ntagger t <t@example.com> 0 +0000\n\nforged\n`, stdio: "pipe" }).toString().trim();
  git(r.dir, "replace", "-f", tagObj, forged);
  return { dir: r.dir, x: r.first, y: r.second, tagObj };
}
const kindOf = async (p: Promise<unknown>): Promise<string> => { try { await p; return "none"; } catch (e) { return (e as { kind?: string }).kind ?? "other"; } };

describe("security round 3 (review: SECURITY_TRUST_ROOT): the release tag is read with replace refs off and nothing of the caller's git environment", () => {
  test("a refs/replace ref that swaps the genuine release tag object for a forged tag on an untagged commit does not tag that commit", async () => {
    const t = replacedTag();
    // the forgery is live for a plain git: for-each-ref peels the genuine tag to Y
    expect(git(t.dir, "for-each-ref", "--format=%(*objectname)", "refs/tags/release/1.0")).toBe(t.y);
    expect(await releaseTagsFor(t.dir, t.y)).toEqual([]);
    expect(await releaseTagsFor(t.dir, t.x)).toEqual(["release/1.0"]);
  });

  test("a GIT_DIR in the caller's environment that names another repository is not read: the same result", async () => {
    const t = replacedTag();
    const other = repo(); // a repository where release/1.0 genuinely tags its own second commit
    git(other.dir, "tag", "-a", "release/1.0", "-m", "other", other.second);
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_NO_REPLACE_OBJECTS: process.env.GIT_NO_REPLACE_OBJECTS };
    process.env.GIT_DIR = join(other.dir, ".git");
    try {
      expect(await releaseTagsFor(t.dir, t.y)).toEqual([]);
      expect(await releaseTagsFor(t.dir, t.x)).toEqual(["release/1.0"]);
      expect(await releaseTagsFor(t.dir, other.second)).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("with the sha, the remote must peel the tag to it: a remote whose tag names another commit is refused", async () => {
    const r = repo();
    const remote = tmp("pc-rt3-remote-");
    git(remote, "init", "-q", "--bare");
    git(r.dir, "tag", "-a", "release/1.0", "-m", "release", r.first);
    git(r.dir, "remote", "add", "origin", remote);
    git(r.dir, "push", "-q", "origin", "refs/tags/release/1.0");
    await verifyRemoteTag(r.dir, "release/1.0", "origin", undefined, { sha: r.first });
    expect(await kindOf(verifyRemoteTag(r.dir, "release/1.0", "origin", undefined, { sha: r.second }))).toBe("RELEASE_TAG_REMOTE_MISMATCH");
    // the replace-ref forgery on top: the local tag object still equals the remote one, the remote's peel names X, so Y is refused
    const t = replacedTag();
    const tr = tmp("pc-rt3-remote-");
    git(tr, "init", "-q", "--bare");
    git(t.dir, "remote", "add", "origin", tr);
    git(t.dir, "push", "-q", "origin", "refs/tags/release/1.0");
    expect(await kindOf(verifyRemoteTag(t.dir, "release/1.0", "origin", undefined, { sha: t.y }))).toBe("RELEASE_TAG_REMOTE_MISMATCH");
  });

  test("neutral: ls-remote runs outside the checkout, so a url.<base>.insteadOf in the checkout's config cannot answer for the remote", async () => {
    const r = repo();
    const mirror = tmp("pc-rt3-mirror-");
    git(mirror, "init", "-q", "--bare");
    git(r.dir, "tag", "-a", "release/1.0", "-m", "release", r.first);
    git(r.dir, "push", "-q", mirror, "refs/tags/release/1.0");
    const url = "file:///nonexistent-rm-canonical/robotmoney-core.git";
    git(r.dir, "config", `url.${mirror}.insteadOf`, url);
    // from inside the checkout the rewrite answers (the old behaviour), from a neutral directory it does not
    await verifyRemoteTag(r.dir, "release/1.0", url, undefined, { sha: r.first });
    await expect(verifyRemoteTag(r.dir, "release/1.0", url, undefined, { neutral: true, sha: r.first })).rejects.toThrow(/unreachable/);
  });

  test("verifyCanonicalRemoteTag asks the canonical https URL, from a directory that is not the checkout, for the tag and its peeled commit", async () => {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const OBJ = "1".repeat(40), SHA = "2".repeat(40);
    const fake = (peeled: string): GitRunner => async (args, opts) => {
      calls.push({ args, env: opts?.env });
      if (args.includes("--get-url")) return { code: 0, stdout: "git@github.com:robotmoney/robotmoney-core.git\n", stderr: "" };
      if (args.includes("rev-parse")) return { code: 0, stdout: `${OBJ}\n`, stderr: "" };
      return { code: 0, stdout: `${OBJ}\trefs/tags/release/1.0\n${peeled}\trefs/tags/release/1.0^{}\n`, stderr: "" };
    };
    await verifyCanonicalRemoteTag("/checkout", "release/1.0", fake(SHA), SHA);
    const ls = calls.find((c) => c.args.includes("ls-remote") && c.args.includes("--tags"))!;
    expect(ls.args.slice(2)).toEqual(["ls-remote", "--tags", CANONICAL_CORE_URL, "refs/tags/release/1.0", "refs/tags/release/1.0^{}"]);
    expect(ls.args[1]).not.toBe("/checkout");
    expect(ls.env?.GIT_CEILING_DIRECTORIES).toBeDefined();
    // mutation: the canonical repository peels the tag to another commit
    expect(await kindOf(verifyCanonicalRemoteTag("/checkout", "release/1.0", fake("3".repeat(40)), SHA))).toBe("RELEASE_TAG_REMOTE_MISMATCH");
  });
});
