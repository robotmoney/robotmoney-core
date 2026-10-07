// core 1524: the release tag of a DEPLOY_SHA, read from a real temporary git repo.
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseTagFor, releaseTagsFor } from "../src/release-tag.ts";
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
