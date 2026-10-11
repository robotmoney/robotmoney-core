#!/usr/bin/env bun
// The step script of the twin-publish action (core 1488, 1523), in TypeScript because no shell file may orchestrate the deploy driver.
// Environment in: RPC_URL, SHARE_RECEIVER_IN, VERIFY_IN, GOVERN_IN, PREDEPLOY_LIBS_IN, PIN_BLOCK_IN (optional), REHEARSAL_IN, GITHUB_WORKSPACE, GITHUB_ENV.
// REHEARSAL_IN=true (issue 1727) runs the Twin chain in the REHEARSAL kind the Base mainnet rehearsal uses: the sheet gets DEPLOYMENT_KIND=rehearsal, TIMELOCK_MIN_DELAY=900, a new
// SAFE_SALT_NONCE, and the deployer is NOT fresh (one self-transfer before publish moves its nonce, so the relative nonce accounting runs). After govern and the second verify it
// runs the receipt path with a REAL recorded receipt, not a fixture. The SUBMITTER is a SECOND Safe (issue 1750, owner decision 2026-10-10: the submitter is a multisig, never a key): this script
// creates it with the Safe tool (the same three owners, threshold 2, a different salt), registers it through the governing Safe and the timelock (govern --row register-committee --submitter),
// two of its owners sign the record and the deployer pays the gas (the record-receipt verb with --submitter), the Safe applies it (govern --row apply-receipt: releaseReceipt plus the router weights), then verify a third time and check the run manifest's receipt path (evidence-check).
// The order is publish, verify, govern, verify (issue 1667): the second verify runs only with both VERIFY_IN and GOVERN_IN.
// Tests replace the tools with stubs: TWIN_CLI (default src/cli.ts), TWIN_EVIDENCE_CHECK (default src/evidence-check.ts), TWIN_REHEARSAL_CLI (src/rehearsal/cli.ts), TWIN_MERGE_SHEET (src/ci/merge-sheet.ts), CAST (cast).
// Any tool that exits non-zero fails this script. The only Twin environment steps are fund-gas and fund-usdc (the RM/USDC pool is never funded: the Twin forks the live pool, owner decision 2026-10-09); the govern time warp is inside the CLI.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { receiptIdOfBytes, receiptPayloadDigest } from "../receipt-digest.ts";
import { TWIN_CHAIN_ID } from "../chains.ts";

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
const safeCli = env("TWIN_SAFE_CLI", "src/safe/cli.ts");

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
const safeSalt = Math.floor(Date.now() / 1000);
if (rehearsalMode) appendFileSync(fragment, ["DEPLOYMENT_KIND=rehearsal", "TIMELOCK_MIN_DELAY=900", "GOVERN_NEW_DELAY=1800", `SAFE_SALT_NONCE=${safeSalt}`].join("\n") + "\n");
const sheet = join(rh, "sheet.env");
run([bun, mergeSheet, "--template", join(core, "deployments/twin-918453/stage-sheet.env"), "--fragment", fragment, "--out", sheet], { cwd: pc });
// PREDEPLOY_LIBS_IN=true (issue 1721): put all four CREATE2 libraries on the fork first, so the whole run finds them already deployed (the state of Base after the real deploy).
if (env("PREDEPLOY_LIBS_IN") === "true") run([bun, predeploy, "--rpc", rpc, "--core-dir", core], { cwd: pc });
// Twin environment steps: gas for every key, USDC for the seed deposit.
run([bun, rehearsal, "fund-gas", "--rpc", rpc, "--sheet", sheet], { cwd: pc });
run([bun, rehearsal, "fund-usdc", "--rpc", rpc, "--sheet", sheet, "--usdc-units", "2000000000"], { cwd: pc });

const admin = /^ADMIN_ADDRESS=(.*)$/m.exec(readFileSync(fragment, "utf8"))?.[1]?.trim() ?? fail("the key fragment has no ADMIN_ADDRESS");
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
run([bun, "src/ci/rehearsal-counts.ts", "build", "--counts-dir", join(rh, "counts"), "--sha", sha, "--nonce", nonce, "--out", countsJson, "--run-manifest", join(rh, "evidence", "publish-run.json"), ...(rehearsalMode ? ["--start-nonce", startNonce] : []), ...(env("PIN_BLOCK_IN") ? ["--pin-block", env("PIN_BLOCK_IN")] : [])], { cwd: pc });
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
  // The SUBMITTER is a second Safe: the same owners as the governing Safe and threshold 2, a different salt (so a different address and its own nonce). The deployer pays its creation.
  const owners = /^SAFE_OWNERS=(.*)$/m.exec(readFileSync(fragment, "utf8"))?.[1]?.trim() ?? fail("the key fragment has no SAFE_OWNERS");
  const submitterSafeJson = join(rh, "submitter-safe.json");
  run([bun, safeCli, "create", "--rpc", rpc, "--chain-id", String(TWIN_CHAIN_ID), "--owners", owners, "--threshold", "2", "--signer", `keystore:${join(rh, "keys/DEPLOYER")}:${pass}`,
    "--salt-nonce", String(safeSalt + 1), "--yes", "--out", submitterSafeJson], { cwd: pc, stdoutTo: join(rh, "submitter-safe-create.txt"), childEnv: { ADMIN_ADDRESS: admin } });
  const submitter = (JSON.parse(readFileSync(submitterSafeJson, "utf8")) as { safe?: string }).safe ?? fail("the submitter Safe manifest has no safe address");
  // A REAL receipt payload (issue 1754): the production swarm receipt of session 5015526d-27f6-478a-86e9-ac768e310af1, byte for byte as the canonical route serves it, with its four signed weights
  // (agent 575, conservative 8550, protocol 525, rwa 350 bps). Digest and id come from the shared protocol functions (receipt-digest.ts), never from a plain keccak256 of the file.
  const payload = join(rh, "receipt-payload.json");
  const body = readFileSync(join(import.meta.dir, "..", "..", "tests", "fixtures", "real-consensus-receipt.canonical.json"));
  writeFileSync(payload, body);
  const digest = receiptPayloadDigest(new Uint8Array(body));
  const receiptId = receiptIdOfBytes(new Uint8Array(body)) ?? fail("the receipt fixture has no session_id and subject_id");
  const uri = `https://twin.invalid/receipts/${receiptId}.json`;
  stage("govern", join(rh, "register-committee-rows.txt"), ["--row", "register-committee", "--submitter", submitter, "--agent-label", "twin-submitter"]);
  // --signer is the DEPLOYER (it pays the gas); two of the submitter Safe's owners sign (their keystores sit beside the DEPLOYER keystore).
  stage("record-receipt", join(rh, "record-receipt.txt"), ["--receipt-id", receiptId, "--payload-digest", digest, "--payload", payload, "--payload-uri", uri, "--submitter", submitter]);
  stage("govern", join(rh, "apply-receipt-rows.txt"), ["--row", "apply-receipt", "--receipt-id", receiptId, "--payload", payload]);
  exportVar("TWIN_RECEIPT_ID", receiptId);
  exportVar("TWIN_RECEIPT_SUBMITTER", submitter);
  exportVar("TWIN_SUBMITTER_SAFE_JSON", submitterSafeJson);
  if (env("VERIFY_IN") === "true") {
    stage("verify", join(rh, "verify-labels-post-apply.txt"));
    exportVar("TWIN_VERIFY_LABELS_POST_APPLY", join(rh, "verify-labels-post-apply.txt"));
  }
  // The run manifest's receipt path (registration, recorded receipt, application) read back from the chain with the rehearsal evidence checker.
  run([bun, env("TWIN_EVIDENCE_CHECK", "src/evidence-check.ts"), "--receipt-applications", join(rh, "evidence", "publish-run.json"), "--deployment-kind", "rehearsal", "--consensus-receipt", field("ic-policy", "consensus_receipt"),
    "--governance", field("governance", "governance"), "--timelock", field("timelock", "timelock"), "--rpc", rpc], { cwd: pc });
}
