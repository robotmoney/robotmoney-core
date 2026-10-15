// No write is ever sent when the wallet is not on Base on the mainnet class (issue 1729).
// Real wagmi, a fake `mock` connector that can sit on chain 1 / 918453 / 8453, and a
// recording transport: the test asserts on what actually reaches the wallet/RPC.
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, custom, useAccount, useConnect } from "wagmi";
import { mock } from "wagmi/connectors";
import { base as wagmiBase, mainnet as wagmiMainnet } from "wagmi/chains";
import {
  defineChain,
  encodeFunctionResult,
  keccak256,
  pad,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { RuntimeConfigProvider } from "../../src/lib/RuntimeConfigContext";
import { useGuardedWriteContract } from "../../src/lib/useGuardedWriteContract";
import { WrongChainGate } from "../../src/components/WrongChainGate";
import { routerAbi } from "../../src/lib/abi";
import {
  ROUTER_CODE_HASH_PIN_KEY,
  ROUTER_IMPLEMENTATION_HASH_PIN_KEY,
  VAULT_CODE_HASH_PIN_KEY,
  VAULT_IMPLEMENTATION_HASH_PIN_KEY,
  WriteTargetPinError,
} from "../../src/lib/codePins";

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

/**
 * A per-call answer for the wallet's RPC (method, params), or undefined for the default one. Lets a
 * test give each address its own code and ERC-1967 slot, and answer an `eth_call`.
 */
type RpcAnswer = (method: string, params: readonly unknown[]) => unknown;

function setup(
  chainId: number,
  envClass: string,
  code: string | null = "0x6001",
  extraConfig: Readonly<Record<string, string>> = {},
  rpc: RpcAnswer = () => undefined,
) {
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
  const sent: Array<{ gas?: string; data?: string }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    let method = "unparsed";
    let id: unknown = 1;
    let params: unknown[] = [];
    try {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        id: unknown;
        params?: Array<{ gas?: string; data?: string }>;
      };
      method = body.method;
      id = body.id;
      params = body.params ?? [];
      if (method === "eth_sendTransaction" && body.params?.[0]) sent.push(body.params[0]);
    } catch {
      /* not JSON-RPC */
    }
    fetched.push(method);
    // The pin check (codePins.ts) reads the code, the ERC-1967 slot (zero: a direct contract) and
    // the block they are read at.
    const answer: Record<string, unknown> = {
      eth_getCode: code,
      eth_blockNumber: "0x10",
      eth_getStorageAt: `0x${"0".repeat(64)}`,
    };
    const own = rpc(method, params);
    if (own !== undefined || method in answer) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result: own !== undefined ? own : answer[method] }),
          { headers: { "content-type": "application/json" } },
        ),
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
        <RuntimeConfigProvider config={{ VITE_ENV_CLASS: envClass, ...extraConfig }}>
          <Probe />
          <WrongChainGate>
            <p data-testid="app-body">app</p>
          </WrongChainGate>
        </RuntimeConfigProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
  return { requests, fetched, sent, getWrite: () => write! };
}

async function connected(
  chainId: number,
  envClass: string,
  code: string | null = "0x6001",
  extraConfig: Readonly<Record<string, string>> = {},
  rpc?: RpcAnswer,
) {
  const h = setup(chainId, envClass, code, extraConfig, rpc);
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
/**
 * The build-time pin (QA plan U5) that lets a mainnet deposit to `address` through: the hash of the
 * code the fake wallet answers with.
 */
const pinFor = (address: Address, code = "0x6001"): Record<string, string> => ({
  VITE_VAULT_EXPECTED_CODE_HASH: JSON.stringify({ [address]: keccak256(code as `0x${string}`) }),
});

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
    const target = fresh();
    const { fetched, getWrite } = await connected(
      8453,
      "mainnet",
      "0x6001",
      pinFor(target.address),
    );
    expect(screen.getByTestId("app-body")).toBeInTheDocument();
    expect(screen.queryByTestId("wrong-chain-gate")).toBeNull();
    expect(getWrite().writeBlocked).toBe(false);
    // The caller asks for chain 1. The guard pins the write to 8453, so wagmi does not
    // raise a chain mismatch and the call reaches the wallet transport (which then
    // fails to estimate gas against the recording stub, after the guard).
    let message = "";
    await act(async () => {
      await getWrite()
        .writeContractAsync({ ...target, chainId: 1 })
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

// Security round 2 (ADR-0014): `PortfolioRouter._executeLeg` forwards each leg's USDC into that
// vault and takes the vault's own `deposit()` return as the shares minted, so the per-leg floors
// cannot catch a leg that keeps the USDC. A pinned router is not enough: before a router deposit
// the guard reads `getEffectiveWeights()` at the same block and checks every leg vault's code and
// implementation, as rmpc `verify_router_and_legs` does. Removing `assertRouterLegsPinned` from
// the guard makes this test fail.
describe("useGuardedWriteContract checks every leg vault of a router deposit (security round 2)", () => {
  /** The generic ERC1967Proxy runtime at the router and every leg. */
  const PROXY_CODE = "0x6003" as Hex;
  const ROUTER_IMPL_CODE = "0x6004" as Hex;
  const LEG_IMPL_CODE = "0x6005" as Hex;
  const UNREVIEWED_IMPL_CODE = "0x6006" as Hex;
  const ZERO_SLOT = `0x${"0".repeat(64)}` as Hex;
  const WEIGHTS = toFunctionSelector("getEffectiveWeights()");
  const addr = (): Address => `0x${(nextTarget += 1).toString(16).padStart(40, "0")}` as Address;
  const same = (a: unknown, b: string): boolean =>
    typeof a === "string" && a.toLowerCase() === b.toLowerCase();

  it("refuses router.deposit naming the leg whose ERC-1967 slot points at an unpinned implementation, and nothing reaches the wallet", async () => {
    const router = addr();
    const routerImpl = addr();
    const legA = addr();
    const legB = addr();
    const reviewedLegImpl = addr();
    const unreviewedLegImpl = addr();
    // The timelock upgraded leg B to logic this build does not pin.
    let legBImpl = unreviewedLegImpl;
    const config = {
      VITE_ROUTER_ADDRESS: router,
      [ROUTER_CODE_HASH_PIN_KEY]: keccak256(PROXY_CODE),
      [ROUTER_IMPLEMENTATION_HASH_PIN_KEY]: keccak256(ROUTER_IMPL_CODE),
      [VAULT_CODE_HASH_PIN_KEY]: JSON.stringify({
        [legA]: keccak256(PROXY_CODE),
        [legB]: keccak256(PROXY_CODE),
      }),
      [VAULT_IMPLEMENTATION_HASH_PIN_KEY]: JSON.stringify({
        [legA]: keccak256(LEG_IMPL_CODE),
        [legB]: keccak256(LEG_IMPL_CODE),
      }),
    };
    const rpc: RpcAnswer = (method, params) => {
      const at = params[0];
      if (method === "eth_getCode") {
        if (same(at, routerImpl)) return ROUTER_IMPL_CODE;
        if (same(at, reviewedLegImpl)) return LEG_IMPL_CODE;
        if (same(at, unreviewedLegImpl)) return UNREVIEWED_IMPL_CODE;
        return PROXY_CODE;
      }
      if (method === "eth_getStorageAt") {
        if (same(at, router)) return pad(routerImpl, { size: 32 });
        if (same(at, legA)) return pad(reviewedLegImpl, { size: 32 });
        if (same(at, legB)) return pad(legBImpl, { size: 32 });
        return ZERO_SLOT;
      }
      const call = at as { to?: string; data?: string } | undefined;
      if (method === "eth_call" && same(call?.to, router) && call?.data?.startsWith(WEIGHTS)) {
        return encodeFunctionResult({
          abi: routerAbi,
          functionName: "getEffectiveWeights",
          result: [
            [legA, legB],
            [6_000n, 4_000n],
          ],
        });
      }
      return undefined;
    };
    const { fetched, getWrite } = await connected(8453, "mainnet", PROXY_CODE, config, rpc);
    const deposit = {
      address: router,
      abi: routerAbi,
      functionName: "deposit",
      args: [1_000_000n, [1n, 1n]],
    };

    let refused: Error | undefined;
    await act(async () => {
      await getWrite()
        .writeContractAsync(deposit as never)
        .catch((e: Error) => {
          refused = e;
        });
    });
    expect(refused).toBeInstanceOf(WriteTargetPinError);
    const pinError = refused as WriteTargetPinError;
    expect(pinError.pinCause).toBe("implementation-mismatch");
    expect(pinError.target).toBe(legB);
    expect(pinError.router).toBe(router);
    expect(pinError.message).toContain(legB);
    expect(pinError.message).toContain(
      `a leg vault the Portfolio Router ${router} would deposit into`,
    );
    expect(fetched).toContain("eth_call");
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
    expect(getWrite().error?.name).toBe("WriteTargetPinError");

    // Control: the same deposit reaches the wallet once leg B runs a reviewed implementation, so
    // the refusal above was the leg's and nothing else's.
    legBImpl = reviewedLegImpl;
    let passed: Error | undefined;
    await act(async () => {
      await getWrite()
        .writeContractAsync(deposit as never)
        .catch((e: Error) => {
          passed = e;
        });
    });
    expect(passed).not.toBeInstanceOf(WriteTargetPinError);
    expect(fetched.some((m) => WRITE_METHODS.includes(m))).toBe(true);
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

// Core issue 1758: an rmUSDC redeem estimated against the pending block can revert Panic(0x11), so a redeem of
// a configured RobotMoneyVault is sent with a fixed gas limit through this one hook (dapp issue 1760). A basket
// vault redeem needs more than that limit, so it is left to the wallet's estimate (QA plan U3).
describe("useGuardedWriteContract redeem gas workaround (core issue 1758)", () => {
  const redeemAbi = [
    {
      type: "function",
      name: "redeem",
      stateMutability: "nonpayable",
      inputs: [
        { name: "shares", type: "uint256" },
        { name: "receiver", type: "address" },
        { name: "owner", type: "address" },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;
  const redeem = (extra: object = {}) => ({
    address: `0x${(nextTarget += 1).toString(16).padStart(40, "0")}` as Address,
    abi: redeemAbi,
    functionName: "redeem" as const,
    args: [1n, USER, USER] as const,
    ...extra,
  });
  /** The deployment's RobotMoneyVault (rmUSDC) is the redeem target. */
  const asRmUsdc = (v: ReturnType<typeof redeem>) => ({ VITE_VAULT_ADDRESS: v.address });
  const GAS_2_5M = "0x2625a0";

  it.each(["mainnet", "devnet"])(
    "sends an rmUSDC redeem on the %s class with gas 2,500,000",
    async (env) => {
      const chainId = env === "mainnet" ? 8453 : 918453;
      const v = redeem();
      const { sent, getWrite } = await connected(chainId, env, "0x6001", asRmUsdc(v));
      await act(async () => {
        await getWrite()
          .writeContractAsync(v)
          .catch(() => undefined);
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.gas).toBe(GAS_2_5M);
    },
  );

  it("the callback form sends the rmUSDC redeem with gas 2,500,000 too", async () => {
    const v = redeem();
    const { sent, getWrite } = await connected(8453, "mainnet", "0x6001", asRmUsdc(v));
    await act(async () => {
      getWrite().writeContract(v);
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(sent[0]?.gas).toBe(GAS_2_5M);
  });

  it("a caller-set gas wins", async () => {
    const v = redeem({ gas: 1_234_567n });
    const { sent, getWrite } = await connected(8453, "mainnet", "0x6001", asRmUsdc(v));
    await act(async () => {
      await getWrite()
        .writeContractAsync(v)
        .catch(() => undefined);
    });
    expect(sent[0]?.gas).toBe("0x12d687");
  });

  it("a basket vault redeem gets no fixed gas: its floor is above 2,500,000", async () => {
    const rmUsdc = redeem();
    const basket = redeem();
    const { sent, getWrite } = await connected(8453, "mainnet", "0x6001", asRmUsdc(rmUsdc));
    await act(async () => {
      await getWrite()
        .writeContractAsync(basket)
        .catch(() => undefined);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.gas).toBeUndefined();
  });

  it("a deposit gets no added gas", async () => {
    const target = fresh();
    const { sent, getWrite } = await connected(8453, "mainnet", "0x6001", pinFor(target.address));
    await act(async () => {
      await getWrite()
        .writeContractAsync(target)
        .catch(() => undefined);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.gas).toBeUndefined();
  });
});
