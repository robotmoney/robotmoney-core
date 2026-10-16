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
 * The gateway runs behind an ERC-1967 proxy (issue 1808). The proxy's own
 * code never changes on an upgrade, so `computeGatewayVerification` (issue
 * 1810) also checks the live implementation slot against the build-time pin
 * `VITE_GATEWAY_EXPECTED_IMPLEMENTATION` + `_HASH`, failing closed:
 *   - Slot read failed / not an address        → refused
 *   - Slot set, no implementation pinned        → refused
 *   - Implementation pinned, slot empty         → refused (not the approved proxy)
 *   - Slot names another address                → refused
 *   - keccak256(implementation code) ≠ pin      → refused
 *   - Slot empty and nothing pinned             → verified (direct gateway)
 *
 * The caller is responsible for fetching `code` via the wagmi/viem
 * client (see useGatewayVerifier.ts). Keeping this layer pure makes it
 * straightforward to unit-test without any React or wagmi machinery.
 *
 * Every refusal carries a `cause` (QA plan U5, finding DR-9). The product
 * reason code stays `unknown_revert` for all of them, but the banner prints
 * one sentence per cause (`describeVerificationCause`), so a missing pin, a
 * wallet on the wrong chain, an RPC failure and a hash mismatch no longer
 * read the same. The implementation checks also carry a free-form `detail`
 * naming the exact check that refused.
 */
import { keccak256 } from "viem";
import type { Address, Hex } from "viem";
import type { ProductReasonCode } from "./productReasonCode";

export type VerificationState =
  | { status: "idle" }
  | { status: "pending" }
  | {
      status: "verified";
      computedHash: Hex;
      /**
       * The verified implementation behind the gateway proxy; `null` for a
       * direct gateway. Absent when only the proxy code was checked.
       */
      implementation?: Address | null;
      /** keccak256 of the verified implementation's code (proxied gateway only). */
      implementationCodeHash?: Hex;
      /** `upgradesFrozen()` at the verified block; `undefined` when unread. */
      upgradesFrozen?: boolean;
      /** `upgradeTimelock()` at the verified block; `undefined` when unread. */
      upgradeTimelock?: Address;
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
      /** Which check refused, for the banner. */
      detail?: string;
    };

/** Why the gateway was not verified. One cause, one banner sentence. */
export type VerificationCause =
  | "pin-missing"
  | "address-missing"
  | "no-code"
  | "hash-mismatch"
  | "wrong-chain"
  | "no-wallet"
  | "rpc-failed"
  | "implementation-unreadable"
  | "implementation-pin-missing"
  | "implementation-mismatch"
  | "implementation-unexpected";

/** The refused state for `cause`. Every refusal maps to the `unknown_revert` product code. */
export function refusedVerification(cause: VerificationCause, detail?: string): VerificationState {
  return detail === undefined
    ? { status: "refused", reason: "unknown_revert", cause }
    : { status: "refused", reason: "unknown_revert", cause, detail };
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
      return "Your wallet's RPC did not answer the gateway code or implementation read after several tries. Re-verify, or check the wallet's network.";
    case "implementation-unreadable":
      return "The implementation behind the gateway proxy could not be read through your wallet, so the logic behind it cannot be verified. Re-verify, or check the wallet's network.";
    case "implementation-pin-missing":
      return "The gateway is an upgradeable proxy and this build does not pin its implementation (VITE_GATEWAY_EXPECTED_IMPLEMENTATION and VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH, both required), so the logic behind it cannot be verified.";
    case "implementation-mismatch":
      return "The implementation behind the gateway proxy is not the reviewed one this build pins. It may have been upgraded. Do not sign anything against it.";
    case "implementation-unexpected":
      return "This build pins a gateway implementation, but the gateway is not a proxy. Do not sign anything against it.";
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

/**
 * `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`: where an
 * ERC-1967 proxy stores its implementation address.
 */
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** The build-time implementation pin (`VITE_GATEWAY_EXPECTED_IMPLEMENTATION` + `_HASH`). */
export interface ImplementationPin {
  readonly address?: string;
  readonly hash?: string;
}

/**
 * Decode an ERC-1967 implementation slot word. `null` for an empty slot (no
 * proxy); `undefined` for a word that is not a left-padded address.
 */
export function implementationFromSlot(word: Hex): Address | null | undefined {
  const hex = word.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (hex.length !== 64 || !/^[0-9a-f]+$/.test(hex)) return undefined;
  if (!/^0{24}$/.test(hex.slice(0, 24))) return undefined;
  const addr = hex.slice(24);
  if (/^0+$/.test(addr)) return null;
  return `0x${addr}` as Address;
}

/**
 * `computeVerificationState` (the proxy code pin) plus the live ERC-1967
 * implementation check (issue 1810). Reads are expected at one block.
 *
 * @param slot      the implementation slot word; `undefined` while in flight,
 *                  `null` when the read failed
 * @param implCode  the implementation's code; `undefined` while in flight (or
 *                  not needed), `null` / `"0x"` when there is none
 */
export function computeGatewayVerification(
  gatewayAddress: string,
  expectedHash: string | undefined,
  code: Hex | undefined | null,
  pin: ImplementationPin,
  slot: Hex | undefined | null,
  implCode: Hex | undefined | null,
): VerificationState {
  const base = computeVerificationState(gatewayAddress, expectedHash, code);
  if (base.status !== "verified") return base;
  const pinAddress = pin.address?.trim() ?? "";
  const pinHash = pin.hash?.trim() ?? "";
  if ((pinAddress === "") !== (pinHash === "")) {
    return refusedVerification(
      "implementation-pin-missing",
      "the implementation pin needs both an address and a code hash",
    );
  }
  if (slot === undefined) return { status: "pending" };
  if (slot === null)
    return refusedVerification(
      "implementation-unreadable",
      "the gateway implementation slot could not be read",
    );
  const live = implementationFromSlot(slot);
  if (live === undefined)
    return refusedVerification(
      "implementation-mismatch",
      "the gateway implementation slot is not an address",
    );
  if (live === null) {
    if (pinAddress !== "") {
      return refusedVerification(
        "implementation-unexpected",
        "an implementation is pinned but the gateway is not a proxy",
      );
    }
    return { ...base, implementation: null };
  }
  if (pinAddress === "") {
    return refusedVerification(
      "implementation-pin-missing",
      `the gateway is a proxy for ${live} and no implementation is pinned`,
    );
  }
  if (live.toLowerCase() !== pinAddress.toLowerCase()) {
    return refusedVerification(
      "implementation-mismatch",
      `the gateway implementation is ${live}, not the pinned ${pinAddress}`,
    );
  }
  if (implCode === undefined) return { status: "pending" };
  if (implCode === null || implCode === "0x") {
    return refusedVerification(
      "implementation-mismatch",
      `the gateway implementation ${live} has no code`,
    );
  }
  const implementationCodeHash = keccak256(implCode);
  if (implementationCodeHash.toLowerCase() !== pinHash.toLowerCase()) {
    return refusedVerification(
      "implementation-mismatch",
      `the gateway implementation ${live} code hash does not match the pin`,
    );
  }
  return { ...base, implementation: live, implementationCodeHash };
}
