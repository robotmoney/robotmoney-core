// Core issue 1777: router and vault deposits are sent with a gas limit above their entry floors.
// QA plan U3: the router limit follows the effective leg count instead of a 4-leg constant.
import { describe, expect, it } from "vitest";
import {
  ROUTER_DEPOSIT_GAS_PER_LEG,
  VAULT_DEPOSIT_GAS_FLOOR,
  VAULT_DEPOSIT_GAS_LIMIT,
  routerDepositGasFloor,
  routerDepositGasLimit,
  withGasLimit,
} from "../../src/lib/depositGas";

describe("deposit gas limits", () => {
  it("the router floor is 2.8M per leg: 11.2M for the 4-leg router", () => {
    expect(ROUTER_DEPOSIT_GAS_PER_LEG).toBe(2_800_000n);
    expect(routerDepositGasFloor(4)).toBe(11_200_000n);
  });
  it("the 4-leg router limit is the floor plus 1.2M", () => {
    expect(routerDepositGasLimit(4)).toBe(12_400_000n);
  });
  it("a fifth leg raises the limit above its 14M floor (the 4-leg limit would revert InsufficientGas)", () => {
    expect(routerDepositGasFloor(5)).toBe(14_000_000n);
    expect(routerDepositGasLimit(5)).toBeGreaterThan(routerDepositGasFloor(5));
    expect(routerDepositGasLimit(5)).toBeGreaterThan(routerDepositGasLimit(4));
  });
  it.each([1, 2, 3, 4, 5, 6, 8])("the limit for %i legs sits above that floor", (legs) => {
    expect(routerDepositGasLimit(legs)).toBeGreaterThan(routerDepositGasFloor(legs));
  });
  it("the vault limit is at least the 1.6M floor, with headroom", () => {
    expect(VAULT_DEPOSIT_GAS_FLOOR).toBe(1_600_000n);
    expect(VAULT_DEPOSIT_GAS_LIMIT).toBeGreaterThan(VAULT_DEPOSIT_GAS_FLOOR);
  });
  it("adds the limit to a request without gas", () => {
    expect(withGasLimit({ functionName: "deposit" }, routerDepositGasLimit(4))).toEqual({
      functionName: "deposit",
      gas: 12_400_000n,
    });
  });
  it("a higher caller-set gas wins, a lower one is raised", () => {
    expect(withGasLimit({ gas: 13_000_000n }, routerDepositGasLimit(4)).gas).toBe(13_000_000n);
    expect(withGasLimit({ gas: 1n }, routerDepositGasLimit(4)).gas).toBe(12_400_000n);
  });
});
