// Canonical: docs/technical/deposit-gas-1777.md

/**
 * Gas limits for deposits (core issue 1777). Both entrypoints revert `InsufficientGas` below a floor
 * that is checked at entry against `gasleft()`, so a limit equal to the floor still fails: the
 * transaction's intrinsic cost and the code before the check come out of it first. The limits below
 * sit above the floors with headroom. They match the harness limits that succeeded on Base.
 *
 * - Vault `deposit`: floor 1,600,000 (`DEPOSIT_ENTRY_GAS_FLOOR`), limit 2,500,000.
 * - Router `deposit`: floor `legs * 1,700,000` (`DEPOSIT_GAS_PER_LEG`), where `legs` is the length of
 *   the router's effective weight vector. Limit `legs * 1,700,000 + 1,200,000`: 8,000,000 for the
 *   4-leg router (`InsufficientGas(5948330, 6800000)` at a 6,000,000 limit). The limit follows the
 *   leg count (QA plan U3): a fixed 8,000,000 is below the 8,500,000 floor of a fifth leg.
 *
 * Unused gas is refunded, so a high limit costs nothing extra. It only raises the balance a wallet
 * needs for the maximum fee.
 */
export const VAULT_DEPOSIT_GAS_FLOOR = 1_600_000n;
export const VAULT_DEPOSIT_GAS_LIMIT = 2_500_000n;
/** `PortfolioRouter.DEPOSIT_GAS_PER_LEG`: the router's entry floor per effective-weight leg. */
export const ROUTER_DEPOSIT_GAS_PER_LEG = 1_700_000n;
/** Headroom above the router floor for intrinsic gas and the code before the entry check. */
export const ROUTER_DEPOSIT_GAS_HEADROOM = 1_200_000n;

/** The router's entry floor for `legs` effective-weight legs (zero-weight legs count). Pure. */
export function routerDepositGasFloor(legs: number): bigint {
  return BigInt(Math.max(0, Math.trunc(legs))) * ROUTER_DEPOSIT_GAS_PER_LEG;
}

/** The gas limit sent with a router deposit over `legs` effective-weight legs. Pure. */
export function routerDepositGasLimit(legs: number): bigint {
  return routerDepositGasFloor(legs) + ROUTER_DEPOSIT_GAS_HEADROOM;
}

/** A simulated request with the gas limit set. A caller-set `gas` that is higher wins. Pure. */
export function withGasLimit<T extends object>(request: T, limit: bigint): T & { gas: bigint } {
  const existing = (request as { gas?: unknown }).gas;
  const gas = typeof existing === "bigint" && existing > limit ? existing : limit;
  return { ...request, gas };
}
