// Canonical: docs/architecture.md §3 — Technology Stack

/**
 * Chain-ID classifier for the testnet/devnet USDC faucet UX (issue #261).
 *
 * The faucet code path — admin-panel Faucet tab and onboarding USDC drip —
 * is a HARD safety surface: it must be unreachable when the connected
 * wallet is on a real money chain. The classifier is the single source of
 * truth used by both the Faucet tab gate and the onboarding seed gate.
 *
 * Mainnet IDs: 1 (Ethereum), 8453 (Base). Anything else is treated as a
 * testnet/devnet (including the Robot Money smoke-test chain id 918453,
 * Sepolia 11155111, and Base Sepolia 84532). Conservative-by-default in
 * the *other* direction would be wrong here — we'd surface a faucet on
 * mainnet if a new mainnet chain id ever appeared — so the rule is
 * inverted: unknown ⇒ testnet, known-mainnet ⇒ mainnet.
 *
 * `0` is treated as `mainnet` because wagmi returns 0 when no chain is
 * connected yet; rendering the faucet during a disconnected boot is
 * worse than hiding it.
 *
 * Canonical: docs/prd.md (faucet must never appear on mainnet),
 * docs/testing/smoke-test-design.md (chain-id 918453).
 */

/** Mainnet chain IDs the dapp will ever encounter. Keep this list small. */
export const MAINNET_CHAIN_IDS: ReadonlyArray<number> = [
  1, // Ethereum mainnet
  8453, // Base mainnet
];

/** Smoke-test full-stack devnet (see docs/testing/smoke-test-design.md). */
export const ROBOT_MONEY_DEVNET_CHAIN_ID = 918453;

export type ChainClass = "mainnet" | "testnet";

/**
 * Classify a chain ID into mainnet vs. testnet/devnet. `0` and any
 * unrecognized but non-mainnet ID falls into `testnet` only when the
 * caller has already established the user *is* on a chain — disconnected
 * (chain id 0) is forced to `mainnet` so the faucet never renders before
 * a real chain is known.
 */
export function classifyChain(chainId: number): ChainClass {
  if (chainId === 0) return "mainnet";
  return MAINNET_CHAIN_IDS.includes(chainId) ? "mainnet" : "testnet";
}

/**
 * Shared drip amount used by BOTH the onboarding seed step and the admin
 * Faucet tab — issue #261 acceptance criterion requires a single source.
 * USDC has 6 decimals, so 100 USDC = 100 * 10^6 = 100_000_000 base units.
 */
export const FAUCET_DRIP_AMOUNT_USDC: bigint = 100_000_000n;

/**
 * Human-readable form of the USDC drip amount for UI rendering only. Pure
 * derivation from `FAUCET_DRIP_AMOUNT_USDC` so the two never drift.
 */
export const FAUCET_DRIP_AMOUNT_LABEL = "100 USDC";

/**
 * RM token drip amount for the Faucet tab (issue #365). RM uses 18 decimals;
 * 100 RM = 100 * 10^18 base units. Single source of truth for the RM drip
 * button — FaucetTab and FaucetTabView both read this constant.
 */
export const FAUCET_DRIP_AMOUNT_RM: bigint = 100_000_000_000_000_000_000n;

/**
 * Human-readable form of the RM drip amount for UI rendering only.
 */
export const FAUCET_DRIP_AMOUNT_RM_LABEL = "100 RM";
