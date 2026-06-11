// Canonical: docs/architecture.md §7.2 — Stable product reason codes

/**
 * Stable product reason-code union.
 *
 * Every failed operation in the dapp must surface one of these codes so
 * that the PRD §2 success metric ("percentage of failed operations that
 * return a clear product reason") can be measured. Architecture §7.2
 * mandates exactly these nine codes plus a catch-all for unrecognised
 * on-chain reverts.
 *
 * The codes are intentionally snake_case strings (not numeric enum values)
 * so they are stable across refactors and can be matched in logs and tests
 * without importing the enum.
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

/**
 * EVM custom-error selector → ProductReasonCode mapping.
 *
 * Each entry is the 4-byte hex selector (first 4 bytes of keccak256 of the
 * error signature) for a known on-chain custom error, mapped to the
 * corresponding product reason code.
 *
 * Add new entries here as new custom errors are introduced to the contracts.
 * Selectors are lowercase hex without leading zeros beyond the 8 hex chars.
 */
const SELECTOR_MAP: Record<string, ProductReasonCode> = {
  // GatewayPaused() — gateway.paused() == true
  "0x1a7e0d23": "paused",
  // VaultPaused() — source vault reports paused() == true
  "0x6d50a6ce": "paused",
  // EnforcedPause() — OZ Pausable standard error (used by vault and gateway)
  "0xd93c0665": "paused",
  // VaultDisabled() — vault is disabled / not registered
  "0x3a81d6fc": "vault_disabled",
  // CapExceeded() — per-payment or per-window cap exceeded
  "0x9f32e927": "cap_exceeded",
  // WithdrawCapExceeded() — per-payment or per-window withdrawal cap exceeded
  "0x12c4d14b": "cap_exceeded",
  // PolicyExpired() — agent policy validUntil < block.timestamp
  "0x8d5e3e5d": "expired_policy",
  // AllowanceInsufficient() / ERC20InsufficientAllowance — token allowance < amount
  "0x13be252b": "insufficient_allowance",
  // ERC20InsufficientAllowance (OZ standard)
  "0xfb8f41b2": "insufficient_allowance",
  // BalanceInsufficient() / ERC20InsufficientBalance
  "0xdfd1fc1b": "insufficient_balance",
  // ERC20InsufficientBalance (OZ standard)
  "0xe450d38c": "insufficient_balance",
  // LegUnavailable() — router leg vault is unavailable (e.g. full, paused)
  "0x8562ca85": "unavailable_leg",
  // FeeCapExceeded() — computed maxFeePerGas exceeds operator cap
  "0x35f3f5e8": "fee_cap_exceeded",
  // SlippageBoundExceeded() — minSharesPerLeg not satisfied
  "0xb3b72aca": "slippage_bound_exceeded",
};

/**
 * Map a raw EVM revert payload (or error message string) to a stable
 * ProductReasonCode.
 *
 * Accepts either a hex-encoded revert payload (starts with "0x") — in which
 * case the first 4 bytes are compared against the known custom-error selector
 * table — or a plain-text revert reason string which is matched against known
 * revert message patterns.
 *
 * Unrecognised errors always map to "unknown_revert" rather than leaking
 * raw on-chain data to the product UI.
 *
 * @param revert  Raw revert data from viem's ContractFunctionRevertedError
 *                `.data` field, or a revert reason string. May be undefined.
 */
export function mapEvmRevertToProductReason(revert: string | undefined): ProductReasonCode {
  if (!revert) return "unknown_revert";

  // Hex-encoded custom error: inspect the 4-byte selector.
  if (revert.startsWith("0x") && revert.length >= 10) {
    const selector = revert.slice(0, 10).toLowerCase();
    const mapped = SELECTOR_MAP[selector];
    if (mapped) return mapped;
  }

  // Plain-text revert reason matching (fallback for older-style reverts).
  const lower = revert.toLowerCase();
  if (lower.includes("paused")) return "paused";
  if (lower.includes("vault_disabled") || lower.includes("vaultdisabled")) return "vault_disabled";
  if (lower.includes("cap exceeded") || lower.includes("capexceeded")) return "cap_exceeded";
  if (lower.includes("expired") || lower.includes("policy expired")) return "expired_policy";
  if (lower.includes("allowance")) return "insufficient_allowance";
  if (lower.includes("balance")) return "insufficient_balance";
  if (lower.includes("unavailable")) return "unavailable_leg";
  if (lower.includes("fee cap")) return "fee_cap_exceeded";
  if (lower.includes("slippage")) return "slippage_bound_exceeded";

  return "unknown_revert";
}
