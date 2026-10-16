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
 * Position value is what the shares pay at redeem (`vault.previewRedeem`,
 * core 1795, QA plan X8). PortfolioPosition reads it for the watched address's
 * own shares, so the parent passes nothing: a map built in the parent would be
 * keyed to the connected wallet, not to the address being inspected.
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
   * Optional override of PortfolioPosition's own `previewRedeem` values: vault
   * address to the USDC amount string the shares pay at redeem.
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
