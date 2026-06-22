/**
 * Component tests — DepositWithdrawTab deposit-target threading (issue #992,
 * scan finding DAPP-4).
 *
 * The DestinationSelector lets a depositor pick any registered vault, but the
 * single-vault deposit path historically hard-coded props.vaultAddress in the
 * allowance read, deposit simulation, and approve call — so picking vault B
 * deposited into the default vault A (wrong risk class). These tests assert the
 * selected destination vault drives all three calls.
 *
 * wagmi is mocked at the module boundary (browser project resolves the mock for
 * component source too — same pattern as vault-detail.test.tsx). Each hook
 * records the `address`/`args` it was invoked with into module-level recorders
 * so the test can assert the exact contract target after selecting vault B.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "./helpers/render";
import type { Address } from "viem";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import type { VaultPreviewContext } from "../../src/lib/vaultPreview";

const VAULT_A = "0x1111111111111111111111111111111111111111" as Address;
const VAULT_B = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const REGISTRY = "0x5555555555555555555555555555555555555555" as Address;
const ROUTER = "0x6666666666666666666666666666666666666666" as Address;
const USER = "0x3333333333333333333333333333333333333333" as Address;

const ctx: VaultPreviewContext = {
  gateway: "0x7777777777777777777777777777777777777777",
  vault: VAULT_A,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

// ─── Call recorders ──────────────────────────────────────────────────────────
// Capture the contract target/spender each hook was last invoked with so the
// test can assert deposit/approve/allowance keyed to the SELECTED vault.
interface Recorders {
  depositSimAddress: Address | undefined;
  approveSpender: Address | undefined;
  allowanceSpender: Address | undefined;
}
const rec: Recorders = {
  depositSimAddress: undefined,
  approveSpender: undefined,
  allowanceSpender: undefined,
};

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: USER, isConnected: true }),
  useReadContract: (opts: {
    functionName?: string;
    args?: readonly unknown[];
    address?: Address;
  }) => {
    if (opts.functionName === "listVaults") {
      // DestinationSelector enumerates registered vaults.
      return { data: [VAULT_A, VAULT_B] as Address[], refetch: vi.fn() };
    }
    if (opts.functionName === "allowance") {
      rec.allowanceSpender = opts.args?.[1] as Address | undefined;
      // Below the entered amount so the Approve button is rendered too.
      return { data: 0n, refetch: vi.fn() };
    }
    if (opts.functionName === "balanceOf") return { data: 0n, refetch: vi.fn() };
    if (opts.functionName === "previewRedeem") return { data: undefined, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: (opts: {
    functionName?: string;
    args?: readonly unknown[];
    address?: Address;
  }) => {
    if (opts.functionName === "deposit") {
      rec.depositSimAddress = opts.address;
      return { data: { request: {} }, error: null };
    }
    if (opts.functionName === "approve") {
      rec.approveSpender = opts.args?.[0] as Address | undefined;
      return { data: { request: {} }, error: null };
    }
    return { data: undefined, error: null };
  },
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, data: undefined }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

function renderTab() {
  return render(
    <DepositWithdrawTab
      vaultAddress={VAULT_A}
      usdcAddress={USDC}
      ctx={ctx}
      registryAddress={REGISTRY}
      routerAddress={ROUTER}
    />,
  );
}

describe("DepositWithdrawTab routes the selected vault into the single-vault deposit (DAPP-4)", () => {
  beforeEach(() => {
    rec.depositSimAddress = undefined;
    rec.approveSpender = undefined;
    rec.allowanceSpender = undefined;
  });

  it("deposit simulate and approve target the selected non-default vault, not props.vaultAddress", async () => {
    renderTab();
    // Enter an amount so the deposit/approve simulations are enabled.
    fireEvent.change(screen.getByTestId("deposit-amount"), { target: { value: "1" } });
    // Select vault B in the destination selector.
    const radioB = screen.getByTestId(`destination-vault-${VAULT_B.toLowerCase()}`) as HTMLElement;
    fireEvent.click(radioB.querySelector("input") as HTMLInputElement);

    await waitFor(() => expect(rec.depositSimAddress).toBe(VAULT_B));
    expect(rec.depositSimAddress).toBe(VAULT_B);
    expect(rec.depositSimAddress).not.toBe(VAULT_A);
    expect(rec.approveSpender).toBe(VAULT_B);

    // The decoded preview target reflects the selected vault too.
    await waitFor(() =>
      expect(screen.getByTestId("tx-preview-target").textContent).toContain(VAULT_B),
    );
  });

  it("the deposit allowance read is keyed to the selected vault, not props.vaultAddress", async () => {
    renderTab();
    fireEvent.change(screen.getByTestId("deposit-amount"), { target: { value: "1" } });
    const radioB = screen.getByTestId(`destination-vault-${VAULT_B.toLowerCase()}`) as HTMLElement;
    fireEvent.click(radioB.querySelector("input") as HTMLInputElement);

    await waitFor(() => expect(rec.allowanceSpender).toBe(VAULT_B));
    expect(rec.allowanceSpender).toBe(VAULT_B);
    expect(rec.allowanceSpender).not.toBe(VAULT_A);
  });

  it("defaults to props.vaultAddress before any selection is made", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("deposit-amount"), { target: { value: "1" } });
    // No selection yet → the default single-vault flow targets VAULT_A.
    expect(rec.depositSimAddress).toBe(VAULT_A);
    expect(rec.allowanceSpender).toBe(VAULT_A);
  });
});
