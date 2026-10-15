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
 * Implementation pin (issue 1810, ADR-0014 §10): behind an ERC-1967 proxy the
 * gateway's own code never changes across an upgrade, so the code-hash pin
 * alone would let the dapp sign against any implementation the timelock
 * installs. `computeImplementationVerification` adds a second, build-time pin
 * (`VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH`, one or more comma-separated
 * reviewed code hashes): a proxied gateway is verified only when its live
 * implementation's code hash is listed. A proxy with no pin, an implementation
 * with no code, and an unlisted hash each refuse. A pin for a gateway that is
 * not a proxy refuses too: the build expected a proxy.
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
import { implementationFromSlot } from "./upgradeState";

/** Why the gateway was not verified. One cause, one banner sentence. */
export type VerificationCause =
  | "pin-missing"
  | "address-missing"
  | "no-code"
  | "hash-mismatch"
  | "wrong-chain"
  | "no-wallet"
  | "rpc-failed"
  | "implementation-pin-missing"
  | "implementation-mismatch"
  | "implementation-unexpected";

export type VerificationState =
  | { status: "idle" }
  | { status: "pending" }
  | {
      status: "verified";
      computedHash: Hex;
      /**
       * The live implementation's code hash when the gateway is a proxy and that hash is one of
       * the build-time implementation pins. Absent for a direct gateway.
       */
      implementationHash?: Hex;
    }
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
    case "implementation-pin-missing":
      return "The gateway is an upgradeable proxy and this build carries no implementation pin (VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH), so the logic behind it cannot be verified.";
    case "implementation-mismatch":
      return "The implementation behind the gateway proxy is not a reviewed one this build pins. It may have been upgraded. Do not sign anything against it.";
    case "implementation-unexpected":
      return "This build pins a gateway implementation, but the gateway is not a proxy. Do not sign anything against it.";
  }
}

/** The build-time implementation pins: a comma-separated list of 32-byte hex hashes. Malformed entries are dropped. */
export function parseImplementationPins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{64}$/.test(s) && !/^0x0{64}$/.test(s));
}

/**
 * Apply the implementation pin to a verified gateway (pure). `slotWord` is the gateway's ERC-1967
 * implementation slot (`undefined` while unread); `implementationCode` the implementation's code
 * (`undefined` while unread, `null` or "0x" when it has none). Any state that is not `verified` is
 * returned unchanged: the code-hash pin decides first.
 */
export function computeImplementationVerification(
  base: VerificationState,
  pins: readonly string[],
  slotWord: Hex | undefined,
  implementationCode: Hex | null | undefined,
): VerificationState {
  if (base.status !== "verified") return base;
  if (slotWord === undefined) return { status: "pending" };
  const implementation = implementationFromSlot(slotWord);
  if (implementation === null) {
    return pins.length > 0 ? refusedVerification("implementation-unexpected") : base;
  }
  if (pins.length === 0) return refusedVerification("implementation-pin-missing");
  if (implementationCode === undefined) return { status: "pending" };
  if (implementationCode === null || implementationCode === "0x") {
    return refusedVerification("implementation-mismatch");
  }
  const implementationHash = keccak256(implementationCode);
  if (!pins.includes(implementationHash.toLowerCase())) {
    return refusedVerification("implementation-mismatch");
  }
  return { ...base, implementationHash };
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
