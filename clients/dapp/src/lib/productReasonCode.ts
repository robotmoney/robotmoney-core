// Canonical: docs/architecture.md §7.2 — Execution Results

/**
 * Stable product-level refusal codes shared by dapp previews and API results.
 *
 * Issue #670 owns wiring EVM custom errors and existing free-form refusal
 * messages to this contract. This scout intentionally exports only the type
 * seam so current runtime behavior remains unchanged.
 */
export type ProductReasonCode =
  | "paused"
  | "vault_disabled"
  | "cap_exceeded"
  | "expired_policy"
  | "insufficient_allowance"
  | "insufficient_balance"
  | "unavailable_leg"
  | "fee_cap_exceeded"
  | "slippage_bound_exceeded"
  | "unknown_revert";

