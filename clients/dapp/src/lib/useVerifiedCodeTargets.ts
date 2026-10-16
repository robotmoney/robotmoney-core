// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * The vault and router addresses whose code matches their build-time pin (QA plan U5,
 * issue 1737 item 1). This feeds `PreviewContext.verifiedTargets`, so a vault or router
 * preview badges its target "[bytecode verified]" only when keccak256 of the code at that
 * address equals the pin the bundle carries (codePins.ts). Without a pin, or before the read
 * lands, the badge says UNVERIFIED.
 *
 * Behind an ERC-1967 proxy that code is the generic `ERC1967Proxy` (ADR-0014), so a match says
 * nothing about the logic. Each address is therefore read like the write guard reads it: the
 * code, the implementation slot and the implementation's code, all at one block, through
 * `verifyPinnedTarget`. A proxy is verified only when its implementation is a reviewed pin.
 * The reads repeat every minute, so a tab left open across an upgrade loses the badge.
 *
 * `refused` holds the addresses the chain answered for and that failed: wrong code, no code, or
 * an implementation the build does not pin. A failed read is neither verified nor refused. The
 * Withdraw tab uses `refused` to stop offering a share approval to a router the guard would
 * refuse, and redeems straight from the vault instead (an exit never depends on the router). The
 * router deposit form uses it to close while any leg vault is refused (security round 2).
 *
 * Reads go through the wallet like every other read (docs/technical/dapp-topology.md §2), with
 * the same chain rule as `useVaultsDepositsPaused`: on the `mainnet` class a wallet on another
 * chain would answer for the OTHER chain, so no read is made and nothing is verified.
 *
 * The badge is display only. The write guard (`useGuardedWriteContract`) reads everything again
 * at send time and refuses a deposit or approve whose target does not match its pins.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { useRuntimeConfig } from "./RuntimeConfigContext";
import { useWriteChainGuard } from "./useGuardedWriteContract";
import { depositsReadAllowed } from "./useVaultsDepositsPaused";
import {
  DEFINITE_PIN_REFUSALS,
  parseCodePins,
  parseImplementationAddressPins,
  parseImplementationPinMap,
  verifyPinnedTarget,
  type PinnedTargetReads,
} from "./codePins";
import { ERC1967_IMPLEMENTATION_SLOT, implementationFromSlot } from "./gatewayVerifier";

/** How often the pinned addresses are read again, so an upgrade is noticed on an open tab. */
const REVERIFY_MS = 60_000;

export interface CodeTargetVerification {
  /** Lower-cased addresses whose code and implementation matched their pins. */
  readonly verified: ReadonlySet<string>;
  /** Lower-cased addresses the chain showed do NOT match their pins. */
  readonly refused: ReadonlySet<string>;
}

export function useCodeTargetVerification(): CodeTargetVerification {
  const env = useRuntimeConfig();
  const pins = useMemo(() => parseCodePins(env), [env]);
  const implementationPins = useMemo(() => parseImplementationPinMap(env), [env]);
  const implementationAddressPins = useMemo(() => parseImplementationAddressPins(env), [env]);
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const client = usePublicClient({ chainId });
  const addresses = useMemo(() => [...pins.keys()].sort(), [pins]);

  const { data } = useQuery({
    queryKey: ["code-pin-targets", chainId ?? null, client?.chain?.id ?? null, addresses],
    queryFn: async (): Promise<Array<PinnedTargetReads | null>> => {
      if (!client) return [];
      const blockNumber = await client.getBlockNumber();
      return Promise.all(
        addresses.map(async (a): Promise<PinnedTargetReads | null> => {
          const address = a as Address;
          try {
            const [code, slot] = await Promise.all([
              client.getCode({ address, blockNumber }),
              client.getStorageAt({ address, slot: ERC1967_IMPLEMENTATION_SLOT, blockNumber }),
            ]);
            // viem returns undefined for an empty account.
            const codeHex = code ?? "0x";
            const implementation = typeof slot === "string" ? implementationFromSlot(slot) : null;
            const implementationCode =
              implementation === null || implementation === undefined
                ? null
                : ((await client.getCode({ address: implementation, blockNumber })) ?? "0x");
            return { code: codeHex, slot, implementationCode };
          } catch {
            return null;
          }
        }),
      );
    },
    enabled: allowed && client !== undefined && addresses.length > 0,
    staleTime: REVERIFY_MS / 2,
    refetchInterval: REVERIFY_MS,
  });

  return useMemo(() => {
    const verified = new Set<string>();
    const refused = new Set<string>();
    addresses.forEach((a, i) => {
      const reads = data?.[i];
      if (!reads) return;
      const result = verifyPinnedTarget(
        a,
        reads,
        pins,
        implementationPins,
        implementationAddressPins,
      );
      if (result.ok) verified.add(a);
      else if (DEFINITE_PIN_REFUSALS.has(result.cause)) refused.add(a);
    });
    return { verified, refused };
  }, [addresses, data, pins, implementationPins, implementationAddressPins]);
}

/** The verified half of `useCodeTargetVerification`: what the preview badges read. */
export function useVerifiedCodeTargets(): ReadonlySet<string> {
  return useCodeTargetVerification().verified;
}
