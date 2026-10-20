/**
 * Unit tests — AuthorizeTab component (issue #254, reworked by issue 1890).
 *
 * Focus: the freeze button (the first step of the consented registration) stays disabled
 * when the wallet is not connected or the agent/shareReceiver are invalid, and no commit
 * button exists before the inputs are frozen.
 *
 * Strategy: vi.mock wagmi hooks at the network boundary (helpers/registrationWagmi.ts).
 * The component's own `isAddress` validation gate is exercised directly.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "../helpers/render";
import { AuthorizeTab } from "../../../src/components/AuthorizeTab";
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

const NOW = 1_893_456_000_000;

function renderTab(agent = "", shareReceiver = "") {
  const setAgent = vi.fn();
  const setShareReceiver = vi.fn();
  return render(
    <AuthorizeTab
      gatewayAddress={GATEWAY}
      ctx={ctx}
      agent={agent}
      setAgent={setAgent}
      shareReceiver={shareReceiver}
      setShareReceiver={setShareReceiver}
      now={NOW}
    />,
  );
}

describe("AuthorizeTab — freeze button gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the authorize form with no commit button before the freeze", () => {
    renderTab();
    expect(screen.getByTestId("authorize-form")).toBeInTheDocument();
    expect(screen.queryByTestId("authorize-submit")).toBeNull();
  });

  it("freeze is disabled while the wallet is not connected, even with valid inputs", () => {
    renderTab(
      "0x2222222222222222222222222222222222222222",
      "0x3333333333333333333333333333333333333333",
    );
    expect(screen.getByTestId("authorize-freeze")).toBeDisabled();
  });

  it("freeze is disabled when agent is empty", () => {
    renderTab("", "");
    expect(screen.getByTestId("authorize-freeze")).toBeDisabled();
  });

  it("freeze is disabled with an invalid (non-address) agent value", () => {
    renderTab("not-an-address", "0x2222222222222222222222222222222222222222");
    expect(screen.getByTestId("authorize-freeze")).toBeDisabled();
  });

  it("freeze is disabled with a valid agent but invalid shareReceiver", () => {
    renderTab("0x2222222222222222222222222222222222222222", "bad-receiver");
    expect(screen.getByTestId("authorize-freeze")).toBeDisabled();
  });

  it("preview is absent when agent address is invalid", () => {
    renderTab("invalid", "0x3333333333333333333333333333333333333333");
    // TxPreview is only rendered when action is non-null (valid addresses)
    expect(screen.queryByTestId("tx-preview-fn")).toBeNull();
  });

  it("preview is absent when both addresses are empty", () => {
    renderTab("", "");
    expect(screen.queryByTestId("tx-preview-fn")).toBeNull();
  });

  it("agent input reflects the passed agent prop", () => {
    renderTab("0xabcd", "");
    const input = screen.getByTestId("agent-input") as HTMLInputElement;
    expect(input.value).toBe("0xabcd");
  });
});
