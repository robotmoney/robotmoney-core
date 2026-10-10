// No write is ever sent when the wallet is not on Base on the mainnet class (issue 1729).
// Real wagmi, a fake `mock` connector that can sit on chain 1 / 918453 / 8453, and a
// recording transport: the test asserts on what actually reaches the wallet/RPC.
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, custom, useAccount, useConnect } from "wagmi";
import { mock } from "wagmi/connectors";
import { base as wagmiBase, mainnet as wagmiMainnet } from "wagmi/chains";
import { defineChain, type Address } from "viem";
import { RuntimeConfigProvider } from "../../src/lib/RuntimeConfigContext";
import { useGuardedWriteContract } from "../../src/lib/useGuardedWriteContract";
import { WrongChainGate } from "../../src/components/WrongChainGate";

const devnet = defineChain({
  id: 918453,
  name: "Robot Money devnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://localhost:8545"] } },
});
// The `mock` connector sends through each chain's own first RPC URL. Point every chain at a
// closed local port so no test can reach a real chain.
const DEAD = { default: { http: ["http://127.0.0.1:1"] } };
const base = defineChain({ ...wagmiBase, rpcUrls: DEAD });
const mainnet = defineChain({ ...wagmiMainnet, rpcUrls: DEAD });
const USER = "0x1111111111111111111111111111111111111111" as const;
const TARGET = "0x2222222222222222222222222222222222222222" as Address;
const abi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "a", type: "uint256" }],
    outputs: [],
  },
] as const;

const WRITE_METHODS = [
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_signTransaction",
  "eth_estimateGas",
  "eth_signTypedData_v4",
];

function setup(chainId: number, envClass: string, code: string | null = "0x6001") {
  const requests: Array<{ chainId: number; method: string }> = [];
  const t = (id: number) =>
    custom({
      request: async ({ method }: { method: string }) => {
        requests.push({ chainId: id, method });
        if (method === "eth_chainId") return `0x${id.toString(16)}`;
        if (method === "eth_getCode") return code;
        if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
        return null;
      },
    });
  const config = createConfig({
    chains: [base, mainnet, devnet],
    connectors: [mock({ accounts: [USER] })],
    transports: { [base.id]: t(base.id), [mainnet.id]: t(mainnet.id), [devnet.id]: t(devnet.id) },
  });
  // Every wallet send goes to a chain RPC URL over fetch: record the JSON-RPC methods and fail them.
  const fetched: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    let method = "unparsed";
    let id: unknown = 1;
    try {
      const body = JSON.parse(String(init?.body)) as { method: string; id: unknown };
      method = body.method;
      id = body.id;
    } catch {
      /* not JSON-RPC */
    }
    fetched.push(method);
    if (method === "eth_getCode") {
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: "2.0", id, result: code }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.reject(new TypeError("blocked by test"));
  });
  let write: ReturnType<typeof useGuardedWriteContract> | undefined;
  function Probe() {
    const { connect, connectors } = useConnect();
    const { isConnected, chainId: c } = useAccount();
    write = useGuardedWriteContract();
    return (
      <div>
        <button
          type="button"
          data-testid="go"
          onClick={() => connect({ connector: connectors[0], chainId })}
        >
          connect
        </button>
        <span data-testid="state">{isConnected ? `connected:${c}` : "off"}</span>
      </div>
    );
  }
  render(
    <WagmiProvider config={config}>
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeConfigProvider config={{ VITE_ENV_CLASS: envClass }}>
          <Probe />
          <WrongChainGate>
            <p data-testid="app-body">app</p>
          </WrongChainGate>
        </RuntimeConfigProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
  return { requests, fetched, getWrite: () => write! };
}

async function connected(chainId: number, envClass: string, code: string | null = "0x6001") {
  const h = setup(chainId, envClass, code);
  await act(async () => screen.getByTestId("go").click());
  await waitFor(() =>
    expect(screen.getByTestId("state")).toHaveTextContent(`connected:${chainId}`),
  );
  return h;
}

let nextTarget = 0x1000;
const fresh = (): {
  address: Address;
  abi: typeof abi;
  functionName: "deposit";
  args: readonly [bigint];
} => ({
  // a new target per call: the hook remembers targets that had code
  address: `0x${(nextTarget += 1).toString(16).padStart(40, "0")}` as Address,
  abi,
  functionName: "deposit",
  args: [1n],
});
const call = { address: TARGET, abi, functionName: "deposit", args: [1n] } as const;

describe("useGuardedWriteContract on the mainnet class", () => {
  it.each([1, 918453])("sends NO write when the wallet is on chain %i", async (chainId) => {
    const { requests, fetched, getWrite } = await connected(chainId, "mainnet");
    let errors = 0;
    const onError = () => {
      errors += 1;
    };
    await act(async () => getWrite().writeContract(call, { onError }));
    let rejected = "";
    await act(async () => {
      await getWrite()
        .writeContractAsync(call)
        .catch((e: Error) => {
          rejected = e.message;
        });
    });
    expect(rejected).toMatch(/Switch your wallet to Base/);
    expect(errors).toBe(1);
    expect(requests.filter((r) => WRITE_METHODS.includes(r.method))).toEqual([]);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
    expect(getWrite().writeBlocked).toBe(true);
    // the app body is replaced by the switch prompt, so no wrong-chain reads are displayed
    expect(screen.queryByTestId("app-body")).toBeNull();
    expect(screen.getByTestId("wrong-chain-gate")).toHaveTextContent(
      "Switch your wallet to Base (chain 8453)",
    );
    expect(screen.getByTestId("wrong-chain-switch")).toBeEnabled();
  });

  it("lets the write through, pinned to 8453, when the wallet is on Base", async () => {
    const { fetched, getWrite } = await connected(8453, "mainnet");
    expect(screen.getByTestId("app-body")).toBeInTheDocument();
    expect(screen.queryByTestId("wrong-chain-gate")).toBeNull();
    expect(getWrite().writeBlocked).toBe(false);
    // The caller asks for chain 1. The guard pins the write to 8453, so wagmi does not
    // raise a chain mismatch and the call reaches the wallet transport (which then
    // fails to estimate gas against the recording stub, after the guard).
    let message = "";
    await act(async () => {
      await getWrite()
        .writeContractAsync({ ...fresh(), chainId: 1 })
        .catch((e: Error) => {
          message = `${e.name}: ${e.message.slice(0, 400)}`;
        });
    });
    expect(message).not.toMatch(/WrongChainError|ChainMismatch|does not match the target chain/);
    // The send was attempted against Base's (dead, local) RPC URL, i.e. it reached the wallet.
    expect(message).toMatch(/127\.0\.0\.1:1/);
    expect(fetched).toContain("eth_sendTransaction");
  });
});

describe("useGuardedWriteContract target code check (issue 1729)", () => {
  it.each([null, "0x"])("refuses a target with no code (%s) and sends nothing", async (code) => {
    const { fetched, getWrite } = await connected(8453, "mainnet", code);
    let refused: Error | undefined;
    await act(async () => {
      await getWrite()
        .writeContractAsync(fresh())
        .catch((e: Error) => {
          refused = e;
        });
    });
    expect(refused?.name).toBe("WriteTargetCodeError");
    expect(refused?.message).toMatch(/no contract code/);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("the callback form reports the refusal through onError and sends nothing", async () => {
    const { fetched, getWrite } = await connected(8453, "mainnet", "0x");
    let errors = 0;
    await act(async () => {
      getWrite().writeContract(fresh(), {
        onError: () => {
          errors += 1;
        },
      });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(errors).toBe(1);
    expect(getWrite().error?.name).toBe("WriteTargetCodeError");
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });
});

describe("useGuardedWriteContract on other classes", () => {
  it("does not block or gate (behaviour unchanged)", async () => {
    const { getWrite } = await connected(1, "devnet");
    expect(getWrite().writeBlocked).toBe(false);
    expect(screen.getByTestId("app-body")).toBeInTheDocument();
    expect(screen.queryByTestId("wrong-chain-gate")).toBeNull();
  });
});
