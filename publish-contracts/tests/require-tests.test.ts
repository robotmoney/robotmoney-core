// The non-zero-count guard (src/ci/require-tests.ts): zero passing tests fails, a missing file fails, a failing test fails.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUITES, checkFiles, main, parseCounts } from "../src/ci/require-tests.ts";

describe("parseCounts", () => {
  test("reads the bun summary lines", () => {
    expect(parseCounts("bun test\n\n 12 pass\n 1 skip\n 0 fail\nRan 13 tests")).toEqual({ passed: 12, failed: 0, skipped: 1 });
    expect(parseCounts("nothing")).toEqual({ passed: 0, failed: 0, skipped: 0 });
  });
});

describe("checkFiles with a fake runner", () => {
  const run = (o: string, code = 0) => async () => ({ code, output: o });
  test("passes with at least one passing test", async () => {
    expect((await checkFiles(["a"], 1, run(" 3 pass\n 0 fail\n"), () => true))[0]!.ok).toBe(true);
  });
  test("fails on zero passing (all skipped)", async () => {
    const r = (await checkFiles(["a"], 1, run(" 0 pass\n 4 skip\n 0 fail\n"), () => true))[0]!;
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("runs nothing");
  });
  test("fails on a failing test, on a non-zero exit and on a missing file", async () => {
    expect((await checkFiles(["a"], 1, run(" 2 pass\n 1 fail\n", 1), () => true))[0]!.ok).toBe(false);
    expect((await checkFiles(["a"], 1, run(" 2 pass\n 0 fail\n", 1), () => true))[0]!.ok).toBe(false);
    expect((await checkFiles(["gone"], 1, run(""), () => false))[0]!.reason).toContain("does not exist");
  });
  test("--min is honoured", async () => {
    expect((await checkFiles(["a"], 5, run(" 3 pass\n 0 fail\n"), () => true))[0]!.ok).toBe(false);
  });
});

describe("the real runner on tiny files", () => {
  const dir = mkdtempSync(join(tmpdir(), "require-tests-"));
  const file = (n: string, body: string) => { const p = join(dir, n); writeFileSync(p, `import { test, expect } from "bun:test";\n${body}\n`); return p; };
  test("a passing file is ok, a skip-only file fails", async () => {
    const ok = file("ok.test.ts", 'test("one", () => expect(1).toBe(1));');
    const skipped = file("skip.test.ts", 'test.skip("one", () => expect(1).toBe(1));');
    expect(await main([ok])).toBe(0);
    expect(await main([skipped])).toBe(1);
  }, 30_000);
});

describe("the suites", () => {
  test("the ten core suites exist and name only test files that exist", async () => {
    expect(Object.keys(SUITES).sort()).toEqual(["chain-id", "counts", "evidence", "gates", "parity", "safe", "sheet", "stages", "systems", "verify"]);
    const { existsSync } = await import("node:fs");
    const root = join(import.meta.dir, "..");
    for (const files of Object.values(SUITES)) for (const f of files) expect(existsSync(join(root, f))).toBe(true);
  });
  // issue 1892: the systems suite is a required runtime guard. A removed file, a zero count or a skipped-only file fails it, and each named case must have run.
  test("the systems suite names the gateway runner, both verifiers' system cases, the historical reading and the gateway evidence, and a floor of tests each", async () => {
    expect(SUITES.systems).toEqual(["tests/gateway-system-runner.test.ts", "tests/gateway-sheet.test.ts", "tests/verify/systems.test.ts", "tests/verify/historical.test.ts", "tests/evidence-gateway.test.ts"]);
    const run = async (file: string): Promise<{ code: number; output: string }> => ({ code: 0, output: file.includes("historical") ? " 3 pass\n 0 skip\n 0 fail\n" : " 12 pass\n 0 skip\n 0 fail\n" });
    const r = await checkFiles(SUITES.systems!, 4, run);
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false, true]);
    expect(r[3]!.reason).toContain("at least 4 required");
    const skipped = await checkFiles(SUITES.systems!, 4, async () => ({ code: 0, output: " 0 pass\n 9 skip\n 0 fail\n" }));
    expect(skipped.every((x) => !x.ok)).toBe(true);
    const missing = await checkFiles(SUITES.systems!, 4, run, (f) => !f.includes("evidence-gateway"));
    expect(missing[4]!.reason).toContain("does not exist");
  });
});
