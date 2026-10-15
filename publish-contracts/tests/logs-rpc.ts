// A fake public JSON-RPC for the prove-control adoption scan (issue 1724), served by Bun.serve on loopback. It holds the Safe's execution
// events and the proof transaction, and misbehaves like the public Base RPCs did on the mainnet run: HTTP 429 for the first `throttle`
// eth_getLogs calls (Infinity: always), a range-limit error for an eth_getLogs range wider than `maxRange` blocks, and a pruned-node refusal
// for chosen methods. No chain, no network.
import { encodeAbiParameters, pad, toEventSelector, toHex, type Address, type Hex } from "viem";

export interface FakeExecution { block: number; txHash: Hex; safeTxHash: Hex; success?: boolean; logIndex?: number }
export interface FakeTx { from: Address; to: Address | null; input: Hex; value: bigint; status: "success" | "reverted"; block: number }
export interface LogsRpcOpts {
  safe: Address;
  latest: number;
  executions?: FakeExecution[];
  txs?: Record<string, FakeTx>;
  /** The first `throttle` eth_getLogs calls answer HTTP 429. */
  throttle?: number;
  /** The Retry-After header of a 429, in seconds. */
  retryAfter?: string;
  /** An eth_getLogs range of more blocks than this answers a range-limit error (code -32005, like the Base providers). */
  maxRange?: number;
  /** These methods answer a pruned-node error (code -32000). */
  refuse?: string[];
}
export interface LogsRpc {
  url: string;
  /** Every method served, in order. */
  calls: string[];
  /** Every eth_getLogs range asked, [from, to], in order (throttled and refused ones too). */
  ranges: [number, number][];
  stop(): void;
}

const SUCCESS = toEventSelector("ExecutionSuccess(bytes32,uint256)");
const FAILURE = toEventSelector("ExecutionFailure(bytes32,uint256)");
const BLOCK_HASH = pad("0xb1", { size: 32 });
const hex = (n: number | bigint): Hex => toHex(n);

export function logsRpc(o: LogsRpcOpts): LogsRpc {
  const calls: string[] = [];
  const ranges: [number, number][] = [];
  let getLogs = 0;
  const txs = Object.fromEntries(Object.entries(o.txs ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

  function answer(method: string, params: unknown[]): { result?: unknown; error?: { code: number; message: string }; status?: number } {
    if (o.refuse?.includes(method)) return { error: { code: -32000, message: "missing trie node: historical state not available (pruned)" } };
    switch (method) {
      case "eth_chainId": return { result: "0x7a69" };
      case "eth_blockNumber": return { result: hex(o.latest) };
      case "eth_getLogs": {
        const f = params[0] as { address: string; fromBlock: Hex; toBlock: Hex };
        const from = Number(f.fromBlock), to = Number(f.toBlock);
        ranges.push([from, to]);
        if (getLogs++ < (o.throttle ?? 0)) return { status: 429 };
        if (o.maxRange !== undefined && to - from + 1 > o.maxRange) return { error: { code: -32005, message: `block range is too wide: maximum is ${o.maxRange} blocks` } };
        if (f.address.toLowerCase() !== o.safe.toLowerCase()) return { result: [] };
        return { result: (o.executions ?? []).filter((e) => e.block >= from && e.block <= to).map((e) => ({
          address: o.safe, topics: [e.success === false ? FAILURE : SUCCESS, e.safeTxHash], data: encodeAbiParameters([{ type: "uint256" }], [0n]),
          blockNumber: hex(e.block), blockHash: BLOCK_HASH, transactionHash: e.txHash, transactionIndex: "0x0", logIndex: hex(e.logIndex ?? 0), removed: false,
        })) };
      }
      case "eth_getTransactionByHash": {
        const h = (params[0] as string).toLowerCase(), t = txs[h];
        return { result: t ? { hash: h, from: t.from, to: t.to, input: t.input, value: hex(t.value), nonce: "0x0", gas: "0x100000", gasPrice: "0x1", type: "0x0", v: "0x1b", r: pad("0x1", { size: 32 }), s: pad("0x1", { size: 32 }), blockNumber: hex(t.block), blockHash: BLOCK_HASH, transactionIndex: "0x0", chainId: "0x7a69" } : null };
      }
      case "eth_getTransactionReceipt": {
        const h = (params[0] as string).toLowerCase(), t = txs[h];
        return { result: t ? { transactionHash: h, from: t.from, to: t.to, status: t.status === "success" ? "0x1" : "0x0", blockNumber: hex(t.block), blockHash: BLOCK_HASH, transactionIndex: "0x0", cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: pad("0x0", { size: 256 }), type: "0x0", contractAddress: null } : null };
      }
      default: return { error: { code: -32601, message: `fake rpc: ${method} not served` } };
    }
  }

  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
      const all = Array.isArray(body) ? body : [body];
      const answers = all.map((r) => { calls.push(r.method); return { id: r.id, ...answer(r.method, r.params ?? []) }; });
      if (answers.some((a) => a.status === 429)) return new Response("Too Many Requests", { status: 429, headers: o.retryAfter ? { "retry-after": o.retryAfter } : {} });
      const one = (a: (typeof answers)[number]) => (a.error ? { jsonrpc: "2.0", id: a.id, error: a.error } : { jsonrpc: "2.0", id: a.id, result: a.result });
      return Response.json(Array.isArray(body) ? answers.map(one) : one(answers[0]!));
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1/secret-key`, calls, ranges, stop: () => server.stop(true) };
}
