// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.2 step 2 (Gas limit).
// settle() runs up to two sides. Before each, FlowSettleLib._runSide reverts SettleSideOutOfGas unless
// gasleft() >= budget + budget/63 + SIDE_CALL_MARGIN, with budget = sideGas(assets, fills). An eth_estimateGas point
// estimate does not leave that margin (Base 8453, 2026-11-23), so the settle limit has a floor from the same budget.
// The constants are internal to the library, so they are copied here; test/gas.test.ts pins them to the .sol file.

export const SIDE_GAS_BASE = 2_000_000n;
export const SIDE_GAS_PER_ASSET = 600_000n;
export const SIDE_GAS_PER_FILL = 450_000n;
export const SIDE_CALL_MARGIN = 10_000n;
/** Gas outside the two side calls: the walk, pricing, the cursor moves and the KeeperAccount hop. */
export const SETTLE_OVERHEAD = 1_500_000n;

/** FlowSettleLib.sideGas. */
export const sideGas = (assets: bigint, fills: bigint) => SIDE_GAS_BASE + assets * SIDE_GAS_PER_ASSET + fills * SIDE_GAS_PER_FILL;

/** What one side needs left before its call: budget + budget/63 + margin. */
export const sideNeed = (assets: bigint, fills: bigint) => {
  const b = sideGas(assets, fills);
  return b + b / 63n + SIDE_CALL_MARGIN;
};

/** 2 × sideNeed(assets, maxRequests) + overhead, times `factor` (2 on the SettleSideOutOfGas retry). */
export const settleFloor = (assets: bigint, maxRequests: bigint, factor = 1n) =>
  (2n * sideNeed(assets, maxRequests) + SETTLE_OVERHEAD) * factor;

/** ceil(estimate × multiplier), in integer math (multiplier to 1/1000). */
export const scaleEstimate = (estimate: bigint, multiplier: number) =>
  (estimate * BigInt(Math.round(multiplier * 1000)) + 999n) / 1000n;

/** max(estimate × multiplier, floor), capped at the block gas limit. */
export function gasLimit(estimate: bigint, multiplier: number, blockGasLimit: bigint, floor = 0n): bigint {
  const want = scaleEstimate(estimate, multiplier);
  const l = want > floor ? want : floor;
  return l > blockGasLimit ? blockGasLimit : l;
}
