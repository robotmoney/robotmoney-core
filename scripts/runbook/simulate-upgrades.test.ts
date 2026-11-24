// scripts/runbook/simulate-upgrades.test.ts: the pre-send simulation of a release's upgrade chain (v0.9.0 and v0.10.0 P1.85).
import { expect, test } from "bun:test";
import { decodeFunctionData, encodeErrorResult, getAddress, parseAbi, type Address, type Hex } from "../../publish-contracts/node_modules/viem";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { IMPLEMENTATION_SLOT, describeRevert, parseLegs, revertData, simulate, upgradeCalls, type CallRequest, type Leg } from "./simulate-upgrades.ts";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const TL = A(0x71);
const LEGS: Leg[] = [
  { name: "rebalancer", proxy: A(0xb1), impl: A(0xb2), data: "0x27491b91" as Hex },
  { name: "fund", proxy: A(0xf1), impl: A(0xf2), data: "0xd85cc223" as Hex },
  { name: "queue", proxy: A(0xa1), impl: A(0xa2), data: "0x1d74ec6f" as Hex },
];
/** v0.10.0: six legs, the adapter last. */
const LEGS6: Leg[] = [...LEGS, { name: "governance", proxy: A(0xc1), impl: A(0xc2), data: "0x" }, { name: "receipt", proxy: A(0xd1), impl: A(0xd2), data: "0x" }, { name: "adapter", proxy: A(0xe1), impl: A(0xe2), data: "0x" }];
const slot = (a: Address) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const ERRORS = parseAbi(["error OldLedgerNotEmpty(address ledger, uint256 count, uint256 held)", "error LegacyEscrowOpen(uint256 pendingUsdc, uint256 escrowShares)"]);
const UPGRADE = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data)"]);

test("the calls: rebalancer, fund (with the Rebalancer's implementation slot overridden), queue (both overridden); all from the timelock", () => {
  const c = upgradeCalls(TL, LEGS);
  expect(c.map((x) => x.to)).toEqual([A(0xb1), A(0xf1), A(0xa1)]);
  expect(c.every((x) => x.from === TL)).toBe(true);
  expect(decodeFunctionData({ abi: UPGRADE, data: c[1]!.data }).args).toEqual([A(0xf2), "0xd85cc223"]);
  expect(c[0]!.stateOverride).toBeUndefined();
  expect(c[1]!.stateOverride).toEqual([{ address: A(0xb1), stateDiff: [{ slot: IMPLEMENTATION_SLOT, value: slot(A(0xb2)) }] }]);
  expect(c[2]!.stateOverride?.map((o) => o.address)).toEqual([A(0xb1), A(0xf1)]);
});

test("v0.10.0: six legs (rebalancer, fund, queue, governance, receipt, adapter) in order, each after every earlier leg's slot override", async () => {
  const seen: CallRequest[] = [];
  await simulate(async (c) => { seen.push(c); }, TL, LEGS6, ERRORS);
  expect(seen.map((c) => c.to)).toEqual(LEGS6.map((l) => l.proxy));
  seen.forEach((c, i) => {
    expect(decodeFunctionData({ abi: UPGRADE, data: c.data }).args).toEqual([LEGS6[i]!.impl, LEGS6[i]!.data]);
    expect((c.stateOverride ?? []).map((o) => [o.address, o.stateDiff[0]!.value.toLowerCase()])).toEqual(LEGS6.slice(0, i).map((l) => [l.proxy, slot(l.impl)]));
  });
  const caller = async (c: CallRequest) => { if (c.to === A(0xd1)) throw Object.assign(new Error("execution reverted"), { cause: { data: "0x" } }); };
  await expect(simulate(caller, TL, LEGS6, ERRORS)).rejects.toThrow("the receipt upgrade with its migration reverts from the timelock: reverted without data");
});

test("the command line: --leg in order, or the v0.9.0 named flags; a bad leg is a usage error (exit 2); a revert exits 1", () => {
  const legArg = (l: Leg) => ["--leg", `${l.name}=${l.proxy},${l.impl},${l.data}`];
  const p = parseLegs(["--rpc", "http://r", ...LEGS6.flatMap(legArg), "--timelock", TL]);
  expect(p.legs).toEqual(LEGS6);
  expect(p.opts).toEqual({ rpc: "http://r", timelock: TL });
  const named = parseLegs(LEGS.flatMap((l) => [`--${l.name}`, l.proxy, `--${l.name}-impl`, l.impl, `--${l.name}-data`, l.data]));
  expect(named.legs).toEqual(LEGS);
  const extra = LEGS6.slice(3);
  expect(parseLegs([...LEGS, ...extra].flatMap((l) => [`--${l.name}`, l.proxy, `--${l.name}-impl`, l.impl, `--${l.name}-data`, l.data])).legs).toEqual(LEGS6);
  expect(() => parseLegs(["--leg", "x=0x1,0x2,0x"])).toThrow("NAME=PROXY,IMPL,DATA");
  const script = join(import.meta.dir, "simulate-upgrades.ts");
  expect(spawnSync("bun", [script, "--leg", "bad"], { encoding: "utf8" }).status).toBe(2);
  // an RPC that refuses every call: the first leg reverts and the run exits 1 naming it
  const r = spawnSync("bun", [script, "--rpc", "http://127.0.0.1:9", "--timelock", TL, "--out", "/nonexistent", ...LEGS6.flatMap(legArg)], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("the rebalancer upgrade with its migration reverts");
});

test("a revert names the migration's custom error; the run stops at the first failing leg", async () => {
  const seen: CallRequest[] = [];
  const data = encodeErrorResult({ abi: ERRORS, errorName: "OldLedgerNotEmpty", args: [A(0xed), 1n, 0n] });
  const caller = async (c: CallRequest) => { seen.push(c); if (c.to === A(0xf1)) throw Object.assign(new Error("execution reverted"), { cause: { data } }); };
  await expect(simulate(caller, TL, LEGS, ERRORS)).rejects.toThrow(`the fund upgrade with its migration reverts from the timelock: OldLedgerNotEmpty(${A(0xed)}, 1, 0)`);
  expect(seen.map((c) => c.to)).toEqual([A(0xb1), A(0xf1)]);
  await expect(simulate(async () => {}, TL, LEGS, ERRORS)).resolves.toBeUndefined();
});

test("revert data is found in nested viem errors and decoded, or reported raw", () => {
  const data = encodeErrorResult({ abi: ERRORS, errorName: "LegacyEscrowOpen", args: [5n, 0n] });
  expect(revertData({ cause: { cause: { data: { data } } } })).toBe(data);
  expect(describeRevert(data, ERRORS)).toBe("LegacyEscrowOpen(5, 0)");
  expect(describeRevert("0xdeadbeef", ERRORS)).toBe("reverted with unknown error 0xdeadbeef");
  expect(describeRevert(undefined, ERRORS)).toBe("reverted without data");
}, 60_000);
