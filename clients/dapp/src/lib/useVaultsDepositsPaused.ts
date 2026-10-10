// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * Live `depositsPaused()` of a set of vaults (issue 1731).
 *
 * Reads go through the dapp's wagmi client, which is the user's wallet provider (docs/technical/dapp-topology.md
 * §2, no dapp-owned RPC). On the `mainnet` class a wallet that is absent or on another chain cannot answer for
 * Base, and asking it would return the OTHER chain's answer for the same address. So on `mainnet` the read
 * runs only when the wallet is on Base. Otherwise the result is empty and the caller falls back to the
 * explorer flag, and then to "unknown". An unreadable vault is `undefined`, never `false`.
 */
import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { DEPOSITS_PAUSED_ABI } from "./vaultDepositState";
import { useWriteChainGuard } from "./useGuardedWriteContract";
import type { WriteGuardState } from "./writeChainGuard";

/** May the dapp ask its wallet provider about this deployment's chain? Pure, so it is tested alone. */
export function depositsReadAllowed(guard: WriteGuardState): boolean {
  return guard.kind === "not-applicable" || guard.kind === "ok";
}

export function useVaultsDepositsPaused(addresses: readonly string[]): {
  readonly byAddress: ReadonlyMap<string, boolean>;
  readonly allowed: boolean;
} {
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const key = addresses.map((a) => a.toLowerCase()).join(",");
  const unique = useMemo(() => (key === "" ? [] : Array.from(new Set(key.split(",")))), [key]);

  const { data } = useReadContracts({
    contracts: unique.map((a) => ({
      address: a as `0x${string}`,
      abi: DEPOSITS_PAUSED_ABI,
      functionName: "depositsPaused" as const,
      chainId,
    })),
    query: { enabled: allowed && unique.length > 0, refetchInterval: 12_000 },
  });

  const byAddress = useMemo(() => {
    const m = new Map<string, boolean>();
    unique.forEach((a, i) => {
      const r = data?.[i];
      if (r?.status === "success" && typeof r.result === "boolean") m.set(a, r.result);
    });
    return m;
  }, [data, unique]);
  return { byAddress, allowed };
}
