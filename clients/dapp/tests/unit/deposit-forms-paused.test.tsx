/**
 * Issue 1731: the deposit forms disable deposits, with the reason, when the vault's own `depositsPaused()` is
 * true, and leave withdraw and redeem alone (`pauseDeposits()` closes the deposit side only).
 *
 * Real wagmi hooks over a fake in-memory chain (helpers/fakeChain.tsx) with a connected mock wallet. Nothing
 * inside the components is mocked.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { encodeFunctionResult, toFunctionSelector, type Address } from "viem";
import { erc20Abi, vaultAbi } from "../../src/lib/abi";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import { RouterDepositTab } from "../../src/components/RouterDepositTab";
import { routerAbi } from "../../src/lib/abi";
import type { VaultPreviewContext } from "../../src/lib/vaultPreview";
import type { RouterPreviewContext } from "../../src/lib/routerPreview";
import { makeFakeChain, renderOnFakeChain } from "./helpers/fakeChain";

const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const VAULT_B = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const ROUTER = "0x5555555555555555555555555555555555555555" as Address;

const ctx: VaultPreviewContext = {
  gateway: "0x1111111111111111111111111111111111111111",
  vault: VAULT,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const tid = (c: ParentNode, id: string) => c.querySelector(`[data-testid="${id}"]`);

describe("DepositWithdrawTab: single-vault deposit form", () => {
  it("paused: shows the closed notice, disables amount, approve and submit, and leaves withdraw usable", async () => {
    const fake = makeFakeChain({ [VAULT]: true });
    const { container } = await renderOnFakeChain(
      <DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />,
      fake,
      { connected: true },
    );
    await waitFor(() => expect(tid(container, "deposit-closed-notice")).not.toBeNull());
    const notice = tid(container, "deposit-closed-notice")!;
    expect(notice.textContent).toContain("Deposits paused / closed");
    expect(notice.textContent).toContain("Withdraw and redeem stay open");
    expect(notice.getAttribute("data-deposit-state")).toBe("paused");
    expect((tid(container, "deposit-amount") as HTMLInputElement).disabled).toBe(true);
    expect((tid(container, "deposit-submit") as HTMLButtonElement).disabled).toBe(true);
    // The withdraw side is untouched by a deposit pause.
    expect(tid(container, "withdraw-form")).not.toBeNull();
    expect((tid(container, "withdraw-amount") as HTMLInputElement).disabled).toBe(false);
  });

  it("unpaused: no notice and the amount can be typed", async () => {
    const fake = makeFakeChain({ [VAULT]: false });
    const { container } = await renderOnFakeChain(
      <DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />,
      fake,
      { connected: true },
    );
    await waitFor(() => expect(fake.calls.some((c) => c.method === "eth_call")).toBe(true));
    expect(tid(container, "deposit-closed-notice")).toBeNull();
    expect((tid(container, "deposit-amount") as HTMLInputElement).disabled).toBe(false);
  });
});

describe("RouterDepositTab: all-or-revert router deposit", () => {
  const routerCtx: RouterPreviewContext = { ...ctx, router: ROUTER };
  const previewSelector = toFunctionSelector("previewDeposit(uint256)");

  function routerFake(paused: Record<string, boolean>) {
    const fake = makeFakeChain(paused);
    fake.respond = (to, data) => {
      if (to === ROUTER.toLowerCase() && data.startsWith(previewSelector)) {
        return encodeFunctionResult({
          abi: routerAbi,
          functionName: "previewDeposit",
          result: [
            {
              vault: VAULT,
              weightBps: 5000n,
              legAmount: 500000n,
              estShares: 500000n,
              unavailable: false,
            },
            {
              vault: VAULT_B,
              weightBps: 5000n,
              legAmount: 500000n,
              estShares: 500000n,
              unavailable: false,
            },
          ],
        });
      }
      return undefined;
    };
    return fake;
  }

  it("a paused leg vault closes the whole router deposit and says how many legs are closed", async () => {
    const fake = routerFake({ [VAULT]: false, [VAULT_B]: true });
    const { container } = await renderOnFakeChain(
      <RouterDepositTab routerAddress={ROUTER} usdcAddress={USDC} ctx={routerCtx} />,
      fake,
      { connected: true },
    );
    fireEvent.change(tid(container, "router-deposit-tab-amount")!, { target: { value: "1" } });
    await waitFor(() => expect(tid(container, "router-deposits-closed")).not.toBeNull());
    const notice = tid(container, "router-deposits-closed")!;
    expect(notice.textContent).toContain("1 of 2 leg vaults closed");
    expect(notice.textContent).toContain("Deposits paused / closed");
    expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(true);
    expect((tid(container, "router-deposit-tab-amount") as HTMLInputElement).disabled).toBe(true);
  });

  it("no leg paused: no closed notice", async () => {
    const fake = routerFake({ [VAULT]: false, [VAULT_B]: false });
    const { container } = await renderOnFakeChain(
      <RouterDepositTab routerAddress={ROUTER} usdcAddress={USDC} ctx={routerCtx} />,
      fake,
      { connected: true },
    );
    fireEvent.change(tid(container, "router-deposit-tab-amount")!, { target: { value: "1" } });
    await waitFor(() =>
      expect(fake.calls.filter((c) => c.method === "eth_call").length).toBeGreaterThan(2),
    );
    expect(tid(container, "router-deposits-closed")).toBeNull();
  });
});

// ─── A pause that lands while the form is open ───────────────────────────────────────────────────────────
//
// The tests above show the closed state from the start, where the deposit is also disabled for want of a
// simulation. These start with a fully enabled form (allowance, simulation, preview all good), then flip the
// vault's flag on the chain and refetch. The submit button must follow the FLAG, not the stale simulation.

describe("a pause that lands while the form is open", () => {
  const ALLOWANCE = toFunctionSelector("allowance(address,address)");
  const DEPOSIT = toFunctionSelector("deposit(uint256,address)");
  const ROUTER_DEPOSIT = toFunctionSelector("deposit(uint256,uint256[])");
  const PREVIEW = toFunctionSelector("previewDeposit(uint256)");
  const WEIGHTS = toFunctionSelector("getEffectiveWeights()");

  function fullyEnabledFake(paused: Record<string, boolean>) {
    const fake = makeFakeChain(paused);
    fake.respond = (to, data) => {
      if (data.startsWith(ALLOWANCE)) {
        return encodeFunctionResult({
          abi: erc20Abi,
          functionName: "allowance",
          result: 10n ** 30n,
        });
      }
      if (data.startsWith(DEPOSIT) && to === VAULT.toLowerCase()) {
        return encodeFunctionResult({ abi: vaultAbi, functionName: "deposit", result: 1n });
      }
      if (to === ROUTER.toLowerCase()) {
        if (data.startsWith(PREVIEW)) {
          return encodeFunctionResult({
            abi: routerAbi,
            functionName: "previewDeposit",
            result: [
              {
                vault: VAULT,
                weightBps: 10000n,
                legAmount: 1000000n,
                estShares: 1000000n,
                unavailable: false,
              },
            ],
          });
        }
        if (data.startsWith(WEIGHTS)) {
          return encodeFunctionResult({
            abi: routerAbi,
            functionName: "getEffectiveWeights",
            result: [[VAULT], [10000n]],
          });
        }
        if (data.startsWith(ROUTER_DEPOSIT)) {
          return encodeFunctionResult({ abi: routerAbi, functionName: "deposit", result: [1n] });
        }
      }
      return undefined;
    };
    return fake;
  }

  it("single-vault form: submit is enabled while open, and disabled once the vault pauses", async () => {
    const fake = fullyEnabledFake({ [VAULT]: false });
    const { container, client } = await renderOnFakeChain(
      <DepositWithdrawTab vaultAddress={VAULT} usdcAddress={USDC} ctx={ctx} />,
      fake,
      { connected: true },
    );
    fireEvent.change(tid(container, "deposit-amount")!, { target: { value: "1" } });
    await waitFor(() =>
      expect((tid(container, "deposit-submit") as HTMLButtonElement).disabled).toBe(false),
    );
    fake.paused[VAULT.toLowerCase()] = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(tid(container, "deposit-closed-notice")).not.toBeNull());
    expect((tid(container, "deposit-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("router form: submit is enabled while open, and disabled once a leg vault pauses", async () => {
    const fake = fullyEnabledFake({ [VAULT]: false });
    const { container, client } = await renderOnFakeChain(
      <RouterDepositTab
        routerAddress={ROUTER}
        usdcAddress={USDC}
        ctx={{ ...ctx, router: ROUTER }}
      />,
      fake,
      { connected: true },
    );
    fireEvent.change(tid(container, "router-deposit-tab-amount")!, { target: { value: "1" } });
    await waitFor(() =>
      expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fake.paused[VAULT.toLowerCase()] = true;
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(tid(container, "router-deposits-closed")).not.toBeNull());
    expect((tid(container, "router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(true);
  });
});
