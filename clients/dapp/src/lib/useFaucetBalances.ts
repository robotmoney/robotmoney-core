// Canonical: docs/architecture.md §5.3 — Human Dapp (faucet UX)

/**
 * useFaucetBalances — wagmi hook layer for the FaucetTab. Encapsulates
 * the USDC `balanceOf` reads (harness preflight + recipient read-back)
 * and optionally the RM token harness balance (issue #365) so the FaucetTab
 * component itself stays render-only per docs/guides/react-guide.md §Layout
 * ("components/*.tsx render only, no fetching primitives").
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
  /** Optional RM token address. When provided, the hook also reads the harness RM balance. */
  readonly rmTokenAddress?: Address;
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
  /** Harness RM token balance. Only populated when `rmTokenAddress` is provided. */
  readonly harnessRm: FaucetBalanceQuery;
}

export function useFaucetBalances(args: UseFaucetBalancesArgs): UseFaucetBalancesResult {
  const usdcReady = isAddress(args.usdcAddress);
  const rmReady = args.rmTokenAddress ? isAddress(args.rmTokenAddress) : false;

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

  const harnessRmQuery = useReadContract({
    address: args.rmTokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: args.harnessAddress ? [args.harnessAddress] : undefined,
    chainId: args.chainId,
    query: {
      enabled: rmReady && args.harnessAddress !== null,
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
    harnessRm: {
      data: harnessRmQuery.data as bigint | undefined,
      isPending: harnessRmQuery.isPending,
      error: harnessRmQuery.error,
      refetch: harnessRmQuery.refetch,
    },
  };
}
