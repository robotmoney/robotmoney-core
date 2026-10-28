// Tests for scripts/runbook/run-record.ts: the run writes its own go, report and sign-off, and refuses a mismatched or unsafe one.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VAULT_MANIFESTS, journalHashesOf, main, notRunOf, redactUrls, senderIssuesOf, senderTxOf, unbackedOf } from "./run-record.ts";

const SHA = "84952e18";
/** The steps the test run's release runs on the target: the one step its journal holds, plus the report and sign-off steps the report excludes. */
const applicable = async () => ["P0.03-tools"];
const full = (d: { ev: string; man: string }, vaults?: string) => ["--evidence-dir", d.ev, "--manifest-dir", d.man, "--rpc", "http://127.0.0.1:8545", "--chain-id", "918453", "--tag", "release/v0.6.0-rehearsal", "--release", "vX", ...(vaults ? ["--vaults", vaults] : [])];
type Run = { run: string; ev: string; man: string; sheet: string; setDepositsPaused: (v: string) => void; setNonce: (n: number) => void };
/** A run directory with four vault manifests and a fake `cast` on PATH that answers depositsPaused() with the value `paused` sets. */
async function withRun(fn: (d: Run) => Promise<void> | void, manifests: readonly string[] = VAULT_MANIFESTS): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "run-record-"));
  const path = process.env.PATH;
  try {
    const run = join(root, "run"), ev = join(root, "evidence"), man = join(root, "manifests"), sheet = join(root, "sheet.env"), bin = join(root, "bin");
    mkdirSync(join(run, "journal"), { recursive: true }); mkdirSync(ev); mkdirSync(man); mkdirSync(bin);
    manifests.forEach((m, i) => writeFileSync(join(man, `${m}.json`), JSON.stringify({ vault: `0x${String(i + 1).padStart(40, "0")}` })));
    const answer = join(root, "paused");
    writeFileSync(answer, "false\n");
    writeFileSync(join(bin, "cast"), `#!/bin/sh\ncase "$1" in nonce) cat "${join(root, "nonce")}";; tx) exit 1;; *) cat "${answer}";; esac\n`); writeFileSync(join(root, "nonce"), "0\n"); chmodSync(join(bin, "cast"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    writeFileSync(sheet, "CHAIN_ID=918453\n");
    writeFileSync(join(run, "journal", "P0.03-tools.out"), "ok\n");
    writeFileSync(join(run, "journal", "P0.03-tools.result"), "pass\n");
    writeFileSync(join(ev, "evidence.json"), "{}\n");
    await fn({ run, ev, man, sheet, setDepositsPaused: (v) => writeFileSync(answer, `${v}\n`), setNonce: (n) => writeFileSync(join(root, "nonce"), `${n}\n`) });
  } finally { process.env.PATH = path; rmSync(root, { recursive: true, force: true }); }
}
const SENDER = "0x000000000000000000000000000000000000a001";
const goWith = (d: Run) => main(["go", "--kind", "publish", ...base(d), "--rpc", "http://127.0.0.1:8545", "--sender", SENDER, "--evidence-dir", d.ev]);
const THREE = ["vault", "protocol-asset-vault", "rwa-basket-vault"];
const reportOf = (d: Run) => readFileSync(join(d.run, "rollout-report.md"), "utf8");
const base = (d: Pick<Run, "run" | "sheet">, target = "twin") => ["--run-dir", d.run, "--sha", SHA, "--target", target, "--sheet", d.sheet];
const report3 = (d: Run, vaults = THREE.join(",")) => main(["report", ...base(d), ...full(d, vaults)], { applicable });
const report = (d: Run) => main(["report", ...base(d), ...full(d)], { applicable });
const signoff = (d: Run, vaults?: string) => main(["signoff", ...base(d), ...full(d, vaults)], { applicable });

test("go, report and sign-off are written by the run", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  expect(await goWith(d)).toBe(0);
  expect(await report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("| P0.03-tools | 1 | ok |");
  expect(await signoff(d)).toBe(0);
  expect(JSON.parse(readFileSync(join(d.run, "go", "signoff.json"), "utf8")).coreSha).toBe(SHA);
}));

test("a go for another sheet is refused", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  writeFileSync(d.sheet, "CHAIN_ID=1\n");
  expect(await goWith(d)).toBe(1);
}));

test("a freeze go is refused off the Twin chain", () => withRun(async (d) => {
  expect(await main(["go", "--kind", "freeze", ...base(d, "rehearsal")])).toBe(1);
  expect(existsSync(join(d.run, "go", "freeze.json"))).toBe(false);
  expect(await main(["go", "--kind", "freeze", ...base(d)])).toBe(0);
}));

test("a pause drill's report is listed, and the run still signs off once the vaults are open", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  writeFileSync(join(d.ev, "rollout-report-918453.json"), "{}\n");
  expect(await report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("- rollout-report-918453.json");
  expect(await signoff(d)).toBe(0);
}));

test("no sign-off while a vault is still paused", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  d.setDepositsPaused("true");
  expect(await report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("depositsPaused() is true at report time");
  expect(await signoff(d)).toBe(1);
}));

test("no sign-off without a publish go", () => withRun(async (d) => {
  expect(await report(d)).toBe(0);
  expect(await signoff(d)).toBe(1);
}));

test("no sign-off when a step failed, even with every vault open", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  writeFileSync(join(d.run, "journal", "P9.01-pause-all.out"), "\n");
  writeFileSync(join(d.run, "journal", "P9.01-pause-all.result"), "fail exit 25\n");
  expect(await report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("- P9.01-pause-all: fail exit 25");
  expect(await signoff(d)).toBe(1);
}));

test("a journaled step with no result is an issue, except the report's own step", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  writeFileSync(join(d.run, "journal", "P10.51-write-rollout-report.out"), "\n");
  expect(await main(["report", ...base(d), ...full(d), "--step", "P10.51-write-rollout-report"], { applicable })).toBe(0);
  expect(await signoff(d)).toBe(1); // the sign-off computes the report again without the exemption: by then the report step has a result, and this one has not
  writeFileSync(join(d.run, "journal", "P10.51-write-rollout-report.result"), "pass\n");
  expect(await signoff(d)).toBe(0);
  writeFileSync(join(d.run, "journal", "P9.02-paused-read.out"), "\n");
  expect(await report(d)).toBe(0);
  const text = readFileSync(join(d.run, "rollout-report.md"), "utf8");
  expect(text).toContain("- P9.02-paused-read: no result recorded");
  expect(text).not.toContain("- P10.51-write-rollout-report: no result recorded"); // it has its result now
}));

test("a skipped step is listed, not an issue", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  writeFileSync(join(d.run, "journal", "P0.13-twin-keys.result"), "skip dress: real keys\n");
  expect(await report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("## Skipped steps\n\n- P0.13-twin-keys: skip dress: real keys");
  expect(await signoff(d)).toBe(0);
}));

test("a three-vault run with no agent manifest has no issue and signs off", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  expect(await report3(d)).toBe(0);
  expect(reportOf(d)).toContain("## Issues\n\nNone.");
  expect(await signoff(d, THREE.join(","))).toBe(0);
}, THREE));

test("the default four-vault run missing the agent manifest lists an issue and refuses sign-off", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  expect(await report(d)).toBe(0);
  expect(reportOf(d)).toContain("agent-token-vault ?: depositsPaused() is unreadable (no manifest)");
  expect(await signoff(d)).toBe(1);
}, THREE));

test("a three-vault run missing the protocol-asset-vault manifest lists an issue and refuses sign-off", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  expect(await report3(d)).toBe(0);
  expect(reportOf(d)).toContain("protocol-asset-vault ?: depositsPaused() is unreadable (no manifest)");
  expect(await signoff(d, THREE.join(","))).toBe(1);
}, ["vault", "rwa-basket-vault"]));

test("a three-vault run still refuses sign-off while a declared vault is paused", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  d.setDepositsPaused("true");
  expect(await report3(d)).toBe(0);
  expect(reportOf(d)).toContain("true at report time");
  expect(await signoff(d, THREE.join(","))).toBe(1);
}, THREE));

test("--vaults with an unknown, empty or duplicate name is a usage error", () => withRun(async (d) => {
  for (const v of ["vault,no-such-vault", "vault,,rwa-basket-vault", "vault,vault", " "]) expect(await report3(d, v)).toBe(2);
  expect(existsSync(join(d.run, "rollout-report.md"))).toBe(false);
}));

test("only the v0.6.0 release adds a report step with the three-vault list", () => {
  const stepOf = (r: string) => {
    const t = readFileSync(join(import.meta.dir, "../../docs/runbooks/contract-qa/releases", `${r}.yaml`), "utf8");
    const i = t.indexOf('id: "P10.53-write-three-vault-rollout-report"');
    return i < 0 ? "" : t.slice(i, t.indexOf("irreversible:", i));
  };
  expect(stepOf("v0.6.0")).toContain('"--step", "P10.53-write-three-vault-rollout-report", "--vaults", "vault,protocol-asset-vault,rwa-basket-vault"');
  for (const r of ["v0.4.0", "v0.5.0"]) expect(readFileSync(join(import.meta.dir, "../../docs/runbooks/contract-qa/releases", `${r}.yaml`), "utf8")).not.toContain("--vaults");
});

test("a step the release runs on the target with no result is an issue; the report's own step and the steps after it are still to come", () => {
  expect(notRunOf(["P0.01", "P1.02", "P10.51", "P10.52"], { "P0.01": "pass" }, "P10.51")).toEqual(["P1.02: not run"]);
  expect(notRunOf(["P0.01", "P1.02"], { "P0.01": "pass", "P1.02": "skip gateAbsent x" })).toEqual([]);
  expect(notRunOf(["P0.01", "P1.02"], {})).toEqual(["P0.01: not run", "P1.02: not run"]);
});

test("--release lists every step of the release file that runs on the target and has no result", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  expect(await main(["report", ...base(d), "--evidence-dir", d.ev, "--manifest-dir", d.man, "--rpc", "http://127.0.0.1:8545", "--chain-id", "918453", "--tag", "release/v0.6.0-rehearsal", "--vaults", THREE.join(","), "--release", "v0.6.0", "--step", "P10.53-write-three-vault-rollout-report"])).toBe(0);
  const text = reportOf(d);
  expect(text).toContain("- P1.02-publish: not run");
  expect(text).toContain("- P8.23-v050-apply-receipt: not run");
  expect(await signoff(d)).toBe(1);
}, THREE));

test("the journal's transaction hashes are read from the CLI logs and the cast receipts", () => {
  const h = (c: string) => `0x${c.repeat(64)}`;
  expect(journalHashesOf([`{"event":"govern.safe_tx","tx_hash":"${h("a")}"}`, `{"deploy_tx":"${h("b")}"}`, `{"status":"0x1","transactionHash":"${h("C")}"}`, "no hash here"])).toEqual([h("a"), h("b"), h("c")]);
});

test("a marked sender's nonce that no journaled transaction carries is an issue", () => {
  const a = "0x000000000000000000000000000000000000a001";
  expect(senderIssuesOf(a, 10, 13, [{ from: a, nonce: 10 }, { from: a, nonce: 11 }, { from: a, nonce: 12 }])).toEqual([]);
  expect(senderIssuesOf(a, 10, 13, [{ from: a, nonce: 10 }, { from: a, nonce: 12 }])).toEqual([`sender ${a}: its transaction at nonce 11 is not in the run's journal (sent outside the runbook)`]);
  expect(senderIssuesOf(a, 10, 11, [{ from: "0x000000000000000000000000000000000000beef", nonce: 10 }])).toHaveLength(1);
});

test("a hand-edited report does not sign off: the sign-off computes the report again from the run", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  writeFileSync(join(d.run, "journal", "P0.05-failed.out"), "\n");
  writeFileSync(join(d.run, "journal", "P0.05-failed.result"), "fail exit 25\n");
  expect(await report(d)).toBe(0);
  writeFileSync(join(d.run, "rollout-report.md"), reportOf(d).replace(/## Issues\n\n[\s\S]*?\n\n## Skipped/, "## Issues\n\nNone.\n\n## Skipped"));
  expect(reportOf(d)).toContain("## Issues\n\nNone.\n");
  expect(await signoff(d)).toBe(1);
  expect(existsSync(join(d.run, "go", "signoff.json"))).toBe(false);
}));

test("the report and sign-off steps of the committed yamls name the release, so a step that never ran blocks sign-off", () => {
  const dir = join(import.meta.dir, "../../docs/runbooks/contract-qa");
  for (const f of ["template.yaml", "releases/v0.6.0.yaml"]) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const id of ["P10.51-write-rollout-report", "P10.53-write-three-vault-rollout-report", "P10.52-record-signoff"]) {
      const i = text.indexOf(`id: "${id}"`);
      if (i < 0) continue;
      expect(text.slice(i, text.indexOf("irreversible:", i)), `${f} ${id}`).toContain('"--release", "{release}"');
    }
  }
});

test("a URL in a journal line never reaches the published report", () => withRun(async (d) => {
  expect(redactUrls("Error: failed to connect to https://base-mainnet.example.com/v2/AbCdEfGhIjKlMnOpQrStUv012345 (503)")).toBe("Error: failed to connect to <url> (503)");
  expect(redactUrls("0x1234 status 1")).toBe("0x1234 status 1");
  expect(await goWith(d)).toBe(0);
  writeFileSync(join(d.run, "journal", "P0.03-tools.out"), "connecting to https://base-mainnet.example.com/v2/SECRETKEYSECRETKEYSECRET\n");
  expect(await report(d)).toBe(0);
  expect(reportOf(d)).not.toContain("SECRETKEY");
  expect(reportOf(d)).toContain("connecting to <url>");
}));

test("no sign-off when the publish go marks no sender", () => withRun(async (d) => {
  expect(await main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  expect(await report(d)).toBe(0);
  expect(await signoff(d)).toBe(1);
}));

test("no sign-off for another sha: the go and the sign-off name the same commit", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  expect(await report(d)).toBe(0);
  expect(await main(["signoff", "--run-dir", d.run, "--sha", "deadbeef", "--target", "twin", "--sheet", d.sheet, ...full(d)], { applicable })).toBe(1);
}));

test("a transaction a marked sender sent that no step journaled blocks the report's sign-off", () => withRun(async (d) => {
  expect(await goWith(d)).toBe(0);
  d.setNonce(2); // the sender sent two transactions after the go, and the journal names none
  expect(await report(d)).toBe(0);
  expect(reportOf(d)).toContain(`sender ${SENDER}: its transaction at nonce 0 is not in the run's journal`);
  expect(await signoff(d)).toBe(1);
}));

test("a pass with no journal was written by hand", () => withRun(async (d) => {
  expect(unbackedOf({ "P0.03-tools": "pass", "P0.04-x": "pass", "P0.05-y": "skip gate" }, ["P0.03-tools"])).toEqual(["P0.04-x: a pass with no journal"]);
  expect(await goWith(d)).toBe(0);
  writeFileSync(join(d.run, "journal", "P0.04-forged.result"), "pass\n");
  expect(await report(d)).toBe(0);
  expect(reportOf(d)).toContain("- P0.04-forged: a pass with no journal");
  expect(await signoff(d)).toBe(1);
}));

test("senderTxOf reads the foundry 1.8 envelope and the bare transaction, and nothing else", () => {
  const a = "0x000000000000000000000000000000000000a001";
  expect(senderTxOf(JSON.stringify({ schema_version: 1, success: true, data: { from: a, nonce: "0x5" }, errors: [], warnings: [] }))).toEqual({ from: a, nonce: 5 });
  expect(senderTxOf(JSON.stringify({ schema_version: 1, success: true, data: { from: a, nonce: 7 } }))).toEqual({ from: a, nonce: 7 });
  expect(senderTxOf(JSON.stringify({ from: a, nonce: "0x9" }))).toEqual({ from: a, nonce: 9 });
  expect(senderTxOf(JSON.stringify({ schema_version: 1, success: false, data: null, errors: [{ message: "tx not found" }] }))).toBeUndefined();
  expect(senderTxOf(JSON.stringify({ success: true, data: {} }))).toBeUndefined();
  expect(senderTxOf("not json")).toBeUndefined();
  expect(senderTxOf("")).toBeUndefined();
});
