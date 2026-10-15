/**
 * Issue 1810 acceptance: "the dapp and explorer display the implementation address and freeze
 * state". The vault page shows its vault; ProtocolUpgradesPanel shows the gateway (whose
 * implementation version every agent consent binds), the router, the registry, the IC policy and
 * the receipt contract. The IC policy and receipt addresses come from the gateway's `icPolicy()`
 * and `consensusReceipt()`.
 *
 * The wagmi mock answers the committee pointers and an empty ERC-1967 slot (a direct deployment),
 * so every configured contract renders its own block, and an unconfigured one says so.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "./helpers/render";
import { ProtocolUpgradesPanel } from "../../src/components/ProtocolUpgradesPanel";

vi.mock("wagmi", () => ({
  useReadContracts: () => ({
    data: [
      { status: "success", result: "0x00000000000000000000000000000000000001c1" },
      { status: "success", result: "0x00000000000000000000000000000000000004ec" },
    ],
  }),
  useStorageAt: () => ({ data: `0x${"00".repeat(32)}`, isError: false }),
  useBytecode: () => ({ data: undefined }),
  useAccount: () => ({ address: undefined, isConnected: false, chainId: undefined }),
  useWriteContract: () => ({ writeContract: () => undefined, isPending: false, data: undefined }),
  useReadContract: () => ({ data: undefined, isError: false, isLoading: true }),
  createConfig: () => ({}),
  http: () => ({}),
  fallback: (...args: unknown[]) => args[0],
  unstable_connector: () => ({}),
}));

describe("ProtocolUpgradesPanel (issue 1810)", () => {
  it("shows the gateway, router, IC policy and receipt, and says when a contract is not configured", () => {
    const { getByTestId } = render(
      <ProtocolUpgradesPanel
        gatewayAddress="0x0000000000000000000000000000000000000b00"
        routerAddress="0x0000000000000000000000000000000000000e00"
      />,
    );
    for (const key of ["gateway", "router", "ic-policy", "receipt"]) {
      const block = getByTestId(`protocol-upgrade-${key}`);
      // An empty slot: a direct deployment, read from the chain (no wallet needed off mainnet).
      expect([key, block.getAttribute("data-upgrade-state")]).toEqual([key, "direct"]);
      expect(getByTestId(`protocol-upgrade-${key}-status`).textContent).toBe("Not upgradeable");
    }
    expect(getByTestId("protocol-upgrade-gateway").querySelector("h3")?.textContent).toBe(
      "RobotMoneyGateway",
    );
    expect(getByTestId("protocol-upgrade-registry").getAttribute("data-upgrade-state")).toBe(
      "unconfigured",
    );
  });
});
