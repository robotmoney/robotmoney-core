// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * The vault registry context object and its hook, kept free of wagmi so a component that only
 * reads the cached list (the agent destination picker) does not pull the chain-read provider
 * into its import graph. `VaultRegistryContext.tsx` provides the value.
 */
import { createContext, useContext } from "react";
import type { VaultRecord } from "./abi";

export interface VaultRegistryState {
  /** All registered vaults from the latest registry read. Empty during load. */
  vaults: readonly VaultRecord[];
  isLoading: boolean;
  error: Error | null;
  /** Trigger a re-fetch of the entire registry. */
  refresh: () => void;
}

export const VaultRegistryContext = createContext<VaultRegistryState>({
  vaults: [],
  isLoading: false,
  error: null,
  refresh: () => undefined,
});

/**
 * Hook for consuming vault registry state in any descendant component.
 * Must be used inside a VaultRegistryProvider tree.
 */
export function useVaultRegistry(): VaultRegistryState {
  return useContext(VaultRegistryContext);
}
