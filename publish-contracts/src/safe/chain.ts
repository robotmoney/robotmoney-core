// Chain access: one public client per run, a chain-id guard before anything is signed or sent, and the loopback rule for plaintext keys.
import { createPublicClient, defineChain, http, type Address, type Chain, type PublicClient } from "viem";
import { DEFAULT_ALLOWED_CHAIN_IDS } from "./constants.ts";
import { SafeToolError } from "./errors.ts";

export interface ChainOpts {
  rpcUrl: string;
  chainId: number;
  /** Extra chain ids this run may use besides Base mainnet and the Twin chain (a local anvil for unit work). */
  allowChainIds?: readonly number[];
}

/** Host of a URL, lowercased, userinfo/port/brackets dropped. */
export function rpcHost(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  } catch {
    throw new SafeToolError("BAD_INPUT", `not an RPC URL: ${url.replace(/\/\/[^@/]*@/, "//***@")}`);
  }
}

export const isLoopbackRpc = (url: string): boolean => ["127.0.0.1", "localhost", "::1"].includes(rpcHost(url));

/** URLs may carry an API key in the path. Logs get the host only. */
export const rpcLabel = (url: string): string => rpcHost(url);

export function assertChainAllowed(o: ChainOpts): void {
  if (!Number.isInteger(o.chainId) || o.chainId <= 0) throw new SafeToolError("BAD_INPUT", `chainId must be a positive integer, got ${o.chainId}`);
  const allowed = [...DEFAULT_ALLOWED_CHAIN_IDS, ...(o.allowChainIds ?? [])];
  if (!allowed.includes(o.chainId)) throw new SafeToolError("CHAIN_NOT_ALLOWED", `chain ${o.chainId} is not one of ${allowed.join(", ")}`, { chainId: o.chainId });
}

export function viemChain(o: ChainOpts): Chain {
  return defineChain({
    id: o.chainId, name: `chain-${o.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [o.rpcUrl] } },
  });
}

export function publicClientFor(o: ChainOpts): PublicClient {
  return createPublicClient({ chain: viemChain(o), transport: http(o.rpcUrl) }) as PublicClient;
}

/** Refuses a run whose RPC answers a different chain id than the one asked for. Nothing is signed or sent before this passes. */
export async function chainGuard(client: PublicClient, o: ChainOpts): Promise<void> {
  assertChainAllowed(o);
  let got: number;
  try { got = await client.getChainId(); } catch (e) { throw new SafeToolError("CHAIN_UNREACHABLE", `cannot reach the RPC at ${rpcLabel(o.rpcUrl)}`, { cause: String(e) }); }
  if (got !== o.chainId) throw new SafeToolError("CHAIN_MISMATCH", `RPC answers chain id ${got}, want ${o.chainId}. Nothing was signed or sent.`, { got, want: o.chainId });
}

export const lc = (a: string): string => a.toLowerCase();
export const sameAddress = (a: string, b: string): boolean => lc(a) === lc(b);
export type { Address };
