// The three vault keys (rmUSDC, rmPROTO, rmRWA) and the two baskets. rmAGENT is retired under ADR-0009 and ADR-0017: no stage deploys it and no key names it., with no dependency (no viem). scripts/stage/core-stack.ts runs in CI jobs and on operator machines that never ran `bun install` in
// publish-contracts, so anything it imports must resolve without node_modules. sheet.ts re-exports these.
export const VAULT_KEYS = ["USDC", "PROTO", "RWA"] as const;
export type VaultKey = (typeof VAULT_KEYS)[number];

/** The baskets (rmPROTO, rmRWA). rmUSDC is not a basket: it has no navDeviationGuardBps and no pool. */
export const BASKET_KEYS = ["PROTO", "RWA"] as const satisfies readonly VaultKey[];

/**
 * Issue 1927: the vault keys of the PRIOR line this tool governs but never deploys: rmAGENT of the live v0.5.0 deployment (Deploy 3), retired by `govern --row retire-vault`
 * (ADR-0017). A v0.5.0 core checkout (--core-dir at that line's DEPLOY_SHA) names it in its stage table and its sheet carries VAULT_AGENT_* lines. The follow-on verbs of the
 * governed upgrade (deploy-implementation, govern, verify) read that deployment as it is. No deploy stage, no unpause row and no router vector of this tool ever names it.
 */
export const RETIRED_VAULT_KEYS = ["AGENT"] as const;
export type RetiredVaultKey = (typeof RETIRED_VAULT_KEYS)[number];
export const RETIRED_VAULT_NAME: Record<RetiredVaultKey, string> = { AGENT: "rmAGENT" };
export const isRetiredVaultKey = (k: string): k is RetiredVaultKey => (RETIRED_VAULT_KEYS as readonly string[]).includes(k);
