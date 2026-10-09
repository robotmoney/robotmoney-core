// The twin-publish step script (publish-contracts/src/ci/twin-publish.ts) run with a stub bun and cast (core 1523). The stub plays the CLI:
// it fails the stage named by STUB_FAIL, and on publish it writes the measured counts file like the real Twin chain run does.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COUNTS, tmp } from "./fixtures.ts";
import { REPO_ROOT } from "./repo-root.ts";

const ACTION = join(REPO_ROOT, ".github/actions/twin-publish");
const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);

function stubs(): Record<string, string> {
  const dir = tmp("stub-bin-");
  const f = (n: string, body: string, mode = 0o644) => { const p = join(dir, n); writeFileSync(p, body); chmodSync(p, mode); return p; };
  return {
    TWIN_CLI: f("cli.js", `
      const { appendFileSync, writeFileSync } = require("node:fs");
      const a = process.argv.slice(2), verb = a[0];
      appendFileSync(process.env.STUB_LOG, "cli " + verb + "\\n");
      const n = require("node:fs").readFileSync(process.env.STUB_LOG, "utf8").split("\\n").filter((l) => l === "cli " + verb).length;
      if (process.env.STUB_FAIL === verb || process.env.STUB_FAIL === verb + ":" + n) { console.error("stub: " + verb + " failed"); process.exit(3); }
      if (verb === "publish") {
        const v = (k) => a[a.indexOf(k) + 1];
        writeFileSync(v("--counts-dir") + "/" + v("--core-sha") + ".json", JSON.stringify({ deploySha: v("--core-sha"), measured: { chainId: 918453, at: "now" }, counts: JSON.parse(process.env.STUB_COUNTS) }));
      }`),
    TWIN_REHEARSAL_CLI: f("rehearsal.js", `
      if (process.argv[2] === "keys") console.log("ADMIN_ADDRESS=0x00000000000000000000000000000000000000aa");`),
    TWIN_MERGE_SHEET: f("merge.js", `
      const a = process.argv; require("node:fs").writeFileSync(a[a.indexOf("--out") + 1], "X=1\\n");`),
    CAST: f("cast", `#!/usr/bin/env bash\necho "$STUB_NONCE"\n`, 0o755),
  };
}

function runScript(env: Record<string, string>) {
  const work = tmp("tp-");
  const log = join(work, "log"), ghEnv = join(work, "env");
  writeFileSync(log, ""); writeFileSync(ghEnv, "");
  const r = Bun.spawnSync([process.execPath, join(REPO_ROOT, "publish-contracts/src/ci/twin-publish.ts")], {
    env: { ...process.env, ...stubs(), STUB_LOG: log, STUB_COUNTS: JSON.stringify(COUNTS), STUB_NONCE: String(sum + 1), STUB_FAIL: "",
      GITHUB_WORKSPACE: REPO_ROOT, GITHUB_ENV: ghEnv, RPC_URL: "http://127.0.0.1:1", SHARE_RECEIVER_IN: "", VERIFY_IN: "true", GOVERN_IN: "true", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const exported = Object.fromEntries(readFileSync(ghEnv, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { code: r.exitCode, err: r.stderr.toString(), verbs: readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("cli ")).map((l) => l.slice(4)), exported };
}

describe("twin-publish step script", () => {
  test("a green run does publish, verify, govern and verify again in that order and writes a counts.json that passes the check", () => {
    const r = runScript({});
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.verbs).toEqual(["publish", "verify", "govern", "verify"]);
    expect(existsSync(r.exported.TWIN_VERIFY_LABELS!)).toBe(true);
    expect(existsSync(r.exported.TWIN_VERIFY_LABELS_POST_GOVERN!)).toBe(true);
    const j = JSON.parse(readFileSync(r.exported.TWIN_COUNTS_JSON!, "utf8"));
    expect(j.counts).toEqual(COUNTS);
    expect(j.deployerNonce).toBe(sum + 1); // the sum of the counts plus the deployer's prove-control transaction (core 1712)
    expect(existsSync(r.exported.TWIN_GOVERN_ROWS!)).toBe(true);
  });
  for (const [fail, verbs] of [["publish", ["publish"]], ["verify", ["publish", "verify"]], ["govern", ["publish", "verify", "govern"]], ["verify:2", ["publish", "verify", "govern", "verify"]]] as const) {
    test(`a failing ${fail} makes the script exit non-zero and later stages do not run`, () => {
      const r = runScript({ STUB_FAIL: fail });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain(`stub: ${fail.split(":")[0]} failed`);
      expect(r.verbs).toEqual([...verbs]);
    });
  }
  test("the second verify only runs when govern ran: verify without govern is one verify", () => {
    const r = runScript({ GOVERN_IN: "false" });
    expect(r.verbs).toEqual(["publish", "verify"]);
    expect(r.exported.TWIN_VERIFY_LABELS_POST_GOVERN).toBeUndefined();
  });
  test("a deployer nonce that is not the sum of the counts plus the prove-control transaction fails the run (the bare sum too)", () => {
    const r = runScript({ STUB_NONCE: String(sum) });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("deployerNonce");
  });
  test("govern is off unless asked for", () => {
    const r = runScript({ GOVERN_IN: "false" });
    expect(r.code).toBe(0);
    expect(r.verbs).toEqual(["publish", "verify"]);
  });
});

describe("the rehearsal uses only the allowed Twin environment steps", () => {
  test("no anvil_ or evm_ RPC name in the action, its script or the suite 28 workflow", () => {
    const script = join(REPO_ROOT, "publish-contracts/src/ci/twin-publish.ts");
    const files = [join(ACTION, "action.yml"), script, join(REPO_ROOT, ".github/workflows/suite-28-core-stages.yml")];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/\b(anvil|evm)_[a-zA-Z]+/);
    const steps = [...readFileSync(script, "utf8").matchAll(/run\(\[bun, rehearsal, "([a-z-]+)"/g)].map((m) => m[1]).filter((x) => x !== "keys");
    expect(steps).toEqual(["fund-gas", "fund-usdc"]);
  });
});
