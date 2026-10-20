/**
 * Issue 1892 (gateway-write-reverify): a vaults-system write or signature verifies its OWN
 * actual target and is refused before anything reaches the wallet, with the gateway absent.
 * No `VITE_GATEWAY_ADDRESS` is configured and no `GatewayWriteCheck` wraps the probe, so any
 * refusal below comes from the target's own check (chain, code, code hash, implementation,
 * Safe or timelock identity), never from the gateway verifier.
 */
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, custom, useAccount, useConnect } from "wagmi";
import { mock } from "wagmi/connectors";
import { base as wagmiBase, mainnet } from "wagmi/chains";
import { defineChain, keccak256, pad, type Address, type Hex } from "viem";
import { RuntimeConfigProvider } from "../../src/lib/RuntimeConfigContext";
import { useGuardedWriteContract } from "../../src/lib/useGuardedWriteContract";
import {
  ROUTER_CODE_HASH_PIN_KEY,
  ROUTER_IMPLEMENTATION_HASH_PIN_KEY,
  VAULT_CODE_HASH_PIN_KEY,
  VAULT_IMPLEMENTATION_HASH_PIN_KEY,
  WriteTargetPinError,
} from "../../src/lib/codePins";
import { WrongChainError, WriteTargetCodeError } from "../../src/lib/writeChainGuard";
import { SafeProposalError, buildSafeTx, encodeSchedule } from "../../src/lib/safeProposal";

const DEAD = { default: { http: ["http://127.0.0.1:1"] } };
const base = defineChain({ ...wagmiBase, rpcUrls: DEAD });
const L1 = defineChain({ ...mainnet, rpcUrls: DEAD });
const USER = "0x1111111111111111111111111111111111111111" as const;
const GOOD_CODE = "0x6001" as Hex;
const OTHER_CODE = "0x6002" as Hex;
const PROXY_CODE = "0x6003" as Hex;
const GOOD_IMPL_CODE = "0x6004" as Hex;
const BAD_IMPL_CODE = "0x6005" as Hex;
const ZERO_SLOT = `0x${"0".repeat(64)}` as Hex;
const WRITE_METHODS = [
  "eth_sendTransaction",
  "eth_sendRawTransaction",
  "eth_signTransaction",
  "eth_estimateGas",
  "eth_signTypedData_v4",
];
let next = 0x9000;
const fresh = (): Address => `0x${(next += 1).toString(16).padStart(40, "0")}` as Address;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

/** The wallet answers for `walletChain`; code and slot answers are chosen per address. */
async function connect(
  env: Record<string, string>,
  codeOf: (a: string) => Hex,
  slotOf: (a: string) => Hex = () => ZERO_SLOT,
  walletChain: typeof base | typeof L1 = base,
) {
  const sent: string[] = [];
  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      sent.push(method);
      if (method === "eth_chainId") return `0x${walletChain.id.toString(16)}`;
      if (method === "eth_blockNumber") return "0x10";
      if (method === "eth_getCode") return codeOf(String(params?.[0]));
      if (method === "eth_getStorageAt") return slotOf(String(params?.[0]));
      return null;
    },
  });
  const transports: Record<number, typeof transport> = { [walletChain.id]: transport };
  const config = createConfig({
    chains: [walletChain] as never,
    connectors: [mock({ accounts: [USER] })],
    transports: transports as never,
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((_u, init) => {
    const body = JSON.parse(String(init?.body)) as {
      method: string;
      id: unknown;
      params: unknown[];
    };
    sent.push(body.method);
    const result =
      body.method === "eth_getCode"
        ? codeOf(String(body.params[0]))
        : body.method === "eth_getStorageAt"
          ? slotOf(String(body.params[0]))
          : body.method === "eth_blockNumber"
            ? "0x10"
            : undefined;
    if (result === undefined) return Promise.reject(new TypeError("blocked by test"));
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  let write: ReturnType<typeof useGuardedWriteContract> | undefined;
  function Probe() {
    const { connect: c, connectors } = useConnect();
    const { isConnected, chainId } = useAccount();
    write = useGuardedWriteContract();
    return (
      <div>
        <button
          type="button"
          data-testid="go"
          onClick={() => c({ connector: connectors[0], chainId: walletChain.id })}
        >
          connect
        </button>
        <span data-testid="state">{isConnected ? `connected:${chainId}` : "off"}</span>
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
  await waitFor(() =>
    expect(screen.getByTestId("state")).toHaveTextContent(`connected:${walletChain.id}`),
  );
  return { sent, getWrite: () => write! };
}

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

const noWallet = (sent: string[]) => sent.filter((m) => WRITE_METHODS.includes(m));
const gatewayConfigured = (env: Record<string, string>) =>
  Object.keys(env).some((k) => k.includes("GATEWAY"));
const depositOf = (address: Address) => ({
  address,
  abi,
  functionName: "deposit" as const,
  args: [1_000_000n, USER] as const,
});
const redeemOf = (address: Address) => ({
  address,
  abi,
  functionName: "redeem" as const,
  args: [1n, USER, USER] as const,
});
const pauseOf = (address: Address) => ({ address, abi, functionName: "pause" as const, args: [] });

describe("gateway-write-reverify: each vaults-system target is verified on its own, gateway absent", () => {
  const vaultPin = (v: Address) => ({
    [VAULT_CODE_HASH_PIN_KEY]: JSON.stringify({ [v]: keccak256(GOOD_CODE) }),
  });

  it("refuses a vault deposit whose code hash differs from its pin", async () => {
    const v = fresh();
    const env = vaultPin(v);
    expect(gatewayConfigured(env)).toBe(false);
    const { sent, getWrite } = await connect(env, () => OTHER_CODE);
    const e = await attempt(getWrite, depositOf(v));
    expect(e).toBeInstanceOf(WriteTargetPinError);
    expect((e as WriteTargetPinError).pinCause).toBe("hash-mismatch");
    expect(noWallet(sent)).toEqual([]);
  });

  it("refuses a router deposit whose code hash differs from its pin", async () => {
    const router = fresh();
    const env = { VITE_ROUTER_ADDRESS: router, [ROUTER_CODE_HASH_PIN_KEY]: keccak256(GOOD_CODE) };
    const { sent, getWrite } = await connect(env, () => OTHER_CODE);
    const e = await attempt(getWrite, depositOf(router));
    expect((e as WriteTargetPinError).pinCause).toBe("hash-mismatch");
    expect(noWallet(sent)).toEqual([]);
  });

  it.each([
    ["vault", VAULT_CODE_HASH_PIN_KEY, VAULT_IMPLEMENTATION_HASH_PIN_KEY],
    ["router", ROUTER_CODE_HASH_PIN_KEY, ROUTER_IMPLEMENTATION_HASH_PIN_KEY],
  ])(
    "refuses a %s deposit whose implementation is not a pinned one",
    async (kind, codeKey, implKey) => {
      const target = fresh();
      const impl = fresh();
      const proxyPin = keccak256(PROXY_CODE);
      const env: Record<string, string> =
        kind === "vault"
          ? {
              [codeKey]: JSON.stringify({ [target]: proxyPin }),
              [implKey]: JSON.stringify({ [target]: keccak256(GOOD_IMPL_CODE) }),
            }
          : {
              VITE_ROUTER_ADDRESS: target,
              [codeKey]: proxyPin,
              [implKey]: keccak256(GOOD_IMPL_CODE),
            };
      const { sent, getWrite } = await connect(
        env,
        (a) => (same(a, impl) ? BAD_IMPL_CODE : PROXY_CODE),
        (a) => (same(a, target) ? pad(impl, { size: 32 }) : ZERO_SLOT),
      );
      const e = await attempt(getWrite, depositOf(target));
      expect(e).toBeInstanceOf(WriteTargetPinError);
      expect((e as WriteTargetPinError).pinCause).toBe("implementation-mismatch");
      expect(noWallet(sent)).toEqual([]);
    },
  );

  // The Safe and the timelock have no code pin: their identity is the configured address, and a
  // write to an address with no code (a wrong Safe or timelock) is refused before it is sent.
  it.each([
    ["a vault redeem", redeemOf],
    ["a Timelock write", pauseOf],
    ["a Safe write", pauseOf],
  ])("refuses %s to an address with no contract code", async (_name, build) => {
    const target = fresh();
    const { sent, getWrite } = await connect(vaultPinFor(target), (a) =>
      same(a, target) ? ("0x" as Hex) : GOOD_CODE,
    );
    const e = await attempt(getWrite, build(target));
    expect(e).toBeInstanceOf(WriteTargetCodeError);
    expect(noWallet(sent)).toEqual([]);
  });

  it.each([
    ["a vault deposit", depositOf],
    ["a vault redeem", redeemOf],
    ["a Timelock write", pauseOf],
    ["a Safe write", pauseOf],
  ])("refuses %s when the wallet is on the wrong chain", async (_name, build) => {
    const target = fresh();
    const { sent, getWrite } = await connect(
      vaultPinFor(target),
      () => GOOD_CODE,
      () => ZERO_SLOT,
      L1,
    );
    const e = await attempt(getWrite, build(target));
    expect(e).toBeInstanceOf(WrongChainError);
    expect(noWallet(sent)).toEqual([]);
  });
});

function vaultPinFor(v: Address): Record<string, string> {
  return { [VAULT_CODE_HASH_PIN_KEY]: JSON.stringify({ [v]: keccak256(GOOD_CODE) }) };
}

describe("gateway-write-reverify: a Safe signature is bound to its Safe, timelock and chain", () => {
  const SAFE = "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e" as Address;
  const TIMELOCK = "0x7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a" as Address;
  const OTHER = "0x8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b" as Address;
  const data = encodeSchedule(
    {
      target: fresh(),
      data: "0x",
      predecessor: `0x${"0".repeat(64)}` as Hex,
      salt: `0x${"1".repeat(64)}` as Hex,
    },
    172_800n,
  );
  const input = { chainId: 8453, safe: SAFE, timelock: TIMELOCK, to: TIMELOCK, data, nonce: 1n };

  it("signs typed data bound to the configured chain and Safe", () => {
    const built = buildSafeTx(input);
    expect(built.typedData.domain.chainId).toBe(8453);
    expect(built.typedData.domain.verifyingContract.toLowerCase()).toBe(SAFE);
    expect(built.typedData.message.to.toLowerCase()).toBe(TIMELOCK);
  });

  it("refuses a signature whose target is not the configured timelock", () => {
    expect(() => buildSafeTx({ ...input, to: OTHER })).toThrow(SafeProposalError);
    expect(() => buildSafeTx({ ...input, to: OTHER })).toThrow(/not the configured timelock/);
  });

  it("refuses a signature that is not a plain call or moves value", () => {
    expect(() => buildSafeTx({ ...input, operation: 1 })).toThrow(/delegatecall/);
    expect(() => buildSafeTx({ ...input, value: 1n })).toThrow(/value must be 0/);
  });

  it("refuses a signature for an invalid chain id", () => {
    expect(() => buildSafeTx({ ...input, chainId: 0 })).toThrow(SafeProposalError);
  });
});
