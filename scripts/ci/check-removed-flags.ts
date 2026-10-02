#!/usr/bin/env bun
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S1 (issue 1483).
//
// CI gate: the flags that used to lift a deploy floor must not come back. Exit 0 when no file
// under contracts/ or scripts/ names any of them. Exit 1 and print each hit otherwise.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Usage: bun scripts/ci/check-removed-flags.ts [--root DIR]
//   --root DIR   scan DIR instead of the repo (the self-test plants a flag in a temp copy)

const REMOVED = [
  "SKIP_ROUTER_ADMIN_GRANT",
  "ALLOW_SHORT_TIMELOCK_DELAY",
  "BASKET_VAULT_AUDIT_COMPLETE",
  "REHEARSAL",
];
const ROOTS = ["contracts", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "out", "cache", ".git", "lib"]);
const SELF = resolve(import.meta.path);

// Reasoned allowlist. A hit is exempt only when its file AND its line both match one rule. These
// are the places that must NAME a removed flag in order to ban it or to prove the ban. A use
// anywhere else, or a different use in these files, still fails.
export interface FlagAllow {
  file: string;
  line: RegExp;
  reason: string;
}
export const FLAG_ALLOWLIST: FlagAllow[] = [
  {
    file: "scripts/stage/sheet-diff.ts",
    line: /^\s*"[A-Z_]+",\s*$/,
    reason: "FORBIDDEN_KEYS: the parity check's own ban list; the flags are listed so any sheet carrying one fails",
  },
  {
    file: "scripts/stage/tests/sheet-diff.test.ts",
    line: /ALLOW_SHORT_TIMELOCK_DELAY|REHEARSAL/,
    reason: "test fixture: plants a banned key in a sheet to prove the parity check rejects it",
  },
  {
    file: "scripts/ci/check-removed-flags.test.ts",
    line: /REHEARSAL|ALLOW_SHORT_TIMELOCK_DELAY|SKIP_ROUTER_ADMIN_GRANT/,
    reason: "this gate's self-test: the planted violations are the proof that the gate still fails",
  },
  {
    file: "scripts/stage/tests/core-stack.test.ts",
    line: /REHEARSAL=1/,
    reason: "test fixture: plants a banned key in a sheet to prove the parity check rejects it",
  },
];

// Match the flag as a whole identifier so names such as STAGE_KEY_DIR never collide with it.
const flagRe = (flag: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${flag}(?![A-Za-z0-9_])`);

const rootArg = process.argv.indexOf("--root");
const repo = resolve(rootArg >= 0 ? process.argv[rootArg + 1]! : join(import.meta.dir, "..", ".."));
const hits: string[] = [];

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      walk(path);
    } else if (resolve(path) !== SELF) {
      const text = readFileSync(path, "utf8");
      text.split("\n").forEach((line, i) => {
        const rel = relative(repo, path).split("\\").join("/");
        for (const flag of REMOVED) {
          if (!flagRe(flag).test(line)) continue;
          if (FLAG_ALLOWLIST.some((a) => a.file === rel && a.line.test(line))) continue;
          hits.push(`${rel}:${i + 1}: ${flag}`);
        }
      });
    }
  }
}

for (const root of ROOTS) walk(join(repo, root));

if (hits.length > 0) {
  console.error("Removed deploy flags are back:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`ok: none of ${REMOVED.join(", ")} appears under ${ROOTS.join(", ")}`);
