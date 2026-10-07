/**
 * Unit tests — RoleTab (issue #254, reworked for core 1544).
 *
 * After the timelock handover a browser wallet cannot grant or revoke a role on
 * the gateway. RoleTab therefore builds a Safe -> Timelock proposal. These tests
 * pin the signing surface:
 *  - the grant and revoke buttons ("Create Safe proposal") ask the connected
 *    wallet for `eth_signTypedData_v4` and for nothing else: never `eth_sign`,
 *    `personal_sign` or `eth_sendTransaction`;
 *  - a missing Safe address renders the preview plus a blocking message and NO
 *    button;
 *  - a wallet that is not a Safe owner is refused before any signature request.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { render, screen, fireEvent, waitFor } from "../helpers/render";
import { RoleTab } from "../../../src/components/RoleTab";
import type { PreviewContext } from "../../../src/lib/preview";
import type { RoleName } from "../../../src/lib/abi";
import { buildSafeTx } from "../../../src/lib/safeProposal";
import type { SafeContext } from "../../../src/lib/safeProposalChain";

const OWNER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OWNER = privateKeyToAccount(OWNER_KEY);
const OTHER_OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const NON_OWNER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const SAFE = "0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE" as Address;
const TIMELOCK = "0x7172717271727172717271727172717271727172" as Address;
const GATEWAY = "0x1111111111111111111111111111111111111111" as const;
const TARGET = "0x3333333333333333333333333333333333333333";

// Per-test wallet state, hoisted for the vi.mock factories.
const state = vi.hoisted(() => {
  const requests: Array<{ method: string; params?: readonly unknown[] }> = [];
  const account: {
    isConnected: boolean;
    address?: `0x${string}`;
    connector?: { getProvider: () => Promise<unknown> };
  } = { isConnected: false };
  return {
    requests,
    account,
    writeContractAsync: vi.fn(),
    ctx: undefined as unknown,
    sign: undefined as undefined | ((json: string) => Promise<string>),
  };
});

const publicClient = vi.hoisted(() => ({
  readContract: undefined as unknown as (a: {
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>,
  getChainId: async () => 918453,
  getCode: async () => "0x6001" as const,
  getStorageAt: async () => "0x" as const,
  simulateContract: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock("wagmi", () => ({
  useAccount: () => state.account,
  usePublicClient: () => publicClient,
  useWriteContract: () => ({ writeContractAsync: state.writeContractAsync }),
}));

// The chain reads need canonical SafeL2 bytecode, which a unit test cannot forge.
// Mock only the context loader; the refusals and the digest check stay real.
vi.mock("../../../src/lib/safeProposalChain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/safeProposalChain")>();
  return { ...actual, loadSafeContext: vi.fn(async () => state.ctx as SafeContext) };
});

const ctx: PreviewContext = {
  gateway: GATEWAY,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

function safeContext(over: Partial<SafeContext> = {}): SafeContext {
  return {
    chainId: 918453,
    safe: SAFE,
    timelock: TIMELOCK,
    version: "1.4.1",
    owners: [OWNER.address, OTHER_OWNER],
    threshold: 2,
    nonce: 4n,
    codehash: "0x00",
    singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    canonical: true,
    minDelay: 172800n,
    hasProposerRole: true,
    hasExecutorRole: true,
    ...over,
  };
}

function connect(address: Address) {
  state.account = {
    isConnected: true,
    address,
    connector: {
      getProvider: async () => ({
        request: async (req: { method: string; params?: readonly unknown[] }) => {
          state.requests.push(req);
          if (req.method !== "eth_signTypedData_v4") throw new Error(`unexpected ${req.method}`);
          const json = (req.params ?? [])[1];
          if (typeof json !== "string") throw new Error("typed data must be a JSON string");
          return OWNER.signTypedData(JSON.parse(json));
        },
      }),
    },
  };
}

function renderTab(role: RoleName, withSafe = true) {
  return render(
    <RoleTab
      role={role}
      gatewayAddress={GATEWAY}
      ctx={ctx}
      safeAddress={withSafe ? SAFE : undefined}
      timelockAddress={withSafe ? TIMELOCK : undefined}
      description={<span>Role description</span>}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.requests.length = 0;
  state.account = { isConnected: false };
  state.ctx = safeContext();
  // Safe.getTransactionHash, computed from the same fields the chain would use.
  publicClient.readContract = async (a) => {
    if (a.functionName !== "getTransactionHash") throw new Error(`unmocked read ${a.functionName}`);
    const args = a.args ?? [];
    return buildSafeTx({
      chainId: 918453,
      safe: SAFE,
      timelock: TIMELOCK,
      to: args[0] as Address,
      data: args[2] as Hex,
      nonce: args[9] as bigint,
    }).safeTxHash;
  };
});

describe.each([
  ["ADMIN_ROLE", "admin"],
  ["DEPOSIT_PAUSER_ROLE", "pauser"],
] as const)("RoleTab %s — Create Safe proposal", (role, slug) => {
  it("renders the form slugs and no proposal until an address is typed", () => {
    renderTab(role);
    expect(screen.getByTestId(`${slug}-role-form`)).toBeInTheDocument();
    expect(screen.getByTestId(`${slug}-account-input`)).toBeInTheDocument();
    expect(screen.queryByTestId(`grant-${slug}-submit`)).toBeNull();
    expect(screen.queryByTestId(`revoke-${slug}-submit`)).toBeNull();
  });

  it.each(["grant", "revoke"] as const)(
    "%s calls only eth_signTypedData_v4, never eth_sign, personal_sign or eth_sendTransaction",
    async (verb) => {
      connect(OWNER.address);
      renderTab(role);
      fireEvent.change(screen.getByTestId(`${slug}-account-input`), { target: { value: TARGET } });

      const button = await screen.findByTestId(`${verb}-${slug}-submit`);
      expect(button.textContent).toBe("Create Safe proposal");
      await waitFor(() => expect(button).toBeEnabled());
      // The preview rows include the Safe and timelock rows.
      expect(screen.getByTestId(`${verb}-${slug}-safe-address`).textContent).toBe(SAFE);
      expect(screen.getByTestId(`${verb}-${slug}-timelock-address`).textContent).toBe(TIMELOCK);
      expect(screen.getByTestId(`${verb}-${slug}-safe-threshold`).textContent).toBe("2 of 2");
      expect(screen.getByTestId(`${verb}-${slug}-timelock-min-delay`).textContent).toContain(
        "172800",
      );

      fireEvent.click(button);
      await waitFor(() =>
        expect(screen.getByTestId(`${verb}-${slug}-signature-count`).textContent).toContain(
          "1 of 2",
        ),
      );

      const methods = state.requests.map((r) => r.method);
      expect(methods).toEqual(["eth_signTypedData_v4"]);
      expect(methods).not.toContain("eth_sign");
      expect(methods).not.toContain("personal_sign");
      expect(methods).not.toContain("eth_sendTransaction");
      expect(state.writeContractAsync).not.toHaveBeenCalled();

      // The wallet was asked to sign exactly the typed data the dapp rendered.
      const shown = screen.getByTestId(`${verb}-${slug}-typed-data`).textContent ?? "";
      const asked = (state.requests[0]?.params ?? [])[1];
      expect(JSON.parse(String(asked))).toEqual(JSON.parse(shown));
      const bundle = JSON.parse(
        (screen.getByTestId(`${verb}-${slug}-bundle-json`) as HTMLTextAreaElement).value,
      ) as { format: string; safe_tx_hash: string };
      expect(bundle.format).toBe("robotmoney-safe-tx/1");
      expect(bundle.safe_tx_hash).toBe(
        screen.getByTestId(`${verb}-${slug}-safe-tx-hash`).textContent,
      );
    },
  );

  it("renders the preview and a blocking message, with no button, when the Safe address is missing", () => {
    connect(OWNER.address);
    renderTab(role, false);
    fireEvent.change(screen.getByTestId(`${slug}-account-input`), { target: { value: TARGET } });

    expect(screen.getByTestId(`grant-${slug}-preview-wrap`)).toBeInTheDocument();
    expect(screen.getByTestId(`revoke-${slug}-preview-wrap`)).toBeInTheDocument();
    expect(screen.getByTestId(`grant-${slug}-safe-blocked`)).toBeInTheDocument();
    expect(screen.getByTestId(`revoke-${slug}-safe-blocked`)).toBeInTheDocument();
    expect(screen.getByTestId(`grant-${slug}-safe-blocked-reason`).textContent).toContain(
      "VITE_SAFE_ADDRESS",
    );
    expect(screen.queryByTestId(`grant-${slug}-submit`)).toBeNull();
    expect(screen.queryByTestId(`revoke-${slug}-submit`)).toBeNull();
    expect(state.requests).toHaveLength(0);
  });

  it("refuses a wallet that is not a Safe owner before any signature request", async () => {
    connect(NON_OWNER);
    renderTab(role);
    fireEvent.change(screen.getByTestId(`${slug}-account-input`), { target: { value: TARGET } });

    const refusal = await screen.findByTestId(`grant-${slug}-safe-refusal`);
    expect(refusal.textContent).toContain("not an owner of the Safe");
    expect(screen.getByTestId(`grant-${slug}-submit`)).toBeDisabled();
    expect(state.requests).toHaveLength(0);
  });

  it("refuses a Safe that is not canonical SafeL2 v1.4.1", async () => {
    state.ctx = safeContext({ canonical: false });
    connect(OWNER.address);
    renderTab(role);
    fireEvent.change(screen.getByTestId(`${slug}-account-input`), { target: { value: TARGET } });

    const refusal = await screen.findByTestId(`grant-${slug}-safe-refusal`);
    expect(refusal.textContent).toContain("not canonical SafeL2");
    expect(screen.getByTestId(`grant-${slug}-submit`)).toBeDisabled();
    expect(state.requests).toHaveLength(0);
  });

  it("refuses a Safe without PROPOSER_ROLE on the timelock", async () => {
    state.ctx = safeContext({ hasProposerRole: false });
    connect(OWNER.address);
    renderTab(role);
    fireEvent.change(screen.getByTestId(`${slug}-account-input`), { target: { value: TARGET } });

    const refusal = await screen.findByTestId(`grant-${slug}-safe-refusal`);
    expect(refusal.textContent).toContain("PROPOSER_ROLE");
    expect(screen.getByTestId(`grant-${slug}-submit`)).toBeDisabled();
    expect(state.requests).toHaveLength(0);
  });

  it("refuses to sign when the local digest differs from Safe.getTransactionHash", async () => {
    publicClient.readContract = async () => `0x${"ab".repeat(32)}`;
    connect(OWNER.address);
    renderTab(role);
    fireEvent.change(screen.getByTestId(`${slug}-account-input`), { target: { value: TARGET } });

    const button = await screen.findByTestId(`grant-${slug}-submit`);
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    const refusal = await screen.findByTestId(`grant-${slug}-safe-refusal`);
    expect(refusal.textContent).toContain("Safe.getTransactionHash");
    expect(state.requests).toHaveLength(0);
  });
});
