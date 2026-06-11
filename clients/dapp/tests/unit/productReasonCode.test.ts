/**
 * Unit tests for the EVM-revert → ProductReasonCode mapping layer.
 *
 * Asserts that each of the nine architecture-mandated product reason codes
 * is reachable from a mock EVM revert payload (no manual steps, satisfying
 * the issue #670 test_plan bullet).
 *
 * Architecture §7.2: client and API surfaces must map known failures to
 * stable product reason codes.
 */
import { describe, it, expect } from "vitest";
import { mapEvmRevertToProductReason } from "../../src/lib/productReasonCode";
import type { ProductReasonCode } from "../../src/lib/productReasonCode";

describe("mapEvmRevertToProductReason — all nine architecture-mandated codes", () => {
  // Each entry is [mock revert payload, expected ProductReasonCode].
  // The hex selectors must match the SELECTOR_MAP in productReasonCode.ts.
  const cases: [string, ProductReasonCode][] = [
    // paused — GatewayPaused() selector
    ["0x1a7e0d23", "paused"],
    // paused — EnforcedPause() (OZ Pausable standard)
    ["0xd93c0665", "paused"],
    // vault_disabled
    ["0x3a81d6fc", "vault_disabled"],
    // cap_exceeded
    ["0x9f32e927", "cap_exceeded"],
    // expired_policy
    ["0x8d5e3e5d", "expired_policy"],
    // insufficient_allowance — ERC20InsufficientAllowance (OZ)
    ["0xfb8f41b2", "insufficient_allowance"],
    // insufficient_balance — ERC20InsufficientBalance (OZ)
    ["0xe450d38c", "insufficient_balance"],
    // unavailable_leg
    ["0x8562ca85", "unavailable_leg"],
    // fee_cap_exceeded
    ["0x35f3f5e8", "fee_cap_exceeded"],
    // slippage_bound_exceeded
    ["0xb3b72aca", "slippage_bound_exceeded"],
  ];

  for (const [payload, expected] of cases) {
    it(`maps ${payload} → "${expected}"`, () => {
      expect(mapEvmRevertToProductReason(payload)).toBe(expected);
    });
  }

  it('maps unrecognised hex payload → "unknown_revert"', () => {
    expect(mapEvmRevertToProductReason("0xdeadbeef")).toBe("unknown_revert");
  });

  it('maps undefined → "unknown_revert"', () => {
    expect(mapEvmRevertToProductReason(undefined)).toBe("unknown_revert");
  });

  it('maps plain-text "paused" revert string → "paused"', () => {
    expect(mapEvmRevertToProductReason("execution reverted: paused")).toBe("paused");
  });

  it('maps plain-text "allowance" revert string → "insufficient_allowance"', () => {
    expect(mapEvmRevertToProductReason("ERC20: insufficient allowance")).toBe(
      "insufficient_allowance",
    );
  });
});
