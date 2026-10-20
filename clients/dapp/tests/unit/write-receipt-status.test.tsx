/**
 * Unit tests — every agent-permission write tab renders its receipt, and a
 * flow is "done" only when its last transaction is mined with success (QA
 * plan U5, finding DR-9, issue 1737).
 *
 * Before U5 the Authorize, onboarding and rotation tabs passed only
 * `{ error, isPending }` to `WriteStatus`, so a transaction the wallet
 * accepted but the chain reverted showed nothing. Rotation marked its steps
 * done as soon as the wallet accepted them (the admin path even before the
 * write resolved), so "Rotation complete" showed for a reverted reveal, and
 * the Authorize tab registered the wallet on acceptance alone.
 *
 * wagmi is mocked at the module boundary. Receipts come from a per-hash map,
 * so each test decides which transaction mined and with what status.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { fireEvent, render, screen, waitFor } from "./helpers/render";
import { AuthorizeTab } from "../../src/components/AuthorizeTab";
import { RotationTab } from "../../src/components/RotationTab";
import type { PreviewContext } from "../../src/lib/preview";
import type { RegState } from "./helpers/registrationWagmi";

const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const DEPOSITOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const OLD_AGENT = "0x5555555555555555555555555555555555555555" as const;
const NEW_AGENT = "0x6666666666666666666666666666666666666666" as const;
const tx = (b: string) => `0x${b.repeat(64)}` as `0x${string}`;
const COMMIT_TX = tx("c");
const REVEAL_TX = tx("e");
const REVOKE_TX = tx("d");

type Receipt = { status: "success" | "reverted"; blockNumber: bigint };

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

const ctx: PreviewContext = { gateway: GATEWAY, gatewayCodeHashVerified: true, envClass: "fork" };
const NOW = 1_893_456_000_000;

/** The wallet accepted the last write and returned `hash`; its receipt is `receipt` (or none yet). */
async function accept(hash: `0x${string}`, receipt?: Receipt) {
  await waitFor(() => expect(state.callbacks.length).toBeGreaterThan(0));
  if (receipt) state.receipts.set(hash, receipt);
  const cb = state.callbacks.pop()!;
  await act(async () => {
    cb(hash);
  });
}

beforeEach(() => {
  state.account = { address: DEPOSITOR, isConnected: true };
  state.chainId = 918453;
  state.block = 100n;
  state.consent = undefined;
  state.hasAdmin = false;
  state.receipts = new Map();
  state.calls = [];
  state.reads = [];
  state.callbacks = [];
});

/** Freeze the inputs on the host whose controls start with `prefix`, then wait for the owner commit. */
async function freezeAndWaitForCommit(prefix: string, commitId: string) {
  const freeze = screen.getByTestId(`${prefix}-freeze`);
  await waitFor(() => expect(freeze).toBeEnabled());
  fireEvent.click(freeze);
  const commit = await screen.findByTestId(commitId);
  await waitFor(() => expect(commit).toBeEnabled());
  return commit;
}

describe("AuthorizeTab — commit and reveal receipts (QA plan U5)", () => {
  // A self-reveal: the wallet binds itself, so no agent consent commit is needed (core 1791).
  function renderSelfBinding() {
    return render(
      <AuthorizeTab
        gatewayAddress={GATEWAY}
        ctx={ctx}
        agent={DEPOSITOR}
        setAgent={vi.fn()}
        shareReceiver={DEPOSITOR}
        setShareReceiver={vi.fn()}
        now={NOW}
      />,
    );
  }

  it("a reverted reveal shows its revert and does not register the wallet", async () => {
    const registered = vi.fn();
    window.addEventListener("rm:registration-changed", registered);
    try {
      renderSelfBinding();
      fireEvent.click(await freezeAndWaitForCommit("authorize", "authorize-submit"));
      state.block = 101n;
      await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
      const reveal = screen.getByTestId("authorize-reveal-submit");
      await waitFor(() => expect(reveal).not.toBeDisabled());
      fireEvent.click(reveal);
      await accept(REVEAL_TX, { status: "reverted", blockNumber: 102n });

      expect(await screen.findByTestId("authorize-reveal-write-reverted")).toBeInTheDocument();
      expect(screen.queryByTestId("authorize-complete")).toBeNull();
      expect(registered).not.toHaveBeenCalled();
      // A reverted reveal is not re-sent by the same button.
      expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled();
    } finally {
      window.removeEventListener("rm:registration-changed", registered);
    }
  });

  it("a mined reveal confirms and registers the wallet", async () => {
    const registered = vi.fn();
    window.addEventListener("rm:registration-changed", registered);
    try {
      renderSelfBinding();
      fireEvent.click(await freezeAndWaitForCommit("authorize", "authorize-submit"));
      state.block = 101n;
      await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
      const reveal = screen.getByTestId("authorize-reveal-submit");
      await waitFor(() => expect(reveal).not.toBeDisabled());
      fireEvent.click(reveal);
      await accept(REVEAL_TX, { status: "success", blockNumber: 102n });

      expect(await screen.findByTestId("authorize-complete")).toBeInTheDocument();
      expect(screen.getByTestId("authorize-reveal-write-status").getAttribute("data-status")).toBe(
        "success",
      );
      await waitFor(() => expect(registered).toHaveBeenCalled());
    } finally {
      window.removeEventListener("rm:registration-changed", registered);
    }
  });

  it("a reverted commit shows its revert and never opens the reveal", async () => {
    renderSelfBinding();
    fireEvent.click(await freezeAndWaitForCommit("authorize", "authorize-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "reverted", blockNumber: 100n });
    expect(await screen.findByTestId("authorize-commit-write-reverted")).toBeInTheDocument();
    expect(screen.getByTestId("authorize-reveal-submit")).toBeDisabled();
  });
});

describe("RotationTab — every step renders its receipt (QA plan U5)", () => {
  function fill() {
    render(<RotationTab gatewayAddress={GATEWAY} ctx={ctx} now={NOW} />);
    fireEvent.change(screen.getByTestId("rotation-old-agent-input"), {
      target: { value: OLD_AGENT },
    });
    fireEvent.change(screen.getByTestId("rotation-new-agent-input"), {
      target: { value: NEW_AGENT },
    });
    fireEvent.change(screen.getByTestId("rotation-shareReceiver-input"), {
      target: { value: DEPOSITOR },
    });
  }

  async function runToReveal(revealReceipt: Receipt) {
    // The new agent has consented on the gateway.
    state.consent = [NEW_AGENT, 90n];
    fill();
    const revoke = screen.getByTestId("rotation-revoke-submit");
    await waitFor(() => expect(revoke).not.toBeDisabled());
    fireEvent.click(revoke);
    await accept(REVOKE_TX, { status: "success", blockNumber: 99n });
    fireEvent.click(await freezeAndWaitForCommit("rotation", "rotation-authorize-submit"));
    state.block = 101n;
    await accept(COMMIT_TX, { status: "success", blockNumber: 100n });
    const reveal = screen.getByTestId("rotation-reveal-submit");
    await waitFor(() => expect(reveal).not.toBeDisabled());
    fireEvent.click(reveal);
    await accept(REVEAL_TX, revealReceipt);
  }

  it("a reverted reveal shows its revert and never says 'Rotation complete'", async () => {
    await runToReveal({ status: "reverted", blockNumber: 102n });
    expect(await screen.findByTestId("rotation-reveal-write-reverted")).toBeInTheDocument();
    expect(screen.queryByTestId("rotation-complete")).toBeNull();
  });

  it("'Rotation complete' appears only once the reveal is mined with success", async () => {
    await runToReveal({ status: "success", blockNumber: 102n });
    expect(await screen.findByTestId("rotation-complete")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-revoke-write-status").getAttribute("data-status")).toBe(
      "success",
    );
  });

  it("a reverted revoke shows its revert and keeps step 2 closed", async () => {
    fill();
    const revoke = screen.getByTestId("rotation-revoke-submit");
    await waitFor(() => expect(revoke).not.toBeDisabled());
    fireEvent.click(revoke);
    await accept(REVOKE_TX, { status: "reverted", blockNumber: 99n });
    expect(await screen.findByTestId("rotation-revoke-write-reverted")).toBeInTheDocument();
    // The registration stays closed: a reverted revoke left the old agent bound.
    expect(screen.getByTestId("rotation-freeze")).toBeDisabled();
  });
});
