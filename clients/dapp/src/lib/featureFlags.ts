/**
 * Feature flags for the human dapp.
 *
 * `historyPane` gates the optional explorer-API-backed history pane
 * described in docs/implementation-plan.md §12 and issue #88. The plan
 * states "Dapp reads live chain state directly through RPC and may use
 * phase 5 API for historical display." The pane is hidden by default
 * because it introduces a hard dependency on the phase-5 explorer API
 * (`docs/technical/explorer-schema-decisions.md`); operators must opt in
 * per-deployment via `VITE_HISTORY_PANE=true`.
 *
 * Browser-side keypair generation is intentionally not a flag. The dapp
 * never generates or holds private keys; see
 * docs/technical/dapp-credential-decisions.md §3.1.
 */
export interface FeatureFlags {
  readonly historyPane: boolean;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  historyPane: false,
};

/**
 * Resolve the active flag set. We read import.meta.env so the build
 * surface (Vite) controls enablement; runtime toggles are intentionally
 * not supported, because flipping the flag must require a build + ADR.
 */
export function resolveFlags(env: Record<string, string | undefined> = {}): FeatureFlags {
  return {
    historyPane: env.VITE_HISTORY_PANE === "true",
  };
}
