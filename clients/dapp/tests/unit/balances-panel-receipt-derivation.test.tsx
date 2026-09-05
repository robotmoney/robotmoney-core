/**
 * Container test — BalancesPanel receipt-address derivation (issue #1348).
 *
 * `BalancesPanel` (mounted app-wide at `main.tsx:160`) is the only mounted
 * consumer of `VaultRecord`. For each registered vault it reads
 * balanceOf/decimals/symbol off the vault's receipt token — which, since
 * every vault is itself its ERC-4626 share token, is `record.vault`. The
 * pre-#1348 code read a `record.receiptToken` field the registry never
 * returns, so the derived address was `undefined`.
 *
 * `balances-panel.test.tsx` renders the presentational `BalancesPanelView`
 * with pre-built `receipts` props, so it cannot catch that: it never runs
 * the `VaultRecord -> address` derivation. This test renders the real
 * container instead and resolves each mocked read BY THE ADDRESS THE
 * COMPONENT ASKED FOR, so a wrong/undefined derived address yields no
 * receipt row and turns the test red.
 *
 * Wagmi is mocked at the module boundary (same pattern as
 * governance-panel.test.tsx).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "./helpers/render";
import type { Address } from "viem";
import { BalancesPanel } from "../../src/components/BalancesPanel";

const GATEWAY = "0x6666666666666666666666666666666666666666" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const USER = "0x3333333333333333333333333333333333333333" as Address;
const ASSET = "0x7777777777777777777777777777777777777777" as Address;
const VAULT_A = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0" as Address;

/**
 * Real-shaped VaultRecord (issue #1348): exactly the fields the registry
 * returns plus the address the caller passed in. Deliberately carries NO
 * `receiptToken`/`riskLabel`/`mandate`/`depositCap`/`exitFeeBps`, so any
 * code reaching for one derives `undefined`.
 */
const vaultRecords = [
  {
    vault: VAULT_A,
    name: "Test Vault Alpha",
    asset: ASSET,
    registeredAt: 1_700_000_000n,
    status: 0,
  },
];

vi.mock("../../src/lib/VaultRegistryContext", () => ({
  useVaultRegistry: () => ({
    vaults: vaultRecords,
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

/** Per-token read fixtures, keyed by the address a caller must ask for. */
const TOKEN_READS: Record<string, { balance: bigint; decimals: number; symbol: string }> = {
  [USDC.toLowerCase()]: { balance: 1_000_000n, decimals: 6, symbol: "USDC" },
  // The vault IS its own receipt token — reads must be addressed to the vault.
  [VAULT_A.toLowerCase()]: { balance: 5_000_000n, decimals: 6, symbol: "rmUSDC" },
};

interface ReadContractSpec {
  address?: string;
  functionName?: string;
}

/**
 * Resolve a batched read against TOKEN_READS by the requested address. An
 * address the fixture doesn't know (including `undefined`, which is what a
 * missing `receiptToken` field derives to) fails the call, exactly as a
 * real multicall to a non-token address would.
 */
function resolveRead(spec: ReadContractSpec) {
  const entry = spec.address ? TOKEN_READS[spec.address.toLowerCase()] : undefined;
  if (!entry) return { status: "failure" as const, error: new Error("no contract at address") };
  if (spec.functionName === "balanceOf")
    return { status: "success" as const, result: entry.balance };
  if (spec.functionName === "decimals")
    return { status: "success" as const, result: entry.decimals };
  if (spec.functionName === "symbol") return { status: "success" as const, result: entry.symbol };
  return { status: "failure" as const, error: new Error("unexpected function") };
}

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: USER, isConnected: true }),
  useChainId: () => 918453,
  useBalance: () => ({ data: { value: 1_500_000_000_000_000_000n, symbol: "ETH" } }),
  useReadContract: (opts: { functionName?: string }) => {
    // gateway.usdc() resolves the USDC token address.
    if (opts.functionName === "usdc") return { data: USDC };
    return { data: undefined };
  },
  useReadContracts: (opts: { contracts?: ReadContractSpec[] }) => ({
    data: (opts.contracts ?? []).map(resolveRead),
  }),
}));

describe("BalancesPanel derives receipt-token reads from VaultRecord (issue #1348)", () => {
  it("renders a receipt row for a held vault, addressing reads to record.vault", () => {
    render(<BalancesPanel gatewayAddress={GATEWAY} />);

    // The row only appears if balanceOf/decimals/symbol all resolved, which
    // only happens if the reads were addressed to VAULT_A itself.
    expect(screen.getByTestId(`balances-panel-row-receipt-${VAULT_A}-symbol`).textContent).toBe(
      "rmUSDC",
    );
    expect(screen.getByTestId(`balances-panel-row-receipt-${VAULT_A}-amount`).textContent).toBe(
      "5 rmUSDC",
    );
  });

  it("still renders the plain USDC row (guards against a vacuous pass)", () => {
    render(<BalancesPanel gatewayAddress={GATEWAY} />);
    expect(screen.getByTestId("balances-panel-row-usdc-amount").textContent).toBe("1 USDC");
  });
});
