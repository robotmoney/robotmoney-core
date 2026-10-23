#!/usr/bin/env bun
// The step script of the twin-publish action (core 1488, 1523), in TypeScript because no shell file may orchestrate the deploy driver.
// Environment in: RPC_URL, SHARE_RECEIVER_IN, VERIFY_IN, GOVERN_IN, PREDEPLOY_LIBS_IN, PIN_BLOCK_IN (optional), REHEARSAL_IN, SHEET_OVERLAY_IN (optional), GITHUB_WORKSPACE, GITHUB_ENV.
// SHEET_OVERLAY_IN (issue 1811) is a committed sheet overlay, relative to the core checkout (deployments/twin-918453/upgrade-rehearsal.env): its NAME=value lines replace the same
// names of the committed Twin sheet, after the keystore lines and before the rehearsal-kind lines. The upgrade rehearsal uses it to deploy UPGRADE_MODE=upgradeable.
// When the merged sheet is upgradeable and names no UPGRADE_FREEZE_DEADLINE (issue 1846), this script sets it to the pin block timestamp (PIN_BLOCK_IN, else the fork's latest block, read with
// `cast block`) plus 365 days, so the rehearsal deadline moves with the Twin clock instead of being a hard-coded date the clock eventually passes.
// REHEARSAL_IN=true (issue 1727) runs the Twin chain in the REHEARSAL kind the Base mainnet rehearsal uses: the sheet gets DEPLOYMENT_KIND=rehearsal, TIMELOCK_MIN_DELAY=900, a new
// SAFE_SALT_NONCE, and the deployer is NOT fresh (one self-transfer before publish moves its nonce, so the relative nonce accounting runs). After govern and the second verify it
// runs the receipt path with a REAL recorded receipt, not a fixture. The SUBMITTER is a SECOND Safe (issue 1750, owner decision 2026-10-10: the submitter is a multisig, never a key): this script
// creates it with the Safe tool (the same three owners, threshold 2, a different salt), registers it through the governing Safe and the timelock (govern --row register-submitter --submitter: one delayed receipt grantRole),
// two of its owners sign the record and the deployer pays the gas (the record-receipt verb with --submitter), the Safe applies it (govern --row apply-receipt: ONE RouterGovernance.applyReceipt call, which releases the receipt and writes the router weights in one transaction, issue 1698), then verify a third time and check the run manifest's receipt path (evidence-check).
// The order is publish, verify, govern, verify (issue 1667): the second verify runs only with both VERIFY_IN and GOVERN_IN. Between govern and that verify, one set-unwind-guard
// round per basket stage 13 opened (QA plan v1 D7: the verifier requires the emergency unwind guard on an open basket). With GOVERN_IN the govern matrix then runs
// one Safe self-administration row on the REAL SafeL2 (QA plan v1 B5, finding T5): `govern --row safe-change-threshold` raises the threshold to the owner count, then
// restores the sheet's threshold (that second transaction carries every owner's signature and runs while the sheet is stale), before the receipt path.
// Tests replace the tools with stubs: TWIN_CLI (default src/cli.ts), TWIN_EVIDENCE_CHECK (default src/evidence-check.ts), TWIN_REHEARSAL_CLI (src/rehearsal/cli.ts), TWIN_MERGE_SHEET (src/ci/merge-sheet.ts), CAST (cast).
// Any tool that exits non-zero fails this script. The only Twin environment steps are fund-gas and fund-usdc (the RM/USDC pool is never funded: the Twin forks the live pool, owner decision 2026-10-09); the govern time warp is inside the CLI.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { GATEWAY_FILES, GATEWAY_STAGES, MARKERS, REQUIRED_GATEWAY_LABELS } from "./twin-markers.ts";
import { receiptIdOfBytes, receiptPayloadDigest } from "../receipt-digest.ts";
import { TWIN_CHAIN_ID } from "../chains.ts";
import { BASKET_KEYS, parseSheetText } from "../sheet.ts";
import { twinUnwindGuardArgs } from "../unwind-guard.ts";

/** The one Safe self-administration row the Twin govern matrix runs on the real SafeL2 (QA plan v1 B5): one Safe transaction to the Safe itself, no timelock round. */
const SELF_ADMIN_MATRIX_ROW = "safe-change-threshold";
const env = (k: string, d = ""): string => process.env[k] ?? d;
const fail = (m: string): never => { console.error(`twin-publish: ${m}`); process.exit(1); };
/** Issue 1846: the Twin rehearsal freeze deadline, the pin block timestamp (seconds) plus 365 days, in ISO 8601 UTC without milliseconds. */
function freezeDeadlineFromPin(pinTimestampSec: number): string {
  return new Date((pinTimestampSec + 365 * 86_400) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

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
if (env("SHEET_OVERLAY_IN")) appendFileSync(fragment, readFileSync(join(core, env("SHEET_OVERLAY_IN")), "utf8").replace(/\n?$/, "\n"));
// The rehearsal kind (issue 1727): explicit lines, later lines win. The committed Twin sheet stays production-kind (60 s); this job is the rehearsal.
const rehearsalMode = env("REHEARSAL_IN") === "true";
const safeSalt = Math.floor(Date.now() / 1000);
if (rehearsalMode) appendFileSync(fragment, ["DEPLOYMENT_KIND=rehearsal", "TIMELOCK_MIN_DELAY=900", "GOVERN_NEW_DELAY=1800", `SAFE_SALT_NONCE=${safeSalt}`].join("\n") + "\n");
const sheet = join(rh, "sheet.env");
run([bun, mergeSheet, "--template", join(core, "deployments/twin-918453/stage-sheet.env"), "--fragment", fragment, "--out", sheet], { cwd: pc });
const castBin = env("CAST", "cast");
// Issue 1846: an upgradeable sheet with no deadline gets pin block timestamp + 365 days (well past now + TIMELOCK_MIN_DELAY + 1 day, which the sheet parser requires).
const merged = readFileSync(sheet, "utf8");
const sheetValue = (name: string): string => [...merged.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].pop()?.[1]?.trim() ?? "";
if (sheetValue("UPGRADE_MODE") === "upgradeable" && sheetValue("UPGRADE_FREEZE_DEADLINE") === "") {
  const ts = run([castBin, "block", env("PIN_BLOCK_IN") || "latest", "--field", "timestamp", "--rpc-url", rpc], { stdoutTo: join(rh, "pin-block-timestamp.txt") }).trim();
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(ts)) fail(`cast block returned no timestamp: '${ts}'`);
  const line = `UPGRADE_FREEZE_DEADLINE=${freezeDeadlineFromPin(Number(BigInt(ts)))}`;
  writeFileSync(sheet, merged.replace(/^UPGRADE_FREEZE_DEADLINE=\s*$\n?/gm, "").replace(/\n?$/, "\n") + line + "\n");
}
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

// Rehearsal: the deployer is not fresh. One self-transfer moves its nonce before the first stage, so the start nonce is recorded and every later check runs relative to it.
if (rehearsalMode) run([castBin, "send", admin, "--value", "0", "--keystore", join(rh, "keys/DEPLOYER"), "--password-file", pass, "--rpc-url", rpc]);
const startNonce = rehearsalMode ? run([castBin, "nonce", admin, "--rpc-url", rpc]).trim() : "0";
// No frozen file in the empty counts dir: the Twin chain publish measures the per-stage counts and writes <counts-dir>/<sha>.json.
stage("publish");
// Issue 1892, mode vaults-only (VAULTS_ONLY_IN=true): the vaults system ran with the gateway absent. No gateway manifest, no gateway-handover manifest, and the run manifest holds no
// gateway stage. The marker line is required by the workflow (publish-contracts/src/ci/twin-markers.ts).
const vaultsOnly = env("VAULTS_ONLY_IN") === "true";
if (vaultsOnly) {
  const runStages = Object.keys((JSON.parse(readFileSync(join(rh, "evidence", "publish-run.json"), "utf8")) as { stages: Record<string, unknown> }).stages);
  const leaked = [...GATEWAY_FILES.filter((f) => existsSync(join(rh, "manifests", f))), ...runStages.filter((s) => GATEWAY_STAGES.includes(s))];
  if (leaked.length > 0) fail(`the vaults-only run left gateway artifacts: ${leaked.join(", ")}`);
  const gatewayTxs = runStages.filter((s) => GATEWAY_STAGES.includes(s)).length;
  console.log(`${MARKERS.vaultsOnly} stages=${runStages.length} gateway_stages=${gatewayTxs} gateway_manifests=0`);
}
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
  // Stage 13 (the four vault unpauses through the real Safe and timelock). On the Twin fork the 48 hour wait is one time warp.
  stage("govern", join(rh, "govern-rows.txt"));
  exportVar("TWIN_GOVERN_ROWS", join(rh, "govern-rows.txt"));
  // QA plan v1 D7: one set-unwind-guard round per basket the sheet's GOVERN_UNPAUSE_VAULTS opened, through the real Safe and timelock (one warp each), before the post-govern verify.
  const unpaused = (parseSheetText(readFileSync(sheet, "utf8")).GOVERN_UNPAUSE_VAULTS ?? fail("the merged sheet has no GOVERN_UNPAUSE_VAULTS")).split(",").map((x) => x.trim());
  const guarded = BASKET_KEYS.filter((k) => unpaused.includes(k));
  const guardRows = guarded.map((k) => stage("govern", join(rh, `unwind-guard-${k}.txt`), twinUnwindGuardArgs(k)));
  writeFileSync(join(rh, "unwind-guard-rows.txt"), guardRows.join(""));
  exportVar("TWIN_UNWIND_GUARD_ROWS", join(rh, "unwind-guard-rows.txt"));
  // Issue 1667: verify, govern, verify. The second verify reads the post-govern state (all three vaults unpaused). The Twin run only proves the scripts execute in this
  // order: the 48 hour delay and the Safe signers are proven on 8453 through the real Safe.
  if (env("VERIFY_IN") === "true") {
    stage("verify", join(rh, "verify-labels-post-govern.txt"));
    exportVar("TWIN_VERIFY_LABELS_POST_GOVERN", join(rh, "verify-labels-post-govern.txt"));
  }
  // QA plan v1 B5 (finding T5, issue 1645): one Safe self-administration row on the REAL SafeL2, not only against the fake Safe of govern.test.ts. The matrix raises
  // the threshold to the owner count (so the next Safe transaction needs every owner's signature), then restores the sheet's threshold: that transaction carries all
  // three signatures and runs while the sheet is stale (the self-administration exemption of B4), and the run manifest holds two records (two calldata, two Safe nonces).
  // The restore is what keeps the rest of the run honest: the verifier's Safe threshold label and every later row (register-submitter, apply-receipt) compare the live
  // roster with the sheet, and the sheet parser refuses a threshold equal to the owner count, so the sheet cannot be rewritten to the raised value instead (runbook section 9).
  // The owner count and the threshold come from the merged sheet, the one the CLI reads: nothing here is hard-coded.
  const merged = parseSheetText(readFileSync(sheet, "utf8"));
  const safeOwners = (merged.SAFE_OWNERS ?? fail("the merged sheet has no SAFE_OWNERS")).split(",").map((x) => x.trim()).filter(Boolean);
  const sheetThreshold = merged.SAFE_THRESHOLD ?? fail("the merged sheet has no SAFE_THRESHOLD");
  if (!(Number(sheetThreshold) < safeOwners.length)) fail(`the sheet threshold ${sheetThreshold} is not below the owner count ${safeOwners.length}: the self-administration pair has nothing to raise`);
  const selfAdmin = (threshold: string, stdoutTo: string) => stage("govern", stdoutTo, ["--row", SELF_ADMIN_MATRIX_ROW, "--admin-arg", `threshold=${threshold}`]);
  const raised = selfAdmin(String(safeOwners.length), join(rh, "self-admin-raise.txt"));
  const restored = selfAdmin(sheetThreshold, join(rh, "self-admin-restore.txt"));
  writeFileSync(join(rh, "self-admin-rows.txt"), raised + restored);
  exportVar("TWIN_SELF_ADMIN_ROWS", join(rh, "self-admin-rows.txt"));
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
  // A REAL receipt envelope (issue 1754): the production swarm receipt of session 5015526d-27f6-478a-86e9-ac768e310af1, as the canonical route serves it (session, subject, stances, judge and
  // analyst signatures). Its signed weights give the agent_tokens bucket 575 bps. rmAGENT is retired (ADR-0017), so the Safe cannot apply a vector that weights it: the Twin applies the same
  // envelope with the three-vault launch weights (agent 0, conservative 9500, protocol 500, rwa 0). The Twin never verifies the analyst signatures; the receipt contract stores the digest and the
  // apply row reads the weights. Digest and id come from the shared protocol functions (receipt-digest.ts), never from a plain keccak256 of the file.
  const payload = join(rh, "receipt-payload.json");
  const real = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "tests", "fixtures", "real-consensus-receipt.canonical.json"), "utf8")) as Record<string, unknown>;
  // The canonical form is one compact JSON object followed by exactly one newline (receipt-digest.ts).
  const body = Buffer.from(`${JSON.stringify({
    ...real,
    weights: [{ bucket: "agent_tokens", weight_bps: 0 }, { bucket: "conservative_defi_yield", weight_bps: 9500 }, { bucket: "protocol_tokens", weight_bps: 500 }, { bucket: "real_world_assets", weight_bps: 0 }],
  })}\n`);
  writeFileSync(payload, body);
  const digest = receiptPayloadDigest(new Uint8Array(body));
  const receiptId = receiptIdOfBytes(new Uint8Array(body)) ?? fail("the receipt fixture has no session_id and subject_id");
  const uri = `https://twin.invalid/receipts/${receiptId}.json`;
  stage("govern", join(rh, "register-submitter-rows.txt"), ["--row", "register-submitter", "--submitter", submitter]);
  // --signer is the DEPLOYER (it pays the gas); two of the submitter Safe's owners sign (their keystores sit beside the DEPLOYER keystore).
  stage("record-receipt", join(rh, "record-receipt.txt"), ["--receipt-id", receiptId, "--payload-digest", digest, "--payload", payload, "--payload-uri", uri, "--submitter", submitter]);
  stage("govern", join(rh, "apply-receipt-rows.txt"), ["--row", "apply-receipt", "--receipt-id", receiptId, "--payload", payload]);
  // Issue 1892: the receipt path marker. Sibling issue 1888 (receipt stage, submitter grant through the timelock, direct receipt record) owns the rows above and keeps this line
  // after its own apply step: the workflow requires it, so a run that drops the receipt path fails.
  console.log(`${MARKERS.receiptPath} receipt_id=${receiptId} submitter=${submitter}`);
  exportVar("TWIN_RECEIPT_ID", receiptId);
  exportVar("TWIN_RECEIPT_SUBMITTER", submitter);
  exportVar("TWIN_SUBMITTER_SAFE_JSON", submitterSafeJson);
  if (env("VERIFY_IN") === "true") {
    stage("verify", join(rh, "verify-labels-post-apply.txt"));
    exportVar("TWIN_VERIFY_LABELS_POST_APPLY", join(rh, "verify-labels-post-apply.txt"));
  }
  // The run manifest's receipt path (registration, recorded receipt, application) read back from the chain with the rehearsal evidence checker.
  run([bun, env("TWIN_EVIDENCE_CHECK", "src/evidence-check.ts"), "--receipt-applications", join(rh, "evidence", "publish-run.json"), "--deployment-kind", "rehearsal", "--consensus-receipt", field("receipt", "consensus_receipt"),
    "--governance", field("governance", "governance"), "--timelock", field("timelock", "timelock"), "--rpc", rpc], { cwd: pc });
}

// ---- the gateway system run (issue 1892), GATEWAY_IN=true: after the whole vaults run, against its manifests, with its own sheet, evidence directory and run manifest ----
// The gateway run goes LAST: its forge scripts rebuild out/, and the vaults verifier compares the deployed libraries with the build artifacts in out/. Every vaults verify
// (publish, post-govern, post-apply) has run by now, and the gateway run proves the vaults manifests unchanged by hash.
if (env("GATEWAY_IN") === "true") {
  const manifestDir = join(rh, "manifests");
  const vaultsSheet = parseSheetText(readFileSync(sheet, "utf8"));
  const need = (k: string): string => vaultsSheet[k] ?? fail(`the merged sheet has no ${k}`);
  const timelockAddr = (JSON.parse(readFileSync(join(manifestDir, "timelock.json"), "utf8")) as Record<string, string>).timelock ?? fail("timelock.json has no timelock");
  const consumed = ["libs"].map((n) => join(manifestDir, `${n}.json`));
  const hashes = () => consumed.map((f) => createHash("sha256").update(readFileSync(f)).digest("hex"));
  const before = hashes();
  const gsheet = (extra: string[], name: string): string => {
    const p = join(rh, name);
    writeFileSync(p, [`CHAIN_ID=${TWIN_CHAIN_ID}`, `EXPECTED_CHAIN_ID=${TWIN_CHAIN_ID}`, `ADMIN_ADDRESS=${need("ADMIN_ADDRESS")}`, `PAUSER_ADDRESS=${need("PAUSER_ADDRESS")}`,
      `SHARE_RECEIVER_ADDRESS=${need("SHARE_RECEIVER_ADDRESS")}`, `UPGRADE_MODE=${need("UPGRADE_MODE")}`, ...(vaultsSheet.DEPLOYMENT_KIND ? [`DEPLOYMENT_KIND=${vaultsSheet.DEPLOYMENT_KIND}`] : []), ...extra].join("\n") + "\n");
    return p;
  };
  // The Twin's explicit choice: the run's own timelock is both the gateway admin and the gateway upgrade timelock, named explicitly, so the Twin's governed unpauses and role grants keep working. Production chooses its own (architecture 10, open).
  const good = [`GATEWAY_ADMIN_ADDRESS=${timelockAddr}`, `GATEWAY_UPGRADE_TIMELOCK=${timelockAddr}`];
  const gargs = (sheetPath: string, verb: string, evidence: string) => [bun, cli, verb, "--system", "gateway", "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheetPath,
    "--signer", `keystore:${join(rh, "keys", "DEPLOYER")}:${pass}`, "--environment", "stage", "--core-sha", sha, "--counts-dir", join(rh, "counts"), "--evidence", evidence];
  const gEnv = { PUBLISH_MANIFEST_DIR: manifestDir, YES: "1" };
  // Negative scenarios: each must be refused BEFORE any broadcast (deployer nonce unmoved, no gateway manifest).
  const nonce0 = run([castBin, "nonce", admin, "--rpc-url", rpc]).trim();
  const refused: string[] = [];
  const negatives: [string, string[]][] = [
    ["missing-upgrade-timelock", [good[0]!]],
    ["zero-upgrade-timelock", [good[0]!, "GATEWAY_UPGRADE_TIMELOCK=0x0000000000000000000000000000000000000000"]],
    ["agent-input", [...good, `AGENT_ADDRESSES=${admin}`]],
  ];
  for (const [name, lines] of negatives) {
    const r = Bun.spawnSync(gargs(gsheet(lines, `gateway-neg-${name}.env`), "publish", join(rh, `gateway-neg-${name}`)), { cwd: pc, env: { ...process.env, ...gEnv }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode === 0) fail(`gateway negative scenario ${name} was accepted`);
    const now = run([castBin, "nonce", admin, "--rpc-url", rpc]).trim();
    if (now !== nonce0 || GATEWAY_FILES.some((f) => existsSync(join(manifestDir, f)))) fail(`gateway negative scenario ${name} broadcast something (nonce ${nonce0} -> ${now})`);
    refused.push(name);
  }
  console.log(`${MARKERS.gatewayRefusals} scenarios=${refused.join(",")} broadcasts=0`);
  const gs = gsheet(good, "gateway-sheet.env");
  const gev = join(rh, "gateway-evidence");
  run(gargs(gs, "publish", gev), { cwd: pc, childEnv: gEnv });
  run(gargs(gs, "verify", gev), { cwd: pc, childEnv: gEnv, stdoutTo: join(rh, "verify-labels-gateway.txt") });
  exportVar("TWIN_VERIFY_LABELS_GATEWAY", join(rh, "verify-labels-gateway.txt"));
  if (JSON.stringify(before) !== JSON.stringify(hashes())) fail("the gateway run changed a vaults manifest");
  const gw = (JSON.parse(readFileSync(join(manifestDir, "gateway-handover.json"), "utf8")) as { gateway_admin?: string; roles?: Record<string, boolean> });
  const roles = gw.roles ?? {};
  if (!roles.admin_holder_has_admin_role || !roles.admin_holder_has_default_admin_role || roles.deployer_has_admin_role || roles.deployer_has_default_admin_role) fail("the gateway handover manifest does not show the roles moved to GATEWAY_ADMIN_ADDRESS");
  const labels = readFileSync(join(rh, "verify-labels-gateway.txt"), "utf8");
  for (const l of REQUIRED_GATEWAY_LABELS) if (!labels.includes(l)) fail(`the gateway verifier did not print '${l}'`);
  console.log(`${MARKERS.gatewayRun} vaults_manifests_unchanged=true agents_at_handover=0 admin=${gw.gateway_admin}`);
  exportVar("TWIN_GATEWAY_EVIDENCE_DIR", gev);
}
