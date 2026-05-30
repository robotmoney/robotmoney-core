/**
 * Unit tests — AuthorizeTab component (issue #254).
 *
 * Focus: submit button stays disabled when agent/shareReceiver are
 * invalid or when simulate hasn't returned a result yet.
 *
 * Strategy: vi.mock wagmi hooks at the network boundary. The mock
 * returns `isPending:false` and `sim:undefined` by default — matching
 * what a real wagmi instance returns before a simulation completes.
 * The component's own `isAddress` validation gate is exercised directly.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "../helpers/render";
import { AuthorizeTab } from "../../../src/components/AuthorizeTab";
import type { PreviewContext } from "../../../src/lib/preview";

// Mock wagmi at the network boundary — we only care about the component's
// own address-validation logic and button disable conditions.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useSimulateContract: () => ({ data: undefined }),
  useWriteContract: () => ({ writeContract: vi.fn(), isPending: false }),
  // useVaultRegistration.ts (imported transitively) statically imports useReadContract.
  useReadContract: () => ({ data: undefined }),
}));

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

describe("AuthorizeTab — submit button gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the authorize form", () => {
    renderTab();
    expect(screen.getByTestId("authorize-form")).toBeInTheDocument();
  });

  it("submit is disabled when agent is empty", () => {
    renderTab("", "");
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
  });

  it("submit is disabled with an invalid (non-address) agent value", () => {
    renderTab("not-an-address", "0x2222222222222222222222222222222222222222");
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
  });

  it("submit is disabled with a valid agent but invalid shareReceiver", () => {
    renderTab("0x2222222222222222222222222222222222222222", "bad-receiver");
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
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
