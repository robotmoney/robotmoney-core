/**
 * Unit tests — the Withdraw tab redeems only against a registered vault
 * (QA plan U4, finding DR-5, issue #1737 part 2).
 *
 * The PositionSelector rows come from the explorer API. Before U4 a selected
 * row's vault address went straight into the share-balance read, the redeem
 * simulation, the preview and the write, and the preview badged it
 * "[bytecode verified]" because only the gateway hash was checked. A poisoned
 * explorer row could therefore have the user sign a redeem on an attacker
 * contract shown as LOW risk and verified (docs/technical/dapp-topology.md §4
 * forbids indexer input to a signing decision).
 *
 * Now a target is accepted only when it is the runtime-config vault or a vault
 * `useVaultRegistry()` lists, and a vault target without its own code-hash pin
 * is badged "[bytecode UNVERIFIED]".
 *
 * The registry context and wagmi are mocked at the module boundary; every
 * read and simulation records the address it was asked about.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "./helpers/render";
import type { Address } from "viem";
import { DepositWithdrawTab } from "../../src/components/DepositWithdrawTab";
import { TxPreview } from "../../src/components/TxPreview";
import { buildVaultPreview, type VaultPreviewContext } from "../../src/lib/vaultPreview";
import { acceptedRedeemTarget, redeemTargetAllowlist } from "../../src/lib/redeemTarget";

const VAULT_A = "0x1111111111111111111111111111111111111111" as Address; // runtime-config vault
const VAULT_B = "0x2222222222222222222222222222222222222222" as Address; // registered vault
const ATTACKER = "0x9999999999999999999999999999999999999999" as Address; // explorer-only row
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const USER = "0x3333333333333333333333333333333333333333" as Address;
const API_URL = "http://localhost:8080";
const SHARES = "5000000000000000000000000"; // 5 shares at 24 decimals

const ctx: VaultPreviewContext = {
  gateway: "0x7777777777777777777777777777777777777777",
  vault: VAULT_A,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const mock = vi.hoisted(() => ({
  registered: [] as { vault: `0x${string}`; name: string; status: number }[],
  /** Every address a vault read or a redeem simulation was asked about. */
  touched: [] as string[],
  writes: [] as { address?: string; functionName?: string }[],
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
  // The deposits-paused and share-symbol reads use useReadContracts; no live chain here.
  useReadContracts: () => ({ data: undefined }),
  useAccount: () => ({ address: USER, isConnected: true }),
  useReadContract: (opts: { functionName?: string; address?: string }) => {
    if (opts.functionName === "balanceOf" || opts.functionName === "previewRedeem") {
      if (opts.address) mock.touched.push(opts.address.toLowerCase());
    }
    if (opts.functionName === "balanceOf") {
      return { data: opts.address ? 10n ** 30n : undefined, refetch: vi.fn() };
    }
    if (opts.functionName === "previewRedeem") {
      return { data: opts.address ? 4_990_000n : undefined, refetch: vi.fn() };
    }
    if (opts.functionName === "allowance") return { data: 0n, refetch: vi.fn() };
    return { data: undefined, refetch: vi.fn() };
  },
  useSimulateContract: (opts: {
    functionName?: string;
    address?: string;
    args?: readonly unknown[];
    query?: { enabled?: boolean };
  }) => {
    if (opts.functionName !== "redeem") return { data: undefined, error: null };
    if (opts.address) mock.touched.push(opts.address.toLowerCase());
    if (!opts.address || opts.query?.enabled !== true) return { data: undefined, error: null };
    return {
      data: { request: { address: opts.address, functionName: "redeem", args: opts.args } },
      error: null,
    };
  },
  useWriteContract: () => ({
    writeContract: (params: { address?: string; functionName?: string }) => {
      mock.writes.push(params);
    },
    isPending: false,
    data: undefined,
  }),
  useWaitForTransactionReceipt: () => ({ isFetching: false, isSuccess: false }),
}));

function stubPositions(vaults: readonly string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ positions: vaults.map((vault) => ({ vault, shares: SHARES })) }),
      }),
    ),
  );
}

function renderTab({ withExplorer }: { withExplorer: boolean }) {
  return render(
    <DepositWithdrawTab
      vaultAddress={VAULT_A}
      usdcAddress={USDC}
      ctx={ctx}
      explorerApiUrl={withExplorer ? API_URL : undefined}
    />,
  );
}

async function selectPosition(vault: string) {
  await waitFor(() => expect(screen.getByTestId("position-selector")).toBeInTheDocument());
  const option = screen.getByTestId(`position-option-${vault}`);
  fireEvent.click(option.querySelector("input") as HTMLInputElement);
}

function withdrawForm() {
  return within(screen.getByTestId("withdraw-form"));
}

beforeEach(() => {
  mock.registered = [
    { vault: VAULT_A, name: "rmUSDC", status: 0 },
    // A retired vault stays redeemable (ADR-0009): status never gates the allowlist.
    { vault: VAULT_B, name: "rmPROTO", status: 2 },
  ];
  mock.touched = [];
  mock.writes = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Withdraw tab — redeem target must be registered (QA plan U4)", () => {
  it("refuses an explorer position whose vault the registry does not list", async () => {
    stubPositions([ATTACKER, VAULT_B]);
    renderTab({ withExplorer: true });
    await selectPosition(ATTACKER);

    await waitFor(() =>
      expect(screen.getByTestId("withdraw-target-unregistered").textContent).toContain(ATTACKER),
    );
    // No preview, no enabled signing button, and no write against the explorer address.
    expect(withdrawForm().queryByTestId("tx-preview")).toBeNull();
    const submit = screen.getByTestId("withdraw-submit");
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mock.writes).toHaveLength(0);
    // No balance read, previewRedeem or redeem simulation was ever made against it.
    expect(mock.touched).not.toContain(ATTACKER.toLowerCase());
  });

  it("accepts a registered vault named by an explorer row, in any letter case", async () => {
    // The explorer serves lowercase; the registry returns checksummed addresses.
    stubPositions([ATTACKER, VAULT_B.toLowerCase()]);
    renderTab({ withExplorer: true });
    await selectPosition(VAULT_B.toLowerCase());

    await waitFor(() =>
      expect(withdrawForm().getByTestId("tx-preview-fn").textContent).toBe("redeem"),
    );
    expect(screen.queryByTestId("withdraw-target-unregistered")).toBeNull();
    expect(withdrawForm().getByTestId("tx-preview-target").textContent?.toLowerCase()).toContain(
      VAULT_B.toLowerCase(),
    );
    const submit = screen.getByTestId("withdraw-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0].functionName).toBe("redeem");
    expect(mock.writes[0].address?.toLowerCase()).toBe(VAULT_B.toLowerCase());
  });

  it("accepts the runtime-config vault when no registry is mounted", async () => {
    mock.registered = [];
    renderTab({ withExplorer: false });
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "1" } });

    await waitFor(() =>
      expect(withdrawForm().getByTestId("tx-preview-target").textContent).toContain(VAULT_A),
    );
    const submit = screen.getByTestId("withdraw-submit");
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(mock.writes[0]?.address).toBe(VAULT_A);
  });

  it("labels a vault target without its own pin UNVERIFIED although the gateway hash matched", async () => {
    mock.registered = [];
    renderTab({ withExplorer: false });
    fireEvent.change(screen.getByTestId("withdraw-amount"), { target: { value: "1" } });

    await waitFor(() =>
      expect(withdrawForm().getByTestId("tx-preview-codehash").textContent).toBe(
        "[bytecode UNVERIFIED]",
      ),
    );
  });
});

describe("Vault preview target badge comes from the vault's own pin (QA plan U4)", () => {
  const action = { kind: "vaultRedeem", shares: 1n, receiver: USER, owner: USER } as const;

  it("is UNVERIFIED with only the gateway hash verified", () => {
    const preview = buildVaultPreview(action, ctx);
    expect(preview.ok).toBe(true);
    expect(preview.ok && preview.targetCodeHashKnown).toBe(false);
  });

  it("is verified only for a vault in verifiedTargets", () => {
    const pinned = buildVaultPreview(action, {
      ...ctx,
      verifiedTargets: new Set([VAULT_A.toLowerCase()]),
    });
    render(<TxPreview preview={pinned} />);
    expect(screen.getByTestId("tx-preview-codehash").textContent).toBe("[bytecode verified]");

    // The same context spread onto another vault does not carry the pin over.
    const other = buildVaultPreview(action, {
      ...ctx,
      vault: VAULT_B,
      verifiedTargets: new Set([VAULT_A.toLowerCase()]),
    });
    expect(other.ok).toBe(true);
    expect(other.ok && other.targetCodeHashKnown).toBe(false);
  });
});

describe("redeemTarget helpers", () => {
  it("accept the config vault and registered vaults, case-insensitively, and nothing else", () => {
    const allow = redeemTargetAllowlist([{ vault: VAULT_B }], VAULT_A);
    expect(acceptedRedeemTarget(VAULT_A, allow)).toBe(VAULT_A);
    expect(acceptedRedeemTarget(VAULT_B.toLowerCase(), allow)).toBe(VAULT_B.toLowerCase());
    expect(acceptedRedeemTarget(ATTACKER, allow)).toBeUndefined();
    expect(acceptedRedeemTarget(undefined, allow)).toBeUndefined();
  });
});
