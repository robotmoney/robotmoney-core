// Core issue 1758 workaround (dapp issue 1760): the redeem gas helper is pure and removable by one constant.
import { describe, expect, it } from "vitest";
import source from "../../src/lib/redeemGas.ts?raw";
import { REDEEM_GAS_LIMIT_WORKAROUND_1758, withRedeemGasWorkaround } from "../../src/lib/redeemGas";

const RM_USDC = "0x1111111111111111111111111111111111111aBc";
const TARGETS: ReadonlySet<string> = new Set([RM_USDC.toLowerCase()]);

describe("withRedeemGasWorkaround", () => {
  it("the limit is 2.5M, above the ~1.0M a redeem uses", () => {
    expect(REDEEM_GAS_LIMIT_WORKAROUND_1758).toBe(2_500_000n);
  });
  it("adds the limit to a RobotMoneyVault redeem without gas", () => {
    expect(
      withRedeemGasWorkaround({ address: RM_USDC, functionName: "redeem", args: [1n] }, TARGETS),
    ).toEqual({
      address: RM_USDC,
      functionName: "redeem",
      args: [1n],
      gas: 2_500_000n,
    });
  });
  it("keeps a caller-set gas", () => {
    const v = { address: RM_USDC, functionName: "redeem", gas: 7n };
    expect(withRedeemGasWorkaround(v, TARGETS)).toBe(v);
  });
  it.each(["deposit", "approve", "withdraw", "record"])("leaves %s alone", (functionName) => {
    const v = { address: RM_USDC, functionName };
    expect(withRedeemGasWorkaround(v, TARGETS)).toBe(v);
  });
  it("leaves a redeem with no target address alone", () => {
    const v = { functionName: "redeem", args: [1n] };
    expect(withRedeemGasWorkaround(v, TARGETS)).toBe(v);
  });
  it("the constant names core issue 1758 so it is found and removed with the fix", () => {
    const src = source as string;
    expect(src).toMatch(/core issue 1758/);
    expect(src).toMatch(/SETTING THIS CONSTANT TO `undefined`/);
  });
});
