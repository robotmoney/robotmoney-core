// QA plan U5 (issue 1737 item 1): build-time vault and router code-hash pins.
//
// On the mainnet class a deposit or an approve is sent only when keccak256 of the code of the
// contract that receives the USDC (deposit target) or the allowance (approve spender) equals its
// pin. Real wagmi, a `mock` connector on Base, and a recording fetch: the test asserts on what
// actually reaches the wallet. A missing pin, a different hash and unreadable code each refuse,
// and no signing or sending method is ever called. Removing the hash comparison in
// `checkCodePin` (the guard's step 3) makes the "hash-mismatch" cases below fail.
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, custom, useAccount, useConnect } from "wagmi";
import { mock } from "wagmi/connectors";
import { base as wagmiBase } from "wagmi/chains";
import { defineChain, keccak256, type Address, type Hex } from "viem";
import { RuntimeConfigProvider } from "../../src/lib/RuntimeConfigContext";
import { useGuardedWriteContract } from "../../src/lib/useGuardedWriteContract";
import { useVerifiedCodeTargets } from "../../src/lib/useVerifiedCodeTargets";
import {
  checkCodePin,
  parseCodePins,
  pinnedWriteTarget,
  ROUTER_CODE_HASH_PIN_KEY,
  VAULT_CODE_HASH_PIN_KEY,
  WriteTargetPinError,
} from "../../src/lib/codePins";
import { MAINNET_RUNTIME_KEYS, RUNTIME_CONFIG_KEYS } from "../../src/lib/runtimeConfig";
import { buildVaultPreview } from "../../src/lib/vaultPreview";
import { buildRouterPreview } from "../../src/lib/routerPreview";

const DEAD = { default: { http: ["http://127.0.0.1:1"] } };
const base = defineChain({ ...wagmiBase, rpcUrls: DEAD });
const USER = "0x1111111111111111111111111111111111111111" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const VAULT_CODE = "0x6001" as Hex;
const OTHER_CODE = "0x6002" as Hex;
const PIN = keccak256(VAULT_CODE);

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
] as const;

/** A new address per call: the guard caches targets that already passed. */
let next = 0x7000;
const fresh = (): Address => `0x${(next += 1).toString(16).padStart(40, "0")}` as Address;

type CodeAnswer = Hex | null | "unreadable";

function rpcResponse(id: unknown, body: Record<string, unknown>) {
  return Promise.resolve(
    new Response(JSON.stringify({ jsonrpc: "2.0", id, ...body }), {
      headers: { "content-type": "application/json" },
    }),
  );
}

/** Real wagmi on Base with a wallet whose `eth_getCode` answer is chosen per address. */
async function connectedOnBase(env: Record<string, string>, codeOf: (a: string) => CodeAnswer) {
  const fetched: string[] = [];
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === "eth_chainId") return `0x${base.id.toString(16)}`;
      if (method === "eth_getCode") {
        const a = codeOf(String(params?.[0]));
        if (a === "unreadable") throw new Error("rpc down");
        return a;
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
    if (method === "eth_getCode") {
      const a = codeOf(String(params[0]));
      if (a === "unreadable") return rpcResponse(id, { error: { code: -32603, message: "down" } });
      return rpcResponse(id, { result: a });
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

  it("the router pin is read at the router address", async () => {
    const router = fresh();
    const { fetched, getWrite } = await connectedOnBase(
      { [ROUTER_CODE_HASH_PIN_KEY]: PIN, VITE_ROUTER_ADDRESS: router },
      () => VAULT_CODE,
    );
    const error = await attempt(getWrite, deposit(router));
    expect(error).not.toBeInstanceOf(WriteTargetPinError);
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
