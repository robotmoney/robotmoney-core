/**
 * Core 1912 (ADR-0017): after rmAGENT is retired the router splits across THREE legs
 * (rmUSDC, rmPROTO, rmRWA). RouterDepositTab shows no rmAGENT leg and no fourth leg row,
 * and the retired vault is never a destination of the preview.
 *
 * Wagmi hooks are mocked at the module boundary, as in router-deposit-tab.test.tsx.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "./helpers/render";
import type { Address } from "viem";
import { RouterDepositTab } from "../../src/components/RouterDepositTab";
import type { RouterPreviewContext } from "../../src/lib/routerPreview";

const ROUTER = "0xrouterrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr" as Address;
const USDC_TOKEN = "0x4444444444444444444444444444444444444444" as Address;
const RM_USDC = "0x1111111111111111111111111111111111111111" as Address;
const RM_PROTO = "0x2222222222222222222222222222222222222222" as Address;
const RM_RWA = "0x3333333333333333333333333333333333333333" as Address;
const RM_AGENT = "0x00000000000000000000000000000000000000a9" as Address;
const USER = "0x5555555555555555555555555555555555555555" as Address;

const ctx: RouterPreviewContext = {
  gateway: "0x6666666666666666666666666666666666666666" as Address,
  router: ROUTER,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const leg = (vault: Address, weightBps: bigint, legAmount: bigint, estShares: bigint) => ({
  vault,
  weightBps,
  legAmount,
  estShares,
  unavailable: false,
});

/** 10 USDC at the default vector rmUSDC 9500, rmPROTO 500, rmRWA 0 bps. */
const threeLegs = [
  leg(RM_USDC, 9500n, 9_500_000n, 9_450_000n),
  leg(RM_PROTO, 500n, 500_000n, 495_000n),
  leg(RM_RWA, 0n, 0n, 0n),
];

vi.mock("wagmi", () => ({
  useReadContracts: () => ({ data: undefined }),
  useAccount: () => ({ address: USER, isConnected: true }),
  useReadContract: (opts: { functionName?: string }) => {
    if (opts.functionName === "allowance") return { data: 10_000_000n, refetch: vi.fn() };
    if (opts.functionName === "previewDeposit") return { data: threeLegs, error: null };
    if (opts.functionName === "getEffectiveWeights")
      return {
        data: [
          [RM_USDC, RM_PROTO, RM_RWA],
          [9500n, 500n, 0n],
        ],
      };
    return { data: undefined, error: null };
  },
  useSimulateContract: () => ({ data: { request: {} }, error: null }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false, data: undefined }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

describe("RouterDepositTab after the rmAGENT retire", () => {
  it("shows exactly three legs and no rmAGENT leg", () => {
    const { container } = render(
      <RouterDepositTab routerAddress={ROUTER} usdcAddress={USDC_TOKEN} ctx={ctx} />,
    );
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });
    expect(screen.getByTestId("proportion-preview-usdc-0")).toBeDefined();
    expect(screen.getByTestId("proportion-preview-usdc-1")).toBeDefined();
    expect(screen.getByTestId("proportion-preview-usdc-2")).toBeDefined();
    expect(screen.queryByTestId("proportion-preview-usdc-3")).toBeNull();
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain(RM_AGENT.toLowerCase());
    expect(text).not.toContain("rmagent");
  });
});
