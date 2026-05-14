/**
 * Unit tests — DepositWithdrawTab component (issue #254).
 *
 * Focus: both deposit and withdraw submit buttons are disabled when vault
 * ABI is effectively "unwired" (simulate returns undefined, not connected).
 * The component's own `depositSim`/`redeemSim` gates drive the disable
 * logic — verified by mocking wagmi to return no simulation data.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DepositWithdrawTab } from "../../../src/components/DepositWithdrawTab";
import type { VaultPreviewContext } from "../../../src/lib/vaultPreview";

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useSimulateContract: () => ({ data: undefined, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, data: undefined }),
  useReadContract: () => ({ data: undefined, refetch: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDC = "0x4444444444444444444444444444444444444444" as const;

const ctx: VaultPreviewContext = {
  gateway: "0x1111111111111111111111111111111111111111",
  vault: VAULT,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

function renderTab() {
  return render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
}

describe("DepositWithdrawTab — button gating while vault ABI is unwired", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders deposit and withdraw forms", () => {
    renderTab();
    expect(screen.getByTestId("deposit-form")).toBeInTheDocument();
    expect(screen.getByTestId("withdraw-form")).toBeInTheDocument();
  });

  it("deposit submit is disabled while not connected / simulate pending", () => {
    renderTab();
    expect(screen.getByTestId("deposit-submit")).toBeDisabled();
  });

  it("withdraw submit is disabled while not connected / simulate pending", () => {
    renderTab();
    expect(screen.getByTestId("withdraw-submit")).toBeDisabled();
  });

  it("deposit submit remains disabled after entering an amount (no simulate result)", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("deposit-amount"), { target: { value: "10" } });
    expect(screen.getByTestId("deposit-submit")).toBeDisabled();
  });

  it("withdraw submit remains disabled after entering an amount (no simulate result)", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });
    expect(screen.getByTestId("withdraw-submit")).toBeDisabled();
  });
});
