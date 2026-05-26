// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

/**
 * AgentPoliciesPanel — issue #319, account layer.
 *
 * Shows agent policies owned by a watched address. Reads active policies
 * from `GET /v1/agents/:agent/deposits` (indirectly via the existing
 * `agentOwner` on-chain lookup) and surfaces the withdrawal policy
 * fields: `assetRecipient` and `allowedSourceVaults`.
 *
 * For the account-layer use case the panel receives a pre-fetched list of
 * `AgentPolicyEntry` objects (the caller reads on-chain via
 * `gateway.agentOwner(agent)` to find which agents belong to the address,
 * then fetches each policy via `GET /v1/agents/:address`). This keeps the
 * component pure and testable without RPC.
 *
 * Extends the existing `PolicyFields` surface (issue #269) with the
 * withdrawal-specific fields `assetRecipient` and `allowedSourceVaults`
 * required by the account layer scope in issue #319.
 *
 * Allowance-hygiene surfacing (issue #429): each entry can carry a
 * `shareAllowance` (the agent's outstanding vault.allowance to the
 * gateway) and a `withdrawalsEnabled` flag. The panel renders an
 * inline warning when withdrawals are enabled and a "revoke" affordance
 * (via an optional callback) when the allowance is stale (non-zero
 * while withdrawals are disabled). The callback contract is
 * intentionally narrow — the panel does not assume a transport; the
 * caller turns the click into an on-chain `approve(gateway, 0)` tx.
 *
 * docs/architecture.md §5.3.
 * Security: docs/code-reviews/review-codex-20260518-234945.md §5.
 */
import type { Address } from "viem";

export interface AgentPolicyEntry {
  /** Agent address (0x-prefixed). */
  readonly agent: Address;
  readonly authorized: boolean;
  readonly validUntil?: string;
  readonly maxPerPayment?: string;
  readonly maxPerWindow?: string;
  readonly shareReceiver?: string;
  /**
   * Withdrawal policy: the address that receives USDC on withdrawal.
   * Null when not set.
   */
  readonly assetRecipient?: string;
  /**
   * Withdrawal policy: list of vault addresses the agent may withdraw from.
   * Null/empty when not set.
   */
  readonly allowedSourceVaults?: readonly string[];
  /**
   * Issue #429: `maxWithdrawPerPayment > 0` on the agent policy. The
   * panel renders a high-visibility warning when this is true so the
   * depositor sees the agent-key compromise blast radius.
   */
  readonly withdrawalsEnabled?: boolean;
  /**
   * Per-window withdrawal cap, decimal string. Surfaced under the
   * warning so the user can compare it with their share balance.
   */
  readonly maxWithdrawPerWindow?: string;
  /**
   * Outstanding `vault.allowance(agent, gateway)`, decimal string.
   * Used together with `withdrawalsEnabled` to flag stale allowances
   * (issue #429: scope item "revoke stale gateway share allowances").
   */
  readonly shareAllowance?: string;
}

/**
 * Stable predicate for "agent has a leftover gateway share allowance
 * but withdrawals are not enabled on the policy". The flag is the hook
 * the revoke-allowance affordance hangs off (issue #429).
 */
export function isStaleShareAllowance(policy: AgentPolicyEntry): boolean {
  return policy.withdrawalsEnabled === false && (policy.shareAllowance ?? "0") !== "0";
}

export interface AgentPoliciesPanelProps {
  /** Address whose agent policies to display. */
  readonly ownerAddress: Address;
  /** Pre-fetched agent policies for this owner. */
  readonly policies: readonly AgentPolicyEntry[];
  /** True while the caller is still loading policies. */
  readonly loading?: boolean;
  /** Non-null when the caller failed to load policies. */
  readonly error?: string;
  /**
   * Optional callback invoked when the user clicks "Revoke share
   * allowance" on a stale-allowance entry. Issue #429: the caller is
   * responsible for translating this into an on-chain
   * `vault.approve(gateway, 0)` transaction; the panel stays pure.
   * When omitted, the button still renders but is non-interactive —
   * the warning text alone is the documented mitigation path.
   */
  readonly onRevokeShareAllowance?: (agent: Address) => void;
}

export function AgentPoliciesPanel(props: AgentPoliciesPanelProps) {
  return (
    <section data-testid="agent-policies-panel">
      <h2>Agent policies</h2>
      <p data-testid="agent-policies-owner">
        Owner: <code>{props.ownerAddress}</code>
      </p>

      {props.loading && <p data-testid="agent-policies-loading">Loading agent policies…</p>}

      {props.error && (
        <p data-testid="agent-policies-error">Failed to load policies: {props.error}</p>
      )}

      {!props.loading &&
        !props.error &&
        (props.policies.length === 0 ? (
          <p data-testid="agent-policies-empty">No agent policies found for this address.</p>
        ) : (
          <ul data-testid="agent-policies-list">
            {props.policies.map((policy) => (
              <li key={policy.agent} data-testid="agent-policy-entry">
                <details>
                  <summary data-testid="agent-policy-agent">
                    <code>{policy.agent}</code>{" "}
                    {policy.authorized ? (
                      <span data-testid="agent-policy-status-active">(active)</span>
                    ) : (
                      <span data-testid="agent-policy-status-revoked">(revoked)</span>
                    )}
                  </summary>
                  {policy.withdrawalsEnabled === true && (
                    <p
                      data-testid="agent-policy-withdrawal-warning"
                      role="alert"
                      style={{ color: "var(--rm-warning, #b34700)", fontWeight: 600 }}
                    >
                      WARNING: withdrawals enabled. An agent-key compromise can redeem up to{" "}
                      <code data-testid="agent-policy-withdrawal-warning-cap">
                        {policy.maxWithdrawPerWindow ?? "(unknown cap)"}
                      </code>{" "}
                      shares per window to <code>{policy.assetRecipient ?? "(unset)"}</code>. Keep
                      assetRecipient under your sole control and revoke unused gateway share
                      allowance below.
                    </p>
                  )}
                  {isStaleShareAllowance(policy) && (
                    <div data-testid="agent-policy-stale-allowance" role="alert">
                      <p>
                        Stale gateway share allowance:{" "}
                        <code data-testid="agent-policy-stale-allowance-amount">
                          {policy.shareAllowance}
                        </code>{" "}
                        shares. Withdrawals are disabled, but this allowance lets a future
                        re-authorization or compromised admin path move shares without further
                        approval. Revoke when unused.
                      </p>
                      <button
                        type="button"
                        data-testid="agent-policy-revoke-allowance"
                        onClick={
                          props.onRevokeShareAllowance
                            ? () => props.onRevokeShareAllowance?.(policy.agent)
                            : undefined
                        }
                        disabled={!props.onRevokeShareAllowance}
                      >
                        Revoke share allowance
                      </button>
                    </div>
                  )}
                  <dl data-testid="agent-policy-fields">
                    {policy.validUntil !== undefined && (
                      <>
                        <dt>Valid until</dt>
                        <dd data-testid="agent-policy-valid-until">{policy.validUntil}</dd>
                      </>
                    )}
                    {policy.maxPerPayment !== undefined && (
                      <>
                        <dt>Max per payment</dt>
                        <dd data-testid="agent-policy-max-per-payment">{policy.maxPerPayment}</dd>
                      </>
                    )}
                    {policy.maxPerWindow !== undefined && (
                      <>
                        <dt>Max per window</dt>
                        <dd data-testid="agent-policy-max-per-window">{policy.maxPerWindow}</dd>
                      </>
                    )}
                    {policy.shareReceiver !== undefined && (
                      <>
                        <dt>Share receiver</dt>
                        <dd data-testid="agent-policy-share-receiver">{policy.shareReceiver}</dd>
                      </>
                    )}
                    {/* Withdrawal policy fields (issue #319 extension) */}
                    {policy.assetRecipient !== undefined && (
                      <>
                        <dt>Asset recipient (withdrawal)</dt>
                        <dd data-testid="agent-policy-asset-recipient">{policy.assetRecipient}</dd>
                      </>
                    )}
                    {policy.maxWithdrawPerWindow !== undefined && (
                      <>
                        <dt>Max withdrawal per window (shares)</dt>
                        <dd data-testid="agent-policy-max-withdraw-per-window">
                          {policy.maxWithdrawPerWindow}
                        </dd>
                      </>
                    )}
                    {policy.shareAllowance !== undefined && (
                      <>
                        <dt>Gateway share allowance</dt>
                        <dd data-testid="agent-policy-share-allowance">{policy.shareAllowance}</dd>
                      </>
                    )}
                    {policy.allowedSourceVaults !== undefined &&
                      policy.allowedSourceVaults.length > 0 && (
                        <>
                          <dt>Allowed source vaults</dt>
                          <dd data-testid="agent-policy-allowed-source-vaults">
                            <ul>
                              {policy.allowedSourceVaults.map((v) => (
                                <li key={v} data-testid="agent-policy-source-vault">
                                  <code>{v}</code>
                                </li>
                              ))}
                            </ul>
                          </dd>
                        </>
                      )}
                  </dl>
                </details>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
