#!/usr/bin/env bun
// The step script of the twin-publish action (core 1488, 1523), in TypeScript because no shell file may orchestrate the deploy driver.
// Environment in: RPC_URL, SHARE_RECEIVER_IN, VERIFY_IN, GOVERN_IN, PREDEPLOY_LIBS_IN, REHEARSAL_IN, GITHUB_WORKSPACE, GITHUB_ENV.
// REHEARSAL_IN=true (issue 1727) runs the Twin chain in the REHEARSAL kind the Base mainnet rehearsal uses: the sheet gets DEPLOYMENT_KIND=rehearsal, TIMELOCK_MIN_DELAY=900, a new
// SAFE_SALT_NONCE, and the deployer is NOT fresh (one self-transfer before publish moves its nonce, so the relative nonce accounting runs). After govern and the second verify it
// runs the receipt path with a REAL recorded receipt, not a fixture: register the SUBMITTER through the Safe and the timelock (govern --row register-committee), the submitter records the
// receipt through the gateway (the record-receipt verb), the Safe applies it (govern --row apply-receipt: releaseReceipt plus the router weights), then verify a third time and check the run manifest's receipt path (evidence-check).
// The order is publish, verify, govern, verify (issue 1667): the second verify runs only with both VERIFY_IN and GOVERN_IN.
// Tests replace the tools with stubs: TWIN_CLI (default src/cli.ts), TWIN_EVIDENCE_CHECK (default src/evidence-check.ts), TWIN_REHEARSAL_CLI (src/rehearsal/cli.ts), TWIN_MERGE_SHEET (src/ci/merge-sheet.ts), CAST (cast).
// Any tool that exits non-zero fails this script. The only Twin environment steps are fund-gas and fund-usdc (the RM/USDC pool is never funded: the Twin forks the live pool, owner decision 2026-10-09); the govern time warp is inside the CLI.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
import { TWIN_CHAIN_ID } from "../chains.ts";
import { keygen } from "../keystore/keygen.ts";

const env = (k: string, d = ""): string => process.env[k] ?? d;
const fail = (m: string): never => { console.error(`twin-publish: ${m}`); process.exit(1); };

function run(cmd: string[], opts: { cwd?: string; stdoutTo?: string; childEnv?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.childEnv }, stdout: "pipe", stderr: "inherit" });
  const out = r.stdout.toString();
  if (opts.stdoutTo) writeFileSync(opts.stdoutTo, out); else process.stdout.write(out);
  if (r.exitCode !== 0) fail(`${cmd.slice(0, 3).join(" ")} exited ${r.exitCode}`);
  return out;
}

const core = env("GITHUB_WORKSPACE") || fail("GITHUB_WORKSPACE is not set");
const rpc = env("RPC_URL");
const ghEnv = env("GITHUB_ENV");
const exportVar = (k: string, v: string) => { if (ghEnv) appendFileSync(ghEnv, `${k}=${v}\n`); };
const sha = run(["git", "-C", core, "rev-parse", "HEAD"]).trim();
const pc = join(core, "publish-contracts");
const bun = process.execPath;
const cli = env("TWIN_CLI", "src/cli.ts");
const rehearsal = env("TWIN_REHEARSAL_CLI", "src/rehearsal/cli.ts");
const mergeSheet = env("TWIN_MERGE_SHEET", "src/ci/merge-sheet.ts");
const predeploy = env("TWIN_PREDEPLOY", "src/ci/predeploy-libs.ts");

// Under /tmp: foundry.toml fs_permissions lets the deploy scripts write their manifests there only.
const rh = mkdtempSync("/tmp/twin-publish.");
mkdirSync(join(rh, "manifests")); mkdirSync(join(rh, "counts"));
// A random passphrase in a 0600 file. It is never an argument or an exported variable.
const pass = join(rh, "passphrase");
writeFileSync(pass, Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex"), { mode: 0o600 });

const fragment = join(rh, "fragment.env");
run([bun, rehearsal, "keys", "--dir", join(rh, "keys"), "--password-file", pass, "--chain-id", String(TWIN_CHAIN_ID)], { cwd: pc, stdoutTo: fragment });
// Later lines win in merge-sheet.
if (env("SHARE_RECEIVER_IN")) appendFileSync(fragment, `SHARE_RECEIVER_ADDRESS=${env("SHARE_RECEIVER_IN")}\n`);
// The rehearsal kind (issue 1727): explicit lines, later lines win. The committed Twin sheet stays production-kind (60 s); this job is the rehearsal.
const rehearsalMode = env("REHEARSAL_IN") === "true";
if (rehearsalMode) appendFileSync(fragment, ["DEPLOYMENT_KIND=rehearsal", "TIMELOCK_MIN_DELAY=900", "GOVERN_NEW_DELAY=1800", `SAFE_SALT_NONCE=${Math.floor(Date.now() / 1000)}`].join("\n") + "\n");
const sheet = join(rh, "sheet.env");
run([bun, mergeSheet, "--template", join(core, "deployments/twin-918453/stage-sheet.env"), "--fragment", fragment, "--out", sheet], { cwd: pc });
// PREDEPLOY_LIBS_IN=true (issue 1721): put all four CREATE2 libraries on the fork first, so the whole run finds them already deployed (the state of Base after the real deploy).
if (env("PREDEPLOY_LIBS_IN") === "true") run([bun, predeploy, "--rpc", rpc, "--core-dir", core], { cwd: pc });
// Twin environment steps: gas for every key, USDC for the seed deposit.
run([bun, rehearsal, "fund-gas", "--rpc", rpc, "--sheet", sheet], { cwd: pc });
run([bun, rehearsal, "fund-usdc", "--rpc", rpc, "--sheet", sheet, "--usdc-units", "2000000000"], { cwd: pc });

const admin = /^ADMIN_ADDRESS=(.*)$/m.exec(readFileSync(fragment, "utf8"))?.[1]?.trim() ?? fail("the key fragment has no ADMIN_ADDRESS");
// The committee SUBMITTER key (rehearsal only): a throwaway keystore beside the others, under the same random passphrase file. A key never leaves its keystore.
const submitter = rehearsalMode ? (keygen(join(rh, "keys"), pass, ["SUBMITTER"]).SUBMITTER ?? fail("no SUBMITTER address")) : "";
exportVar("TWIN_MANIFEST_DIR", join(rh, "manifests"));
exportVar("TWIN_DEPLOYER_ADDRESS", admin);
exportVar("TWIN_RUN_DIR", rh);

// One CLI verb, the same flags for each. The unattended Twin chain run needs YES=1 (the CLI refuses it on 8453).
const stage = (verb: string, stdoutTo?: string, extra: string[] = [], key = "DEPLOYER") => run([bun, cli, verb, "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet,
  "--signer", `keystore:${join(rh, "keys", key)}:${pass}`, "--environment", "stage", "--core-sha", sha,
  "--counts-dir", join(rh, "counts"), "--evidence", join(rh, "evidence"), ...extra], { cwd: pc, stdoutTo, childEnv: { PUBLISH_MANIFEST_DIR: join(rh, "manifests"), YES: "1" } });
const castBin = env("CAST", "cast");

// Rehearsal: the deployer is not fresh. One self-transfer moves its nonce before the first stage, so the start nonce is recorded and every later check runs relative to it.
if (rehearsalMode) run([castBin, "send", admin, "--value", "0", "--keystore", join(rh, "keys/DEPLOYER"), "--password-file", pass, "--rpc-url", rpc]);
const startNonce = rehearsalMode ? run([castBin, "nonce", admin, "--rpc-url", rpc]).trim() : "0";
// No frozen file in the empty counts dir: the Twin chain publish measures the per-stage counts and writes <counts-dir>/<sha>.json.
stage("publish");
// counts.json: the measured counts and the real deployer nonce, read after publish (it includes the one prove-control transaction; verify and govern run after it).
const nonce = run([castBin, "nonce", admin, "--rpc-url", rpc]).trim();
const countsJson = join(rh, "counts.json");
run([bun, "src/ci/rehearsal-counts.ts", "build", "--counts-dir", join(rh, "counts"), "--sha", sha, "--nonce", nonce, "--out", countsJson, "--run-manifest", join(rh, "evidence", "publish-run.json"), ...(rehearsalMode ? ["--start-nonce", startNonce] : [])], { cwd: pc });
run([bun, "src/ci/rehearsal-counts.ts", "check", "--file", countsJson], { cwd: pc });
exportVar("TWIN_COUNTS_JSON", countsJson);
if (env("VERIFY_IN") === "true") {
  stage("verify", join(rh, "verify-labels.txt"));
  exportVar("TWIN_VERIFY_LABELS", join(rh, "verify-labels.txt"));
}
if (env("GOVERN_IN") === "true") {
  // Stage 13 (the basket unpauses through the real Safe and timelock). On the Twin fork the 48 hour wait is one time warp.
  stage("govern", join(rh, "govern-rows.txt"));
  exportVar("TWIN_GOVERN_ROWS", join(rh, "govern-rows.txt"));
  // Issue 1667: verify, govern, verify. The second verify reads the post-govern state (the unpaused baskets). The Twin run only proves the scripts execute in this
  // order: the 48 hour delay and the Safe signers are proven on 8453 through the real Safe.
  if (env("VERIFY_IN") === "true") {
    stage("verify", join(rh, "verify-labels-post-govern.txt"));
    exportVar("TWIN_VERIFY_LABELS_POST_GOVERN", join(rh, "verify-labels-post-govern.txt"));
  }
}

// ---- the receipt path of a rehearsal (issue 1727): a REAL recorded receipt, registered submitter, applied by the Safe ----
if (rehearsalMode && env("GOVERN_IN") === "true") {
  const manifestDir = join(rh, "manifests");
  const field = (file: string, name: string): string => (JSON.parse(readFileSync(join(manifestDir, `${file}.json`), "utf8")) as Record<string, string>)[name] ?? fail(`manifest ${file}.json has no ${name}`);
  // The submitter pays its own gas: the deployer sends it a little, as the operator does on 8453.
  run([castBin, "send", submitter, "--value", "10000000000000000", "--keystore", join(rh, "keys/DEPLOYER"), "--password-file", pass, "--rpc-url", rpc]);
  // A real receipt payload: the allocation vector the Safe will apply, in the registry order of the four router-eligible vaults.
  const payload = join(rh, "receipt-payload.json");
  const body = JSON.stringify({ session_id: `twin-${sha.slice(0, 8)}`, subject_id: "router-weights", weights: [
    { bucket: "conservative_defi_yield", weight_bps: 8000 }, { bucket: "protocol_tokens", weight_bps: 1000 }, { bucket: "agent_tokens", weight_bps: 500 }, { bucket: "real_world_assets", weight_bps: 500 }] });
  writeFileSync(payload, body);
  const digest = keccak256(toBytes(body));
  const receiptId = keccak256(toBytes(`robotmoney:consensus-receipt-id:v1\ntwin-${sha.slice(0, 8)}\nrouter-weights`));
  const uri = `https://twin.invalid/receipts/${receiptId}.json`;
  stage("govern", join(rh, "register-committee-rows.txt"), ["--row", "register-committee", "--submitter", submitter, "--agent-label", "twin-submitter"]);
  stage("record-receipt", join(rh, "record-receipt.txt"), ["--receipt-id", receiptId, "--payload-digest", digest, "--payload-uri", uri], "SUBMITTER");
  stage("govern", join(rh, "apply-receipt-rows.txt"), ["--row", "apply-receipt", "--receipt-id", receiptId, "--payload", payload]);
  exportVar("TWIN_RECEIPT_ID", receiptId);
  exportVar("TWIN_RECEIPT_SUBMITTER", submitter);
  if (env("VERIFY_IN") === "true") {
    stage("verify", join(rh, "verify-labels-post-apply.txt"));
    exportVar("TWIN_VERIFY_LABELS_POST_APPLY", join(rh, "verify-labels-post-apply.txt"));
  }
  // The run manifest's receipt path (registration, recorded receipt, application) read back from the chain with the rehearsal evidence checker.
  run([bun, env("TWIN_EVIDENCE_CHECK", "src/evidence-check.ts"), "--receipt-applications", join(rh, "evidence", "publish-run.json"), "--deployment-kind", "rehearsal", "--consensus-receipt", field("ic-policy", "consensus_receipt"),
    "--governance", field("governance", "governance"), "--timelock", field("timelock", "timelock"), "--rpc", rpc], { cwd: pc });
}
