/**
 * Unit tests — commit/reveal authorization flow (issue #1066, AZ-DAPP-1; reworked by issue 1890).
 *
 * Covers acceptance criteria:
 *   - OnboardingWizard and AuthorizeTab sign commitAuthorization (never authorizeAgent, which the
 *     gateway no longer has) as their first write.
 *   - Both sign revealAuthorization(agent, salt, policy) after the commit mined and a block passed.
 *   - The first write is a 32-byte hash, and the commit is bound to the frozen agent and wallet.
 *
 * The sequencing rules (consent first, freeze, expiry, wallet and chain edits) are pinned in
 * consent-registration.test.tsx. This file keeps the per-surface write assertions, driven with
 * the wallet as its own agent so no separate consent is needed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "./helpers/render";
import { getAddress, type Address, type Hex } from "viem";
import { OnboardingWizard } from "../../src/components/OnboardingWizard";
import { AuthorizeTab } from "../../src/components/AuthorizeTab";
import { computeCommitHash } from "../../src/lib/commitReveal";
import type { PreviewContext } from "../../src/lib/preview";
import { COMMIT_TX, REVEAL_TX, ZERO, type RegState } from "./helpers/registrationWagmi";

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

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ctx: PreviewContext = { gateway: GATEWAY, gatewayCodeHashVerified: true, envClass: "fork" };
const NOW = 1_893_456_000_000;

beforeEach(() => {
  state.account = { address: WALLET as Address, isConnected: true };
  state.chainId = 918453;
  state.block = 100n;
  state.consent = undefined;
  state.agentOwner = ZERO;
  state.hasAdmin = false;
  state.receipts = new Map();
  state.calls = [];
  state.reads = [];
  state.callbacks = [];
});

async function accept(hash: Hex, blockNumber: bigint) {
  await waitFor(() => expect(state.callbacks.length).toBeGreaterThan(0));
  state.receipts.set(hash, { status: "success", blockNumber });
  const cb = state.callbacks.pop()!;
  await act(async () => {
    cb(hash);
  });
}

async function wizardToFrozen() {
  render(<OnboardingWizard gatewayAddress={GATEWAY} ctx={ctx} env={{}} now={NOW} />);
  fireEvent.click(screen.getByTestId("step-1-next"));
  fireEvent.change(screen.getByTestId("wizard-agent-input"), { target: { value: WALLET } });
  fireEvent.change(screen.getByTestId("wizard-shareReceiver-input"), {
    target: { value: WALLET },
  });
  fireEvent.click(screen.getByTestId("step-2-next"));
  const freeze = await screen.findByTestId("wizard-freeze");
  await waitFor(() => expect(freeze).toBeEnabled());
  fireEvent.click(freeze);
}

function renderAuthorizeTab() {
  return render(
    <AuthorizeTab
      gatewayAddress={GATEWAY}
      ctx={ctx}
      agent={WALLET}
      setAgent={vi.fn()}
      shareReceiver={WALLET}
      setShareReceiver={vi.fn()}
      now={NOW}
    />,
  );
}

describe("OnboardingWizard — commit/reveal authorization flow", () => {
  it("step 3 offers the freeze, not an authorizeAgent form", async () => {
    render(<OnboardingWizard gatewayAddress={GATEWAY} ctx={ctx} env={{}} now={NOW} />);
    fireEvent.click(screen.getByTestId("step-1-next"));
    fireEvent.change(screen.getByTestId("wizard-agent-input"), { target: { value: WALLET } });
    fireEvent.change(screen.getByTestId("wizard-shareReceiver-input"), {
      target: { value: WALLET },
    });
    fireEvent.click(screen.getByTestId("step-2-next"));
    expect(await screen.findByTestId("wizard-freeze")).toBeInTheDocument();
    expect(screen.queryByTestId("wizard-commit-submit")).toBeNull();
    expect(document.body.textContent).not.toMatch(/authorizeAgent/);
  });

  it("the first write is commitAuthorization with a 32-byte hash bound to the agent and wallet", async () => {
    await wizardToFrozen();
    const commit = await screen.findByTestId("wizard-commit-submit");
    await waitFor(() => expect(commit).toBeEnabled());
    fireEvent.click(commit);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].functionName).toBe("commitAuthorization");
    expect(state.calls[0].functionName).not.toBe("authorizeAgent");
    const hash = (state.calls[0].args as readonly string[])[0];
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("signs revealAuthorization(agent, salt, policy) once the commit mined and a block passed", async () => {
    await wizardToFrozen();
    const commit = await screen.findByTestId("wizard-commit-submit");
    await waitFor(() => expect(commit).toBeEnabled());
    fireEvent.click(commit);
    state.block = 101n;
    await accept(COMMIT_TX, 100n);
    const reveal = screen.getByTestId("wizard-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, 102n);

    expect(state.calls.map((c) => c.functionName)).toEqual([
      "commitAuthorization",
      "revealAuthorization",
    ]);
    const args = state.calls[1].args as readonly unknown[];
    expect(args[0]).toBe(getAddress(WALLET));
    expect(args[1]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(args[2]).toMatchObject({ shareReceiver: getAddress(WALLET), active: true });
    // The commit hash is the one for exactly this agent, wallet and salt.
    expect(state.calls[0].args).toEqual([
      computeCommitHash(getAddress(WALLET), getAddress(WALLET), args[1] as Hex),
    ]);
  });

  it("the reveal button stays disabled while the commit receipt has not arrived", async () => {
    await wizardToFrozen();
    const commit = await screen.findByTestId("wizard-commit-submit");
    await waitFor(() => expect(commit).toBeEnabled());
    fireEvent.click(commit);
    state.block = 105n;
    // The wallet accepted the commit but no receipt exists yet.
    await act(async () => {
      state.callbacks.pop()!(COMMIT_TX);
    });
    expect(screen.getByTestId("wizard-reveal-submit")).toBeDisabled();
  });
});

describe("AuthorizeTab — commit/reveal authorization flow", () => {
  it("the first write is commitAuthorization, never authorizeAgent", async () => {
    renderAuthorizeTab();
    const freeze = screen.getByTestId("authorize-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    const commit = await screen.findByTestId("authorize-submit");
    await waitFor(() => expect(commit).toBeEnabled());
    fireEvent.click(commit);
    expect(state.calls[0].functionName).toBe("commitAuthorization");
    expect(state.calls[0].functionName).not.toBe("authorizeAgent");
    expect((state.calls[0].args as readonly string[])[0]).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("signs revealAuthorization after the commit mined and a block advanced", async () => {
    renderAuthorizeTab();
    const freeze = screen.getByTestId("authorize-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    const commit = await screen.findByTestId("authorize-submit");
    await waitFor(() => expect(commit).toBeEnabled());
    fireEvent.click(commit);
    state.block = 101n;
    await accept(COMMIT_TX, 100n);
    const reveal = screen.getByTestId("authorize-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, 102n);
    expect(state.calls.map((c) => c.functionName)).toEqual([
      "commitAuthorization",
      "revealAuthorization",
    ]);
  });
});
