// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * The deposit state of vaults for the deposit FORMS (issue 1731), from the same three sources the cards use:
 * the registry status and the explorer's snapshot (via ExplorerContext) and the live `depositsPaused()` read.
 * Every form goes through here, so no form can build its own weaker rule. A form is enabled only when the
 * state is `open` (`depositsBlocked` is false): paused, retired and unknown all disable it.
 */
import { useMemo } from "react";
import { useExplorer } from "./ExplorerContext";
import { useVaultsDepositsPaused } from "./useVaultsDepositsPaused";
import { resolveDepositState, type DepositState } from "./vaultDepositState";

export function useDepositStates(
  addresses: readonly string[],
  registryStatusOverride?: Readonly<Record<string, number | undefined>>,
): ReadonlyMap<string, DepositState> {
  const { vaults, blockNumber, chainHeadBlock } = useExplorer();
  const { byAddress } = useVaultsDepositsPaused(addresses);
  const key = addresses.map((a) => a.toLowerCase()).join(",");
  return useMemo(() => {
    const out = new Map<string, DepositState>();
    for (const a of key === "" ? [] : key.split(",")) {
      const row = vaults.find((v) => v.address.toLowerCase() === a);
      out.set(
        a,
        resolveDepositState({
          registryStatus: registryStatusOverride?.[a] ?? row?.status ?? 0,
          explorerPaused: row?.deposits_paused,
          explorerBlock: blockNumber,
          explorerHead: chainHeadBlock,
          chainPaused: byAddress.get(a),
        }),
      );
    }
    return out;
  }, [key, vaults, blockNumber, chainHeadBlock, byAddress, registryStatusOverride]);
}

/** One vault. An absent address is `unknown`. */
export function useDepositState(
  address: string | undefined,
  registryStatus?: number,
): DepositState {
  const lower = address?.toLowerCase();
  const override = useMemo(
    () => (lower && registryStatus !== undefined ? { [lower]: registryStatus } : undefined),
    [lower, registryStatus],
  );
  const states = useDepositStates(lower ? [lower] : [], override);
  return (lower && states.get(lower)) || { kind: "unknown" };
}
