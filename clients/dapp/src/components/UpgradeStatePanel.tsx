// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3, §5 — proxies, the timelock authority, the freeze

/**
 * UpgradeStatePanel — discloses which implementation runs behind one proxied
 * contract, whether the timelock can still replace it, and who can (QA plan P3,
 * core issue 1810). The vault page shows it for its vault;
 * `ProtocolUpgradesPanel` shows it for the gateway, the router, the registry,
 * the IC policy and the receipt contract. The view is pure
 * (`UpgradeStateView`) so tests render each state without a chain;
 * `UpgradeStatePanel` feeds it the live reads.
 */
import { useUpgradeState } from "../lib/useUpgradeState";
import { upgradeStateExplanation, upgradeStateLabel, type UpgradeState } from "../lib/upgradeState";

/**
 * Stable attribute for tests and styling: loading, unknown, unavailable, direct, frozen,
 * upgradeable, proxy, indexed-frozen or indexed-upgradeable.
 */
function upgradeStateAttr(state: UpgradeState): string {
  if (state.kind === "indexed") return state.frozen ? "indexed-frozen" : "indexed-upgradeable";
  if (state.kind !== "proxy") return state.kind;
  if (state.frozen === true) return "frozen";
  if (state.frozen === false) return "upgradeable";
  return "proxy";
}

export function UpgradeStateView({
  state,
  title = "Upgrades",
  testId = "vault-detail-upgrade",
}: {
  state: UpgradeState;
  /** Heading of the block: "Upgrades" on the vault page, the contract name elsewhere. */
  title?: string;
  /** Prefix of every `data-testid` in the block. */
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="vault-detail-upgrade"
      data-upgrade-state={upgradeStateAttr(state)}
    >
      <h3>{title}</h3>
      <p data-testid={`${testId}-status`} className="stat-value">
        {upgradeStateLabel(state)}
      </p>
      <p className="hint" data-testid={`${testId}-explanation`}>
        {upgradeStateExplanation(state)}
      </p>
      {state.kind === "proxy" && (
        <dl className="vault-detail-upgrade-facts">
          <dt>Implementation</dt>
          <dd data-testid={`${testId}-implementation`} className="font-mono">
            {state.implementation}
          </dd>
          <dt>Implementation code hash</dt>
          <dd data-testid={`${testId}-code-hash`} className="font-mono">
            {state.implementationCodeHash ?? "unknown"}
          </dd>
          <dt>Upgrade authority (timelock)</dt>
          <dd data-testid={`${testId}-authority`} className="font-mono">
            {state.authority ?? "unknown"}
          </dd>
        </dl>
      )}
      {state.kind === "indexed" && state.implementation !== null && (
        <dl className="vault-detail-upgrade-facts">
          <dt>Implementation (indexed)</dt>
          <dd data-testid={`${testId}-implementation`} className="font-mono">
            {state.implementation}
          </dd>
        </dl>
      )}
    </div>
  );
}

export function UpgradeStatePanel({
  address,
  title,
  testId,
}: {
  address: string;
  title?: string;
  testId?: string;
}) {
  return <UpgradeStateView state={useUpgradeState(address)} title={title} testId={testId} />;
}
