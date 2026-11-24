#!/usr/bin/env bun
// scripts/runbook/simulate-upgrades.ts: the one pre-send check of a release's upgrade chain (v0.9.0 P1.85, decision D4-19; v0.10.0 P1.85, decision D10-1).
// After the implementations are deployed and before anything is scheduled, it eth_calls every upgrade of the chain from the fund timelock, in the order given,
// each with the ERC-1967 implementation slot of every EARLIER leg's proxy overridden to that leg's new implementation (the earlier upgrades stand executed):
//   bun scripts/runbook/simulate-upgrades.ts --rpc URL --timelock A --out BUILD/out --leg NAME=PROXY,IMPL,DATA [--leg ...]
// v0.10.0 passes six legs: rebalancer, fund, queue, governance, receipt, adapter (migrateV0100() = 0x42829c5e on each but the fund, whose data is 0x).
// The named-flag form below is the same chain: rebalancer, fund, queue, then the optional --governance, --receipt and --adapter (each with -impl and -data).
// The v0.9.0 chain:
//   1. rebalancer.upgradeToAndCall(rebalancerImpl, migrateV090())
//   2. fund.upgradeToAndCall(fundImpl, migrateV090(rebalancer)), with the Rebalancer proxy's ERC-1967 implementation slot overridden to rebalancerImpl
//      (the fund migration requires the Rebalancer to run 0.9.0: it calls lastBasketStepAt(); it reads nothing the Rebalancer migration writes)
//   3. queue.upgradeToAndCall(queueImpl, migrateV090(cancelBuffer, maxPause, matchBandBps)) (it depends on neither)
// A call that reverts fails the step with the decoded custom error (the build's ABIs), so the migrations' own requires decide, nothing re-implements them.
// It works on any RPC that serves eth_call with a state override (Base 8453 and the Twin). Nothing is sent.
//   bun scripts/runbook/simulate-upgrades.ts --rpc URL --timelock A --out BUILD/out
//       --rebalancer A --rebalancer-impl A --rebalancer-data HEX --fund A --fund-impl A --fund-data HEX --queue A --queue-impl A --queue-data HEX
// Exit 0 when every leg succeeds, 1 when one reverts (naming it), 2 on a usage error.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, decodeErrorResult, encodeFunctionData, getAddress, http, pad, parseAbi, type Abi, type Address, type Hex } from "../../publish-contracts/node_modules/viem";
import { UsageError, check, need, options, runMain } from "./cast-io.ts";

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const UPGRADE_ABI = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data)"]);
/** The artifacts whose custom errors a migration can revert with. */
export const ERROR_ARTIFACTS = ["Rebalancer", "RobotMoneyFund", "FlowQueue", "RebalanceGovernance", "ConsensusRecommendationReceipt", "UniswapV3ExactOutSwapAdapterUpgradeable", "FundMigrateLib", "FlowMigrateLib", "GovernedUpgrade", "ERC1967Utils", "Initializable"];

export interface Leg { name: string; proxy: Address; impl: Address; data: Hex }
export interface CallRequest { from: Address; to: Address; data: Hex; stateOverride?: { address: Address; stateDiff: { slot: Hex; value: Hex }[] }[] }
/** Runs one eth_call; resolves on success, rejects with the revert data (if any) on a revert. */
export type Caller = (c: CallRequest) => Promise<void>;

/** PURE. One call per leg, in order, each with the implementation slot of every earlier leg's proxy overridden to that leg's new implementation. */
export function upgradeCalls(timelock: Address, legs: readonly Leg[]): CallRequest[] {
  return legs.map((l, i) => {
    const data = encodeFunctionData({ abi: UPGRADE_ABI, functionName: "upgradeToAndCall", args: [l.impl, l.data] });
    const earlier = legs.slice(0, i).map((e) => ({ address: e.proxy, stateDiff: [{ slot: IMPLEMENTATION_SLOT, value: pad(e.impl, { size: 32 }) }] }));
    return { from: timelock, to: l.proxy, data, ...(earlier.length ? { stateOverride: earlier } : {}) };
  });
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

export async function simulate(caller: Caller, timelock: Address, legs: readonly Leg[], errors: Abi): Promise<void> {
  const calls = upgradeCalls(timelock, legs);
  for (let i = 0; i < calls.length; i++) {
    try {
      await caller(calls[i]!);
    } catch (e) {
      check(false, `the ${legs[i]!.name} upgrade with its migration reverts from the timelock: ${describeRevert(revertData(e), errors)}`);
    }
    console.log(`${legs[i]!.name}: upgradeToAndCall with its migration succeeds from the timelock (simulated${i ? `, after ${legs.slice(0, i).map((l) => l.name).join(", ")}` : ""})`);
  }
}

/** The optional named legs after the queue, in release order (v0.10.0, issue 2062). */
export const EXTRA_LEGS = ["governance", "receipt", "adapter"] as const;

/** PURE. The legs of the command line: every --leg NAME=PROXY,IMPL,DATA in order, else the named flags (rebalancer, fund, queue, then any of governance, receipt, adapter). */
export function parseLegs(argv: string[]): { opts: Record<string, string>; legs: Leg[] } {
  const rest: string[] = [];
  const legs: Leg[] = [];
  const addr = (a: string) => getAddress(a.toLowerCase());
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--leg") { rest.push(argv[i]!); continue; }
    const m = /^([A-Za-z0-9_-]+)=(0x[0-9a-fA-F]{40}),(0x[0-9a-fA-F]{40}),(0x(?:[0-9a-fA-F]{2})*)$/.exec(argv[++i] ?? "");
    if (!m) throw new UsageError(`--leg ${argv[i] ?? ""} is not NAME=PROXY,IMPL,DATA`);
    legs.push({ name: m[1]!, proxy: addr(m[2]!), impl: addr(m[3]!), data: m[4]! as Hex });
  }
  let opts: Record<string, string>;
  try { opts = options(rest).opts; } catch (e) { throw new UsageError((e as Error).message); }
  if (!legs.length) {
    for (const n of ["rebalancer", "fund", "queue", ...EXTRA_LEGS.filter((x) => opts[x] !== undefined)]) {
      const [proxy, impl, data] = need(opts, n, `${n}-impl`, `${n}-data`);
      legs.push({ name: n, proxy: addr(proxy!), impl: addr(impl!), data: data as Hex });
    }
  }
  return { opts, legs };
}

export function viemCaller(rpc: string): Caller {
  const client = createPublicClient({ transport: http(rpc) });
  return async (c) => { await client.call({ account: c.from, to: c.to, data: c.data, ...(c.stateOverride ? { stateOverride: c.stateOverride } : {}) }); };
}

if (import.meta.main) {
  await runMain("usage: simulate-upgrades.ts --rpc URL --timelock A --out BUILD/out (--leg NAME=PROXY,IMPL,DATA ... | --rebalancer A --rebalancer-impl A --rebalancer-data HEX --fund A --fund-impl A --fund-data HEX --queue A --queue-impl A --queue-data HEX)", async () => {
    const { opts, legs } = parseLegs(process.argv.slice(2));
    const [rpc, timelock, out] = need(opts, "rpc", "timelock", "out");
    await simulate(viemCaller(rpc!), getAddress(timelock!.toLowerCase()), legs, loadErrorAbi(out!));
  });
}
