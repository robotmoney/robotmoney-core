#!/usr/bin/env bun
// Canonical: core issue 1499, core S5 (issue 1487).
//
// CI gate: setRegistry is called nowhere under contracts/script or scripts except
// DeployTimelock.s.sol. Vault deploy scripts must never link the registry.
// Usage: bun scripts/ci/check-set-registry-owner.ts [--root DIR]   (default: repo root)
//   --root DIR   scan DIR instead of the repo (the self-test plants a line in a temp copy)
// Exit 0 when every hit is allowed. Exit 1 and print each hit otherwise.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Reasoned allowlist, matched on the repo-relative path.
export const SET_REGISTRY_ALLOWLIST: { file: string; reason: string }[] = [
  { file: "contracts/script/DeployTimelock.s.sol", reason: "the one script that links the registry, in the timelock stage" },
  { file: "scripts/ci/check-set-registry-owner.ts", reason: "this gate names the call it bans" },
  { file: "scripts/ci/check-set-registry-owner.test.ts", reason: "this gate's self-test plants the call to prove the gate fails" },
  {
    file: "publish-contracts/src/verify/index.ts",
    reason: "the one verifier: an eth_call probe that a second setRegistry reverts; it never sends the call",
  },
  { file: "publish-contracts/tests/verify/world.ts", reason: "the verifier's unit-test chain: answers that probe" },
  { file: "publish-contracts/tests/verify/negative-fixtures.test.ts", reason: "plants the fault that label catches" },
  { file: "publish-contracts/tests/verify/fixtures/expected-labels.json", reason: "the committed label list names the check" },
  { file: "publish-contracts/tests/fixtures/verifier-labels.txt", reason: "the committed label list names the check" },
];

const SKIP_DIRS = new Set(["node_modules", "out", "cache", ".git", "lib", "target", "broadcast"]);
const rootArg = process.argv.indexOf("--root");
const repo = resolve(rootArg >= 0 ? process.argv[rootArg + 1]! : join(import.meta.dir, "..", ".."));

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const hits: string[] = [];
let scanned = 0;
for (const root of ["contracts/script", "scripts"]) {
  for (const f of walk(join(repo, root))) {
    const rel = relative(repo, f).split("\\").join("/");
    scanned++;
    if (SET_REGISTRY_ALLOWLIST.some((a) => a.file === rel)) continue;
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("setRegistry")) hits.push(`setRegistry outside the allowlist: ${rel}:${i + 1}: ${line.trim()}`);
      });
  }
}

if (scanned === 0) {
  console.error("check-set-registry-owner: FAIL: no files scanned (zero checks ran)");
  process.exit(1);
}
if (hits.length > 0) {
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log(`ok: setRegistry appears only in the allowlist (${scanned} files scanned)`);
