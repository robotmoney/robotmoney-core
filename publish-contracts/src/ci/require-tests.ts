#!/usr/bin/env bun
// A required CI guard: a core suite must RUN tests. `bun test` exits 0 when a file has only skipped tests, and a renamed or deleted file
// silently drops out of a long list. This runs every file of a suite on its own and fails when the file is missing, when bun exits
// non-zero, or when fewer than --min tests passed (default 1). A skipped-only file is a zero count and fails here.
//   bun src/ci/require-tests.ts --suite sheet|chain-id|counts|stages|safe|verify|evidence|parity|gates
//   bun src/ci/require-tests.ts --min 3 tests/a.test.ts tests/b.test.ts
// Run from the publish-contracts directory.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

/** The nine core suites of the publish contracts package. Each file must pass at least one test. */
export const SUITES: Record<string, string[]> = {
  sheet: ["tests/sheet.test.ts", "tests/merge-sheet.test.ts"],
  "chain-id": ["tests/chain-id.test.ts", "tests/chain-floors.test.ts", "tests/floors.test.ts"],
  counts: ["tests/counts.test.ts"],
  stages: ["tests/stages.test.ts", "tests/preflight.test.ts", "tests/runner.test.ts", "tests/core-harness-contract.test.ts"],
  // src/safe/e2e.test.ts needs a real SafeL2 on the Twin chain: it runs in the safe-e2e job of publish-contracts.yml, not here
  safe: ["src/safe/unit.test.ts", "src/safe/repo-guard.test.ts"],
  verify: ["tests/verify/units.test.ts", "tests/verify/verify.test.ts", "tests/verify/artifacts.test.ts", "tests/verify/guard.test.ts", "tests/verify-stage.test.ts"],
  evidence: ["tests/evidence-check.test.ts", "tests/evidence-secret-scan.test.ts"],
  // reads core's stage table from REPO_ROOT (core checked out at the pinned DEPLOY_SHA): every row, env name, manifest and artifact exists in core
  parity: ["tests/core-parity.test.ts"],
  // the workflow gates: plan gate (core check-sha-green wiring), workflow inputs and pins, config-check, sheet merge
  gates: ["tests/plan-gate.test.ts", "tests/config-check.test.ts"],
};

export interface FileResult { file: string; ok: boolean; passed: number; failed: number; skipped: number; reason?: string }

/** The pass, fail and skip counts in the summary lines bun prints (` 12 pass`, ` 0 skip`, ` 0 fail`). */
export function parseCounts(output: string): { passed: number; failed: number; skipped: number } {
  const n = (word: string): number => Number(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "m").exec(output)?.[1] ?? 0);
  return { passed: n("pass"), failed: n("fail"), skipped: n("skip") };
}

export type Runner = (file: string) => Promise<{ code: number; output: string }>;

export const bunRunner: Runner = async (file) => {
  const p = Bun.spawn(["bun", "test", file], { stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, output: out + err };
};

export async function checkFiles(files: string[], min = 1, run: Runner = bunRunner, exists: (f: string) => boolean = existsSync): Promise<FileResult[]> {
  const out: FileResult[] = [];
  for (const file of files) {
    if (!exists(file)) { out.push({ file, ok: false, passed: 0, failed: 0, skipped: 0, reason: "the test file does not exist" }); continue; }
    const r = await run(file);
    const c = parseCounts(r.output);
    let reason: string | undefined;
    if (r.code !== 0 || c.failed > 0) reason = `bun test exited ${r.code} with ${c.failed} failing`;
    else if (c.passed < min) reason = `${c.passed} tests passed, at least ${min} required (${c.skipped} skipped): a suite that runs nothing is a failure`;
    out.push({ file, ok: reason === undefined, ...c, reason });
  }
  return out;
}

export async function main(argv: string[], run: Runner = bunRunner): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { suite: { type: "string" }, min: { type: "string" } } });
  const files = v.suite ? SUITES[v.suite] : positionals;
  if (!files || files.length === 0) { console.error(`usage: require-tests.ts --suite ${Object.keys(SUITES).join("|")} | [--min N] FILE...`); return 2; }
  const min = v.min ? Number(v.min) : 1;
  const results = await checkFiles(files, min, run);
  for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.file}: ${r.passed} pass, ${r.skipped} skip, ${r.failed} fail${r.reason ? ` (${r.reason})` : ""}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
