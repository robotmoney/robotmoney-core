/**
 * A fake chain for tests that must read `depositsPaused()` through the real wagmi hooks (issue 1731).
 *
 * The fake is an in-memory EIP-1193 transport (`custom`), so no socket and no browser mock of wagmi is
 * involved: the component under test runs the real `useReadContracts` and the real write guard, and the
 * transport answers `eth_call` from a table. It records every request, so a test can also prove that NO call
 * was made (the mainnet class with no wallet on Base must not ask a provider that cannot answer for Base).
 *
 * An address that is not in the table answers with an execution revert, the way an RPC answers for a
 * contract that does not exist or a node that refuses: that is the "unreadable" case.
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, type RenderResult } from "@testing-library/react";
import { createConfig, custom, WagmiProvider } from "wagmi";
import { connect } from "wagmi/actions";
import { mock } from "wagmi/connectors";
import { defineChain, encodeAbiParameters, toFunctionSelector, type Address } from "viem";
import { RuntimeConfigProvider } from "../../../src/lib/RuntimeConfigContext";

export const DEPOSITS_PAUSED_SELECTOR = toFunctionSelector("depositsPaused()");

export interface FakeChain {
  /** Every `{method, to}` the transport saw. */
  readonly calls: { method: string; to?: string; data?: string }[];
  /** `depositsPaused()` answers by lowercase address. Set a key to `undefined` or omit it to make the call revert. */
  paused: Record<string, boolean | undefined>;
  /** Answers any other `eth_call` (target lowercase, calldata). Return undefined to revert. */
  respond?: (to: string, data: string) => `0x${string}` | undefined;
}

export function makeFakeChain(paused: Record<string, boolean> = {}): FakeChain {
  const lower: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(paused)) lower[k.toLowerCase()] = v;
  return { calls: [], paused: lower };
}

export interface RenderOpts {
  readonly chainId?: number;
  /** The runtime config (env class and addresses), as `/config.json` would give it. */
  readonly env?: Record<string, string>;
  /** Connect the mock wallet before rendering. */
  readonly connected?: boolean;
  /** The chain the connected wallet is on, when it is not `chainId` (a wrong-chain wallet). */
  readonly walletChainId?: number;
}

export async function renderOnFakeChain(
  ui: React.ReactElement,
  fake: FakeChain,
  opts: RenderOpts = {},
): Promise<RenderResult & { client: QueryClient }> {
  const chainId = opts.chainId ?? 918453;
  const chain = defineChain({
    id: chainId,
    name: "Fake",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: ["http://fake.invalid"] } },
  });
  const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    const first = (params?.[0] ?? {}) as { to?: string; data?: string };
    fake.calls.push({ method, to: first.to, data: first.data });
    if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
    if (method === "eth_accounts" || method === "eth_requestAccounts") {
      return ["0x1111111111111111111111111111111111111111"];
    }
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_call") {
      const to = (first.to ?? "").toLowerCase();
      const value = fake.paused[to];
      if (first.data?.startsWith(DEPOSITS_PAUSED_SELECTOR) && typeof value === "boolean") {
        return encodeAbiParameters([{ type: "bool" }], [value]);
      }
      const other = fake.respond?.(to, first.data ?? "");
      if (other !== undefined) return other;
      const err = new Error("execution reverted") as Error & { code: number };
      err.code = 3;
      throw err;
    }
    throw new Error(`fake chain: unsupported ${method}`);
  };
  const walletChainId = opts.walletChainId ?? chainId;
  const otherChain =
    walletChainId === chainId
      ? undefined
      : defineChain({
          id: walletChainId,
          name: "Other",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: ["http://other.invalid"] } },
        });
  const config = createConfig({
    chains: otherChain ? [chain, otherChain] : [chain],
    connectors: [mock({ accounts: ["0x1111111111111111111111111111111111111111"] as const })],
    transports: {
      [chainId]: custom({ request }),
      ...(otherChain ? { [walletChainId]: custom({ request }) } : {}),
    },
    storage: null,
  });
  if (opts.connected) {
    await connect(config, { connector: config.connectors[0]!, chainId: walletChainId });
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = rtlRender(
    <RuntimeConfigProvider config={opts.env ?? {}}>
      <WagmiProvider config={config} reconnectOnMount={false}>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </WagmiProvider>
    </RuntimeConfigProvider>,
  );
  // The query client, so a test can change the fake chain and force a refetch (a pause landing mid-session).
  return Object.assign(rendered, { client });
}

export type { Address };
