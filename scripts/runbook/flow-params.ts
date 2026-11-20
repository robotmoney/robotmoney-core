#!/usr/bin/env bun
// scripts/runbook/flow-params.ts: the queue's flowParams across the v0.9.0 upgrade (releases/v0.9.0-onevault-upgrade.yaml). The live queue returns
// the 18 words of the v0.8 FlowParams; the v0.9.0 queue returns 21 (src/FlowTypes.sol): cancelBuffer, maxPause and matchBandBps are appended.
//   snapshot (P0.94) --queue A --min-hold N --out FILE      the live 18 words, written raw: epochLength 3600, settleWindow 720, minHold N
//   calldata (P2.86) --before HEX --min-hold N --cancel-buffer N --max-pause N --match-band-bps N --out FILE
//                                                           setFlowParams with the 18 live words (minHold N) and the three new fields
//   same     (P2.84) --queue A --before HEX                 after the upgrade: 21 words, the first 18 unchanged, the three appended read 0
//   check    (P3.81) --queue A --before HEX --min-hold N --cancel-buffer N --max-pause N --match-band-bps N --sheet FILE --sheet-at-go FILE
//                                                           after the execute: 18 words unchanged, the three set; keeps the sheet at go once, then
//                                                           syncs its FLOW_EPOCH_LENGTH and FLOW_SETTLE_WINDOW to the chain
// Reads through cast with ETH_RPC_URL (cast-io.ts). Exit 0 pass, 1 a failed check or call, 2 a usage error.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { UsageError, check, need, options, realCast, runMain, wordDec, words, writeState, type Cast } from "./cast-io.ts";

/** The v0.9.0 FlowParams tuple (src/FlowTypes.sol). validate-contract-qa.test.ts recomputes it from the source and pins its selector. */
export const SET_FLOW_PARAMS = "setFlowParams((uint32,uint32,uint32,uint32,uint16,uint128,uint16,uint16,uint128,uint32,uint8,uint8,uint16,uint16,uint16,uint32,uint16,uint16,uint32,uint32,uint16))";
export const LIVE_WORDS = 18;
export const NEW_WORDS = 21;
const EPOCH = 0, SETTLE = 1, MIN_HOLD = 2;

export interface Appended { cancelBuffer: string; maxPause: string; matchBandBps: string }

/** PURE. Why a live (pre-upgrade) flowParams return is not the one the upgrade expects. */
export function liveProblems(raw: string, minHold: string): string[] {
  const w = words(raw);
  if (w.length !== LIVE_WORDS) return [`flowParams has ${w.length} words, not ${LIVE_WORDS}`];
  const out: string[] = [];
  if (wordDec(w[EPOCH]!) !== "3600") out.push(`epochLength ${wordDec(w[EPOCH]!)}, not 3600`);
  if (wordDec(w[SETTLE]!) !== "720") out.push(`settleWindow ${wordDec(w[SETTLE]!)}, not 720`);
  if (wordDec(w[MIN_HOLD]!) !== minHold) out.push(`minHold ${wordDec(w[MIN_HOLD]!)}, not ${minHold}`);
  return out;
}

/** PURE. The setFlowParams tuple argument: the 18 live words as decimals, minHold replaced, then the three appended fields. */
export function tupleArg(before: string, minHold: string, a: Appended): string {
  const w = words(before);
  if (w.length !== LIVE_WORDS) throw new Error(`the snapshot has ${w.length} words, not ${LIVE_WORDS}`);
  const f = w.map(wordDec);
  f[MIN_HOLD] = minHold;
  return `(${[...f, a.cancelBuffer, a.maxPause, a.matchBandBps].join(",")})`;
}

/** PURE. Why an upgraded queue's flowParams are not the snapshot plus `appended` (all three "0" before the execute). */
export function upgradedProblems(raw: string, before: string, appended: Appended, minHold?: string): string[] {
  const a = words(raw), b = words(before);
  if (a.length !== NEW_WORDS) return [`flowParams has ${a.length} words, not ${NEW_WORDS}`];
  const out: string[] = [];
  for (let i = 0; i < LIVE_WORDS; i++) if (a[i] !== b[i]) out.push(`word ${i} changed: ${wordDec(b[i] ?? "0")} -> ${wordDec(a[i]!)}`);
  if (minHold !== undefined && wordDec(a[MIN_HOLD]!) !== minHold) out.push(`minHold ${wordDec(a[MIN_HOLD]!)}, not ${minHold}`);
  const want = [appended.cancelBuffer, appended.maxPause, appended.matchBandBps];
  const names = ["cancelBuffer", "maxPause", "matchBandBps"];
  for (let i = 0; i < 3; i++) if (wordDec(a[LIVE_WORDS + i]!) !== want[i]) out.push(`${names[i]} ${wordDec(a[LIVE_WORDS + i]!)}, not ${want[i]}`);
  return out;
}

/** PURE. The sheet with FLOW_EPOCH_LENGTH and FLOW_SETTLE_WINDOW set to the chain's words. */
export function syncSheet(sheet: string, raw: string): string {
  const w = words(raw);
  return sheet.replace(/^FLOW_EPOCH_LENGTH=.*$/m, `FLOW_EPOCH_LENGTH=${wordDec(w[EPOCH]!)}`).replace(/^FLOW_SETTLE_WINDOW=.*$/m, `FLOW_SETTLE_WINDOW=${wordDec(w[SETTLE]!)}`);
}

const appendedOf = (o: Record<string, string>): Appended => {
  const [cancelBuffer, maxPause, matchBandBps] = need(o, "cancel-buffer", "max-pause", "match-band-bps");
  return { cancelBuffer: cancelBuffer!, maxPause: maxPause!, matchBandBps: matchBandBps! };
};
const fail = (problems: string[]): void => check(problems.length === 0, problems.join("; "));

export function main(cast: Cast, verb: string | undefined, o: Record<string, string>): void {
  if (verb === "snapshot") {
    const [queue, minHold, out] = need(o, "queue", "min-hold", "out");
    const raw = cast(["call", queue!, "flowParams()"]);
    writeState(out!, raw);
    console.log(`flowParams ${raw}`);
    fail(liveProblems(raw, minHold!));
  } else if (verb === "calldata") {
    const [before, minHold, out] = need(o, "before", "min-hold", "out");
    const a = appendedOf(o);
    writeState(out!, cast(["calldata", SET_FLOW_PARAMS, tupleArg(before!, minHold!, a)]));
    console.log(`setFlowParams calldata: the live 18 words, cancelBuffer ${a.cancelBuffer}, maxPause ${a.maxPause}, matchBandBps ${a.matchBandBps}, minHold ${minHold}`);
  } else if (verb === "same") {
    const [queue, before] = need(o, "queue", "before");
    fail(upgradedProblems(cast(["call", queue!, "flowParams()"]), before!, { cancelBuffer: "0", maxPause: "0", matchBandBps: "0" }));
    console.log("flowParams: the 18 live words unchanged, the 3 appended words read 0 until P3.81");
  } else if (verb === "check") {
    const [queue, before, minHold, sheet, atGo] = need(o, "queue", "before", "min-hold", "sheet", "sheet-at-go");
    const raw = cast(["call", queue!, "flowParams()"]);
    console.log(`flowParams ${raw}`);
    fail(upgradedProblems(raw, before!, appendedOf(o), minHold!));
    if (!existsSync(atGo!)) copyFileSync(sheet!, atGo!);
    const synced = syncSheet(readFileSync(sheet!, "utf8"), raw);
    writeFileSync(sheet!, synced);
    for (const l of synced.split("\n")) if (/^FLOW_(EPOCH_LENGTH|SETTLE_WINDOW)=/.test(l)) console.log(l);
  } else throw new UsageError(`unknown subcommand ${verb ?? "(none)"}`);
}

if (import.meta.main) {
  await runMain("usage: flow-params.ts snapshot|calldata|same|check --name value ... (see the header)", () => {
    const [verb, ...argv] = process.argv.slice(2);
    let o;
    try { o = options(argv).opts; } catch (e) { throw new UsageError((e as Error).message); }
    main(realCast, verb, o);
  });
}
