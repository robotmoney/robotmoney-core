// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * RouterContext — shared router data-fetching seam (issue #417).
 *
 * Provides the active vault list from `router.activeVaults()` to all
 * downstream components from a single read. RouterDepositTab and the
 * vault-list change guard both consume this context.
 *
 * Implementation decisions from docs/technical/multi-vault-dapp-decisions.md §4.1:
 *   - A `RouterContext` holds active vault weights (via the previewDeposit
 *     shape) and the active vault list (via `activeVaults()`).
 *   - Its update cadence differs from VaultRegistryContext (governance
 *     proposals are rare; vault registration is rarer still).
 *   - Query key: `['router', routerAddress, chainId]`.
 *
 * Usage: mount `RouterProvider` below WagmiProvider and QueryClientProvider,
 * alongside VaultRegistryProvider. Children call `useRouterContext()`.
 */
import React, { createContext, useContext, useMemo } from "react";
import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { routerAbi } from "./abi";

interface RouterState {
  /** Current active vault list from router.activeVaults(). */
  activeVaults: readonly Address[];
  routerAddress: Address | undefined;
  isLoading: boolean;
  error: Error | null;
  refresh: () => void;
}

const RouterContext = createContext<RouterState>({
  activeVaults: [],
  routerAddress: undefined,
  isLoading: false,
  error: null,
  refresh: () => undefined,
});

export interface RouterProviderProps {
  routerAddress: Address;
  children: React.ReactNode;
}

/**
 * Mount this provider once near the root alongside VaultRegistryProvider.
 * Only needed when a Portfolio Router address is configured.
 */
export function RouterProvider({ routerAddress, children }: RouterProviderProps) {
  const {
    data: rawActiveVaults,
    isLoading,
    error,
    refetch,
  } = useReadContract({
    address: routerAddress,
    abi: routerAbi,
    functionName: "activeVaults",
    query: { enabled: Boolean(routerAddress) },
  });

  const activeVaults: readonly Address[] = useMemo(
    () => (Array.isArray(rawActiveVaults) ? (rawActiveVaults as Address[]) : []),
    [rawActiveVaults],
  );

  const refresh = React.useCallback(() => {
    void refetch();
  }, [refetch]);

  const value = useMemo(
    () => ({
      activeVaults,
      routerAddress,
      isLoading,
      error: (error ?? null) as Error | null,
      refresh,
    }),
    [activeVaults, routerAddress, isLoading, error, refresh],
  );

  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

/**
 * Hook for consuming router state in any descendant component.
 * Must be used inside a RouterProvider tree.
 */
export function useRouterContext(): RouterState {
  return useContext(RouterContext);
}
