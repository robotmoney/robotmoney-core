// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * What each indexed position pays at exit: `vault.previewRedeem(shares)`, read on chain
 * (core 1795, QA plan X8).
 *
 * `convertToAssets` is the gross share of NAV. It ignores the exit fee on both vault families and
 * the `maxSlippageBps` floor a BasketVault applies to the swaps of a redeem, so an rmAGENT
 * position read about 3% above what a redeem paid. `previewRedeem` is what the redeem pays at
 * least, so the position card shows it.
 *
 * The share counts come from the explorer index. The result is display only and never feeds a
 * signature. Reads follow the same chain rule as `useVaultsDepositsPaused`: on the `mainnet` class
 * a wallet on another chain would answer for the OTHER chain, so no read is made. A position whose
 * read fails or is not made has no entry, and the caller falls back to the explorer's
 * `usdc_value` (the same `previewRedeem` semantics at the snapshot block) or shows "—".
 *
 * The result maps a lower-cased vault address to raw USDC (6 decimals).
 */
import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { vaultAbi } from "./abi";
import { depositsReadAllowed } from "./useVaultsDepositsPaused";
import { useWriteChainGuard } from "./useGuardedWriteContract";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d+$/;

/** One indexed position: the vault and its raw share balance (decimal string). */
export interface ShareHolding {
  readonly vault: string;
  readonly shares: string;
}

export function usePreviewRedeemValues(
  holdings: readonly ShareHolding[],
): ReadonlyMap<string, bigint> {
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  // A string key keeps the read list stable across renders that carry the same holdings.
  const key = holdings
    .filter((h) => ADDRESS.test(h.vault) && UINT.test(h.shares))
    .map((h) => `${h.vault.toLowerCase()}:${h.shares}`)
    .join(",");
  const reads = useMemo(() => {
    const byVault = new Map<string, bigint>();
    if (key !== "") {
      for (const pair of key.split(",")) {
        const [vault = "", shares = "0"] = pair.split(":");
        // One position per vault; the first row wins if the index ever sent two.
        if (!byVault.has(vault)) byVault.set(vault, BigInt(shares));
      }
    }
    return [...byVault].map(([vault, shares]) => ({ vault, shares }));
  }, [key]);

  const { data } = useReadContracts({
    contracts: reads.map(({ vault, shares }) => ({
      address: vault as Address,
      abi: vaultAbi,
      functionName: "previewRedeem" as const,
      args: [shares] as const,
      chainId,
    })),
    query: { enabled: allowed && reads.length > 0, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    const out = new Map<string, bigint>();
    reads.forEach(({ vault }, i) => {
      const r = data?.[i];
      if (r?.status === "success" && typeof r.result === "bigint") out.set(vault, r.result);
    });
    return out;
  }, [data, reads]);
}
