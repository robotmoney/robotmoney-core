// Deploy 4: the fund system's Twin step script (publish-contracts/src/ci/twin-publish-fund.ts) run with stub tools, in the style of twin-publish-script.test.ts. The stub CLI
// plays publish (it writes the measured counts file, the run manifest and the fund and queue manifests) and verify (labels); the stub feed tool plays the feed check and
// the stale-feed probe; the counts tool is the real rehearsal-counts.ts, so counts.json is built and checked against the fund system's stage keys for real.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./fixtures.ts";
import { REPO_ROOT } from "./repo-root.ts";
import { overlaySheet } from "../src/ci/twin-publish-fund.ts";
import { FUND_RUN_MARKERS, VAULTS_RUN_MARKERS, markerProblems } from "../src/ci/twin-markers.ts";
import { parseSheet, parseSheetText } from "../src/sheet.ts";

/** The fund system's deployer stage counts (the shape of evidence-fund.test.ts), plus one vaults key the publish's counts file may also hold: counts.json must drop it. */
const FUND_COUNTS: Record<string, number> = { safe: 1, "fund-libs": 14, "fund-receipt": 2, fund: 18, rebalancer: 7, "fund-governance": 2, queue: 2, "fund-wiring": 3, "fund-timelock": 15 };
const fundSum = Object.values(FUND_COUNTS).reduce((a, b) => a + b, 0);
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function stubs(): Record<string, string> {
  const dir = tmp("fund-stub-bin-");
  const f = (n: string, body: string, mode = 0o644) => { const p = join(dir, n); writeFileSync(p, body); chmodSync(p, mode); return p; };
  return {
    TWIN_CLI: f("cli.js", `
      const fs = require("node:fs"), path = require("node:path");
      const a = process.argv.slice(2), verb = a[0], v = (k) => a[a.indexOf(k) + 1];
      fs.appendFileSync(process.env.STUB_LOG, "cli " + verb + " system=" + (a.includes("--system") ? v("--system") : "none") + " chain=" + v("--chain") + "\\n");
      if (process.env.STUB_FAIL === verb) { console.error("stub: " + verb + " failed"); process.exit(3); }
      if (verb === "publish") {
        fs.copyFileSync(v("--sheet"), process.env.STUB_SHEET_COPY);
        fs.writeFileSync(v("--counts-dir") + "/" + v("--core-sha") + ".json", JSON.stringify({ deploySha: v("--core-sha"), measured: { chainId: 918453, at: "now" }, counts: { ...JSON.parse(process.env.STUB_COUNTS), vault: 18 } }));
        fs.mkdirSync(v("--evidence"), { recursive: true });
        fs.writeFileSync(path.join(v("--evidence"), "publish-run.json"), JSON.stringify({ stages: Object.fromEntries(Object.keys(JSON.parse(process.env.STUB_COUNTS)).map((k) => [k, { status: "done" }])) }));
        const m = process.env.PUBLISH_MANIFEST_DIR;
        fs.writeFileSync(path.join(m, "fund.json"), JSON.stringify({ fund: "${A(0xf1)}" }));
        fs.writeFileSync(path.join(m, "queue.json"), JSON.stringify({ queue: "${A(0xf2)}" }));
      }
      if (verb === "verify") console.log("[verify]\\nfund: seeded\\nqueue: flow parameters equal the sheet\\ntimelock: the only upgrade authority");`),
    TWIN_REHEARSAL_CLI: f("rehearsal.js", `
      const fs = require("node:fs"), a = process.argv.slice(2);
      fs.appendFileSync(process.env.STUB_LOG, "rehearsal " + a[0] + "\\n");
      if (a[0] === "keys") {
        const keeper = a[a.indexOf("--dir") + 1].endsWith("keeper-keys");
        console.log("CHAIN_ID=918453\\nADMIN_ADDRESS=" + (keeper ? "${A(0xee)}" : "${A(0xaa)}") + "\\nRECEIPT_ADMIN_ADDRESS=" + (keeper ? "${A(0xee)}" : "${A(0xaa)}") + "\\nPAUSER_ADDRESS=${A(0xbb)}\\nEMERGENCY_ADDRESS=${A(0xcc)}\\nSAFE_OWNERS=${A(0xa1)},${A(0xa2)},${A(0xa3)}\\nSAFE_THRESHOLD=2");
      }`),
    TWIN_FEEDS: f("feeds.js", `
      const fs = require("node:fs"), a = process.argv.slice(2), v = (k) => a[a.indexOf(k) + 1];
      fs.appendFileSync(process.env.STUB_LOG, "feeds " + a[0] + (a[0] === "probe" ? " fund=" + v("--fund") + " queue=" + v("--queue") + " usdc=" + v("--usdc") : a[0] === "refresh" ? " journal=" + (a.includes("--journal") ? "yes" : "no") : " min=" + v("--min-margin")) + "\\n");
      if (process.env.STUB_FAIL === "feeds-" + a[0]) { console.error("stub: feeds " + a[0] + " failed"); process.exit(1); }
      if (a[0] === "check") fs.writeFileSync(v("--out"), JSON.stringify({ windows: [{ name: "ETH/USD", fresh: true, marginSec: 900 }, { name: "cbBTC/USD", fresh: true, marginSec: 80000 }, { name: "USDC/USD", fresh: true, marginSec: 70000 }] }));
      else if (a[0] === "refresh") fs.writeFileSync(v("--out"), JSON.stringify({ pinBlock: 7, problems: [], feeds: ["ETH/USD", "cbBTC/USD", "USDC/USD"].map((name, i) => ({ name, pin: { answer: String(100 + i) }, after: { answer: process.env.STUB_REFRESH_ANSWER || String(100 + i), aggregatorRound: 10 + i } })) }));
      else fs.writeFileSync(v("--out"), JSON.stringify({ ethIndex: 2, fresh: { result: "ok" }, stale: { warpedSec: 600 }, problems: [] }));`),
    // cast: `nonce` answers the next value of STUB_NONCES (a comma list kept in a state file), `rpc` and `send` are logged.
    CAST: f("cast", `#!/usr/bin/env bash
echo "cast $1 $2" >> "$STUB_LOG"
if [ "$1" = call ]; then echo "$STUB_TOTAL_ASSETS"; fi
if [ "$1" = nonce ]; then n=$(cat "$STUB_NONCE_STATE" 2>/dev/null || echo 0); echo "$STUB_NONCES" | cut -d, -f$((n + 1)); echo $((n + 1)) > "$STUB_NONCE_STATE"; fi
`, 0o755),
  };
}

function runScript(env: Record<string, string> = {}) {
  const work = tmp("tpf-");
  const log = join(work, "log"), ghEnv = join(work, "env");
  writeFileSync(log, ""); writeFileSync(ghEnv, "");
  const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, "publish-contracts/src/ci/twin-publish-fund.ts")], {
    env: { ...process.env, ...stubs(), STUB_LOG: log, STUB_COUNTS: JSON.stringify(FUND_COUNTS), STUB_NONCES: String(fundSum + 1), STUB_NONCE_STATE: join(work, "nonce-state"), STUB_FAIL: "", STUB_TOTAL_ASSETS: "1000000 [1e6]",
      STUB_SHEET_COPY: join(work, "sheet.env"), GITHUB_WORKSPACE: REPO_ROOT, GITHUB_ENV: ghEnv, RPC_URL: "http://127.0.0.1:1", TWIN_RUN_PARENT: work, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const exported = Object.fromEntries(readFileSync(ghEnv, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), all: lines, cli: lines.filter((l) => l.startsWith("cli ")).map((l) => l.slice(4)), exported, sheetCopy: join(work, "sheet.env") };
}

describe("twin-publish-fund step script", () => {
  test("a green run publishes and verifies the FUND system on 918453, writes a fund counts.json that passes the check, the fund markers and the record", () => {
    const r = runScript();
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.cli).toEqual(["publish system=fund chain=918453", "verify system=fund chain=918453"]);
    const counts = JSON.parse(readFileSync(r.exported.TWIN_COUNTS_JSON!, "utf8"));
    expect(counts.system).toBe("fund");
    expect(counts.counts).toEqual(FUND_COUNTS); // the vaults key the counts file also held is not a fund count
    expect(counts.deployerNonce).toBe(fundSum + 1); // the fund stages plus the prove-control transaction
    expect(counts.deployerStartNonce).toBeUndefined();
    expect(markerProblems(r.out, FUND_RUN_MARKERS)).toEqual([]);
    expect(markerProblems(r.out, VAULTS_RUN_MARKERS)).toHaveLength(VAULTS_RUN_MARKERS.length); // a fund run never passes as a vaults run
    const rec = JSON.parse(readFileSync(r.exported.TWIN_QA_RECORD!, "utf8"));
    expect(rec).toMatchObject({ kind: "twin-qa-run", system: "fund", chainId: 918453, conclusion: "success", verifyLabels: 3, counts: FUND_COUNTS });
    expect(rec.deploySha).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.markers).toHaveLength(FUND_RUN_MARKERS.length);
    expect(r.exported.TWIN_RUN_DIR).toContain("/twin-publish-fund.");
    expect(existsSync(r.exported.TWIN_VERIFY_LABELS_FUND!)).toBe(true);
  });
  test("the run's sheet is the committed fund sheet with the Twin keys, the Twin chain ids and a throwaway keeper over it, and the fund parser accepts it", () => {
    const r = runScript();
    expect(r.code).toBe(0);
    const text = readFileSync(r.sheetCopy, "utf8");
    const committed = readFileSync(join(REPO_ROOT, "deployments/base-8453-rehearsal/deploy-4.env"), "utf8");
    expect(() => parseSheet(text, { system: "fund" })).not.toThrow();
    const s = parseSheetText(text);
    expect(s.CHAIN_ID).toBe("918453");
    expect(s.EXPECTED_CHAIN_ID).toBe("918453");
    expect(s.ADMIN_ADDRESS).toBe(A(0xaa));
    expect(s.KEEPER_ADDRESS).toBe(A(0xee)); // the deployer of the second throwaway set, never a key of the first
    expect(s.SAFE_OWNERS).toBe([A(0xa1), A(0xa2), A(0xa3)].join(","));
    for (const n of ["FUND_TVL_CAP", "FLOW_MIN_REQUEST_USDC", "TIMELOCK_MIN_DELAY", "DEPLOYMENT_KIND", "PLAN_DURATION"]) expect(new RegExp(`^${n}=(.*)$`, "m").exec(text)![1]).toBe(new RegExp(`^${n}=(.*)$`, "m").exec(committed)![1]!);
    expect(text.match(/^CHAIN_ID=/gm)).toHaveLength(1);
    expect(text.match(/^KEEPER_ADDRESS=/gm)).toHaveLength(1);
  });
  test("the keeper gets gas, every throwaway key gets gas and the deployer USDC, all before the feed check and the publish", () => {
    const r = runScript();
    const i = (l: string) => r.all.indexOf(l);
    expect(i("rehearsal fund-gas")).toBeGreaterThan(-1);
    expect(i("cast rpc anvil_setBalance")).toBeGreaterThan(i("rehearsal fund-usdc"));
    expect(i("feeds check min=300")).toBeGreaterThan(i("cast rpc anvil_setBalance"));
    expect(i("cli publish system=fund chain=918453")).toBeGreaterThan(i("feeds check min=300"));
    expect(i(`feeds probe fund=${A(0xf1)} queue=${A(0xf2)} usdc=1000000`)).toBeGreaterThan(i("cli verify system=fund chain=918453"));
  });
  test("a feed that would go stale before the publish stops the run before anything is sent, with no record", () => {
    const r = runScript({ STUB_FAIL: "feeds-check" });
    expect(r.code).not.toBe(0);
    expect(r.cli).toEqual([]);
    expect(r.exported.TWIN_QA_RECORD).toBeUndefined();
  });
  for (const [fail, cli] of [["publish", ["publish system=fund chain=918453"]], ["verify", ["publish system=fund chain=918453", "verify system=fund chain=918453"]]] as const) {
    test(`a failing ${fail} exits non-zero, runs nothing after it and writes no record`, () => {
      const r = runScript({ STUB_FAIL: fail });
      expect(r.code).not.toBe(0);
      expect(r.cli).toEqual([...cli]);
      expect(r.all.some((l) => l.startsWith("feeds probe"))).toBe(false);
      expect(r.exported.TWIN_QA_RECORD).toBeUndefined();
    });
  }
  test("a stale-feed probe that does not see the named refusal fails the run and writes no record", () => {
    const r = runScript({ STUB_FAIL: "feeds-probe" });
    expect(r.code).not.toBe(0);
    expect(r.exported.TWIN_QA_RECORD).toBeUndefined();
    expect(r.out).not.toContain("fund-feed-stale-refusal");
  });
  test("after the probe the Twin feed step restates the pin answers, with a journal, and the fund reads again before the record", () => {
    const r = runScript();
    expect(r.code).toBe(0);
    const i = (l: string) => r.all.findIndex((x) => x.startsWith(l));
    expect(i("feeds refresh journal=yes")).toBeGreaterThan(i("feeds probe"));
    expect(i("cast call")).toBeGreaterThan(i("feeds refresh"));
    expect(r.out).toContain("fund-feed-refresh: feeds=3 pin_block=7");
    expect(r.out).toContain("total_assets=1000000");
    expect(JSON.parse(readFileSync(r.exported.TWIN_QA_RECORD!, "utf8")).feedRefresh).toBe(r.exported.TWIN_FEED_REFRESH_JSON);
  });
  test("a refresh that writes any answer but the pin's fails the run and writes no record", () => {
    const r = runScript({ STUB_REFRESH_ANSWER: "999" });
    expect(r.code).not.toBe(0);
    expect(r.exported.TWIN_QA_RECORD).toBeUndefined();
  });
  test("a fund that still refuses after the refresh fails the run and writes no record", () => {
    const r = runScript({ STUB_TOTAL_ASSETS: "" });
    expect(r.code).not.toBe(0);
    expect(r.exported.TWIN_QA_RECORD).toBeUndefined();
  });
  test("a nonce that is not the fund counts plus the prove-control transaction fails the counts check", () => {
    const r = runScript({ STUB_NONCES: String(fundSum + 2) });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("deployerNonce");
    expect(r.cli).toEqual(["publish system=fund chain=918453"]);
  });
  test("REHEARSAL_IN=true: the deployer is not fresh (one self-transfer before the publish) and counts.json records the start nonce", () => {
    const r = runScript({ REHEARSAL_IN: "true", STUB_NONCES: `1,${fundSum + 2}` });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.all.indexOf("cast send " + A(0xaa))).toBeLessThan(r.all.indexOf("cli publish system=fund chain=918453"));
    const counts = JSON.parse(readFileSync(r.exported.TWIN_COUNTS_JSON!, "utf8"));
    expect(counts.deployerStartNonce).toBe(1);
    expect(JSON.parse(readFileSync(r.exported.TWIN_QA_RECORD!, "utf8")).deployer.fresh).toBe(false);
  });
  test("a FEED_MIN_MARGIN_IN that is no whole number is refused before anything runs", () => {
    const r = runScript({ FEED_MIN_MARGIN_IN: "5m" });
    expect(r.code).not.toBe(0);
    expect(r.all).toEqual([]);
  });
});

describe("overlaySheet", () => {
  test("replaces a name in place, appends a name the base lacks, keeps comments and the other lines", () => {
    expect(overlaySheet("# head\nCHAIN_ID=8453\nX=1\nKEEPER_ADDRESS=\n", "CHAIN_ID=918453\nKEEPER_ADDRESS=0x1\nNEW=2\n")).toBe("# head\nCHAIN_ID=918453\nX=1\nKEEPER_ADDRESS=0x1\nNEW=2\n");
  });
});
