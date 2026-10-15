/**
 * Unit tests — RotationTab + useRotationState (issue #254).
 *
 * Focus:
 *  - composeRotationPreview error (same old/new address) surfaces in
 *    the rotation-preview-error element.
 *  - Step button gating: revoke-submit enabled only in `idle` step
 *    (when previews are ready and, on the depositor path, the new agent
 *    has consented, issue 1791); authorize-submit enabled only once the
 *    wallet accepted the revoke (`revoke-sent`).
 *
 * Both previews being ready (`previewsOk`) requires simulate to return
 * data. We set the step machine state via address inputs, and gate the
 * simulate mock so the error path and disable conditions are exercised.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { render, screen, fireEvent } from "../helpers/render";
import { CONSENT_AGENT, pasteAgentConsent, signAgentConsent } from "../helpers/agentConsent";
import { RotationTab } from "../../../src/components/RotationTab";
import type { PreviewContext } from "../../../src/lib/preview";

// Per-test wagmi state. Default: not connected, no reads, no simulate data
// → buttons stay disabled.
const wagmiState = vi.hoisted(() => {
  const account: { isConnected: boolean; address?: `0x${string}`; chainId?: number } = {
    isConnected: false,
  };
  return {
    account,
    hasAdmin: undefined as boolean | undefined,
    agentOwner: undefined as string | undefined,
    simData: undefined as unknown,
    writeContract: undefined as unknown as (...args: unknown[]) => void,
  };
});

vi.mock("wagmi", () => ({
  useAccount: () => wagmiState.account,
  useReadContract: (cfg: { functionName: string }) => ({
    data:
      cfg.functionName === "hasRole"
        ? wagmiState.hasAdmin
        : cfg.functionName === "agentConsentNonce"
          ? 0n
          : wagmiState.agentOwner,
  }),
  useSimulateContract: () => ({ data: wagmiState.simData }),
  useWriteContract: () => ({ writeContract: wagmiState.writeContract, isPending: false }),
  useWaitForTransactionReceipt: () => ({ data: undefined }),
  useBlockNumber: () => ({ data: undefined }),
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

function resetWagmi() {
  wagmiState.account = { isConnected: false };
  wagmiState.hasAdmin = undefined;
  wagmiState.agentOwner = undefined;
  wagmiState.simData = undefined;
  wagmiState.writeContract = vi.fn();
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

describe("RotationTab — depositor path (wallet without ADMIN_ROLE)", () => {
  const DEPOSITOR = "0x4444444444444444444444444444444444444444" as const;
  const OLD = "0x2222222222222222222222222222222222222222";
  /** The new agent: a key the test holds, so it can sign the agent's consent (issue 1791). */
  const NEW = CONSENT_AGENT.address;
  const ZERO = "0x0000000000000000000000000000000000000000";

  /** The new agent's consent for DEPOSITOR, pasted into the rotation form. */
  async function consent() {
    const signature = await signAgentConsent({
      owner: DEPOSITOR,
      shareReceiver: DEPOSITOR,
      nonce: 0n,
      chainId: 918453,
      gateway: GATEWAY,
    });
    await pasteAgentConsent("rotation", signature);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetWagmi();
    wagmiState.account = { isConnected: true, address: DEPOSITOR, chainId: 918453 };
    wagmiState.hasAdmin = false;
    wagmiState.agentOwner = ZERO;
    // revokeAgent simulate succeeds (the depositor owns OLD).
    wagmiState.simData = { request: { functionName: "revokeAgent" } };
  });

  function fill(receiver: string) {
    fireEvent.change(screen.getByTestId("rotation-old-agent-input"), { target: { value: OLD } });
    fireEvent.change(screen.getByTestId("rotation-new-agent-input"), { target: { value: NEW } });
    fireEvent.change(screen.getByTestId("rotation-shareReceiver-input"), {
      target: { value: receiver },
    });
  }

  it("labels the commit/reveal path and renders a step-3 reveal button", () => {
    renderTab();
    fill(DEPOSITOR);
    expect(screen.getByTestId("rotation-depositor-path")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-authorize-submit").textContent).toMatch(
      /commitAuthorization/,
    );
    expect(screen.getByTestId("rotation-reveal-submit")).toBeDisabled();
    expect(screen.queryByTestId("rotation-depositor-error")).toBeNull();
  });

  it("enables step 1 when the depositor names itself as shareReceiver, the new agent is free and has consented", async () => {
    renderTab();
    fill(DEPOSITOR);
    // Nothing is signed before the new agent consents: a revoke with no possible
    // reveal after it would leave the depositor with no agent.
    expect(screen.getByTestId("rotation-revoke-submit")).toBeDisabled();
    await consent();
    expect(screen.getByTestId("rotation-revoke-submit")).toBeEnabled();
    expect(screen.getByTestId("rotation-authorize-submit")).toBeDisabled();
  });

  it("refuses a foreign shareReceiver with a visible reason", () => {
    renderTab();
    fill("0x3333333333333333333333333333333333333333");
    expect(screen.getByTestId("rotation-depositor-error").textContent).toMatch(/shareReceiver/);
    expect(screen.getByTestId("rotation-revoke-submit")).toBeDisabled();
  });

  it("refuses a new agent that already has an owner", () => {
    wagmiState.agentOwner = "0x6666666666666666666666666666666666666666";
    renderTab();
    fill(DEPOSITOR);
    expect(screen.getByTestId("rotation-depositor-error").textContent).toMatch(/AgentAlreadyOwned/);
    expect(screen.getByTestId("rotation-revoke-submit")).toBeDisabled();
  });

  it("step 2 signs commitAuthorization (not authorizeAgent) once the wallet accepted step 1", async () => {
    renderTab();
    fill(DEPOSITOR);
    await consent();
    fireEvent.click(screen.getByTestId("rotation-revoke-submit"));
    const write = vi.mocked(wagmiState.writeContract);
    // Sent is not accepted: step 2 waits for the wallet to return the revoke's hash (QA plan U5).
    expect(screen.getByTestId("rotation-authorize-submit")).toBeDisabled();
    const opts = write.mock.calls[0][1] as { onSuccess: (hash: `0x${string}`) => void };
    await act(async () => {
      opts.onSuccess(`0x${"de".repeat(32)}`);
    });
    expect(screen.getByTestId("rotation-authorize-submit")).toBeEnabled();
    fireEvent.click(screen.getByTestId("rotation-authorize-submit"));
    const calls = write.mock.calls.map((c) => (c[0] as { functionName?: string }).functionName);
    expect(calls).toEqual(["revokeAgent", "commitAuthorization"]);
  });
});

describe("RotationTab — admin path (wallet with ADMIN_ROLE) is kept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWagmi();
    wagmiState.account = {
      isConnected: true,
      address: "0x7777777777777777777777777777777777777777",
    };
    wagmiState.hasAdmin = true;
    wagmiState.simData = { request: { functionName: "sim" } };
  });

  it("uses authorizeAgent and renders no reveal step", () => {
    renderTab();
    expect(screen.queryByTestId("rotation-depositor-path")).toBeNull();
    expect(screen.queryByTestId("rotation-reveal-submit")).toBeNull();
    expect(screen.getByTestId("rotation-authorize-submit").textContent).toMatch(/authorizeAgent/);
  });
});
