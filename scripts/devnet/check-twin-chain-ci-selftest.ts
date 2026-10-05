#!/usr/bin/env bun
/**
 * Self-test for the Twin chain CI wiring (core 1498, 1496). Offline, needs yq. Run on every pull
 * request by suite-13-doc-checks.yml.
 *
 * The Twin chain (id 918453) is a pinned lazy fork of real Base state made with anvil. This checks
 * the owner rule "ONE pin per workflow run (a setup job outputs the pin; jobs take it as input)":
 *   1. the nightly (suite-29-nightly-twin-chain.yml) calls suites 5, 7, 8, 10, 11b and 14 with
 *      pin_block taken from its own pin job, and passes secrets with `secrets: inherit`;
 *   2. each of those suites declares the workflow_call input pin_block, has a `pin` job that uses
 *      .github/actions/twin-pin with that input, and every step that uses .github/actions/twin-fork
 *      takes its pin-block from the pin job output and sits in a job that needs the pin job;
 *   3. nothing in .github, scripts, testing, clients or services still references the retired
 *      geth+lighthouse devnet, the genesis alloc, the fresh-snapshot overlay or the saved
 *      .anvil-state fixture for a chain boot;
 *   4. the retired files are gone.
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

const NIGHTLY = ".github/workflows/suite-29-nightly-twin-chain.yml";
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

// 3. nothing still boots the retired devnet.
const RETIRED = [
  /docker-compose\.alloc\.yaml/, /SMOKE_GENESIS_ALLOC_FILE/, /smoke-test-genesis-ingester/, /genesis-ingester/,
  /fresh_snapshot/, /apply-fresh-snapshot/, /boot-fork-state-anvil/, /Geth\+Lighthouse devnet/,
  /docker-compose\.yaml/,
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
const hits: string[] = [];
for (const root of [".github", "scripts", "testing", "clients/dapp/tests", "services"]) {
  if (!existsSync(root)) continue;
  for (const f of walk(root)) {
    if (f === SELF || f.endsWith("fork-block.json")) continue;
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
]) if (existsSync(gone)) bad(`${gone} must be deleted`);
ok("the geth/lighthouse compose, genesis alloc handling, ingester and fresh-snapshot overlay are deleted");

console.log(`twin chain CI self-test: ${pass} checks passed`);
