// Canonical: core issues 1498, 1239. Offline unit test of the executed-test counter.
// Run: bun test scripts/devnet/forge-fork-tests.test.ts --timeout 60000
import { describe, expect, test } from "bun:test";
import { countExecuted } from "./forge-fork-tests.ts";

const result = (status: string) => ({ status, reason: null, kind: "Standard" });

describe("countExecuted", () => {
  test("counts passes and failures, never skips", () => {
    const json = {
      "contracts/test/A.t.sol:A": { test_results: { "test_a()": result("Success"), "test_b()": result("Skip"), "test_c()": result("Failure") } },
      "contracts/test/B.t.sol:B": { test_results: { "test_d()": result("Skip") } },
    };
    expect(countExecuted(json)).toBe(2);
  });
  test("a run that skipped everything counts zero", () => {
    expect(countExecuted({ x: { test_results: { "t()": result("Skip") } } })).toBe(0);
  });
  test("empty and non-object input count zero", () => {
    expect(countExecuted({})).toBe(0);
    expect(countExecuted(null)).toBe(0);
  });
});
