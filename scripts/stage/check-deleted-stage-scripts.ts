// CI grep gate: exits 0 only when the second deployment path is gone.
// Absent: the stage ceremony shell, deploy-core-stack.sh, the deploy workflow, the
// Rust harness deployment (forge script calls, demo seeding, faucet funding).
// The stage verbs are Bun TypeScript (scripts/stage/core-stack.ts), called directly. The core-stack.sh shim
// is deleted (core 1488): it must stay absent, and core-stack.ts may not hold deploy or ceremony logic.
// Usage: bun scripts/stage/check-deleted-stage-scripts.ts [repo-root]
// Canonical: the one-deployment-scheme plan (S9, core 1488).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const MUST_BE_ABSENT = [
  "scripts/stage/fusion-ceremony.sh",
  "scripts/stage/deploy-core-stack.sh",
  "scripts/stage/tests/fusion-ceremony-selftest.sh",
  ".github/workflows/deploy-contracts.yml",
  "testing/smoke-test/src/bin/demo-seed-depositors.rs",
  "testing/smoke-test/tests/demo_seeding.rs",
  "testing/smoke-test/tests/full_stack_demo_tvl.rs",
  "testing/smoke-test/tests/faucet_eth.rs",
  "testing/smoke-test/tests/faucet_rm.rs",
  "deployments/timelock-918453.json",
  "scripts/stage/core-stack.sh",
];

/** Patterns that must not appear in the harness, clients, scripts or workflows. */
export const FORBIDDEN_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /run_forge_deploy/, why: "a Rust harness forge deployment" },
  { re: /seed_demo_depositors|demo-seed-depositors|demo_depositor_key/, why: "demo depositor seeding" },
  { re: /dapp_faucet_key|fund_rm_token/, why: "dapp faucet funding" },
  { re: /fusion-ceremony\.sh|deploy-core-stack\.sh/, why: "a deleted stage script" },
  { re: /core-stack\.sh/, why: "the deleted core-stack.sh shim (call scripts/stage/core-stack.ts directly)" },
  { re: /deploy-contracts\.yml/, why: "the deleted deploy workflow (deployment is publish contracts in devops)" },
  { re: /timelock-918453/, why: "the stale timelock record fallback" },
];

/** core-stack wraps boot, health, the record and parity only. These strings mean deploy or ceremony logic crept back. */
export const CORE_STACK_FORBIDDEN = [/forge script/, /cast send/, /fusion-ceremony/, /deploy-core-stack/, /--private-key/];

const SCAN_ROOTS = ["testing", "clients", "scripts", ".github"];
/** Docs are scanned only for the deleted deploy workflow: older design docs may still name demo harness pieces. */
const DOC_ROOT = "docs";
const DOC_FORBIDDEN = FORBIDDEN_PATTERNS.filter((f) => f.re.test("deploy-contracts.yml"));
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "dist", "lib", "out", "cache"]);
/** Files whose job is to NAME the deleted paths (ban lists). They are not a second deployment path. */
const SELF = new Set([
  "scripts/stage/check-deleted-stage-scripts.ts",
  "scripts/stage/tests/check-deleted-stage-scripts.test.ts",
  "scripts/ci/check-no-test-only-code.ts",
]);
const TEXT_EXT = /\.(rs|ts|tsx|js|mjs|sh|yml|yaml|toml|json|md|py|sol|env)$/;

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (TEXT_EXT.test(name)) yield p;
  }
}

/** Files the pattern scan reads. The CLI fails when this is zero: a gate that read nothing proved nothing. */
export function countScanned(root: string): number {
  let n = 0;
  for (const r of SCAN_ROOTS) for (const _ of walk(join(root, r))) n++;
  return n;
}

export function check(root: string): string[] {
  const out: string[] = [];
  for (const f of MUST_BE_ABSENT) if (existsSync(join(root, f))) out.push(`${f} must be absent`);
  for (const r of SCAN_ROOTS) {
    for (const p of walk(join(root, r))) {
      const rel = relative(root, p);
      if (SELF.has(rel)) continue;
      const text = readFileSync(p, "utf8");
      for (const { re, why } of FORBIDDEN_PATTERNS) if (re.test(text)) out.push(`${rel}: mentions ${why} (${re})`);
    }
  }
  for (const p of walk(join(root, DOC_ROOT))) {
    const rel = relative(root, p);
    if (SELF.has(rel) || !p.endsWith(".md")) continue;
    const text = readFileSync(p, "utf8");
    for (const { re, why } of DOC_FORBIDDEN) if (re.test(text)) out.push(`${rel}: mentions ${why} (${re})`);
  }
  for (const f of ["scripts/stage/core-stack.ts", "scripts/stage/parity.ts"]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("#") && !l.trim().startsWith("//"))
      .join("\n");
    for (const re of CORE_STACK_FORBIDDEN) if (re.test(text)) out.push(`${f} holds deploy or ceremony logic (${re})`);
  }
  return out;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  if (countScanned(root) === 0) {
    console.error("deleted-stage-gate: FAIL: no files scanned (zero checks ran)");
    process.exit(1);
  }
  const v = check(root);
  for (const m of v) console.error(`deleted-stage-gate: ${m}`);
  if (v.length) process.exit(1);
  console.log("deleted-stage-gate: the stage ceremony, deploy-core-stack and the Rust harness deployment are gone");
}
