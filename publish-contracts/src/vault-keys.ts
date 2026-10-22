// The three vault keys (rmUSDC, rmPROTO, rmRWA) and the two baskets. rmAGENT is retired under ADR-0009 and ADR-0017: no stage deploys it and no key names it., with no dependency (no viem). scripts/stage/core-stack.ts runs in CI jobs and on operator machines that never ran `bun install` in
// publish-contracts, so anything it imports must resolve without node_modules. sheet.ts re-exports these.
export const VAULT_KEYS = ["USDC", "PROTO", "RWA"] as const;
export type VaultKey = (typeof VAULT_KEYS)[number];

/** The baskets (rmPROTO, rmRWA). rmUSDC is not a basket: it has no navDeviationGuardBps and no pool. */
export const BASKET_KEYS = ["PROTO", "RWA"] as const satisfies readonly VaultKey[];
