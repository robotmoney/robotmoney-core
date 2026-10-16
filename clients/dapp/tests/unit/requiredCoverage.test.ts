// The zero-assertion guard, both directions (QA finding T14).
//
// C-21: this file is the negative self-test of the guard — it proves the guard
// FAILS on the exact condition that shipped green (a required spec collecting
// only skips), not merely that it passes when everything runs.
import { describe, it, expect } from "vitest";
import {
  evaluateCoverage,
  evaluateNoSkips,
  evaluateRun,
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

  it("names the Safe proposal spec as required (core 1544)", () => {
    expect(REQUIRED_SPECS).toContain("safe-proposal-role-grant.spec.ts");
  });

  it("fails the run when the Safe proposal spec did not execute", () => {
    const v = evaluateCoverage(
      seen({ "consensus-receipts-seeded.spec.ts": { executed: 1, skipped: 0 } }),
    );
    expect(v.ok).toBe(false);
    expect(v.failures.join("\n")).toContain("safe-proposal-role-grant.spec.ts");
    const skipped = evaluateCoverage(
      seen({
        "consensus-receipts-seeded.spec.ts": { executed: 1, skipped: 0 },
        "safe-proposal-role-grant.spec.ts": { executed: 0, skipped: 3 },
      }),
    );
    expect(skipped.ok).toBe(false);
  });

  it("no longer requires the deleted governance spec (issue 1698 removed the voting path)", () => {
    expect(REQUIRED_SPECS).not.toContain("governance.spec.ts");
  });

  it("names the role grant/revoke spec as required: the Safe proposal path must execute (issue 1647)", () => {
    expect(REQUIRED_SPECS).toContain("role-grant-revoke.spec.ts");
    const others = Object.fromEntries(
      REQUIRED_SPECS.filter((s) => s !== "role-grant-revoke.spec.ts").map((s) => [
        s,
        { executed: 1, skipped: 0 },
      ]),
    );
    expect(evaluateCoverage(seen(others)).ok).toBe(false);
    expect(
      evaluateCoverage(
        seen({ ...others, "role-grant-revoke.spec.ts": { executed: 0, skipped: 6 } }),
      ).ok,
    ).toBe(false);
    expect(
      evaluateCoverage(
        seen({ ...others, "role-grant-revoke.spec.ts": { executed: 8, skipped: 0 } }),
      ).ok,
    ).toBe(true);
  });

  // QA plan v1 T5: a test that skips inside a spec whose other tests ran. The
  // spec rule passes it, so this rule has to fail it.
  it("FAILS a full run that skipped any test, and names the test (QA plan v1 T5)", () => {
    const label =
      "number-formatting.spec.ts › router-deposit: ProportionPreview numeric columns are right-aligned";
    const v = evaluateNoSkips([label]);
    expect(v.ok).toBe(false);
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0]).toContain(label);
    expect(v.failures[0]).toContain("SKIPPED");
  });

  it("passes a full run that skipped no test (QA plan v1 T5)", () => {
    expect(evaluateNoSkips([])).toEqual({ ok: true, failures: [] });
  });

  it("fails the run on a skip even when every required spec executed (QA plan v1 T5)", () => {
    const allRan = seen(
      Object.fromEntries(REQUIRED_SPECS.map((s) => [s, { executed: 1, skipped: 0 }])),
    );
    expect(evaluateRun(allRan, []).ok).toBe(true);
    const v = evaluateRun(allRan, ["number-formatting.spec.ts › snapshot"]);
    expect(v.ok).toBe(false);
    expect(v.failures.join("\n")).toContain("number-formatting.spec.ts › snapshot");
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
