/**
 * Issue 1738: the router deposit preview shows amounts at the token's real scale and a status from the
 * deposit-state resolver. Real wagmi hooks over a fake in-memory chain with a connected mock wallet. The router
 * answers previewDeposit with the value the Base 8453 rehearsal router returned for 1 USDC.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { encodeFunctionResult, toFunctionSelector, type Address } from "viem";
import { routerAbi } from "../../src/lib/abi";
import { RouterDepositTab } from "../../src/components/RouterDepositTab";
import type { VaultPreviewContext } from "../../src/lib/vaultPreview";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const ROUTER = "0x5555555555555555555555555555555555555555" as Address;
/** router.previewDeposit(1e6) on the real rehearsal contracts: 1 USDC buys about 1 share at 24 decimals. */
const EST_SHARES_FOR_1_USDC = 999949002651862103170635n;

const ctx: VaultPreviewContext = {
  gateway: "0x1111111111111111111111111111111111111111",
  vault: VAULT,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};
const tid = (c: ParentNode, id: string) => c.querySelector(`[data-testid="${id}"]`);

function respondRouter(fake: ReturnType<typeof makeFakeChain>) {
  fake.respond = (to, data) => {
    if (to !== ROUTER.toLowerCase()) return undefined;
    if (data.startsWith(toFunctionSelector("getEffectiveWeights()"))) {
      return encodeFunctionResult({
        abi: routerAbi,
        functionName: "getEffectiveWeights",
        result: [[VAULT], [10000n]],
      });
    }
    if (data.startsWith(toFunctionSelector("previewDeposit(uint256)"))) {
      return encodeFunctionResult({
        abi: routerAbi,
        functionName: "previewDeposit",
        result: [
          {
            vault: VAULT,
            weightBps: 10000n,
            legAmount: 1_000_000n,
            estShares: EST_SHARES_FOR_1_USDC,
            unavailable: false,
          },
        ],
      });
    }
    return undefined;
  };
}

describe("router deposit preview scale", () => {
  it("a 1 USDC preview reads 1.00 USDC, 100.00%, about 1 share, and Active for an open vault", async () => {
    const fake = makeFakeChain({ [VAULT]: false });
    respondRouter(fake);
    const { container } = await renderOnFakeChain(
      <RouterDepositTab
        routerAddress={ROUTER}
        usdcAddress={USDC}
        ctx={{ ...ctx, router: ROUTER }}
      />,
      fake,
      { connected: true },
    );
    const amount = () => tid(container, "router-deposit-tab-amount") as HTMLInputElement;
    await waitFor(() => expect(amount().disabled).toBe(false));
    fireEvent.change(amount(), { target: { value: "1" } });
    await waitFor(() => expect(tid(container, "proportion-preview-table")).not.toBeNull());

    expect(tid(container, "proportion-preview-usdc-0")?.textContent).toBe("1.00 USDC");
    expect(tid(container, "proportion-preview-weight-0")?.textContent).toBe("100.00%");
    expect(tid(container, "proportion-preview-shares-0")?.textContent).toBe("0.999949 shares");
    expect(tid(container, "proportion-preview-status-0")?.textContent).toBe("Active");
    // The raw 24-decimal count formatted at 6 decimals was the bug.
    expect(container.textContent).not.toContain("999,949,002,651,862,103");
    expect(container.textContent).toContain("Portfolio Router splits 1.00 USDC across 1 vault(s)");
  });

  it("a paused vault shows the closed notice with no amount typed, an empty amount, and a disabled button", async () => {
    const fake = makeFakeChain({ [VAULT]: true });
    respondRouter(fake);
    const { container } = await renderOnFakeChain(
      <RouterDepositTab
        routerAddress={ROUTER}
        usdcAddress={USDC}
        ctx={{ ...ctx, router: ROUTER }}
      />,
      fake,
      { connected: true },
    );
    await waitFor(() =>
      expect(tid(container, "router-deposits-closed")?.textContent ?? "").toMatch(
        /Deposits paused \/ closed/,
      ),
    );
    expect((tid(container, "router-deposit-tab-amount") as HTMLInputElement).value).toBe("");
    expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).not.toMatch(/\bActive\b/);
  });

  it("with no wallet the closed notice still shows from the router's weights", async () => {
    const fake = makeFakeChain({ [VAULT]: true });
    respondRouter(fake);
    const { container } = await renderOnFakeChain(
      <RouterDepositTab
        routerAddress={ROUTER}
        usdcAddress={USDC}
        ctx={{ ...ctx, router: ROUTER }}
      />,
      fake,
      { connected: false },
    );
    await waitFor(() => expect(tid(container, "router-deposits-closed")).not.toBeNull());
    expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
