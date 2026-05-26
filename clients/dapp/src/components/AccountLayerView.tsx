// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * AccountLayerView — issue #319, account layer.
 *
 * Composes the account-layer components:
 *   - WatchedAddressInput: enter any address for read-only inspection
 *   - PortfolioPosition: per-vault receipt-token balances
 *   - TransactionHistory: chronological event log across all vaults
 *   - AgentPoliciesPanel: agent policies owned by the address
 *
 * A connected wallet address (from wagmi) is passed in as the
 * `connectedAddress` prop and pre-fills the input so the user
 * does not have to re-type their own address. Watched-address mode
 * requires no wallet — the form accepts any valid Ethereum address.
 *
 * Live USDC conversion (vault.convertToAssets) is intentionally left to
 * the parent or a future companion hook; this component renders "—" when
 * `usdcValues` is not provided.
 *
 * docs/architecture.md §5.3.
 */
import { useState } from "react";
import type { Address } from "viem";
import { WatchedAddressInput } from "./WatchedAddressInput";
import { PortfolioPosition } from "./PortfolioPosition";
import { TransactionHistory } from "./TransactionHistory";
import { AgentPoliciesPanel } from "./AgentPoliciesPanel";

export interface AccountLayerViewProps {
  /** Resolved explorer API base URL (no trailing slash). */
  readonly apiUrl: string;
  /** Connected wallet address, if any. Pre-fills the watched-address input. */
  readonly connectedAddress?: Address;
  /**
   * Optional USDC value map from vault address to USDC amount string.
   * Injected by the parent after on-chain `vault.convertToAssets` reads.
   */
  readonly usdcValues?: Readonly<Record<string, string>>;
}

export function AccountLayerView({ apiUrl, connectedAddress, usdcValues }: AccountLayerViewProps) {
  const [watchedAddress, setWatchedAddress] = useState<Address | undefined>(undefined);

  return (
    <section data-testid="account-layer-view">
      <h2>Account inspector</h2>
      <p className="hint">
        Enter any Ethereum address to inspect portfolio positions and transaction history without
        connecting a wallet.
      </p>

      <WatchedAddressInput defaultAddress={connectedAddress} onAddress={setWatchedAddress} />

      {watchedAddress !== undefined && (
        <>
          <PortfolioPosition address={watchedAddress} apiUrl={apiUrl} usdcValues={usdcValues} />
          <TransactionHistory address={watchedAddress} apiUrl={apiUrl} />
          <AgentPoliciesPanel ownerAddress={watchedAddress} policies={[]} />
        </>
      )}
    </section>
  );
}
