#!/usr/bin/env bun
// The fund system's Twin run (Deploy 4): the one deploy driver, `publish --system fund` then `verify --system fund`, on a Twin chain (918453) a caller started at a fresh
// pin, with throwaway keys. It is twin-publish.ts for the third system and leaves the vaults and gateway runs to that script, unchanged. Two clean runs of it at one sha
// on the stage host are the fund's Twin pair (docs/runbooks/contract-qa/README.md, "The fund flow").
// Environment in: RPC_URL, GITHUB_WORKSPACE (the core checkout at the sha), GITHUB_ENV (optional: the exports below are appended there), and optional:
//   FUND_SHEET_IN       the committed fund sheet, relative to the checkout (default deployments/base-8453-rehearsal/deploy-4.env, the Deploy 4 sheet, whole)
//   REHEARSAL_IN=true   the deployer is not fresh (one self-transfer first), as the Deploy 3 key that publishes Deploy 4 on 8453 is not; counts.json records the start nonce
//   PIN_BLOCK_IN        the Base block the fork is pinned at, recorded in counts.json
//   FEED_MIN_MARGIN_IN  the seconds every feed must stay fresh when the publish starts (default 300; see "The feeds" below)
//   TWIN_RUN_PARENT     where the run directory is made (default /tmp: foundry.toml fs_permissions lets the deploy scripts write manifests only under /tmp or ./deployments)
// The sheet: the committed fund sheet with the Twin's lines over it, as P0.68 of releases/v0.7.0-onevault.yaml does: the throwaway keys' fragment (CHAIN_ID 918453, the
// roles, the three Safe owners and threshold), EXPECTED_CHAIN_ID=918453 and KEEPER_ADDRESS, the deployer of a second throwaway set. Each replaces the same name; every other
// line stays the committed one. Twin environment steps only: gas for every key and the keeper, USDC for the seed.
// The feeds: the fund's assets and its queue read the real Chainlink feeds, and a pinned fork serves each feed's round at the pin for as long as it runs (twin-feeds.ts).
// Before the publish, every feed must stay fresh for FEED_MIN_MARGIN_IN more seconds (the fund stage's addAsset refuses a stale feed). After the verify, the probe shows
// the fund's own refusal once ETH / USD is past its stale point: totalAssets() reverts FeedUnhealthy(WETH, Stale) and quoteDeposit SettleBlocked(Feed, WETH, Stale).
// Then the Twin feed step (twin-feeds.ts refresh, owner decision 2026-11-13): each basket and peg feed gets one new round that restates the answer it reported at the
// pin, at the fork's clock, written to the real aggregator's storage and journaled; totalAssets() must read again. No mock is etched, no pool, token, fund or queue
// slot is written. The queue's timed rows run after this script, from the release runbook (releases/v0.7.0-onevault.yaml, P6.80 to P6.85 refresh before them).
// The record: counts.json names `system: "fund"` (rehearsal-counts build --system fund), the markers are the fund's own (twin-markers.ts FUND_RUN_MARKERS), and the last
// step writes twin-qa-fund.json { kind: "twin-qa-run", system: "fund", deploySha, ..., conclusion: "success" }, which a failed run never reaches.
// Exports: TWIN_RUN_DIR, TWIN_MANIFEST_DIR, TWIN_DEPLOYER_ADDRESS, TWIN_COUNTS_JSON, TWIN_VERIFY_LABELS_FUND, TWIN_FEEDS_JSON, TWIN_FEED_PROBE_JSON, TWIN_FEED_REFRESH_JSON,
// TWIN_QA_RECORD.
// Tests replace the tools: TWIN_CLI (src/cli.ts), TWIN_REHEARSAL_CLI (src/rehearsal/cli.ts), TWIN_FEEDS (src/ci/twin-feeds.ts), TWIN_COUNTS (src/ci/rehearsal-counts.ts), CAST.
// Any tool that exits non-zero fails this script. Never use this against Base mainnet: every verb gets --chain 918453 and the CLI refuses YES=1 on 8453.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKERS } from "./twin-markers.ts";
import { TWIN_CHAIN_ID } from "../chains.ts";

const env = (k: string, d = ""): string => process.env[k] || d;
const fail = (m: string): never => { console.error(`twin-publish-fund: ${m}`); process.exit(1); };

function run(cmd: string[], opts: { cwd?: string; stdoutTo?: string; childEnv?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.childEnv }, stdout: "pipe", stderr: "inherit" });
  const out = r.stdout.toString();
  if (opts.stdoutTo) writeFileSync(opts.stdoutTo, out); else process.stdout.write(out);
  if (r.exitCode !== 0) fail(`${cmd.slice(0, 3).join(" ")} exited ${r.exitCode}`);
  return out;
}

/** PURE. The P0.68 overlay: each NAME=value line of `over` replaces the same name in `base` (in place), names `base` lacks are appended. Comments and blank lines stay. */
export function overlaySheet(base: string, over: string): string {
  const o = new Map<string, string>();
  for (const l of over.split("\n")) { const m = /^([A-Z][A-Z0-9_]*)=/.exec(l.trim()); if (m) o.set(m[1]!, l.trim()); }
  const out: string[] = [];
  for (const l of base.replace(/\n$/, "").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(l);
    if (m && o.has(m[1]!)) { out.push(o.get(m[1]!)!); o.delete(m[1]!); } else out.push(l);
  }
  return [...out, ...o.values()].join("\n") + "\n";
}
const lineOf = (text: string, name: string): string => [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].pop()?.[1]?.replace(/#.*$/, "").trim() ?? "";

if (import.meta.main) {
  const core = env("GITHUB_WORKSPACE") || fail("GITHUB_WORKSPACE is not set");
  const rpc = env("RPC_URL") || fail("RPC_URL is not set");
  const ghEnv = env("GITHUB_ENV");
  const exportVar = (k: string, v: string) => { if (ghEnv) appendFileSync(ghEnv, `${k}=${v}\n`); };
  const sha = run(["git", "-C", core, "rev-parse", "HEAD"], { stdoutTo: "/dev/null" }).trim();
  const pc = join(core, "publish-contracts");
  const bun = process.execPath;
  const cli = env("TWIN_CLI", "src/cli.ts");
  const rehearsal = env("TWIN_REHEARSAL_CLI", "src/rehearsal/cli.ts");
  const feeds = env("TWIN_FEEDS", "src/ci/twin-feeds.ts");
  const countsTool = env("TWIN_COUNTS", "src/ci/rehearsal-counts.ts");
  const castBin = env("CAST", "cast");
  const minMargin = env("FEED_MIN_MARGIN_IN", "300");
  if (!/^\d+$/.test(minMargin)) fail(`FEED_MIN_MARGIN_IN is a whole number of seconds, got '${minMargin}'`);
  const rehearsalMode = env("REHEARSAL_IN") === "true";
  const markers: string[] = [];
  const marker = (line: string) => { markers.push(line); console.log(line); };

  const rh = mkdtempSync(join(env("TWIN_RUN_PARENT", "/tmp"), "twin-publish-fund."));
  mkdirSync(join(rh, "manifests")); mkdirSync(join(rh, "counts"));
  // A random passphrase in a 0600 file. It is never an argument or an exported variable.
  const pass = join(rh, "passphrase");
  writeFileSync(pass, Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex"), { mode: 0o600 });
  exportVar("TWIN_RUN_DIR", rh);
  exportVar("TWIN_MANIFEST_DIR", join(rh, "manifests"));

  // ---- keys and the sheet (P0.66, P0.67, P0.68) ----
  const fragment = run([bun, rehearsal, "keys", "--dir", join(rh, "keys"), "--password-file", pass, "--chain-id", String(TWIN_CHAIN_ID)], { cwd: pc, stdoutTo: join(rh, "fragment.env") });
  const keeperFragment = run([bun, rehearsal, "keys", "--dir", join(rh, "keeper-keys"), "--password-file", pass, "--chain-id", String(TWIN_CHAIN_ID)], { cwd: pc, stdoutTo: join(rh, "keeper-fragment.env") });
  const keeper = lineOf(keeperFragment, "ADMIN_ADDRESS") || fail("the keeper key fragment has no ADMIN_ADDRESS");
  const admin = lineOf(fragment, "ADMIN_ADDRESS") || fail("the key fragment has no ADMIN_ADDRESS");
  const over = `${fragment.replace(/\n?$/, "\n")}EXPECTED_CHAIN_ID=${TWIN_CHAIN_ID}\nKEEPER_ADDRESS=${keeper}\n`;
  const committed = join(core, env("FUND_SHEET_IN", "deployments/base-8453-rehearsal/deploy-4.env"));
  if (!existsSync(committed)) fail(`the fund sheet ${committed} does not exist`);
  const sheet = join(rh, "sheet.env");
  writeFileSync(sheet, overlaySheet(readFileSync(committed, "utf8"), over));
  const merged = readFileSync(sheet, "utf8");
  if (lineOf(merged, "CHAIN_ID") !== String(TWIN_CHAIN_ID) || lineOf(merged, "EXPECTED_CHAIN_ID") !== String(TWIN_CHAIN_ID)) fail(`the merged fund sheet is not for the Twin chain ${TWIN_CHAIN_ID}`);
  if (!lineOf(merged, "FUND_TVL_CAP")) fail("the merged sheet has no FUND_TVL_CAP: it is not a fund sheet");
  exportVar("TWIN_DEPLOYER_ADDRESS", admin);

  // ---- Twin environment steps (P0.71): gas for every key and the keeper, USDC for the seed ----
  run([bun, rehearsal, "fund-gas", "--rpc", rpc, "--sheet", sheet], { cwd: pc });
  run([bun, rehearsal, "fund-usdc", "--rpc", rpc, "--sheet", sheet, "--usdc-units", "2000000000"], { cwd: pc });
  run([castBin, "rpc", "anvil_setBalance", keeper, "0x8ac7230489e80000", "--rpc-url", rpc], { stdoutTo: join(rh, "keeper-gas.txt") });

  // ---- the feeds before the publish ----
  const feedsJson = join(rh, "feeds-before-publish.json");
  run([bun, feeds, "check", "--rpc", rpc, "--min-margin", minMargin, "--out", feedsJson], { cwd: pc });
  const check = JSON.parse(readFileSync(feedsJson, "utf8")) as { windows: { name: string; fresh: boolean; marginSec: number }[] };
  const eth = check.windows.find((w) => w.name === "ETH/USD") ?? fail("the feed check names no ETH/USD window");
  marker(`${MARKERS.fundFeeds} feeds=${check.windows.length} fresh=${check.windows.filter((w) => w.fresh).length} eth_margin_s=${eth.marginSec} min_margin_s=${minMargin}${env("PIN_BLOCK_IN") ? ` pin_block=${env("PIN_BLOCK_IN")}` : ""}`);
  exportVar("TWIN_FEEDS_JSON", feedsJson);

  // ---- publish and verify, the fund system ----
  const stage = (verb: string, stdoutTo?: string) => run([bun, cli, verb, "--system", "fund", "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet,
    "--signer", `keystore:${join(rh, "keys", "DEPLOYER")}:${pass}`, "--environment", "stage", "--core-sha", sha,
    "--counts-dir", join(rh, "counts"), "--evidence", join(rh, "evidence")], { cwd: pc, stdoutTo, childEnv: { PUBLISH_MANIFEST_DIR: join(rh, "manifests"), YES: "1" } });
  if (rehearsalMode) run([castBin, "send", admin, "--value", "0", "--keystore", join(rh, "keys/DEPLOYER"), "--password-file", pass, "--rpc-url", rpc], { stdoutTo: join(rh, "self-transfer.txt") });
  const startNonce = rehearsalMode ? run([castBin, "nonce", admin, "--rpc-url", rpc], { stdoutTo: join(rh, "start-nonce.txt") }).trim() : "0";
  // No frozen file in the empty counts dir: the Twin publish measures the fund stages' counts and writes <counts-dir>/<sha>.json.
  stage("publish");
  const nonce = run([castBin, "nonce", admin, "--rpc-url", rpc], { stdoutTo: join(rh, "nonce-after-publish.txt") }).trim();
  const countsJson = join(rh, "counts.json");
  run([bun, countsTool, "build", "--system", "fund", "--counts-dir", join(rh, "counts"), "--sha", sha, "--nonce", nonce, "--out", countsJson, "--run-manifest", join(rh, "evidence", "publish-run.json"),
    ...(rehearsalMode ? ["--start-nonce", startNonce] : []), ...(env("PIN_BLOCK_IN") ? ["--pin-block", env("PIN_BLOCK_IN")] : [])], { cwd: pc });
  run([bun, countsTool, "check", "--file", countsJson], { cwd: pc });
  exportVar("TWIN_COUNTS_JSON", countsJson);
  const labelsFile = join(rh, "verify-labels-fund.txt");
  stage("verify", labelsFile);
  exportVar("TWIN_VERIFY_LABELS_FUND", labelsFile);
  const runStages = Object.keys((JSON.parse(readFileSync(join(rh, "evidence", "publish-run.json"), "utf8")) as { stages?: Record<string, unknown> }).stages ?? {});
  const labels = readFileSync(labelsFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("[") && !l.startsWith("#"));
  const counts = (JSON.parse(readFileSync(countsJson, "utf8")) as { counts: Record<string, number>; system?: string });
  if (counts.system !== "fund") fail(`counts.json names system ${JSON.stringify(counts.system ?? null)}, not fund`);
  marker(`${MARKERS.fundRun} system=fund stages=${runStages.length} verify_labels=${labels.length} count_keys=${Object.keys(counts.counts).length} sha=${sha}`);

  // ---- the fund's refusal on the Twin's frozen feeds ----
  const field = (file: string, name: string): string => (JSON.parse(readFileSync(join(rh, "manifests", `${file}.json`), "utf8")) as Record<string, string>)[name] ?? fail(`manifest ${file}.json has no ${name}`);
  const probeJson = join(rh, "feed-probe.json");
  const minRequest = lineOf(merged, "FLOW_MIN_REQUEST_USDC") || fail("the merged sheet has no FLOW_MIN_REQUEST_USDC");
  run([bun, feeds, "probe", "--rpc", rpc, "--fund", field("fund", "fund"), "--queue", field("queue", "queue"), "--usdc", minRequest, "--out", probeJson], { cwd: pc });
  const probe = JSON.parse(readFileSync(probeJson, "utf8")) as { ethIndex: number; fresh: { result: string }; stale: { warpedSec: number } };
  marker(`${MARKERS.fundFeedStaleRefusal} scenarios=totalAssets,quoteDeposit index=${probe.ethIndex} status=Stale warped_s=${probe.stale.warpedSec} fresh_probe=${probe.fresh.result}`);
  exportVar("TWIN_FEED_PROBE_JSON", probeJson);

  // ---- the Twin feed step: restate each feed's pin answer at the fork's clock, then the fund reads again ----
  const refreshJson = join(rh, "feed-refresh.json");
  run([bun, feeds, "refresh", "--rpc", rpc, "--journal", join(rh, "feed-refresh.jsonl"), "--out", refreshJson], { cwd: pc });
  const refresh = JSON.parse(readFileSync(refreshJson, "utf8")) as { pinBlock: number; feeds: { name: string; pin: { answer: string }; after: { answer: string; aggregatorRound: number } }[]; problems: string[] };
  if (refresh.problems.length || refresh.feeds.length !== 3 || refresh.feeds.some((f) => f.after.answer !== f.pin.answer)) fail(`the feed refresh did not restate the three pin answers: ${refreshJson}`);
  const navAfter = run([castBin, "call", field("fund", "fund"), "totalAssets()(uint256)", "--rpc-url", rpc], { stdoutTo: join(rh, "total-assets-after-refresh.txt") }).trim().split(" ")[0] ?? "";
  if (!/^\d+$/.test(navAfter)) fail(`totalAssets() after the feed refresh read '${navAfter}'`);
  marker(`${MARKERS.fundFeedRefresh} feeds=${refresh.feeds.length} pin_block=${refresh.pinBlock} rounds=${refresh.feeds.map((f) => `${f.name}:${f.after.aggregatorRound}`).join(",")} total_assets=${navAfter}`);
  exportVar("TWIN_FEED_REFRESH_JSON", refreshJson);

  // ---- the record: written last, so a failed run has none ----
  const record = join(rh, "twin-qa-fund.json");
  writeFileSync(record, JSON.stringify({
    kind: "twin-qa-run", system: "fund", deploySha: sha, chainId: TWIN_CHAIN_ID, ...(env("PIN_BLOCK_IN") ? { pinBlock: Number(env("PIN_BLOCK_IN")) } : {}),
    deployer: { address: admin, fresh: !rehearsalMode, startNonce: Number(startNonce), nonceAfterPublish: Number(nonce) }, keeper,
    stages: runStages, countsJson, counts: counts.counts, verifyLabels: labels.length, feedsBeforePublish: feedsJson, feedProbe: probeJson, feedRefresh: refreshJson, markers,
    finishedAt: new Date().toISOString(), conclusion: "success",
  }, null, 2) + "\n");
  exportVar("TWIN_QA_RECORD", record);
  console.log(`twin-publish-fund: the fund Twin run passed at ${sha}; record ${record}`);
}
