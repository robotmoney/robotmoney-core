// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * The vault and router addresses whose code matches their build-time pin (QA plan U5,
 * issue 1737 item 1). This feeds `PreviewContext.verifiedTargets`, so a vault or router
 * preview badges its target "[bytecode verified]" only when keccak256 of the code at that
 * address equals the pin the bundle carries (codePins.ts). Without a pin, or before the read
 * lands, the badge says UNVERIFIED.
 *
 * Reads go through the wallet like every other read (docs/technical/dapp-topology.md §2), with
 * the same chain rule as `useVaultsDepositsPaused`: on the `mainnet` class a wallet on another
 * chain would answer for the OTHER chain, so no read is made and nothing is verified.
 *
 * The badge is display only. The write guard (`useGuardedWriteContract`) reads the code again
 * at send time and refuses a deposit or approve whose target does not match its pin.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { useRuntimeConfig } from "./RuntimeConfigContext";
import { useWriteChainGuard } from "./useGuardedWriteContract";
import { depositsReadAllowed } from "./useVaultsDepositsPaused";
import { checkCodePin, parseCodePins } from "./codePins";

export function useVerifiedCodeTargets(): ReadonlySet<string> {
  const env = useRuntimeConfig();
  const pins = useMemo(() => parseCodePins(env), [env]);
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const client = usePublicClient({ chainId });
  const addresses = useMemo(() => [...pins.keys()].sort(), [pins]);

  const { data } = useQuery({
    queryKey: ["code-pin-targets", chainId ?? null, client?.chain?.id ?? null, addresses],
    queryFn: () =>
      Promise.all(
        addresses.map((a) =>
          client ? client.getCode({ address: a as Address }).catch(() => undefined) : undefined,
        ),
      ),
    enabled: allowed && client !== undefined && addresses.length > 0,
    staleTime: Infinity,
  });

  return useMemo(() => {
    const verified = new Set<string>();
    addresses.forEach((a, i) => {
      if (checkCodePin(a, data?.[i], pins).ok) verified.add(a);
    });
    return verified;
  }, [addresses, data, pins]);
}
