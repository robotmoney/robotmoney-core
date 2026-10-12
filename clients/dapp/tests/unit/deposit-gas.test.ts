// Core issue 1777: router and vault deposits are sent with a gas limit above their entry floors.
import { describe, expect, it } from "vitest";
import routerTab from "../../src/components/RouterDepositTab.tsx?raw";
import vaultSelectorTab from "../../src/components/VaultSelectorDepositTab.tsx?raw";
import depositWithdrawTab from "../../src/components/DepositWithdrawTab.tsx?raw";
import {
  ROUTER_DEPOSIT_GAS_FLOOR,
  ROUTER_DEPOSIT_GAS_LIMIT,
  VAULT_DEPOSIT_GAS_FLOOR,
  VAULT_DEPOSIT_GAS_LIMIT,
  withGasLimit,
} from "../../src/lib/depositGas";

describe("deposit gas limits", () => {
  it("the router limit is at least the 6.8M floor, with headroom", () => {
    expect(ROUTER_DEPOSIT_GAS_FLOOR).toBe(6_800_000n);
    expect(ROUTER_DEPOSIT_GAS_LIMIT).toBeGreaterThan(ROUTER_DEPOSIT_GAS_FLOOR);
  });
  it("the vault limit is at least the 1.6M floor, with headroom", () => {
    expect(VAULT_DEPOSIT_GAS_FLOOR).toBe(1_600_000n);
    expect(VAULT_DEPOSIT_GAS_LIMIT).toBeGreaterThan(VAULT_DEPOSIT_GAS_FLOOR);
  });
  it("adds the limit to a request without gas", () => {
    expect(withGasLimit({ functionName: "deposit" }, ROUTER_DEPOSIT_GAS_LIMIT)).toEqual({
      functionName: "deposit",
      gas: 8_000_000n,
    });
  });
  it("a higher caller-set gas wins, a lower one is raised", () => {
    expect(withGasLimit({ gas: 9_000_000n }, ROUTER_DEPOSIT_GAS_LIMIT).gas).toBe(9_000_000n);
    expect(withGasLimit({ gas: 1n }, ROUTER_DEPOSIT_GAS_LIMIT).gas).toBe(8_000_000n);
  });
  it("the router deposit tab sends the router limit", () => {
    expect(routerTab as string).toMatch(
      /depositWrite\.writeContract\(withGasLimit\(depositSim\.request, ROUTER_DEPOSIT_GAS_LIMIT\)\)/,
    );
  });
  it.each([
    ["VaultSelectorDepositTab", vaultSelectorTab],
    ["DepositWithdrawTab", depositWithdrawTab],
  ])("the %s sends the vault limit", (_name, src) => {
    expect(src as string).toMatch(
      /depositWrite\.writeContract\(withGasLimit\(depositSim\.request, VAULT_DEPOSIT_GAS_LIMIT\)\)/,
    );
  });
});
