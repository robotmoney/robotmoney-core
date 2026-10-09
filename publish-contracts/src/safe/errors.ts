// Typed errors for the Safe tool. Every failure carries a stable `code` so callers (the stage runner, tests, the CLI) branch on
// the code, never on message text. A Safe revert keeps the Safe's own GSxxx code, so the two negative controls are typed:
// GS020 (signatures data too short: below threshold) and GS026 (invalid owner: a non-owner signed).
export type SafeErrorCode =
  | "BAD_INPUT" | "CHAIN_UNREACHABLE" | "CHAIN_MISMATCH" | "CHAIN_NOT_ALLOWED" | "PLAINTEXT_KEY_REFUSED"
  | "NOT_A_SAFE" | "WRONG_SAFE_VERSION" | "ROSTER_INVALID" | "INFRA_MISSING" | "ADDRESS_OCCUPIED"
  | "CREATION_FAILED" | "VERIFY_FAILED" | "INSUFFICIENT_FUNDS"
  | "BUNDLE_INVALID" | "STALE_BUNDLE" | "HASH_MISMATCH" | "NOT_OWNER" | "SIGNATURE_INVALID" | "BELOW_THRESHOLD"
  | "TIMELOCK_INVALID" | "TIMELOCK_ROLE_MISSING" | "TIMELOCK_STATE" | "UNSAFE_DELAY" | "CALL_NOT_ALLOWED"
  | "SAFE_REVERT" | "SEND_FAILED" | "TX_REVERTED" | "NONCE_DID_NOT_MOVE" | "EFFECT_NOT_OBSERVED"
  | "SIGNER_UNAVAILABLE" | "PASSPHRASE_UNAVAILABLE" | "PASSPHRASE_FILE_PERMISSIONS" | "KEYSTORE_INVALID" | "WRONG_PASSPHRASE"
  | "HARDWARE_FAILED" | "HARDWARE_ADDRESS_MISMATCH" | "UNSUPPORTED_SIGN_MODE";

export class SafeToolError extends Error {
  readonly code: SafeErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: SafeErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SafeToolError";
    this.code = code;
    this.details = details;
  }
}

/** The Safe contract itself rejected a call. `gsCode` is the Safe's own error code, e.g. GS020 or GS026. */
export class SafeRevertError extends SafeToolError {
  readonly gsCode: string | undefined;
  readonly reason: string;
  constructor(reason: string, details: Record<string, unknown> = {}) {
    const gs = /GS\d{3}/.exec(reason)?.[0];
    super("SAFE_REVERT", gs ? `the Safe rejected the call with ${gs}: ${GS_MEANING[gs] ?? reason}` : `the Safe call reverted: ${reason}`, details);
    this.name = "SafeRevertError";
    this.gsCode = gs;
    this.reason = reason;
  }
}

/** The Safe 1.4.1 codes this tool meets in practice. */
export const GS_MEANING: Record<string, string> = {
  GS010: "not enough gas for the inner call",
  GS013: "the inner call failed and gas price is 0",
  GS020: "signatures data too short (fewer signatures than the threshold)",
  GS021: "invalid contract signature location: inside the static part",
  GS022: "invalid contract signature location: length not present",
  GS023: "invalid contract signature location: data not complete",
  GS024: "invalid contract signature provided",
  GS025: "hash has not been approved",
  GS026: "invalid owner provided (the signer is not an owner, or signatures are not sorted/unique)",
  GS030: "only owners can approve a hash",
};

export function isSafeToolError(e: unknown, code?: SafeErrorCode): e is SafeToolError {
  return e instanceof SafeToolError && (code === undefined || e.code === code);
}

/** Pulls the revert reason out of a viem error (or any error), keeping a GSxxx code when present. */
export function revertReasonOf(e: unknown): string {
  const anyE = e as { reason?: string; shortMessage?: string; message?: string; walk?: (fn: (x: unknown) => boolean) => unknown; cause?: unknown };
  let reason = anyE?.reason;
  try {
    if (!reason && typeof anyE?.walk === "function") {
      const inner = anyE.walk((x) => typeof (x as { reason?: string })?.reason === "string") as { reason?: string } | null;
      reason = inner?.reason;
    }
  } catch { /* fall through to the message */ }
  const text = reason ?? anyE?.shortMessage ?? anyE?.message ?? String(e);
  const gs = /GS\d{3}/.exec(`${reason ?? ""} ${anyE?.shortMessage ?? ""} ${anyE?.message ?? ""}`)?.[0];
  return gs ?? text;
}
