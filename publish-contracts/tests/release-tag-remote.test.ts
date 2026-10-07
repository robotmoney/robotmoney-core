// core 1602: the local release tag must equal the remote tag. The remote is a real temporary bare repo.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { verifyRemoteTag } from "../src/release-tag.ts";
import { tmp } from "./fixtures.ts";

function git(dir: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}
/** A local repo with commits "one" and "two", an annotated release/1.0.0 on two, and a bare remote it was pushed to. */
function world(): { dir: string; remote: string; first: string; second: string } {
  const dir = tmp("pc-rt-local-");
  const remote = tmp("pc-rt-remote-");
  git(remote, "init", "-q", "--bare");
  git(dir, "init", "-q");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  const first = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "-q", "--allow-empty", "-m", "two");
  const second = git(dir, "rev-parse", "HEAD");
  git(dir, "tag", "-a", "release/1.0.0", "-m", "release", second);
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "refs/tags/release/1.0.0");
  return { dir, remote, first, second };
}
const refusal = async (p: Promise<void>): Promise<string> => {
  try { await p; } catch (e) { return (e as { kind?: string }).kind ?? "other"; }
  return "none";
};

describe("verifyRemoteTag", () => {
  test("a tag that matches the remote passes, by remote name and by URL", async () => {
    const w = world();
    await verifyRemoteTag(w.dir, "release/1.0.0", "origin");
    await verifyRemoteTag(w.dir, "release/1.0.0", w.remote);
  });
  test("a tag moved locally but not on the remote is refused", async () => {
    const w = world();
    git(w.dir, "tag", "-f", "-a", "release/1.0.0", "-m", "moved", w.first);
    expect(await refusal(verifyRemoteTag(w.dir, "release/1.0.0", "origin"))).toBe("RELEASE_TAG_REMOTE_MISMATCH");
  });
  test("a tag re-created locally with the same commit but another tag object is refused", async () => {
    const w = world();
    git(w.dir, "tag", "-f", "-a", "release/1.0.0", "-m", "another message", w.second);
    expect(await refusal(verifyRemoteTag(w.dir, "release/1.0.0", "origin"))).toBe("RELEASE_TAG_REMOTE_MISMATCH");
  });
  test("a tag missing on the remote is refused", async () => {
    const w = world();
    git(w.dir, "tag", "-a", "release/2.0.0", "-m", "local only", w.second);
    expect(await refusal(verifyRemoteTag(w.dir, "release/2.0.0", "origin"))).toBe("RELEASE_TAG_REMOTE_MISMATCH");
  });
  test("an unreachable remote is refused, never skipped", async () => {
    const w = world();
    await expect(verifyRemoteTag(w.dir, "release/1.0.0", join(tmp("pc-rt-none-"), "missing.git"))).rejects.toThrow(/unreachable/);
  });
  test("a checkout with no origin is refused", async () => {
    const w = world();
    git(w.dir, "remote", "remove", "origin");
    await expect(verifyRemoteTag(w.dir, "release/1.0.0")).rejects.toThrow(/unreachable/);
  });
});
