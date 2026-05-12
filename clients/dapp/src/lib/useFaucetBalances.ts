/**
 * useFaucetBalances — wagmi hook layer for the FaucetTab. Encapsulates
 * the two USDC `balanceOf` reads (harness preflight + recipient
 * read-back) so the FaucetTab component itself stays render-only per
 * docs/guides/react-guide.md §Layout ("components/*.tsx render only,
 * no fetching primitives").
 *
 * Issue #261 ties the drip button's enabled state to a "simulate before
 * write" preflight. A real `simulateContract` would require the dapp to
 * open its own HTTP RPC, which docs/security/dapp-topology.md §2 bans;
 * `balanceOf(harness) >= amount` routed through the user's wallet is
 * the strict equivalent — the transfer would revert otherwise, and we
 * never surface the signing prompt without a positive preflight.
 */
import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { isAddress } from "viem";
import { erc20Abi } from "./abi";

export interface UseFaucetBalancesArgs {
  readonly usdcAddress: Address;
  readonly chainId: number;
  readonly harnessAddress: Address | null;
  readonly recipient: Address | null;
}

export interface FaucetBalanceQuery {
  readonly data: bigint | undefined;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly refetch: () => Promise<unknown>;
}

export interface UseFaucetBalancesResult {
  readonly harness: FaucetBalanceQuery;
  readonly recipient: FaucetBalanceQuery;
}

export function useFaucetBalances(args: UseFaucetBalancesArgs): UseFaucetBalancesResult {
  const usdcReady = isAddress(args.usdcAddress);

  const harnessQuery = useReadContract({
    address: args.usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: args.harnessAddress ? [args.harnessAddress] : undefined,
    chainId: args.chainId,
    query: {
      enabled: usdcReady && args.harnessAddress !== null,
      retry: 0,
    },
  });

  const recipientQuery = useReadContract({
    address: args.usdcAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: args.recipient ? [args.recipient] : undefined,
    chainId: args.chainId,
    query: {
      enabled: usdcReady && args.recipient !== null,
      retry: 0,
    },
  });

  return {
    harness: {
      data: harnessQuery.data as bigint | undefined,
      isPending: harnessQuery.isPending,
      error: harnessQuery.error,
      refetch: harnessQuery.refetch,
    },
    recipient: {
      data: recipientQuery.data as bigint | undefined,
      isPending: recipientQuery.isPending,
      error: recipientQuery.error,
      refetch: recipientQuery.refetch,
    },
  };
}
