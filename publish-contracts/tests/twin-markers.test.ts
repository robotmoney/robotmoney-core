// Issue 1892: the Twin system rehearsal markers and their guard (src/ci/twin-markers.ts). The workflow runs the guard on the twin-publish log; these cases are its negative fixtures:
// a removed scenario, a zero count, an empty log and an empty requirement must all fail, and the script must still print every marker the workflow requires.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARKERS, markerProblems, type MarkerName } from "../src/ci/twin-markers.ts";
import { tmp } from "./fixtures.ts";
import { REPO_ROOT } from "./repo-root.ts";

const ALL = Object.keys(MARKERS) as MarkerName[];
const GOOD = [
  `${MARKERS.vaultsOnly} stages=12 gateway_stages=0 gateway_manifests=0`,
  `${MARKERS.receiptPath} receipt_id=0x01 submitter=0x02`,
  `${MARKERS.gatewayRefusals} scenarios=missing-upgrade-timelock,zero-upgrade-timelock,agent-input broadcasts=0`,
  `${MARKERS.gatewayRun} vaults_manifests_unchanged=true agents_at_handover=0 admin=0x03`,
].join("\n");

describe("twin scenario markers", () => {
  test("a log with every marker passes", () => {
    expect(markerProblems(GOOD, ALL)).toEqual([]);
  });
  for (const name of ALL) {
    test(`a log without the ${name} marker fails`, () => {
      const log = GOOD.split("\n").filter((l) => !l.startsWith(MARKERS[name])).join("\n");
      expect(markerProblems(log, ALL).join()).toContain(MARKERS[name]);
    });
  }
  test("an empty log fails every required marker", () => {
    expect(markerProblems("", ALL)).toHaveLength(ALL.length);
  });
  test("a marker with a zero count fails", () => {
    expect(markerProblems(GOOD.replace("stages=12", "stages=0"), ["vaultsOnly"]).join()).toContain("zero count");
    expect(markerProblems(GOOD.replace("scenarios=missing-upgrade-timelock,zero-upgrade-timelock,agent-input", "scenarios="), ["gatewayRefusals"]).join()).toContain("zero count");
  });
  test("requiring nothing fails: the guard cannot pass an empty requirement", () => {
    expect(markerProblems(GOOD, [])).not.toEqual([]);
  });
  test("the CLI exits 1 on a missing marker and 0 on a full log", () => {
    const dir = tmp("markers-");
    const run = (text: string) => {
      const f = join(dir, "log"); writeFileSync(f, text);
      return Bun.spawnSync([process.execPath, join(REPO_ROOT, "publish-contracts/src/ci/twin-markers.ts"), "check", "--log", f, "--require", ALL.join(",")], { stdout: "pipe", stderr: "pipe" }).exitCode;
    };
    expect(run(GOOD)).toBe(0);
    expect(run(GOOD.split("\n").slice(1).join("\n"))).toBe(1);
  });
  test("twin-publish.ts prints every marker the workflow requires and the workflow requires them all", () => {
    const script = readFileSync(join(REPO_ROOT, "publish-contracts/src/ci/twin-publish.ts"), "utf8");
    for (const name of ALL) expect(script).toContain(`MARKERS.${name}`);
    const wf = readFileSync(join(REPO_ROOT, ".github/workflows/suite-28-core-stages.yml"), "utf8");
    expect(wf).toContain(`--require ${ALL.join(",")}`);
    for (const input of ['vaults-only: "true"', 'gateway: "true"']) expect(wf).toContain(input);
  });
});
