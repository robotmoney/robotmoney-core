/**
 * Snapshot test — pauseDeposits / unpauseDeposits TxPreview rendering.
 *
 * Covers issue #82 acceptance criterion:
 *   "Vitest unit tests snapshot the preview component output for both
 *    pause and unpause inputs."
 *
 * Asserts:
 *   - The structured preview block renders with target, selector,
 *     decoded effect, and (collapsed) calldata.
 *   - The encoded calldata equals the well-known 4-byte selector for
 *     pauseDeposits()/unpauseDeposits() — guarantees the dapp signs
 *     exactly the bytes the operator expects.
 *   - The effect copy says withdrawals stay open (core 1494).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "./helpers/render";
import { encodeFunctionData, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PauseFlow } from "../../src/components/PauseFlow";
import { TxPreview } from "../../src/components/TxPreview";
import { buildSafeTx } from "../../src/lib/safeProposal";
import type { SafeContext } from "../../src/lib/safeProposalChain";
import { gatewayAbi } from "../../src/lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../../src/lib/preview";

const gateway = "0x1111111111111111111111111111111111111111" as const;

// Wallet state for the PauseFlow block (core 1544). The preview tests above do not use wagmi.
const wallet = vi.hoisted(() => {
  const account: {
    isConnected: boolean;
    address?: `0x${string}`;
    connector?: { getProvider: () => Promise<unknown> };
  } = { isConnected: false };
  return {
    requests: [] as Array<{ method: string; params?: readonly unknown[] }>,
    account,
    writeContract: vi.fn(),
    writeContractAsync: vi.fn(),
    ctx: undefined as unknown,
  };
});
const client = vi.hoisted(() => ({
  readContract: undefined as unknown as (a: {
    functionName: string;
    args?: readonly unknown[];
  }) => Promise<unknown>,
  getChainId: async () => 918453,
  getCode: async () => "0x6001" as const,
  getStorageAt: async () => "0x" as const,
}));

vi.mock("wagmi", () => ({
  useAccount: () => wallet.account,
  useChainId: () => 918453,
  usePublicClient: () => client,
  useReadContract: () => ({ data: false }),
  useSimulateContract: () => ({ data: undefined }),
  useWriteContract: () => ({
    writeContract: wallet.writeContract,
    writeContractAsync: wallet.writeContractAsync,
    isPending: false,
  }),
}));
vi.mock("../../src/lib/safeProposalChain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/safeProposalChain")>();
  return { ...actual, loadSafeContext: vi.fn(async () => wallet.ctx as SafeContext) };
});

const ctx: PreviewContext = {
  gateway,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const cases: { name: "pauseDeposits" | "unpauseDeposits"; action: AdminAction }[] = [
  { name: "pauseDeposits", action: { kind: "pauseDeposits" } },
  { name: "unpauseDeposits", action: { kind: "unpauseDeposits" } },
];

describe("TxPreview snapshot — pauseDeposits/unpauseDeposits", () => {
  for (const { name, action } of cases) {
    it(`renders structured preview for ${name}`, () => {
      const preview = buildPreview(action, ctx);
      const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);

      // Structured fields exist.
      expect(getByTestId("tx-preview-target").textContent).toContain(gateway);
      expect(getByTestId("tx-preview-fn").textContent).toBe(name);
      expect(getByTestId("tx-preview-effect").textContent).toMatch(/Withdrawals (stay|were) open/);
      expect(queryByTestId("refusal-reason")).toBeNull();

      // Selector matches the canonical 4-byte function selector.
      const fn = gatewayAbi.find((e) => e.type === "function" && e.name === name);
      const expectedSelector = toFunctionSelector(fn as never);
      expect(getByTestId("tx-preview-selector").textContent).toBe(expectedSelector);

      // Calldata equals the encoder output for the intended call. For
      // pauseDeposits()/unpauseDeposits() the calldata is exactly the 4-byte selector
      // (no args), so this is a strict equality check.
      const expectedCalldata = encodeFunctionData({
        abi: gatewayAbi,
        functionName: name,
        args: [],
      });
      expect(getByTestId("tx-preview-calldata").textContent).toBe(expectedCalldata);
      expect(expectedCalldata).toBe(expectedSelector);
    });

    it(`refuses ${name} when bytecode is unverified`, () => {
      const preview = buildPreview(action, { ...ctx, gatewayCodeHashVerified: false });
      const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);
      expect(getByTestId("refusal-reason").textContent).toMatch(/bytecode/i);
      expect(queryByTestId("tx-preview-fn")).toBeNull();
    });
  }
});

describe("PauseFlow — unpause is a Safe proposal, never a wallet transaction (core 1544)", () => {
  const OWNER = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const SAFE = "0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE" as Address;
  const TIMELOCK = "0x7172717271727172717271727172717271727172" as Address;

  function connect(address: Address) {
    wallet.account = {
      isConnected: true,
      address,
      connector: {
        getProvider: async () => ({
          request: async (req: { method: string; params?: readonly unknown[] }) => {
            wallet.requests.push(req);
            if (req.method !== "eth_signTypedData_v4") throw new Error(`unexpected ${req.method}`);
            return OWNER.signTypedData(JSON.parse(String((req.params ?? [])[1])));
          },
        }),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    wallet.requests.length = 0;
    wallet.account = { isConnected: false };
    wallet.ctx = {
      chainId: 918453,
      safe: SAFE,
      timelock: TIMELOCK,
      version: "1.4.1",
      owners: [OWNER.address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
      threshold: 2,
      nonce: 9n,
      codehash: "0x00",
      singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
      canonical: true,
      minDelay: 172800n,
      hasProposerRole: true,
      hasExecutorRole: true,
    } satisfies SafeContext;
    client.readContract = async (a) => {
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

  it("unpause calls only eth_signTypedData_v4, never eth_sign, personal_sign or eth_sendTransaction", async () => {
    connect(OWNER.address);
    render(
      <PauseFlow
        gatewayAddress={gateway}
        gatewayCodeHashVerified
        envClass="fork"
        safeAddress={SAFE}
        timelockAddress={TIMELOCK}
      />,
    );
    const button = await screen.findByTestId("unpause-submit");
    expect(button.textContent).toBe("Create Safe proposal");
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId("unpause-signature-count").textContent).toContain("1 of 2"),
    );
    const methods = wallet.requests.map((r) => r.method);
    expect(methods).toEqual(["eth_signTypedData_v4"]);
    expect(methods).not.toContain("eth_sign");
    expect(methods).not.toContain("personal_sign");
    expect(methods).not.toContain("eth_sendTransaction");
    expect(wallet.writeContract).not.toHaveBeenCalled();
    expect(wallet.writeContractAsync).not.toHaveBeenCalled();
  });

  it("renders a blocking preview with no button when the Safe address is missing from config", () => {
    connect(OWNER.address);
    render(<PauseFlow gatewayAddress={gateway} gatewayCodeHashVerified envClass="fork" />);
    expect(screen.getByTestId("unpause-form")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("unpause-form")).getByTestId("tx-preview-fn").textContent,
    ).toBe("unpauseDeposits");
    expect(screen.getByTestId("unpause-safe-blocked-reason").textContent).toContain(
      "VITE_SAFE_ADDRESS",
    );
    expect(screen.queryByTestId("unpause-submit")).toBeNull();
    expect(wallet.requests).toHaveLength(0);
  });
});
