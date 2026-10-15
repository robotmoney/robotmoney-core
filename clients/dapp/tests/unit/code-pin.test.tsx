// QA plan U5 (issue 1737 item 1): build-time vault and router code-hash pins.
//
// On the mainnet class a deposit or an approve is sent only when keccak256 of the code of the
// contract that receives the USDC (deposit target) or the allowance (approve spender) equals its
// pin. Real wagmi, a `mock` connector on Base, and a recording fetch: the test asserts on what
// actually reaches the wallet. A missing pin, a different hash and unreadable code each refuse,
// and no signing or sending method is ever called. Removing the hash comparison in
// `checkCodePin` (the guard's step 3) makes the "hash-mismatch" cases below fail.
//
// ADR-0014: behind an ERC-1967 proxy the code at the address is the generic proxy, so the guard
// also reads the implementation slot and the implementation's code (step 4). Removing
// `checkImplementationPin` from `verifyPinnedTarget` makes the "implementation-*" cases fail.
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, custom, useAccount, useConnect } from "wagmi";
import { mock } from "wagmi/connectors";
import { base as wagmiBase } from "wagmi/chains";
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
import { useVerifiedCodeTargets } from "../../src/lib/useVerifiedCodeTargets";
import {
  checkCodePin,
  checkImplementationPin,
  GATEWAY_CODE_HASH_PIN_KEY,
  GATEWAY_IMPLEMENTATION_HASH_PIN_KEY,
  isRouterDeposit,
  parseCodePins,
  parseImplementationPinMap,
  pinnedWriteTarget,
  ROUTER_CODE_HASH_PIN_KEY,
  ROUTER_IMPLEMENTATION_HASH_PIN_KEY,
  VAULT_CODE_HASH_PIN_KEY,
  VAULT_IMPLEMENTATION_HASH_PIN_KEY,
  verifyPinnedTarget,
  WriteTargetPinError,
} from "../../src/lib/codePins";
import { MAINNET_RUNTIME_KEYS, RUNTIME_CONFIG_KEYS } from "../../src/lib/runtimeConfig";
import { buildVaultPreview } from "../../src/lib/vaultPreview";
import { buildRouterPreview, type LegPreview } from "../../src/lib/routerPreview";
import { routerAbi } from "../../src/lib/abi";
import { TxPreview } from "../../src/components/TxPreview";

const DEAD = { default: { http: ["http://127.0.0.1:1"] } };
const base = defineChain({ ...wagmiBase, rpcUrls: DEAD });
const USER = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const VAULT_CODE = "0x6001" as Hex;
const OTHER_CODE = "0x6002" as Hex;
const PIN = keccak256(VAULT_CODE);
/** The generic ERC1967Proxy runtime: the same at every proxy, unchanged by an upgrade. */
const PROXY_CODE = "0x6003" as Hex;
const PROXY_PIN = keccak256(PROXY_CODE);
/** A reviewed implementation, and one nobody reviewed, behind a proxy. */
const REVIEWED_IMPL_CODE = "0x6004" as Hex;
const UNREVIEWED_IMPL_CODE = "0x6005" as Hex;
const REVIEWED_IMPL_PIN = keccak256(REVIEWED_IMPL_CODE);
const ZERO_SLOT = `0x${"0".repeat(64)}` as Hex;
/** The ERC-1967 implementation slot word naming `implementation`. */
const slotNaming = (implementation: Address): Hex => pad(implementation, { size: 32 });

const WRITE_METHODS = [
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_signTransaction",
  "eth_estimateGas",
  "eth_signTypedData_v4",
];

const abi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
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
  {
    type: "function",
    name: "pauseDeposits",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
] as const;

/** A new address per call: the guard caches targets that already passed. */
let next = 0x7000;
const fresh = (): Address => `0x${(next += 1).toString(16).padStart(40, "0")}` as Address;

type CodeAnswer = Hex | null | "unreadable";
/** The ERC-1967 implementation slot word at an address; a zero word is a direct contract. */
type SlotAnswer = Hex | "unreadable";
const directSlot = (): SlotAnswer => ZERO_SLOT;
/** The answer to an `eth_call` (to, data), or undefined when the test does not serve that call. */
type CallAnswer = (to: string, data: string) => Hex | undefined;
const noCalls: CallAnswer = () => undefined;
/** `router.getEffectiveWeights()` answering `legs`, each at 5000 bps. */
const weightsOf =
  (router: Address, legs: readonly Address[]): CallAnswer =>
  (to, data) =>
    same(to, router) && data.startsWith(toFunctionSelector("getEffectiveWeights()"))
      ? encodeFunctionResult({
          abi: routerAbi,
          functionName: "getEffectiveWeights",
          result: [legs, legs.map(() => 5_000n)],
        })
      : undefined;

function rpcResponse(id: unknown, body: Record<string, unknown>) {
  return Promise.resolve(
    new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), {
      headers: { "content-type": "application/json" },
    }),
  );
}

/**
 * Real wagmi on Base with a wallet whose `eth_getCode` and `eth_getStorageAt` answers are chosen
 * per address. `slotOf` defaults to a zero slot: a direct contract.
 */
async function connectedOnBase(
  env: Record<string, string>,
  codeOf: (a: string) => CodeAnswer,
  slotOf: (a: string) => SlotAnswer = directSlot,
  callOf: CallAnswer = noCalls,
) {
  const fetched: string[] = [];
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_chainId") return `0x${base.id.toString(16)}`;
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_getCode") {
        const a = codeOf(String(params?.[0]));
        if (a === "unreadable") throw new Error("rpc down");
        return a;
      }
      if (method === "eth_getStorageAt") {
        const w = slotOf(String(params?.[0]));
        if (w === "unreadable") throw new Error("rpc down");
        return w;
      }
      return null;
    },
  });
  const config = createConfig({
    chains: [base],
    connectors: [mock({ accounts: [USER] })],
    transports: { [base.id]: transport },
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    let method = "unparsed";
    let id: unknown = 1;
    let params: unknown[] = [];
    try {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        id: unknown;
        params?: unknown[];
      };
      method = body.method;
      id = body.id;
      params = body.params ?? [];
    } catch {
      /* not JSON-RPC */
    }
    fetched.push(method);
    if (method === "eth_blockNumber") return rpcResponse(id, { result: "0x10" });
    if (method === "eth_getCode") {
      const a = codeOf(String(params[0]));
      if (a === "unreadable") return rpcResponse(id, { error: { code: -32603, message: "down" } });
      return rpcResponse(id, { result: a });
    }
    if (method === "eth_getStorageAt") {
      const w = slotOf(String(params[0]));
      if (w === "unreadable") return rpcResponse(id, { error: { code: -32603, message: "down" } });
      return rpcResponse(id, { result: w });
    }
    if (method === "eth_call") {
      const call = (params[0] ?? {}) as { to?: unknown; data?: unknown };
      const out = callOf(String(call.to), String(call.data));
      if (out !== undefined) return rpcResponse(id, { result: out });
    }
    return Promise.reject(new TypeError("blocked by test"));
  });
  let write: ReturnType<typeof useGuardedWriteContract> | undefined;
  function Probe() {
    const { connect, connectors } = useConnect();
    const { isConnected, chainId } = useAccount();
    write = useGuardedWriteContract();
    const verified = useVerifiedCodeTargets();
    return (
      <div>
        <button
          type="button"
          data-testid="go"
          onClick={() => connect({ connector: connectors[0], chainId: base.id })}
        >
          connect
        </button>
        <span data-testid="state">{isConnected ? `connected:${chainId}` : "off"}</span>
        <span data-testid="verified">{[...verified].sort().join(",")}</span>
      </div>
    );
  }
  render(
    <WagmiProvider config={config}>
      <QueryClientProvider client={new QueryClient()}>
        <RuntimeConfigProvider config={{ VITE_ENV_CLASS: "mainnet", ...env }}>
          <Probe />
        </RuntimeConfigProvider>
      </QueryClientProvider>
    </WagmiProvider>,
  );
  await act(async () => screen.getByTestId("go").click());
  await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent(`connected:8453`));
  return { fetched, getWrite: () => write! };
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sends = (fetched: string[]) => fetched.filter((m) => m === "eth_sendTransaction").length;
/** The addresses the badge hook verified, as Probe renders them. */
const verifiedNow = (): Set<string> =>
  new Set((screen.getByTestId("verified").textContent ?? "").split(",").filter(Boolean));

const vaultPins = (pins: Record<string, string>) => ({
  [VAULT_CODE_HASH_PIN_KEY]: JSON.stringify(pins),
});

async function attempt(getWrite: () => ReturnType<typeof useGuardedWriteContract>, v: object) {
  let error: Error | undefined;
  await act(async () => {
    await getWrite()
      .writeContractAsync(v as never)
      .catch((e: Error) => {
        error = e;
      });
  });
  return error;
}

const deposit = (address: Address) => ({
  address,
  abi,
  functionName: "deposit" as const,
  args: [1_000_000n, USER] as const,
});
const approve = (spender: Address) => ({
  address: USDC,
  abi,
  functionName: "approve" as const,
  args: [spender, 1_000_000n] as const,
});

describe("parseCodePins (pure)", () => {
  it("reads the vault map and the router pin, lower-cased", () => {
    const v = "0x00000000000000000000000000000000000000AA";
    const r = "0x00000000000000000000000000000000000000BB";
    const pins = parseCodePins({
      [VAULT_CODE_HASH_PIN_KEY]: JSON.stringify({ [v]: PIN.toUpperCase().replace("0X", "0x") }),
      [ROUTER_CODE_HASH_PIN_KEY]: PIN,
      VITE_ROUTER_ADDRESS: r,
    });
    expect(pins.get(v.toLowerCase())).toBe(PIN.toLowerCase());
    expect(pins.get(r.toLowerCase())).toBe(PIN.toLowerCase());
    expect(pins.size).toBe(2);
  });

  it("drops what it cannot parse: bad JSON, bad address, bad or zero hash, a router pin with no address", () => {
    expect(parseCodePins({ [VAULT_CODE_HASH_PIN_KEY]: "not json" }).size).toBe(0);
    expect(parseCodePins({ [VAULT_CODE_HASH_PIN_KEY]: "[]" }).size).toBe(0);
    const v = fresh();
    const pins = parseCodePins({
      [VAULT_CODE_HASH_PIN_KEY]: JSON.stringify({
        "0x1234": PIN,
        [v]: "0x12",
        [fresh()]: `0x${"0".repeat(64)}`,
      }),
      [ROUTER_CODE_HASH_PIN_KEY]: PIN,
    });
    expect(pins.size).toBe(0);
  });

  it("is build-time only: /config.json can never supply a pin", () => {
    for (const key of [VAULT_CODE_HASH_PIN_KEY, ROUTER_CODE_HASH_PIN_KEY]) {
      expect(RUNTIME_CONFIG_KEYS as readonly string[]).not.toContain(key);
      expect(MAINNET_RUNTIME_KEYS).not.toContain(key);
    }
  });
});

describe("pinnedWriteTarget and checkCodePin (pure)", () => {
  it("pins the deposit target and the approve spender, never a redeem", () => {
    const v = fresh();
    expect(pinnedWriteTarget(deposit(v))).toBe(v);
    expect(pinnedWriteTarget({ ...deposit(v), functionName: "mint" })).toBe(v);
    expect(pinnedWriteTarget(approve(v))).toBe(v);
    expect(pinnedWriteTarget({ ...approve(v), functionName: "increaseAllowance" })).toBe(v);
    expect(pinnedWriteTarget({ address: v, functionName: "redeem", args: [1n, USER, USER] })).toBe(
      undefined,
    );
    expect(pinnedWriteTarget({ functionName: "deposit" })).toBe("");
    expect(pinnedWriteTarget({ address: USDC, functionName: "approve", args: [] })).toBe("");
  });

  it("names one cause per failure", () => {
    const v = fresh();
    const pins = parseCodePins(vaultPins({ [v]: PIN }));
    expect(checkCodePin(fresh(), VAULT_CODE, pins)).toEqual({ ok: false, cause: "pin-missing" });
    expect(checkCodePin(v, undefined, pins)).toEqual({ ok: false, cause: "code-unreadable" });
    expect(checkCodePin(v, "nope", pins)).toEqual({ ok: false, cause: "code-unreadable" });
    expect(checkCodePin(v, "0x", pins)).toEqual({ ok: false, cause: "no-code" });
    expect(checkCodePin(v, OTHER_CODE, pins)).toEqual({
      ok: false,
      cause: "hash-mismatch",
      got: keccak256(OTHER_CODE),
    });
    expect(checkCodePin(v, VAULT_CODE, pins)).toEqual({ ok: true, hash: PIN });
  });
});

describe("useGuardedWriteContract refuses a deposit or approve to unpinned code on mainnet", () => {
  it("refuses a deposit whose target code differs from its pin, and sends nothing", async () => {
    const v = fresh();
    const { fetched, getWrite } = await connectedOnBase(vaultPins({ [v]: PIN }), () => OTHER_CODE);
    const error = await attempt(getWrite, deposit(v));
    expect(error).toBeInstanceOf(WriteTargetPinError);
    expect((error as WriteTargetPinError).pinCause).toBe("hash-mismatch");
    expect(error?.message).toMatch(/not the pinned hash/);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
    expect(getWrite().error?.name).toBe("WriteTargetPinError");
  });

  it("refuses a deposit to a vault with no pin, and sends nothing", async () => {
    const { fetched, getWrite } = await connectedOnBase(vaultPins({}), () => VAULT_CODE);
    const error = await attempt(getWrite, deposit(fresh()));
    expect((error as WriteTargetPinError).pinCause).toBe("pin-missing");
    expect(error?.message).toMatch(/no build-time code-hash pin/);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("refuses an approve whose spender has no pin, and sends nothing", async () => {
    const { fetched, getWrite } = await connectedOnBase(vaultPins({}), () => VAULT_CODE);
    const error = await attempt(getWrite, approve(fresh()));
    expect((error as WriteTargetPinError).pinCause).toBe("pin-missing");
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("refuses an approve whose spender code cannot be read, and sends nothing", async () => {
    const spender = fresh();
    const { fetched, getWrite } = await connectedOnBase(vaultPins({ [spender]: PIN }), (a) =>
      a.toLowerCase() === spender.toLowerCase() ? "unreadable" : VAULT_CODE,
    );
    const error = await attempt(getWrite, approve(spender));
    expect((error as WriteTargetPinError).pinCause).toBe("code-unreadable");
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("refuses an approve whose spender code differs from its pin", async () => {
    const spender = fresh();
    const { fetched, getWrite } = await connectedOnBase(vaultPins({ [spender]: PIN }), (a) =>
      a.toLowerCase() === spender.toLowerCase() ? OTHER_CODE : VAULT_CODE,
    );
    const error = await attempt(getWrite, approve(spender));
    expect((error as WriteTargetPinError).pinCause).toBe("hash-mismatch");
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("the callback form reports the refusal through onError and sends nothing", async () => {
    const v = fresh();
    const { fetched, getWrite } = await connectedOnBase(vaultPins({ [v]: PIN }), () => OTHER_CODE);
    let errors = 0;
    await act(async () => {
      getWrite().writeContract(deposit(v), {
        onError: () => {
          errors += 1;
        },
      });
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(errors).toBe(1);
    expect(getWrite().error?.name).toBe("WriteTargetPinError");
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("lets a deposit and an approve through when the code matches the pin", async () => {
    const v = fresh();
    const { fetched, getWrite } = await connectedOnBase(vaultPins({ [v]: PIN }), () => VAULT_CODE);
    const depositError = await attempt(getWrite, deposit(v));
    expect(depositError).not.toBeInstanceOf(WriteTargetPinError);
    expect(fetched).toContain("eth_sendTransaction");
    const approveError = await attempt(getWrite, approve(v));
    expect(approveError).not.toBeInstanceOf(WriteTargetPinError);
  });

  it("the router pin is read at the router address, and the router's leg vaults are read too", async () => {
    const router = fresh();
    const leg = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      {
        [ROUTER_CODE_HASH_PIN_KEY]: PIN,
        VITE_ROUTER_ADDRESS: router,
        ...vaultPins({ [leg]: PIN }),
      },
      () => VAULT_CODE,
      directSlot,
      weightsOf(router, [leg]),
    );
    const error = await attempt(getWrite, deposit(router));
    expect(error).not.toBeInstanceOf(WriteTargetPinError);
    expect(fetched).toContain("eth_call");
    expect(fetched).toContain("eth_sendTransaction");
  });

  it("a redeem needs no pin: an exit never depends on a build setting", async () => {
    const v = fresh();
    const { fetched, getWrite } = await connectedOnBase(vaultPins({}), () => VAULT_CODE);
    const error = await attempt(getWrite, {
      address: v,
      abi,
      functionName: "redeem",
      args: [1n, USER, USER],
    });
    expect(error).not.toBeInstanceOf(WriteTargetPinError);
    expect(fetched).toContain("eth_sendTransaction");
  });
});

describe("targetCodeHashKnown comes from the pins", () => {
  it("only a pinned address whose code matches is verified, and only its preview says so", async () => {
    const good = fresh();
    const bad = fresh();
    await connectedOnBase(vaultPins({ [good]: PIN, [bad]: PIN }), (a) =>
      a.toLowerCase() === good.toLowerCase() ? VAULT_CODE : OTHER_CODE,
    );
    await waitFor(() =>
      expect(screen.getByTestId("verified")).toHaveTextContent(good.toLowerCase()),
    );
    expect(screen.getByTestId("verified")).not.toHaveTextContent(bad.toLowerCase());

    const verifiedTargets = new Set([good.toLowerCase()]);
    const ctx = {
      gateway: USDC,
      gatewayCodeHashVerified: true,
      envClass: "mainnet" as const,
      verifiedTargets,
    };
    const action = { kind: "vaultDeposit", assets: 1n, receiver: USER } as const;
    const ok = buildVaultPreview(action, { ...ctx, vault: good });
    const no = buildVaultPreview(action, { ...ctx, vault: bad });
    expect(ok.ok && ok.targetCodeHashKnown).toBe(true);
    expect(no.ok && no.targetCodeHashKnown).toBe(false);
    const router = buildRouterPreview(1n, [], { ...ctx, router: bad });
    expect(router.ok && router.targetCodeHashKnown).toBe(false);
  });
});

describe("implementation pins behind an ERC-1967 proxy (ADR-0014)", () => {
  describe("parseImplementationPinMap, pinnedWriteTarget and checkImplementationPin (pure)", () => {
    it("reads the vault map (a string or a list), the router list and the gateway list", () => {
      const v1 = fresh();
      const v2 = fresh();
      const router = fresh();
      const gateway = fresh();
      const other = keccak256("0x01");
      const pins = parseImplementationPinMap({
        [VAULT_IMPLEMENTATION_HASH_PIN_KEY]: JSON.stringify({
          [v1]: `${REVIEWED_IMPL_PIN},0x12`,
          [v2]: [REVIEWED_IMPL_PIN.toUpperCase().replace("0X", "0x"), other],
          "0x1234": REVIEWED_IMPL_PIN,
        }),
        VITE_ROUTER_ADDRESS: router,
        [ROUTER_IMPLEMENTATION_HASH_PIN_KEY]: `${REVIEWED_IMPL_PIN}, ${other}`,
        VITE_GATEWAY_ADDRESS: gateway,
        [GATEWAY_IMPLEMENTATION_HASH_PIN_KEY]: REVIEWED_IMPL_PIN,
      });
      expect(pins.get(v1)).toEqual([REVIEWED_IMPL_PIN]);
      expect(pins.get(v2)).toEqual([REVIEWED_IMPL_PIN, other]);
      expect(pins.get(router)).toEqual([REVIEWED_IMPL_PIN, other]);
      expect(pins.get(gateway)).toEqual([REVIEWED_IMPL_PIN]);
      expect(pins.size).toBe(4);
      expect(parseImplementationPinMap({ [VAULT_IMPLEMENTATION_HASH_PIN_KEY]: "nope" }).size).toBe(
        0,
      );
    });

    it("is build-time only: /config.json can never supply an implementation pin", () => {
      for (const key of [
        VAULT_IMPLEMENTATION_HASH_PIN_KEY,
        ROUTER_IMPLEMENTATION_HASH_PIN_KEY,
        GATEWAY_IMPLEMENTATION_HASH_PIN_KEY,
        GATEWAY_CODE_HASH_PIN_KEY,
      ]) {
        expect(RUNTIME_CONFIG_KEYS as readonly string[]).not.toContain(key);
        expect(MAINNET_RUNTIME_KEYS).not.toContain(key);
      }
    });

    it("pins every write to the gateway, and never an approve of zero", () => {
      const gateway = fresh();
      const spender = fresh();
      expect(pinnedWriteTarget({ address: gateway, functionName: "pauseDeposits" }, gateway)).toBe(
        gateway,
      );
      expect(pinnedWriteTarget({ address: gateway, functionName: "pauseDeposits" })).toBe(
        undefined,
      );
      expect(pinnedWriteTarget({ ...approve(spender), args: [spender, 0n] })).toBe(undefined);
      expect(pinnedWriteTarget({ ...approve(spender), args: [spender, 1n] })).toBe(spender);
    });

    it("names one cause per failure, and passes a direct contract with no implementation pin", () => {
      const target = fresh();
      const impl = fresh();
      const pins = parseImplementationPinMap({
        [VAULT_IMPLEMENTATION_HASH_PIN_KEY]: JSON.stringify({ [target]: REVIEWED_IMPL_PIN }),
      });
      const slot = slotNaming(impl);
      expect(checkImplementationPin(fresh(), ZERO_SLOT, null, pins)).toEqual({ ok: true });
      expect(checkImplementationPin(target, ZERO_SLOT, null, pins)).toEqual({
        ok: false,
        cause: "implementation-unexpected",
      });
      expect(checkImplementationPin(fresh(), slot, REVIEWED_IMPL_CODE, pins)).toEqual({
        ok: false,
        cause: "implementation-pin-missing",
      });
      expect(checkImplementationPin(target, undefined, null, pins)).toEqual({
        ok: false,
        cause: "implementation-unreadable",
      });
      expect(checkImplementationPin(target, slot, undefined, pins)).toEqual({
        ok: false,
        cause: "implementation-unreadable",
      });
      expect(checkImplementationPin(target, slot, "0x", pins)).toEqual({
        ok: false,
        cause: "implementation-mismatch",
      });
      expect(checkImplementationPin(target, slot, UNREVIEWED_IMPL_CODE, pins)).toEqual({
        ok: false,
        cause: "implementation-mismatch",
        got: keccak256(UNREVIEWED_IMPL_CODE),
      });
      expect(checkImplementationPin(target, slot, REVIEWED_IMPL_CODE, pins)).toEqual({
        ok: true,
        implementationHash: REVIEWED_IMPL_PIN,
      });

      // The proxy's own code is checked first; a matching proxy says nothing about the logic.
      const codePins = parseCodePins(vaultPins({ [target]: PROXY_PIN }));
      const reads = (code: Hex, implementationCode: Hex) => ({ code, slot, implementationCode });
      expect(
        verifyPinnedTarget(target, reads(OTHER_CODE, REVIEWED_IMPL_CODE), codePins, pins),
      ).toMatchObject({
        ok: false,
        cause: "hash-mismatch",
      });
      expect(
        verifyPinnedTarget(target, reads(PROXY_CODE, UNREVIEWED_IMPL_CODE), codePins, pins),
      ).toMatchObject({
        ok: false,
        cause: "implementation-mismatch",
      });
      expect(
        verifyPinnedTarget(target, reads(PROXY_CODE, REVIEWED_IMPL_CODE), codePins, pins),
      ).toEqual({
        ok: true,
        hash: PROXY_PIN,
        implementationHash: REVIEWED_IMPL_PIN,
      });
    });
  });

  // The finding (security round 1): every vault and router pin is the generic ERC1967Proxy hash, so a
  // timelock upgrade to logic nobody reviewed kept passing the guard and the badge.
  it("refuses a deposit and an approve to a router whose proxy code matches but whose implementation is unpinned, never badges it, and still sends a redeem", async () => {
    const router = fresh();
    const unreviewed = fresh();
    const control = fresh();
    const exitVault = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      {
        VITE_ROUTER_ADDRESS: router,
        [ROUTER_CODE_HASH_PIN_KEY]: PROXY_PIN,
        [ROUTER_IMPLEMENTATION_HASH_PIN_KEY]: REVIEWED_IMPL_PIN,
        ...vaultPins({ [control]: PIN }),
      },
      (a) =>
        same(a, unreviewed) ? UNREVIEWED_IMPL_CODE : same(a, control) ? VAULT_CODE : PROXY_CODE,
      (a) => (same(a, router) || same(a, exitVault) ? slotNaming(unreviewed) : ZERO_SLOT),
    );

    const depositError = await attempt(getWrite, deposit(router));
    expect(depositError).toBeInstanceOf(WriteTargetPinError);
    expect((depositError as WriteTargetPinError).pinCause).toBe("implementation-mismatch");
    expect(depositError?.message).toMatch(/not a reviewed one this build pins/);
    const approveError = await attempt(getWrite, approve(router));
    expect(approveError).toBeInstanceOf(WriteTargetPinError);
    expect((approveError as WriteTargetPinError).pinCause).toBe("implementation-mismatch");
    expect(fetched).toContain("eth_getStorageAt");
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);

    // The badge: the direct control vault is verified, the proxied router never is.
    await waitFor(() => expect(verifiedNow().has(control)).toBe(true));
    expect(verifiedNow().has(router)).toBe(false);
    const preview = buildRouterPreview(1n, [], {
      gateway: USDC,
      gatewayCodeHashVerified: true,
      envClass: "mainnet",
      router,
      verifiedTargets: verifiedNow(),
    });
    expect(preview.ok && preview.targetCodeHashKnown).toBe(false);
    render(<TxPreview preview={preview} />);
    expect(screen.getByTestId("tx-preview-codehash")).toHaveTextContent("[bytecode UNVERIFIED]");

    // An exit never depends on a pin: a redeem from a proxy with an unpinned implementation is sent.
    const redeemError = await attempt(getWrite, {
      address: exitVault,
      abi,
      functionName: "redeem",
      args: [1n, USER, USER],
    });
    expect(redeemError).not.toBeInstanceOf(WriteTargetPinError);
    expect(fetched).toContain("eth_sendTransaction");
  });

  it("refuses a deposit to a proxied vault whose build carries no implementation pin", async () => {
    const vault = fresh();
    const impl = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      vaultPins({ [vault]: PROXY_PIN }),
      (a) => (same(a, impl) ? REVIEWED_IMPL_CODE : PROXY_CODE),
      (a) => (same(a, vault) ? slotNaming(impl) : ZERO_SLOT),
    );
    const error = await attempt(getWrite, deposit(vault));
    expect((error as WriteTargetPinError).pinCause).toBe("implementation-pin-missing");
    expect(error?.message).toMatch(/pins no reviewed implementation/);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("lets a deposit through to a proxied vault whose implementation is reviewed, and badges it", async () => {
    const vault = fresh();
    const impl = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      {
        ...vaultPins({ [vault]: PROXY_PIN }),
        [VAULT_IMPLEMENTATION_HASH_PIN_KEY]: JSON.stringify({ [vault]: REVIEWED_IMPL_PIN }),
      },
      (a) => (same(a, impl) ? REVIEWED_IMPL_CODE : PROXY_CODE),
      (a) => (same(a, vault) ? slotNaming(impl) : ZERO_SLOT),
    );
    const error = await attempt(getWrite, deposit(vault));
    expect(error).not.toBeInstanceOf(WriteTargetPinError);
    expect(fetched).toContain("eth_sendTransaction");
    await waitFor(() => expect(verifiedNow().has(vault)).toBe(true));
  });

  it("reads the implementation again before every send: an upgrade between two deposits refuses the second", async () => {
    const vault = fresh();
    const reviewed = fresh();
    const unreviewed = fresh();
    let live = reviewed;
    const { fetched, getWrite } = await connectedOnBase(
      {
        ...vaultPins({ [vault]: PROXY_PIN }),
        [VAULT_IMPLEMENTATION_HASH_PIN_KEY]: JSON.stringify({ [vault]: REVIEWED_IMPL_PIN }),
      },
      (a) =>
        same(a, reviewed)
          ? REVIEWED_IMPL_CODE
          : same(a, unreviewed)
            ? UNREVIEWED_IMPL_CODE
            : PROXY_CODE,
      (a) => (same(a, vault) ? slotNaming(live) : ZERO_SLOT),
    );
    expect(await attempt(getWrite, deposit(vault))).not.toBeInstanceOf(WriteTargetPinError);
    const sentBefore = sends(fetched);
    expect(sentBefore).toBeGreaterThan(0);
    live = unreviewed;
    const error = await attempt(getWrite, deposit(vault));
    expect((error as WriteTargetPinError).pinCause).toBe("implementation-mismatch");
    expect(sends(fetched)).toBe(sentBefore);
  });

  it("re-verifies the gateway implementation before every gateway write", async () => {
    const gateway = fresh();
    const reviewed = fresh();
    const unreviewed = fresh();
    let live = reviewed;
    const { fetched, getWrite } = await connectedOnBase(
      {
        VITE_GATEWAY_ADDRESS: gateway,
        [GATEWAY_CODE_HASH_PIN_KEY]: PROXY_PIN,
        [GATEWAY_IMPLEMENTATION_HASH_PIN_KEY]: REVIEWED_IMPL_PIN,
      },
      (a) =>
        same(a, reviewed)
          ? REVIEWED_IMPL_CODE
          : same(a, unreviewed)
            ? UNREVIEWED_IMPL_CODE
            : PROXY_CODE,
      (a) => (same(a, gateway) ? slotNaming(live) : ZERO_SLOT),
    );
    const pause = { address: gateway, abi, functionName: "pauseDeposits" as const, args: [] };
    expect(await attempt(getWrite, pause)).not.toBeInstanceOf(WriteTargetPinError);
    const sentBefore = sends(fetched);
    expect(sentBefore).toBeGreaterThan(0);
    // The timelock upgrades the gateway while the tab is open.
    live = unreviewed;
    const error = await attempt(getWrite, pause);
    expect(error).toBeInstanceOf(WriteTargetPinError);
    expect((error as WriteTargetPinError).pinCause).toBe("implementation-mismatch");
    expect(sends(fetched)).toBe(sentBefore);
  });

  it("an approve of zero (a revoke) grants nothing, so it needs no pin", async () => {
    const spender = fresh();
    const { fetched, getWrite } = await connectedOnBase(vaultPins({}), () => VAULT_CODE);
    const error = await attempt(getWrite, { ...approve(spender), args: [spender, 0n] as const });
    expect(error).not.toBeInstanceOf(WriteTargetPinError);
    expect(fetched).toContain("eth_sendTransaction");
  });
});

// Security round 2 (ADR-0014): the router forwards each leg's USDC into that vault and takes the
// vault's own `deposit()` return as the shares minted. A router deposit is refused unless every
// vault of `getEffectiveWeights()` passes its pins too (rmpc `verify_router_and_legs`), and the
// preview badges the deposit verified only when the router and every leg are.
describe("a router deposit checks every leg vault (security round 2)", () => {
  it("isRouterDeposit is a deposit into the configured router or of the router's shape, never an approve or a vault deposit", () => {
    const router = fresh();
    const vault = fresh();
    expect(isRouterDeposit(deposit(router), router)).toBe(true);
    expect(isRouterDeposit(deposit(vault), router)).toBe(false);
    expect(isRouterDeposit(approve(router), router)).toBe(false);
    expect(isRouterDeposit(deposit(router), undefined)).toBe(false);
    // deposit(amount, minSharesPerLeg[]) is the router's alone, wherever it is sent.
    const routerShaped = { address: vault, functionName: "deposit", args: [1n, [1n]] };
    expect(isRouterDeposit(routerShaped, undefined)).toBe(true);
  });

  it("refuses a router deposit whose leg vault has no code-hash pin, naming the leg, and sends nothing", async () => {
    const router = fresh();
    const pinned = fresh();
    const unpinned = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      {
        [ROUTER_CODE_HASH_PIN_KEY]: PIN,
        VITE_ROUTER_ADDRESS: router,
        ...vaultPins({ [pinned]: PIN }),
      },
      () => VAULT_CODE,
      directSlot,
      weightsOf(router, [pinned, unpinned]),
    );
    const error = await attempt(getWrite, deposit(router));
    expect(error).toBeInstanceOf(WriteTargetPinError);
    expect((error as WriteTargetPinError).pinCause).toBe("pin-missing");
    expect((error as WriteTargetPinError).target).toBe(unpinned);
    expect((error as WriteTargetPinError).router).toBe(router);
    expect(error?.message).toContain(unpinned);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("refuses a router deposit whose leg vault's code differs from its pin", async () => {
    const router = fresh();
    const leg = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      {
        [ROUTER_CODE_HASH_PIN_KEY]: PIN,
        VITE_ROUTER_ADDRESS: router,
        ...vaultPins({ [leg]: PIN }),
      },
      (a) => (same(a, leg) ? OTHER_CODE : VAULT_CODE),
      directSlot,
      weightsOf(router, [leg]),
    );
    const error = await attempt(getWrite, deposit(router));
    expect((error as WriteTargetPinError).pinCause).toBe("hash-mismatch");
    expect((error as WriteTargetPinError).target).toBe(leg);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
  });

  it("refuses a router deposit when the router's legs cannot be read, while an approve to the router still goes", async () => {
    const router = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      { [ROUTER_CODE_HASH_PIN_KEY]: PIN, VITE_ROUTER_ADDRESS: router },
      () => VAULT_CODE,
    );
    const error = await attempt(getWrite, deposit(router));
    expect((error as WriteTargetPinError).pinCause).toBe("router-legs-unreadable");
    expect(error?.message).toMatch(/leg vaults \(getEffectiveWeights\) could not be read/);
    expect(fetched.filter((m) => WRITE_METHODS.includes(m))).toEqual([]);
    // The USDC approval gives the router an allowance only it can pull, from the depositor, inside
    // the deposit the guard checks. It needs the router's pin alone.
    const approveError = await attempt(getWrite, approve(router));
    expect(approveError).not.toBeInstanceOf(WriteTargetPinError);
  });

  it("badges a router deposit verified only when the router and every leg are, and names a refused leg", () => {
    const router = fresh();
    const legA = fresh();
    const legB = fresh();
    const legs: LegPreview[] = [legA, legB].map((vault) => ({
      vault,
      weightBps: 5_000n,
      legAmount: 500_000n,
      estShares: 500_000n,
      unavailable: false,
    }));
    const ctx = {
      gateway: USDC,
      gatewayCodeHashVerified: true,
      envClass: "mainnet" as const,
      router,
    };
    const key = (a: Address) => a.toLowerCase();
    const routerOnly = buildRouterPreview(1_000_000n, legs, {
      ...ctx,
      verifiedTargets: new Set([key(router), key(legA)]),
    });
    expect(routerOnly.ok && routerOnly.targetCodeHashKnown).toBe(false);
    const all = buildRouterPreview(1_000_000n, legs, {
      ...ctx,
      verifiedTargets: new Set([key(router), key(legA), key(legB)]),
    });
    expect(all.ok && all.targetCodeHashKnown).toBe(true);
    expect(all.ok && all.warning).toBeFalsy();
    const refused = buildRouterPreview(1_000_000n, legs, {
      ...ctx,
      verifiedTargets: new Set([key(router), key(legA)]),
      refusedTargets: new Set([key(legB)]),
    });
    expect(refused.ok && refused.targetCodeHashKnown).toBe(false);
    expect(refused.ok ? refused.warning : "").toContain(legB);
  });
});
