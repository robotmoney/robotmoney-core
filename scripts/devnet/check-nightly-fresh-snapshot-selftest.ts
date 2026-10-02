#!/usr/bin/env bun
/**
 * Selftest for nightly job (b), suite-29-nightly-fresh-snapshot.yml (core 1496).
 * Ports check-nightly-fresh-snapshot-selftest.sh to Bun TypeScript.
 * Offline and fast: yq, jq-free JSON, bun. No chain, no network, no secret.
 *
 * It fails when:
 *   - suite 5, 7, 8, 10, 11b or 14 is missing from the workflow (negative control on a temp copy);
 *   - suite 26 is back in the workflow without a way to run on the fresh snapshot with no secret;
 *   - the workflow or a called suite job references a secret other than GITHUB_TOKEN
 *     (a job gated off by `inputs.fresh_snapshot != true` is allowed), or a keyed or archive RPC URL;
 *   - check-nightly-fresh-snapshot.ts accepts a manifest without block number, hash or timestamp,
 *     or one whose block timestamp is more than one hour old;
 *   - it accepts a stubbed failing, cancelled, skipped or missing suite result;
 *   - the called suite list is not exactly the final list, or the results job still ends in a git diff
 *     step that cannot see suite runners (removed: it ran on a fresh checkout);
 *   - snapshot-fork retries do not survive a stub HTTP 429 (snapshot-fork-selftest.ts).
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
process.chdir(ROOT);
const WF = ".github/workflows/suite-29-nightly-fresh-snapshot.yml";
const CHECK = "scripts/devnet/check-nightly-fresh-snapshot.ts";
const WORK = mkdtempSync(join(tmpdir(), "nightly-selftest-"));
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));

// Suite 26 is out of the nightly: it needs secrets.FUSION_RMPC_CONFIG and targets the
// shared fusion devnet, so it cannot run on the fresh Twin snapshot with no secret.
// Recorded in docs/development/nightly-fresh-snapshot.md.
const SUITE_FILE: Record<string, string> = {
  "5": "suite-05-fork-integration.yml",
  "7": "suite-07-rmpc-integration.yml",
  "8": "suite-08-explorer-indexer.yml",
  "10": "suite-10-dapp-e2e.yml",
  "11b": "suite-11b-opencode-headless.yml",
  "14": "suite-14-smoke-test.yml",
};
const SUITES = Object.keys(SUITE_FILE);
// Secrets a called suite is allowed to use in a fresh-snapshot run, with the reason.
const KNOWN_SECRET_EXCEPTIONS: Record<string, string> = {
  "suite-14-smoke-test.yml:DEVOPS_READ_TOKEN":
    "checks out the private devops repo for publish-contracts; read-only token, to be replaced by a public checkout (documented in nightly-fresh-snapshot.md)",
};

let pass = 0;
const ok = (m: string) => { pass++; console.log(`ok   - ${m}`); };
const bad = (m: string): never => { console.error(`FAIL - ${m}`); process.exit(1); };

function run(cmd: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
const yq = (expr: string, file: string) => run(["yq", "-r", expr, file]);
const yqOk = (expr: string, file: string) => run(["yq", "-e", expr, file]).code === 0;
if (run(["yq", "--version"]).code !== 0) { console.error("selftest needs yq"); process.exit(2); }

const missingSuites = (file: string): string[] =>
  SUITES.filter((s) => !yqOk(`.jobs[] | select(.uses == "./.github/workflows/${SUITE_FILE[s]}")`, file)).map(
    (s) => `suite ${s} (./.github/workflows/${SUITE_FILE[s]})`,
  );
const jobKey = (s: string) =>
  yq(`.jobs | to_entries[] | select(.value.uses == "./.github/workflows/${SUITE_FILE[s]}") | .key`, WF).out.trim();

// 0. the final suite list is exactly SUITES: no more, no fewer
const called = yq('.jobs[] | select(.uses != null) | .uses', WF).out.split("\n").filter(Boolean).sort();
const want = Object.values(SUITE_FILE).map((f) => `./.github/workflows/${f}`).sort();
if (JSON.stringify(called) !== JSON.stringify(want))
  bad(`the called suite list is not the final list.\n  want: ${want.join(" ")}\n  got:  ${called.join(" ")}`);
ok(`the called suite list is exactly: suites ${SUITES.join(", ")}`);

// 1. every suite is in the workflow
const m0 = missingSuites(WF);
if (m0.length) bad(`the workflow is missing: ${m0.join(", ")}`);
ok(`suites ${SUITES.join(", ")} are all called by ${WF}`);
if (yqOk(`.jobs[] | select(.uses == "./.github/workflows/suite-26-fusion-devnet-acceptance.yml")`, WF))
  bad("suite 26 is called by the nightly again: it needs secrets and the shared devnet, so it cannot run on the fresh snapshot");
ok("suite 26 is not in the nightly (needs a secret; recorded in docs/development/nightly-fresh-snapshot.md)");
for (const s of SUITES) {
  if (!yqOk(`.jobs[] | select(.uses == "./.github/workflows/${SUITE_FILE[s]}") | .with.fresh_snapshot == true`, WF))
    bad(`suite ${s} is not called with fresh_snapshot: true`);
}
ok("every suite runs against the fresh snapshot (fresh_snapshot: true)");
for (const s of SUITES) {
  const key = jobKey(s);
  if (!yqOk(`.jobs.results.needs | contains(["${key}"])`, WF)) bad(`the results job does not wait for ${key}`);
}
ok("the results job needs every suite job");
for (const s of SUITES) {
  const key = jobKey(s);
  const f = join(WORK, `without-${s}.yml`);
  writeFileSync(f, yq(`del(.jobs."${key}")`, WF).out);
  if (!missingSuites(f).some((l) => l.startsWith(`suite ${s} `))) bad(`removing suite ${s} from the workflow was not detected`);
}
ok(`removing any one of the ${SUITES.length} suites is detected (negative control)`);
if (!yqOk(".on | has(\"schedule\")", WF) || !yqOk(".on | has(\"workflow_dispatch\")", WF))
  bad("the workflow needs schedule and workflow_dispatch");
ok("the workflow has a nightly schedule and workflow_dispatch");

// 2. no secret, no keyed or archive RPC
const stripComments = (t: string) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
function scan(text: string): string[] {
  const v: string[] = [];
  for (const m of new Set([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((x) => x[1])))
    if (m !== "GITHUB_TOKEN") v.push(`secret other than GITHUB_TOKEN: secrets.${m}`);
  for (const m of text.matchAll(/(alchemy|infura|quicknode|quiknode|ankr|drpc|chainstack|blastapi|llamarpc|nodereal|getblock|tenderly)[A-Za-z0-9./_-]*/gi))
    v.push(`keyed or archive RPC: ${m[0]}`);
  for (const m of text.matchAll(/RMPC_FORK_RPC_URL|BASE_RPC_URL|ARCHIVE_RPC[A-Z_]*/g)) v.push(`RPC variable: ${m[0]}`);
  for (const m of text.matchAll(/https?:\/\/[^ "]*[?/][A-Za-z0-9_-]{24,}/g)) v.push(`RPC URL with a key: ${m[0]}`);
  return v;
}
const live = stripComments(readFileSync(WF, "utf8"));
const v0 = scan(live);
if (v0.length) bad(`the workflow carries: ${v0.join("; ")}`);
ok("the workflow references no secret other than GITHUB_TOKEN and no keyed or archive RPC");
if (!scan(live + "\nenv: { X: ${{ secrets.ALCHEMY_KEY }} }").length) bad("a stub secret was not detected");
if (!scan(live + "\nurl: https://base-mainnet.g.alchemy.com/v2/abc").length) bad("a stub keyed RPC URL was not detected");
if (scan(live + "\nt: ${{ secrets.GITHUB_TOKEN }}").length) bad("GITHUB_TOKEN must be allowed");
ok("the scanner flags a stub secret and a stub keyed RPC URL and allows GITHUB_TOKEN (negative control)");

// 2b. called suites: a job that uses a secret must be gated off in a fresh-snapshot run.
function suiteSecretViolations(file: string): string[] {
  const out: string[] = [];
  const jobs = JSON.parse(run(["yq", "-o=json", ".jobs", file]).out || "{}") as Record<string, unknown>;
  for (const [name, job] of Object.entries(jobs)) {
    const text = stripComments(JSON.stringify(job));
    const ifCond = String((job as { if?: unknown }).if ?? "");
    const gatedOff = /fresh_snapshot\s*!=\s*true/.test(ifCond);
    for (const s of new Set([...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((x) => x[1]))) {
      if (s === "GITHUB_TOKEN" || gatedOff) continue;
      const key = `${file.split("/").pop()}:${s}`;
      if (key in KNOWN_SECRET_EXCEPTIONS) continue;
      out.push(`${file} job ${name} uses secrets.${s} and is not gated by inputs.fresh_snapshot != true`);
    }
  }
  return out;
}
for (const s of SUITES) {
  const v = suiteSecretViolations(`.github/workflows/${SUITE_FILE[s]}`);
  if (v.length) bad(v.join("; "));
}
ok("no called suite job uses a secret in a fresh-snapshot run (suite 5 testnet job is gated off; known exceptions listed)");
const stub = join(WORK, "stub-suite.yml");
writeFileSync(stub, "jobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ secrets.FOO }}\n");
if (!suiteSecretViolations(stub).length) bad("a stub suite job using a secret was not detected");
writeFileSync(stub, "jobs:\n  j:\n    runs-on: x\n    if: ${{ inputs.fresh_snapshot != true }}\n    steps:\n      - run: echo ${{ secrets.FOO }}\n");
if (suiteSecretViolations(stub).length) bad("a gated-off suite job was flagged");
ok("the suite scanner flags an ungated secret job and allows a gated-off one (negative control)");

// 3. the manifest check
const NOW = 1790000000;
function manifest(file: string, ts: number, drop?: string) {
  const m: Record<string, unknown> = { block_number: 48896605, block_hash: "0x" + "ab".repeat(32), block_timestamp: ts };
  if (drop) delete m[drop];
  writeFileSync(file, JSON.stringify(m));
}
const check = (...args: string[]) => run(["bun", CHECK, "--now", String(NOW), ...args]);
const fresh = join(WORK, "fresh.json");
manifest(fresh, NOW - 600);
let r = check("--manifest", fresh);
if (r.code) bad(`a fresh manifest was rejected: ${r.out}`);
ok("a manifest with block number, hash and a timestamp 10 minutes old passes");
const old = join(WORK, "old.json");
manifest(old, NOW - 3601);
r = check("--manifest", old);
if (!r.code) bad("a manifest more than one hour old was accepted");
if (!r.out.includes("older than")) bad(`the stale failure did not say why: ${r.out}`);
ok("a manifest whose block is 3601 seconds old fails");
const edge = join(WORK, "edge.json");
manifest(edge, NOW - 3600);
if (check("--manifest", edge).code) bad("a manifest exactly one hour old was rejected");
ok("a manifest exactly one hour old still passes (the limit is over one hour)");
for (const f of ["block_number", "block_hash", "block_timestamp"]) {
  const p = join(WORK, `no-${f}.json`);
  manifest(p, NOW - 60, f);
  if (!check("--manifest", p).code) bad(`a manifest without ${f} was accepted`);
}
ok("a manifest missing block_number, block_hash or block_timestamp fails");
const short = join(WORK, "short-hash.json");
writeFileSync(short, JSON.stringify({ ...JSON.parse(readFileSync(fresh, "utf8")), block_hash: "0x1234" }));
if (!check("--manifest", short).code) bad("a manifest with a short block hash was accepted");
ok("a manifest whose block hash is not 32 bytes fails");
if (!check("--manifest", join(WORK, "does-not-exist.json")).code) bad("a missing manifest was accepted");
ok("a missing manifest fails");

// 4. the suite results gate
const results = join(WORK, "results");
mkdirSync(results);
const putResult = (s: string, result: string) => writeFileSync(join(results, `suite-${s}.json`), JSON.stringify({ suite: s, result }));
for (const s of SUITES) putResult(s, "success");
r = check("--manifest", fresh, "--suite-results", results);
if (r.code) bad(`passing suites were rejected: ${r.out}`);
ok(`${SUITES.length} successful suite results pass`);
for (const outcome of ["failure", "cancelled", "skipped"]) {
  putResult("14", outcome);
  r = check("--manifest", fresh, "--suite-results", results);
  if (!r.code) bad(`a ${outcome} suite 14 result was accepted`);
  if (!r.out.includes("suite 14")) bad(`the ${outcome} failure did not name suite 14`);
}
ok("a stubbed failure, cancelled or skipped suite exits non-zero and names the suite");
putResult("14", "success");
rmSync(join(results, "suite-7.json"));
r = check("--manifest", fresh, "--suite-results", results);
if (!r.code) bad("a missing suite 7 result was accepted");
if (!r.out.includes("suite 7")) bad("the missing result did not name suite 7");
ok("a missing suite result exits non-zero and names the suite");
if (!yqOk('.jobs.results.steps[] | select(.run | test("check-nightly-fresh-snapshot.ts")) | .run | test("--suite-results")', WF))
  bad("the results job does not run the gate with --suite-results");
ok("the results job runs the gate with --suite-results");

// 5. nothing is committed
if (yq(".jobs.results.steps[].run // \"\"", WF).out.includes("git diff"))
  bad("the results job has a git diff step again: it runs on a fresh checkout and cannot see what the suite runners did");
ok("the results job has no git diff step (it could not see suite runners; reason in the workflow header)");
if (!yqOk('.permissions.contents == "read" and (.permissions | length) == 1', WF)) bad("the workflow permissions are not contents: read only");
ok("workflow permissions are contents: read only");
if (/git (add|commit|push)/.test(live)) bad("the workflow commits or pushes");
ok("the workflow never runs git add, commit or push");

// 6. HTTP 429 retry and no Deploy.s.sol
r = run(["bun", "scripts/devnet/snapshot-fork-selftest.ts"]);
if (r.code) { console.error(r.out); bad("snapshot-fork-selftest.ts failed (429 retry, no Deploy.s.sol)"); }
if (!r.out.includes("retries HTTP 429 until it succeeds")) bad("the 429 retry assertion did not run");
ok("the snapshot tooling retries a stub HTTP 429 and then succeeds");

console.log(`nightly fresh snapshot selftest: ${pass} checks passed`);
