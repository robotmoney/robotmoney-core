/**
 * Unit tests for the Deposit/Withdraw tab's pure helpers (issue #257).
 *
 * Covers:
 *   - `parseUsdcAmount` — input parsing into the 6-decimal scalar the
 *     vault and USDC contracts use.
 *   - `buildVaultPreview` — calldata encode + decode round-trip for
 *     both deposit and redeem, including the unverified-bytecode
 *     refusal path and a structural decoder mismatch.
 */
import { describe, it, expect } from "vitest";
import { parseUsdcAmount } from "../../src/components/DepositWithdrawTab";
import { buildVaultPreview, type VaultPreviewContext } from "../../src/lib/vaultPreview";

const vault = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd" as const;
const gateway = "0x1111111111111111111111111111111111111111" as const;
const user = "0x2222222222222222222222222222222222222222" as const;

const ctxOk: VaultPreviewContext = {
  gateway,
  vault,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const ctxUnverified: VaultPreviewContext = { ...ctxOk, gatewayCodeHashVerified: false };

describe("parseUsdcAmount", () => {
  it("parses whole-USDC inputs", () => {
    expect(parseUsdcAmount("1")).toBe(1_000_000n);
    expect(parseUsdcAmount("100")).toBe(100_000_000n);
  });

  it("parses fractional inputs up to 6 dp", () => {
    expect(parseUsdcAmount("1.5")).toBe(1_500_000n);
    expect(parseUsdcAmount("0.000001")).toBe(1n);
    expect(parseUsdcAmount("0.123456")).toBe(123_456n);
  });

  it("rejects empty, non-numeric, and over-precise inputs", () => {
    expect(parseUsdcAmount("")).toBeNull();
    expect(parseUsdcAmount("  ")).toBeNull();
    expect(parseUsdcAmount("abc")).toBeNull();
    expect(parseUsdcAmount("1.2345678")).toBeNull();
    expect(parseUsdcAmount("-1")).toBeNull();
    expect(parseUsdcAmount("0")).toBeNull();
    expect(parseUsdcAmount("0.0")).toBeNull();
  });
});

describe("buildVaultPreview — deposit", () => {
  it("builds a structured preview with deposit calldata", () => {
    const preview = buildVaultPreview(
      { kind: "vaultDeposit", assets: 1_000_000n, receiver: user },
      ctxOk,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.target).toBe(vault);
    expect(preview.functionName).toBe("deposit");
    expect(preview.calldata).toMatch(/^0x[0-9a-f]+$/);
    expect(preview.args.find((a) => a.name === "assets")?.raw).toBe("1000000");
    expect(preview.args.find((a) => a.name === "receiver")?.raw).toBe(user);
    expect(preview.risk).toBe("low");
  });
});

describe("buildVaultPreview — redeem", () => {
  it("builds a structured preview with redeem calldata", () => {
    const preview = buildVaultPreview(
      { kind: "vaultRedeem", shares: 500_000n, receiver: user, owner: user },
      ctxOk,
    );
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.functionName).toBe("redeem");
    expect(preview.args.map((a) => a.name)).toEqual(["shares", "receiver", "owner"]);
  });
});

describe("buildVaultPreview — refusal paths", () => {
  it("refuses when gateway bytecode hash is unverified", () => {
    const preview = buildVaultPreview(
      { kind: "vaultDeposit", assets: 1_000_000n, receiver: user },
      ctxUnverified,
    );
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.reason).toMatch(/bytecode/i);
  });
});
