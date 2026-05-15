/**
 * FaucetTab — testnet/devnet-only admin tab that drips a fixed
 * `FAUCET_DRIP_AMOUNT_USDC` (100 USDC) into the wallet selected from a
 * dropdown of the user's wallets. Optionally also drips RM tokens when
 * `rmTokenAddress` is provided (issue #365). The tab is *only* present in
 * the rendered AdminFlow when `classifyChain(chainId) === "testnet"` (see
 * buildAdminTabs.tsx); this component additionally early-returns
 * "unavailable" if the build-time harness key is missing, so even a
 * forced render on mainnet displays no signing affordance.
 *
 * The drip button stays disabled until a `balanceOf(harness) >= amount`
 * preflight succeeds (the "simulate before write" gate). The actual
 * transfer is signed by the in-bundle harness key (NOT the user's
 * wallet) and broadcast through the user's EIP-1193 provider — see
 * `lib/faucetClient.ts` for the architectural rationale (#261 scout
 * decision).
 *
 * This wrapper owns the wagmi `useReadContract` calls; the inner
 * `FaucetTabView` is render-only and is what tests render directly,
 * keeping component tests free of a wagmi/QueryClient fixture per
 * docs/guides/react-guide.md §Layout.
 */
import { useMemo } from "react";
import { type Address, type Hex, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useFaucetBalances } from "../lib/useFaucetBalances";
import {
  dripUsdc,
  dripRmToken,
  type DripUsdcArgs,
  type DripRmTokenArgs,
} from "../lib/faucetClient";
import { FaucetTabView } from "./FaucetTabView";

type Props = Readonly<{
  /** Connected USDC contract address (read from gateway.usdc() in AdminFlow). */
  usdcAddress: Address;
  /** Active wallet chain id. */
  chainId: number;
  /** User's known wallet addresses for the dropdown — connected EOA first. */
  walletAddresses: ReadonlyArray<Address>;
  /** Build-time harness private key. `null` ⇒ mainnet/prod build, surface fails closed. */
  harnessPrivateKey: Hex | null;
  /**
   * Injected USDC drip handler (recipient → tx hash). Production calls
   * `dripUsdc` from `lib/faucetClient.ts`; the e2e harness substitutes
   * its own forwarder.
   */
  drip?: (args: DripUsdcArgs) => Promise<Hex>;
  /**
   * RM token contract address. When provided and env is not mainnet, the
   * FaucetTabView renders a 'Get RM tokens' button (issue #365).
   */
  rmTokenAddress?: Address;
  /**
   * Injected RM drip handler. Production calls `dripRmToken` from
   * `lib/faucetClient.ts`; the e2e harness substitutes its own forwarder.
   */
  dripRm?: (args: DripRmTokenArgs) => Promise<Hex>;
}>;

export function FaucetTab(props: Props) {
  const harnessAccount = useMemo(
    () => (props.harnessPrivateKey ? privateKeyToAccount(props.harnessPrivateKey) : null),
    [props.harnessPrivateKey],
  );

  const balances = useFaucetBalances({
    usdcAddress: props.usdcAddress,
    chainId: props.chainId,
    harnessAddress: harnessAccount?.address ?? null,
    // recipient passes through state owned by the view; we read the
    // first wallet here as a conservative default so an "unmounted"
    // tab still renders a recipient balance once the user opens it.
    recipient:
      props.walletAddresses[0] && isAddress(props.walletAddresses[0])
        ? props.walletAddresses[0]
        : null,
    rmTokenAddress: props.rmTokenAddress,
  });

  return (
    <FaucetTabView
      usdcAddress={props.usdcAddress}
      chainId={props.chainId}
      walletAddresses={props.walletAddresses}
      harnessPrivateKey={props.harnessPrivateKey}
      harnessBalance={balances.harness.data}
      harnessBalancePending={balances.harness.isPending}
      harnessBalanceError={balances.harness.error}
      recipientBalance={balances.recipient.data}
      refetchRecipientBalance={balances.recipient.refetch}
      drip={props.drip ?? dripUsdc}
      rmTokenAddress={props.rmTokenAddress}
      harnessRmBalance={balances.harnessRm.data}
      dripRm={props.dripRm ?? dripRmToken}
    />
  );
}
