/**
 * Unit tests — commit/reveal authorization flow (issue #1066, AZ-DAPP-1).
 *
 * Covers acceptance criteria:
 *   - OnboardingWizard calls commitAuthorization (not authorizeAgent) in the
 *     commit call.
 *   - OnboardingWizard calls revealAuthorization in the reveal call after the
 *     reveal block passes.
 *   - AuthorizeTab calls commitAuthorization in its commit call.
 *   - AuthorizeTab calls revealAuthorization in its reveal call.
 *
 * Strategy: vi.mock wagmi so writeContract is a spy. For the OnboardingWizard
 * commit phase, we advance to step 3 and click the commit submit button. For
 * the reveal phase we fire the onSuccess callback (wrapped in act) to simulate
 * a confirmed commit transaction, advance the mock block number so revealReady
 * is true, then check the reveal submit calls revealAuthorization.
 *
 * The commit hash correctness (keccak256(abi.encode(agent, caller, salt))) is
 * verified by checking the first argument to commitAuthorization is a 66-char
 * 0x-prefixed hex string (32 bytes). The full hash round-trip is verified in
 * the contract test suite.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "./helpers/render";
import { OnboardingWizard } from "../../src/components/OnboardingWizard";
import { AuthorizeTab } from "../../src/components/AuthorizeTab";
import type { PreviewContext } from "../../src/lib/preview";

// ---------------------------------------------------------------------------
// Shared spy state
// ---------------------------------------------------------------------------

let capturedWriteArgs: Array<{ functionName: string; args: readonly unknown[] }> = [];
let writeContractOnSuccessCallback: ((txHash: `0x${string}`) => void) | null = null;

// We expose a mutable object so the useBlockNumber mock can read the current
// value even after tests mutate it (closure over object property, not bigint).
const blockState = { current: 100n };

// Receipt state: null means the receipt hasn't arrived yet (commit still mining).
// Set to a receipt object to simulate the commit tx having mined at a given block.
const receiptState: { blockNumber: bigint | null } = { blockNumber: null };

// Partial wagmi mock: spread real exports, override hooks we need to control.
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useAccount: () => ({
      address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
      isConnected: true,
    }),
    useChainId: () => 918453,
    useReadContract: ({ functionName }: { functionName: string }) => {
      // Return a USDC address for gateway.usdc() call; non-zero balance for others.
      if (functionName === "usdc") return { data: "0x4444444444444444444444444444444444444444" };
      return { data: 1000n };
    },
    useBalance: () => ({ data: { value: 1000n } }),
    useBlockNumber: () => ({ data: blockState.current }),
    useSimulateContract: () => ({ data: undefined }),
    useWaitForTransactionReceipt: () => ({
      data:
        receiptState.blockNumber !== null ? { blockNumber: receiptState.blockNumber } : undefined,
    }),
    useWriteContract: () => ({
      writeContract: (
        params: { functionName: string; args: readonly unknown[] },
        opts?: { onSuccess?: (txHash: `0x${string}`) => void },
      ) => {
        capturedWriteArgs.push({ functionName: params.functionName, args: params.args });
        if (opts?.onSuccess) {
          writeContractOnSuccessCallback = opts.onSuccess;
        }
      },
      isPending: false,
    }),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const AGENT = "0x2222222222222222222222222222222222222222" as const;
const SHARE_RECEIVER = "0x3333333333333333333333333333333333333333" as const;

const ctx: PreviewContext = {
  gateway: GATEWAY,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const NOW = 1_893_456_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWizard() {
  return render(<OnboardingWizard gatewayAddress={GATEWAY} ctx={ctx} env={{}} now={NOW} />);
}

function renderAuthorizeTab() {
  const setAgent = vi.fn();
  const setShareReceiver = vi.fn();
  return render(
    <AuthorizeTab
      gatewayAddress={GATEWAY}
      ctx={ctx}
      agent={AGENT}
      setAgent={setAgent}
      shareReceiver={SHARE_RECEIVER}
      setShareReceiver={setShareReceiver}
      now={NOW}
    />,
  );
}

// Advance the wizard from step 1 → 2 → 3 (commit phase).
function advanceWizardToStep3() {
  fireEvent.click(screen.getByTestId("step-1-next"));
  // Fill agent address
  const agentInput = screen.getByTestId("wizard-agent-input");
  fireEvent.change(agentInput, { target: { value: AGENT } });
  // Fill share receiver (PolicyFields uses testIdPrefix="wizard-" + "shareReceiver-input")
  const receiverInput = screen.getByTestId("wizard-shareReceiver-input");
  fireEvent.change(receiverInput, { target: { value: SHARE_RECEIVER } });
  // Advance to step 3
  fireEvent.click(screen.getByTestId("step-2-next"));
}

// Simulate commit onSuccess: call the callback with a mock tx hash, set the
// receipt block number to 100n (the commit mined at block 100), and advance
// the current block to 101n so revealReady = 101n > 100n = true.
async function simulateCommitConfirmedAndBlockAdvanced() {
  await waitFor(() => expect(writeContractOnSuccessCallback).not.toBeNull());
  // Set the mocked receipt: commit mined at block 100.
  receiptState.blockNumber = 100n;
  // Advance the current block past the commit block.
  blockState.current = 101n;
  const MOCK_COMMIT_TX_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
  await act(async () => {
    writeContractOnSuccessCallback!(MOCK_COMMIT_TX_HASH);
  });
}

// ---------------------------------------------------------------------------
// Tests — OnboardingWizard
// ---------------------------------------------------------------------------

describe("OnboardingWizard — commit/reveal authorization flow (AZ-DAPP-1)", () => {
  beforeEach(() => {
    capturedWriteArgs = [];
    writeContractOnSuccessCallback = null;
    blockState.current = 100n;
    receiptState.blockNumber = null;
    vi.clearAllMocks();
  });

  it("shows commit form on step 3, not authorizeAgent form", () => {
    renderWizard();
    advanceWizardToStep3();
    expect(screen.getByTestId("wizard-commit-form")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard-authorize-form")).toBeNull();
  });

  it("commit submit calls commitAuthorization with a 32-byte hash", async () => {
    renderWizard();
    advanceWizardToStep3();

    const commitBtn = screen.getByTestId("wizard-commit-submit");
    expect(commitBtn).not.toBeDisabled();
    fireEvent.click(commitBtn);

    await waitFor(() => {
      expect(capturedWriteArgs).toHaveLength(1);
    });

    const call = capturedWriteArgs[0];
    expect(call.functionName).toBe("commitAuthorization");
    // args[0] is the commitHash — must be a 66-char 0x-prefixed hex string (32 bytes).
    const hash = call.args[0] as string;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("commit submit does NOT call authorizeAgent", async () => {
    renderWizard();
    advanceWizardToStep3();

    fireEvent.click(screen.getByTestId("wizard-commit-submit"));

    await waitFor(() => {
      expect(capturedWriteArgs).toHaveLength(1);
    });

    expect(capturedWriteArgs[0].functionName).not.toBe("authorizeAgent");
  });

  it("transitions to reveal phase after commit onSuccess", async () => {
    renderWizard();
    advanceWizardToStep3();

    fireEvent.click(screen.getByTestId("wizard-commit-submit"));

    await simulateCommitConfirmedAndBlockAdvanced();

    await waitFor(() => {
      expect(screen.getByTestId("wizard-step-3-reveal")).toBeInTheDocument();
    });
  });

  it("reveal submit calls revealAuthorization with agent, salt, and policy", async () => {
    renderWizard();
    advanceWizardToStep3();

    // Commit
    fireEvent.click(screen.getByTestId("wizard-commit-submit"));
    await simulateCommitConfirmedAndBlockAdvanced();

    // Now in reveal phase
    await waitFor(() => expect(screen.getByTestId("wizard-step-3-reveal")).toBeInTheDocument());

    // Clear captured calls to isolate reveal call
    capturedWriteArgs = [];
    writeContractOnSuccessCallback = null;

    const revealBtn = screen.getByTestId("wizard-reveal-submit");
    await waitFor(() => expect(revealBtn).not.toBeDisabled());
    fireEvent.click(revealBtn);

    await waitFor(() => {
      expect(capturedWriteArgs).toHaveLength(1);
    });

    const revealCall = capturedWriteArgs[0];
    expect(revealCall.functionName).toBe("revealAuthorization");
    // args: [agent, salt, policy]
    const [revealAgent, revealSalt, revealPolicy] = revealCall.args as [string, string, unknown];
    expect(revealAgent.toLowerCase()).toBe(AGENT.toLowerCase());
    // salt must be a 32-byte hex string
    expect(revealSalt).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(revealPolicy).toBeTruthy();
  });

  it("reveal button is disabled before the commit receipt arrives (still mining)", async () => {
    // receiptState.blockNumber stays null — receipt has not arrived yet.
    // revealReady requires commitBlockNumber !== null, so button stays disabled.
    renderWizard();
    advanceWizardToStep3();

    fireEvent.click(screen.getByTestId("wizard-commit-submit"));

    // Trigger onSuccess (tx hash returned) but do NOT set receiptState — receipt pending.
    await waitFor(() => expect(writeContractOnSuccessCallback).not.toBeNull());
    const MOCK_TX = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
    await act(async () => {
      writeContractOnSuccessCallback!(MOCK_TX);
    });

    await waitFor(() => expect(screen.getByTestId("wizard-step-3-reveal")).toBeInTheDocument());

    // commitBlockNumber = null (receipt not yet arrived) → revealReady = false
    const revealBtn = screen.getByTestId("wizard-reveal-submit");
    expect(revealBtn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Tests — AuthorizeTab
// ---------------------------------------------------------------------------

describe("AuthorizeTab — commit/reveal authorization flow (AZ-DAPP-1)", () => {
  beforeEach(() => {
    capturedWriteArgs = [];
    writeContractOnSuccessCallback = null;
    blockState.current = 100n;
    receiptState.blockNumber = null;
    vi.clearAllMocks();
  });

  it("shows commit form (not authorizeAgent form) on initial render", () => {
    renderAuthorizeTab();
    expect(screen.getByTestId("authorize-form")).toBeInTheDocument();
    // The heading should mention "commit"
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("commit");
  });

  it("commit submit calls commitAuthorization (not authorizeAgent)", async () => {
    renderAuthorizeTab();

    fireEvent.click(screen.getByTestId("authorize-submit"));

    await waitFor(() => {
      expect(capturedWriteArgs).toHaveLength(1);
    });

    expect(capturedWriteArgs[0].functionName).toBe("commitAuthorization");
    expect(capturedWriteArgs[0].functionName).not.toBe("authorizeAgent");
  });

  it("commitAuthorization args[0] is a 32-byte hash", async () => {
    renderAuthorizeTab();

    fireEvent.click(screen.getByTestId("authorize-submit"));

    await waitFor(() => expect(capturedWriteArgs).toHaveLength(1));

    const hash = capturedWriteArgs[0].args[0] as string;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it("transitions to reveal phase and calls revealAuthorization after block advances", async () => {
    renderAuthorizeTab();

    // Commit
    fireEvent.click(screen.getByTestId("authorize-submit"));

    // Advance block and trigger onSuccess
    await simulateCommitConfirmedAndBlockAdvanced();

    // Reveal form should now appear
    await waitFor(() => expect(screen.getByTestId("authorize-reveal-form")).toBeInTheDocument());

    // Reveal
    capturedWriteArgs = [];
    writeContractOnSuccessCallback = null;

    const revealBtn = screen.getByTestId("authorize-reveal-submit");
    await waitFor(() => expect(revealBtn).not.toBeDisabled());
    fireEvent.click(revealBtn);

    await waitFor(() => expect(capturedWriteArgs).toHaveLength(1));

    const revealCall = capturedWriteArgs[0];
    expect(revealCall.functionName).toBe("revealAuthorization");
    const [revealAgent, revealSalt] = revealCall.args as [string, string, unknown];
    expect(revealAgent.toLowerCase()).toBe(AGENT.toLowerCase());
    expect(revealSalt).toMatch(/^0x[0-9a-f]{64}$/i);
  });
});
