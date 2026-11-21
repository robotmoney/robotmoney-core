#!/usr/bin/env bun
// scripts/runbook/flow-params.ts: the queue's flowParams around the v0.9.0 upgrade (releases/v0.9.0-onevault-upgrade.yaml). The live queue returns
// the 18 words of the v0.8 FlowParams; the v0.9.0 queue returns 21 (contracts/FlowTypes.sol): cancelBuffer, maxPause and matchBandBps are appended,
// and the queue's own migration writes them (decision D4-19). No governed setFlowParams runs.
//   snapshot   (P0.94) --queue A --min-hold N --out FILE    the live 18 words, written raw: epochLength 3600, settleWindow 720, minHold N
//   sync-sheet (P0.87) --queue A --sheet FILE               sets the run sheet copy's FLOW_EPOCH_LENGTH and FLOW_SETTLE_WINDOW to the chain's
//                                                           (deploy-4.env still names the values before v0.8.0-onevault-upgrade), before the go
//   resubmit   (P3.72) --queue A --timelock A               after the adapter swap: the queue accepts setFlowParams of its own 21 live words from
//                                                           the timelock (simulated, nothing sent), so checkFlowParams passes with the new adapter
// Reads through cast with ETH_RPC_URL (cast-io.ts). Exit 0 pass, 1 a failed check or call, 2 a usage error.
import { readFileSync, writeFileSync } from "node:fs";
import { UsageError, check, need, options, realCast, runMain, wordDec, words, writeState, type Cast } from "./cast-io.ts";

/** The v0.9.0 FlowParams tuple (contracts/FlowTypes.sol). validate-contract-qa.test.ts recomputes it from the source and pins its selector. */
export const SET_FLOW_PARAMS = "setFlowParams((uint32,uint32,uint32,uint32,uint16,uint128,uint16,uint16,uint128,uint32,uint8,uint8,uint16,uint16,uint16,uint32,uint16,uint16,uint32,uint32,uint16))";
export const LIVE_WORDS = 18;
export const NEW_WORDS = 21;
const EPOCH = 0, SETTLE = 1, MIN_HOLD = 2;

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

/** PURE. The setFlowParams tuple argument of a 21-word flowParams return, every field as it reads. */
export function tupleOf(raw: string): string {
  const w = words(raw);
  if (w.length !== NEW_WORDS) throw new Error(`flowParams has ${w.length} words, not ${NEW_WORDS}: is the queue upgraded?`);
  return `(${w.map(wordDec).join(",")})`;
}

/** PURE. The sheet with FLOW_EPOCH_LENGTH and FLOW_SETTLE_WINDOW set to the chain's words. */
export function syncSheet(sheet: string, raw: string): string {
  const w = words(raw);
  return sheet.replace(/^FLOW_EPOCH_LENGTH=.*$/m, `FLOW_EPOCH_LENGTH=${wordDec(w[EPOCH]!)}`).replace(/^FLOW_SETTLE_WINDOW=.*$/m, `FLOW_SETTLE_WINDOW=${wordDec(w[SETTLE]!)}`);
}

export function main(cast: Cast, verb: string | undefined, o: Record<string, string>): void {
  if (verb === "snapshot") {
    const [queue, minHold, out] = need(o, "queue", "min-hold", "out");
    const raw = cast(["call", queue!, "flowParams()"]);
    writeState(out!, raw);
    console.log(`flowParams ${raw}`);
    const p = liveProblems(raw, minHold!);
    check(p.length === 0, p.join("; "));
  } else if (verb === "sync-sheet") {
    const [queue, sheet] = need(o, "queue", "sheet");
    const synced = syncSheet(readFileSync(sheet!, "utf8"), cast(["call", queue!, "flowParams()"]));
    writeFileSync(sheet!, synced);
    for (const l of synced.split("\n")) if (/^FLOW_(EPOCH_LENGTH|SETTLE_WINDOW)=/.test(l)) console.log(l);
  } else if (verb === "resubmit") {
    const [queue, timelock] = need(o, "queue", "timelock");
    const tuple = tupleOf(cast(["call", queue!, "flowParams()"]));
    cast(["call", "--from", timelock!, queue!, SET_FLOW_PARAMS, tuple]);
    console.log(`the queue accepts setFlowParams${tuple} from the timelock (simulated): checkFlowParams passes with the new adapter`);
  } else throw new UsageError(`unknown subcommand ${verb ?? "(none)"}`);
}

if (import.meta.main) {
  await runMain("usage: flow-params.ts snapshot|sync-sheet|resubmit --name value ... (see the header)", () => {
    const [verb, ...argv] = process.argv.slice(2);
    let o;
    try { o = options(argv).opts; } catch (e) { throw new UsageError((e as Error).message); }
    main(realCast, verb, o);
  });
}
