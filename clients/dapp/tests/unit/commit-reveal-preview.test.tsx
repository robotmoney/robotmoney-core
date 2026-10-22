/**
 * Unit tests — the previewed call is the signed call on every commit/reveal
 * surface (QA plan U4, finding DR-4, issue #1737 part 2; reworked by issue 1890).
 *
 * Before U4 the Authorize tab, the onboarding wizard and the rotation flow
 * previewed `authorizeAgent(agent, policy)` while the wallet signed
 * `commitAuthorization(hash)` and then `revealAuthorization(agent, salt,
 * policy)`. `authorizeAgent` is gone from the gateway (issue 1890), and every surface
 * now previews the two calls it signs, built from the frozen inputs.
 *
 * Each test drives one surface through consent, commit and reveal with wagmi mocked at the
 * module boundary (helpers/registrationWagmi.ts), captures what reaches `writeContract`, and
 * checks the preview rendered next to that button: `tx-preview-fn` equals the signed
 * functionName, `tx-preview-calldata` equals the calldata of the signed args, and the preview
 * target is the signed address. The agent is not the signing wallet, so the consent hash on
 * screen must be the one for exactly the signed reveal (core 1791).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor, within } from "./helpers/render";
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from "viem";
import { AuthorizeTab } from "../../src/components/AuthorizeTab";
import { OnboardingWizard } from "../../src/components/OnboardingWizard";
import { RotationTab } from "../../src/components/RotationTab";
import { computeCommitHash, computeConsentHash } from "../../src/lib/commitReveal";
import type { PreviewContext } from "../../src/lib/preview";
import { COMMIT_TX, REVOKE_TX, ZERO, type RegState } from "./helpers/registrationWagmi";

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
  const { makeWagmiMock } = await import("./helpers/registrationWagmi");
  return makeWagmiMock(await importOriginal(), state);
});

interface SignedCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
}

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const AGENT = "0x2222222222222222222222222222222222222222" as const;
const OLD_AGENT = "0x5555555555555555555555555555555555555555" as const;
const DEPOSITOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ctx: PreviewContext = { gateway: GATEWAY, gatewayCodeHashVerified: true, envClass: "fork" };
const NOW = 1_893_456_000_000;

beforeEach(() => {
  state.account = { address: DEPOSITOR as Address, isConnected: true };
  state.chainId = 918453;
  state.block = 100n;
  // The agent's consent is on the gateway, so the owner commit is open.
  state.consent = [AGENT, 95n];
  state.agentOwner = ZERO;
  state.hasAdmin = false;
  state.receipts = new Map();
  state.calls = [];
  state.reads = [];
  state.callbacks = [];
});

function lastCall(): SignedCall {
  expect(state.calls.length).toBeGreaterThan(0);
  return state.calls[state.calls.length - 1] as unknown as SignedCall;
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

/** No preview anywhere on screen names a function the flow never signs. */
function expectNoAuthorizeAgentPreview() {
  for (const el of screen.queryAllByTestId("tx-preview-fn")) {
    expect(el.textContent).not.toBe("authorizeAgent");
  }
}

async function accept(hash: Hex, blockNumber: bigint) {
  await waitFor(() => expect(state.callbacks.length).toBeGreaterThan(0));
  state.receipts.set(hash, { status: "success", blockNumber });
  const cb = state.callbacks.pop()!;
  await act(async () => {
    cb(hash);
  });
}

/** The reveal is the 3-argument call (core 1791); the consent hash on screen is for exactly it. */
function expectConsentHashMatchesReveal(testId: string, reveal: SignedCall) {
  expect(reveal.args).toHaveLength(3);
  const [agent, salt, policy] = reveal.args as [Address, Hex, never];
  expect(screen.getByTestId(testId).textContent).toBe(
    computeConsentHash(getAddress(DEPOSITOR), agent, salt, policy),
  );
}

/** The commit hash binds the agent, the depositor and the salt the reveal later signs. */
function expectCommitMatchesReveal(commit: SignedCall, reveal: SignedCall) {
  const [agent, salt] = reveal.args as [Address, Hex];
  expect(commit.args[0]).toBe(computeCommitHash(getAddress(agent), getAddress(DEPOSITOR), salt));
}

/**
 * Click `commitId`, let it mine, click `revealId`, and check each preview against the call that
 * reached the wallet. Returns nothing; the assertions are the point.
 */
async function driveAndCheck(ids: {
  commit: string;
  commitPreview: string;
  reveal: string;
  revealPreview: string;
  consent: string;
  baseCalls: number;
}) {
  const commitBtn = await screen.findByTestId(ids.commit);
  await waitFor(() => expect(commitBtn).toBeEnabled());
  // Before the commit the screen shows the commit preview and no reveal preview.
  expectNoAuthorizeAgentPreview();
  fireEvent.click(commitBtn);
  await waitFor(() => expect(state.calls).toHaveLength(ids.baseCalls + 1));
  const commit = lastCall();
  expect(commit.functionName).toBe("commitAuthorization");
  expectPreviewIsSignedCall(screen.getByTestId(ids.commitPreview), commit);

  state.block = 101n;
  await accept(COMMIT_TX, 100n);
  const revealBtn = await screen.findByTestId(ids.reveal);
  await waitFor(() => expect(revealBtn).toBeEnabled());
  const revealPreview = screen.getByTestId(ids.revealPreview);
  expectNoAuthorizeAgentPreview();
  fireEvent.click(revealBtn);
  await waitFor(() => expect(state.calls).toHaveLength(ids.baseCalls + 2));
  const reveal = lastCall();
  expect(reveal.functionName).toBe("revealAuthorization");
  expectPreviewIsSignedCall(revealPreview, reveal);
  expectCommitMatchesReveal(commit, reveal);
  expectConsentHashMatchesReveal(ids.consent, reveal);
}

describe("AuthorizeTab — commit and reveal previews (QA plan U4)", () => {
  function renderTab(agent: string = AGENT) {
    return render(
      <AuthorizeTab
        gatewayAddress={GATEWAY}
        ctx={ctx}
        agent={agent}
        setAgent={vi.fn()}
        shareReceiver={DEPOSITOR}
        setShareReceiver={vi.fn()}
        destinations={["0x4444444444444444444444444444444444444444"]}
        setDestinations={vi.fn()}
        now={NOW}
      />,
    );
  }

  it("tx-preview-fn equals signed functionName", async () => {
    renderTab();
    const freeze = screen.getByTestId("authorize-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    await driveAndCheck({
      commit: "authorize-submit",
      commitPreview: "authorize-commit-preview",
      reveal: "authorize-reveal-submit",
      revealPreview: "authorize-reveal-preview",
      consent: "authorize-consent-hash",
      baseCalls: 0,
    });
  });

  it("an agent edit after the freeze unbinds the registration instead of changing the signed call", async () => {
    const view = renderTab();
    const freeze = screen.getByTestId("authorize-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    const commitBtn = await screen.findByTestId("authorize-submit");
    await waitFor(() => expect(commitBtn).toBeEnabled());

    // The agent field is shared with other admin tabs: an edit must not retarget the commit.
    view.rerender(
      <AuthorizeTab
        gatewayAddress={GATEWAY}
        ctx={ctx}
        agent={OLD_AGENT}
        setAgent={vi.fn()}
        shareReceiver={DEPOSITOR}
        setShareReceiver={vi.fn()}
        destinations={["0x4444444444444444444444444444444444444444"]}
        setDestinations={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
    expect(screen.getByTestId("authorize-stale")).toBeInTheDocument();
    expect(state.calls).toHaveLength(0);
  });
});

describe("OnboardingWizard — commit and reveal previews (QA plan U4)", () => {
  it("tx-preview-fn equals signed functionName", async () => {
    render(<OnboardingWizard gatewayAddress={GATEWAY} ctx={ctx} env={{}} now={NOW} />);
    fireEvent.click(screen.getByTestId("step-1-next"));
    fireEvent.change(screen.getByTestId("wizard-agent-input"), { target: { value: AGENT } });
    fireEvent.change(screen.getByTestId("wizard-shareReceiver-input"), {
      target: { value: DEPOSITOR },
    });
    fireEvent.change(screen.getByTestId("wizard-destination-extra"), {
      target: { value: "0x4444444444444444444444444444444444444444" },
    });
    fireEvent.click(screen.getByTestId("step-2-next"));
    const freeze = await screen.findByTestId("wizard-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    await driveAndCheck({
      commit: "wizard-commit-submit",
      commitPreview: "wizard-commit-preview",
      reveal: "wizard-reveal-submit",
      revealPreview: "wizard-reveal-preview",
      consent: "wizard-consent-hash",
      baseCalls: 0,
    });
  });
});

describe("RotationTab — commit and reveal previews (QA plan U4)", () => {
  it("tx-preview-fn equals signed functionName", async () => {
    render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
    fireEvent.change(screen.getByTestId("rotation-old-agent-input"), {
      target: { value: OLD_AGENT },
    });
    fireEvent.change(screen.getByTestId("rotation-new-agent-input"), { target: { value: AGENT } });
    fireEvent.change(screen.getByTestId("rotation-shareReceiver-input"), {
      target: { value: DEPOSITOR },
    });
    fireEvent.change(screen.getByTestId("rotation-destination-extra"), {
      target: { value: "0x4444444444444444444444444444444444444444" },
    });
    expectNoAuthorizeAgentPreview();

    // Step 1 (revoke), once the wallet accepts it, unlocks the registration.
    await waitFor(() => expect(screen.getByTestId("rotation-revoke-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("rotation-revoke-submit"));
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(screen.getByTestId("rotation-freeze")).toBeDisabled();
    await accept(REVOKE_TX, 99n);

    const freeze = screen.getByTestId("rotation-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    await driveAndCheck({
      commit: "rotation-authorize-submit",
      commitPreview: "rotation-commit-preview",
      reveal: "rotation-reveal-submit",
      revealPreview: "rotation-reveal-preview",
      consent: "rotation-consent-hash",
      baseCalls: 1,
    });
    // Accepted is not mined: "Rotation complete" waits for a success receipt (QA plan U5).
    expect(screen.queryByTestId("rotation-complete")).toBeNull();
  });
});
