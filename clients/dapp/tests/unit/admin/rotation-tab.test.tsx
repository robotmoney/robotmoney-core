/**
 * Unit tests — RotationTab + useRotationState (issue #254).
 *
 * Focus:
 *  - composeRotationPreview error (same old/new address) surfaces in
 *    the rotation-preview-error element.
 *  - Step button gating: revoke-submit enabled only in `idle` step
 *    (when previews are ready); authorize-submit enabled only in
 *    `revoke-sent` step.
 *
 * Both previews being ready (`previewsOk`) requires simulate to return
 * data. We set the step machine state via address inputs, and gate the
 * simulate mock so the error path and disable conditions are exercised.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "../helpers/render";
import { RotationTab } from "../../../src/components/RotationTab";
import type { PreviewContext } from "../../../src/lib/preview";

// Default mock: not connected, no simulate data → buttons stay disabled.
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
const NOW = 1_893_456_000_000;

function renderTab() {
  return render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
}

describe("RotationTab — error surfaces in rotation-preview-error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the rotation form", () => {
    renderTab();
    expect(screen.getByTestId("rotation-form")).toBeInTheDocument();
  });

  it("no preview error is shown when both address fields are empty", () => {
    renderTab();
    expect(screen.queryByTestId("rotation-preview-error")).toBeNull();
  });

  it("surfaces an error when old and new agent addresses are identical", () => {
    renderTab();
    const ADDR = "0x2222222222222222222222222222222222222222";
    const RECEIVER = "0x3333333333333333333333333333333333333333";

    fireEvent.change(screen.getByTestId("rotation-old-agent-input"), {
      target: { value: ADDR },
    });
    fireEvent.change(screen.getByTestId("rotation-new-agent-input"), {
      target: { value: ADDR },
    });
    fireEvent.change(screen.getByTestId("rotation-shareReceiver-input"), {
      target: { value: RECEIVER },
    });

    // composeRotationPreview throws when old === new; useRotationState
    // surfaces it as combinedError → rotation-preview-error.
    expect(screen.getByTestId("rotation-preview-error")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-preview-error").textContent).toMatch(/distinct/i);
  });
});

describe("RotationTab — step button gating (idle state)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revoke-submit is disabled in idle state when not connected", () => {
    renderTab();
    expect(screen.getByTestId("rotation-revoke-submit")).toBeDisabled();
  });

  it("authorize-submit is disabled in idle state (must wait for revoke-sent)", () => {
    renderTab();
    // In idle state, step !== "revoke-sent" → authorize button disabled.
    expect(screen.getByTestId("rotation-authorize-submit")).toBeDisabled();
  });

  it("rotation-complete message is absent in idle state", () => {
    renderTab();
    expect(screen.queryByTestId("rotation-complete")).toBeNull();
  });
});
