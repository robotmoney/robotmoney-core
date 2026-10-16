// The four vault keys and the three baskets, with no dependency (no viem). scripts/stage/core-stack.ts runs in CI jobs and on operator machines that never ran `bun install` in
// publish-contracts, so anything it imports must resolve without node_modules. sheet.ts re-exports these.
export const VAULT_KEYS = ["USDC", "PROTO", "AGENT", "RWA"] as const;
export type VaultKey = (typeof VAULT_KEYS)[number];

/** The baskets (rmPROTO, rmAGENT, rmRWA). rmUSDC is not a basket: it has no navDeviationGuardBps and no pool. */
export const BASKET_KEYS = ["PROTO", "AGENT", "RWA"] as const satisfies readonly VaultKey[];
