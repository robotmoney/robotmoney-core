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
 */
import { keccak256 } from "viem";
import type { Hex } from "viem";

export type VerificationState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "verified"; computedHash: Hex }
  | { status: "refused"; reason: string };

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
    return {
      status: "refused",
      reason:
        "VITE_GATEWAY_EXPECTED_CODE_HASH is not set. " +
        "Configure the expected runtime hash to enable admin writes.",
    };
  }

  // Fail closed: zero or missing gateway address → refuse.
  if (!gatewayAddress || gatewayAddress === ZERO_ADDRESS) {
    return {
      status: "refused",
      reason:
        "Gateway address is zero or missing. " +
        "Set VITE_GATEWAY_ADDRESS to the deployed contract address.",
    };
  }

  // Still fetching bytecode → pending.
  if (code === undefined) {
    return { status: "pending" };
  }

  // Fail closed: no bytecode at address → refuse.
  // code is typed as Hex (0x-prefixed), so empty means "0x".
  if (code === null || (code as string) === "0x" || (code as string) === "") {
    return {
      status: "refused",
      reason:
        "Gateway bytecode is empty. The address is not a deployed contract " +
        "on the current network.",
    };
  }

  // Compute the runtime hash and compare.
  const computedHash = keccak256(code);
  if (computedHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return {
      status: "refused",
      reason:
        `Gateway bytecode hash mismatch. ` +
        `Expected ${expectedHash} but got ${computedHash}. ` +
        `Refusing to surface signing prompts.`,
    };
  }

  return { status: "verified", computedHash };
}
