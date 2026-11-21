#!/usr/bin/env bun
// scripts/runbook/fund-state.ts: reads of the live fund system that releases/v0.9.0-onevault-upgrade.yaml makes before and after the upgrade.
//   proxies  (P0.94) --timelock A --proxy PROXY:IMPL ...     each proxy runs its manifest implementation, is not frozen, and only the timelock upgrades it
//   timelock (P0.94) --timelock A --safe A --delay N        the delay; the Safe is proposer, canceller and the only executor (not address(0)); prints the owners
//   counters (P0.94) --fund A --queue A --out FILE          writes supply-seedshares-plan-requests
//   counters (P2.84) --fund A --queue A --same VALUE        the same four numbers as VALUE
//   pool-depth (P0.94)  --fund A --queue A --lib A --usdc A --min N
//                       prints each active basket pool's USDC depth as the fund measures it (FundValuationLib.poolUsdcDepth over the queue's
//                       settleWindow, called on the live library) and WARNS, without failing, when one is below N (the migration's minPoolDepthUsdc)
//   sheet-defaults (P0.87) --sheet FILE
//                       appends each key the v0.9.0 migrations write that the run sheet copy lacks, at the migration's value (decision D4-19), so the
//                       fund verifier compares the migrated values with reviewed ones; a key the sheet has is kept
// Reads through cast with ETH_RPC_URL (cast-io.ts). Exit 0 pass, 1 a failed check or call, 2 a usage error.
import { appendFileSync, readFileSync } from "node:fs";
import { UsageError, check, firstToken, need, options, realCast, runMain, sameAddress, wordDec, words, writeState, type Cast } from "./cast-io.ts";
import { basket } from "./adapter-swap.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function proxies(cast: Cast, timelock: string, pairs: string[]): void {
  check(pairs.length > 0, "no --proxy PROXY:IMPL");
  for (const p of pairs) {
    const [proxy, impl] = p.split(":");
    if (!proxy || !impl) throw new UsageError(`--proxy ${p} is not PROXY:IMPL`);
    const have = cast(["implementation", proxy]);
    console.log(`${proxy} implementation ${have}`);
    check(sameAddress(have, impl), `${proxy} runs ${have}, not the manifest's ${impl}`);
    check(cast(["call", proxy, "upgradesFrozen()(bool)"]) === "false", `${proxy} is frozen`);
    check(sameAddress(cast(["call", proxy, "upgradeTimelock()(address)"]), timelock), `${proxy} is not upgraded by the fund timelock`);
  }
}

export function timelockRoles(cast: Cast, timelock: string, safe: string, delay: string): void {
  const minDelay = cast(["call", timelock, "getMinDelay()(uint256)"]);
  console.log(`delay ${minDelay}`);
  console.log(`owners ${cast(["call", safe, "getOwners()(address[])"])} threshold ${cast(["call", safe, "getThreshold()(uint256)"])}`);
  check(minDelay === delay, `the timelock delay is ${minDelay}, not ${delay}`);
  const has = (role: string, who: string) => cast(["call", timelock, "hasRole(bytes32,address)(bool)", cast(["keccak", role]), who]) === "true";
  check(has("PROPOSER_ROLE", safe), "the Safe is not proposer");
  check(has("CANCELLER_ROLE", safe), "the Safe is not canceller");
  check(has("EXECUTOR_ROLE", safe), "the Safe is not executor");
  check(!has("EXECUTOR_ROLE", ZERO_ADDRESS), "the executor is open (address(0) holds EXECUTOR_ROLE)");
  console.log("executor: the Safe only");
}

/** supply-seedshares-plan-requests, as the step's state file holds it. */
export function counters(cast: Cast, fund: string, queue: string): string {
  return [
    firstToken(cast(["call", fund, "totalSupply()(uint256)"])),
    firstToken(cast(["call", fund, "balanceOf(address)(uint256)", fund])),
    cast(["call", fund, "currentPlanId()(uint256)"]),
    cast(["call", queue, "requestCount()(uint256)"]),
  ].join("-");
}

/** The values the v0.9.0 migrations write, under the sheet keys the fund verifier compares them with: contracts/lib/FundStorage.sol's defaults
 *  (FundMigrateLib), decision D4-16 for the queue (FlowMigrateLib), and the live Rebalancer's step params, which its migration carries over. */
export const MIGRATION_SHEET_DEFAULTS: readonly (readonly [string, string])[] = [
  ["FUND_MIN_POOL_DEPTH_USDC", "2000000000000"], ["FUND_FEE_MARGIN_BPS", "20"], ["FUND_DELIST_BAND_BPS", "300"], ["FUND_DELIST_BUDGET_BPS", "300"], ["FUND_MAX_BASKET_BPS", "10000"],
  ["FLOW_CANCEL_BUFFER", "900"], ["FLOW_MAX_PAUSE", "259200"], ["FLOW_MATCH_BAND_BPS", "10"],
  ["REBALANCER_MAX_OVERRUN", "604800"], ["REBALANCER_MAX_STEP_COST_BPS", "50"], ["REBALANCER_TOLERANCE_BPS", "50"], ["REBALANCER_MIN_STEP_USDC", "1000000"],
];

/** PURE. The sheet lines to append: each default whose key the sheet lacks. */
export function missingSheetLines(sheet: string): string[] {
  const has = new Set(sheet.split("\n").map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1]).filter(Boolean));
  return MIGRATION_SHEET_DEFAULTS.filter(([k]) => !has.has(k)).map(([k, v]) => `${k}=${v}`);
}

export function sheetDefaults(path: string): void {
  const text = readFileSync(path, "utf8");
  const add = missingSheetLines(text);
  if (add.length) appendFileSync(path, `${text.endsWith("\n") ? "" : "\n"}# v0.9.0 migration values (decision D4-19), added by the runbook\n${add.join("\n")}\n`);
  console.log(add.length ? `added ${add.join(" ")}` : "the sheet has every migration key");
}

export function poolDepth(cast: Cast, fund: string, queue: string, lib: string, usdc: string, min: bigint): void {
  const window = wordDec(words(cast(["call", queue, "flowParams()"]))[1]!);
  for (const a of basket(cast, fund)) {
    const out = cast(["call", lib, "poolUsdcDepth(address,address,uint32)(bool,uint256)", a.pool, usdc, window]).split("\n").map(firstToken);
    const ok = out[0] === "true", depth = BigInt(out[1] ?? "0");
    const line = `asset ${a.index} pool ${a.pool}: depth ${ok ? `${depth} (${depth / 1_000_000n} USDC)` : "unreadable (history too short)"} over ${window} s`;
    if (!ok || depth < min) console.warn(`WARNING ${line} is below the migration's minPoolDepthUsdc ${min}: setting a target for it will revert PoolDepthTooLow`);
    else console.log(line);
  }
}

export function main(cast: Cast, verb: string | undefined, argv: string[]): void {
  if (verb === "proxies") {
    const pairs: string[] = [];
    let timelock = "";
    for (let i = 0; i < argv.length; i += 2) {
      if (argv[i] === "--proxy" && argv[i + 1]) pairs.push(argv[i + 1]!);
      else if (argv[i] === "--timelock" && argv[i + 1]) timelock = argv[i + 1]!;
      else throw new UsageError(`unexpected ${argv[i]}`);
    }
    if (!timelock) throw new UsageError("missing --timelock");
    proxies(cast, timelock, pairs);
    return;
  }
  let o;
  try { o = options(argv).opts; } catch (e) { throw new UsageError((e as Error).message); }
  if (verb === "timelock") {
    const [timelock, safe, delay] = need(o, "timelock", "safe", "delay");
    timelockRoles(cast, timelock!, safe!, delay!);
  } else if (verb === "counters") {
    const [fund, queue] = need(o, "fund", "queue");
    const now = counters(cast, fund!, queue!);
    const planStatus = cast(["call", fund!, "planStatus()(uint8)"]);
    if (o.out) { writeState(o.out, now); console.log(`supply-seedshares-plan-requests ${now} planStatus ${planStatus}`); }
    else if (o.same !== undefined) { check(now === o.same, `supply-seedshares-plan-requests ${now}, was ${o.same}`); console.log(`planStatus ${planStatus}`); }
    else throw new UsageError("counters needs --out FILE or --same VALUE");
  } else if (verb === "sheet-defaults") {
    sheetDefaults(need(o, "sheet")[0]!);
  } else if (verb === "pool-depth") {
    const [fund, queue, lib, usdc, min] = need(o, "fund", "queue", "lib", "usdc", "min");
    poolDepth(cast, fund!, queue!, lib!, usdc!, BigInt(min!));
  } else throw new UsageError(`unknown subcommand ${verb ?? "(none)"}`);
}

if (import.meta.main) {
  await runMain("usage: fund-state.ts proxies|timelock|counters|pool-depth|sheet-defaults --name value ... (see the header)", () => {
    const [verb, ...argv] = process.argv.slice(2);
    main(realCast, verb, argv);
  });
}
