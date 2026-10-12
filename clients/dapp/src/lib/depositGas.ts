// Canonical: docs/technical/deposit-gas-1777.md

/**
 * Gas limits for deposits (core issue 1777). Both entrypoints revert `InsufficientGas` below a floor
 * that is checked at entry against `gasleft()`, so a limit equal to the floor still fails: the
 * transaction's intrinsic cost and the code before the check come out of it first. The limits below
 * sit above the floors with headroom. They match the harness limits that succeeded on Base.
 *
 * - Vault `deposit`: floor 1,600,000 (`DEPOSIT_ENTRY_GAS_FLOOR`), limit 2,500,000.
 * - Router `deposit`: floor `legs * 1,700,000`, 6,800,000 for the 4-leg router
 *   (`InsufficientGas(5948330, 6800000)` at a 6,000,000 limit), limit 8,000,000.
 *
 * Unused gas is refunded, so a high limit costs nothing extra. It only raises the balance a wallet
 * needs for the maximum fee.
 */
export const VAULT_DEPOSIT_GAS_FLOOR = 1_600_000n;
export const VAULT_DEPOSIT_GAS_LIMIT = 2_500_000n;
export const ROUTER_DEPOSIT_GAS_FLOOR = 6_800_000n;
export const ROUTER_DEPOSIT_GAS_LIMIT = 8_000_000n;

/** A simulated request with the gas limit set. A caller-set `gas` that is higher wins. Pure. */
export function withGasLimit<T extends object>(request: T, limit: bigint): T & { gas: bigint } {
  const existing = (request as { gas?: unknown }).gas;
  const gas = typeof existing === "bigint" && existing > limit ? existing : limit;
  return { ...request, gas };
}
