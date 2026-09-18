/**
 * The zero-assertion guard for suite-10 (QA finding T14).
 *
 * THE FAILURE THIS EXISTS TO STOP
 * `b3ed4dc1` gated `consensus-receipts.spec.ts` on `FUSION_RECEIPT_ID` /
 * `FUSION_RECEIPT_URL`, which nothing in `.github/`, `playwright.config.ts` or
 * the smoke-test harness sets. Playwright reported the spec skipped and the run
 * green, and `AC-CORE-08` went on claiming browser coverage that had executed on
 * zero runs. A skipped spec and an executed spec are not distinguishable in the
 * exit code, which is the whole problem: coverage that can silently stop running
 * is not coverage.
 *
 * THE RULE
 * Every spec file named in `REQUIRED_SPECS` must contribute at least one test
 * that actually EXECUTED — passed or failed, never `skipped` and never absent
 * from the run. A required spec that collects zero executed tests FAILS the run
 * with a message naming the file, rather than passing quietly.
 *
 * Optional-by-design specs (the env-named real-artifact one) stay out of the
 * list: they are allowed to skip, which is exactly why something else has to be
 * standing coverage. The split is deliberate — see
 * `consensus-receipts-seeded.spec.ts`.
 *
 * The decision is a pure function so it is unit-testable in both directions
 * (`tests/unit/requiredCoverage.test.ts`) without booting a devnet.
 */

/**
 * Spec files (repo-relative to `clients/dapp/tests/e2e/`) that MUST execute on
 * every full suite run. Add a spec here when it is the standing proof of an
 * acceptance criterion; never add one that is legitimately environment-gated.
 */
export const REQUIRED_SPECS: readonly string[] = [
  // AC-CORE-08: the four consensus-receipt state dimensions and the required
  // explanatory language, against the harness-seeded devnet fixtures.
  "consensus-receipts-seeded.spec.ts",
];

/** How many tests of each kind a single spec file contributed to a run. */
export interface SpecOutcome {
  /** Tests that ran to completion — passed, failed, timed out or flaked. */
  executed: number;
  /** Tests Playwright skipped (test.skip, describe-level skip, filtering). */
  skipped: number;
}

export interface CoverageVerdict {
  ok: boolean;
  /** Human-readable failure lines; empty when `ok`. */
  failures: string[];
}

/**
 * Decide whether every required spec executed.
 *
 * @param seen  spec-file basename -> outcome counts, as observed in the run.
 * @param required  spec basenames that must have executed (default `REQUIRED_SPECS`).
 */
export function evaluateCoverage(
  seen: ReadonlyMap<string, SpecOutcome>,
  required: readonly string[] = REQUIRED_SPECS,
): CoverageVerdict {
  const failures: string[] = [];
  for (const spec of required) {
    const outcome = seen.get(spec);
    if (!outcome) {
      failures.push(
        `required spec '${spec}' contributed NO tests to this run — it was not ` +
          `collected at all (renamed, moved, or excluded by testMatch/grep?).`,
      );
      continue;
    }
    if (outcome.executed === 0) {
      failures.push(
        `required spec '${spec}' executed 0 tests (${outcome.skipped} skipped). ` +
          `A skipped required spec is a coverage hole, not a pass: this spec is ` +
          `the standing browser proof for AC-CORE-08 and must run unconditionally.`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * A partial run cannot be judged for coverage.
 *
 * `--grep`/`--grep-invert`, a shard, or a positional file filter all mean the
 * runner was ASKED to leave specs out, so a missing required spec says nothing
 * about the suite's health — enforcing there would redden every `--grep` run and
 * teach people to ignore the guard, which is how the original hole survived.
 * Only a full, unfiltered run is judged; CI runs `bun run test:e2e` unfiltered.
 *
 * The decision has to be read off the command line: Playwright does NOT surface
 * `--grep` on `FullConfig` (it stays at the match-all default there) and the
 * suite handed to `onBegin` has already been filtered, so neither can tell a
 * filtered run from a full one. Verified against @playwright/test 1.59.1.
 */
const FILTER_FLAGS = new Set(["--grep", "-g", "--grep-invert", "--shard"]);

/**
 * Flags that consume the NEXT argv entry as their value. Without this list a
 * value like the `1` of `--workers 1` reads as a positional test-file filter and
 * the guard stands down on a full run — failing open, the one way this guard
 * must never fail.
 */
const VALUE_FLAGS = new Set([
  "-c",
  "--config",
  "-j",
  "--workers",
  "--project",
  "--reporter",
  "--timeout",
  "--retries",
  "--output",
  "--repeat-each",
  "--max-failures",
  "-x",
  "--update-snapshots",
  "--trace",
]);

export function shouldEnforceFromArgv(argv: readonly string[]): boolean {
  // argv here is the `playwright test [args]` tail, e.g. ["test", "--grep", "x"].
  const marker = argv.indexOf("test");
  const args = marker === -1 ? [] : argv.slice(marker + 1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (FILTER_FLAGS.has(arg)) return false;
    if (arg.startsWith("--grep=") || arg.startsWith("--shard=")) return false;
    if (VALUE_FLAGS.has(arg)) {
      i += 1; // consume the value; it is not a file filter
      continue;
    }
    // Anything else that is not a flag is Playwright's positional test-file
    // filter, so the run was asked to leave specs out.
    if (!arg.startsWith("-")) return false;
  }
  return true;
}

/** The banner the reporter prints; shared so the unit test can assert it. */
export function formatFailureReport(verdict: CoverageVerdict): string {
  return [
    "",
    "──────────────────────────────────────────────────────────────────────",
    "REQUIRED BROWSER COVERAGE DID NOT RUN (QA finding T14)",
    ...verdict.failures.map((f) => `  • ${f}`),
    "The run is marked FAILED even though no test failed.",
    "──────────────────────────────────────────────────────────────────────",
    "",
  ].join("\n");
}
