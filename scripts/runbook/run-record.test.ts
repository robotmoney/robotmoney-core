// Tests for scripts/runbook/run-record.ts: the run writes its own go, report and sign-off, and refuses a mismatched or unsafe one.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VAULT_MANIFESTS, main } from "./run-record.ts";

const SHA = "84952e18";
type Run = { run: string; ev: string; man: string; sheet: string; setDepositsPaused: (v: string) => void };
/** A run directory with four vault manifests and a fake `cast` on PATH that answers depositsPaused() with the value `paused` sets. */
function withRun(fn: (d: Run) => void): void {
  const root = mkdtempSync(join(tmpdir(), "run-record-"));
  const path = process.env.PATH;
  try {
    const run = join(root, "run"), ev = join(root, "evidence"), man = join(root, "manifests"), sheet = join(root, "sheet.env"), bin = join(root, "bin");
    mkdirSync(join(run, "journal"), { recursive: true }); mkdirSync(ev); mkdirSync(man); mkdirSync(bin);
    VAULT_MANIFESTS.forEach((m, i) => writeFileSync(join(man, `${m}.json`), JSON.stringify({ vault: `0x${String(i + 1).padStart(40, "0")}` })));
    const answer = join(root, "paused");
    writeFileSync(answer, "false\n");
    writeFileSync(join(bin, "cast"), `#!/bin/sh\ncat "${answer}"\n`); chmodSync(join(bin, "cast"), 0o755);
    process.env.PATH = `${bin}:${path}`;
    writeFileSync(sheet, "CHAIN_ID=918453\n");
    writeFileSync(join(run, "journal", "P0.03-tools.out"), "ok\n");
    writeFileSync(join(run, "journal", "P0.03-tools.result"), "pass\n");
    writeFileSync(join(ev, "evidence.json"), "{}\n");
    fn({ run, ev, man, sheet, setDepositsPaused: (v) => writeFileSync(answer, `${v}\n`) });
  } finally { process.env.PATH = path; rmSync(root, { recursive: true, force: true }); }
}
const base = (d: Pick<Run, "run" | "sheet">, target = "twin") => ["--run-dir", d.run, "--sha", SHA, "--target", target, "--sheet", d.sheet];
const report = (d: Run) => main(["report", ...base(d), "--evidence-dir", d.ev, "--manifest-dir", d.man, "--rpc", "http://127.0.0.1:8545", "--chain-id", "918453", "--tag", "release/v0.5.0-rehearsal"]);

test("go, report and sign-off are written by the run", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  expect(report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("| P0.03-tools | 1 | ok |");
  expect(main(["signoff", ...base(d)])).toBe(0);
  expect(JSON.parse(readFileSync(join(d.run, "go", "signoff.json"), "utf8")).coreSha).toBe(SHA);
}));

test("a go for another sheet is refused", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  writeFileSync(d.sheet, "CHAIN_ID=1\n");
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(1);
}));

test("a freeze go is refused off the Twin chain", () => withRun((d) => {
  expect(main(["go", "--kind", "freeze", ...base(d, "rehearsal")])).toBe(1);
  expect(existsSync(join(d.run, "go", "freeze.json"))).toBe(false);
  expect(main(["go", "--kind", "freeze", ...base(d)])).toBe(0);
}));

test("a pause drill's report is listed, and the run still signs off once the vaults are open", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  writeFileSync(join(d.ev, "rollout-report-918453.json"), "{}\n");
  expect(report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("- rollout-report-918453.json");
  expect(main(["signoff", ...base(d)])).toBe(0);
}));

test("no sign-off while a vault is still paused", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  d.setDepositsPaused("true");
  expect(report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("depositsPaused() is true at report time");
  expect(main(["signoff", ...base(d)])).toBe(1);
}));

test("no sign-off without a publish go", () => withRun((d) => {
  expect(report(d)).toBe(0);
  expect(main(["signoff", ...base(d)])).toBe(1);
}));

test("no sign-off when a step failed, even with every vault open", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  writeFileSync(join(d.run, "journal", "P9.01-pause-all.out"), "\n");
  writeFileSync(join(d.run, "journal", "P9.01-pause-all.result"), "fail exit 25\n");
  expect(report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("- P9.01-pause-all: fail exit 25");
  expect(main(["signoff", ...base(d)])).toBe(1);
}));

test("a journaled step with no result is an issue, except the report's own step", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  writeFileSync(join(d.run, "journal", "P10.51-write-rollout-report.out"), "\n");
  expect(main(["report", ...base(d), "--evidence-dir", d.ev, "--manifest-dir", d.man, "--rpc", "http://127.0.0.1:8545", "--chain-id", "918453", "--tag", "release/v0.5.0-rehearsal", "--step", "P10.51-write-rollout-report"])).toBe(0);
  expect(main(["signoff", ...base(d)])).toBe(0);
  writeFileSync(join(d.run, "journal", "P9.02-paused-read.out"), "\n");
  expect(report(d)).toBe(0);
  const text = readFileSync(join(d.run, "rollout-report.md"), "utf8");
  expect(text).toContain("- P9.02-paused-read: no result recorded");
  expect(text).toContain("- P10.51-write-rollout-report: no result recorded");
}));

test("a skipped step is listed, not an issue", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  writeFileSync(join(d.run, "journal", "P0.13-twin-keys.result"), "skip dress: real keys\n");
  expect(report(d)).toBe(0);
  expect(readFileSync(join(d.run, "rollout-report.md"), "utf8")).toContain("## Skipped steps\n\n- P0.13-twin-keys: skip dress: real keys");
  expect(main(["signoff", ...base(d)])).toBe(0);
}));
