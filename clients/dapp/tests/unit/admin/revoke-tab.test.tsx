/**
 * Unit tests — RevokeTab component (issue #254).
 *
 * Focus: button disabled when agent is empty or malformed (not a valid
 * Ethereum address). The component gates on `isAddress(agent)` before
 * constructing the action and on `sim` before enabling the button.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RevokeTab } from "../../../src/components/RevokeTab";
import type { PreviewContext } from "../../../src/lib/preview";

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false }),
  useSimulateContract: () => ({ data: undefined }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false }),
}));

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const ctx: PreviewContext = {
  gateway: GATEWAY,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

function renderTab(agent = "") {
  return render(<RevokeTab gatewayAddress={GATEWAY} ctx={ctx} agent={agent} />);
}

describe("RevokeTab — button gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the revoke form", () => {
    renderTab();
    expect(screen.getByTestId("revoke-form")).toBeInTheDocument();
  });

  it("button is disabled when agent is empty", () => {
    renderTab("");
    expect(screen.getByTestId("revoke-submit")).toBeDisabled();
  });

  it("button is disabled when agent is malformed (partial hex)", () => {
    renderTab("0xdeadbeef");
    expect(screen.getByTestId("revoke-submit")).toBeDisabled();
  });

  it("button is disabled when agent is a plain string", () => {
    renderTab("not-an-address");
    expect(screen.getByTestId("revoke-submit")).toBeDisabled();
  });

  it("no preview shown when agent is invalid", () => {
    renderTab("bad");
    // TxPreview only renders when action is non-null
    expect(screen.queryByTestId("tx-preview-fn")).toBeNull();
  });
});
