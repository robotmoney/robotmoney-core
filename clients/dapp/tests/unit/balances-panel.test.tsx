/**
 * Component tests — BalancesPanelView (issue #463).
 *
 * Covers acceptance criteria:
 *   - USDC, ETH, and RM rows render with per-token decimal formatting
 *     (USDC 6, ETH 18, RM 18) and the correct symbol (AC §1).
 *   - Per-registered-vault receipt-token rows render with vault decimals
 *     and the receipt symbol (AC §2).
 *   - The RM row is absent when VITE_RM_TOKEN_ADDRESS is unset and
 *     present when set (AC §3) — modeled via the `rmAvailable` prop the
 *     container derives from the env var.
 *   - Zero balances render as the literal "0" (not omitted) and a
 *     disconnected wallet renders a connect prompt instead of balance
 *     rows (AC §4).
 *
 * Render the pure `BalancesPanelView` directly — no wagmi/QueryClient
 * fixture needed, per docs/development/react-guide.md §Layout.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Address } from "viem";
import {
  BalancesPanelView,
  type BalancesPanelReceipt,
} from "../../src/components/BalancesPanelView";

const VAULT_A = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0" as Address;
const VAULT_B = "0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0" as Address;

interface RenderOpts {
  readonly connected?: boolean;
  readonly usdcBalance?: bigint;
  readonly usdcDecimals?: number;
  readonly usdcSymbol?: string;
  readonly ethBalance?: bigint;
  readonly ethSymbol?: string;
  readonly rmAvailable?: boolean;
  readonly rmBalance?: bigint;
  readonly rmDecimals?: number;
  readonly rmSymbol?: string;
  readonly receipts?: ReadonlyArray<BalancesPanelReceipt>;
}

function renderView(opts: RenderOpts = {}) {
  return render(
    <BalancesPanelView
      connected={opts.connected ?? true}
      usdcBalance={opts.usdcBalance ?? 1_000_000n}
      usdcDecimals={opts.usdcDecimals ?? 6}
      usdcSymbol={opts.usdcSymbol ?? "USDC"}
      ethBalance={opts.ethBalance ?? 1_500_000_000_000_000_000n}
      ethSymbol={opts.ethSymbol ?? "ETH"}
      rmAvailable={opts.rmAvailable ?? true}
      rmBalance={opts.rmBalance ?? 25_000_000_000_000_000_000n}
      rmDecimals={opts.rmDecimals ?? 18}
      rmSymbol={opts.rmSymbol ?? "RM"}
      receipts={opts.receipts ?? []}
    />,
  );
}

describe("BalancesPanelView", () => {
  it("renders USDC, ETH, and RM rows with per-token decimal formatting and symbols", () => {
    // Centralized formatter: 1_000_000 USDC → "1 USDC"; 1.5e18 ETH → "1.5 ETH"; 25e18 RM → "25 RM".
    renderView({
      usdcBalance: 1_000_000n,
      ethBalance: 1_500_000_000_000_000_000n,
      rmBalance: 25_000_000_000_000_000_000n,
    });
    expect(screen.getByTestId("balances-panel-row-usdc-symbol").textContent).toBe("USDC");
    expect(screen.getByTestId("balances-panel-row-usdc-amount").textContent).toBe("1 USDC");

    expect(screen.getByTestId("balances-panel-row-eth-symbol").textContent).toBe("ETH");
    expect(screen.getByTestId("balances-panel-row-eth-amount").textContent).toBe("1.5 ETH");

    expect(screen.getByTestId("balances-panel-row-rm-symbol").textContent).toBe("RM");
    expect(screen.getByTestId("balances-panel-row-rm-amount").textContent).toBe("25 RM");
  });

  it("renders one row per registered vault the wallet holds receipt-token shares in", () => {
    const receipts: BalancesPanelReceipt[] = [
      { vaultAddress: VAULT_A, symbol: "rmUSDC", decimals: 6, balance: 5_000_000n },
      {
        vaultAddress: VAULT_B,
        symbol: "rmPROTO",
        decimals: 18,
        balance: 3_000_000_000_000_000_000n,
      },
    ];
    renderView({ receipts });

    expect(screen.getByTestId(`balances-panel-row-receipt-${VAULT_A}-symbol`).textContent).toBe(
      "rmUSDC",
    );
    // Centralized formatter: 5_000_000 (6 decimals) + symbol → "5 rmUSDC"
    expect(screen.getByTestId(`balances-panel-row-receipt-${VAULT_A}-amount`).textContent).toBe(
      "5 rmUSDC",
    );
    expect(screen.getByTestId(`balances-panel-row-receipt-${VAULT_B}-symbol`).textContent).toBe(
      "rmPROTO",
    );
    // Centralized formatter: 3e18 (18 decimals) + symbol → "3 rmPROTO"
    expect(screen.getByTestId(`balances-panel-row-receipt-${VAULT_B}-amount`).textContent).toBe(
      "3 rmPROTO",
    );
  });

  it("hides the RM row when VITE_RM_TOKEN_ADDRESS is unset (rmAvailable=false)", () => {
    renderView({ rmAvailable: false });
    expect(screen.queryByTestId("balances-panel-row-rm")).toBeNull();
    // USDC and ETH rows remain.
    expect(screen.getByTestId("balances-panel-row-usdc")).toBeTruthy();
    expect(screen.getByTestId("balances-panel-row-eth")).toBeTruthy();
  });

  it("shows the RM row when VITE_RM_TOKEN_ADDRESS is set (rmAvailable=true)", () => {
    renderView({ rmAvailable: true });
    expect(screen.getByTestId("balances-panel-row-rm")).toBeTruthy();
  });

  it("renders zero balances as the literal '0' with symbol (not omitted)", () => {
    // Centralized formatter renders zeros with symbol suffix: "0 USDC", "0 ETH", "0 RM".
    renderView({ usdcBalance: 0n, ethBalance: 0n, rmBalance: 0n });
    expect(screen.getByTestId("balances-panel-row-usdc-amount").textContent).toBe("0 USDC");
    expect(screen.getByTestId("balances-panel-row-eth-amount").textContent).toBe("0 ETH");
    expect(screen.getByTestId("balances-panel-row-rm-amount").textContent).toBe("0 RM");
  });

  it("renders a connect prompt instead of balance rows when no wallet is connected", () => {
    renderView({ connected: false });
    expect(screen.getByTestId("balances-panel-disconnected")).toBeTruthy();
    // None of the balance rows are present.
    expect(screen.queryByTestId("balances-panel-table")).toBeNull();
    expect(screen.queryByTestId("balances-panel-row-usdc")).toBeNull();
    expect(screen.queryByTestId("balances-panel-row-eth")).toBeNull();
    expect(screen.queryByTestId("balances-panel-row-rm")).toBeNull();
  });
});
