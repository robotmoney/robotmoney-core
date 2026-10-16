// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * A holder's exclusion claim per vault (core 1820, QA plan U5 with D3).
 *
 * When a RobotMoneyVault excludes a funded adapter, recovered USDC is held in the vault's
 * `ExclusionLedger` and owed pro rata to the holders at the moment of exclusion, whether they
 * stayed or exited since (owner decision 2026-10-13). The position card shows what `holder` can
 * claim now. Two reads, both on chain (never the explorer):
 *   1. `vault.exclusionLedger()`        — the vault's ledger (reverts on basket vaults);
 *   2. `ledger.claimableTotal(holder)`  — USDC claimable now across every record.
 *
 * The result maps a lower-cased vault address to the claimable USDC (6 decimals). A vault with
 * no ledger, an unreadable read or a zero claim has no entry, so the card shows nothing.
 * Reads follow the same chain rule as `useVaultsDepositsPaused`: on the `mainnet` class a
 * wallet on another chain would answer for the OTHER chain, so no read is made.
 */
import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { EXCLUSION_LEDGER_ABI, VAULT_EXCLUSION_ABI } from "./abi";
import { depositsReadAllowed } from "./useVaultsDepositsPaused";
import { useWriteChainGuard } from "./useGuardedWriteContract";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

export function useExclusionClaims(
  vaults: readonly string[],
  holder: string | undefined,
): ReadonlyMap<string, bigint> {
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const key = vaults.map((a) => a.toLowerCase()).join(",");
  const unique = useMemo(() => (key === "" ? [] : Array.from(new Set(key.split(",")))), [key]);
  const holderOk = typeof holder === "string" && ADDRESS.test(holder);

  const { data: ledgerReads } = useReadContracts({
    contracts: unique.map((v) => ({
      address: v as Address,
      abi: VAULT_EXCLUSION_ABI,
      functionName: "exclusionLedger" as const,
      chainId,
    })),
    query: { enabled: allowed && holderOk && unique.length > 0, staleTime: 5 * 60_000 },
  });

  // vault (lower) -> ledger, only for a vault that answered with a real address.
  const ledgers = useMemo(() => {
    const out: { vault: string; ledger: Address }[] = [];
    unique.forEach((v, i) => {
      const r = ledgerReads?.[i];
      if (r?.status !== "success") return;
      const ledger = r.result as unknown;
      if (typeof ledger === "string" && ADDRESS.test(ledger) && !ZERO.test(ledger)) {
        out.push({ vault: v, ledger: ledger as Address });
      }
    });
    return out;
  }, [ledgerReads, unique]);

  const { data: claimReads } = useReadContracts({
    contracts: ledgers.map(({ ledger }) => ({
      address: ledger,
      abi: EXCLUSION_LEDGER_ABI,
      functionName: "claimableTotal" as const,
      args: [holder as Address] as const,
      chainId,
    })),
    query: { enabled: allowed && holderOk && ledgers.length > 0, refetchInterval: 60_000 },
  });

  return useMemo(() => {
    const out = new Map<string, bigint>();
    ledgers.forEach(({ vault }, i) => {
      const r = claimReads?.[i];
      if (r?.status === "success" && typeof r.result === "bigint" && r.result > 0n) {
        out.set(vault, r.result);
      }
    });
    return out;
  }, [claimReads, ledgers]);
}
