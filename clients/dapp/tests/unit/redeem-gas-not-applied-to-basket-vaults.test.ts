// QA plan U3 (DR-10): the fixed 2.5M redeem gas (core issue 1758) is a RobotMoneyVault workaround. A basket
// vault redeem needs 300,000 + 400,000 per basket asset at entry (about 3.8M for a full basket), so the fixed
// limit made every basket redeem revert InsufficientGas. Only a configured RobotMoneyVault target gets it.
import { describe, expect, it } from "vitest";
import {
  REDEEM_GAS_LIMIT_WORKAROUND_1758,
  robotMoneyVaultTargets,
  withRedeemGasWorkaround,
} from "../../src/lib/redeemGas";

const RM_USDC = "0x1111111111111111111111111111111111111aBc";
const RM_PROTO = "0x2222222222222222222222222222222222222222";
const RM_AGENT = "0x3333333333333333333333333333333333333333";
const RM_RWA = "0x4444444444444444444444444444444444444444";
const ENV = {
  VITE_VAULT_ADDRESS: RM_USDC,
  VITE_VAULT_ADDRESSES: JSON.stringify({
    rmUSDC: RM_USDC,
    rmPROTO: RM_PROTO,
    rmAGENT: RM_AGENT,
    rmRWA: RM_RWA,
  }),
};

const redeem = (address: string) => ({
  address,
  functionName: "redeem" as const,
  args: [1n, RM_USDC, RM_USDC] as const,
});

describe("redeem gas is not applied to basket vaults", () => {
  const targets = robotMoneyVaultTargets(ENV);

  it("the RobotMoneyVault set holds rmUSDC only, never a basket vault", () => {
    expect([...targets]).toEqual([RM_USDC.toLowerCase()]);
    for (const basket of [RM_PROTO, RM_AGENT, RM_RWA]) {
      expect(targets.has(basket.toLowerCase())).toBe(false);
    }
  });

  it.each([
    ["rmPROTO", RM_PROTO],
    ["rmAGENT", RM_AGENT],
    ["rmRWA", RM_RWA],
  ])("a %s redeem is sent without a fixed gas limit, so the wallet estimates it", (_, vault) => {
    const v = redeem(vault);
    const out = withRedeemGasWorkaround(v, targets);
    expect(out).toBe(v);
    expect((out as { gas?: bigint }).gas).toBeUndefined();
  });

  it("an rmUSDC redeem still gets the 2.5M limit, whatever the address case", () => {
    expect(REDEEM_GAS_LIMIT_WORKAROUND_1758).toBe(2_500_000n);
    expect(withRedeemGasWorkaround(redeem(RM_USDC), targets)).toEqual({
      ...redeem(RM_USDC),
      gas: 2_500_000n,
    });
    expect(
      withRedeemGasWorkaround(redeem(RM_USDC.toUpperCase().replace("0X", "0x")), targets),
    ).toEqual({
      ...redeem(RM_USDC.toUpperCase().replace("0X", "0x")),
      gas: 2_500_000n,
    });
  });

  it("the rmUSDC entry of VITE_VAULT_ADDRESSES counts without VITE_VAULT_ADDRESS", () => {
    const fromMap = robotMoneyVaultTargets({ VITE_VAULT_ADDRESSES: ENV.VITE_VAULT_ADDRESSES });
    expect([...fromMap]).toEqual([RM_USDC.toLowerCase()]);
  });

  it("an unconfigured deployment applies the limit to no redeem", () => {
    const none = robotMoneyVaultTargets({});
    expect(none.size).toBe(0);
    const v = redeem(RM_USDC);
    expect(withRedeemGasWorkaround(v, none)).toBe(v);
  });

  it("a zero or malformed vault address never enters the set", () => {
    const bad = robotMoneyVaultTargets({
      VITE_VAULT_ADDRESS: "0x0000000000000000000000000000000000000000",
      VITE_VAULT_ADDRESSES: "not json",
    });
    expect(bad.size).toBe(0);
    expect(robotMoneyVaultTargets({ VITE_VAULT_ADDRESS: "0x1234" }).size).toBe(0);
  });
});
