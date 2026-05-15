/**
 * Component test — Faucet tab is absent from the AdminFlow tab list when
 * the chain-ID classifier returns `mainnet`, and present when it returns
 * `testnet`. Covers issue #261 acceptance criteria:
 *
 *   - "On a chain whose ID is classified mainnet, the dapp bundle
 *     renders no Faucet tab …"
 *   - "A grep-based CI check (or equivalent test) asserts that no
 *     faucet UI component or RPC route is reachable when the chain-ID
 *     classifier returns `mainnet` (e.g. tab is not in the rendered
 *     tree)"
 *
 * We exercise `buildAdminTabs` directly (the function that owns the
 * gating decision) — same surface AdminFlow uses, no wagmi fixture
 * required.
 */
import { describe, expect, it } from "vitest";
import { buildAdminTabs, type BuildAdminTabsArgs } from "../../src/components/buildAdminTabs";

const baseArgs: BuildAdminTabsArgs = {
  gatewayAddress: "0x1111111111111111111111111111111111111111",
  vaultAddress: "0x2222222222222222222222222222222222222222",
  usdcAddress: "0x3333333333333333333333333333333333333333",
  chainId: 1, // mainnet
  ctx: {
    gateway: "0x1111111111111111111111111111111111111111",
    gatewayCodeHashVerified: true,
    envClass: "mainnet",
  },
  flagEnv: {},
  agent: "",
  setAgent: () => undefined,
  shareReceiver: "",
  setShareReceiver: () => undefined,
  faucetWalletAddresses: [],
  now: 0,
};

describe("buildAdminTabs faucet gating", () => {
  it("does NOT include the faucet tab on mainnet (chainId 1)", () => {
    const tabs = buildAdminTabs(baseArgs);
    expect(tabs.find((t) => t.id === "faucet")).toBeUndefined();
  });

  it("does NOT include the faucet tab on Base mainnet (chainId 8453)", () => {
    const tabs = buildAdminTabs({ ...baseArgs, chainId: 8453 });
    expect(tabs.find((t) => t.id === "faucet")).toBeUndefined();
  });

  it("DOES include the faucet tab on the smoke-test devnet (chainId 918453)", () => {
    const tabs = buildAdminTabs({ ...baseArgs, chainId: 918453 });
    expect(tabs.find((t) => t.id === "faucet")).toBeDefined();
  });

  it("DOES include the faucet tab on Sepolia (testnet, chainId 11155111)", () => {
    const tabs = buildAdminTabs({ ...baseArgs, chainId: 11155111 });
    expect(tabs.find((t) => t.id === "faucet")).toBeDefined();
  });
});
