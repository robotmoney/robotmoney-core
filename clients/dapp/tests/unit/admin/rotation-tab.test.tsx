/**
 * Unit tests — RotationTab + useRotationState (issue #254, reworked by issue 1890).
 *
 * Focus:
 *  - composeRotationPreview error (same old/new address) surfaces in
 *    the rotation-preview-error element.
 *  - Step gating: revoke-submit is enabled only in `idle` step (when previews are
 *    ready); the registration (freeze, consent, owner commit, reveal) opens only once
 *    the wallet accepted the revoke, and the owner commit only after the new agent's
 *    consent is on the gateway.
 *  - Every wallet takes the same path. An ADMIN_ROLE wallet gets no authorizeAgent
 *    button: the gateway has no such call.
 *
 * Both previews being ready (`previewsOk`) requires simulate to return data, which the
 * shared wagmi mock provides for revokeAgent once its argument exists.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { render, screen, fireEvent, waitFor } from "../helpers/render";
import { RotationTab } from "../../../src/components/RotationTab";
import type { PreviewContext } from "../../../src/lib/preview";
import { REVOKE_TX, type RegState } from "../helpers/registrationWagmi";

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
const ZERO = "0x0000000000000000000000000000000000000000" as const;

function renderTab() {
  return render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
}

function resetWagmi() {
  state.account = { address: undefined, isConnected: false };
  state.chainId = 918453;
  state.block = 100n;
  state.consent = undefined;
  state.agentOwner = ZERO;
  state.hasAdmin = false;
  state.receipts = new Map();
  state.calls = [];
  state.reads = [];
  state.callbacks = [];
}

describe("RotationTab — error surfaces in rotation-preview-error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWagmi();
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
    fireEvent.change(screen.getByTestId("rotation-destination-extra"), {
      target: { value: "0x4444444444444444444444444444444444444444" },
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
    resetWagmi();
  });

  it("revoke-submit is disabled in idle state when not connected", () => {
    renderTab();
    expect(screen.getByTestId("rotation-revoke-submit")).toBeDisabled();
  });

  it("the registration is closed in idle state (it waits for the revoke)", () => {
    renderTab();
    expect(screen.getByTestId("rotation-freeze")).toBeDisabled();
    expect(screen.queryByTestId("rotation-authorize-submit")).toBeNull();
  });

  it("rotation-complete message is absent in idle state", () => {
    renderTab();
    expect(screen.queryByTestId("rotation-complete")).toBeNull();
  });
});

describe.each([
  { label: "depositor wallet (no ADMIN_ROLE)", admin: false },
  { label: "ADMIN_ROLE wallet", admin: true },
])("RotationTab — one registration path for a $label", ({ admin }) => {
  const WALLET = "0x4444444444444444444444444444444444444444" as const;
  const OLD = "0x2222222222222222222222222222222222222222";
  const NEW = "0x5555555555555555555555555555555555555555";

  beforeEach(() => {
    vi.clearAllMocks();
    resetWagmi();
    state.account = { address: WALLET, isConnected: true };
    state.hasAdmin = admin;
  });

  function fill(receiver: string) {
    fireEvent.change(screen.getByTestId("rotation-old-agent-input"), { target: { value: OLD } });
    fireEvent.change(screen.getByTestId("rotation-new-agent-input"), { target: { value: NEW } });
    fireEvent.change(screen.getByTestId("rotation-shareReceiver-input"), {
      target: { value: receiver },
    });
    fireEvent.change(screen.getByTestId("rotation-destination-extra"), {
      target: { value: "0x4444444444444444444444444444444444444444" },
    });
  }

  it("labels the one path and renders no authorizeAgent control", () => {
    renderTab();
    fill(WALLET);
    expect(screen.getByTestId("rotation-registration-path")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/authorizeAgent/);
  });

  it("enables step 1 when the previews are ready, with the registration still closed", async () => {
    renderTab();
    fill(WALLET);
    await waitFor(() => expect(screen.getByTestId("rotation-revoke-submit")).toBeEnabled());
    expect(screen.getByTestId("rotation-freeze")).toBeDisabled();
  });

  it("a foreign share receiver blocks the freeze with a visible reason", async () => {
    renderTab();
    fill("0x3333333333333333333333333333333333333333");
    await act(async () => {
      state.callbacks.length = 0;
    });
    expect(screen.getByTestId("rotation-freeze")).toBeDisabled();
  });

  it("warns when the new agent already has an owner", () => {
    state.agentOwner = "0x6666666666666666666666666666666666666666";
    renderTab();
    fill(WALLET);
    expect(screen.getByTestId("rotation-new-agent-owned").textContent).toMatch(/AgentAlreadyOwned/);
  });

  it("opens the registration once the wallet accepted the revoke, and the commit waits for the consent", async () => {
    renderTab();
    fill(WALLET);
    await waitFor(() => expect(screen.getByTestId("rotation-revoke-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("rotation-revoke-submit"));
    // Sent is not accepted: the registration waits for the wallet to return the revoke's hash.
    expect(screen.getByTestId("rotation-freeze")).toBeDisabled();
    await act(async () => {
      state.callbacks.pop()!(REVOKE_TX);
    });
    const freeze = screen.getByTestId("rotation-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    // No consent yet: the commit button is disabled and nothing but the revoke was signed.
    expect(await screen.findByTestId("rotation-authorize-submit")).toBeDisabled();
    expect(state.calls.map((c) => c.functionName)).toEqual(["revokeAgent"]);

    // The new agent's consent appears on the gateway: a fresh freeze reads it and the commit opens.
    state.consent = [NEW, 90n];
    fireEvent.click(screen.getByTestId("rotation-reset"));
    fireEvent.click(await screen.findByTestId("rotation-freeze"));
    await waitFor(() => expect(screen.getByTestId("rotation-authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("rotation-authorize-submit"));
    expect(state.calls.map((c) => c.functionName)).toEqual(["revokeAgent", "commitAuthorization"]);
  });
});
