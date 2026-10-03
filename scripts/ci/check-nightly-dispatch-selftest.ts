#!/usr/bin/env bun
/**
 * Self-test for the nightly dispatch job (core 1495). Ports test_nightly_dispatch_list.sh to Bun.
 * Run on every pull request by suite-13-doc-checks.yml.
 *
 * Asserts:
 *   1. every suite workflow is in SUITES or the documented exclusion list
 *      (scripts/ci/check_nightly_dispatch_list.py), and removing one suite is detected, naming it;
 *   2. suite-21-nightly.yml passes actionlint (CI installs it and CI=true makes a missing one fatal; locally it is skipped with a loud warning);
 *   3. the fork-pin age step carries continue-on-error: true (yq), found by the script it runs;
 *   4. the live-base-fork-drift job, its script and its test are gone and nothing in .github, scripts or docs
 *      names them or the other deleted files;
 *   5. the nightly drift alarm text is absent from the docs and the three forge test headers.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
process.chdir(ROOT);
const NIGHTLY = ".github/workflows/suite-21-nightly.yml";
const CHECK = "scripts/ci/check_nightly_dispatch_list.py";
const SELF = "scripts/ci/check-nightly-dispatch-selftest.ts";
let pass = 0;
const ok = (m: string) => { pass++; console.log(`ok   - ${m}`); };
const bad = (m: string): never => { console.error(`FAIL - ${m}`); process.exit(1); };
const run = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};
const yqOk = (expr: string, file: string) => run(["yq", "-e", expr, file]).code === 0;

// 1. coverage, positive and negative.
if (run(["python3", CHECK]).code) bad("a suite workflow is missing from the dispatch list");
ok("every suite workflow is in SUITES or EXCLUDED");
if (run(["python3", CHECK, "--self-test"]).code) bad("the python self-test failed");
ok("the python self-test passes (removed suite and new suite are detected)");

const tmp = mkdtempSync(join(tmpdir(), "nightly-dispatch-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const victim = "suite-12-openclaw.yml";
mkdirSync(join(tmp, ".github/workflows"), { recursive: true });
mkdirSync(join(tmp, "scripts/ci"), { recursive: true });
for (const f of readdirSync(".github/workflows")) cpSync(join(".github/workflows", f), join(tmp, ".github/workflows", f));
cpSync(CHECK, join(tmp, CHECK));
writeFileSync(
  join(tmp, NIGHTLY),
  readFileSync(NIGHTLY, "utf8").split("\n").filter((l) => l.trim() !== victim).join("\n"),
);
const neg = run(["python3", join(tmp, CHECK)]);
if (neg.code === 0) bad(`removing ${victim} from the list still exited 0`);
if (!neg.out.includes(victim)) bad(`the failure did not name ${victim}: ${neg.out}`);
ok(`removing ${victim} exits non-zero and names it`);

// 2. actionlint
if (run(["which", "actionlint"]).code === 0) {
  const a = run(["actionlint", NIGHTLY]);
  if (a.code) bad(`actionlint rejects ${NIGHTLY}: ${a.out}`);
  ok(`actionlint passes on ${NIGHTLY}`);
} else if (process.env.CI === "true") {
  bad("actionlint is not installed, and CI must install it");
} else {
  console.warn("WARNING ******************************************************************");
  console.warn("WARNING actionlint is not installed: SKIPPING the actionlint check locally.");
  console.warn("WARNING CI installs it and runs this check. Install actionlint to run it here.");
  console.warn("WARNING ******************************************************************");
}

// 3. the fork-pin age step cannot fail the run: found by the script it runs, not by an exact string.
if (!yqOk('.jobs."fork-pin-age-warning".steps[] | select(.run | test("check-fork-pin-age")) | .["continue-on-error"] == true', NIGHTLY))
  bad("the fork-pin age step does not carry continue-on-error: true");
ok("the fork-pin age step carries continue-on-error: true");
// negative control: the same query rejects a step without the flag
const noFlag = join(tmp, "no-flag.yml");
writeFileSync(noFlag, "jobs:\n  fork-pin-age-warning:\n    steps:\n      - run: scripts/devnet/check-fork-pin-age.sh\n");
if (yqOk('.jobs."fork-pin-age-warning".steps[] | select(.run | test("check-fork-pin-age")) | .["continue-on-error"] == true', noFlag))
  bad("the continue-on-error query accepted a step without the flag");
ok("the continue-on-error query rejects a step without the flag (negative control)");

// 4. deleted job, scripts and tests are gone and unreferenced.
if (yqOk('.jobs | has("live-base-fork-drift")', NIGHTLY)) bad(`the live-base-fork-drift job is still in ${NIGHTLY}`);
ok("the live-base-fork-drift job is gone");
for (const f of ["scripts/devnet/run-live-base-fork-drift.sh", ".github/scripts/tests/test_live_base_fork_drift.sh", ".github/scripts/tests/test_nightly_dispatch_list.sh"])
  if (existsSync(f)) bad(`${f} still exists`);
ok("the deleted drift script, its test and the old shell selftest are absent");

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "code-reviews") continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else yield p;
  }
}
function grepTree(re: RegExp): string[] {
  const hits: string[] = [];
  for (const d of [".github", "scripts", "docs"]) {
    for (const f of walk(d)) {
      if (f === SELF) continue;
      let text: string;
      try { text = readFileSync(f, "utf8"); } catch { continue; }
      text.split("\n").forEach((l, i) => { if (re.test(l)) hits.push(`${f}:${i + 1}:${l.trim().slice(0, 120)}`); });
    }
  }
  return hits;
}
const drift = grepTree(/live-base-fork-drift|run-live-base-fork-drift|test_live_base_fork_drift|test_nightly_dispatch_list\.sh/);
if (drift.length) bad(`something still references the deleted drift job, script or test:\n${drift.join("\n")}`);
ok("no file under .github, scripts or docs references the deleted drift job, script or tests");
if (!existsSync("scripts/devnet/check-fork-rpc-configured.sh")) {
  const h = grepTree(/check-fork-rpc-configured/);
  if (h.length) bad(`check-fork-rpc-configured.sh is deleted but still referenced:\n${h.join("\n")}`);
  ok("check-fork-rpc-configured.sh is deleted and unreferenced");
}
// negative control for the grep itself
const probe = join(tmp, "probe.txt");
writeFileSync(probe, "see run-live-base-fork-drift.sh\n");
if (!/live-base-fork-drift|run-live-base-fork-drift/.test(readFileSync(probe, "utf8"))) bad("the drift-name pattern does not match a stub reference");
ok("the drift-name pattern matches a stub reference (negative control)");

// 5. the drift alarm text.
const alarm = /drift[- ]alarm|live-drift|nightly live|nightly drift (alarm|fires)|non-blocking nightly/i;
const files = [
  "docs/development/ci-suites.md", "docs/development/environments.md", "docs/technical/smart-contracts.md",
  "docs/technical/opencode-headless-invocation.md", "docs/technical/fork-e2e-decisions.md", "scripts/devnet/refresh-fork-fixture.sh",
  "contracts/test/VaultForkRegressions.t.sol", "contracts/test/DeploySeedDeposit.t.sol", "contracts/test/SafeIntegration.t.sol",
];
for (const f of files) {
  if (!existsSync(f)) continue;
  const hit = readFileSync(f, "utf8").split("\n").findIndex((l) => alarm.test(l));
  if (hit >= 0) bad(`${f}:${hit + 1} still carries the nightly drift alarm text`);
}
for (const f of walk("docs/technical")) {
  if (!f.endsWith(".md")) continue;
  const hit = readFileSync(f, "utf8").split("\n").findIndex((l) => alarm.test(l));
  if (hit >= 0) bad(`${f}:${hit + 1} still carries the nightly drift alarm text`);
}
ok("the nightly drift alarm text is absent from the docs and the forge test headers");

// 6. a failed dispatch fails the job and names the workflow (core 1495). The real step script runs against a stub `gh`.
{
  const nightlyText = readFileSync(NIGHTLY, "utf8");
  if (/\|\|\s*echo\s+["']?WARNING/i.test(nightlyText)) bad("the nightly still swallows a dispatch failure with '|| echo WARNING'");
  ok("no '|| echo WARNING' swallow in the nightly");
  const script = run(["yq", "-r", '.jobs."dispatch-all-suites".steps[] | select(.name == "Dispatch suites") | .run', NIGHTLY]);
  if (script.code || !script.out.includes("gh api")) bad(`could not read the dispatch step script: ${script.out}`);
  const stubDir = join(tmp, "stub-bin");
  mkdirSync(stubDir, { recursive: true });
  const dispatchRun = (failing: string[]) => {
    writeFileSync(join(stubDir, "gh"), `#!/usr/bin/env bash\nfor f in ${failing.map((w) => `"${w}"`).join(" ")} _; do case "$*" in *"/$f/dispatches"*) exit 1;; esac; done\nexit 0\n`, { mode: 0o755 });
    const r = Bun.spawnSync(["bash", "-c", script.out], {
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, REPO: "o/r", REF: "dev", GH_TOKEN: "stub" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const good = dispatchRun([]);
  if (good.code !== 0 || !good.out.includes("All dispatches sent.")) bad(`all dispatches succeeding did not exit 0: ${good.out}`);
  ok("all dispatches succeeding exits 0");
  const two = dispatchRun(["suite-12-openclaw.yml", "config-check.yml"]);
  if (two.code === 0) bad("two failed dispatches still exited 0");
  if (!two.out.includes("suite-12-openclaw.yml") || !two.out.includes("config-check.yml") || !/2 suite dispatch/.test(two.out))
    bad(`the failure did not list both workflows: ${two.out}`);
  ok("two failed dispatches exit non-zero and list both workflows, after trying every suite");
  if (!two.out.includes("Dispatching suite-30-check-sha-green.yml")) bad("the loop stopped at the first failure instead of trying every suite");
  ok("a failure does not stop the remaining dispatches");
}

console.log(`nightly dispatch list selftest: ${pass} checks passed`);
