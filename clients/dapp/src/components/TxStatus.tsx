// Canonical: docs/technical/security-model.md §12 — Off-chain chain & infrastructure

/**
 * TxStatus — surfaces the per-operation-class finality distinction from
 * `rmpc get-tx` JSON output (issue #676).
 *
 * Reads the `finality` object from the rmpc `get-tx` response and renders
 * a human-readable status distinguishing "L2 included" from "L1 finalized"
 * so that users understand when a transaction is sequencer-confirmed versus
 * irreversibly settled on L1.
 *
 * Policy (security-model.md §12 / confirmation_policy.rs):
 *   - `pending`      — included but below minimum confirmation depth
 *   - `l2_included`  — confirmed on L2 (≥ op-class minimum)
 *   - `l1_finalized` — confirmed on L1 (≥ 64 blocks, Base safe-head)
 *
 * This component is intentionally display-only; it never issues RPC calls.
 * Callers feed the `finality` object from a pre-fetched rmpc JSON payload.
 */

/** Finality status values from rmpc get-tx output. */
export type FinalityStatusValue = "pending" | "l2_included" | "l1_finalized";

/** The `finality` object embedded in every successful `rmpc get-tx` response. */
export interface FinalityInfo {
  /** Derived finality status. */
  readonly status: FinalityStatusValue;
  /** Blocks since the tx's inclusion block (0 = just mined). */
  readonly confirmations: number;
  /** Minimum confirmations required by the operation class policy. */
  readonly required_confirmations: number;
  /** Operation class used to look up `required_confirmations`. */
  readonly op_class: "deposit" | "withdraw" | "vault_rebalance" | "admin_governance";
}

export interface TxStatusProps {
  /** The finality sub-object from an rmpc `get-tx` JSON response. */
  readonly finality: FinalityInfo;
}

/** Human-readable label and description for each finality status. */
const FINALITY_COPY: Record<
  FinalityStatusValue,
  { label: string; description: string; testId: string }
> = {
  pending: {
    label: "Pending finality",
    description:
      "The transaction is included in an L2 block but has not yet accumulated " +
      "enough confirmations for this operation class.",
    testId: "tx-status-pending",
  },
  l2_included: {
    label: "L2 included",
    description:
      "The transaction is confirmed on the Base L2 sequencer. For most agent " +
      "operations this is sufficient. Admin and governance operations require " +
      "L1 finalization.",
    testId: "tx-status-l2-included",
  },
  l1_finalized: {
    label: "L1 finalized",
    description:
      "The transaction is covered by an L1 batch with enough L1 confirmations " +
      "to be considered irreversible. Required for admin and governance operations.",
    testId: "tx-status-l1-finalized",
  },
};

/**
 * TxStatus renders the finality status from an rmpc `get-tx` `finality` object.
 *
 * It surfaces:
 * - A human-readable status label (Pending / L2 included / L1 finalized)
 * - The observed and required confirmation counts
 * - A brief description explaining what the status means
 */
export function TxStatus({ finality }: TxStatusProps) {
  const copy = FINALITY_COPY[finality.status] ?? FINALITY_COPY.pending;

  return (
    <div data-testid="tx-status" aria-label={`Transaction finality: ${copy.label}`}>
      <span data-testid={copy.testId} aria-live="polite">
        {copy.label}
      </span>
      <span data-testid="tx-status-confirmations">
        {finality.confirmations}/{finality.required_confirmations} confirmations
      </span>
      <span data-testid="tx-status-description">{copy.description}</span>
    </div>
  );
}
