// scripts/runbook/simulate-upgrades.test.ts: the pre-send simulation of the three v0.9.0 upgrades with their migrations (P1.85, decision D4-19).
import { expect, test } from "bun:test";
import { decodeFunctionData, encodeErrorResult, getAddress, parseAbi, type Address, type Hex } from "../../publish-contracts/node_modules/viem";
import { IMPLEMENTATION_SLOT, describeRevert, revertData, simulate, upgradeCalls, type CallRequest, type Leg } from "./simulate-upgrades.ts";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const TL = A(0x71);
const LEGS = {
  rebalancer: { name: "rebalancer", proxy: A(0xb1), impl: A(0xb2), data: "0x27491b91" as Hex },
  fund: { name: "fund", proxy: A(0xf1), impl: A(0xf2), data: "0xd85cc223" as Hex },
  queue: { name: "queue", proxy: A(0xa1), impl: A(0xa2), data: "0x1d74ec6f" as Hex },
} satisfies Record<string, Leg>;
const ERRORS = parseAbi(["error OldLedgerNotEmpty(address ledger, uint256 count, uint256 held)", "error LegacyEscrowOpen(uint256 pendingUsdc, uint256 escrowShares)"]);
const UPGRADE = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data)"]);

test("the calls: rebalancer, fund (with the Rebalancer's implementation slot overridden), queue; all from the timelock", () => {
  const c = upgradeCalls(TL, LEGS);
  expect(c.map((x) => x.to)).toEqual([A(0xb1), A(0xf1), A(0xa1)]);
  expect(c.every((x) => x.from === TL)).toBe(true);
  expect(decodeFunctionData({ abi: UPGRADE, data: c[1]!.data }).args).toEqual([A(0xf2), "0xd85cc223"]);
  expect(c[0]!.stateOverride).toBeUndefined();
  expect(c[2]!.stateOverride).toBeUndefined();
  expect(c[1]!.stateOverride).toEqual([{ address: A(0xb1), stateDiff: [{ slot: IMPLEMENTATION_SLOT, value: `0x${"0".repeat(24)}${A(0xb2).slice(2).toLowerCase()}` }] }]);
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
});
