/**
 * Unit tests — the previewed call is the signed call on every commit/reveal
 * surface (QA plan U4, finding DR-4, issue #1737 part 2).
 *
 * Before U4 the Authorize tab, the onboarding wizard and the rotation flow
 * previewed `authorizeAgent(agent, policy)` while the wallet signed
 * `commitAuthorization(hash)` and then `revealAuthorization(agent, salt,
 * policy)`, and the reveal screen showed no preview at all
 * (docs/technical/dapp-credential-decisions.md §3.3 forbids both).
 *
 * Each test drives one surface through commit and reveal with wagmi mocked
 * at the module boundary, captures what reaches `writeContract`, and checks
 * the preview rendered next to that button: `tx-preview-fn` equals the signed
 * functionName, `tx-preview-calldata` equals the calldata of the signed
 * args, and the preview target is the signed address. The reveal screen must
 * re-render the same policy preview the commit screen showed for step 2.
 *
 * The agent is not the depositor, so every surface first collects the agent's
 * EIP-712 AgentConsent (issue 1791, QA plan D2/U4). The tests sign it with a
 * key they hold and paste it; the signed reveal must carry exactly those
 * bytes as its fourth argument, and a consent for another owner keeps the
 * commit disabled.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor, within } from "./helpers/render";
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from "viem";
import { AuthorizeTab } from "../../src/components/AuthorizeTab";
import { OnboardingWizard } from "../../src/components/OnboardingWizard";
import { RotationTab } from "../../src/components/RotationTab";
import { computeCommitHash } from "../../src/lib/commitReveal";
import type { PreviewContext } from "../../src/lib/preview";
import { CONSENT_AGENT, pasteAgentConsent, signAgentConsent } from "./helpers/agentConsent";

// ---------------------------------------------------------------------------
// wagmi mock state
// ---------------------------------------------------------------------------

interface SignedCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
/** An agent whose key the test holds, so it can sign the agent's consent. */
const AGENT = CONSENT_AGENT.address.toLowerCase() as `0x${string}`;
const OLD_AGENT = "0x5555555555555555555555555555555555555555" as const;
const DEPOSITOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const COMMIT_TX = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const;
const REVOKE_TX = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as const;
const CHAIN_ID = 918453;
const CONSENT_NONCE = 0n;

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  onSuccess: null as ((txHash: `0x${string}`) => void) | null,
  block: 100n,
  receiptBlock: null as bigint | null,
}));

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useAccount: () => ({ address: DEPOSITOR, isConnected: true, chainId: 918453 }),
    useChainId: () => 918453,
    useReadContract: ({ functionName }: { functionName: string }) => {
      if (functionName === "usdc") return { data: "0x4444444444444444444444444444444444444444" };
      // Rotation: the wallet has no ADMIN_ROLE (depositor path) and the new agent is unowned.
      if (functionName === "hasRole") return { data: false };
      if (functionName === "agentOwner") return { data: ZERO };
      if (functionName === "agentConsentNonce") return { data: 0n };
      return { data: 1000n };
    },
    useBalance: () => ({ data: { value: 1000n } }),
    useBlockNumber: () => ({ data: state.block }),
    useSimulateContract: ({ functionName, args }: { functionName: string; args?: unknown }) =>
      functionName === "revokeAgent" && args !== undefined
        ? { data: { request: { address: GATEWAY, functionName: "revokeAgent", args } } }
        : { data: undefined },
    useWaitForTransactionReceipt: () => ({
      data: state.receiptBlock !== null ? { blockNumber: state.receiptBlock } : undefined,
    }),
    useWriteContract: () => ({
      writeContract: (params: unknown, opts?: { onSuccess?: (txHash: `0x${string}`) => void }) => {
        state.calls.push(params);
        state.onSuccess = opts?.onSuccess ?? null;
      },
      isPending: false,
    }),
  };
});

const ctx: PreviewContext = {
  gateway: GATEWAY,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};
const NOW = 1_893_456_000_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lastCall(): SignedCall {
  expect(state.calls.length).toBeGreaterThan(0);
  return state.calls[state.calls.length - 1] as SignedCall;
}

function calldataOf(call: SignedCall): Hex {
  // The captured call is untyped wagmi input; viem re-encodes it from its own ABI.
  const params = { abi: call.abi, functionName: call.functionName, args: call.args };
  return encodeFunctionData(params as never);
}

/** The preview inside `container` describes exactly `call`. */
function expectPreviewIsSignedCall(container: HTMLElement, call: SignedCall) {
  const preview = within(container);
  expect(preview.getByTestId("tx-preview").getAttribute("data-ok")).toBe("true");
  expect(preview.getByTestId("tx-preview-fn").textContent).toBe(call.functionName);
  expect(preview.getByTestId("tx-preview-calldata").textContent).toBe(calldataOf(call));
  expect(preview.getByTestId("tx-preview-target").textContent).toContain(call.address);
}

function previewCalldata(container: HTMLElement): string | null {
  return within(container).getByTestId("tx-preview-calldata").textContent;
}

/** No preview anywhere on screen names a function the flow never signs. */
function expectNoAuthorizeAgentPreview() {
  for (const el of screen.queryAllByTestId("tx-preview-fn")) {
    expect(el.textContent).not.toBe("authorizeAgent");
  }
}

/** The commit was accepted by the wallet, mined at block 100, and the head is at 101. */
async function confirmCommit() {
  await waitFor(() => expect(state.onSuccess).not.toBeNull());
  state.receiptBlock = 100n;
  state.block = 101n;
  await act(async () => {
    state.onSuccess!(COMMIT_TX);
  });
}

/** The agent's consent for this depositor at the live nonce, as `rmpc agent-consent` prints it. */
function consentForDepositor(owner: `0x${string}` = DEPOSITOR) {
  return signAgentConsent({
    owner: getAddress(owner),
    shareReceiver: getAddress(owner),
    nonce: CONSENT_NONCE,
    chainId: CHAIN_ID,
    gateway: GATEWAY,
  });
}

/** The reveal carries the pasted consent as its fourth argument. */
function expectRevealCarriesConsent(reveal: SignedCall, consent: Hex) {
  expect(reveal.args).toHaveLength(4);
  expect(reveal.args[3]).toBe(consent.toLowerCase());
}

/** The commit hash binds the agent, the depositor and the salt the reveal later signs. */
function expectCommitMatchesReveal(commit: SignedCall, reveal: SignedCall) {
  const [agent, salt] = reveal.args as [Address, Hex];
  expect(commit.args[0]).toBe(computeCommitHash(getAddress(agent), getAddress(DEPOSITOR), salt));
}

beforeEach(() => {
  state.calls = [];
  state.onSuccess = null;
  state.block = 100n;
  state.receiptBlock = null;
});

// ---------------------------------------------------------------------------
// AuthorizeTab
// ---------------------------------------------------------------------------

describe("AuthorizeTab — commit and reveal previews (QA plan U4)", () => {
  function renderTab() {
    return render(
      <AuthorizeTab
        gatewayAddress={GATEWAY}
        ctx={ctx}
        agent={AGENT}
        setAgent={vi.fn()}
        shareReceiver={DEPOSITOR}
        setShareReceiver={vi.fn()}
        now={NOW}
      />,
    );
  }

  it("tx-preview-fn equals signed functionName", async () => {
    renderTab();
    expectNoAuthorizeAgentPreview();
    // No commit before the agent consents: the reveal would revert InvalidAgentConsent.
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
    const consent = await consentForDepositor();
    await pasteAgentConsent("authorize", consent);
    const stepTwoCalldata = previewCalldata(screen.getByTestId("authorize-next-reveal-preview"));

    fireEvent.click(screen.getByTestId("authorize-submit"));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    const commit = lastCall();
    expect(commit.functionName).toBe("commitAuthorization");
    expectPreviewIsSignedCall(screen.getByTestId("authorize-commit-preview"), commit);

    await confirmCommit();
    await waitFor(() => expect(screen.getByTestId("authorize-reveal-form")).toBeInTheDocument());
    // The reveal screen re-renders the policy preview the commit screen showed for step 2.
    const revealPreview = screen.getByTestId("authorize-reveal-preview");
    expect(previewCalldata(revealPreview)).toBe(stepTwoCalldata);
    expectNoAuthorizeAgentPreview();

    const revealBtn = screen.getByTestId("authorize-reveal-submit");
    await waitFor(() => expect(revealBtn).not.toBeDisabled());
    fireEvent.click(revealBtn);
    await waitFor(() => expect(state.calls).toHaveLength(2));
    const reveal = lastCall();
    expect(reveal.functionName).toBe("revealAuthorization");
    expectPreviewIsSignedCall(revealPreview, reveal);
    expectCommitMatchesReveal(commit, reveal);
    expectRevealCarriesConsent(reveal, consent);
  });

  it("a consent signed for another owner keeps the commit disabled", async () => {
    renderTab();
    const foreign = await consentForDepositor("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await pasteAgentConsent("authorize", foreign, "wrong-signer");
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
    await pasteAgentConsent("authorize", "0x1234", "malformed");
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
  });

  it("an agent edit after the commit does not change the reveal it previews and signs", async () => {
    const view = renderTab();
    await pasteAgentConsent("authorize", await consentForDepositor());
    fireEvent.click(screen.getByTestId("authorize-submit"));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    await confirmCommit();
    const before = previewCalldata(screen.getByTestId("authorize-reveal-preview"));

    // The agent field is shared with other admin tabs; the reveal stays frozen on the commit.
    view.rerender(
      <AuthorizeTab
        gatewayAddress={GATEWAY}
        ctx={ctx}
        agent={OLD_AGENT}
        setAgent={vi.fn()}
        shareReceiver={DEPOSITOR}
        setShareReceiver={vi.fn()}
        now={NOW}
      />,
    );
    const revealPreview = screen.getByTestId("authorize-reveal-preview");
    expect(previewCalldata(revealPreview)).toBe(before);

    const revealBtn = screen.getByTestId("authorize-reveal-submit");
    await waitFor(() => expect(revealBtn).not.toBeDisabled());
    fireEvent.click(revealBtn);
    await waitFor(() => expect(state.calls).toHaveLength(2));
    const reveal = lastCall();
    expect((reveal.args[0] as string).toLowerCase()).toBe(AGENT);
    expectPreviewIsSignedCall(revealPreview, reveal);
  });
});

// ---------------------------------------------------------------------------
// OnboardingWizard
// ---------------------------------------------------------------------------

describe("OnboardingWizard — commit and reveal previews (QA plan U4)", () => {
  function renderToCommitStep() {
    render(<OnboardingWizard gatewayAddress={GATEWAY} ctx={ctx} env={{}} now={NOW} />);
    fireEvent.click(screen.getByTestId("step-1-next"));
    fireEvent.change(screen.getByTestId("wizard-agent-input"), { target: { value: AGENT } });
    fireEvent.change(screen.getByTestId("wizard-shareReceiver-input"), {
      target: { value: DEPOSITOR },
    });
    fireEvent.click(screen.getByTestId("step-2-next"));
  }

  it("tx-preview-fn equals signed functionName", async () => {
    renderToCommitStep();
    expectNoAuthorizeAgentPreview();
    expect(screen.getByTestId("wizard-commit-submit")).toBeDisabled();
    const consent = await consentForDepositor();
    await pasteAgentConsent("wizard", consent);
    const stepTwoCalldata = previewCalldata(screen.getByTestId("wizard-next-reveal-preview"));

    fireEvent.click(screen.getByTestId("wizard-commit-submit"));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    const commit = lastCall();
    expect(commit.functionName).toBe("commitAuthorization");
    expectPreviewIsSignedCall(screen.getByTestId("wizard-commit-preview"), commit);

    await confirmCommit();
    await waitFor(() => expect(screen.getByTestId("wizard-step-3-reveal")).toBeInTheDocument());
    const revealPreview = screen.getByTestId("wizard-reveal-preview");
    expect(previewCalldata(revealPreview)).toBe(stepTwoCalldata);
    expectNoAuthorizeAgentPreview();

    const revealBtn = screen.getByTestId("wizard-reveal-submit");
    await waitFor(() => expect(revealBtn).not.toBeDisabled());
    fireEvent.click(revealBtn);
    await waitFor(() => expect(state.calls).toHaveLength(2));
    const reveal = lastCall();
    expect(reveal.functionName).toBe("revealAuthorization");
    expectPreviewIsSignedCall(revealPreview, reveal);
    expectCommitMatchesReveal(commit, reveal);
    expectRevealCarriesConsent(reveal, consent);
  });
});

// ---------------------------------------------------------------------------
// RotationTab (depositor path)
// ---------------------------------------------------------------------------

describe("RotationTab depositor path — commit and reveal previews (QA plan U4)", () => {
  it("tx-preview-fn equals signed functionName", async () => {
    render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
    fireEvent.change(screen.getByTestId("rotation-old-agent-input"), {
      target: { value: OLD_AGENT },
    });
    fireEvent.change(screen.getByTestId("rotation-new-agent-input"), { target: { value: AGENT } });
    fireEvent.change(screen.getByTestId("rotation-shareReceiver-input"), {
      target: { value: DEPOSITOR },
    });
    expectNoAuthorizeAgentPreview();
    // Nothing is signed, not even the revoke, before the new agent consents.
    expect(screen.getByTestId("rotation-revoke-submit")).toBeDisabled();
    const consent = await consentForDepositor();
    await pasteAgentConsent("rotation", consent);
    const stepThreeCalldata = previewCalldata(screen.getByTestId("rotation-step3"));

    // Step 1 (revoke), once the wallet accepts it, unlocks step 2.
    await waitFor(() => expect(screen.getByTestId("rotation-revoke-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("rotation-revoke-submit"));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(screen.getByTestId("rotation-authorize-submit")).toBeDisabled();
    await act(async () => {
      state.onSuccess!(REVOKE_TX);
    });
    state.onSuccess = null;

    fireEvent.click(screen.getByTestId("rotation-authorize-submit"));
    await waitFor(() => expect(state.calls).toHaveLength(2));
    const commit = lastCall();
    expect(commit.functionName).toBe("commitAuthorization");
    expectPreviewIsSignedCall(screen.getByTestId("rotation-step2"), commit);

    await confirmCommit();
    const step3 = screen.getByTestId("rotation-step3");
    expect(previewCalldata(step3)).toBe(stepThreeCalldata);

    const revealBtn = screen.getByTestId("rotation-reveal-submit");
    await waitFor(() => expect(revealBtn).not.toBeDisabled());
    fireEvent.click(revealBtn);
    await waitFor(() => expect(state.calls).toHaveLength(3));
    const reveal = lastCall();
    expect(reveal.functionName).toBe("revealAuthorization");
    expectPreviewIsSignedCall(step3, reveal);
    expectCommitMatchesReveal(commit, reveal);
    expectRevealCarriesConsent(reveal, consent);
    // Accepted is not mined: "Rotation complete" waits for a success receipt (QA plan U5).
    expect(screen.queryByTestId("rotation-complete")).toBeNull();
  });
});
