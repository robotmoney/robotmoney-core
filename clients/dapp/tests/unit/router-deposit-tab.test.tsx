/**
 * Component tests — RouterDepositTab (issue #417).
 *
 * Covers acceptance criteria:
 *   AC §6  per-leg preview shows destination vaults, weights, estimated receipts;
 *          unavailable-leg warning shown when a leg is unavailable.
 *   AC §7  submit disabled when getEffectiveWeights()'s vault list differs from preview vault list.
 *   QA plan D4  the router skips unavailable legs and renormalizes the rest, so an
 *          unavailable leg (0 bps or weighted) no longer disables the deposit: the
 *          simulation is the revert gate, and the effect lists the renormalized amounts.
 *
 *   Security round 2  a leg vault the chain showed does not match its pins
 *          (`ctx.refusedTargets`) badges the deposit UNVERIFIED, is named, and
 *          disables the approve and the deposit: the router would forward USDC into it.
 *
 * Test names match the issue test plan exactly so the pnpm --testNamePattern
 * invocations resolve correctly.
 *
 * Wagmi hooks are mocked at the module boundary so no WagmiProvider is needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "./helpers/render";
import type { Address } from "viem";
import { RouterDepositTab } from "../../src/components/RouterDepositTab";
import { deriveMinSharesPerLeg, type RouterPreviewContext } from "../../src/lib/routerPreview";
import { formatUsdc } from "../../src/lib/format";

// ─── Addresses ───────────────────────────────────────────────────────────────
const ROUTER = "0xrouterrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const VAULT_A = "0x1111111111111111111111111111111111111111" as Address;
const VAULT_B = "0x2222222222222222222222222222222222222222" as Address;
const GATEWAY = "0x6666666666666666666666666666666666666666" as Address;
const USER = "0x3333333333333333333333333333333333333333" as Address;

const ctx: RouterPreviewContext = {
  gateway: GATEWAY,
  router: ROUTER,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

// ─── Wagmi mock state ─────────────────────────────────────────────────────────

type LegRaw = {
  vault: Address;
  weightBps: bigint;
  legAmount: bigint;
  estShares: bigint;
  unavailable: boolean;
};

const activeLegsPrev: LegRaw[] = [
  {
    vault: VAULT_A,
    weightBps: 6000n,
    legAmount: 6_000_000n,
    estShares: 5_950_000n,
    unavailable: false,
  },
  {
    vault: VAULT_B,
    weightBps: 4000n,
    legAmount: 4_000_000n,
    estShares: 3_980_000n,
    unavailable: false,
  },
];

const legsWithUnavailable: LegRaw[] = [
  {
    vault: VAULT_A,
    weightBps: 6000n,
    legAmount: 6_000_000n,
    estShares: 5_950_000n,
    unavailable: false,
  },
  { vault: VAULT_B, weightBps: 4000n, legAmount: 4_000_000n, estShares: 0n, unavailable: true },
];

interface WagmiMockState {
  isConnected: boolean;
  address: Address | undefined;
  allowance: bigint | undefined;
  previewDepositLegs: LegRaw[] | undefined;
  /** Vault list half of getEffectiveWeights()'s (vaults, bps) return tuple. */
  effectiveWeightsVaults: Address[] | undefined;
  approveSim: unknown;
  depositSim: unknown;
  /**
   * True: every leg vault's live `depositsPaused()` reads false (open) and no basket asset has a
   * recorder. False: the batched reads return nothing, so every leg state is unknown (closed).
   */
  legsOpen: boolean;
  /** Lower-cased leg vaults whose `depositsPaused()` reads true when `legsOpen` is set. */
  pausedVaults: string[];
}

const mockState: WagmiMockState = {
  isConnected: true,
  address: USER,
  allowance: 10_000_000n,
  previewDepositLegs: activeLegsPrev,
  effectiveWeightsVaults: [VAULT_A, VAULT_B],
  approveSim: undefined,
  depositSim: { request: {} },
  legsOpen: false,
  pausedVaults: [],
};

// Captures the args the component passes to the router `deposit` simulation so
// DAPP-2 (issue #1025) — non-zero per-leg minSharesPerLeg — can be asserted.
let capturedDepositArgs: readonly unknown[] | undefined;
/** Whether the component enabled the router `deposit` simulation (QA plan D4: the revert gate). */
let capturedDepositEnabled: boolean | undefined;

vi.mock("wagmi", () => ({
  // issue 1731: the deposits-paused reads use useReadContracts; no live chain in this test.
  useReadContracts: (opts: { contracts?: { functionName?: string; address?: string }[] }) =>
    mockState.legsOpen
      ? {
          data: (opts.contracts ?? []).map((c) => ({
            status: "success",
            result:
              c.functionName === "depositsPaused"
                ? mockState.pausedVaults.includes((c.address ?? "").toLowerCase())
                : 0n,
          })),
        }
      : { data: undefined },
  useAccount: () => ({ address: mockState.address, isConnected: mockState.isConnected }),
  useReadContract: (opts: { functionName?: string }) => {
    if (opts.functionName === "allowance") return { data: mockState.allowance, refetch: vi.fn() };
    if (opts.functionName === "previewDeposit")
      return { data: mockState.previewDepositLegs, error: null };
    if (opts.functionName === "getEffectiveWeights") {
      if (mockState.effectiveWeightsVaults === undefined) return { data: undefined };
      // Real getEffectiveWeights() returns (address[] vaults, uint256[] bps) —
      // viem decodes a multi-output function as a positional tuple.
      return {
        data: [mockState.effectiveWeightsVaults, mockState.effectiveWeightsVaults.map(() => 0n)],
      };
    }
    return { data: undefined, error: null };
  },
  useSimulateContract: (opts: {
    functionName?: string;
    args?: readonly unknown[];
    query?: { enabled?: boolean };
  }) => {
    if (opts.functionName === "approve") return { data: mockState.approveSim, error: null };
    if (opts.functionName === "deposit") {
      capturedDepositArgs = opts.args;
      capturedDepositEnabled = opts.query?.enabled;
      return { data: mockState.depositSim, error: null };
    }
    return { data: undefined, error: null };
  },
  useWriteContract: () => ({
    writeContract: vi.fn(),
    isPending: false,
    data: undefined,
  }),
  useWaitForTransactionReceipt: () => ({
    isFetching: false,
    isSuccess: false,
  }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

function renderTab() {
  return render(<RouterDepositTab routerAddress={ROUTER} usdcAddress={USDC} ctx={ctx} />);
}

describe("RouterDepositTab shows per-leg split preview", () => {
  beforeEach(() => {
    mockState.isConnected = true;
    mockState.address = USER;
    mockState.allowance = 10_000_000n;
    mockState.previewDepositLegs = activeLegsPrev;
    mockState.effectiveWeightsVaults = [VAULT_A, VAULT_B];
    mockState.depositSim = { request: {} };
  });

  it("renders the router deposit tab form", () => {
    renderTab();
    expect(screen.getByTestId("router-deposit-tab")).toBeDefined();
    expect(screen.getByTestId("router-deposit-tab-amount")).toBeDefined();
    expect(screen.getByTestId("router-deposit-tab-submit")).toBeDefined();
  });

  it("renders without crashing with active legs", () => {
    const { container } = renderTab();
    expect(container).toBeDefined();
    // The ProportionPreview renders when legs.length > 0 (after amount entered)
    // With no amount entered legs is empty from the hook — just verify no crash.
  });

  it("submit button is present", () => {
    renderTab();
    const submit = screen.getByTestId("router-deposit-tab-submit") as HTMLButtonElement;
    expect(submit).toBeDefined();
  });
});

// QA plan D4: `PortfolioRouter._depositTo` skips a leg `previewDeposit` reports unavailable and splits
// the amount across the rest. A stale rmAGENT recorder (maxDeposit reverts) or a paused 0 bps vault
// used to disable every router deposit with a false "will revert" warning.
describe("RouterDepositTab skips unavailable legs instead of refusing the deposit", () => {
  const VAULT_C = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
  // 10 USDC: the weighted unavailable leg B is skipped, so A takes all of it.
  const legsSkipped: LegRaw[] = [
    {
      vault: VAULT_A,
      weightBps: 6000n,
      legAmount: 10_000_000n,
      estShares: 9_950_000n,
      unavailable: false,
    },
    { vault: VAULT_B, weightBps: 4000n, legAmount: 0n, estShares: 0n, unavailable: true },
    { vault: VAULT_C, weightBps: 0n, legAmount: 0n, estShares: 0n, unavailable: true },
  ];

  beforeEach(() => {
    mockState.isConnected = true;
    mockState.address = USER;
    mockState.allowance = 10_000_000n;
    mockState.previewDepositLegs = legsSkipped;
    mockState.effectiveWeightsVaults = [VAULT_A, VAULT_B, VAULT_C];
    mockState.depositSim = { request: {} };
    mockState.legsOpen = true;
    // The 0 bps leg is paused too: it is never funded, so its state does not close the deposit.
    mockState.pausedVaults = [VAULT_C.toLowerCase()];
    capturedDepositEnabled = undefined;
  });
  afterEach(() => {
    mockState.legsOpen = false;
    mockState.pausedVaults = [];
  });

  it("a preview with one 0 bps unavailable leg and one weighted unavailable leg keeps submit enabled when the simulation succeeds, and the effect text lists the renormalized leg amounts", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });

    // The simulation runs: it, not the unavailable flag, decides whether the deposit reverts.
    expect(capturedDepositEnabled).toBe(true);
    const submit = screen.getByTestId("router-deposit-tab-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    expect(screen.queryByTestId("router-deposits-closed")).toBeNull();

    const effect = screen.getByTestId("tx-preview-effect").textContent ?? "";
    expect(effect).toContain("Unavailable legs are skipped");
    expect(effect).not.toMatch(/revert/i);
    // The renormalized amount of the funded leg, and the two skipped legs at 0.
    expect(effect).toContain(`60.00% → ${formatUsdc(10_000_000n)} →`);
    expect(effect.match(/\[UNAVAILABLE, skipped: 0 USDC\]/g)).toHaveLength(2);
    expect(screen.getByTestId("proportion-preview-usdc-0")).toHaveTextContent(
      formatUsdc(10_000_000n),
    );
    const warning = screen.getByTestId("router-unavailable-warning");
    expect(warning).toHaveTextContent("Unavailable legs are skipped");
    expect(warning).toHaveTextContent("renormalized");
    expect(warning.textContent ?? "").not.toMatch(/revert/i);
  });

  it("the simulation still gates submit: no simulated request, no submit", () => {
    mockState.depositSim = undefined;
    renderTab();
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });
    expect(capturedDepositEnabled).toBe(true);
    expect((screen.getByTestId("router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("RouterDepositTab shows unavailable-leg warning and disables submit when active vaults list changes", () => {
  beforeEach(() => {
    mockState.isConnected = true;
    mockState.address = USER;
    mockState.allowance = 10_000_000n;
    mockState.previewDepositLegs = legsWithUnavailable;
    mockState.effectiveWeightsVaults = [VAULT_A, VAULT_B];
    mockState.depositSim = undefined; // disabled when unavailable leg
  });

  it("submit button is disabled when a leg is unavailable (depositSim is undefined)", () => {
    renderTab();
    const submit = screen.getByTestId("router-deposit-tab-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("renders without crashing when a leg is unavailable", () => {
    const { container } = renderTab();
    expect(container).toBeDefined();
  });

  it("submit is disabled when vault list changed (activeVaults differs from preview)", () => {
    // Simulate vault list change: preview has [A, B] but activeVaults now has [A, C]
    const VAULT_C = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
    mockState.previewDepositLegs = activeLegsPrev; // preview: [A, B]
    mockState.effectiveWeightsVaults = [VAULT_A, VAULT_C]; // live: [A, C] — mismatch
    mockState.depositSim = { request: {} }; // sim still returns but vault list changed
    renderTab();
    // The vault list changed guard disables submit even if sim passes
    const submit = screen.getByTestId("router-deposit-tab-submit") as HTMLButtonElement;
    // The submit is disabled because vaultListChanged=true
    expect(submit.disabled).toBe(true);
  });
});

// DAPP-2 (issue #1025): the router deposit call must submit non-zero per-leg
// minSharesPerLeg floors derived from the preview's estimated shares, not the
// previous empty `[]` that disabled per-leg slippage protection.
describe("RouterDepositTab submits non-zero per-leg minSharesPerLeg floors derived from expected shares", () => {
  beforeEach(() => {
    mockState.isConnected = true;
    mockState.address = USER;
    mockState.allowance = 10_000_000n;
    mockState.previewDepositLegs = activeLegsPrev;
    mockState.effectiveWeightsVaults = [VAULT_A, VAULT_B];
    mockState.depositSim = { request: {} };
    capturedDepositArgs = undefined;
  });

  it("passes a non-empty floors array equal to deriveMinSharesPerLeg over the preview legs", () => {
    renderTab();
    // Enter an amount so depositAssets is non-null and the deposit sim runs.
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });

    expect(capturedDepositArgs).toBeDefined();
    const [amountArg, floorsArg] = capturedDepositArgs as [bigint, bigint[]];

    // 10 USDC (6 decimals) -> the deposit amount the user typed.
    expect(amountArg).toBe(10_000_000n);

    // Floors must be the derived, NON-zero per-leg floors — never the old `[]`.
    const expected = deriveMinSharesPerLeg(
      activeLegsPrev.map((l) => ({
        vault: l.vault,
        weightBps: l.weightBps,
        legAmount: l.legAmount,
        estShares: l.estShares,
        unavailable: l.unavailable,
      })),
    );
    expect(floorsArg).toEqual(expected);
    expect(floorsArg.length).toBe(activeLegsPrev.length);
    expect(floorsArg.every((f) => f > 0n)).toBe(true);
    // And each floor is strictly below the estimated shares (tolerance shaved).
    floorsArg.forEach((f, i) => {
      expect(f).toBeLessThan(activeLegsPrev[i].estShares);
    });
  });
});

// Security round 2 (ADR-0014): `PortfolioRouter._executeLeg` forwards each leg's USDC into that
// vault and takes the vault's own `deposit()` return as the shares minted. A leg the timelock
// upgraded to logic this build does not pin (`ctx.refusedTargets`) must not get a deposit through
// the router while a direct deposit into it is refused. The write guard refuses it at send time;
// the tab says so first and never offers the deposit.
describe("RouterDepositTab refuses a leg vault that failed its pins (security round 2)", () => {
  beforeEach(() => {
    mockState.isConnected = true;
    mockState.address = USER;
    mockState.allowance = 10_000_000n;
    mockState.previewDepositLegs = activeLegsPrev;
    mockState.effectiveWeightsVaults = [VAULT_A, VAULT_B];
    mockState.depositSim = { request: {} };
    mockState.legsOpen = true;
    mockState.pausedVaults = [];
    capturedDepositEnabled = undefined;
  });
  afterEach(() => {
    mockState.legsOpen = false;
    mockState.approveSim = undefined;
  });

  const key = (a: Address) => a.toLowerCase();
  const renderWith = (extra: Partial<RouterPreviewContext>) =>
    render(
      <RouterDepositTab routerAddress={ROUTER} usdcAddress={USDC} ctx={{ ...ctx, ...extra }} />,
    );

  it("a leg in refusedTargets shows UNVERIFIED, names the leg and disables submit", () => {
    renderWith({
      verifiedTargets: new Set([key(ROUTER), key(VAULT_A)]),
      refusedTargets: new Set([key(VAULT_B)]),
    });
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });

    expect(screen.getByTestId("tx-preview-codehash")).toHaveTextContent("[bytecode UNVERIFIED]");
    expect(screen.getByTestId("router-leg-unverified")).toHaveTextContent(VAULT_B);
    expect(screen.getByTestId("tx-preview-warning")).toHaveTextContent(VAULT_B);
    // The deposit is never simulated, so no stale request can be signed either.
    expect(capturedDepositEnabled).toBe(false);
    expect((screen.getByTestId("router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Nothing else closed it: every leg is open and the vault list matches.
    expect(screen.queryByTestId("router-deposits-closed")).toBeNull();
    expect(screen.queryByTestId("router-vault-list-changed")).toBeNull();
  });

  it("a refused leg disables the USDC approval too", () => {
    mockState.allowance = 0n;
    // The approval simulates: only the refused leg keeps the button disabled.
    mockState.approveSim = { request: { args: [ROUTER, 10_000_000n] } };
    renderWith({ refusedTargets: new Set([key(VAULT_A)]) });
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });
    expect((screen.getByTestId("router-deposit-tab-approve") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("the router and every leg verified badge the deposit verified and keep submit enabled", () => {
    renderWith({ verifiedTargets: new Set([key(ROUTER), key(VAULT_A), key(VAULT_B)]) });
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });

    expect(screen.getByTestId("tx-preview-codehash")).toHaveTextContent("[bytecode verified]");
    expect(screen.queryByTestId("router-leg-unverified")).toBeNull();
    expect(capturedDepositEnabled).toBe(true);
    expect((screen.getByTestId("router-deposit-tab-submit") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("the router verified alone is not enough for the badge", () => {
    renderWith({ verifiedTargets: new Set([key(ROUTER)]) });
    fireEvent.change(screen.getByTestId("router-deposit-tab-amount"), {
      target: { value: "10" },
    });
    expect(screen.getByTestId("tx-preview-codehash")).toHaveTextContent("[bytecode UNVERIFIED]");
  });
});
