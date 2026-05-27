// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * BalancesPanel — wagmi data-fetching wrapper for the main-page wallet
 * balances panel (issue #463). Owns the `useAccount`, `useBalance`, and
 * `useReadContracts` calls so the inner `BalancesPanelView` stays
 * render-only per docs/development/react-guide.md §Layout.
 *
 * Sources:
 *   - USDC balance / decimals / symbol via ERC-20 `balanceOf`, `decimals`,
 *     `symbol` (re-using `erc20Abi` from `lib/abi.ts`).
 *   - ETH balance via wagmi's `useBalance` (native-asset read).
 *   - RM balance — only fetched when `rmTokenAddress` is provided
 *     (gated on `VITE_RM_TOKEN_ADDRESS`), mirroring the optional-RM
 *     pattern used by `useFaucetBalances` (issue #365).
 *   - Per-vault receipt tokens — iterates the shared `VaultRegistryContext`
 *     (issue #417) so newly registered vaults appear without code
 *     changes. Only receipts with a non-zero `balanceOf` render.
 *
 * No fetching happens until a wallet is connected; with no address the
 * inner view renders a connect prompt.
 */
import { useMemo } from "react";
import { useAccount, useBalance, useChainId, useReadContract, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { erc20Abi, gatewayAbi } from "../lib/abi";
import { useVaultRegistry } from "../lib/VaultRegistryContext";
import { BalancesPanelView, type BalancesPanelReceipt } from "./BalancesPanelView";

export interface BalancesPanelProps {
  /** Gateway contract address — the panel reads `gateway.usdc()` to find the USDC token. */
  readonly gatewayAddress: Address;
  /** RM token address. When undefined, the RM row is hidden. */
  readonly rmTokenAddress?: Address;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export function BalancesPanel(props: BalancesPanelProps) {
  const { address, isConnected } = useAccount();
  const connected = isConnected && Boolean(address);
  const chainId = useChainId();

  // Resolve USDC address from gateway.usdc() — same pattern as AdminFlow.
  const { data: usdcAddressData } = useReadContract({
    address: props.gatewayAddress,
    abi: gatewayAbi,
    functionName: "usdc",
    query: { enabled: connected },
  });
  const usdcAddress = (usdcAddressData as Address | undefined) ?? ZERO_ADDRESS;
  const usdcReady = usdcAddress !== ZERO_ADDRESS;

  // USDC balance + decimals + symbol — one batched multicall.
  const usdcReads = useReadContracts({
    contracts: [
      {
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address ?? ZERO_ADDRESS],
        chainId,
      },
      {
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "decimals",
        chainId,
      },
      {
        address: usdcAddress,
        abi: erc20Abi,
        functionName: "symbol",
        chainId,
      },
    ],
    query: { enabled: connected && usdcReady },
  });

  const usdcBalance =
    usdcReads.data?.[0]?.status === "success" ? (usdcReads.data[0].result as bigint) : undefined;
  const usdcDecimals =
    usdcReads.data?.[1]?.status === "success" ? Number(usdcReads.data[1].result) : 6;
  const usdcSymbol =
    usdcReads.data?.[2]?.status === "success" ? String(usdcReads.data[2].result) : "USDC";

  // ETH balance — native via wagmi's useBalance.
  const ethBalanceQuery = useBalance({
    address,
    chainId,
    query: { enabled: connected },
  });
  const ethBalance = ethBalanceQuery.data?.value;
  const ethSymbol = ethBalanceQuery.data?.symbol ?? "ETH";

  // Optional RM balance + decimals + symbol — only when configured.
  const rmAvailable = Boolean(props.rmTokenAddress);
  const rmReads = useReadContracts({
    contracts: props.rmTokenAddress
      ? [
          {
            address: props.rmTokenAddress,
            abi: erc20Abi,
            functionName: "balanceOf" as const,
            args: [address ?? "0x0000000000000000000000000000000000000000"] as const,
            chainId,
          },
          {
            address: props.rmTokenAddress,
            abi: erc20Abi,
            functionName: "decimals" as const,
            chainId,
          },
          {
            address: props.rmTokenAddress,
            abi: erc20Abi,
            functionName: "symbol" as const,
            chainId,
          },
        ]
      : [],
    query: { enabled: connected && rmAvailable },
  });

  const rmBalance =
    rmReads.data?.[0]?.status === "success" ? (rmReads.data[0].result as bigint) : undefined;
  const rmDecimals = rmReads.data?.[1]?.status === "success" ? Number(rmReads.data[1].result) : 18;
  const rmSymbol = rmReads.data?.[2]?.status === "success" ? String(rmReads.data[2].result) : "RM";

  // Per-vault receipt token reads — iterate the shared registry.
  // For each registered vault we read balanceOf + decimals + symbol from the
  // vault's receiptToken in one batched multicall. AC §2 says the row only
  // renders when the wallet holds shares (balance > 0), so we filter below.
  const registry = useVaultRegistry();
  const receiptContracts = useMemo(() => {
    if (!connected || !address) return [];
    return registry.vaults.flatMap((v) => [
      {
        address: v.receiptToken,
        abi: erc20Abi,
        functionName: "balanceOf" as const,
        args: [address] as const,
        chainId,
      },
      {
        address: v.receiptToken,
        abi: erc20Abi,
        functionName: "decimals" as const,
        chainId,
      },
      {
        address: v.receiptToken,
        abi: erc20Abi,
        functionName: "symbol" as const,
        chainId,
      },
    ]);
  }, [connected, address, registry.vaults, chainId]);

  const receiptReads = useReadContracts({
    contracts: receiptContracts,
    query: { enabled: connected && registry.vaults.length > 0 },
  });

  const receipts: ReadonlyArray<BalancesPanelReceipt> = useMemo(() => {
    if (!receiptReads.data) return [];
    const out: BalancesPanelReceipt[] = [];
    for (let i = 0; i < registry.vaults.length; i++) {
      const vault = registry.vaults[i];
      if (!vault) continue;
      const balRes = receiptReads.data[i * 3];
      const decRes = receiptReads.data[i * 3 + 1];
      const symRes = receiptReads.data[i * 3 + 2];
      if (!balRes || balRes.status !== "success") continue;
      const balance = balRes.result as bigint;
      // AC §2: only render rows for vaults the wallet HOLDS (non-zero).
      if (balance === 0n) continue;
      const decimals = decRes?.status === "success" ? Number(decRes.result) : 6;
      const symbol = symRes?.status === "success" ? String(symRes.result) : "rmVAULT";
      out.push({
        vaultAddress: vault.vault,
        symbol,
        decimals,
        balance,
      });
    }
    return out;
  }, [receiptReads.data, registry.vaults]);

  return (
    <BalancesPanelView
      connected={connected}
      usdcBalance={usdcBalance}
      usdcDecimals={usdcDecimals}
      usdcSymbol={usdcSymbol}
      ethBalance={ethBalance}
      ethSymbol={ethSymbol}
      rmAvailable={rmAvailable}
      rmBalance={rmBalance}
      rmDecimals={rmDecimals}
      rmSymbol={rmSymbol}
      receipts={receipts}
    />
  );
}
