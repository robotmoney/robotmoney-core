#!/usr/bin/env bun
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S1 (issue 1483).
//
// CI gate: the flags that used to lift a deploy floor must not come back. Exit 0 when no file
// under contracts/ or scripts/ names any of them. Exit 1 and print each hit otherwise.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REMOVED = [
  "SKIP_ROUTER_ADMIN_GRANT",
  "ALLOW_SHORT_TIMELOCK_DELAY",
  "BASKET_VAULT_AUDIT_COMPLETE",
  "REHEARSAL",
];
const ROOTS = ["contracts", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "out", "cache", ".git", "lib"]);
const SELF = resolve(import.meta.path);

const repo = resolve(import.meta.dir, "..", "..");
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
        for (const flag of REMOVED) {
          if (line.includes(flag)) hits.push(`${relative(repo, path)}:${i + 1}: ${flag}`);
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
