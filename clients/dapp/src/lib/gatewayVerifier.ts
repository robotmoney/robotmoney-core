// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway, §7.2 — Stable product reason codes

/**
 * Gateway bytecode hash verifier (pure — no wagmi/viem side effects).
 *
 * Implements the fail-closed spec from issue #207:
 *   - Missing expected hash           → refused (no writes enabled)
 *   - Zero gateway address            → refused
 *   - Empty bytecode (undeployed)     → refused
 *   - keccak256(code) ≠ expectedHash  → refused with mismatch detail
 *   - keccak256(code) == expectedHash → verified
 *
 * The caller is responsible for fetching `code` via the wagmi/viem
 * client (see useGatewayVerifier.ts). Keeping this layer pure makes it
 * straightforward to unit-test without any React or wagmi machinery.
 *
 * Every refusal carries a `cause` (QA plan U5, finding DR-9). The product
 * reason code stays `unknown_revert` for all of them, but the banner prints
 * one sentence per cause (`describeVerificationCause`), so a missing pin, a
 * wallet on the wrong chain, an RPC failure and a hash mismatch no longer
 * read the same.
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";
import type { ProductReasonCode } from "./productReasonCode";

/** Why the gateway was not verified. One cause, one banner sentence. */
export type VerificationCause =
  | "pin-missing"
  | "address-missing"
  | "no-code"
  | "hash-mismatch"
  | "wrong-chain"
  | "no-wallet"
  | "rpc-failed";

export type VerificationState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "verified"; computedHash: Hex }
  | {
      status: "refused";
      /**
       * Typed stable product reason code (Architecture §7.2).
       * The free-form `string` surface has been replaced by this typed union.
       */
      reason: ProductReasonCode;
      /** What went wrong, for the banner (QA plan U5). */
      cause: VerificationCause;
    };

/** The refused state for `cause`. Every refusal maps to the `unknown_revert` product code. */
export function refusedVerification(cause: VerificationCause): VerificationState {
  return { status: "refused", reason: "unknown_revert", cause };
}

/** The one sentence the banner prints for a refusal cause. */
export function describeVerificationCause(cause: VerificationCause): string {
  switch (cause) {
    case "pin-missing":
      return "This build carries no gateway code-hash pin (VITE_GATEWAY_EXPECTED_CODE_HASH), so the gateway cannot be verified.";
    case "address-missing":
      return "No gateway address is configured for this deployment.";
    case "no-code":
      return "The configured gateway address has no contract code on the chain your wallet is on.";
    case "hash-mismatch":
      return "The code at the gateway address does not match the pinned code hash. Do not sign anything against it.";
    case "wrong-chain":
      return "Your wallet is on a different chain from this deployment. Switch chains, then re-verify.";
    case "no-wallet":
      return "No browser wallet was found to read the gateway code through.";
    case "rpc-failed":
      return "Your wallet's RPC did not answer the gateway code read after several tries. Re-verify, or check the wallet's network.";
  }
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Compute the keccak256 of on-chain bytecode and compare it to the
 * expected runtime hash. Returns a VerificationState.
 *
 * @param gatewayAddress  The gateway contract address as a hex string.
 * @param expectedHash    The operator-pinned expected runtime hash
 *                        (`VITE_GATEWAY_EXPECTED_CODE_HASH`). May be
 *                        undefined/empty when the env var is absent.
 * @param code            The bytecode returned by getBytecode(). Pass
 *                        `undefined` when the fetch is still in flight,
 *                        `null` when the fetch resolved with no code
 *                        (i.e. address is not a contract).
 */
export function computeVerificationState(
  gatewayAddress: string,
  expectedHash: string | undefined,
  code: Hex | undefined | null,
): VerificationState {
  // Fail closed: missing expected hash → refuse.
  if (!expectedHash || expectedHash.trim() === "") {
    return refusedVerification("pin-missing");
  }

  // Fail closed: zero or missing gateway address → refuse.
  if (!gatewayAddress || gatewayAddress === ZERO_ADDRESS) {
    return refusedVerification("address-missing");
  }

  // Still fetching bytecode → pending.
  if (code === undefined) {
    return { status: "pending" };
  }

  // Fail closed: no bytecode at address → refuse.
  // code is typed as Hex (0x-prefixed), so empty means "0x".
  if (code === null || (code as string) === "0x" || (code as string) === "") {
    return refusedVerification("no-code");
  }

  // Compute the runtime hash and compare.
  const computedHash = keccak256(code);
  if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return refusedVerification("hash-mismatch");
  }

  return { status: "verified", computedHash };
}
