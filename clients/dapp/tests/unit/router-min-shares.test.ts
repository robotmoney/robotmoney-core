/**
 * Unit tests for DAPP-2 (issue #1025) — non-zero router per-leg floors.
 *
 * `deriveMinSharesPerLeg` turns the `previewDeposit` per-leg estimated shares
 * into a non-zero `minSharesPerLeg` slippage-floor array (0 only for legs that
 * are unavailable / have zero estimated shares). `buildRouterPreview` must
 * encode those floors into the router `deposit` calldata instead of the old
 * empty `[]` that disabled per-leg slippage protection.
 */
import { describe, it, expect } from "vitest";
import { decodeFunctionData } from "viem";
import type { Address } from "viem";
import {
  deriveMinSharesPerLeg,
  buildRouterPreview,
  ROUTER_SLIPPAGE_TOLERANCE_BPS,
  type LegPreview,
  type RouterPreviewContext,
} from "../../src/lib/routerPreview";
import { routerAbi } from "../../src/lib/abi";

const VAULT_A = "0x1111111111111111111111111111111111111111" as Address;
const VAULT_B = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x9999999999999999999999999999999999999999" as Address;
const GATEWAY = "0x6666666666666666666666666666666666666666" as Address;

const ctx: RouterPreviewContext = {
  gateway: GATEWAY,
  router: ROUTER,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const legs: LegPreview[] = [
  {
    vault: VAULT_A,
    weightBps: 6000n,
    legAmount: 6_000_000n,
    estShares: 5_950_000n,
    unavailable: false,
  },
  {
    vault: VAULT_B,
    weightBps: 4000n,
    legAmount: 4_000_000n,
    estShares: 3_980_000n,
    unavailable: false,
  },
];

describe("deriveMinSharesPerLeg — DAPP-2 non-zero per-leg floors", () => {
  it("derives a non-zero floor below estShares for each available leg", () => {
    const floors = deriveMinSharesPerLeg(legs);
    expect(floors.length).toBe(legs.length);
    // floor = estShares * (10_000 - 50) / 10_000 (0.50% tolerance).
    expect(floors[0]).toBe((5_950_000n * (10_000n - ROUTER_SLIPPAGE_TOLERANCE_BPS)) / 10_000n);
    expect(floors[1]).toBe((3_980_000n * (10_000n - ROUTER_SLIPPAGE_TOLERANCE_BPS)) / 10_000n);
    floors.forEach((f, i) => {
      expect(f).toBeGreaterThan(0n);
      expect(f).toBeLessThan(legs[i].estShares);
    });
  });

  it("is never an empty array for a populated leg list (regression: was `[]`)", () => {
    expect(deriveMinSharesPerLeg(legs)).not.toEqual([]);
  });

  it("sets a zero floor for unavailable legs (and keeps array length == legs)", () => {
    const withUnavailable: LegPreview[] = [
      legs[0],
      { vault: VAULT_B, weightBps: 4000n, legAmount: 4_000_000n, estShares: 0n, unavailable: true },
    ];
    const floors = deriveMinSharesPerLeg(withUnavailable);
    expect(floors.length).toBe(2);
    expect(floors[0]).toBeGreaterThan(0n);
    expect(floors[1]).toBe(0n);
  });

  it("honours a custom tolerance", () => {
    const floors = deriveMinSharesPerLeg(legs, 100n); // 1.00%
    expect(floors[0]).toBe((5_950_000n * 9_900n) / 10_000n);
  });
});

describe("buildRouterPreview — encodes derived floors into deposit calldata", () => {
  it("encodes a non-empty minSharesPerLeg matching deriveMinSharesPerLeg", () => {
    const preview = buildRouterPreview(10_000_000n, legs, ctx);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const decoded = decodeFunctionData({ abi: routerAbi, data: preview.calldata });
    expect(decoded.functionName).toBe("deposit");
    const [amount, floors] = decoded.args as [bigint, readonly bigint[]];
    expect(amount).toBe(10_000_000n);
    expect([...floors]).toEqual(deriveMinSharesPerLeg(legs));
    expect(floors.length).toBeGreaterThan(0);
    expect(floors.every((f) => f > 0n)).toBe(true);
  });
});
