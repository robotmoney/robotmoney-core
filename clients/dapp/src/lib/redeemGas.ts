// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * Temporary redeem gas workaround (dapp issue 1760, core issue 1758).
 *
 * On Base mainnet an rmUSDC `redeem` reverts Panic(0x11) when its gas is ESTIMATED against the `pending`
 * block, which is what a wallet does. The same call is fine at `latest` and uses about 0.94M to 1.0M gas.
 * Until core issue 1758 fixes the contract, a redeem is sent with a fixed gas limit so the wallet never
 * estimates it.
 *
 * REMOVE THE WORKAROUND BY SETTING THIS CONSTANT TO `undefined` (then delete this file with 1758).
 */
export const REDEEM_GAS_LIMIT_WORKAROUND_1758: bigint | undefined = 2_500_000n;

/** The write variables with the redeem gas limit added when it applies. Pure. */
export function withRedeemGasWorkaround<T>(variables: T): T {
  const limit = REDEEM_GAS_LIMIT_WORKAROUND_1758;
  if (limit === undefined || typeof variables !== "object" || variables === null) return variables;
  const v = variables as { functionName?: unknown; gas?: unknown };
  if (v.functionName !== "redeem" || v.gas !== undefined) return variables;
  return { ...variables, gas: limit };
}
