// Canonical: docs/technical/redeem-gas-1482.md (core issue 1778)

/**
 * A basket vault (rmPROTO, rmAGENT, rmRWA) sells every leg through a DEX with a 1 percent price floor.
 * A position of a few cents leaves a leg of a handful of token base units, and the pool's one-unit
 * rounding then misses the floor: the simulated USDC redeem reverts "Too little received". The
 * supported exit is `redeemInKind(shares, receiver, owner)`, which pays the basket tokens and swaps nothing.
 */
export const TOO_LITTLE_RECEIVED_HINT =
  "This position is too small to sell back to USDC at the vault's price floor. " +
  "You can still exit: call redeemInKind(shares, receiver, owner) on the vault. It pays out the " +
  "basket tokens directly and sells nothing.";

/** The in-kind exit hint when a USDC redeem simulation failed with "Too little received", else null. */
export function redeemFailureHint(message: string | undefined): string | null {
  return message?.includes("Too little received") ? TOO_LITTLE_RECEIVED_HINT : null;
}
