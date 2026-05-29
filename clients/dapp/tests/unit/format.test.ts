/**
 * Unit tests for the centralized number-formatting module (issue #489).
 *
 * Covers all six format categories — USD/USDC, ETH, token balance, percentage
 * (bps), raw bps label, and price — with boundary cases:
 *   - zero
 *   - very small (< 0.01)
 *   - very large (> 1e9)
 *   - negative
 *   - undefined (should return the placeholder "—")
 */
import { describe, it, expect } from "vitest";
import {
  PLACEHOLDER,
  formatUsdc,
  formatShares,
  formatEth,
  formatTokenBalance,
  formatPercent,
  formatBps,
  formatPrice,
} from "../../src/lib/format";

// ---------------------------------------------------------------------------
// formatUsdc
// ---------------------------------------------------------------------------
describe("formatUsdc", () => {
  it("formats whole amounts", () => {
    expect(formatUsdc(1_000_000n)).toBe("1 USDC");
    expect(formatUsdc(100_000_000n)).toBe("100 USDC");
  });

  it("formats fractional amounts, stripping trailing zeros", () => {
    expect(formatUsdc(1_500_000n)).toBe("1.5 USDC");
    expect(formatUsdc(1_000_001n)).toBe("1.000001 USDC");
  });

  it("formats zero as '0 USDC'", () => {
    expect(formatUsdc(0n)).toBe("0 USDC");
  });

  it("formats very small values (< 0.01 USDC)", () => {
    // 1 base unit = 0.000001 USDC
    expect(formatUsdc(1n)).toBe("0.000001 USDC");
    // 9999 base units = 0.009999 USDC
    expect(formatUsdc(9_999n)).toBe("0.009999 USDC");
  });

  it("formats very large values (> 1e9 USDC)", () => {
    // 1 billion USDC = 1_000_000_000 * 1_000_000 base units
    expect(formatUsdc(1_000_000_000_000_000n)).toBe("1000000000 USDC");
  });

  it("formats negative amounts", () => {
    expect(formatUsdc(-1_000_000n)).toBe("−1 USDC");
    expect(formatUsdc(-500_000n)).toBe("−0.5 USDC");
  });

  it("returns placeholder for undefined", () => {
    expect(formatUsdc(undefined)).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// formatShares
// ---------------------------------------------------------------------------
describe("formatShares", () => {
  it("formats with default symbol", () => {
    expect(formatShares(1_000_000n)).toBe("1 shares");
  });

  it("formats with explicit symbol", () => {
    expect(formatShares(2_000_000n, "rmUSDC")).toBe("2 rmUSDC");
    expect(formatShares(500_000n, "rmPROTO")).toBe("0.5 rmPROTO");
  });

  it("formats zero", () => {
    expect(formatShares(0n)).toBe("0 shares");
  });

  it("formats very small shares", () => {
    expect(formatShares(1n, "rmUSDC")).toBe("0.000001 rmUSDC");
  });

  it("formats very large shares", () => {
    expect(formatShares(1_000_000_000_000_000n, "rmUSDC")).toBe("1000000000 rmUSDC");
  });

  it("formats negative shares", () => {
    expect(formatShares(-1_000_000n, "rmUSDC")).toBe("−1 rmUSDC");
  });

  it("returns placeholder for undefined", () => {
    expect(formatShares(undefined)).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// formatEth
// ---------------------------------------------------------------------------
describe("formatEth", () => {
  it("formats 1 ETH", () => {
    expect(formatEth(1_000_000_000_000_000_000n)).toBe("1 ETH");
  });

  it("formats fractional ETH (up to 4 decimal places)", () => {
    expect(formatEth(1_500_000_000_000_000_000n)).toBe("1.5 ETH");
    expect(formatEth(1_234_500_000_000_000_000n)).toBe("1.2345 ETH");
  });

  it("strips trailing zeros", () => {
    expect(formatEth(2_000_000_000_000_000_000n)).toBe("2 ETH");
  });

  it("formats zero", () => {
    expect(formatEth(0n)).toBe("0 ETH");
  });

  it("formats very small ETH (< 0.0001 ETH rounds to 0 decimal places)", () => {
    // 1 wei = 1e-18 ETH, at 4 decimal places this rounds to "0 ETH"
    expect(formatEth(1n)).toBe("0 ETH");
    // 0.0001 ETH = 1e14 wei
    expect(formatEth(100_000_000_000_000n)).toBe("0.0001 ETH");
  });

  it("formats very large ETH (> 1e9)", () => {
    // 1 billion ETH
    expect(formatEth(1_000_000_000n * 1_000_000_000_000_000_000n)).toBe("1000000000 ETH");
  });

  it("formats negative ETH", () => {
    expect(formatEth(-1_000_000_000_000_000_000n)).toBe("−1 ETH");
  });

  it("returns placeholder for undefined", () => {
    expect(formatEth(undefined)).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// formatTokenBalance
// ---------------------------------------------------------------------------
describe("formatTokenBalance", () => {
  it("formats an 18-decimal token", () => {
    expect(formatTokenBalance(25_000_000_000_000_000_000n, 18, "RM")).toBe("25 RM");
  });

  it("formats a 6-decimal token without symbol", () => {
    expect(formatTokenBalance(1_500_000n, 6)).toBe("1.5");
  });

  it("returns placeholder for undefined", () => {
    expect(formatTokenBalance(undefined, 18, "RM")).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// formatPercent
// ---------------------------------------------------------------------------
describe("formatPercent", () => {
  it("formats 100% (10000 bps)", () => {
    expect(formatPercent(10_000n)).toBe("100.00%");
  });

  it("formats 50% (5000 bps)", () => {
    expect(formatPercent(5_000n)).toBe("50.00%");
  });

  it("formats fractional percentages", () => {
    // 25bps = 0.25%
    expect(formatPercent(25n)).toBe("0.25%");
    // 1bps = 0.01%
    expect(formatPercent(1n)).toBe("0.01%");
  });

  it("formats zero", () => {
    expect(formatPercent(0n)).toBe("0.00%");
  });

  it("formats very small bps (< 0.01%)", () => {
    // bps is integer — the smallest is 1bps = 0.01%; nothing smaller is representable
    expect(formatPercent(1n)).toBe("0.01%");
  });

  it("formats very large bps (> 10000)", () => {
    // 20000 bps = 200%
    expect(formatPercent(20_000n)).toBe("200.00%");
  });

  it("formats negative bps", () => {
    expect(formatPercent(-5_000n)).toBe("−50.00%");
  });

  it("returns placeholder for undefined", () => {
    expect(formatPercent(undefined)).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// formatBps
// ---------------------------------------------------------------------------
describe("formatBps", () => {
  it("formats a bps number", () => {
    expect(formatBps(150)).toBe("150bps");
    expect(formatBps(0)).toBe("0bps");
  });

  it("returns placeholder for undefined", () => {
    expect(formatBps(undefined)).toBe(PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// formatPrice
// ---------------------------------------------------------------------------
describe("formatPrice", () => {
  it("formats a typical price to 4 decimal places", () => {
    expect(formatPrice(1.5)).toBe("$1.5000");
    expect(formatPrice(1234.5678)).toBe("$1234.5678");
  });

  it("formats zero", () => {
    expect(formatPrice(0)).toBe("$0.0000");
  });

  it("formats very small prices (< 0.01)", () => {
    expect(formatPrice(0.001)).toBe("$0.0010");
    expect(formatPrice(0.000099)).toBe("$0.0001");
  });

  it("formats very large prices (> 1e9)", () => {
    expect(formatPrice(1_000_000_000)).toBe("$1000000000.0000");
  });

  it("formats negative prices", () => {
    expect(formatPrice(-1.5)).toBe("$-1.5000");
  });

  it("returns placeholder for undefined", () => {
    expect(formatPrice(undefined)).toBe(PLACEHOLDER);
  });
});
