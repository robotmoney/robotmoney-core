// viem-backed ChainReader. Read-only. Works by RPC URL on any chain (Twin chain 918453, Base 8453).
import { createPublicClient, http, parseAbiItem, decodeErrorResult, type PublicClient } from "viem";
import type { Address, ChainReader, Hex, LogEntry, RawCallResult } from "./types.ts";

export function viemReader(rpcUrl: string): ChainReader {
  const client: PublicClient = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 30_000 }) });
  return {
    chainId: async () => await client.getChainId(),
    blockNumber: async () => await client.getBlockNumber(),
    blockTimestamp: async () => (await client.getBlock({ blockTag: "latest" })).timestamp,
    getCode: async (address) => ((await client.getCode({ address })) ?? "0x") as Hex,
    nonce: async (address) => await client.getTransactionCount({ address, blockTag: "latest" }),
    getStorageAt: async (address, slot) => ((await client.getStorageAt({ address, slot })) ?? "0x") as Hex,
    read: async (address, signature, args = []) => {
      const item = parseAbiItem(signature) as any;
      return await client.readContract({ address, abi: [item], functionName: item.name, args } as any);
    },
    callRaw: async (to, data, from): Promise<RawCallResult> => {
      try {
        const r = await client.call({ to, data, account: from });
        return { ok: true, data: (r.data ?? "0x") as Hex };
      } catch (e: any) {
        const revertData = findRevertData(e);
        let reason: string | undefined;
        if (revertData) {
          try {
            const d = decodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], data: revertData });
            reason = String(d.args?.[0]);
          } catch { /* not Error(string) */ }
        }
        if (!revertData && !/revert/i.test(String(e?.message ?? e))) throw e; // transport failure, not a revert
        return { ok: false, data: revertData ?? "0x", reason: reason ?? String(e?.shortMessage ?? e?.message ?? e) };
      }
    },
    getLogs: async ({ address, topics, fromBlock, toBlock }) => {
      const logs = await client.request({
        method: "eth_getLogs",
        params: [{ address, topics, fromBlock: `0x${fromBlock.toString(16)}`, toBlock: `0x${toBlock.toString(16)}` } as any],
      } as any) as any[];
      return logs.map((l): LogEntry => ({ address: l.address as Address, topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber) }));
    },
  };
}

function findRevertData(e: any): Hex | undefined {
  for (let x = e, i = 0; x && i < 8; x = x.cause, i++) {
    if (typeof x.data === "string" && x.data.startsWith("0x")) return x.data as Hex;
    if (x.data && typeof x.data.data === "string") return x.data.data as Hex;
  }
  return undefined;
}
