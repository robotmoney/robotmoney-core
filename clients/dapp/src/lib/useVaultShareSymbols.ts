// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * Each vault's own share symbol (issue 1767).
 *
 * A vault is its own ERC-4626 share token, so `symbol()` on the vault address is the authority (rmUSDC,
 * rmPROTO, rmAGENT, rmRWA). The explorer sends only `name` and `risk_label`, and a name match is a guess, so
 * this reads the chain. Reads follow the same chain guard as `useVaultsDepositsPaused`: on `mainnet` a wallet
 * on another chain would answer for the same address with the OTHER chain's data, so no read is made. An
 * unreadable vault has no entry, and callers print the neutral "shares" through `shareSymbolOrNeutral`.
 */
import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { erc20Abi } from "./abi";
import { shareSymbolOrNeutral } from "./format";
import { depositsReadAllowed } from "./useVaultsDepositsPaused";
import { useWriteChainGuard } from "./useGuardedWriteContract";

export function useVaultShareSymbols(addresses: readonly string[]): (address: string) => string {
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const key = addresses.map((a) => a.toLowerCase()).join(",");
  const unique = useMemo(() => (key === "" ? [] : Array.from(new Set(key.split(",")))), [key]);

  const { data } = useReadContracts({
    contracts: unique.map((a) => ({
      address: a as `0x${string}`,
      abi: erc20Abi,
      functionName: "symbol" as const,
      chainId,
    })),
    query: { enabled: allowed && unique.length > 0, staleTime: 5 * 60_000 },
  });

  const bySymbol = useMemo(() => {
    const m = new Map<string, string>();
    unique.forEach((a, i) => {
      const r = data?.[i];
      if (r?.status === "success") m.set(a, shareSymbolOrNeutral(r.result));
    });
    return m;
  }, [data, unique]);

  return (address: string) =>
    bySymbol.get(address.toLowerCase()) ?? shareSymbolOrNeutral(undefined);
}
