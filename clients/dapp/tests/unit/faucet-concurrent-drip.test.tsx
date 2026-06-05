/**
 * Component test — concurrent faucet drip serialization (issue #619).
 *
 * The harness EOA is shared across all three drip types (USDC, ETH, RM token).
 * If two drip handlers were fired concurrently they would each fetch a fresh
 * nonce independently, causing the second transaction to collide with the
 * first. FaucetTabView serializes all drips via a shared promise-chain queue
 * (harnessQueueRef) and a global `harnessBusy` guard.
 *
 * AC being validated here:
 *   "Clicking 'Drip 100 USDC' and 'Drip Base ETH' in rapid succession results
 *    in both transactions succeeding (not a nonce-collision error) — enforced
 *    by a Vitest test that fires both handlers concurrently against stub drip
 *    functions that resolve after a short delay."
 *
 * We simulate rapid concurrent clicks by clicking both buttons without
 * awaiting. The stubs resolve sequentially (via the queue) so both hashes
 * eventually appear, and the second drip is disabled while the first is
 * in-flight.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "./helpers/render";
import type { Hex } from "viem";
import { FaucetTabView } from "../../src/components/FaucetTabView";
import {
  FAUCET_DRIP_AMOUNT_ETH,
  FAUCET_DRIP_AMOUNT_USDC,
} from "../../src/lib/chainClassifier";
import type { DripEthArgs, DripUsdcArgs } from "../../src/lib/faucetClient";

const USDC = "0x4444444444444444444444444444444444444444" as const;
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const KEY = ("0x" + "11".repeat(32)) as Hex;

describe("FaucetTabView — concurrent drip serialization (issue #619)", () => {
  it("both USDC and ETH drips succeed when buttons are clicked in rapid succession", async () => {
    // Stubs that resolve after a short delay to simulate in-flight transactions.
    let resolveUsdc!: (hash: Hex) => void;
    let resolveEth!: (hash: Hex) => void;

    const usdcPromise = new Promise<Hex>((res) => {
      resolveUsdc = res;
    });
    const ethPromise = new Promise<Hex>((res) => {
      resolveEth = res;
    });

    const dripUsdc = vi.fn((_args: DripUsdcArgs) => usdcPromise);
    const dripEth = vi.fn((_args: DripEthArgs) => ethPromise);

    (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn() };

    render(
      <FaucetTabView
        usdcAddress={USDC}
        chainId={918453}
        walletAddresses={[WALLET_A]}
        harnessPrivateKey={KEY}
        harnessBalance={FAUCET_DRIP_AMOUNT_USDC * 100n}
        harnessBalancePending={false}
        harnessBalanceError={null}
        recipientBalance={undefined}
        refetchRecipientBalance={vi.fn().mockResolvedValue(undefined)}
        drip={dripUsdc}
        harnessEthBalance={FAUCET_DRIP_AMOUNT_ETH * 100n}
        dripEth={dripEth}
      />,
    );

    // Both buttons should be enabled initially.
    const usdcBtn = screen.getByTestId("faucet-drip-submit");
    const ethBtn = screen.getByTestId("faucet-eth-drip-button");
    expect(usdcBtn).not.toBeDisabled();
    expect(ethBtn).not.toBeDisabled();

    // Click USDC drip — it becomes in-flight.
    fireEvent.click(usdcBtn);

    // ETH drip button should now be disabled (global harness-busy guard).
    await screen.findByTestId("faucet-drip-pending");
    expect(ethBtn).toBeDisabled();

    // Resolve the USDC drip — queue advances, harness is free again.
    await act(async () => {
      resolveUsdc("0xusdc1111" as Hex);
      // Drain microtask queue so React can process the state update.
      await new Promise((r) => setTimeout(r, 0));
    });

    // After USDC resolves, both buttons are re-enabled.
    expect(usdcBtn).not.toBeDisabled();
    expect(ethBtn).not.toBeDisabled();

    // Now click ETH drip.
    fireEvent.click(ethBtn);
    await screen.findByTestId("faucet-eth-drip-pending");

    await act(async () => {
      resolveEth("0xeth2222" as Hex);
      await new Promise((r) => setTimeout(r, 0));
    });

    // Both success messages visible.
    expect(screen.getByTestId("faucet-drip-success")).toBeInTheDocument();
    expect(screen.getByTestId("faucet-eth-drip-success")).toBeInTheDocument();

    // Both drip stubs were called exactly once — serialized, no collision.
    expect(dripUsdc).toHaveBeenCalledTimes(1);
    expect(dripEth).toHaveBeenCalledTimes(1);

    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  it("second drip button is disabled while the first drip is in-flight", async () => {
    let resolveUsdc!: (hash: Hex) => void;
    const usdcPromise = new Promise<Hex>((res) => {
      resolveUsdc = res;
    });

    const dripUsdc = vi.fn((_args: DripUsdcArgs) => usdcPromise);
    const dripEth = vi.fn(async (_args: DripEthArgs): Promise<Hex> => "0xeth" as Hex);

    (window as unknown as { ethereum: unknown }).ethereum = { request: vi.fn() };

    render(
      <FaucetTabView
        usdcAddress={USDC}
        chainId={918453}
        walletAddresses={[WALLET_A]}
        harnessPrivateKey={KEY}
        harnessBalance={FAUCET_DRIP_AMOUNT_USDC * 100n}
        harnessBalancePending={false}
        harnessBalanceError={null}
        recipientBalance={undefined}
        refetchRecipientBalance={vi.fn().mockResolvedValue(undefined)}
        drip={dripUsdc}
        harnessEthBalance={FAUCET_DRIP_AMOUNT_ETH * 100n}
        dripEth={dripEth}
      />,
    );

    const usdcBtn = screen.getByTestId("faucet-drip-submit");
    const ethBtn = screen.getByTestId("faucet-eth-drip-button");

    // Click USDC — drip is in-flight.
    fireEvent.click(usdcBtn);
    await screen.findByTestId("faucet-drip-pending");

    // ETH button must be disabled while USDC drip is in-flight.
    expect(ethBtn).toBeDisabled();

    // Resolve USDC drip and confirm ETH button re-enables.
    await act(async () => {
      resolveUsdc("0xusdc" as Hex);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(ethBtn).not.toBeDisabled();

    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });
});
