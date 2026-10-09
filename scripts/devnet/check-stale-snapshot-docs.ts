// Canonical: core issues 1498, 1496. Docs gate: the retired snapshot / geth devnet phrases must not
// appear outside an allowlist. Run: bun scripts/devnet/check-stale-snapshot-docs.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const STALE = /anvil_dumpState|genesis-alloc|genesis ingester|load-state|CURRENT.anvil-state|warm list|snapshot-fork|geth \+ lighthouse|fork-state/i;
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "lib", "out", "cache", "deployments", "code-review", "code-reviews"]);
const EXT = /\.(md|mdx|ya?ml|ts|rs|sh|toml|json|mjs|sol)$/;
// Files that name the retired phrases on purpose: they are the Twin chain docs and the gates themselves.
export const ALLOWED_FILES = new Set([
  "scripts/devnet/check-stale-snapshot-docs.ts",
  "scripts/devnet/check-stale-snapshot-docs.test.ts",
  "scripts/devnet/check-twin-chain-ci-selftest.ts",
  "scripts/devnet/twin-fork-lib.ts",
  "scripts/devnet/twin-fork-lib.test.ts",
  "scripts/devnet/README.md",
  "scripts/devnet/README-twin-fork.md",
  "testing/smoke-test/src/twin_fork.rs",
  "docs/technical/full-stack-devnet.md",
  "docs/development/smoke-test-design.md",
  "docs/development/ci-suites.md",
  "docs/development/environments.md",
  "docs/technical/governance-isomorphism.md",
  "testing/ethereum-testnet/README.md",
  "testing/fork-e2e-rust/README.md",
  ".github/workflows/suite-13-doc-checks.yml",
]);
/** A line passes when it says the phrase is gone, or the file opens with a Historical/Superseded banner. */
export const NEGATION = /\b(no|not|never|retired|deleted|removed|replaces?d?|superseded|historical|history|gone|no longer)\b/i;
export const BANNER = /^\s*(>\s*\*\*Historical|-\s*\*\*Status:\*\*\s*Superseded)/m;

export function scanText(path: string, text: string): string[] {
  if (ALLOWED_FILES.has(path)) return [];
  if (BANNER.test(text.split("\n").slice(0, 12).join("\n"))) return [];
  const lines = text.split("\n");
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (!STALE.test(l)) return;
    const ctx = lines.slice(Math.max(0, i - 1), i + 2).join(" ");
    if (NEGATION.test(ctx)) return;
    out.push(`${path}:${i + 1}: ${l.trim().slice(0, 120)}`);
  });
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(e)) yield p;
  }
}

if (import.meta.main) {
  const hits: string[] = [];
  for (const f of walk(".")) hits.push(...scanText(f.replace(/^\.\//, ""), readFileSync(f, "utf8")));
  if (hits.length) {
    console.error(`retired snapshot or geth devnet phrases outside the allowlist:\n  ${hits.join("\n  ")}`);
    process.exit(1);
  }
  console.log("stale snapshot docs gate: clean");
}
