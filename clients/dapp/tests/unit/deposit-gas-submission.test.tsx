// Core 1777: exercise real deposit click handlers through the external wagmi boundary.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "./helpers/render";
import type { Address } from "viem";
import { RouterDepositTab } from "../../src/components/RouterDepositTab";
import { VaultSelectorDepositTab } from "../../src/components/VaultSelectorDepositTab";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import { VaultRegistryProvider } from "../../src/lib/VaultRegistryContext";
import { routerAbi, vaultAbi } from "../../src/lib/abi";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const USDC = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x3333333333333333333333333333333333333333" as Address;
const USER = "0x4444444444444444444444444444444444444444" as Address;
const REGISTRY = "0x5555555555555555555555555555555555555555" as Address;
const ctx = {
  gateway: REGISTRY,
  vault: VAULT,
  router: ROUTER,
  gatewayCodeHashVerified: true,
  envClass: "fork" as const,
};
const metadata = { name: "rmUSDC", asset: USDC, registeredAt: 0n };
const writeContract = vi.fn();
const refetch = vi.fn();

interface ContractOptions {
  address: Address;
  account?: Address;
  abi?: unknown;
  functionName: string;
  args?: readonly unknown[];
  query?: { enabled?: boolean };
}

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: USER, isConnected: true }),
  useReadContract: (opts: ContractOptions) => {
    let data: unknown;
    switch (opts.functionName) {
      case "allowance":
      case "balanceOf":
        data = 10_000_000n;
        break;
      case "listVaults":
        data = [VAULT];
        break;
      case "getVault":
        data = [metadata, 0];
        break;
      case "getEffectiveWeights":
        data = [[VAULT], [10_000n]];
        break;
      case "previewDeposit":
        data =
          opts.address === ROUTER
            ? [
                {
                  vault: VAULT,
                  weightBps: 10_000n,
                  legAmount: 1_000_000n,
                  estShares: 1_000_000n,
                  unavailable: false,
                },
              ]
            : 1_000_000n;
        break;
    }
    return { data, refetch, error: null };
  },
  useReadContracts: (opts: { contracts: ContractOptions[] }) => ({
    data: opts.contracts.map((c) => ({
      status: "success",
      result:
        c.functionName === "getVault"
          ? [metadata, 0]
          : c.functionName === "depositsPaused"
            ? false
            : 0n,
    })),
    refetch,
  }),
  // A disabled simulation supplies no request. Submission therefore requires the real form gates.
  useSimulateContract: (opts: ContractOptions) => ({
    data: opts.query?.enabled
      ? {
          request: {
            account: opts.account,
            address: opts.address,
            abi: opts.abi,
            functionName: opts.functionName,
            args: opts.args,
            gas: 1n,
          },
        }
      : undefined,
    error: null,
  }),
  useWriteContract: () => ({ writeContract, isPending: false, data: undefined }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

function assertSubmission(target: Address, abi: unknown, args: readonly unknown[], floor: bigint) {
  expect(writeContract).toHaveBeenCalledTimes(1);
  const [request] = writeContract.mock.calls[0];
  expect(request).toEqual({
    account: USER,
    address: target,
    abi,
    functionName: "deposit",
    args,
    gas: expect.any(BigInt),
  });
  expect(request.gas).toBeGreaterThanOrEqual(floor);
}

describe("deposit gas on wallet submission", () => {
  beforeEach(() => writeContract.mockClear());

  it("RouterDepositTab submits the simulated router deposit with at least 6.8M gas", () => {
    render(<RouterDepositTab routerAddress={ROUTER} usdcAddress={USDC} ctx={ctx} />);
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), { target: { value: "1" } });
    const submit = screen.getByTestId("router-deposit-tab-submit");
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    assertSubmission(ROUTER, routerAbi, [1_000_000n, [995_000n]], 6_800_000n);
  });

  it("VaultSelectorDepositTab submits the selected vault deposit with at least 1.6M gas", () => {
    render(
      <VaultRegistryProvider registryAddress={REGISTRY}>
        <VaultSelectorDepositTab usdcAddress={USDC} registryAddress={REGISTRY} ctx={ctx} />
      </VaultRegistryProvider>,
    );
    fireEvent.change(screen.getByTestId("vault-selector"), { target: { value: VAULT } });
    fireEvent.change(screen.getByTestId("vault-selector-deposit-amount"), {
      target: { value: "1" },
    });
    const submit = screen.getByTestId("vault-selector-deposit-submit");
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    assertSubmission(VAULT, vaultAbi, [1_000_000n, USER], 1_600_000n);
  });

  it("DepositWithdrawTab submits its direct vault deposit with at least 1.6M gas", () => {
    render(<DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />);
    fireEvent.change(screen.getByTestId("deposit-amount"), { target: { value: "1" } });
    const submit = screen.getByTestId("deposit-submit");
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    assertSubmission(VAULT, vaultAbi, [1_000_000n, USER], 1_600_000n);
  });
});
