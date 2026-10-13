// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * VaultCards — landing-page summary cards for the registered vault set.
 *
 * Renders one tile per registered vault, matching the four PRD §11 categories
 * once the demo seed has run (issue #479): the three Active router vaults plus
 * the RWA/Thematic placeholder. A tile is rendered in an inactive presentation
 * (Future / Coming soon, no deposit affordance, SPECULATIVE / Prototype label)
 * whenever its `status` is non-Active. That status is on-chain registry state
 * surfaced by the explorer `/v1/vaults` indexer read — it is NOT a hard-coded
 * per-vault flag, so the same code marks any non-Active vault inactive in
 * every environment (single-production-codebase,
 * docs/development/single-production-codebase.md).
 *
 * Data comes from ExplorerContext (shared polling loop in main.tsx), so this
 * component and VaultList always display the same block_number — no
 * mixed-block state. The pollInterval prop is forwarded to ExplorerProvider in
 * tests to control re-fetch timing without fake timers.
 *
 * The Status shown on a card is the DEPOSIT state (issue 1731), not the bare registry status: a vault the
 * registry calls Active can have `depositsPaused()` set. `resolveDepositState` combines the registry status,
 * the vault's own flag read from the chain, and the explorer's snapshot flag. "Active" is shown only when
 * deposits are known to be open. A paused vault says "Deposits paused / closed", and a vault whose state
 * cannot be read says so.
 *
 * Each vault card now includes a 'Details' link (issue #941) that navigates to
 * the Portfolio Explorer tab and opens VaultDetail for that vault.
 * onSelectVault is called with the vault address; onSwitchToExplorer switches
 * the enclosing Tabs to the portfolio-explorer panel. No wallet connection is
 * required.
 */
import { useExplorer } from "../lib/ExplorerContext";
import { formatUsdcString } from "../lib/format";
import { IndexFreshness } from "./IndexFreshness";
import { useVaultsDepositsPaused } from "../lib/useVaultsDepositsPaused";
import {
  depositStateAttr,
  depositStateLabel,
  depositStateReason,
  depositStateSource,
  resolveDepositState,
} from "../lib/vaultDepositState";

/**
 * Active is status 0 in `VaultRegistry.VaultStatus` (0=Active, 1=DepositsPaused,
 * 2=Retired). Any other value is an inactive vault that takes no deposits.
 */
const VAULT_STATUS_ACTIVE = 0;

interface VaultCardsProps {
  /** Called with the vault address when the user clicks 'Details'. */
  onSelectVault?: (address: string) => void;
  /** Called (after onSelectVault) to switch the enclosing Tabs to Portfolio Explorer. */
  onSwitchToExplorer?: () => void;
}

export function VaultCards({ onSelectVault, onSwitchToExplorer }: VaultCardsProps = {}) {
  const { vaults, blockNumber, chainHeadBlock, vaultsLoading, vaultsError } = useExplorer();
  const { byAddress: chainPaused } = useVaultsDepositsPaused(vaults.map((v) => v.address));

  if (vaultsLoading) {
    return (
      <section className="landing-vaults" data-testid="landing-vault-cards">
        <h2>Vaults</h2>
        <p data-testid="landing-vault-cards-loading">Loading vaults…</p>
      </section>
    );
  }

  if (vaultsError) {
    return (
      <section className="landing-vaults" data-testid="landing-vault-cards">
        <h2>Vaults</h2>
        <p data-testid="landing-vault-cards-error">{vaultsError}</p>
      </section>
    );
  }

  function handleDetails(address: string) {
    onSelectVault?.(address);
    onSwitchToExplorer?.();
  }

  return (
    <section className="landing-vaults" data-testid="landing-vault-cards">
      <div className="section-heading-row">
        <h2>Vaults</h2>
        <IndexFreshness
          blockNumber={blockNumber}
          chainHeadBlock={chainHeadBlock}
          testId="landing-vault-cards-freshness"
        />
      </div>
      {vaults.length === 0 ? (
        <p data-testid="landing-vault-cards-empty">No vaults registered yet.</p>
      ) : (
        <div className="vault-card-grid">
          {vaults.map((vault) => {
            // Inactive presentation is driven by the on-chain registry status
            // surfaced through the indexer — not a per-vault constant.
            const isActive = vault.status === VAULT_STATUS_ACTIVE;
            const deposit = resolveDepositState({
              registryStatus: vault.status,
              explorerPaused: vault.deposits_paused,
              explorerBlock: blockNumber,
              explorerHead: chainHeadBlock,
              chainPaused: chainPaused.get(vault.address.toLowerCase()),
            });
            return (
              <article
                key={vault.address}
                className={
                  !isActive
                    ? "vault-card vault-card-inactive"
                    : deposit.kind === "open"
                      ? "vault-card"
                      : "vault-card vault-card-deposits-closed"
                }
                data-testid="landing-vault-card"
                data-vault-active={isActive ? "true" : "false"}
                data-deposit-state={depositStateAttr(deposit)}
                data-deposit-source={depositStateSource(deposit)}
              >
                <div>
                  <p className="vault-card-kicker" data-testid="landing-vault-card-risk">
                    {vault.risk_label}
                  </p>
                  <h3 data-testid="landing-vault-card-name">{vault.name}</h3>
                </div>
                {isActive && deposit.kind !== "open" && (
                  <p
                    className="vault-card-deposits-closed-note"
                    data-testid="landing-vault-card-deposits-closed"
                    style={{
                      color: deposit.kind === "unknown" ? "orange" : "red",
                      fontWeight: 600,
                    }}
                  >
                    {depositStateReason(deposit)}
                  </p>
                )}
                {isActive ? (
                  <dl>
                    <div>
                      <dt>Status</dt>
                      <dd data-testid="landing-vault-card-status">{depositStateLabel(deposit)}</dd>
                    </div>
                    <div>
                      <dt>TVL</dt>
                      <dd data-testid="landing-vault-card-tvl">
                        {formatUsdcString(vault.total_assets)}
                      </dd>
                    </div>
                    <div>
                      <dt>Exit Fee</dt>
                      <dd data-testid="landing-vault-card-fee">
                        {vault.exit_fee_bps == null ? "—" : `${vault.exit_fee_bps} bps`}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  // No deposit affordance and no live stats for an inactive
                  // vault — only a Future / Coming-soon notice (issue #479).
                  <p className="vault-card-future" data-testid="landing-vault-card-future">
                    Future — coming soon
                  </p>
                )}
                <button
                  type="button"
                  data-testid="landing-vault-card-details"
                  className="vault-card-details-link"
                  onClick={() => handleDetails(vault.address)}
                >
                  Details
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
