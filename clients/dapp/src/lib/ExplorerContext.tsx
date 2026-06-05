// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * ExplorerContext — single polling loop for all explorer-API data.
 *
 * All components that display vault TVL, stats, or block freshness consume
 * this context rather than issuing independent fetches. A single interval
 * drives both /v1/vaults and /v1/stats so every rendered component reflects
 * the same indexed block_number — no mixed-block state.
 *
 * Mount <ExplorerProvider> once near the root (main.tsx) and consume with
 * useExplorer() in any component that needs vaults or stats data.
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FetchLike, StatsResponse, VaultRow } from "./explorerApi";
import { fetchStats, fetchVaults } from "./explorerApi";

export interface ExplorerContextValue {
  readonly vaults: readonly VaultRow[];
  readonly stats: StatsResponse | null;
  /** Block number from the most recent /v1/vaults response, or null before first fetch. */
  readonly blockNumber: number | null;
  readonly vaultsLoading: boolean;
  readonly statsLoading: boolean;
  readonly vaultsError: string | null;
  readonly statsError: string | null;
}

const INITIAL: ExplorerContextValue = {
  vaults: [],
  stats: null,
  blockNumber: null,
  vaultsLoading: true,
  statsLoading: true,
  vaultsError: null,
  statsError: null,
};

/** Exported for test wrappers that inject a controlled value directly. */
export const ExplorerContext = createContext<ExplorerContextValue>(INITIAL);

export function useExplorer(): ExplorerContextValue {
  return useContext(ExplorerContext);
}

interface ExplorerProviderProps {
  readonly apiUrl: string;
  readonly fetchImpl?: FetchLike;
  /** Poll interval in ms. Defaults to 12 000 (one indexer tick). */
  readonly pollInterval?: number;
  readonly children: ReactNode;
}

export function ExplorerProvider({
  apiUrl,
  fetchImpl,
  pollInterval = 12_000,
  children,
}: ExplorerProviderProps) {
  const [value, setValue] = useState<ExplorerContextValue>(INITIAL);
  // Stable ref so the interval callback always sees the current apiUrl / fetchImpl
  // without needing to be torn down and recreated on every render.
  const optsRef = useRef({ apiUrl, fetchImpl });
  optsRef.current = { apiUrl, fetchImpl };

  useEffect(() => {
    let vaultAc = new AbortController();
    let statsAc = new AbortController();

    function fetchAll() {
      vaultAc.abort();
      statsAc.abort();
      vaultAc = new AbortController();
      statsAc = new AbortController();

      const { apiUrl: url, fetchImpl: fi } = optsRef.current;

      fetchVaults(url, { fetchImpl: fi, signal: vaultAc.signal })
        .then((res) =>
          setValue((prev) => ({
            ...prev,
            vaults: res.vaults,
            blockNumber: res.block_number,
            vaultsLoading: false,
            vaultsError: null,
          })),
        )
        .catch((err: unknown) => {
          if (vaultAc.signal.aborted) return;
          setValue((prev) => ({
            ...prev,
            vaultsLoading: false,
            vaultsError: String(err),
          }));
        });

      fetchStats(url, { fetchImpl: fi, signal: statsAc.signal })
        .then((res) =>
          setValue((prev) => ({
            ...prev,
            stats: res,
            statsLoading: false,
            statsError: null,
          })),
        )
        .catch((err: unknown) => {
          if (statsAc.signal.aborted) return;
          setValue((prev) => ({
            ...prev,
            statsLoading: false,
            statsError: String(err),
          }));
        });
    }

    fetchAll();
    const timer = setInterval(fetchAll, pollInterval);
    return () => {
      clearInterval(timer);
      vaultAc.abort();
      statsAc.abort();
    };
    // Re-mount only when the URL or interval changes; fetchImpl is read via ref.
  }, [apiUrl, pollInterval]);

  return <ExplorerContext.Provider value={value}>{children}</ExplorerContext.Provider>;
}
