#!/usr/bin/env bun
// scripts/runbook/simulate-upgrades.ts: the one pre-send check of the v0.9.0 migrations (releases/v0.9.0-onevault-upgrade.yaml P1.85, decision D4-19).
// After the three implementations are deployed and before anything is scheduled, it eth_calls the real upgrade chain from the fund timelock:
//   1. rebalancer.upgradeToAndCall(rebalancerImpl, migrateV090())
//   2. fund.upgradeToAndCall(fundImpl, migrateV090(rebalancer)), with the Rebalancer proxy's ERC-1967 implementation slot overridden to rebalancerImpl
//      (the fund migration requires the Rebalancer to run 0.9.0: it calls lastBasketStepAt(); it reads nothing the Rebalancer migration writes)
//   3. queue.upgradeToAndCall(queueImpl, migrateV090(cancelBuffer, maxPause, matchBandBps)) (it depends on neither)
// A call that reverts fails the step with the decoded custom error (the build's ABIs), so the migrations' own requires decide, nothing re-implements them.
// It works on any RPC that serves eth_call with a state override (Base 8453 and the Twin). Nothing is sent.
//   bun scripts/runbook/simulate-upgrades.ts --rpc URL --timelock A --out BUILD/out
//       --rebalancer A --rebalancer-impl A --rebalancer-data HEX --fund A --fund-impl A --fund-data HEX --queue A --queue-impl A --queue-data HEX
// Exit 0 when all three succeed, 1 when one reverts, 2 on a usage error.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, decodeErrorResult, encodeFunctionData, getAddress, http, pad, parseAbi, type Abi, type Address, type Hex } from "../../publish-contracts/node_modules/viem";
import { UsageError, check, need, options, runMain } from "./cast-io.ts";

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const UPGRADE_ABI = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data)"]);
/** The artifacts whose custom errors a migration can revert with. */
export const ERROR_ARTIFACTS = ["Rebalancer", "RobotMoneyFund", "FlowQueue", "FundMigrateLib", "FlowMigrateLib", "GovernedUpgrade", "ERC1967Utils", "Initializable"];

export interface Leg { name: string; proxy: Address; impl: Address; data: Hex }
export interface CallRequest { from: Address; to: Address; data: Hex; stateOverride?: { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[] }
/** Runs one eth_call; resolves on success, rejects with the revert data (if any) on a revert. */
export type Caller = (c: CallRequest) => Promise<void>;

/** PURE. The three calls, in order, each with the state overrides that stand in for the earlier upgrades it depends on. */
export function upgradeCalls(timelock: Address, legs: { rebalancer: Leg; fund: Leg; queue: Leg }): CallRequest[] {
  const call = (l: Leg): CallRequest => ({ from: timelock, to: l.proxy, data: encodeFunctionData({ abi: UPGRADE_ABI, functionName: "upgradeToAndCall", args: [l.impl, l.data] }) });
  return [
    call(legs.rebalancer),
    { ...call(legs.fund), stateOverride: [{ address: legs.rebalancer.proxy, stateDiff: [{ slot: IMPLEMENTATION_SLOT, value: pad(legs.rebalancer.impl, { size: 32 }) }] }] },
    call(legs.queue),
  ];
}

/** PURE. The revert data in a viem call error, if it carries any. */
export function revertData(e: unknown): Hex | undefined {
  let x: unknown = e;
  for (let i = 0; i < 8 && x && typeof x === "object"; i++) {
    const d = (x as { data?: unknown }).data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d as Hex;
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") return (d as { data: Hex }).data;
    x = (x as { cause?: unknown }).cause;
  }
  return undefined;
}

/** PURE. A revert decoded with the given error ABI: `Name(args)`, or the raw selector. */
export function describeRevert(data: Hex | undefined, abi: Abi): string {
  if (!data || data === "0x") return "reverted without data";
  try {
    const r = decodeErrorResult({ abi, data });
    return `${r.errorName}(${(r.args ?? []).map(String).join(", ")})`;
  } catch {
    return `reverted with unknown error ${data.slice(0, 10)}`;
  }
}

export function loadErrorAbi(out: string): Abi {
  const abi: Abi[number][] = [];
  for (const name of ERROR_ARTIFACTS) {
    const p = join(out, `${name}.sol`, `${name}.json`);
    if (existsSync(p)) for (const x of (JSON.parse(readFileSync(p, "utf8")) as { abi: Abi }).abi) if (x.type === "error") abi.push(x);
  }
  return abi as Abi;
}

export async function simulate(caller: Caller, timelock: Address, legs: { rebalancer: Leg; fund: Leg; queue: Leg }, errors: Abi): Promise<void> {
  const calls = upgradeCalls(timelock, legs);
  const names = [legs.rebalancer.name, legs.fund.name, legs.queue.name];
  for (let i = 0; i < calls.length; i++) {
    try {
      await caller(calls[i]!);
    } catch (e) {
      check(false, `the ${names[i]} upgrade with its migration reverts from the timelock: ${describeRevert(revertData(e), errors)}`);
    }
    console.log(`${names[i]}: upgradeToAndCall with its migration succeeds from the timelock (simulated${calls[i]!.stateOverride ? ", the Rebalancer already upgraded" : ""})`);
  }
}

export function viemCaller(rpc: string): Caller {
  const client = createPublicClient({ transport: http(rpc) });
  return async (c) => { await client.call({ account: c.from, to: c.to, data: c.data, ...(c.stateOverride ? { stateOverride: c.stateOverride } : {}) }); };
}

if (import.meta.main) {
  await runMain("usage: simulate-upgrades.ts --rpc URL --timelock A --out BUILD/out --rebalancer A --rebalancer-impl A --rebalancer-data HEX --fund A --fund-impl A --fund-data HEX --queue A --queue-impl A --queue-data HEX", async () => {
    let o;
    try { o = options(process.argv.slice(2)).opts; } catch (e) { throw new UsageError((e as Error).message); }
    const [rpc, timelock, out] = need(o, "rpc", "timelock", "out");
    const leg = (n: string): Leg => { const [proxy, impl, data] = need(o, n, `${n}-impl`, `${n}-data`); return { name: n, proxy: getAddress(proxy!.toLowerCase()), impl: getAddress(impl!.toLowerCase()), data: data as Hex }; };
    await simulate(viemCaller(rpc!), getAddress(timelock!.toLowerCase()), { rebalancer: leg("rebalancer"), fund: leg("fund"), queue: leg("queue") }, loadErrorAbi(out!));
  });
}
