// Canonical: docs/architecture.md §5.3 — Human Dapp

import { BASE_MAINNET_CHAIN_ID, BASE_MAINNET_CHAIN_NAME } from "../lib/writeChainGuard";

/**
 * MainnetBanner (issue 1729): the persistent, non-dismissible banner on the
 * `mainnet` env class. It has no close control and no state on purpose.
 */
export function MainnetBanner({ envClass }: { envClass: string }) {
  if (envClass !== "mainnet") return null;
  return (
    <div className="mainnet-banner" data-testid="mainnet-banner" role="status">
      <span className="mainnet-banner-tag">
        {BASE_MAINNET_CHAIN_NAME} mainnet {"—"} real funds
      </span>
      <span className="mainnet-banner-body">
        Network: {BASE_MAINNET_CHAIN_NAME} (chain {BASE_MAINNET_CHAIN_ID}). Transactions here move
        real USDC.
      </span>
    </div>
  );
}
