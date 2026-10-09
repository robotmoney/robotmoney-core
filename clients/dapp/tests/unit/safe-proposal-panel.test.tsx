/**
 * Unit tests — SafeProposalPanel carries the live min delay and the predecessor (core 1544).
 *
 * The delay must be the timelock's getMinDelay() (here 3600, not the 172800 the
 * other suites use) and the predecessor must be what the caller passed (zero for
 * schedule; the scheduled one for execute). The panel's displayed rows, the
 * typed data the wallet is asked to sign and the operation id must all agree.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { render, screen, fireEvent, waitFor } from "./helpers/render";
import { SafeProposalPanel } from "../../src/components/SafeProposalPanel";
import { buildSafeTx, timelockCallAbi, timelockOperationId } from "../../src/lib/safeProposal";
import type { SafeContext } from "../../src/lib/safeProposalChain";

const OWNER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const SAFE = "0x5afe5afE5afE5afE5afE5aFe5aFe5Afe5Afe5AfE" as Address;
const TIMELOCK = "0x7172717271727172717271727172717271727172" as Address;
const TARGET = "0x1111111111111111111111111111111111111111" as Address;
const INNER =
  "0x2f2ff15d39d7c99df860586d89a6559d1f1be4c1787de0c0cafbcd46bfce1ec1f971e2380000000000000000000000002222222222222222222222222222222222222222" as Hex;
const ZERO32 = `0x${"00".repeat(32)}` as Hex;
// Vectors from foundry cast (see safe-proposal.test.ts).
const PRED = "0x9ab40b06a76192a7ac7324f1d4f8ebca7bc4c0702ecc74c95d6af6e636d76235" as Hex;
const SALT = "0xb6e88ac5957d805585f52aecb6e457aa81819fb8d46f683b0ee39ecf3ce3b95a" as Hex;
const CAST_OPERATION_ID = "0x35c0f202d4cdb1ce4e07f1d1d4a47c2e047136737f21cbc5fd49f919c781ade5";
const MIN_DELAY = 3600n;

const state = vi.hoisted(() => {
  const requests: Array<{ method: string; params?: readonly unknown[] }> = [];
  const account: {
    isConnected: boolean;
    address?: `0x${string}`;
    connector?: { getProvider: () => Promise<unknown> };
  } = { isConnected: false };
  return { requests, account, ctx: undefined as unknown };
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
  useAccount: () => state.account,
  usePublicClient: () => client,
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));
vi.mock("../../src/lib/safeProposalChain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/safeProposalChain")>();
  return { ...actual, loadSafeContext: vi.fn(async () => state.ctx as SafeContext) };
});

function ctx(): SafeContext {
  return {
    chainId: 918453,
    safe: SAFE,
    timelock: TIMELOCK,
    version: "1.4.1",
    owners: [OWNER.address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
    threshold: 2,
    nonce: 6n,
    codehash: "0x00",
    singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    canonical: true,
    minDelay: MIN_DELAY,
    hasProposerRole: true,
    hasExecutorRole: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.requests.length = 0;
  state.ctx = ctx();
  state.account = {
    isConnected: true,
    address: OWNER.address,
    connector: {
      getProvider: async () => ({
        request: async (req: { method: string; params?: readonly unknown[] }) => {
          state.requests.push(req);
          return OWNER.signTypedData(JSON.parse(String((req.params ?? [])[1])));
        },
      }),
    },
  };
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

async function shownTypedData(prefix: string) {
  const el = await screen.findByTestId(`${prefix}-typed-data`);
  const message = (JSON.parse(el.textContent ?? "{}") as { message: { data: Hex } }).message;
  return { message, decoded: decodeFunctionData({ abi: timelockCallAbi, data: message.data }) };
}

describe("SafeProposalPanel — schedule uses the live getMinDelay and a zero predecessor", () => {
  it("encodes delay 3600 (not 172800) and predecessor 0x00..00, and shows both", async () => {
    render(
      <SafeProposalPanel
        testId="p"
        safeAddress={SAFE}
        timelockAddress={TIMELOCK}
        request={{
          kind: "schedule",
          target: TARGET,
          data: INNER,
          action: "schedule",
          description: "x",
        }}
      />,
    );
    const { message, decoded } = await shownTypedData("p");
    const args = decoded.args as readonly unknown[];
    expect(decoded.functionName).toBe("schedule");
    expect(args[5]).toBe(MIN_DELAY);
    expect(args[3]).toBe(ZERO32);
    expect(screen.getByTestId("p-timelock-min-delay").textContent).toContain("3600");
    expect(screen.getByTestId("p-timelock-predecessor").textContent).toBe(ZERO32);
    // The displayed operation id is the id of exactly what is encoded.
    expect(screen.getByTestId("p-timelock-operation-id").textContent).toBe(
      timelockOperationId({
        target: TARGET,
        data: INNER,
        predecessor: args[3] as Hex,
        salt: args[4] as Hex,
      }),
    );
    expect(screen.getByTestId("p-timelock-salt").textContent).toBe(args[4]);

    // The wallet is asked to sign the same bytes.
    const button = screen.getByTestId("p-submit");
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(state.requests).toHaveLength(1));
    const signed = JSON.parse(String((state.requests[0]?.params ?? [])[1])) as {
      message: { data: Hex };
    };
    expect(signed.message.data).toBe(message.data);
  });
});

describe("SafeProposalPanel — execute carries the scheduled predecessor and salt", () => {
  it("shows the non-zero predecessor and the cast operation id, and signs calldata that carries them", async () => {
    render(
      <SafeProposalPanel
        testId="x"
        safeAddress={SAFE}
        timelockAddress={TIMELOCK}
        request={{
          kind: "execute",
          target: TARGET,
          data: INNER,
          predecessor: PRED,
          salt: SALT,
          action: "execute",
          description: "x",
        }}
      />,
    );
    const { decoded } = await shownTypedData("x");
    const args = decoded.args as readonly unknown[];
    expect(decoded.functionName).toBe("execute");
    expect(args[3]).toBe(PRED);
    expect(args[4]).toBe(SALT);
    expect(screen.getByTestId("x-timelock-predecessor").textContent).toBe(PRED);
    expect(screen.getByTestId("x-timelock-salt").textContent).toBe(SALT);
    expect(screen.getByTestId("x-timelock-operation-id").textContent).toBe(CAST_OPERATION_ID);

    const button = screen.getByTestId("x-submit");
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(state.requests).toHaveLength(1));
    const signed = JSON.parse(String((state.requests[0]?.params ?? [])[1])) as {
      message: { data: Hex };
    };
    const signedArgs = decodeFunctionData({ abi: timelockCallAbi, data: signed.message.data })
      .args as readonly unknown[];
    expect(signedArgs[3]).toBe(PRED);
    expect(signedArgs[4]).toBe(SALT);
  });
});
