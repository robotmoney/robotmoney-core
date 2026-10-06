#!/usr/bin/env bun
// Canonical: owner decision 2026-10-05 (core S-one-driver): core never depends on devops.
//
// The dependency direction is devops -> core only. Devops checks core out. Core is public and
// checks nothing of devops out. This gate fails when a core workflow, script, test or doc contains:
//   - a checkout of robotmoney/devops (the repository slug),
//   - DEVOPS_READ_TOKEN (the token that read the private devops repo),
//   - PUBLISH_CONTRACTS_DIR (the indirection to a devops checkout of the driver),
//   - an import path into a devops checkout (from "../devops/...", require("devops/..."), ../devops/ or devops/publish-contracts).
// The allowlist is documented below: files that NAME the banned strings to ban them or to prove the ban,
// and lines that say devops checks core out (the allowed direction).
//
// Usage: bun scripts/ci/check-no-devops-dependency.ts [--root DIR]
//   --root DIR   scan DIR instead of the repo (the unit test plants violations in a temp tree)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface Rule { re: RegExp; why: string }
export const RULES: Rule[] = [
  { re: /robotmoney\/devops(?!\s+(?:issues?|PRs?|pull)\b|#|\/(?:issues|pull)\b)/i, why: "the robotmoney/devops repository (no checkout of devops in core; an issue reference such as \"robotmoney/devops issue 53\" is history and allowed)" },
  { re: /DEVOPS_READ_TOKEN/, why: "DEVOPS_READ_TOKEN (core never reads the private devops repo)" },
  { re: /PUBLISH_CONTRACTS_DIR/, why: "PUBLISH_CONTRACTS_DIR (the driver is in this repo: publish-contracts/src/cli.ts)" },
  { re: /\b(?:from|import|require\s*\()\s*["'][^"']*\bdevops\b[^"']*["']/, why: "an import path into a devops checkout" },
  { re: /\.\.\/devops\b|\bdevops\/(?:publish-contracts|src|scripts)\b/, why: "a path into a devops checkout" },
];

/** Files that must NAME the banned strings (the ban list and its proof). Whole file exempt. */
export const FILE_ALLOWLIST: Record<string, string> = {
  "scripts/ci/check-no-devops-dependency.ts": "this gate: the ban list",
  "scripts/ci/check-no-devops-dependency.test.ts": "this gate's unit test: plants violations",
  "scripts/stage/check-deleted-stage-scripts.ts": "the deleted-path gate: its ban list names the same strings",
  "scripts/stage/tests/check-deleted-stage-scripts.test.ts": "the deleted-path gate's unit test: plants violations",
};

/** A line that states the allowed direction (devops checks core out) is exempt. */
export const SENTENCE_ALLOW = /devops (?:workflows? )?(?:checks?|checked|checking) (?:this repo|core|robotmoney-core)(?: [a-z-]+){0,3} out|dependency direction is devops (?:to|->|→) core/i;

const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", "lib", "out", "cache", "broadcast", "coverage"]);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|sh|py|rs|toml|sol|env|example|txt|html)$|(^|\/)(Makefile|Dockerfile)[^/]*$/;
const MAX_BYTES = 2_000_000;

export interface Hit { file: string; line: number; why: string; text: string }

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile() && st.size <= MAX_BYTES && TEXT_EXT.test(p)) yield p;
  }
}

export function scan(root: string): { hits: Hit[]; scanned: number } {
  const hits: Hit[] = [];
  let scanned = 0;
  for (const path of walk(root)) {
    const rel = relative(root, path).split("\\").join("/");
    if (FILE_ALLOWLIST[rel]) continue;
    scanned++;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (SENTENCE_ALLOW.test(text)) return;
      for (const r of RULES) if (r.re.test(text)) hits.push({ file: rel, line: i + 1, why: r.why, text: text.trim().slice(0, 160) });
    });
  }
  return { hits, scanned };
}

export function main(argv: string[]): number {
  const i = argv.indexOf("--root");
  const root = resolve(i >= 0 && argv[i + 1] ? argv[i + 1]! : join(import.meta.dir, "..", ".."));
  const { hits, scanned } = scan(root);
  if (scanned === 0) { console.error("check-no-devops-dependency: scanned zero files (wrong --root?)"); return 2; }
  for (const h of hits) console.error(`${h.file}:${h.line}: ${h.why}: ${h.text}`);
  if (hits.length) { console.error(`check-no-devops-dependency: ${hits.length} violation(s). Core must not depend on devops.`); return 1; }
  console.log(`check-no-devops-dependency: ok (${scanned} files scanned)`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
