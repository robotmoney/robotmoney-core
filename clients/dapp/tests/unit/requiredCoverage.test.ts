// The zero-assertion guard, both directions (QA finding T14).
//
// C-21: this file is the negative self-test of the guard — it proves the guard
// FAILS on the exact condition that shipped green (a required spec collecting
// only skips), not merely that it passes when everything runs.
import { describe, it, expect } from "vitest";
import {
  evaluateCoverage,
  shouldEnforceFromArgv,
  formatFailureReport,
  REQUIRED_SPECS,
  type SpecOutcome,
} from "../e2e/reporters/requiredCoverage";

const seen = (entries: Record<string, SpecOutcome>) =>
  new Map<string, SpecOutcome>(Object.entries(entries));

describe("required browser coverage guard", () => {
  it("names the always-running consensus-receipt spec as required", () => {
    expect(REQUIRED_SPECS).toContain("consensus-receipts-seeded.spec.ts");
  });

  it("does NOT require the environment-gated real-artifact spec", () => {
    // That spec is allowed to skip; requiring it would make every ordinary CI
    // run red instead of making the coverage hole visible.
    expect(REQUIRED_SPECS).not.toContain("consensus-receipts.spec.ts");
  });

  it("passes when every required spec executed", () => {
    const v = evaluateCoverage(seen({ "a.spec.ts": { executed: 1, skipped: 0 } }), ["a.spec.ts"]);
    expect(v.ok).toBe(true);
    expect(v.failures).toEqual([]);
  });

  // THE REGRESSION: b3ed4dc1's shape exactly — the spec is collected, reports
  // one skip, zero executions, and the run exits 0.
  it("FAILS when a required spec collected only skips", () => {
    const v = evaluateCoverage(seen({ "a.spec.ts": { executed: 0, skipped: 1 } }), ["a.spec.ts"]);
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("executed 0 tests");
    expect(v.failures[0]).toContain("1 skipped");
  });

  it("FAILS when a required spec was not collected at all", () => {
    const v = evaluateCoverage(seen({}), ["a.spec.ts"]);
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("NO tests");
  });

  it("counts a failed test as executed — coverage ran, it just found a bug", () => {
    const v = evaluateCoverage(seen({ "a.spec.ts": { executed: 1, skipped: 3 } }), ["a.spec.ts"]);
    expect(v.ok).toBe(true);
  });

  // A guard that reddens every `--grep` run gets ignored, and an ignored guard is
  // the hole all over again.
  describe("only a full run is judged", () => {
    const argv = (...args: string[]) => ["node", "playwright", "test", ...args];

    it("enforces on a full, unfiltered run", () => {
      expect(shouldEnforceFromArgv(argv())).toBe(true);
      expect(shouldEnforceFromArgv(argv("--reporter=list", "--workers", "1"))).toBe(true);
      // A value that looks like a path must not read as a file filter.
      expect(shouldEnforceFromArgv(argv("-c", "playwright.config.ts"))).toBe(true);
    });

    it("stands down for --grep, -g, --grep-invert, --shard and file filters", () => {
      expect(shouldEnforceFromArgv(argv("--grep", "consensus receipts"))).toBe(false);
      expect(shouldEnforceFromArgv(argv("--grep=consensus"))).toBe(false);
      expect(shouldEnforceFromArgv(argv("-g", "consensus"))).toBe(false);
      expect(shouldEnforceFromArgv(argv("--grep-invert", "slow"))).toBe(false);
      expect(shouldEnforceFromArgv(argv("--shard=1/3"))).toBe(false);
      expect(shouldEnforceFromArgv(argv("tests/e2e/pause.spec.ts"))).toBe(false);
      // Playwright's positional filter is a substring, not necessarily a path.
      expect(shouldEnforceFromArgv(argv("pause"))).toBe(false);
    });
  });

  it("reports every offending spec, not just the first", () => {
    const v = evaluateCoverage(
      seen({ "a.spec.ts": { executed: 0, skipped: 1 }, "b.spec.ts": { executed: 0, skipped: 2 } }),
      ["a.spec.ts", "b.spec.ts"],
    );
    expect(v.failures).toHaveLength(2);
    const report = formatFailureReport(v);
    expect(report).toContain("a.spec.ts");
    expect(report).toContain("b.spec.ts");
    expect(report).toContain("QA finding T14");
  });
});
