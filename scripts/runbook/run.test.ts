// Tests for scripts/runbook/run.ts: the runner runs every step that runs on the target, journals it, writes its result, and stops on a failure.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Resolver, configProblems, parseConfig, readyAt, runStep, shouldRun, stepsToRun, withResume } from "./run.ts";
import { ROOT, loadModel, validateAll, type RunbookStep } from "./validate-contract-qa.ts";

const model = loadModel(ROOT);
const withRun = (fn: (runDir: string, r: Resolver) => void): void => {
  const runDir = mkdtempSync(join(tmpdir(), "run-test-"));
  try {
    mkdirSync(join(runDir, "state"));
    writeFileSync(join(runDir, "sheet.env"), "TIMELOCK_MIN_DELAY=1\nADMIN_ADDRESS=0x000000000000000000000000000000000000a001\n");
    fn(runDir, new Resolver({ scalars: { runDir, sheet: join(runDir, "sheet.env") }, lists: { owners: [] } }));
  } finally { rmSync(runDir, { recursive: true, force: true }); }
};
const step = (s: Partial<RunbookStep>): RunbookStep => ({ id: "P0.90-test", standing: ["4.1"], description: "t", host: "control", phase: 0, cmds: [["true"]], expectExit: 0, receipts: [], irreversible: false, ...s });
const opts = (runDir: string) => ({ runDir, sheetDelay: 1, dryRun: false, log: () => {} });

test("a step passes when every command exits as expected and journals its output", () => withRun((runDir, r) => {
  expect(runStep(step({ cmds: [["bash", "-c", "echo hello {sheet:ADMIN_ADDRESS}"], ["true"]] }), r, opts(runDir))).toBe("pass");
  expect(readFileSync(join(runDir, "journal", "P0.90-test.out"), "utf8")).toContain("hello 0x000000000000000000000000000000000000a001");
}));

test("a step fails on an exit it does not expect, on a missing receipt, and on an unresolved placeholder", () => withRun((runDir, r) => {
  expect(runStep(step({ cmds: [["bash", "-c", "exit 3"]] }), r, opts(runDir))).toBe("fail exit 3");
  expect(runStep(step({ cmds: [["bash", "-c", "exit 15"]], expectExit: [0, 15] }), r, opts(runDir))).toBe("pass");
  expect(runStep(step({ receipts: [{ dir: "{runDir}", pattern: "missing.json", required: true }] }), r, opts(runDir))).toStartWith("fail receipt missing.json");
  expect(runStep(step({ cmds: [["echo", "{state:never-written}"]] }), r, opts(runDir))).toStartWith("fail state never-written was not written");
  expect(runStep(step({ env: { X: "{sheet:NO_SUCH_LINE}" } }), r, opts(runDir))).toBe("fail the run sheet has no NO_SUCH_LINE");
}));

test("gateAbsent and sheetIs skip by the step's own gate; a missing go and a stage-host step fail", () => withRun((runDir, r) => {
  writeFileSync(join(runDir, "state", "done"), "");
  expect(runStep(step({ gateAbsent: "{runDir}/state/done", cmds: [["false"]] }), r, opts(runDir))).toStartWith("skip gateAbsent");
  // a list of paths skips only when every one exists (issue 1996: the upgrade build runs while any reader of it still runs)
  expect(runStep(step({ gateAbsent: ["{runDir}/state/done", "{runDir}/state/other"] }), r, opts(runDir))).toBe("pass");
  writeFileSync(join(runDir, "state", "other"), "");
  expect(runStep(step({ gateAbsent: ["{runDir}/state/done", "{runDir}/state/other"], cmds: [["false"]] }), r, opts(runDir))).toStartWith("skip gateAbsent");
  expect(runStep(step({ sheetIs: { UPGRADE_MODE: "upgradeable" }, cmds: [["false"]] }), r, opts(runDir))).toStartWith("skip sheetIs UPGRADE_MODE");
  expect(runStep(step({ go: "owner-go" }), r, opts(runDir))).toStartWith("fail go owner-go is not recorded");
  expect(runStep(step({ host: "stage" }), r, opts(runDir))).toStartWith("fail host stage");
}));

test("notBefore waits from the earlier step's result: the delay and hours are read, not typed", () => {
  expect(readyAt(1_000_000, "timelockDelay", 900)).toBe(1000 + 900);
  expect(readyAt(1_000_000, 0, 900)).toBe(1000);
  expect(readyAt(1_000_000, 2, 900)).toBe(1000 + 7200);
  withRun((runDir, r) => {
    expect(runStep(step({ notBefore: { afterStep: "P0.80-earlier", hours: 0 } }), r, opts(runDir))).toBe("fail notBefore P0.80-earlier has no result");
    mkdirSync(join(runDir, "journal"), { recursive: true });
    writeFileSync(join(runDir, "journal", "P0.80-earlier.result"), "pass\n");
    expect(runStep(step({ notBefore: { afterStep: "P0.80-earlier", hours: 0 } }), r, opts(runDir))).toBe("pass");
  });
});

test("a list placeholder takes the config's value for the target; a scalar outside the README is refused", () => withRun((_runDir, r) => {
  expect(r.argv(["bun", "x", "{owners}", "{gate}"])).toEqual(["bun", "x", "--counts-require-origin-dev"]);
  expect(() => parseConfig(JSON.stringify({ scalars: { notAPlaceholder: "x" } }))).toThrow("no placeholder");
  expect(() => parseConfig(JSON.stringify({ scalars: {}, lists: { notAList: [] } }))).toThrow("no whole-element placeholder");
}));

test("the steps to run are every step the release runs on the target; --from and --to only bound them", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  const all = stepsToRun(r, "rehearsal");
  expect(all[0]!.id).toBe("P0.01-runbook-valid");
  expect(all.at(-1)!.id).toBe("P10.52-record-signoff");
  expect(all.map((s) => s.id)).toContain("P8.23-v050-apply-receipt");
  const part = stepsToRun(r, "rehearsal", "P8.20-v050-register-submitter", "P8.24-v050-receipt-read-back");
  expect(part.map((s) => s.id)).toEqual(["P8.20-v050-register-submitter", "P8.21-v050-receipt-offline", "P8.25-v050-funding", "P8.40-v050-receipt-changes-split", "P8.41-v050-pre-deposit-rmusdc", "P8.42-v050-pre-deposit-rmproto", "P8.43-v050-pre-deposit-rmrwa", "P8.44-v050-pre-redeem-rmusdc", "P8.45-v050-pre-redeem-in-kind-rmproto", "P8.46-v050-pre-redeem-rmrwa", "P8.47-v050-pre-router-deposit", "P8.48-v050-pre-sweep-positions", "P8.22-v050-record-receipt", "P8.23-v050-apply-receipt", "P8.24-v050-receipt-read-back"]);
  expect(() => stepsToRun(r, "rehearsal", "P1.02-publish")).toThrow("no step that runs on rehearsal");
});

test("the runner has no option to skip a step", () => {
  const src = readFileSync(join(ROOT, "scripts", "runbook", "run.ts"), "utf8");
  const options = /options: \{([^\n]*)\}/.exec(src)![1]!;
  expect(options).not.toMatch(/skip|force|ignore/);
  expect(existsSync(join(ROOT, "scripts", "runbook", "run.ts"))).toBe(true);
});

test("on the rehearsal the report's directories must be the live deployment's directories", () => {
  const sc = { manifestDir: "/m", v050ManifestDir: "/m", evidenceDir: "/e", v050EvidenceDir: "/e" };
  expect(configProblems({ scalars: sc }, "rehearsal")).toEqual([]);
  expect(configProblems({ scalars: { ...sc, v050ManifestDir: "/other" } }, "rehearsal")).toHaveLength(1);
  expect(configProblems({ scalars: { ...sc, evidenceDir: "/other", manifestDir: "/other" } }, "rehearsal")).toHaveLength(2);
  expect(configProblems({ scalars: { ...sc, v050ManifestDir: "/other" } }, "twin")).toEqual([]);
});

test("a passed step does not run again unless it refreshes; a failed or new step runs", () => {
  expect(shouldRun("pass", {})).toBe(false);
  expect(shouldRun("pass", { refresh: true })).toBe(true);
  expect(shouldRun("fail exit 25", {})).toBe(true);
  expect(shouldRun(undefined, {})).toBe(true);
  expect(shouldRun("skip gateAbsent x", {})).toBe(true);
});

test("a publish that failed continues with --resume; nothing else gets it", () => {
  const publish = ["bun", "publish-contracts/src/cli.ts", "publish", "--chain", "918453"];
  expect(withResume(publish, true)).toEqual([...publish, "--resume"]);
  expect(withResume(publish, false)).toEqual(publish);
  expect(withResume([...publish, "--resume"], true)).toEqual([...publish, "--resume"]);
  expect(withResume([...publish, "--dry-run"], true)).toEqual([...publish, "--dry-run"]);
  expect(withResume(["bun", "publish-contracts/src/cli.ts", "govern", "--row", "x"], true)).toEqual(["bun", "publish-contracts/src/cli.ts", "govern", "--row", "x"]);
  expect(withResume(["bun", "x.ts", "publish"], true)).toEqual(["bun", "x.ts", "publish"]);
});

test("only the two stage-host fork steps and the done-marker read refresh; the destructive pre-state cleanup runs once", () => {
  const r = validateAll(ROOT, model).releases.get("v0.6.0")!;
  expect(r.steps.filter((s) => s.refresh).map((s) => s.id)).toEqual(["P0.12-twin-fork", "P8.02-v050-twin-fork", "P8.07-v050-done-markers"]);
  const cleanup = r.steps.find((s) => s.id === "P8.06-v050-pre-state")!;
  expect(cleanup.refresh).toBeUndefined();
  expect(cleanup.cmds.flat().join(" ")).toContain("revokeAgent"); // it redeems and revokes: a rerun mid-flow would undo the later steps' state
  expect(r.steps.find((s) => s.id === "P8.07-v050-done-markers")!.cmds.flat().join(" ")).not.toMatch(/cast-send|cast send|revokeAgent/); // it only reads
});

test("on the twin the run directory must leave room for the tunnel control socket path", () => {
  expect(configProblems({ scalars: { runDir: "/home/u/tmp/twin-qa-v060-9/run-1" } }, "twin")).toEqual([]);
  expect(configProblems({ scalars: { runDir: `/home/u/${"x".repeat(80)}` } }, "twin")).toHaveLength(1);
});
