/**
 * Unit tests — the Withdraw tab's single-vault exit carries a minimum-out floor
 * (QA plan D9, finding E8, SR-M16).
 *
 * `vault.redeem(shares, receiver, owner)` has no min-out: before D9 the tab
 * signed it directly and the holder got whatever the vault paid at inclusion.
 * Now a registered vault is redeemed through `PortfolioRouter.redeemFor` as one
 * leg, with `minAssetsPerLeg` = `previewRedeem(shares)` less 0.50%, after an
 * approval of exactly `shares` to the router. The direct redeem stays only
 * where the router cannot take the exit, and the tab says it has no floor.
 *
 * wagmi and the registry context are mocked at the module boundary. Every
 * simulation and write records what it was asked to do.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "./helpers/render";
import { decodeFunctionData, type Address } from "viem";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import { RuntimeConfigProvider } from "../../src/lib/RuntimeConfigContext";
import { routerAbi } from "../../src/lib/abi";
import {
  buildRouterRedeemPreview,
  chooseRedeemRoute,
  deriveMinAssets,
  leftoverRouterAllowance,
  leftoverRouterAllowanceText,
  needsShareApproval,
  routerRedeemCall,
  routerRedeemDeadline,
  ROUTER_REDEEM_DEADLINE_SECS,
} from "../../src/lib/routerRedeem";
import { withRedeemGasWorkaround } from "../../src/lib/redeemGas";
import type { VaultPreviewContext } from "../../src/lib/vaultPreview";
import { describeVerificationCause } from "../../src/lib/gatewayVerifier";
import { ROUTER_CODE_HASH_PIN_KEY } from "../../src/lib/codePins";

const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const BASKET = "0x2222222222222222222222222222222222222222" as Address;
const ROUTER = "0x5555555555555555555555555555555555555555" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const USER = "0x3333333333333333333333333333333333333333" as Address;
/** 5 shares at 24 decimals, what "5" in the input parses to. */
const SHARES = 5_000_000_000_000_000_000_000_000n;
/** `previewRedeem(SHARES)` in the mock. */
const PREVIEW = 4_990_000n;
/** PREVIEW less 0.50%: 4_990_000 * 9_950 / 10_000. */
const FLOOR = 4_965_050n;

const ctx: VaultPreviewContext = {
  gateway: "0x7777777777777777777777777777777777777777",
  vault: VAULT,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

interface Sim {
  functionName?: string;
  address?: string;
  args?: readonly unknown[];
  enabled: boolean;
}

const mock = vi.hoisted(() => ({
  registered: [] as { vault: `0x${string}`; name: string; status: number }[],
  /** The router's allowance on the vault's share token. */
  routerAllowance: 0n as bigint,
  sims: [] as Sim[],
  writes: [] as { address?: string; functionName?: string; args?: readonly unknown[] }[],
  /**
   * The wallet's chain and connector. Unset, a mainnet-class write is refused as not connected; a
   * test that sends through the mainnet guard sets Base and a provider that answers its reads.
   */
  chainId: undefined as number | undefined,
  connector: undefined as { getProvider: () => Promise<unknown> } | undefined,
}));

vi.mock("../../src/lib/VaultRegistryContext", () => ({
  useVaultRegistry: () => ({
    vaults: mock.registered,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("wagmi", () => ({
  useReadContracts: () => ({ data: undefined }),
  useAccount: () => ({
    address: USER,
    isConnected: true,
    chainId: mock.chainId,
    connector: mock.connector,
  }),
  useReadContract: (opts: {
    functionName?: string;
    address?: string;
    args?: readonly unknown[];
  }) => {
    switch (opts.functionName) {
      case "balanceOf":
        return { data: opts.address ? 10n ** 30n : undefined, refetch: vi.fn() };
      case "previewRedeem":
        return { data: opts.address ? PREVIEW : undefined, refetch: vi.fn() };
      case "allowance":
        // The router's share allowance; the USDC deposit allowance is 0.
        return {
          data: opts.args?.[1] === ROUTER ? mock.routerAllowance : 0n,
          refetch: vi.fn(),
        };
      default:
        return { data: undefined, refetch: vi.fn() };
    }
  },
  useSimulateContract: (opts: {
    functionName?: string;
    address?: string;
    args?: readonly unknown[];
    query?: { enabled?: boolean };
  }) => {
    const enabled = opts.query?.enabled === true && Boolean(opts.address) && Boolean(opts.args);
    mock.sims.push({
      functionName: opts.functionName,
      address: opts.address,
      args: opts.args,
      enabled,
    });
    if (!enabled) return { data: undefined, error: null };
    return {
      data: {
        request: { address: opts.address, functionName: opts.functionName, args: opts.args },
      },
      error: null,
    };
  },
  useWriteContract: () => ({
    writeContract: (params: {
      address?: string;
      functionName?: string;
      args?: readonly unknown[];
    }) => {
      mock.writes.push(params);
    },
    isPending: false,
    data: undefined,
  }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

function tab(context: VaultPreviewContext = ctx) {
  return (
    <DepositWithdrawTab
      vaultAddress={VAULT}
      usdcAddress={USDC}
      ctx={context}
      routerAddress={ROUTER}
    />
  );
}

/**
 * The context AdminFlow builds when gateway verification is refused because the gateway was
 * upgraded to an implementation this build does not pin (ADR-0014).
 */
const gatewayRefusedCtx: VaultPreviewContext = {
  ...ctx,
  gatewayCodeHashVerified: false,
  gatewayRefusalDetail: describeVerificationCause("implementation-mismatch"),
};

function withdrawForm() {
  return within(screen.getByTestId("withdraw-form"));
}

beforeEach(() => {
  mock.registered = [{ vault: VAULT, name: "rmUSDC", status: 0 }];
  mock.routerAllowance = 0n;
  mock.sims = [];
  mock.writes = [];
  mock.chainId = undefined;
  mock.connector = undefined;
});

describe("Withdraw tab — a registered vault is redeemed through router.redeemFor (QA plan D9)", () => {
  it("approves exactly the shares to the router, then signs redeemFor with the previewRedeem floor", async () => {
    const view = render(tab());
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });

    expect(screen.getByTestId("withdraw-route").getAttribute("data-route")).toBe("router");
    expect(screen.getByTestId("withdraw-route").textContent).toContain("4.96505 USDC");
    expect(withdrawForm().getByTestId("tx-preview-fn").textContent).toBe("redeemFor");
    expect(withdrawForm().getByTestId("tx-preview-target").textContent).toContain(ROUTER);

    // Step 1: the router may not spend the shares yet, so signing waits for the approval.
    expect(screen.getByTestId("withdraw-submit")).toBeDisabled();
    const approve = screen.getByTestId("withdraw-approve");
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]).toMatchObject({ address: VAULT, functionName: "approve" });
    expect(mock.writes[0].args).toEqual([ROUTER, SHARES]);

    // Step 2: the approval landed. The redeem goes to the router, one leg, with the floor.
    mock.routerAllowance = SHARES;
    view.rerender(tab());
    expect(screen.queryByTestId("withdraw-approve")).toBeNull();
    const submit = screen.getByTestId("withdraw-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(mock.writes).toHaveLength(2);
    const redeem = mock.writes[1];
    expect(redeem.address).toBe(ROUTER);
    expect(redeem.functionName).toBe("redeemFor");
    const [holder, recipient, vaults, sharesPerLeg, minAssetsPerLeg, deadline] = redeem.args ?? [];
    expect(holder).toBe(USER);
    expect(recipient).toBe(USER);
    expect(vaults).toEqual([VAULT]);
    expect(sharesPerLeg).toEqual([SHARES]);
    expect(minAssetsPerLeg).toEqual([FLOOR]);
    expect(typeof deadline).toBe("bigint");

    // The direct vault.redeem, which has no min-out, was never simulated or sent.
    expect(mock.sims.some((s) => s.functionName === "redeem" && s.enabled)).toBe(false);
    expect(mock.writes.some((w) => w.functionName === "redeem")).toBe(false);
  });

  it("does not simulate redeemFor before the router may spend the shares", () => {
    render(tab());
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });
    expect(mock.sims.some((s) => s.functionName === "redeemFor" && s.enabled)).toBe(false);
  });

  it("shows an allowance the redeem will not spend, and revokes it to zero", async () => {
    mock.routerAllowance = SHARES * 10n;
    render(tab());
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });

    expect(screen.getByTestId("withdraw-router-allowance-leftover")).toBeInTheDocument();
    const revoke = screen.getByTestId("withdraw-revoke");
    await waitFor(() => expect(revoke).toBeEnabled());
    fireEvent.click(revoke);
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0]).toMatchObject({ address: VAULT, functionName: "approve" });
    expect(mock.writes[0].args).toEqual([ROUTER, 0n]);
  });

  it("redeems a vault the registry does not list directly, and says it has no floor", async () => {
    mock.registered = [];
    render(tab());
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });

    const route = screen.getByTestId("withdraw-route");
    expect(route.getAttribute("data-route")).toBe("direct");
    expect(route.textContent).toContain("no minimum-out floor");
    expect(route.textContent).toContain("VaultRegistry does not list this vault");
    expect(withdrawForm().getByTestId("tx-preview-fn").textContent).toBe("redeem");
    expect(screen.queryByTestId("withdraw-approve")).toBeNull();

    const submit = screen.getByTestId("withdraw-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(mock.writes[0]).toMatchObject({ address: VAULT, functionName: "redeem" });
  });

  // Core 1494: an exit never depends on the gateway. A routine gateway upgrade the build does not pin
  // yet refuses gateway verification; the Withdraw button must stay enabled on both routes.
  it("keeps withdraw-submit enabled on the router route while the gateway verification is refused", async () => {
    mock.routerAllowance = SHARES;
    render(tab(gatewayRefusedCtx));
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });

    expect(screen.getByTestId("withdraw-route").getAttribute("data-route")).toBe("router");
    expect(withdrawForm().getByTestId("tx-preview-fn").textContent).toBe("redeemFor");
    expect(withdrawForm().getByTestId("tx-preview-codehash").textContent).toBe(
      "[bytecode UNVERIFIED]",
    );
    expect(withdrawForm().getByTestId("tx-preview-warning").textContent).toContain(
      describeVerificationCause("implementation-mismatch"),
    );
    const submit = screen.getByTestId("withdraw-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(mock.writes[0]).toMatchObject({ address: ROUTER, functionName: "redeemFor" });
  });

  it("keeps withdraw-submit enabled on the direct route for an unregistered runtime-config vault while the gateway verification is refused", async () => {
    mock.registered = [];
    render(tab(gatewayRefusedCtx));
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });

    expect(screen.getByTestId("withdraw-route").getAttribute("data-route")).toBe("direct");
    expect(withdrawForm().getByTestId("tx-preview-fn").textContent).toBe("redeem");
    expect(withdrawForm().getByTestId("tx-preview-warning").textContent).toContain(
      describeVerificationCause("implementation-mismatch"),
    );
    const submit = screen.getByTestId("withdraw-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(mock.writes[0]).toMatchObject({ address: VAULT, functionName: "redeem" });
  });

  // ADR-0014: a router whose implementation the build does not pin is refused by the write guard, so
  // the tab must not offer it a share approval: the exit goes straight to the vault.
  it("redeems directly on a mainnet build when the chain showed the router does not match its pins", () => {
    render(
      <RuntimeConfigProvider
        config={{
          VITE_ENV_CLASS: "mainnet",
          VITE_ROUTER_ADDRESS: ROUTER,
          [ROUTER_CODE_HASH_PIN_KEY]: `0x${"ab".repeat(32)}`,
        }}
      >
        {tab({ ...ctx, refusedTargets: new Set([ROUTER.toLowerCase()]) })}
      </RuntimeConfigProvider>,
    );
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });
    const route = screen.getByTestId("withdraw-route");
    expect(route.getAttribute("data-route")).toBe("direct");
    expect(route.textContent).toContain("implementation behind it does not match");
    expect(screen.queryByTestId("withdraw-approve")).toBeNull();
  });

  // Security round 2: a holder approved the router and the redeem never landed. The timelock then
  // upgraded the router to logic this build does not pin, so the tab redeems directly. That router
  // can still `transferFrom` the shares through the standing allowance, so the tab must keep
  // showing it and revoke it. An approve of zero needs no pin, so the revoke passes the guard.
  it("shows and revokes the share allowance to a router that failed its pins, on the direct route, through the guard", async () => {
    mock.routerAllowance = SHARES;
    mock.chainId = 8453;
    const walletCalls: string[] = [];
    mock.connector = {
      getProvider: async () => ({
        request: async ({ method }: { method: string }) => {
          walletCalls.push(method);
          if (method === "eth_getCode") return "0x6001";
          if (method === "eth_blockNumber") return "0x10";
          if (method === "eth_getStorageAt") return `0x${"0".repeat(64)}`;
          throw new Error(`unexpected wallet call ${method}`);
        },
      }),
    };
    render(
      <RuntimeConfigProvider
        config={{
          VITE_ENV_CLASS: "mainnet",
          VITE_ROUTER_ADDRESS: ROUTER,
          [ROUTER_CODE_HASH_PIN_KEY]: `0x${"ab".repeat(32)}`,
        }}
      >
        {tab({ ...ctx, refusedTargets: new Set([ROUTER.toLowerCase()]) })}
      </RuntimeConfigProvider>,
    );
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "5" } });

    const route = screen.getByTestId("withdraw-route");
    expect(route.getAttribute("data-route")).toBe("direct");
    // The allowance equals the shares entered, yet the direct redeem spends none of it.
    const leftover = screen.getByTestId("withdraw-router-allowance-leftover");
    expect(leftover).toHaveTextContent("failed verification");
    expect(leftover).toHaveTextContent("calls the vault directly and will not spend it");
    // No approval to, and no redeem through, the refused router.
    expect(screen.queryByTestId("withdraw-approve")).toBeNull();
    expect(mock.sims.some((s) => s.functionName === "redeemFor" && s.enabled)).toBe(false);

    const revoke = screen.getByTestId("withdraw-revoke");
    await waitFor(() => expect(revoke).toBeEnabled());
    fireEvent.click(revoke);
    await waitFor(() => expect(mock.writes).toHaveLength(1));
    // The guard ran (it read the share token's code through the wallet) and pinned the write to
    // Base.
    expect(walletCalls).toContain("eth_getCode");
    expect(mock.writes[0]).toMatchObject({
      address: VAULT,
      functionName: "approve",
      chainId: 8453,
    });
    expect(mock.writes[0].args).toEqual([ROUTER, 0n]);
  });

  it("redeems directly on a mainnet build with no router pin, because the guard would refuse the approval", () => {
    render(
      <RuntimeConfigProvider config={{ VITE_ENV_CLASS: "mainnet" }}>{tab()}</RuntimeConfigProvider>,
    );
    const route = screen.getByTestId("withdraw-route");
    expect(route.getAttribute("data-route")).toBe("direct");
    expect(route.textContent).toContain("no code-hash pin for the router");
  });
});

describe("routerRedeem helpers (QA plan D9)", () => {
  const inputs = {
    vault: VAULT,
    shares: SHARES,
    minAssets: FLOOR,
    holder: USER,
    deadline: 1_700_000_000n,
  };

  it("the floor is previewRedeem less 0.50%, rounded down", () => {
    expect(deriveMinAssets(PREVIEW)).toBe(FLOOR);
    expect(deriveMinAssets(1_000_000n)).toBe(995_000n);
    expect(deriveMinAssets(0n)).toBe(0n);
    expect(deriveMinAssets(1_000_000n, 0n)).toBe(1_000_000n);
  });

  it("the preview encodes exactly the call the tab signs: one leg, the holder twice, the floor", () => {
    const call = routerRedeemCall(inputs);
    expect(call.functionName).toBe("redeemFor");
    expect(call.args).toEqual([USER, USER, [VAULT], [SHARES], [FLOOR], 1_700_000_000n]);

    const preview = buildRouterRedeemPreview(inputs, { ...ctx, router: ROUTER });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.target).toBe(ROUTER);
    expect(preview.functionName).toBe("redeemFor");
    const decoded = decodeFunctionData({ abi: routerAbi, data: preview.calldata });
    expect(decoded.functionName).toBe("redeemFor");
    expect(decoded.args).toEqual(call.args);
    expect(preview.args.find((a) => a.name === "minAssetsPerLeg")?.raw).toBe(`[${FLOOR}]`);
  });

  // Core 1494: an exit never depends on the gateway. `redeemFor` never calls it, so an unverified
  // gateway (an upgrade the build does not pin yet) leaves the redeem built, UNVERIFIED and warned.
  it("builds the preview when the gateway is unverified, UNVERIFIED and with the cause as a warning", () => {
    const preview = buildRouterRedeemPreview(inputs, {
      ...ctx,
      gatewayCodeHashVerified: false,
      gatewayRefusalDetail: describeVerificationCause("implementation-mismatch"),
      router: ROUTER,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.targetCodeHashKnown).toBe(false);
    expect(preview.warning).toContain(describeVerificationCause("implementation-mismatch"));
  });

  it("routes through the router only where the router can take the exit", () => {
    const base = {
      router: ROUTER,
      vault: VAULT,
      registered: [{ vault: VAULT }],
      registryLoading: false,
      routerUnpinned: false,
    };
    expect(chooseRedeemRoute(base)).toEqual({ kind: "router", router: ROUTER });
    expect(
      chooseRedeemRoute({ ...base, registered: [{ vault: VAULT.toLowerCase() as Address }] }),
    ).toEqual({
      kind: "router",
      router: ROUTER,
    });
    expect(chooseRedeemRoute({ ...base, router: undefined })).toEqual({
      kind: "direct",
      reason: "no-router",
    });
    expect(
      chooseRedeemRoute({ ...base, router: "0x0000000000000000000000000000000000000000" }),
    ).toEqual({ kind: "direct", reason: "no-router" });
    expect(chooseRedeemRoute({ ...base, routerUnpinned: true })).toEqual({
      kind: "direct",
      reason: "router-unpinned",
    });
    expect(chooseRedeemRoute({ ...base, routerUnverified: true })).toEqual({
      kind: "direct",
      reason: "router-unverified",
    });
    expect(chooseRedeemRoute({ ...base, registered: [] })).toEqual({
      kind: "direct",
      reason: "unregistered",
    });
    // Nothing is signed while the registry is still loading.
    expect(chooseRedeemRoute({ ...base, registered: [], registryLoading: true })).toEqual({
      kind: "pending",
    });
  });

  it("the deadline is 25 to 30 minutes ahead and stable within a 5-minute step", () => {
    const now = 1_700_000_123_456;
    const nowSecs = BigInt(Math.floor(now / 1000));
    const d = routerRedeemDeadline(now);
    expect(d - nowSecs).toBeGreaterThan(ROUTER_REDEEM_DEADLINE_SECS - 300n);
    expect(d - nowSecs).toBeLessThanOrEqual(ROUTER_REDEEM_DEADLINE_SECS);
    expect(routerRedeemDeadline(now + 1_000)).toBe(d);
  });

  it("says why a leftover router allowance is shown, by route", () => {
    expect(leftoverRouterAllowanceText({ kind: "router", router: ROUTER }, "5 rmUSDC")).toContain(
      "will not spend. Revoke it unless you redeem that much now",
    );
    const unverified = leftoverRouterAllowanceText(
      { kind: "direct", reason: "router-unverified" },
      "5 rmUSDC",
    );
    expect(unverified).toContain("failed verification");
    expect(unverified).toContain("5 rmUSDC");
    expect(
      leftoverRouterAllowanceText({ kind: "direct", reason: "unregistered" }, "5 rmUSDC"),
    ).toContain("calls the vault directly and will not spend it");
  });

  it("asks for an approval until the allowance covers the shares, and flags an allowance left over", () => {
    expect(needsShareApproval(undefined, 5n)).toBe(true);
    expect(needsShareApproval(4n, 5n)).toBe(true);
    expect(needsShareApproval(5n, 5n)).toBe(false);
    expect(leftoverRouterAllowance(0n, 5n)).toBe(false);
    expect(leftoverRouterAllowance(5n, 5n)).toBe(false);
    expect(leftoverRouterAllowance(6n, 5n)).toBe(true);
    expect(leftoverRouterAllowance(1n, null)).toBe(true);
    expect(leftoverRouterAllowance(undefined, null)).toBe(false);
  });

  it("gives a one-leg rmUSDC redeemFor the fixed redeem gas, and leaves a basket leg to the wallet", () => {
    const rmUsdc: ReadonlySet<string> = new Set([VAULT.toLowerCase()]);
    const oneLeg = (vault: Address) => ({
      address: ROUTER,
      functionName: "redeemFor",
      args: [USER, USER, [vault], [1n], [0n], 1n],
    });
    expect(withRedeemGasWorkaround(oneLeg(VAULT), rmUsdc)).toEqual({
      ...oneLeg(VAULT),
      gas: 2_500_000n,
    });
    const basket = oneLeg(BASKET);
    expect(withRedeemGasWorkaround(basket, rmUsdc)).toBe(basket);
    const twoLegs = {
      address: ROUTER,
      functionName: "redeemFor",
      args: [USER, USER, [VAULT, BASKET], [1n, 1n], [0n, 0n], 1n],
    };
    expect(withRedeemGasWorkaround(twoLegs, rmUsdc)).toBe(twoLegs);
  });
});
