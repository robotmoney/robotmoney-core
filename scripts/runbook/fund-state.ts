#!/usr/bin/env bun
// scripts/runbook/fund-state.ts: reads of the live fund system that releases/v0.9.0-onevault-upgrade.yaml makes before and after the upgrade.
//   proxies  (P0.94) --timelock A --proxy PROXY:IMPL ...     each proxy runs its manifest implementation, is not frozen, and only the timelock upgrades it
//   timelock (P0.94) --timelock A --safe A --delay N        the delay; the Safe is proposer, canceller and the only executor (not address(0)); prints the owners
//   counters (P0.94) --fund A --queue A --out FILE          writes supply-seedshares-plan-requests
//   counters (P2.84) --fund A --queue A --same VALUE        the same four numbers as VALUE
// Reads through cast with ETH_RPC_URL (cast-io.ts). Exit 0 pass, 1 a failed check or call, 2 a usage error.
import { UsageError, check, firstToken, need, options, realCast, runMain, sameAddress, writeState, type Cast } from "./cast-io.ts";

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
  } else throw new UsageError(`unknown subcommand ${verb ?? "(none)"}`);
}

if (import.meta.main) {
  await runMain("usage: fund-state.ts proxies|timelock|counters --name value ... (see the header)", () => {
    const [verb, ...argv] = process.argv.slice(2);
    main(realCast, verb, argv);
  });
}
