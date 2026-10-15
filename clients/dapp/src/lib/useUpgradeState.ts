// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3, §5 — proxies, the timelock authority, the freeze

/**
 * useUpgradeState — the live upgrade state of one contract (QA plan P3).
 *
 * Reads the ERC-1967 implementation slot, the implementation's code,
 * `upgradesFrozen()` and `upgradeAuthority()` from the chain through the
 * wallet provider. The same chain guard as the deposit-pause reads applies
 * (`depositsReadAllowed`): on the `mainnet` class a wallet that is absent or
 * on another chain would answer for the wrong chain, so nothing is read from
 * it. The page still works without a wallet (docs/architecture.md §5.3): it
 * then shows the explorer index's answer (`GET /v1/upgrades`), labelled as
 * indexed, or `unavailable` when the index has none. It never stays
 * `loading`. `upgradeState.ts` folds the reads.
 */
import { useEffect, useState } from "react";
import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import { useBytecode, useReadContracts, useStorageAt } from "wagmi";
import { GOVERNED_UPGRADE_ABI } from "./abi";
import { fetchUpgrades, resolveExplorerApiUrl, type UpgradesResponse } from "./explorerApi";
import { useRuntimeConfig } from "./RuntimeConfigContext";
import { useWriteChainGuard } from "./useGuardedWriteContract";
import {
  ERC1967_IMPLEMENTATION_SLOT,
  implementationFromSlot,
  resolveIndexedUpgradeState,
  resolveUpgradeState,
  type UpgradeState,
} from "./upgradeState";
import { depositsReadAllowed } from "./useVaultsDepositsPaused";

/**
 * `GET /v1/upgrades`, fetched only while `enabled` (no chain read is possible). `undefined` while
 * the fetch is in flight, `null` when it failed.
 */
export function useIndexedUpgrades(enabled: boolean): UpgradesResponse | null | undefined {
  const apiUrl = resolveExplorerApiUrl(useRuntimeConfig());
  const [response, setResponse] = useState<UpgradesResponse | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchUpgrades(apiUrl, { signal: controller.signal })
      .then((r) => setResponse(r))
      .catch(() => {
        if (!controller.signal.aborted) setResponse(null);
      });
    return () => controller.abort();
  }, [enabled, apiUrl]);
  return response;
}

export function useUpgradeState(address: string): UpgradeState {
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const indexed = useIndexedUpgrades(!allowed);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const target = isAddress(address, { strict: false }) ? (address as Address) : undefined;

  const slot = useStorageAt({
    address: target,
    slot: ERC1967_IMPLEMENTATION_SLOT,
    chainId,
    query: { enabled: allowed && target !== undefined },
  });
  const slotWord = slot.data as Hex | undefined;
  const implementation = slotWord !== undefined ? implementationFromSlot(slotWord) : null;

  const code = useBytecode({
    address: implementation ?? undefined,
    chainId,
    query: { enabled: allowed && implementation !== null },
  });
  const views = useReadContracts({
    allowFailure: true,
    contracts: [
      {
        address: target ?? zeroAddress,
        abi: GOVERNED_UPGRADE_ABI,
        functionName: "upgradesFrozen" as const,
        chainId,
      },
      {
        address: target ?? zeroAddress,
        abi: GOVERNED_UPGRADE_ABI,
        functionName: "upgradeAuthority" as const,
        chainId,
      },
    ],
    query: { enabled: allowed && implementation !== null },
  });
  const frozen = views.data?.[0];
  const authority = views.data?.[1];

  if (!allowed) {
    return indexed === undefined
      ? { kind: "loading" }
      : resolveIndexedUpgradeState(indexed, address);
  }
  return resolveUpgradeState({
    slot: slotWord,
    slotError: slot.isError === true,
    implementationCode: (code.data as Hex | null | undefined) ?? undefined,
    frozen:
      frozen?.status === "success" && typeof frozen.result === "boolean"
        ? frozen.result
        : undefined,
    authority:
      authority?.status === "success" && typeof authority.result === "string"
        ? (authority.result as Address)
        : undefined,
  });
}
