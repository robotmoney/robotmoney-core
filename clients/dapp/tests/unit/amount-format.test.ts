/**
 * Issue 1738: one decimals-aware formatter and parser (lib/format.ts) for every amount the dapp shows or
 * accepts. USDC is 6 decimals, RM is 18, vault shares are the vault's decimals() (6) plus the ERC-4626 virtual
 * offset (18) = 24. Parsing is exact BigInt, never a float.
 */
import { describe, expect, it } from "vitest";
import {
  RM_DECIMALS,
  SHARE_DECIMALS,
  USDC_DECIMALS,
  formatInputAmount,
  formatSharesString,
  formatTokenBalance,
  formatUsdc,
  formatUsdcString,
  formatShares,
  parseSharesAmount,
  parseTokenAmount,
  parseUsdcAmount,
  shareDisplayDecimals,
} from "../../src/lib/format";

const UINT256_MAX = 2n ** 256n - 1n;

describe("scales", () => {
  it("pins the token scales", () => {
    expect(USDC_DECIMALS).toBe(6);
    expect(RM_DECIMALS).toBe(18);
    expect(SHARE_DECIMALS).toBe(24);
    expect(shareDisplayDecimals(6)).toBe(24);
  });
});

describe("formatUsdc", () => {
  it("1 USDC reads 1.00 USDC, never 10000000000000", () => {
    expect(formatUsdc(1_000_000n)).toBe("1.00 USDC");
  });
  it("1,000 USDC has a thousands separator", () => {
    expect(formatUsdc(1_000_000_000n)).toBe("1,000.00 USDC");
  });
  it("dust (1 base unit) keeps all six digits", () => {
    expect(formatUsdc(1n)).toBe("0.000001 USDC");
  });
  it("max uint256 is exact, with separators", () => {
    expect(formatUsdc(UINT256_MAX)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564,039,457,584,007,913,129.639935 USDC",
    );
  });
  it("a sub-resolution amount is flagged, not shown as zero", () => {
    expect(formatTokenBalance(1n, 18, "ETH", 4)).toBe("<0.0001 ETH");
    expect(formatTokenBalance(0n, 18, "ETH", 4)).toBe("0.00 ETH");
  });
});

describe("formatShares (24 decimals)", () => {
  it("a share amount at 18 decimals of virtual offset", () => {
    expect(formatShares(10n ** 24n, "rmUSDC")).toBe("1.00 rmUSDC");
  });
  it("the real router previewDeposit for 1 USDC reads about 1 share, not 999,949,002,651,862,103", () => {
    // Raw value returned by the Base 8453 rehearsal router for previewDeposit(1e6).
    const raw = 999949002651862103170635n;
    expect(formatShares(raw)).toBe("0.999949 shares");
    expect(formatShares(raw)).not.toContain("999,949,002");
  });
  it("1,000 shares has a separator", () => {
    expect(formatShares(1000n * 10n ** 24n, "rmUSDC")).toBe("1,000.00 rmUSDC");
  });
  it("derives the scale from a vault's own decimals()", () => {
    expect(formatShares(5n * 10n ** 24n, "rmUSDC", shareDisplayDecimals(6))).toBe("5.00 rmUSDC");
  });
  it("max uint256 does not overflow or lose digits", () => {
    expect(formatShares(UINT256_MAX)).toBe(
      "115,792,089,237,316,195,423,570,985,008,687,907,853,269,984,665,640,564.039457 shares",
    );
  });
});

describe("RM amounts (18 decimals)", () => {
  it("formats RM", () => {
    expect(formatTokenBalance(25n * 10n ** 18n, RM_DECIMALS, "RM")).toBe("25.00 RM");
    expect(formatTokenBalance(1_234_567n * 10n ** 18n + 5n * 10n ** 17n, RM_DECIMALS, "RM")).toBe(
      "1,234,567.50 RM",
    );
    expect(formatTokenBalance(1n, RM_DECIMALS, "RM")).toBe("<0.000001 RM");
  });
});

describe("explorer raw strings", () => {
  it("formats an integer string and refuses anything else", () => {
    expect(formatUsdcString("1000000")).toBe("1.00 USDC");
    expect(formatSharesString("1000000000000000000000000", "rmUSDC")).toBe("1.00 rmUSDC");
    expect(formatUsdcString(null)).toBe("—");
    expect(formatUsdcString("1.5")).toBe("—");
    expect(formatUsdcString("abc")).toBe("—");
  });
});

describe("parseTokenAmount: exact BigInt", () => {
  it("1 USDC is 1_000_000 base units", () => {
    expect(parseUsdcAmount("1")).toBe(1_000_000n);
    expect(parseUsdcAmount("1.00")).toBe(1_000_000n);
  });
  it("1,000 USDC, with and without a separator", () => {
    expect(parseUsdcAmount("1000")).toBe(1_000_000_000n);
    expect(parseUsdcAmount("1,000")).toBe(1_000_000_000n);
    expect(parseUsdcAmount("1,000.5")).toBe(1_000_500_000n);
  });
  it("dust: one base unit", () => {
    expect(parseUsdcAmount("0.000001")).toBe(1n);
  });
  it("rejects more fractional digits than the token has", () => {
    expect(parseUsdcAmount("0.0000001")).toBeNull();
  });
  it("does not lose precision where a float would", () => {
    // 0.1 + 0.2 and 9007199254740993 both break a Number.
    expect(parseUsdcAmount("9007199254740993")).toBe(9007199254740993n * 1_000_000n);
    expect(parseUsdcAmount("9007199254740993.000001")).toBe(9007199254740993_000001n);
  });
  it("max uint256 base units parses; one more is refused", () => {
    expect(parseTokenAmount(UINT256_MAX.toString(), 0)).toBe(UINT256_MAX);
    expect(parseTokenAmount((UINT256_MAX + 1n).toString(), 0)).toBeNull();
    expect(
      parseUsdcAmount(
        "115792089237316195423570985008687907853269984665640564039457584007913129.639935",
      ),
    ).toBe(UINT256_MAX);
    expect(
      parseUsdcAmount(
        "115792089237316195423570985008687907853269984665640564039457584007913129.639936",
      ),
    ).toBeNull();
  });
  it("rejects empty, zero, negative, junk, bad grouping", () => {
    for (const bad of [
      "",
      " ",
      "0",
      "0.0",
      "-1",
      "abc",
      "1e6",
      "1,00",
      "1,0000",
      ",1",
      "1.",
      ".5",
      "1 000",
    ]) {
      expect(parseUsdcAmount(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it("a share amount parses at 24 decimals", () => {
    expect(parseSharesAmount("1")).toBe(10n ** 24n);
    expect(parseSharesAmount("0.999949")).toBe(999949n * 10n ** 18n);
    expect(parseSharesAmount("0.0000000000000000000000001")).toBeNull();
  });
  it("an RM amount parses at 18 decimals", () => {
    expect(parseTokenAmount("25", RM_DECIMALS)).toBe(25n * 10n ** 18n);
    expect(parseTokenAmount("0.000000000000000001", RM_DECIMALS)).toBe(1n);
  });
});

describe("round trip: formatInputAmount then parseTokenAmount", () => {
  it("returns the same base units", () => {
    for (const [raw, d] of [
      [1n, 6],
      [1_000_000n, 6],
      [123_456_789n, 6],
      [999949002651862103170635n, 24],
      [10n ** 24n, 24],
      [UINT256_MAX, 24],
      [UINT256_MAX, 6],
      [7n * 10n ** 18n + 1n, 18],
    ] as const) {
      expect(parseTokenAmount(formatInputAmount(raw, d), d), `${raw} @${d}`).toBe(raw);
    }
  });
  it("is a plain decimal with no separators", () => {
    expect(formatInputAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatInputAmount(2_000_000n, 6)).toBe("2");
  });
});
