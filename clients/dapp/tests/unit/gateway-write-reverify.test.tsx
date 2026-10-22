/**
 * Issue 1840: AdminFlow and AgentsPanel re-verify the gateway at the latest
 * block right before each admin write goes to the wallet.
 *
 * The cached verification (mount, chain change, refresh) says the gateway is a
 * proxy for IMPL. The injected provider then answers the latest-block reads.
 * When the implementation slot still names IMPL the write reaches wagmi's
 * `writeContract`. When a governed upgrade has replaced it, the write is
 * refused and never reaches the wallet.
 *
 * Strategy: vi.mock wagmi's component-level hooks (as the onboarding wizard
 * test does) and record what reaches `useWriteContract().writeContract`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "./helpers/render";
import { keccak256, type Address, type Hex } from "viem";
import { AdminFlow } from "../../src/components/AdminFlow";
import { AgentsPanel } from "../../src/components/AgentsPanel";
import type { VerificationState } from "../../src/lib/useGatewayVerifier";
import { GatewayWriteCheck, useGatewayWriteCheck } from "../../src/lib/gatewayWriteCheck";
import { useGuardedWriteContract } from "../../src/lib/useGuardedWriteContract";

const GATEWAY = "0x1111111111111111111111111111111111111111" as Address;
const VAULT = "0x2222222222222222222222222222222222222222" as Address;
const USER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const AGENT = "0x3333333333333333333333333333333333333333";
const IMPL = "0x1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a" as Address;
const UPGRADED_IMPL = "0x2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b" as Address;
const GATEWAY_CODE = "0x60016001" as Hex;
const IMPL_CODE = "0x60026002" as Hex;

const writeSpy = vi.fn();
const writeAsyncSpy = vi.fn();

vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useAccount: () => ({
      address: USER,
      isConnected: true,
      chainId: 918453,
      connector: {
        getProvider: () => Promise.resolve((window as unknown as { ethereum: unknown }).ethereum),
      },
    }),
    useChainId: () => 918453,
    useConnect: () => ({ connect: () => undefined, connectors: [] }),
    useDisconnect: () => ({ disconnect: () => undefined }),
    useReadContract: () => ({ data: undefined }),
    useBalance: () => ({ data: undefined }),
    useBlockNumber: () => ({ data: undefined }),
    useWaitForTransactionReceipt: () => ({ data: undefined }),
    useSimulateContract: ({ functionName }: { functionName: string }) => ({
      data: {
        request: { address: GATEWAY, abi: [], functionName, args: [AGENT] },
      },
    }),
    useWriteContract: () => ({
      writeContract: writeSpy,
      writeContractAsync: writeAsyncSpy,
      isPending: false,
      error: null,
    }),
  };
});

/** The implementation the latest block's ERC-1967 slot names. */
let liveImplementation: Address = IMPL;
/** The chain the wallet provider answers for (918453 = the connected chain). */
let providerChain = "0xe03b5";
const reads: Array<{ method: string; params?: unknown[] }> = [];

function slotWord(implementation: Address): Hex {
  return `0x${"00".repeat(12)}${implementation.slice(2)}` as Hex;
}

beforeEach(() => {
  writeSpy.mockReset();
  writeAsyncSpy.mockReset();
  reads.length = 0;
  liveImplementation = IMPL;
  providerChain = "0xe03b5";
  (window as unknown as { ethereum: unknown }).ethereum = {
    request: ({ method, params }: { method: string; params?: unknown[] }) => {
      reads.push({ method, params });
      if (method === "eth_chainId") return Promise.resolve(providerChain);
      if (method === "eth_blockNumber") return Promise.resolve("0x10");
      if (method === "eth_getCode") {
        const at = String(params?.[0]).toLowerCase();
        if (at === GATEWAY.toLowerCase()) return Promise.resolve(GATEWAY_CODE);
        if (at === liveImplementation.toLowerCase()) return Promise.resolve(IMPL_CODE);
        return Promise.resolve("0x");
      }
      if (method === "eth_getStorageAt") return Promise.resolve(slotWord(liveImplementation));
      return Promise.reject(new Error(`unexpected ${method}`));
    },
  };
});

afterEach(() => {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

const verified: VerificationState = {
  status: "verified",
  computedHash: keccak256(GATEWAY_CODE),
  implementation: IMPL,
  implementationCodeHash: keccak256(IMPL_CODE),
};

const common = {
  gatewayAddress: GATEWAY,
  vaultAddress: VAULT,
  gatewayVerificationState: verified,
  envClass: "devnet" as const,
  now: 1_893_456_000_000,
};

/** AdminFlow: enter the agent, open the Revoke tab, send. */
async function revokeFromAdminFlow(state: VerificationState = verified) {
  render(<AdminFlow {...common} gatewayVerificationState={state} flagEnv={{}} />);
  fireEvent.change(screen.getByTestId("agent-input"), { target: { value: AGENT } });
  fireEvent.click(screen.getByTestId("tab-revoke"));
  await waitFor(() => expect(screen.getByTestId("revoke-submit")).not.toBeDisabled());
  fireEvent.click(screen.getByTestId("revoke-submit"));
}

/**
 * AgentsPanel (onboarding): the wallet registers itself as the agent (no separate consent is
 * needed), freezes the inputs, and signs the commit. The share receiver is the wallet (ACL-9).
 */
async function commitFromAgentsPanel() {
  render(<AgentsPanel {...common} flagEnv={{ VITE_FORCE_ONBOARDING: "1" }} />);
  fireEvent.click(screen.getByTestId("step-1-next"));
  fireEvent.change(screen.getByTestId("wizard-agent-input"), { target: { value: USER } });
  fireEvent.change(screen.getByTestId("wizard-shareReceiver-input"), {
    target: { value: USER },
  });
  fireEvent.change(screen.getByTestId("wizard-destination-extra"), {
    target: { value: "0x4444444444444444444444444444444444444444" },
  });
  fireEvent.click(screen.getByTestId("step-2-next"));
  await waitFor(() => expect(screen.getByTestId("wizard-freeze")).not.toBeDisabled());
  fireEvent.click(screen.getByTestId("wizard-freeze"));
  await waitFor(() => expect(screen.getByTestId("wizard-commit-submit")).not.toBeDisabled());
  fireEvent.click(screen.getByTestId("wizard-commit-submit"));
}

/** The latest-block re-verify read the implementation slot. */
function slotWasReread() {
  return reads.some((r) => r.method === "eth_getStorageAt" && r.params?.[0] === GATEWAY);
}

describe("admin writes re-verify the gateway at the latest block (issue 1840)", () => {
  it("AdminFlow sends the write when the implementation is unchanged", async () => {
    await revokeFromAdminFlow();
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    expect(slotWasReread()).toBe(true);
    expect((writeSpy.mock.calls[0][0] as { functionName: string }).functionName).toBe(
      "revokeAgent",
    );
  });

  it("AdminFlow refuses the write when the implementation was upgraded", async () => {
    liveImplementation = UPGRADED_IMPL;
    await revokeFromAdminFlow();
    await waitFor(() => expect(slotWasReread()).toBe(true));
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("AgentsPanel sends the commit when the implementation is unchanged", async () => {
    await commitFromAgentsPanel();
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    expect(slotWasReread()).toBe(true);
    expect((writeSpy.mock.calls[0][0] as { functionName: string }).functionName).toBe(
      "commitAuthorization",
    );
  });

  it("AgentsPanel refuses the commit when the implementation was upgraded", async () => {
    liveImplementation = UPGRADED_IMPL;
    await commitFromAgentsPanel();
    await waitFor(() => expect(slotWasReread()).toBe(true));
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("AdminFlow refuses a gateway write when the cached state is not verified", async () => {
    const refused: VerificationState = {
      status: "refused",
      reason: "unknown_revert",
      cause: "hash-mismatch",
    };
    render(<AdminFlow {...common} gatewayVerificationState={refused} flagEnv={{}} />);
    fireEvent.change(screen.getByTestId("agent-input"), { target: { value: AGENT } });
    fireEvent.click(screen.getByTestId("tab-revoke"));
    await waitFor(() => expect(screen.getByTestId("revoke-submit")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("revoke-submit"));
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(writeSpy).not.toHaveBeenCalled();
  });
});

const TIMELOCK = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
const SAFE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e" as Address;
const USDC = "0x5555555555555555555555555555555555555555" as Address;

/** A write of `target` from inside the check AdminFlow installs. */
function writeInside(state: VerificationState, target: Address) {
  let write: ReturnType<typeof useGuardedWriteContract> | undefined;
  function Probe() {
    write = useGuardedWriteContract();
    return null;
  }
  render(
    <GatewayWriteCheck gatewayAddress={GATEWAY} verification={state}>
      <Probe />
    </GatewayWriteCheck>,
  );
  const variables = { address: target, abi: [], functionName: "x", args: [] };
  write!.writeContract(variables as never);
}

/** A Timelock schedule that forwards a call to `inner`. */
function scheduleInside(state: VerificationState, inner: Address) {
  let write: ReturnType<typeof useGuardedWriteContract> | undefined;
  function Probe() {
    write = useGuardedWriteContract();
    return null;
  }
  render(
    <GatewayWriteCheck gatewayAddress={GATEWAY} verification={state}>
      <Probe />
    </GatewayWriteCheck>,
  );
  const variables = {
    address: TIMELOCK,
    abi: [],
    functionName: "schedule",
    args: [inner, 0n, "0x", "0x00", "0x00", 1n],
  };
  write!.writeContract(variables as never);
}

/** Calls the check the way the Safe proposal panel does before it signs. */
async function safeSignature(state: VerificationState, nested: Address) {
  let check: ReturnType<typeof useGatewayWriteCheck>;
  function Probe() {
    check = useGatewayWriteCheck();
    return null;
  }
  render(
    <GatewayWriteCheck gatewayAddress={GATEWAY} verification={state}>
      <Probe />
    </GatewayWriteCheck>,
  );
  return check!({
    target: SAFE,
    nestedTarget: nested,
    provider: (window as unknown as { ethereum: never }).ethereum,
    chainId: 918453,
  });
}

const gatewayReads = () => reads.filter((r) => r.params?.[0] === GATEWAY);
const nap = () => act(() => new Promise((r) => setTimeout(r, 100)));

describe("gateway-write-reverify: only gateway operations need the gateway (issue 1892)", () => {
  const unverified: VerificationState = {
    status: "refused",
    reason: "unknown_revert",
    cause: "hash-mismatch",
  };
  const absent: VerificationState = { status: "idle" };

  // Absent, unverified and changed (the live implementation differs) gateways.
  const states: Array<[string, VerificationState, Address]> = [
    ["absent", absent, IMPL],
    ["unverified", unverified, IMPL],
    ["changed", verified, UPGRADED_IMPL],
  ];

  describe.each(states)("with a %s gateway", (_n, state, live) => {
    beforeEach(() => {
      liveImplementation = live;
    });

    it.each([
      ["the Timelock", TIMELOCK],
      ["the Safe", SAFE],
      ["a vault", VAULT],
      ["a token (approve)", USDC],
    ])("sends a write to %s and reads nothing at the gateway", async (_name, target) => {
      writeInside(state, target);
      await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
      expect(gatewayReads()).toEqual([]);
    });

    it("signs a Safe proposal for a vaults-system target and reads nothing at the gateway", async () => {
      await expect(safeSignature(state, VAULT)).resolves.toBeUndefined();
      expect(gatewayReads()).toEqual([]);
    });
  });

  it("makes no gateway read when the wallet provider cannot read the gateway", async () => {
    (window as unknown as { ethereum: { request: () => Promise<never> } }).ethereum = {
      request: () => Promise.reject(new Error("rpc down")),
    };
    writeInside(verified, VAULT);
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
  });

  it("refuses a gateway send when the gateway is not verified", async () => {
    writeInside(unverified, GATEWAY);
    await nap();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("refuses a gateway send when the gateway changed", async () => {
    liveImplementation = UPGRADED_IMPL;
    writeInside(verified, GATEWAY);
    await waitFor(() => expect(slotWasReread()).toBe(true));
    await nap();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("sends a gateway write when the gateway is verified and unchanged", async () => {
    writeInside(verified, GATEWAY);
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    expect(slotWasReread()).toBe(true);
  });

  it("refuses a Timelock schedule that targets the gateway when the gateway changed", async () => {
    liveImplementation = UPGRADED_IMPL;
    scheduleInside(verified, GATEWAY);
    await nap();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("refuses a gateway-targeted Safe signature when the gateway changed or is unverified", async () => {
    liveImplementation = UPGRADED_IMPL;
    await expect(safeSignature(verified, GATEWAY)).rejects.toThrow();
    await expect(safeSignature(unverified, GATEWAY)).rejects.toThrow();
  });

  it("refuses a gateway write when the wallet provider answers for another chain", async () => {
    providerChain = "0x1";
    writeInside(verified, GATEWAY);
    await nap();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
