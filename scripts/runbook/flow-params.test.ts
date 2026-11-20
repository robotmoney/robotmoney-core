// scripts/runbook/flow-params.test.ts: the flowParams reads and the setFlowParams calldata of v0.9.0-onevault-upgrade (P0.94, P2.84, P2.86, P3.81).
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SET_FLOW_PARAMS, liveProblems, main, syncSheet, tupleArg, upgradedProblems } from "./flow-params.ts";
import type { Cast } from "./cast-io.ts";

const w = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
/** The 18 live words: epochLength 3600, settleWindow 720, minHold 3600, then 4..18. */
const LIVE = [3600, 720, 3600, ...Array.from({ length: 15 }, (_, i) => i + 4)];
const raw = (xs: number[]) => `0x${xs.map(w).join("")}`;
const BEFORE = raw(LIVE);
const A = { cancelBuffer: "900", maxPause: "259200", matchBandBps: "10" };

test("the live snapshot: 18 words, epochLength 3600, settleWindow 720, minHold the sheet's", () => {
  expect(BEFORE.length).toBe(1154);
  expect(liveProblems(BEFORE, "3600")).toEqual([]);
  expect(liveProblems(BEFORE, "86400")).toEqual(["minHold 3600, not 86400"]);
  expect(liveProblems(raw([21600, ...LIVE.slice(1)]), "3600")).toEqual(["epochLength 21600, not 3600"]);
  expect(liveProblems(raw([...LIVE, 0]), "3600")[0]).toContain("19 words");
});

test("the tuple keeps the 18 live words, sets minHold, appends the three new fields", () => {
  expect(tupleArg(BEFORE, "1800", A)).toBe(`(3600,720,1800,${LIVE.slice(3).join(",")},900,259200,10)`);
  expect(SET_FLOW_PARAMS.split(",")).toHaveLength(21);
  expect(() => tupleArg(raw(LIVE.slice(1)), "1", A)).toThrow("17 words");
});

test("after the upgrade: 21 words, 18 unchanged, appended 0; after the execute: the three set", () => {
  const zero = { cancelBuffer: "0", maxPause: "0", matchBandBps: "0" };
  const up = raw([...LIVE, 0, 0, 0]);
  expect(up.length).toBe(1346);
  expect(upgradedProblems(up, BEFORE, zero)).toEqual([]);
  expect(upgradedProblems(raw([...LIVE, 900, 259200, 10]), BEFORE, A, "3600")).toEqual([]);
  expect(upgradedProblems(raw([...LIVE, 900, 259200, 11]), BEFORE, A)).toEqual(["matchBandBps 11, not 10"]);
  expect(upgradedProblems(raw([3601, ...LIVE.slice(1), 0, 0, 0]), BEFORE, zero)).toEqual(["word 0 changed: 3600 -> 3601"]);
  expect(upgradedProblems(BEFORE, BEFORE, zero)[0]).toContain("18 words, not 21");
});

test("the sheet sync sets only FLOW_EPOCH_LENGTH and FLOW_SETTLE_WINDOW", () => {
  const s = "A=1\nFLOW_EPOCH_LENGTH=21600\nFLOW_SETTLE_WINDOW=3600\nFLOW_EPOCH_FLOOR_USDC=100\n";
  expect(syncSheet(s, raw([...LIVE, 900, 259200, 10]))).toBe("A=1\nFLOW_EPOCH_LENGTH=3600\nFLOW_SETTLE_WINDOW=720\nFLOW_EPOCH_FLOOR_USDC=100\n");
});

test("the subcommands: snapshot writes the raw words, calldata the cast calldata, check keeps the go sheet once and syncs", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "flow-params-"));
  let live = BEFORE;
  const calls: string[][] = [];
  const cast: Cast = (args) => { calls.push(args); return args[0] === "call" ? live : `0xcalldata(${args[2]})`; };
  main(cast, "snapshot", { queue: "0xq", "min-hold": "3600", out: join(dir, "before") });
  expect(readFileSync(join(dir, "before"), "utf8")).toBe(`${BEFORE}\n`);
  main(cast, "calldata", { before: BEFORE, "min-hold": "3600", "cancel-buffer": "900", "max-pause": "259200", "match-band-bps": "10", out: join(dir, "data") });
  expect(calls.at(-1)![1]).toBe(SET_FLOW_PARAMS);
  expect(readFileSync(join(dir, "data"), "utf8")).toBe(`0xcalldata(${tupleArg(BEFORE, "3600", A)})\n`);
  live = raw([...LIVE, 0, 0, 0]);
  expect(() => main(cast, "same", { queue: "0xq", before: BEFORE })).not.toThrow();
  const sheet = join(dir, "sheet.env"), atGo = join(dir, "sheet-at-go.env");
  writeFileSync(sheet, "FLOW_EPOCH_LENGTH=21600\nFLOW_SETTLE_WINDOW=3600\n");
  const o = { queue: "0xq", before: BEFORE, "min-hold": "3600", "cancel-buffer": "900", "max-pause": "259200", "match-band-bps": "10", sheet, "sheet-at-go": atGo };
  expect(() => main(cast, "check", o)).toThrow("cancelBuffer 0, not 900");
  expect(readFileSync(sheet, "utf8")).toContain("21600");
  live = raw([...LIVE, 900, 259200, 10]);
  main(cast, "check", o);
  expect(readFileSync(sheet, "utf8")).toBe("FLOW_EPOCH_LENGTH=3600\nFLOW_SETTLE_WINDOW=720\n");
  expect(readFileSync(atGo, "utf8")).toBe("FLOW_EPOCH_LENGTH=21600\nFLOW_SETTLE_WINDOW=3600\n");
  main(cast, "check", o);
  expect(readFileSync(atGo, "utf8")).toContain("21600");
  expect(() => main(cast, "nope", {})).toThrow("unknown subcommand");
});
