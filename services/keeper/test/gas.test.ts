// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.2 step 2. The settle limit is
// max(estimate × gasMultiplier, 2 × sideGas + overhead), capped at the block limit, and the SIDE_GAS_* constants match
// contracts/lib/FlowSettleLib.sol: a contract change breaks this test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  gasLimit, scaleEstimate, SETTLE_OVERHEAD, settleFloor, SIDE_CALL_MARGIN, SIDE_GAS_BASE, SIDE_GAS_PER_ASSET, SIDE_GAS_PER_FILL,
  sideGas, sideNeed,
} from "../src/gas.ts";

const SOL = readFileSync(resolve(import.meta.dir, "../../../contracts/lib/FlowSettleLib.sol"), "utf8");
const solConst = (name: string) => {
  const m = SOL.match(new RegExp(`uint256 internal constant ${name} = ([0-9_]+);`));
  if (!m) throw new Error(`${name} not found in FlowSettleLib.sol`);
  return BigInt(m[1]!.replaceAll("_", ""));
};

describe("settle gas floor", () => {
  test("SIDE_GAS_* and SIDE_CALL_MARGIN match contracts/lib/FlowSettleLib.sol", () => {
    expect(SIDE_GAS_BASE).toBe(solConst("SIDE_GAS_BASE"));
    expect(SIDE_GAS_PER_ASSET).toBe(solConst("SIDE_GAS_PER_ASSET"));
    expect(SIDE_GAS_PER_FILL).toBe(solConst("SIDE_GAS_PER_FILL"));
    expect(SIDE_CALL_MARGIN).toBe(solConst("SIDE_CALL_MARGIN"));
  });

  test("the guard and sideGas formula are still the ones the floor models", () => {
    expect(SOL).toContain("return SIDE_GAS_BASE + assets * SIDE_GAS_PER_ASSET + fills * SIDE_GAS_PER_FILL;");
    expect(SOL).toContain("if (gasleft() < budget + budget / 63 + SIDE_CALL_MARGIN) {");
  });

  test("sideGas and the floor follow the contract budget", () => {
    expect(sideGas(3n, 100n)).toBe(2_000_000n + 3n * 600_000n + 100n * 450_000n);
    const need = sideGas(3n, 100n) + sideGas(3n, 100n) / 63n + 10_000n;
    expect(sideNeed(3n, 100n)).toBe(need);
    expect(settleFloor(3n, 100n)).toBe(2n * need + SETTLE_OVERHEAD);
    expect(settleFloor(3n, 100n, 2n)).toBe(2n * settleFloor(3n, 100n));
  });

  test("a low estimate is raised to the floor", () => {
    // The Base 8453 revert: an 8.07M limit for a settle whose guard needed more.
    const floor = settleFloor(4n, 10n);
    expect(gasLimit(5_378_955n, 1.5, 150_000_000n, floor)).toBe(floor);
    expect(floor).toBeGreaterThan(8_068_432n);
  });

  test("a high estimate × multiplier beats the floor", () => {
    expect(gasLimit(20_000_000n, 1.5, 150_000_000n, 10_000_000n)).toBe(30_000_000n);
    expect(scaleEstimate(1001n, 1.5)).toBe(1502n); // rounded up
  });

  test("the limit is capped at the block gas limit", () => {
    expect(gasLimit(1_000_000n, 1.5, 30_000_000n, settleFloor(5n, 100n))).toBe(30_000_000n);
    expect(gasLimit(1_000_000n, 1.5, 30_000_000n, settleFloor(5n, 100n, 2n))).toBe(30_000_000n);
  });

  test("calls other than settle use the estimate × multiplier only", () => {
    expect(gasLimit(200_000n, 1.5, 30_000_000n)).toBe(300_000n);
  });
});
