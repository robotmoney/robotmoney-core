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
  return { code: r.exitCode, err: r.stderr.toString(), logText: readFileSync(log, "utf8"), verbs: readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("cli ")).map((l) => l.slice(4)), exported };
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

describe("twin-publish in the rehearsal kind (issue 1727)", () => {
  /** A stub CLI that logs the whole argument line, writes the counts file and the three manifests the receipt path reads. */
  function rehearsalStubs(): Record<string, string> {
    const dir = tmp("stub-reh-");
    const f = (n: string, body: string, mode = 0o644) => { const p = join(dir, n); writeFileSync(p, body); chmodSync(p, mode); return p; };
    return {
      TWIN_CLI: f("cli.js", `
        const fs = require("node:fs");
        const a = process.argv.slice(2), v = (k) => a[a.indexOf(k) + 1];
        fs.appendFileSync(process.env.STUB_LOG, "line " + a.join(" ") + "\\n");
        if (a[0] === "publish") {
          fs.writeFileSync(v("--counts-dir") + "/" + v("--core-sha") + ".json", JSON.stringify({ deploySha: v("--core-sha"), measured: { chainId: 918453, at: "now" }, counts: JSON.parse(process.env.STUB_COUNTS) }));
          const m = process.env.PUBLISH_MANIFEST_DIR;
          fs.writeFileSync(m + "/ic-policy.json", JSON.stringify({ consensus_receipt: "0x00000000000000000000000000000000000000c1" }));
          fs.writeFileSync(m + "/governance.json", JSON.stringify({ governance: "0x00000000000000000000000000000000000000c2" }));
          fs.writeFileSync(m + "/timelock.json", JSON.stringify({ timelock: "0x00000000000000000000000000000000000000c3" }));
        }`),
      TWIN_EVIDENCE_CHECK: f("evidence.js", `require("node:fs").appendFileSync(process.env.STUB_LOG, "line evidence " + process.argv.slice(2).join(" ") + "\\n");`),
      CAST: f("cast", `#!/usr/bin/env bash
echo "cast $*" >> "$STUB_LOG"
if [ "$1" = "nonce" ]; then
  n=$(grep -c '^cast nonce' "$STUB_LOG")
  if [ "$n" = "1" ]; then echo "$STUB_START"; else echo "$STUB_NONCE"; fi
fi
`, 0o755),
    };
  }
  const START = 118;
  const rehearsalRun = (env: Record<string, string> = {}) => {
    const r = runScript({ REHEARSAL_IN: "true", STUB_START: String(START), STUB_NONCE: String(START + sum + 1), ...rehearsalStubs(), ...env });
    return r;
  };
  test("the sheet is the rehearsal kind at 900 s with a new salt, the deployer is moved off nonce 0 first, and counts.json carries the start nonce", () => {
    const r = rehearsalRun();
    expect(r.err).not.toContain("stub");
    expect(r.code).toBe(0);
    const j = JSON.parse(readFileSync(r.exported.TWIN_COUNTS_JSON!, "utf8"));
    expect(j.deployerStartNonce).toBe(START);
    expect(j.deployerNonce).toBe(START + sum + 1);
    const run = r.exported.TWIN_RUN_DIR!;
    const frag = readFileSync(join(run, "fragment.env"), "utf8");
    expect(frag).toMatch(/^DEPLOYMENT_KIND=rehearsal$/m);
    expect(frag).toMatch(/^TIMELOCK_MIN_DELAY=900$/m);
    expect(frag).toMatch(/^GOVERN_NEW_DELAY=1800$/m);
    expect(frag).toMatch(/^SAFE_SALT_NONCE=[0-9]+$/m);
    expect(existsSync(join(run, "keys", "SUBMITTER"))).toBe(true);
  });
  test("a start nonce that is not part of the final nonce fails the counts check (the production sum alone is wrong for a non-fresh deployer)", () => {
    const r = rehearsalRun({ STUB_NONCE: String(sum + 1) });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("deployerNonce");
  });
  test("after the second verify: register the submitter, record a REAL receipt as the submitter, apply it, verify a third time, check the receipt path", () => {
    const r = rehearsalRun();
    expect(r.code).toBe(0);
    const cli = r.logText.split("\n").filter((l) => l.startsWith("line ") && !l.startsWith("line evidence")).map((l) => l.slice(5));
    const verb = (l: string) => l.split(" ")[0]!;
    const row = (l: string) => (l.includes("--row ") ? l.split("--row ")[1]!.split(" ")[0] : "");
    expect(cli.map((l) => verb(l) + (row(l) ? ":" + row(l) : ""))).toEqual(["publish", "verify", "govern", "verify", "govern:register-committee", "record-receipt", "govern:apply-receipt", "verify"]);
    const reg = cli[4]!, rec = cli[5]!, app = cli[6]!;
    const submitterAddr = /--submitter (0x[0-9a-fA-F]{40})/.exec(reg)![1]!;
    expect(rec).toContain("keystore:"); expect(rec).toContain("/keys/SUBMITTER:"); // the SUBMITTER signs the record, not the deployer
    expect(reg).toContain("/keys/DEPLOYER:");
    const rid = /--receipt-id (0x[0-9a-f]{64})/.exec(rec)![1]!;
    expect(app).toContain(`--receipt-id ${rid}`); // the receipt the Safe applies is the one the submitter recorded
    expect(rec).toMatch(/--payload-digest 0x[0-9a-f]{64}/);
    expect(rec).toMatch(/--payload-uri https:\/\/twin\.invalid\//);
    // the payload the Safe applies is the file whose keccak256 is the recorded digest
    const payload = /--payload (\S+)/.exec(app)![1]!;
    const body = readFileSync(payload);
    const { keccak256 } = require("viem");
    expect(rec).toContain(`--payload-digest ${keccak256(new Uint8Array(body))}`);
    // the SUBMITTER was funded by a plain transfer from the deployer, and the receipt path is checked as a rehearsal
    expect(r.logText).toContain(`cast send ${submitterAddr}`);
    expect(r.logText).toMatch(/line evidence --receipt-applications .*publish-run\.json --deployment-kind rehearsal --consensus-receipt 0x0*c1 --governance 0x0*c2 --timelock 0x0*c3/);
    expect(r.exported.TWIN_RECEIPT_ID).toBe(rid);
    expect(r.exported.TWIN_RECEIPT_SUBMITTER).toBe(submitterAddr);
    expect(existsSync(r.exported.TWIN_VERIFY_LABELS_POST_APPLY!)).toBe(true);
  });
  test("the deployer's self-transfer happens before publish, the submitter's gas after the second verify", () => {
    const r = rehearsalRun();
    const order = r.logText.split("\n").filter((l) => /^(cast send|line (publish|verify|govern|record-receipt))/.test(l)).map((l) => l.replace(/ 0x[0-9a-fA-F]{40}.*/, "").split(" --")[0]!);
    expect(order[0]).toBe("cast send"); // moves the deployer nonce
    expect(order[1]).toBe("line publish");
    expect(order.indexOf("cast send", 1)).toBeGreaterThan(order.lastIndexOf("line verify", order.indexOf("line govern")));
  });
  test("production Twin run (REHEARSAL_IN unset) is unchanged: no self-transfer, no submitter, the four verbs", () => {
    const r = runScript({});
    expect(r.verbs).toEqual(["publish", "verify", "govern", "verify"]);
    expect(r.exported.TWIN_RECEIPT_ID).toBeUndefined();
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
