// Tests for scripts/runbook/run-record.ts: the run writes its own go, report and sign-off, and refuses a mismatched or unsafe one.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./run-record.ts";

const SHA = "84952e18";
function withRun(fn: (d: { run: string; ev: string; sheet: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "run-record-"));
  try {
    const run = join(root, "run"), ev = join(root, "evidence"), sheet = join(root, "sheet.env");
    mkdirSync(join(run, "journal"), { recursive: true }); mkdirSync(ev);
    writeFileSync(sheet, "CHAIN_ID=918453\n");
    writeFileSync(join(run, "journal", "P0.03-tools.out"), "ok\n");
    writeFileSync(join(ev, "evidence.json"), "{}\n");
    fn({ run, ev, sheet });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const base = (d: { run: string; sheet: string }, target = "twin") => ["--run-dir", d.run, "--sha", SHA, "--target", target, "--sheet", d.sheet];
const report = (d: { run: string; ev: string; sheet: string }) => main(["report", ...base(d), "--evidence-dir", d.ev, "--chain-id", "918453", "--tag", "release/v0.5.0-rehearsal"]);

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

test("no sign-off when a pause report shows an issue", () => withRun((d) => {
  expect(main(["go", "--kind", "publish", ...base(d)])).toBe(0);
  writeFileSync(join(d.ev, "rollout-report-918453.json"), "{}\n");
  expect(report(d)).toBe(0);
  expect(main(["signoff", ...base(d)])).toBe(1);
}));

test("no sign-off without a publish go", () => withRun((d) => {
  expect(report(d)).toBe(0);
  expect(main(["signoff", ...base(d)])).toBe(1);
}));
