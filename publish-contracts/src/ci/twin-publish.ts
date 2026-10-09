#!/usr/bin/env bun
// The step script of the twin-publish action (core 1488, 1523), in TypeScript because no shell file may orchestrate the deploy driver.
// Environment in: RPC_URL, SHARE_RECEIVER_IN, VERIFY_IN, GOVERN_IN, GITHUB_WORKSPACE, GITHUB_ENV.
// The order is publish, verify, govern, verify (issue 1667): the second verify runs only with both VERIFY_IN and GOVERN_IN.
// Tests replace the tools with stubs: TWIN_CLI (default src/cli.ts), TWIN_REHEARSAL_CLI (src/rehearsal/cli.ts), TWIN_MERGE_SHEET (src/ci/merge-sheet.ts), CAST (cast).
// Any tool that exits non-zero fails this script. The only Twin environment steps are fund-gas and fund-usdc (the RM/USDC pool is never funded: the Twin forks the live pool, owner decision 2026-10-09); the govern time warp is inside the CLI.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const sheet = join(rh, "sheet.env");
run([bun, mergeSheet, "--template", join(core, "deployments/twin-918453/stage-sheet.env"), "--fragment", fragment, "--out", sheet], { cwd: pc });
// Twin environment steps: gas for every key, USDC for the seed deposit.
run([bun, rehearsal, "fund-gas", "--rpc", rpc, "--sheet", sheet], { cwd: pc });
run([bun, rehearsal, "fund-usdc", "--rpc", rpc, "--sheet", sheet, "--usdc-units", "2000000000"], { cwd: pc });

const admin = /^ADMIN_ADDRESS=(.*)$/m.exec(readFileSync(fragment, "utf8"))?.[1]?.trim() ?? fail("the key fragment has no ADMIN_ADDRESS");
exportVar("TWIN_MANIFEST_DIR", join(rh, "manifests"));
exportVar("TWIN_DEPLOYER_ADDRESS", admin);
exportVar("TWIN_RUN_DIR", rh);

// One CLI verb, the same flags for each. The unattended Twin chain run needs YES=1 (the CLI refuses it on 8453).
const stage = (verb: string, stdoutTo?: string) => run([bun, cli, verb, "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet,
  "--signer", `keystore:${join(rh, "keys/DEPLOYER")}:${pass}`, "--environment", "stage", "--core-sha", sha,
  "--counts-dir", join(rh, "counts"), "--evidence", join(rh, "evidence")], { cwd: pc, stdoutTo, childEnv: { PUBLISH_MANIFEST_DIR: join(rh, "manifests"), YES: "1" } });

// No frozen file in the empty counts dir: the Twin chain publish measures the per-stage counts and writes <counts-dir>/<sha>.json.
stage("publish");
// counts.json: the measured counts and the real deployer nonce, read after publish (verify and govern send nothing from the deployer).
const nonce = run([env("CAST", "cast"), "nonce", admin, "--rpc-url", rpc]).trim();
const countsJson = join(rh, "counts.json");
run([bun, "src/ci/rehearsal-counts.ts", "build", "--counts-dir", join(rh, "counts"), "--sha", sha, "--nonce", nonce, "--out", countsJson], { cwd: pc });
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
