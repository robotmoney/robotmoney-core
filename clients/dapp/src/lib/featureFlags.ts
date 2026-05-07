/**
 * Feature flags for the human dapp.
 *
 * `browserGeneratedCredential` gates the fork-mode-only software-keypair
 * generation flow described in
 * docs/technical/dapp-credential-decisions.md §3.1. The decision record
 * mandates this flag default to `false` and stay off until a
 * `security-review` issue ships an explicit enable.
 */
export interface FeatureFlags {
  readonly browserGeneratedCredential: boolean;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  browserGeneratedCredential: false,
};

/**
 * Resolve the active flag set. We read import.meta.env so the build
 * surface (Vite) controls enablement; runtime toggles are intentionally
 * not supported, because flipping the flag must require a build + ADR.
 */
export function resolveFlags(env: Record<string, string | undefined> = {}): FeatureFlags {
  return {
    browserGeneratedCredential: env.VITE_BROWSER_KEYGEN === "true",
  };
}
