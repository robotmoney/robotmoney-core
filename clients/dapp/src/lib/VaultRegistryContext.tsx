/**
 * VaultRegistryContext — shared registry data-fetching seam (issue #417).
 *
 * Provides a single `VaultRecord[]` to all downstream components from
 * one batched `listVaults()` + per-vault `getVault()` read sequence.
 * This eliminates N+1 chain reads when multiple components (vault selector,
 * withdrawal tab, protocol stats) all need the active vault list.
 *
 * Implementation decisions from docs/technical/multi-vault-dapp-decisions.md §4.1:
 *   - The context issues exactly one `listVaults()` read, then one
 *     `getVault(address)` per vault via `useContractReads` (batched).
 *   - Downstream components consume `useVaultRegistry()` rather than
 *     calling `useReadContract` against the registry directly.
 *   - The `refresh()` function invalidates the TanStack Query cache for
 *     both the vault list and per-vault metadata.
 *
 * Safety note (AC §4 / ADR §4.1 risk 3): the cached `VaultRecord.status`
 * MAY be stale if a vault is paused between context refreshes. Components
 * that gate a signing prompt MUST call `registry.getVault(address)` live
 * via their own `useReadContract` rather than trusting the cached status.
 * This context is for display and routing only.
 */
import React, { createContext, useContext, useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { registryAbi, VaultStatus, type VaultRecord, type VaultStatusValue } from "./abi";

export type { VaultRecord };

interface VaultRegistryState {
  /** All registered vaults from the latest registry read. Empty during load. */
  vaults: readonly VaultRecord[];
  isLoading: boolean;
  error: Error | null;
  /** Trigger a re-fetch of the entire registry. */
  refresh: () => void;
}

const VaultRegistryContext = createContext<VaultRegistryState>({
  vaults: [],
  isLoading: false,
  error: null,
  refresh: () => undefined,
});

export interface VaultRegistryProviderProps {
  registryAddress: Address;
  children: React.ReactNode;
}

/**
 * Mount this provider once near the root, below WagmiProvider and
 * QueryClientProvider. All descendants may call `useVaultRegistry()`.
 */
export function VaultRegistryProvider({ registryAddress, children }: VaultRegistryProviderProps) {
  // Step 1: fetch the flat address list.
  const {
    data: addressListRaw,
    isLoading: listLoading,
    error: listError,
    refetch: refetchList,
  } = useReadContract({
    address: registryAddress,
    abi: registryAbi,
    functionName: "listVaults",
    query: { enabled: Boolean(registryAddress) },
  });

  const addresses: readonly Address[] = useMemo(
    () => (Array.isArray(addressListRaw) ? (addressListRaw as Address[]) : []),
    [addressListRaw],
  );

  // Step 2: batch-fetch getVault(address) for each vault address.
  // useContractReads (wagmi multi-call) issues one eth_call per vault
  // grouped into a single request where multicall is supported.
  const {
    data: vaultRecordsRaw,
    isLoading: recordsLoading,
    error: recordsError,
    refetch: refetchRecords,
  } = useReadContracts({
    contracts: addresses.map((addr) => ({
      address: registryAddress,
      abi: registryAbi,
      functionName: "getVault" as const,
      args: [addr] as const,
    })),
    query: { enabled: addresses.length > 0 },
  });

  // Decode the raw tuple results into typed VaultRecord objects.
  const vaults: readonly VaultRecord[] = useMemo(() => {
    if (!vaultRecordsRaw) return [];
    const records: VaultRecord[] = [];
    for (const result of vaultRecordsRaw) {
      if (result.status !== "success" || !result.result) continue;
      const r = result.result as {
        vault: Address;
        name: string;
        riskLabel: string;
        mandate: string;
        status: number;
        receiptToken: Address;
        depositCap: bigint;
        exitFeeBps: number;
        registeredAt: bigint;
      };
      records.push({
        vault: r.vault,
        name: r.name,
        riskLabel: r.riskLabel,
        mandate: r.mandate,
        status: (r.status in [0, 1, 2] ? r.status : VaultStatus.Active) as VaultStatusValue,
        receiptToken: r.receiptToken,
        depositCap: r.depositCap,
        exitFeeBps: Number(r.exitFeeBps),
        registeredAt: r.registeredAt,
      });
    }
    return records;
  }, [vaultRecordsRaw]);

  const isLoading = listLoading || recordsLoading;
  const error = (listError ?? recordsError ?? null) as Error | null;

  const refresh = React.useCallback(() => {
    void refetchList();
    void refetchRecords();
  }, [refetchList, refetchRecords]);

  const value = useMemo(
    () => ({ vaults, isLoading, error, refresh }),
    [vaults, isLoading, error, refresh],
  );

  return <VaultRegistryContext.Provider value={value}>{children}</VaultRegistryContext.Provider>;
}

/**
 * Hook for consuming vault registry state in any descendant component.
 * Must be used inside a VaultRegistryProvider tree.
 */
export function useVaultRegistry(): VaultRegistryState {
  return useContext(VaultRegistryContext);
}
