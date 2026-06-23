/**
 * Regression tests for issue #1036 — `computeVaultListChanged` null-safety.
 *
 * Root cause: #1025 (DAPP-2 router per-leg floors) left the vault-list-change
 * check in RouterDepositTab.tsx dereferencing `leg.vault.toLowerCase()` with no
 * null guard (only the symmetric `live[i]?.toLowerCase()` was guarded). When a
 * preview leg's `vault` was undefined in the live router-deposit path, the
 * component threw `Cannot read properties of undefined (reading 'toLowerCase')`,
 * the deposit UI never settled, and `router-deposit.spec.ts` timed out.
 *
 * The logic is now extracted into the pure `computeVaultListChanged` helper. A
 * leg with `vault: undefined` must produce a boolean WITHOUT throwing, and is
 * treated as "list changed" (the safe, submit-disabling outcome).
 *
 * These assertions fail against the pre-fix dereference and pass after.
 */
import { describe, it, expect } from "vitest";
import type { Address } from "viem";
import { computeVaultListChanged, type LegPreview } from "../../src/lib/routerPreview";

const VAULT_A = "0x1111111111111111111111111111111111111111" as Address;
const VAULT_B = "0x2222222222222222222222222222222222222222" as Address;
const VAULT_C = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;

function leg(vault: Address | undefined): LegPreview {
  return {
    vault: vault as Address,
    weightBps: 5000n,
    legAmount: 1_000_000n,
    estShares: 990_000n,
    unavailable: false,
  };
}

describe("computeVaultListChanged — issue #1036 undefined leg.vault regression", () => {
  it("returns a boolean without throwing when a leg.vault is undefined", () => {
    const legs = [leg(VAULT_A), leg(undefined)];
    const live: Address[] = [VAULT_A, VAULT_B];

    let result: boolean | undefined;
    expect(() => {
      result = computeVaultListChanged(legs, live);
    }).not.toThrow();

    expect(typeof result).toBe("boolean");
    // An unresolved leg vault can't be confirmed to match → "list changed".
    expect(result).toBe(true);
  });

  it("does not throw even when every leg.vault is undefined", () => {
    const legs = [leg(undefined), leg(undefined)];
    const live: Address[] = [VAULT_A, VAULT_B];
    expect(() => computeVaultListChanged(legs, live)).not.toThrow();
    expect(computeVaultListChanged(legs, live)).toBe(true);
  });

  it("returns false when defined leg vaults match activeVaults in order", () => {
    const legs = [leg(VAULT_A), leg(VAULT_B)];
    const live: Address[] = [VAULT_A, VAULT_B];
    expect(computeVaultListChanged(legs, live)).toBe(false);
  });

  it("is case-insensitive when comparing addresses", () => {
    const legs = [leg(VAULT_A.toUpperCase() as Address)];
    const live: Address[] = [VAULT_A.toLowerCase() as Address];
    expect(computeVaultListChanged(legs, live)).toBe(false);
  });

  it("returns true when a defined leg vault differs from activeVaults", () => {
    const legs = [leg(VAULT_A), leg(VAULT_B)];
    const live: Address[] = [VAULT_A, VAULT_C];
    expect(computeVaultListChanged(legs, live)).toBe(true);
  });

  it("returns true when lengths differ", () => {
    const legs = [leg(VAULT_A), leg(VAULT_B)];
    const live: Address[] = [VAULT_A];
    expect(computeVaultListChanged(legs, live)).toBe(true);
  });

  it("returns false (cannot detect a change) when activeVaults is undefined", () => {
    const legs = [leg(VAULT_A)];
    expect(computeVaultListChanged(legs, undefined)).toBe(false);
  });

  it("returns false for an empty legs list", () => {
    expect(computeVaultListChanged([], [VAULT_A])).toBe(false);
  });
});
