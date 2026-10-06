// THE shared allowlist for every repo-scan guard (src/safe/repo-guard.test.ts, tests/verify/guard.test.ts, tests/tree.test.ts,
// tests/workflow-inputs.test.ts, scripts/check-no-fork-rehearsal-refs.ts). A guard asserts that a removed name is gone from the tree.
// Files that legitimately name a removed thing are listed here ONCE, each with its reason: the guards themselves, and docs history.
// Nothing else is exempt. Add a file here only when it must quote a removed name to assert that the name is gone.
// Plain TypeScript with node imports only, so scripts/ may import it too.
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

/** Repo-relative file -> why it may name removed things. */
export const ALLOWED_FILES: Readonly<Record<string, string>> = {
  "publish-contracts/src/safe/repo-guard.test.ts": "guard: the removed shell Safe tool and the Safe Transaction Service are gone",
  "publish-contracts/tests/verify/guard.test.ts": "guard: the superseded verifier scripts are gone",
  "publish-contracts/tests/tree.test.ts": "guard: the four ceremony shell scripts are gone",
  "publish-contracts/tests/guard-allowlist.ts": "this allowlist module itself",
  "scripts/assert-basescan-verified.sh": "a comment that says the removed devops verifier script replaced it",
  "scripts/check-no-fork-rehearsal-refs.ts": "guard: lists the deleted script names it forbids",
  "scripts/check-no-fork-rehearsal-refs.test.ts": "guard: planted-violation fixtures",
  "scripts/check-docs.ts": "docs checker: lists deleted names it rejects",
};

/** Directory prefixes that are history: they quote old names on purpose. */
export const ALLOWED_DIRS: readonly string[] = ["docs/code-reviews", "docs/plans", "docs/archive"];

export const isAllowed = (rel: string): boolean => rel in ALLOWED_FILES || ALLOWED_DIRS.some((d) => rel === d || rel.startsWith(d + "/"));

/** git pathspec excludes for the allowlist, for `git grep -- . <excludes>`. */
export const pathspecExcludes = (): string[] => [...ALLOWED_DIRS, ...Object.keys(ALLOWED_FILES)].map((p) => `:!${p}`);

/** Tracked and untracked (not ignored) files in `root` whose text matches the ERE `pattern`, minus the allowlist. */
export function repoGrep(root: string, pattern: string): string[] {
  const r = spawnSync("git", ["-C", resolve(root), "grep", "--untracked", "-lIE", pattern, "--", ".", ...pathspecExcludes()], { encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean);
}

/** The repo root of this checkout. */
export const REPO_ROOT = join(import.meta.dir, "..", "..");
