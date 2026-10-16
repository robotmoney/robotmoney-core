/**
 * Playwright reporter that fails the run when a spec in `REQUIRED_SPECS`
 * executed zero tests (QA finding T14), or when a full run skipped any test
 * (QA plan v1 T5). All the judgement lives in `requiredCoverage.ts`; this file
 * only translates Playwright's events into the counts and labels those
 * functions consume, and their verdict back into the run status.
 */
import type { Reporter, TestCase, TestResult, FullResult } from "@playwright/test/reporter";
import path from "node:path";
import {
  evaluateRun,
  formatFailureReport,
  shouldEnforceFromArgv,
  type SpecOutcome,
} from "./requiredCoverage";

export default class RequiredCoverageReporter implements Reporter {
  private readonly seen = new Map<string, SpecOutcome>();
  private readonly skipped: string[] = [];
  private readonly enforce = shouldEnforceFromArgv(process.argv);

  onTestEnd(test: TestCase, result: TestResult): void {
    const spec = path.basename(test.location.file);
    const outcome = this.seen.get(spec) ?? { executed: 0, skipped: 0 };
    // `skipped` covers test.skip() and describe-level skips; everything else
    // (passed / failed / timedOut / interrupted) means the body ran.
    if (result.status === "skipped") {
      outcome.skipped += 1;
      this.skipped.push(`${spec} › ${test.title}`);
    } else outcome.executed += 1;
    this.seen.set(spec, outcome);
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | void> {
    // Do not mask a real failure, and do not second-guess an interrupted run
    // (a Ctrl-C leaves specs uncollected for reasons this guard is not about).
    if (result.status !== "passed") return;
    if (!this.enforce) {
      process.stderr.write(
        "\n[required-coverage] filtered or sharded run — required-spec coverage NOT " +
          "checked. Only a full `bun run test:e2e` is judged (QA finding T14).\n\n",
      );
      return;
    }
    const verdict = evaluateRun(this.seen, this.skipped);
    if (verdict.ok) return;
    process.stderr.write(formatFailureReport(verdict));
    return { status: "failed" };
  }
}
