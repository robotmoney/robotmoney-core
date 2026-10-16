// Canonical: issue 1853. The storage-layout-reset waiver of the forge-unit-tests job reaches the job summary, not only a log ::warning.
// Runs the real `run` script of the "Core storage-layout gate" step from .github/workflows/suite-01-02-forge-tests.yml under bash with a
// stub git and a stub layout gate, and reads what it wrote to $GITHUB_STEP_SUMMARY.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "suite-01-02-forge-tests.yml");
const wf = Bun.YAML.parse(readFileSync(WORKFLOW, "utf8")) as { jobs: Record<string, { name?: string; steps: { name?: string; run?: string }[] }> };
const job = Object.values(wf.jobs).find((j) => j.name === "forge-unit-tests")!;
const step = job.steps.find((s) => s.name?.startsWith("Core storage-layout gate"))!;

function runStep(event: string, layoutReset: string): { code: number; summary: string; gateArgs: string[] } {
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP ?? join(homedir(), "tmp"), "forge-summary-"));
  mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  writeFileSync(join(dir, "bin", "git"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(dir, "scripts", "ci", "check-core-storage-layout.sh"), `#!/usr/bin/env bash\necho "$*" >> "${join(dir, "gate.log")}"\n`);
  chmodSync(join(dir, "bin", "git"), 0o755); chmodSync(join(dir, "scripts", "ci", "check-core-storage-layout.sh"), 0o755);
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  const script = step.run!.replaceAll("${{ github.event_name }}", event);
  const r = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd: dir, env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, LAYOUT_RESET: layoutReset, GITHUB_STEP_SUMMARY: summary }, stdout: "pipe", stderr: "pipe" });
  const log = join(dir, "gate.log");
  return { code: r.exitCode, summary: readFileSync(summary, "utf8"), gateArgs: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

describe("the storage-layout-reset waiver of the forge-unit-tests job", () => {
  test("the step exists and reads the label", () => {
    expect(step).toBeDefined();
    expect(step.run).toContain("$LAYOUT_RESET");
  });

  test("a pull request with the label writes the waiver to $GITHUB_STEP_SUMMARY and drops only the base-commit baseline", () => {
    const r = runStep("pull_request", "true");
    expect(r.code).toBe(0);
    expect(r.summary).toContain("storage-layout-reset");
    expect(r.summary).toContain("not** compared with the base commit");
    expect(r.gateArgs).toEqual(["--selftest", "--releases"]);
  });

  test("a pull request without the label writes no waiver and compares with the base commit", () => {
    const r = runStep("pull_request", "false");
    expect(r.code).toBe(0);
    expect(r.summary).toBe("");
    expect(r.gateArgs).toEqual(["--selftest", "--baseline HEAD^1 --releases"]);
  });

  test("a push to dev writes no waiver", () => {
    const r = runStep("push", "false");
    expect(r.code).toBe(0);
    expect(r.summary).toBe("");
    expect(r.gateArgs).toEqual(["--selftest", "--releases"]);
  });
});
