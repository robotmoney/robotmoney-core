// The four vault keys (rmUSDC, rmPROTO, rmRWA, rmHARD) and the three baskets, with no dependency (no viem). rmAGENT is retired under ADR-0009 and ADR-0017: no stage
// deploys it and no key names it. rmHARD (HardAssetsVault, PAXG) is the fourth router vault in its slot (ADR-0018). scripts/stage/core-stack.ts runs in CI jobs and on operator machines that never ran `bun install` in
// publish-contracts, so anything it imports must resolve without node_modules. sheet.ts re-exports these.
export const VAULT_KEYS = ["USDC", "PROTO", "RWA", "HARD"] as const;
export type VaultKey = (typeof VAULT_KEYS)[number];

/** The baskets (rmPROTO, rmRWA, rmHARD). rmUSDC is not a basket: it has no navDeviationGuardBps and no pool. */
export const BASKET_KEYS = ["PROTO", "RWA", "HARD"] as const satisfies readonly VaultKey[];

/**
 * Issue 1927: the vault keys of the PRIOR line this tool governs but never deploys: rmAGENT of the live v0.5.0 deployment (Deploy 3), retired by `govern --row retire-vault`
 * (ADR-0017). A v0.5.0 core checkout (--core-dir at that line's DEPLOY_SHA) names it in its stage table and its sheet carries VAULT_AGENT_* lines. The follow-on verbs of the
 * governed upgrade (deploy-implementation, govern, verify) read that deployment as it is. No deploy stage, no unpause row and no router vector of this tool ever names it.
 */
export const RETIRED_VAULT_KEYS = ["AGENT"] as const;
/**
 * Core 2008 (ADR-0018): the vault keys this CLI added after the prior lines (v0.5.0 and v0.6.0 have no rmHARD). A follow-on verb of a governed upgrade reads such a line's table as it
 * is, so a vault in this list that the line's table does not name is not required there. A deploy run never drops it: a new deployment has every VAULT_KEYS vault.
 */
export const ADDED_VAULT_KEYS = ["HARD"] as const;
export const isAddedVaultKey = (k: string): boolean => (ADDED_VAULT_KEYS as readonly string[]).includes(k);
export type RetiredVaultKey = (typeof RETIRED_VAULT_KEYS)[number];
export const RETIRED_VAULT_NAME: Record<RetiredVaultKey, string> = { AGENT: "rmAGENT" };
export const isRetiredVaultKey = (k: string): k is RetiredVaultKey => (RETIRED_VAULT_KEYS as readonly string[]).includes(k);
