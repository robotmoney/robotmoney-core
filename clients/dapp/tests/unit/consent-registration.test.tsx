/**
 * Unit tests — the owner-consented registration sequence on every dapp surface
 * (issue 1890, RS-1019-12 and RS-1019-13).
 *
 * The gateway has one registration path: the agent's consent, the owner's commit, the owner's
 * reveal. There is no `authorizeAgent`, so an ADMIN_ROLE wallet, a plain depositor and a wallet
 * that is its own agent all run the same sequence on the Authorize tab, the onboarding wizard and
 * the rotation tab.
 *
 * What these tests pin down:
 *   - the owner commit stays disabled before the agent's consent is on the gateway and live;
 *   - the inputs are frozen first, and an edit to the agent, the policy, the wallet or the chain
 *     afterwards disables every step;
 *   - the reveal needs the commit receipt (success), a later block, and both commitments inside
 *     COMMIT_EXPIRY_BLOCKS (256): the last good next-block is commit + 256, one more is refused;
 *   - a reverted commit never opens the reveal and a reverted reveal never completes anything;
 *   - the signed reveal is the three-argument call the consent hash covers, and no surface ever
 *     signs `authorizeAgent`.
 *
 * wagmi is mocked at the module boundary with the shared fake chain in
 * helpers/registrationWagmi.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, useState } from "react";
import { fireEvent, render, screen, waitFor } from "./helpers/render";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { AuthorizeTab } from "../../src/components/AuthorizeTab";
import { OnboardingWizard } from "../../src/components/OnboardingWizard";
import { RotationTab } from "../../src/components/RotationTab";
import { gatewayAbi } from "../../src/lib/abi";
import { COMMIT_EXPIRY_BLOCKS, commitmentStorageKey } from "../../src/lib/consent";
import { computeConsentHash, policyTuple } from "../../src/lib/commitReveal";
import type { PreviewContext } from "../../src/lib/preview";
import { COMMIT_TX, REVEAL_TX, REVOKE_TX, ZERO, type RegState } from "./helpers/registrationWagmi";

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
const AGENT = "0x2222222222222222222222222222222222222222" as const;
const OLD_AGENT = "0x5555555555555555555555555555555555555555" as const;
const OTHER_AGENT = "0x6666666666666666666666666666666666666666" as const;
const VAULT = "0x4444444444444444444444444444444444444444" as const;
const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const ctx: PreviewContext = { gateway: GATEWAY, gatewayCodeHashVerified: true, envClass: "fork" };
const NOW = 1_893_456_000_000;

const WALLETS = [
  { label: "an ADMIN_ROLE wallet", admin: true },
  { label: "a plain depositor wallet", admin: false },
] as const;

function connect(address: Address, admin = false) {
  state.account = { address, isConnected: true };
  state.hasAdmin = admin;
}

beforeEach(() => {
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
});

/** The wallet accepted the last write and returned `hash`; `receipt` is what the chain says about it. */
async function accept(
  hash: Hex,
  receipt?: { status: "success" | "reverted"; blockNumber: bigint },
) {
  await waitFor(() => expect(state.callbacks.length).toBeGreaterThan(0));
  if (receipt) state.receipts.set(hash, receipt);
  const cb = state.callbacks.pop()!;
  await act(async () => {
    cb(hash);
  });
}

const names = () => state.calls.map((c) => c.functionName);

// ---------------------------------------------------------------------------
// The Authorize tab, driven through a harness that holds its editable fields
// ---------------------------------------------------------------------------

function AuthorizeHarness(props: { initialAgent?: string; receiver?: string }) {
  const [agent, setAgent] = useState(props.initialAgent ?? AGENT);
  const [receiver, setReceiver] = useState(props.receiver ?? WALLET);
  return (
    <AuthorizeTab
      gatewayAddress={GATEWAY}
      ctx={ctx}
      agent={agent}
      setAgent={setAgent}
      shareReceiver={receiver}
      setShareReceiver={setReceiver}
      destinations={[VAULT]}
      setDestinations={vi.fn()}
      now={NOW}
    />
  );
}

async function freezeOnly() {
  const freeze = screen.getByTestId("authorize-freeze");
  await waitFor(() => expect(freeze).toBeEnabled());
  fireEvent.click(freeze);
}

async function freezeAuthorize() {
  await freezeOnly();
  await screen.findByTestId("authorize-consent-hash");
}

function consentHashOnScreen(testId: string): Hex {
  return screen.getByTestId(testId).textContent as Hex;
}

describe.each(WALLETS)("Authorize tab with $label", ({ admin }) => {
  beforeEach(() => connect(WALLET, admin));

  it("shows no commit button before the inputs are frozen", () => {
    render(<AuthorizeHarness />);
    expect(screen.queryByTestId("authorize-submit")).toBeNull();
    expect(screen.getByTestId("authorize-freeze")).toBeEnabled();
  });

  it("keeps the owner commit disabled until the agent's consent is live on the gateway", async () => {
    render(<AuthorizeHarness />);
    await freezeAuthorize();
    const commit = screen.getByTestId("authorize-submit");

    // Not read yet, then read and empty: the agent has not consented.
    expect(commit).toBeDisabled();
    expect(screen.getByTestId("authorize-consent-status").getAttribute("data-status")).toBe(
      "unknown",
    );
    state.consent = [ZERO, 0n];
    fireEvent.click(screen.getByTestId("authorize-reset"));
    await freezeAuthorize();
    expect(screen.getByTestId("authorize-consent-status").getAttribute("data-status")).toBe(
      "missing",
    );
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("authorize-submit"));
    expect(state.calls).toHaveLength(0);

    // The agent commits its consent: the gateway shows it and the commit opens.
    state.consent = [AGENT, 90n];
    fireEvent.click(screen.getByTestId("authorize-reset"));
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());
    expect(screen.getByTestId("authorize-consent-status").getAttribute("data-status")).toBe("live");
  });

  it("reads the consent under the key the gateway stores it at", async () => {
    render(<AuthorizeHarness />);
    await freezeAuthorize();
    const hash = consentHashOnScreen("authorize-consent-hash");
    const key = commitmentStorageKey(hash, getAddress(AGENT));
    expect(state.reads.some((r) => r.functionName === "commitments" && r.args?.[0] === key)).toBe(
      true,
    );
  });

  it("signs the owner commit and then the three-argument reveal the consent covers", async () => {
    state.consent = [AGENT, 90n];
    render(<AuthorizeHarness />);
    await freezeAuthorize();
    const hash = consentHashOnScreen("authorize-consent-hash");

    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("authorize-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
    const reveal = screen.getByTestId("authorize-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, { status: "success", blockNumber: 102n });

    expect(names()).toEqual(["commitAuthorization", "revealAuthorization"]);
    expect(names()).not.toContain("authorizeAgent");
    const [agentArg, salt, policy] = state.calls[1].args as [Address, Hex, never];
    expect(agentArg).toBe(getAddress(AGENT));
    expect(policy).toEqual(
      policyTuple({
        active: true,
        validUntil: BigInt(Math.floor(NOW / 1000 + 86400)),
        maxPerPayment: 100000000n,
        maxPerWindow: 1000000000n,
        shareReceiver: WALLET,
        allowedDestinations: [VAULT],
        assetRecipient: ZERO,
        maxWithdrawPerPayment: 0n,
        maxWithdrawPerWindow: 0n,
        allowedSourceVaults: [],
      }),
    );
    // The consent hash the agent committed covers exactly this reveal.
    expect(computeConsentHash(getAddress(WALLET), agentArg, salt, policy)).toBe(hash);
    // The previewed reveal calldata equals the signed one.
    const signed = encodeFunctionData({
      abi: gatewayAbi,
      functionName: "revealAuthorization",
      args: [agentArg, salt, policy],
    });
    expect(screen.getByTestId("authorize-reveal-preview").textContent).toContain(signed);
    expect(await screen.findByTestId("authorize-complete")).toBeInTheDocument();
  });

  it("refuses a foreign share receiver: the receiver must be the signing wallet", () => {
    render(<AuthorizeHarness receiver={OTHER_WALLET} />);
    expect(screen.getByTestId("authorize-freeze")).toBeDisabled();
    expect(screen.getByTestId("authorize-receiver-note")).toBeInTheDocument();
  });
});

describe("Authorize tab, a wallet that is its own agent", () => {
  it("needs no separate consent: the owner commit opens right after the freeze", async () => {
    connect(WALLET);
    render(<AuthorizeHarness initialAgent={WALLET} />);
    await freezeOnly();
    const commit = await screen.findByTestId("authorize-submit");
    await waitFor(() => expect(commit).toBeEnabled());
    expect(screen.getByTestId("authorize-consent-status").getAttribute("data-status")).toBe("self");
    expect(screen.queryByTestId("authorize-consent-hash")).toBeNull();
    fireEvent.click(commit);
    state.block = 101n;
    await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
    const reveal = screen.getByTestId("authorize-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, { status: "success", blockNumber: 102n });
    expect(names()).toEqual(["commitAuthorization", "revealAuthorization"]);
  });
});

describe("Authorize tab, the freeze and what invalidates it", () => {
  beforeEach(() => {
    connect(WALLET);
    state.consent = [AGENT, 90n];
  });

  it("an agent edit after the freeze disables the commit until the inputs are frozen again", async () => {
    render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());

    fireEvent.change(screen.getByTestId("agent-input"), { target: { value: OTHER_AGENT } });
    expect(screen.getByTestId("authorize-stale")).toBeInTheDocument();
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
    fireEvent.click(screen.getByTestId("authorize-submit"));
    expect(state.calls).toHaveLength(0);
  });

  it("a policy edit after the commit disables the reveal", async () => {
    const { rerender } = render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("authorize-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
    await waitFor(() => expect(screen.getByTestId("authorize-reveal-submit")).toBeEnabled());

    fireEvent.change(screen.getByTestId("maxPerPayment-input"), { target: { value: "7" } });
    expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled();
    rerender(<AuthorizeHarness />);
    expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled();
    expect(names()).toEqual(["commitAuthorization"]);
  });

  it("a wallet switch after the freeze disables every step", async () => {
    const { rerender } = render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());

    connect(OTHER_WALLET);
    rerender(<AuthorizeHarness />);
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
    expect(screen.getByTestId("authorize-stale")).toBeInTheDocument();
  });

  it("a chain switch after the freeze disables every step", async () => {
    const { rerender } = render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());

    state.chainId = 8453;
    rerender(<AuthorizeHarness />);
    expect(screen.getByTestId("authorize-submit")).toBeDisabled();
    expect(screen.getByTestId("authorize-stale")).toBeInTheDocument();
  });
});

describe("Authorize tab, receipts and expiry", () => {
  beforeEach(() => {
    connect(WALLET);
    state.consent = [AGENT, 90n];
  });

  async function commitMined(commitBlock: bigint) {
    render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("authorize-submit"));
    await accept(COMMIT_TX, { status: "success", blockNumber: commitBlock });
  }

  it("a reverted commit never opens the reveal", async () => {
    render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("authorize-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "reverted", blockNumber: 100n });
    expect(await screen.findByTestId("authorize-commit-write-reverted")).toBeInTheDocument();
    expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled();
  });

  it("the reveal waits for a block after the commit block", async () => {
    state.block = 100n;
    await commitMined(100n);
    // The head is still the commit block: the reveal would land in the same block or the next.
    expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled();
    expect(screen.getByTestId("authorize-reveal-waiting")).toBeInTheDocument();
  });

  it("the reveal is allowed through the commit's 256-block limit and refused one block later", async () => {
    const commitBlock = 100n;
    state.consent = [AGENT, 100n];
    // Head 355: the reveal lands in block 356 = commit + 256, the last good block.
    state.block = commitBlock + COMMIT_EXPIRY_BLOCKS - 1n;
    const { rerender } = render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("authorize-submit"));
    await accept(COMMIT_TX, { status: "success", blockNumber: commitBlock });
    await waitFor(() => expect(screen.getByTestId("authorize-reveal-submit")).toBeEnabled());

    // Head 356: the reveal would land in block 357, one past the limit.
    state.block = commitBlock + COMMIT_EXPIRY_BLOCKS;
    rerender(<AuthorizeHarness />);
    await waitFor(() => expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled());
    expect(screen.getByTestId("authorize-expired").getAttribute("data-expiry")).toBe(
      "commit-expired",
    );
  });

  it("the reveal is refused once the agent's consent is older than 256 blocks", async () => {
    // The consent was made at block 90; the owner commit is young (block 300).
    state.block = 299n;
    state.consent = [AGENT, 90n];
    const { rerender } = render(<AuthorizeHarness />);
    await freezeAuthorize();
    await waitFor(() => expect(screen.getByTestId("authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("authorize-submit"));
    await accept(COMMIT_TX, { status: "success", blockNumber: 299n });
    state.block = 300n;
    rerender(<AuthorizeHarness />);
    // Next block 301 > 90 + 256 = 346? No: 301 <= 346, so the consent is still live.
    await waitFor(() => expect(screen.getByTestId("authorize-reveal-submit")).toBeEnabled());

    // Head 346: next block 347 > 346, so the consent is one block too old.
    state.block = 90n + COMMIT_EXPIRY_BLOCKS;
    rerender(<AuthorizeHarness />);
    await waitFor(() => expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled());
    expect(screen.getByTestId("authorize-consent-status").getAttribute("data-status")).toBe(
      "expired",
    );
  });

  it("a reverted reveal never completes the registration", async () => {
    state.block = 101n;
    await commitMined(100n);
    const reveal = screen.getByTestId("authorize-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, { status: "reverted", blockNumber: 102n });
    expect(await screen.findByTestId("authorize-reveal-write-reverted")).toBeInTheDocument();
    expect(screen.queryByTestId("authorize-complete")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The onboarding wizard
// ---------------------------------------------------------------------------

async function wizardToStep3(agent: string) {
  render(<OnboardingWizard gatewayAddress={GATEWAY} ctx={ctx} env={{}} now={NOW} />);
  fireEvent.click(screen.getByTestId("step-1-next"));
  fireEvent.change(screen.getByTestId("wizard-agent-input"), { target: { value: agent } });
  fireEvent.change(screen.getByTestId("wizard-shareReceiver-input"), {
    target: { value: WALLET },
  });
  fireEvent.change(screen.getByTestId("wizard-destination-extra"), { target: { value: VAULT } });
  fireEvent.click(screen.getByTestId("step-2-next"));
  const freeze = await screen.findByTestId("wizard-freeze");
  await waitFor(() => expect(freeze).toBeEnabled());
  fireEvent.click(freeze);
}

describe.each(WALLETS)("Onboarding wizard with $label", ({ admin }) => {
  beforeEach(() => connect(WALLET, admin));

  it("holds the owner commit until the consent is seen, then commits and reveals", async () => {
    await wizardToStep3(AGENT);
    await screen.findByTestId("wizard-consent-hash");
    expect(screen.getByTestId("wizard-commit-submit")).toBeDisabled();

    state.consent = [AGENT, 95n];
    fireEvent.click(screen.getByTestId("wizard-reset"));
    const freeze = await screen.findByTestId("wizard-freeze");
    fireEvent.click(freeze);
    await waitFor(() => expect(screen.getByTestId("wizard-commit-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("wizard-commit-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
    const reveal = screen.getByTestId("wizard-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, { status: "success", blockNumber: 102n });
    expect(names()).toEqual(["commitAuthorization", "revealAuthorization"]);
  });
});

// ---------------------------------------------------------------------------
// The rotation tab
// ---------------------------------------------------------------------------

function fillRotation(receiver: string = WALLET) {
  fireEvent.change(screen.getByTestId("rotation-old-agent-input"), {
    target: { value: OLD_AGENT },
  });
  fireEvent.change(screen.getByTestId("rotation-new-agent-input"), { target: { value: AGENT } });
  fireEvent.change(screen.getByTestId("rotation-shareReceiver-input"), {
    target: { value: receiver },
  });
  fireEvent.change(screen.getByTestId("rotation-destination-extra"), { target: { value: VAULT } });
}

describe.each(WALLETS)("Rotation tab with $label", ({ admin }) => {
  beforeEach(() => connect(WALLET, admin));

  it("never offers or signs authorizeAgent, and labels one path for every wallet", () => {
    render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
    fillRotation();
    expect(screen.getByTestId("rotation-registration-path").textContent).toMatch(/same way/i);
    expect(document.body.textContent).not.toMatch(/authorizeAgent/);
  });

  it("revokes, waits for the consent, commits, then reveals", async () => {
    render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
    fillRotation();
    const revoke = screen.getByTestId("rotation-revoke-submit");
    await waitFor(() => expect(revoke).toBeEnabled());
    // The registration stays closed until the old agent is revoked.
    expect(screen.getByTestId("rotation-freeze")).toBeDisabled();
    fireEvent.click(revoke);
    await accept(REVOKE_TX, { status: "success", blockNumber: 99n });

    const freeze = screen.getByTestId("rotation-freeze");
    await waitFor(() => expect(freeze).toBeEnabled());
    fireEvent.click(freeze);
    await screen.findByTestId("rotation-consent-hash");
    expect(screen.getByTestId("rotation-authorize-submit")).toBeDisabled();

    // The agent consents; a fresh freeze reads it.
    state.consent = [AGENT, 95n];
    fireEvent.click(screen.getByTestId("rotation-reset"));
    fireEvent.click(await screen.findByTestId("rotation-freeze"));
    await waitFor(() => expect(screen.getByTestId("rotation-authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("rotation-authorize-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
    const reveal = screen.getByTestId("rotation-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, { status: "success", blockNumber: 102n });

    expect(names().filter((n) => n !== "revokeAgent")).toEqual([
      "commitAuthorization",
      "revealAuthorization",
    ]);
    expect(names()).not.toContain("authorizeAgent");
    expect(await screen.findByTestId("rotation-complete")).toBeInTheDocument();
  });

  it("a reverted reveal never says the rotation is complete", async () => {
    state.consent = [AGENT, 95n];
    render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
    fillRotation();
    const revoke = screen.getByTestId("rotation-revoke-submit");
    await waitFor(() => expect(revoke).toBeEnabled());
    fireEvent.click(revoke);
    await accept(REVOKE_TX, { status: "success", blockNumber: 99n });
    fireEvent.click(await screen.findByTestId("rotation-freeze"));
    await waitFor(() => expect(screen.getByTestId("rotation-authorize-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("rotation-authorize-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
    const reveal = screen.getByTestId("rotation-reveal-submit");
    await waitFor(() => expect(reveal).toBeEnabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, { status: "reverted", blockNumber: 102n });
    expect(await screen.findByTestId("rotation-reveal-write-reverted")).toBeInTheDocument();
    expect(screen.queryByTestId("rotation-complete")).toBeNull();
  });
});
