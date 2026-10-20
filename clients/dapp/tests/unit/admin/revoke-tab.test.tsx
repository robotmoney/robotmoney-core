/**
 * Unit tests — RevokeTab component (issue #254).
 *
 * Focus: button disabled when agent is empty or malformed (not a valid
 * Ethereum address). The component gates on `isAddress(agent)` before
 * constructing the action and on `sim` before enabling the button.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "../helpers/render";
import { RevokeTab } from "../../../src/components/RevokeTab";
import type { PreviewContext } from "../../../src/lib/preview";
import type { RegState } from "../helpers/registrationWagmi";

const state = vi.hoisted(
  () =>
    ({
      account: { address: undefined, isConnected: false },
      chainId: 918453,
      block: 100n,
      consent: undefined,
      agentOwner: "0x0000000000000000000000000000000000000000",
      hasAdmin: false,
      receipts: new Map(),
      calls: [],
      reads: [],
      callbacks: [],
    }) as unknown as RegState,
);

vi.mock("wagmi", async (importOriginal) => {
  const { makeWagmiMock } = await import("../helpers/registrationWagmi");
  return makeWagmiMock(await importOriginal(), state);
});

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
    state.account = { address: undefined, isConnected: false };
    state.agentOwner = "0x0000000000000000000000000000000000000000";
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

describe("RevokeTab — the owner and the agent itself may revoke (ACL-9, issue 1890)", () => {
  const AGENT = "0x2222222222222222222222222222222222222222" as const;
  const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
  const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

  beforeEach(() => {
    state.agentOwner = OWNER;
  });

  it("an agent wallet sees the self-revoke note and a self-revoke button", () => {
    state.account = { address: AGENT, isConnected: true };
    renderTab(AGENT);
    expect(screen.getByTestId("revoke-self-note")).toBeInTheDocument();
    expect(screen.getByTestId("revoke-submit").textContent).toMatch(/self-revoke/i);
    expect(screen.getByTestId("revoke-submit")).toBeEnabled();
    expect(screen.queryByTestId("revoke-not-allowed")).toBeNull();
  });

  it("the recorded owner revokes without the self-revoke note", () => {
    state.account = { address: OWNER, isConnected: true };
    renderTab(AGENT);
    expect(screen.queryByTestId("revoke-self-note")).toBeNull();
    expect(screen.queryByTestId("revoke-not-allowed")).toBeNull();
    expect(screen.getByTestId("revoke-submit")).toBeEnabled();
  });

  it("any other wallet, an admin included, is told it cannot revoke", () => {
    state.account = { address: OTHER, isConnected: true };
    state.hasAdmin = true;
    renderTab(AGENT);
    expect(screen.getByTestId("revoke-not-allowed")).toBeInTheDocument();
    expect(screen.queryByTestId("revoke-self-note")).toBeNull();
  });
});
