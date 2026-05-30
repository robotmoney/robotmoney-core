/**
 * Component tests — FaucetTabView. Covers issue #261 acceptance criteria:
 *
 *   - Drip button is disabled until the harness `balanceOf` preflight
 *     returns a value >= the fixed amount; clicking the enabled button
 *     calls the injected drip handler with the selected wallet and
 *     `FAUCET_DRIP_AMOUNT_USDC`.
 *   - Wallet dropdown is populated from injected props.
 *   - When `harnessPrivateKey === null` (mainnet build) the tab renders
 *     a "faucet-unavailable" state instead of the form.
 *
 * Issue #365 extends coverage to RM token drip:
 *   - 'Get RM tokens' button renders when rmTokenAddress is provided.
 *   - Button is absent when rmTokenAddress is undefined.
 *   - Button is disabled until harnessRmBalance >= FAUCET_DRIP_AMOUNT_RM.
 *   - Clicking calls the injected dripRm handler with the right rmTokenAddress.
 *
 * Render the pure FaucetTabView directly — no wagmi/QueryClient fixture
 * needed, per docs/development/react-guide.md §Layout.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "./helpers/render";
import type { Hex } from "viem";
import { FaucetTabView } from "../../src/components/FaucetTabView";
import {
  FAUCET_DRIP_AMOUNT_ETH,
  FAUCET_DRIP_AMOUNT_RM,
  FAUCET_DRIP_AMOUNT_USDC,
} from "../../src/lib/chainClassifier";
import type { DripEthArgs, DripRmTokenArgs, DripUsdcArgs } from "../../src/lib/faucetClient";

const USDC = "0x4444444444444444444444444444444444444444" as const;
const RM_TOKEN = "0x5555555555555555555555555555555555555555" as const;
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const KEY = ("0x" + "11".repeat(32)) as Hex;

interface RenderOpts {
  harnessBalance?: bigint;
  harnessBalancePending?: boolean;
  harnessBalanceError?: Error | null;
  recipientBalance?: bigint;
  harnessPrivateKey?: Hex | null;
  walletAddresses?: ReadonlyArray<typeof WALLET_A | typeof WALLET_B>;
  drip?: (args: DripUsdcArgs) => Promise<Hex>;
  rmTokenAddress?: typeof RM_TOKEN;
  harnessRmBalance?: bigint;
  dripRm?: (args: DripRmTokenArgs) => Promise<Hex>;
  harnessEthBalance?: bigint;
  dripEth?: (args: DripEthArgs) => Promise<Hex>;
}

function renderView(opts: RenderOpts = {}) {
  const refetch = vi.fn().mockResolvedValue(undefined);
  const drip = opts.drip ?? vi.fn(async (_a: DripUsdcArgs): Promise<Hex> => "0xfeed" as Hex);
  const utils = render(
    <FaucetTabView
      usdcAddress={USDC}
      chainId={918453}
      walletAddresses={opts.walletAddresses ?? [WALLET_A, WALLET_B]}
      harnessPrivateKey={opts.harnessPrivateKey === undefined ? KEY : opts.harnessPrivateKey}
      harnessBalance={opts.harnessBalance}
      harnessBalancePending={opts.harnessBalancePending ?? false}
      harnessBalanceError={opts.harnessBalanceError ?? null}
      recipientBalance={opts.recipientBalance}
      refetchRecipientBalance={refetch}
      drip={drip}
      rmTokenAddress={opts.rmTokenAddress}
      harnessRmBalance={opts.harnessRmBalance}
      dripRm={opts.dripRm}
      harnessEthBalance={opts.harnessEthBalance}
      dripEth={opts.dripEth}
    />,
  );
  return { ...utils, drip, refetch };
}

describe("FaucetTabView", () => {
  it("renders the wallet dropdown from props", () => {
    renderView();
    const options = screen
      .getByTestId("faucet-wallet-select")
      .querySelectorAll<HTMLOptionElement>("option");
    const values = Array.from(options).map((o) => o.value);
    expect(values).toEqual([WALLET_A, WALLET_B]);
  });

  it("disables the drip button until harness balance >= amount", () => {
    // No balance yet — disabled.
    renderView({ harnessBalance: undefined, harnessBalancePending: true });
    expect(screen.getByTestId("faucet-drip-submit")).toBeDisabled();
  });

  it("disables the drip button when harness balance is below amount", () => {
    renderView({ harnessBalance: FAUCET_DRIP_AMOUNT_USDC - 1n });
    expect(screen.getByTestId("faucet-drip-submit")).toBeDisabled();
  });

  it("enables the drip button once harness balance covers the drip", () => {
    renderView({ harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n });
    expect(screen.getByTestId("faucet-drip-submit")).not.toBeDisabled();
  });

  it("calls drip with the selected recipient and the shared constant amount", async () => {
    // Stub window.ethereum so FaucetTabView's getInjectedProvider() succeeds.
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: vi.fn(),
    };
    const { drip } = renderView({ harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n });
    fireEvent.change(screen.getByTestId("faucet-wallet-select"), { target: { value: WALLET_B } });
    fireEvent.click(screen.getByTestId("faucet-drip-submit"));
    await screen.findByTestId("faucet-drip-pending");
    // give the awaited drip a microtask to resolve into success state
    await new Promise((r) => setTimeout(r, 0));
    expect(drip).toHaveBeenCalledTimes(1);
    const callArg = (drip as ReturnType<typeof vi.fn>).mock.calls[0][0] as DripUsdcArgs;
    expect(callArg.recipient.toLowerCase()).toBe(WALLET_B);
    // The amount field is intentionally NOT on DripUsdcArgs (the
    // constant lives in faucetClient.dripUsdc / encodeDripCalldata), so
    // asserting it here would couple to internals. The dedicated
    // `faucet-shared-amount.test.ts` covers the constant-sharing AC.
    expect(callArg.usdcAddress).toBe(USDC);
    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  it("renders the unavailable state when the harness key is missing", () => {
    renderView({ harnessPrivateKey: null });
    expect(screen.getByTestId("faucet-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("faucet-drip-submit")).toBeNull();
  });

  it("renders an empty-state option when no wallets are connected", () => {
    renderView({ walletAddresses: [], harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n });
    expect(screen.getByText(/no wallets connected/i)).toBeInTheDocument();
    expect(screen.getByTestId("faucet-drip-submit")).toBeDisabled();
  });

  // -- RM token drip (issue #365) -------------------------------------------

  it("does NOT render the RM drip button when rmTokenAddress is undefined", () => {
    renderView({ harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n });
    expect(screen.queryByTestId("faucet-rm-drip-button")).toBeNull();
  });

  it("renders the RM drip button when rmTokenAddress is provided", () => {
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      rmTokenAddress: RM_TOKEN,
      harnessRmBalance: FAUCET_DRIP_AMOUNT_RM * 100n,
      dripRm: vi.fn(async (): Promise<Hex> => "0xabcd" as Hex),
    });
    expect(screen.getByTestId("faucet-rm-drip-button")).toBeInTheDocument();
  });

  it("disables the RM drip button when harnessRmBalance is below amount", () => {
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      rmTokenAddress: RM_TOKEN,
      harnessRmBalance: FAUCET_DRIP_AMOUNT_RM - 1n,
      dripRm: vi.fn(async (): Promise<Hex> => "0xabcd" as Hex),
    });
    expect(screen.getByTestId("faucet-rm-drip-button")).toBeDisabled();
  });

  it("enables the RM drip button when harnessRmBalance covers the drip", () => {
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      rmTokenAddress: RM_TOKEN,
      harnessRmBalance: FAUCET_DRIP_AMOUNT_RM * 100n,
      dripRm: vi.fn(async (): Promise<Hex> => "0xabcd" as Hex),
    });
    expect(screen.getByTestId("faucet-rm-drip-button")).not.toBeDisabled();
  });

  it("calls dripRm with the correct rmTokenAddress and recipient on button click", async () => {
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: vi.fn(),
    };
    const dripRm = vi.fn(async (): Promise<Hex> => "0xabcd" as Hex);
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      rmTokenAddress: RM_TOKEN,
      harnessRmBalance: FAUCET_DRIP_AMOUNT_RM * 100n,
      dripRm,
    });
    fireEvent.change(screen.getByTestId("faucet-wallet-select"), { target: { value: WALLET_B } });
    fireEvent.click(screen.getByTestId("faucet-rm-drip-button"));
    await screen.findByTestId("faucet-rm-drip-pending");
    await new Promise((r) => setTimeout(r, 0));
    expect(dripRm).toHaveBeenCalledTimes(1);
    const callArg = (dripRm as ReturnType<typeof vi.fn>).mock.calls[0][0] as DripRmTokenArgs;
    expect(callArg.rmTokenAddress).toBe(RM_TOKEN);
    expect(callArg.recipient.toLowerCase()).toBe(WALLET_B);
    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  // -- Base ETH drip (issue #466) -------------------------------------------

  it("does NOT render the Get Base ETH button when dripEth is undefined", () => {
    renderView({ harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n });
    expect(screen.queryByTestId("faucet-eth-drip-button")).toBeNull();
  });

  it("renders the Get Base ETH button when dripEth is provided", () => {
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      harnessEthBalance: FAUCET_DRIP_AMOUNT_ETH * 100n,
      dripEth: vi.fn(async (): Promise<Hex> => "0xeeee" as Hex),
    });
    expect(screen.getByTestId("faucet-eth-drip-button")).toBeInTheDocument();
  });

  it("disables the Get Base ETH button when harness ETH balance is below the drip amount", () => {
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      harnessEthBalance: FAUCET_DRIP_AMOUNT_ETH - 1n,
      dripEth: vi.fn(async (): Promise<Hex> => "0xeeee" as Hex),
    });
    expect(screen.getByTestId("faucet-eth-drip-button")).toBeDisabled();
  });

  it("enables the Get Base ETH button once harness ETH balance covers the drip", () => {
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      harnessEthBalance: FAUCET_DRIP_AMOUNT_ETH * 100n,
      dripEth: vi.fn(async (): Promise<Hex> => "0xeeee" as Hex),
    });
    expect(screen.getByTestId("faucet-eth-drip-button")).not.toBeDisabled();
  });

  it("calls dripEth with the selected recipient on button click", async () => {
    (window as unknown as { ethereum: unknown }).ethereum = {
      request: vi.fn(),
    };
    const dripEth = vi.fn(async (): Promise<Hex> => "0xeeee" as Hex);
    renderView({
      harnessBalance: FAUCET_DRIP_AMOUNT_USDC * 100n,
      harnessEthBalance: FAUCET_DRIP_AMOUNT_ETH * 100n,
      dripEth,
    });
    fireEvent.change(screen.getByTestId("faucet-wallet-select"), { target: { value: WALLET_B } });
    fireEvent.click(screen.getByTestId("faucet-eth-drip-button"));
    await screen.findByTestId("faucet-eth-drip-pending");
    await new Promise((r) => setTimeout(r, 0));
    expect(dripEth).toHaveBeenCalledTimes(1);
    const callArg = (dripEth as ReturnType<typeof vi.fn>).mock.calls[0][0] as DripEthArgs;
    expect(callArg.recipient.toLowerCase()).toBe(WALLET_B);
    delete (window as unknown as { ethereum?: unknown }).ethereum;
  });

  it("does NOT render the Get Base ETH button when the harness key is missing", () => {
    renderView({
      harnessPrivateKey: null,
      harnessEthBalance: FAUCET_DRIP_AMOUNT_ETH * 100n,
      dripEth: vi.fn(async (): Promise<Hex> => "0xeeee" as Hex),
    });
    expect(screen.queryByTestId("faucet-eth-drip-button")).toBeNull();
    expect(screen.getByTestId("faucet-unavailable")).toBeInTheDocument();
  });
});
