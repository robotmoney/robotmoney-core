/**
 * Cross-system feature flag registry — TypeScript surface.
 * Canonical source: config/feature-flags.json
 * Implements: issue #389
 *
 * Flag IDs are stable integer bit positions used in the on-chain uint256
 * bitmap (FeatureFlags.sol) and the Rust indexer (feature_flags.rs).
 * Never renumber an ID once assigned; mark deprecated flags as retired in
 * config/feature-flags.json.
 *
 * Runtime enablement is controlled by the VITE_FEATURE_FLAGS environment
 * variable, which is a decimal integer whose bits correspond to the flag IDs.
 * Example: VITE_FEATURE_FLAGS=3 enables flags 0 (MULTI_VAULT_ENABLED) and
 * 1 (PORTFOLIO_ROUTER_ENABLED).
 */

// ---------------------------------------------------------------------------
// Flag ID constants — mirror config/feature-flags.json exactly.
// ---------------------------------------------------------------------------

/** @see config/feature-flags.json id=0 */
export const MULTI_VAULT_ENABLED = 0 as const;

/** @see config/feature-flags.json id=1 */
export const PORTFOLIO_ROUTER_ENABLED = 1 as const;

/** @see config/feature-flags.json id=2 */
export const INDEXER_MULTI_VAULT_EVENTS = 2 as const;

// ---------------------------------------------------------------------------
// Registry — typed, derivable from the JSON source.
// ---------------------------------------------------------------------------

export interface FlagEntry {
  readonly id: number;
  readonly name: string;
  readonly description: string;
}

export const FLAG_REGISTRY: readonly FlagEntry[] = [
  {
    id: MULTI_VAULT_ENABLED,
    name: "MULTI_VAULT_ENABLED",
    description:
      "Gates multi-vault UI surfaces in the dapp (VaultCards, VaultList tab) and multi-vault event indexing paths in the explorer-indexer.",
  },
  {
    id: PORTFOLIO_ROUTER_ENABLED,
    name: "PORTFOLIO_ROUTER_ENABLED",
    description:
      "Gates the router deposit path in the dapp (RouterDepositSection) and RouterGovernance panel.",
  },
  {
    id: INDEXER_MULTI_VAULT_EVENTS,
    name: "INDEXER_MULTI_VAULT_EVENTS",
    description:
      "Gates VaultRegistered and VaultStatusChanged event ingestion in the explorer-indexer.",
  },
] as const;

// ---------------------------------------------------------------------------
// Bitmap helpers
// ---------------------------------------------------------------------------

/**
 * Returns true iff `flagId` is set in `bitmap`.
 * Mirrors FeatureFlags.isEnabled(flagId, bitmap) in Solidity.
 */
export function isEnabled(flagId: number, bitmap: number): boolean {
  return ((bitmap >> flagId) & 1) === 1;
}

/**
 * Parse the VITE_FEATURE_FLAGS env var (decimal integer) into a bitmap.
 * Returns 0 (all flags off) when the value is absent or non-numeric.
 */
export function parseFlagBitmap(env: Record<string, string | undefined> = {}): number {
  const raw = env.VITE_FEATURE_FLAGS;
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
