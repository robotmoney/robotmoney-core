/**
 * Component test — VaultRegistryContext (issue #1348).
 *
 * `VaultRegistry.sol`'s `getVault(address)` returns TWO top-level outputs —
 * a `VaultMetadata` tuple (`name`, `asset`, `registeredAt`) and a separate
 * `status` — so viem's `decodeFunctionResult` decodes each per-vault read as
 * a 2-element array `[metadata, status]`, not an object. This test mocks
 * wagmi's `useReadContract`/`useReadContracts` to return exactly that shape
 * (the same shape a real chain read would decode to) and asserts
 * `VaultRegistryProvider` assembles a correct, garbage-free `VaultRecord[]`
 * — the live, app-wide bug path called out in the issue
 * (`VaultRegistryContext.tsx`'s batched `getVault` decode).
 *
 * Wagmi is mocked at the module boundary (same pattern as
 * governance-panel.test.tsx / vault-selector-deposit-tab.test.tsx) so the
 * test exercises the provider's real decode logic without a live chain.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "./helpers/render";
import type { Address } from "viem";
import { VaultRegistryProvider, useVaultRegistry } from "../../src/lib/VaultRegistryContext";

const REGISTRY = "0x5555555555555555555555555555555555555555" as Address;
const VAULT_A = "0x1111111111111111111111111111111111111111" as Address;
const VAULT_B = "0x2222222222222222222222222222222222222222" as Address;
const ASSET = "0x7777777777777777777777777777777777777777" as Address;

/** Simulates viem's decode of the real two-output `getVault` return. */
function rawGetVaultResult(name: string, status: number) {
  return {
    status: "success" as const,
    result: [{ name, asset: ASSET, registeredAt: 1_700_000_000n }, status] as const,
  };
}

vi.mock("wagmi", () => ({
  useReadContract: (opts: { functionName?: string }) => {
    if (opts.functionName === "listVaults") {
      return { data: [VAULT_A, VAULT_B], isLoading: false, error: null, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
  },
  useReadContracts: () => ({
    data: [rawGetVaultResult("Test Vault Alpha", 0), rawGetVaultResult("Test Vault Beta", 1)],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

function Consumer() {
  const { vaults, isLoading } = useVaultRegistry();
  if (isLoading) return <p data-testid="loading" />;
  return (
    <ul>
      {vaults.map((v) => (
        <li key={v.vault} data-testid={`vault-row-${v.vault}`}>
          {`${v.vault}|${v.name}|${v.asset}|${v.status}|${v.registeredAt.toString()}`}
        </li>
      ))}
    </ul>
  );
}

describe("VaultRegistryContext decodes the real two-output getVault shape", () => {
  it("zips the vault address back in and maps metadata + status with no undefined/garbage fields", () => {
    render(
      <VaultRegistryProvider registryAddress={REGISTRY}>
        <Consumer />
      </VaultRegistryProvider>,
    );

    const rowA = screen.getByTestId(`vault-row-${VAULT_A}`);
    expect(rowA.textContent).toBe(`${VAULT_A}|Test Vault Alpha|${ASSET}|0|1700000000`);

    const rowB = screen.getByTestId(`vault-row-${VAULT_B}`);
    expect(rowB.textContent).toBe(`${VAULT_B}|Test Vault Beta|${ASSET}|1|1700000000`);

    expect(rowA.textContent).not.toContain("undefined");
    expect(rowB.textContent).not.toContain("undefined");
  });
});
