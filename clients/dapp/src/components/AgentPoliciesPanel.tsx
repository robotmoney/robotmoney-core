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
 * docs/architecture.md §5.3.
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
