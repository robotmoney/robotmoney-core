#!/usr/bin/env bun
/**
 * Self-test for the Twin chain CI wiring (core 1498, 1496). Offline, needs yq. Run on every pull
 * request by suite-13-doc-checks.yml.
 *
 * The Twin chain (id 918453) is a pinned lazy fork of real Base state made with anvil. This checks
 * the owner rule "ONE pin per workflow run (a setup job outputs the pin; jobs take it as input)":
 *   1. the nightly (suite-29-nightly-twin-fork.yml) calls suites 5, 7, 8, 10, 11b and 14 with
 *      pin_block taken from its own pin job, and passes secrets with `secrets: inherit`;
 *   2. each of those suites declares the workflow_call input pin_block, has a `pin` job that uses
 *      .github/actions/twin-pin with that input, and every step that uses .github/actions/twin-fork
 *      takes its pin-block from the pin job output and sits in a job that needs the pin job;
 *   3. nothing in .github, scripts, testing, clients or services still references the retired
 *      geth+lighthouse devnet, the genesis alloc, the fresh-snapshot overlay or the saved
 *      .anvil-state fixture for a chain boot;
 *   4. the retired files are gone.
 *   5. every twin-fork use has a matching twin-fork-save-cache last step (if: always()), one pin per
 *      workflow, the action output names, and github.action_path in all three actions.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
process.chdir(ROOT);
let pass = 0;
const ok = (m: string) => { pass++; console.log(`ok   - ${m}`); };
const bad = (m: string): never => { console.error(`FAIL - ${m}`); process.exit(1); };

function yaml(file: string): any {
  const r = Bun.spawnSync(["yq", "-o=json", ".", file], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) bad(`yq could not parse ${file}: ${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString());
}

const NIGHTLY = ".github/workflows/suite-29-nightly-twin-fork.yml";
const SUITES: Record<string, string> = {
  "suite-05": "suite-05-fork-integration.yml",
  "suite-07": "suite-07-rmpc-integration.yml",
  "suite-08": "suite-08-explorer-indexer.yml",
  "suite-10": "suite-10-dapp-e2e.yml",
  "suite-11b": "suite-11b-opencode-headless.yml",
  "suite-14": "suite-14-smoke-test.yml",
};
const PIN_OUT = "${{ needs.pin.outputs.block }}";

// 1. the nightly.
const nightly = yaml(NIGHTLY);
if (!nightly.jobs?.pin || !String(nightly.jobs.pin.steps?.[1]?.uses).endsWith("/twin-pin"))
  bad(`${NIGHTLY} has no pin job that uses the twin-pin action`);
for (const [job, file] of Object.entries(SUITES)) {
  const j = nightly.jobs[job];
  if (!j || j.uses !== `./.github/workflows/${file}`) bad(`${NIGHTLY} does not call ${file} in job ${job}`);
  if (j.with?.pin_block !== PIN_OUT) bad(`${NIGHTLY} job ${job} must pass pin_block: ${PIN_OUT}`);
  if (j.secrets !== "inherit") bad(`${NIGHTLY} job ${job} must pass secrets: inherit`);
  const needs = [].concat(j.needs ?? []);
  if (!needs.includes("pin")) bad(`${NIGHTLY} job ${job} must need the pin job`);
}
if (nightly.jobs["suite-26"]) bad(`${NIGHTLY} calls suite 26, which targets the shared stage devnet`);
ok("the nightly calls suites 5, 7, 8, 10, 11b and 14 with ONE pin from its pin job");

// 2. each suite: input, pin job, every twin-fork step takes the pin as input.
for (const [job, file] of Object.entries(SUITES)) {
  const path = `.github/workflows/${file}`;
  const wf = yaml(path);
  const inp = wf.on?.workflow_call?.inputs?.pin_block;
  if (!inp || inp.type !== "string") bad(`${path} must declare workflow_call input pin_block (string)`);
  if (wf.on?.workflow_call?.inputs?.fresh_snapshot) bad(`${path} still declares fresh_snapshot`);
  const pin = wf.jobs?.pin;
  if (!pin) bad(`${path} has no pin job`);
  const pinStep = (pin.steps ?? []).find((s: any) => String(s.uses ?? "").endsWith("/twin-pin"));
  if (!pinStep) bad(`${path} pin job does not use the twin-pin action`);
  if (pinStep.with?.["pin-block"] !== "${{ inputs.pin_block }}") bad(`${path} pin job must pass pin-block: \${{ inputs.pin_block }}`);
  if (!pin.outputs?.block) bad(`${path} pin job has no block output`);
  let forks = 0;
  for (const [name, j] of Object.entries<any>(wf.jobs)) {
    for (const s of j.steps ?? []) {
      if (!String(s.uses ?? "").endsWith("/twin-fork")) continue;
      forks++;
      if (s.with?.["pin-block"] !== PIN_OUT) bad(`${path} job ${name}: twin-fork must take pin-block: ${PIN_OUT}`);
      if (![].concat(j.needs ?? []).includes("pin")) bad(`${path} job ${name} uses twin-fork but does not need the pin job`);
    }
  }
  if (forks === 0) bad(`${path} starts no Twin fork`);
  ok(`${file}: pin input, pin job and ${forks} twin-fork step(s) take the one pin`);
}

// 2b. the nightly uploads the results and the pin file.
const uploads = Object.values<any>(nightly.jobs).flatMap((j: any) => (j.steps ?? []).filter((x: any) => String(x.uses ?? "").includes("upload-artifact")).map((x: any) => x.with?.name));
for (const want of ["suite-results", "twin-pin"]) if (!uploads.includes(want)) bad(`${NIGHTLY} does not upload the ${want} artifact`);
if (JSON.stringify(nightly).includes("secrets.") && /secrets\.(?!BASE_UPSTREAM_RPC|GITHUB_TOKEN)/.test(JSON.stringify(nightly)))
  bad(`${NIGHTLY} references a secret other than the optional BASE_UPSTREAM_RPC`);
ok("the nightly uploads suite-results and twin-pin and needs no secret beyond the optional BASE_UPSTREAM_RPC");

// 2c. suite 1-2: the forge fork job runs on the Twin fork at one pin and no saved state.
{
  const file = ".github/workflows/suite-01-02-forge-tests.yml";
  const wf = yaml(file);
  const job = wf.jobs?.["fork-regressions"];
  if (!job || ![].concat(job.needs ?? []).includes("twin-pin")) bad(`${file}: fork-regressions must need the twin-pin job`);
  const fork = (job.steps ?? []).find((x: any) => String(x.uses ?? "").endsWith("/twin-fork"));
  if (!fork || fork.with?.["pin-block"] !== "${{ needs.twin-pin.outputs.block }}") bad(`${file}: fork-regressions must start twin-fork at the pin from twin-pin`);
  const runs = (job.steps ?? []).map((x: any) => String(x.run ?? "")).join("\n");
  if (!/forge-fork-tests\.ts/.test(runs)) bad(`${file}: fork-regressions must run the fork tests through scripts/devnet/forge-fork-tests.ts`);
  ok("suite 1-2 fork-regressions starts the Twin fork at the pin and runs the fork tests through the Bun runner");
}

// 2d. every twin-fork use has a matching save-cache step, one pin per workflow run, output names.
{
  const isFork = (x: any) => String(x.uses ?? "").endsWith("/twin-fork");
  const isSave = (x: any) => String(x.uses ?? "").endsWith("/twin-fork-save-cache");
  let forkJobs = 0;
  for (const f of readdirSync(".github/workflows").filter((n) => /\.ya?ml$/.test(n))) {
    const path = `.github/workflows/${f}`;
    const wf = yaml(path);
    const pins = new Set<string>();
    const jobsWithFork: string[] = [];
    for (const [name, j] of Object.entries<any>(wf.jobs ?? {})) {
      const steps: any[] = j.steps ?? [];
      const forks = steps.filter(isFork);
      const saves = steps.filter(isSave);
      if (forks.length === 0) { if (saves.length) bad(`${path} job ${name} saves a Twin cache but starts no fork`); continue; }
      jobsWithFork.push(name);
      forkJobs++;
      if (saves.length !== forks.length) bad(`${path} job ${name}: ${forks.length} twin-fork use(s) but ${saves.length} twin-fork-save-cache step(s)`);
      const last = steps[steps.length - 1];
      if (!isSave(last)) bad(`${path} job ${name}: the LAST step must use twin-fork-save-cache`);
      if (!/always\(\)/.test(String(last.if ?? ""))) bad(`${path} job ${name}: the twin-fork-save-cache step must have if: always()`);
      if (steps.indexOf(last) < steps.indexOf(forks[forks.length - 1])) bad(`${path} job ${name}: save-cache must come after twin-fork`);
      for (const fk of forks) pins.add(String(fk.with?.["pin-block"] ?? ""));
    }
    if (jobsWithFork.length === 0) continue;
    // ONE pin per workflow run: every fork takes the same expression; an empty pin (auto) is only
    // allowed when the workflow has a single job that starts a fork.
    if (pins.size > 1) bad(`${path}: more than one pin-block expression across twin-fork steps: ${[...pins].join(" | ")}`);
    if (pins.has("") && jobsWithFork.length > 1) bad(`${path}: twin-fork steps without pin-block in ${jobsWithFork.length} jobs would each choose their own pin`);
  }
  if (forkJobs === 0) bad("no workflow job uses twin-fork");
  ok(`all ${forkJobs} twin-fork job(s) end with twin-fork-save-cache (if: always()), one pin per workflow`);

  const fork = yaml(".github/actions/twin-fork/action.yml");
  for (const o of ["rpc-url", "pin-block", "TWIN_RPC_URL", "PIN_BLOCK"]) if (!fork.outputs?.[o]) bad(`twin-fork action must output ${o}`);
  const forkText = readFileSync(".github/actions/twin-fork/action.yml", "utf8");
  if (/actions\/cache@/.test(forkText) || !/actions\/cache\/restore@/.test(forkText)) bad("the twin-fork action must only restore the cache (actions/cache/restore)");
  if (!/inputs\.upstream-secret \|\| env\.BASE_UPSTREAM_RPC/.test(forkText)) bad("twin-fork must fall back to an already-set BASE_UPSTREAM_RPC env");
  const saveText = readFileSync(".github/actions/twin-fork-save-cache/action.yml", "utf8");
  if (!/actions\/cache\/save@/.test(saveText) || !/twin-fork\.ts"? stop/.test(saveText)) bad("twin-fork-save-cache must stop the fork and then actions/cache/save");
  if (saveText.indexOf("twin-fork.ts") > saveText.indexOf("actions/cache/save@") && !/\$TWIN_TOOL"? stop/.test(saveText)) bad("save-cache must stop before saving");
  for (const a of ["twin-fork", "twin-pin", "twin-fork-save-cache"]) {
    const t = readFileSync(`.github/actions/${a}/action.yml`, "utf8");
    if (/github\.workspace/.test(t) || /["' ]\.\/scripts\//.test(t)) bad(`the ${a} action must use github.action_path, not the workspace root`);
    if (!/github\.action_path/.test(t)) bad(`the ${a} action must locate scripts with github.action_path`);
  }
  ok("twin-fork outputs both naming styles, only restores, passes BASE_UPSTREAM_RPC through, and all three actions use github.action_path");
}

// 3. nothing still boots the retired devnet.
const RETIRED = [
  /docker-compose\.alloc\.yaml/, /SMOKE_GENESIS_ALLOC_FILE/, /smoke-test-genesis-ingester/, /genesis-ingester/,
  /fresh_snapshot/, /apply-fresh-snapshot/, /boot-fork-state-anvil/, /Geth\+Lighthouse devnet/,
  /docker-compose\.yaml/,
  // the saved fork-state snapshot machinery (core 1496, 1498): the Twin chain is a lazy fork, nothing is saved
  /snapshot-fork/, /fork-snapshot-lib/, /check-fork-snapshot-contents/, /check-fork-manifest/, /check-fork-pin-age/,
  /check-fork-state-digest/, /fork-state-digest/, /check-fork-lockstep/, /run-golden-forge-forks/, /run-live-rpc-forge-fork/,
  /refresh-fork-fixture/, /check-fork-rpc-configured/, /fork-rpc-lib/, /fixtures\/fork-state/, /CURRENT\.anvil-state/,
  /usdc-storage-seed/, /expected-prices/, /anvil_dumpState/, /anvil --dump-state/,
];
const SKIP_DIRS = new Set(["node_modules", "target", ".git", "lib", "out", "cache", "deployments"]);
function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ya?ml|ts|rs|sh|toml|json|mjs)$/.test(e)) yield p;
  }
}
const SELF = "scripts/devnet/check-twin-chain-ci-selftest.ts";
const ALSO_NAMES_RETIRED = new Set(["scripts/ci/check-nightly-dispatch-selftest.ts"]); // names the deleted files on purpose
const hits: string[] = [];
for (const root of [".github", "scripts", "testing", "clients/dapp/tests", "services"]) {
  if (!existsSync(root)) continue;
  for (const f of walk(root)) {
    if (f === SELF || ALSO_NAMES_RETIRED.has(f)) continue;
    const text = readFileSync(f, "utf8");
    for (const re of RETIRED) if (re.test(text)) hits.push(`${f}: ${re}`);
  }
}
if (hits.length) bad(`references to the retired geth devnet or snapshot overlay remain:\n  ${hits.join("\n  ")}`);
ok("no workflow, script or test boots or names the retired geth+lighthouse devnet, genesis alloc or fresh-snapshot overlay");

// 4. retired files are gone.
for (const gone of [
  "testing/ethereum-testnet/config/docker-compose.yaml",
  "testing/ethereum-testnet/config/docker-compose.alloc.yaml",
  "testing/ethereum-testnet/config/genesis",
  "testing/smoke-test/src/genesis_alloc.rs",
  "testing/smoke-test/src/bin/genesis-ingester.rs",
  "scripts/devnet/nightly-fresh-snapshot.ts",
  ".github/actions/apply-fresh-snapshot",
  ".github/workflows/suite-29-nightly-fresh-snapshot.yml",
  ".github/workflows/suite-29-nightly-twin-chain.yml",
  "scripts/devnet/snapshot-fork.ts",
  "scripts/devnet/fork-snapshot-lib.ts",
  "scripts/devnet/check-fork-snapshot-contents.ts",
  "scripts/devnet/check-fork-manifest.sh",
  "scripts/devnet/check-fork-pin-age.sh",
  "scripts/devnet/fork-state-digest.sh",
  "scripts/devnet/check-fork-lockstep.ts",
  "scripts/devnet/run-golden-forge-forks.sh",
  "scripts/devnet/run-live-rpc-forge-fork.sh",
  "scripts/devnet/fork-rpc-lib.sh",
  "testing/fixtures/fork-state",
  "testing/ethereum-testnet/config/fork-block.json",
  "testing/ethereum-testnet/config/expected-prices.json",
]) if (existsSync(gone)) bad(`${gone} must be deleted`);
ok("the geth/lighthouse compose, genesis alloc handling, ingester and fresh-snapshot overlay are deleted");

console.log(`twin chain CI self-test: ${pass} checks passed`);
