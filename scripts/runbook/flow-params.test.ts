// scripts/runbook/flow-params.test.ts: the flowParams reads of v0.9.0-onevault-upgrade (P0.87 sheet sync, P0.94 snapshot, P3.72 resubmit simulation).
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SET_FLOW_PARAMS, liveProblems, main, syncSheet, tupleOf } from "./flow-params.ts";
import type { Cast } from "./cast-io.ts";

const w = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
/** The 18 live words: epochLength 3600, settleWindow 720, minHold 3600, then 4..18. */
const LIVE = [3600, 720, 3600, ...Array.from({ length: 15 }, (_, i) => i + 4)];
const raw = (xs: number[]) => `0x${xs.map(w).join("")}`;
const BEFORE = raw(LIVE);

test("the live snapshot: 18 words, epochLength 3600, settleWindow 720, minHold the sheet's", () => {
  expect(BEFORE.length).toBe(1154);
  expect(liveProblems(BEFORE, "3600")).toEqual([]);
  expect(liveProblems(BEFORE, "86400")).toEqual(["minHold 3600, not 86400"]);
  expect(liveProblems(raw([21600, ...LIVE.slice(1)]), "3600")).toEqual(["epochLength 21600, not 3600"]);
  expect(liveProblems(raw([...LIVE, 0]), "3600")[0]).toContain("19 words");
});

test("the v0.9.0 live snapshot (--words 21): same offsets, 21 words", () => {
  const live21 = raw([...LIVE, 900, 259200, 10]);
  expect(liveProblems(live21, "3600", 21)).toEqual([]);
  expect(liveProblems(live21, "3600")[0]).toBe("flowParams has 21 words, not 18");
  expect(liveProblems(BEFORE, "3600", 21)).toEqual(["flowParams has 18 words, not 21"]);
  expect(liveProblems(raw([3600, 360, 7200, ...LIVE.slice(3), 900, 259200, 10]), "3600", 21)).toEqual(["settleWindow 360, not 720", "minHold 7200, not 3600"]);
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "flow-params-"));
  main(() => live21, "snapshot", { queue: "0xq", "min-hold": "3600", out: join(dir, "before"), words: "21" });
  expect(readFileSync(join(dir, "before"), "utf8")).toBe(`${live21}\n`);
  expect(() => main(() => live21, "snapshot", { queue: "0xq", "min-hold": "3600", out: join(dir, "b2") })).toThrow("21 words, not 18");
  expect(() => main(() => live21, "snapshot", { queue: "0xq", "min-hold": "3600", out: join(dir, "b3"), words: "19" })).toThrow("--words 19");
});

test("the resubmitted tuple is the queue's own 21 words; an unupgraded queue is refused", () => {
  expect(tupleOf(raw([...LIVE, 900, 259200, 10]))).toBe(`(${[...LIVE, 900, 259200, 10].join(",")})`);
  expect(() => tupleOf(BEFORE)).toThrow("18 words, not 21");
  expect(SET_FLOW_PARAMS.split(",")).toHaveLength(21);
});

test("the sheet sync sets only FLOW_EPOCH_LENGTH and FLOW_SETTLE_WINDOW", () => {
  const s = "A=1\nFLOW_EPOCH_LENGTH=21600\nFLOW_SETTLE_WINDOW=3600\nFLOW_EPOCH_FLOOR_USDC=100\n";
  expect(syncSheet(s, BEFORE)).toBe("A=1\nFLOW_EPOCH_LENGTH=3600\nFLOW_SETTLE_WINDOW=720\nFLOW_EPOCH_FLOOR_USDC=100\n");
});

test("the subcommands: snapshot writes the raw words, sync-sheet edits the sheet, resubmit simulates from the timelock", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "flow-params-"));
  let live = BEFORE;
  const calls: string[][] = [];
  const cast: Cast = (args) => { calls.push(args); if (args[1] === "--from") return "0x"; return live; };
  main(cast, "snapshot", { queue: "0xq", "min-hold": "3600", out: join(dir, "before") });
  expect(readFileSync(join(dir, "before"), "utf8")).toBe(`${BEFORE}\n`);
  const sheet = join(dir, "sheet.env");
  writeFileSync(sheet, "FLOW_EPOCH_LENGTH=21600\nFLOW_SETTLE_WINDOW=3600\n");
  main(cast, "sync-sheet", { queue: "0xq", sheet });
  expect(readFileSync(sheet, "utf8")).toBe("FLOW_EPOCH_LENGTH=3600\nFLOW_SETTLE_WINDOW=720\n");
  live = raw([...LIVE, 900, 259200, 10]);
  main(cast, "resubmit", { queue: "0xq", timelock: "0xt" });
  expect(calls.at(-1)).toEqual(["call", "--from", "0xt", "0xq", SET_FLOW_PARAMS, tupleOf(live)]);
  expect(() => main(cast, "nope", {})).toThrow("unknown subcommand");
});
