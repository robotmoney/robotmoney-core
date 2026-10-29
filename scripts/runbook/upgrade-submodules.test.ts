// Tests for scripts/runbook/upgrade-submodules.sh (issue 1996): the --upgrade-build checkout takes every submodule, nested ones included, from the main
// checkout's own submodule repositories, so a library already present is never fetched from the network, and the shared git config is never written.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./validate-contract-qa.ts";

const SCRIPT = join(ROOT, "scripts/runbook/upgrade-submodules.sh");
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", ["-c", "protocol.file.allow=always", "-c", "init.defaultBranch=main", ...args], { cwd, env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
/** A repository with one committed file and, optionally, a submodule added from a local path (the test removes that path later, so its URL is unreachable). */
function repo(dir: string, file: string, sub?: { path: string; from: string }): void {
  git(tmpdir(), "init", "-q", dir);
  writeFileSync(join(dir, file), file);
  if (sub) {
    git(dir, "submodule", "add", "-q", sub.from, sub.path);
    git(dir, "submodule", "update", "--init", "--recursive", "-q");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "c");
}

test("every submodule, nested ones included, is cloned from the main checkout with no network, and the shared config is not written", () => {
  const t = mkdtempSync(join(tmpdir(), "upgrade-submodules-"));
  try {
    repo(join(t, "inner"), "inner.txt");
    repo(join(t, "lib"), "lib.txt", { path: "lib/inner", from: join(t, "inner") });
    repo(join(t, "main"), "main.txt", { path: "lib/x", from: join(t, "lib") });
    // the main checkout's nested submodule must be its own repository to be reused: initialise it recursively
    git(join(t, "main"), "submodule", "update", "--init", "--recursive", "-q");
    // every recorded URL now points nowhere: a clone from a URL (the network path) fails the test
    rmSync(join(t, "inner"), { recursive: true }); rmSync(join(t, "lib"), { recursive: true });
    const config = readFileSync(join(t, "main", ".git", "config"), "utf8");
    git(join(t, "main"), "worktree", "add", "-q", "--detach", join(t, "v060"), "HEAD");
    const r = spawnSync("bash", [SCRIPT, join(t, "v060"), join(t, "main")], { env: ENV, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("submodule lib/x at");
    expect(r.stdout).toContain("submodule lib/inner at");
    expect(r.stdout).not.toContain("fetched from its URL");
    expect(existsSync(join(t, "v060", "lib/x/lib.txt"))).toBe(true);
    expect(existsSync(join(t, "v060", "lib/x/lib/inner/inner.txt"))).toBe(true);
    expect(git(join(t, "v060"), "status", "--porcelain")).toBe("");
    expect(git(join(t, "v060"), "submodule", "status", "--recursive")).not.toMatch(/^-/m);
    expect(readFileSync(join(t, "main", ".git", "config"), "utf8")).toBe(config);
    // a rerun on the filled checkout is a no-op that still passes
    expect(spawnSync("bash", [SCRIPT, join(t, "v060"), join(t, "main")], { env: ENV }).status).toBe(0);
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test("a commit the main checkout lacks is fetched from its URL, which here is gone, so the script fails rather than build a partial checkout", () => {
  const t = mkdtempSync(join(tmpdir(), "upgrade-submodules-"));
  try {
    repo(join(t, "lib"), "lib.txt");
    repo(join(t, "main"), "main.txt", { path: "lib/x", from: join(t, "lib") });
    // a new lib commit recorded in main but absent from main's own lib/x repository
    writeFileSync(join(t, "lib", "new.txt"), "n"); git(join(t, "lib"), "add", "-A"); git(join(t, "lib"), "commit", "-q", "-m", "n");
    git(join(t, "main", "lib/x"), "fetch", "-q", join(t, "lib"), "main"); git(join(t, "main", "lib/x"), "checkout", "-q", "FETCH_HEAD");
    git(join(t, "main"), "add", "lib/x"); git(join(t, "main"), "commit", "-q", "-m", "bump");
    git(join(t, "main", "lib/x"), "checkout", "-q", "HEAD~1"); git(join(t, "main", "lib/x"), "reflog", "expire", "--expire=now", "--all"); git(join(t, "main", "lib/x"), "gc", "-q", "--prune=now");
    rmSync(join(t, "lib"), { recursive: true });
    git(join(t, "main"), "worktree", "add", "-q", "--detach", join(t, "v060"), "HEAD");
    const r = spawnSync("bash", [SCRIPT, join(t, "v060"), join(t, "main")], { env: ENV, encoding: "utf8" });
    expect(r.stdout).toContain("fetched from its URL with --reference");
    expect(r.status).not.toBe(0);
  } finally { rmSync(t, { recursive: true, force: true }); }
});
