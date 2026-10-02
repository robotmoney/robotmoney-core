// Self-test for scripts/ci/check-removed-flags.ts: the gate passes on the tree and fails, naming
// the file, when a removed flag is planted outside the reasoned allowlist.
// Run: bun test scripts/ci/check-removed-flags.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..");
const gate = join(repo, "scripts/ci/check-removed-flags.ts");
const temps: string[] = [];

function run(root?: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", gate, ...(root ? ["--root", root] : [])], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

function planted(rel: string, body: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "rf-"));
  temps.push(dir);
  mkdirSync(join(dir, "contracts"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
  return run(dir);
}

afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("removed flags gate", () => {
  test("the tree is clean", () => {
    expect(run().code).toBe(0);
  });
  test("a planted flag in a script fails and names the file", () => {
    const r = planted("scripts/stage/x.ts", "const f = process.env.REHEARSAL;\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("scripts/stage/x.ts:1: REHEARSAL");
  });
  test("a planted flag in a Solidity script fails", () => {
    const r = planted("contracts/script/A.s.sol", 'bool x = vm.envOr("ALLOW_SHORT_TIMELOCK_DELAY", false);\n');
    expect(r.code).toBe(1);
  });
  test("a flag planted in an allowlisted file on a non-matching line still fails", () => {
    const r = planted("scripts/stage/sheet-diff.ts", "if (process.env.SKIP_ROUTER_ADMIN_GRANT) {}\n");
    expect(r.code).toBe(1);
  });
  test("a longer identifier that merely contains the word does not match", () => {
    expect(planted("scripts/stage/y.ts", 'const k = "STAGE_REHEARSAL_X";\n').code).toBe(0);
  });
});
