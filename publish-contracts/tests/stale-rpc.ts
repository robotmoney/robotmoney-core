// A fake load-balanced JSON-RPC (issue 1723), served by Bun.serve on loopback: one in-memory chain with a Safe 1.4.1 world (factory, SafeL2
// singleton, fallback handler, a Safe proxy) and a deployer. After a broadcast, the first `stale[kind]` reads of each kind are answered as a
// node behind the transaction's block would: no code at the new Safe, an eth_call with no data, empty storage, the old deployer or Safe nonce.
// Then the true state. `wrong` serves a fresh but different state instead. No chain, no network, no key beyond test keys.
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, getContractAddress, keccak256, pad, type Address, type Hex } from "viem";
import { FACTORY_ABI, FALLBACK_HANDLER_SLOT, SAFE_141, SAFE_ABI, SAFE_VERSION } from "../src/safe/constants.ts";
import { localSafeTxHash } from "../src/safe/tx.ts";
import type { Signer } from "../src/safe/signers.ts";

export const FAKE_CHAIN_ID = 31337;
/** The canonical SafeProxyFactory 1.4.1 proxyCreationCode() and the runtime code it yields, as read from Base mainnet (keccak = SAFE_141.proxyCodehash). */
export const PROXY_CREATION_CODE: Hex = "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";
export const PROXY_RUNTIME_CODE: Hex = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";

/** The read kinds a node behind the write's block answers stale. */
export type StaleKind = "code" | "safeCall" | "storage" | "deployerNonce" | "safeNonce";

export interface StaleRpcOpts {
  owners: Address[];
  threshold: number;
  deployer: Address;
  /** An existing Safe at this address (the execute tests). Unset: the Safe is created by the deployer's broadcast. */
  safe?: Address;
  /** Stale reads served after the broadcast, per kind. Use Infinity for a node that never catches up. */
  stale?: Partial<Record<StaleKind, number>>;
  /** A fresh but wrong state after the broadcast. */
  wrong?: { code?: Hex; deployerNonceDelta?: number; safeNonceDelta?: number };
}

export interface StaleRpc {
  url: string;
  /** Every method served, in order. */
  calls: string[];
  /** Stale answers actually served, per kind. */
  served: Record<StaleKind, number>;
  safe(): Address | undefined;
  safeNonce(): number;
  /** The deployer: sends through this RPC like a real signer (the broadcast). */
  deployerSigner(): Signer;
  stop(): void;
}

const word = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const BLOCK = 100;

export function staleRpc(o: StaleRpcOpts): StaleRpc {
  let safe: Address | undefined = o.safe;
  let safeNonce = 0;
  let deployerNonce = 0;
  let sent = false;
  const staleLeft: Record<StaleKind, number> = { code: 0, safeCall: 0, storage: 0, deployerNonce: 0, safeNonce: 0, ...(o.stale ?? {}) };
  const served: Record<StaleKind, number> = { code: 0, safeCall: 0, storage: 0, deployerNonce: 0, safeNonce: 0 };
  const calls: string[] = [];
  /** True when this read is answered stale: only after the broadcast, and only while the kind's budget lasts. */
  const stale = (k: StaleKind): boolean => {
    if (!sent || staleLeft[k] <= 0) return false;
    staleLeft[k]--; served[k]++;
    return true;
  };
  const isSafe = (a: unknown) => !!safe && typeof a === "string" && a.toLowerCase() === safe.toLowerCase();
  const infra = new Set(Object.values(SAFE_141).filter((v) => v.length === 42).map((v) => v.toLowerCase()));

  function ethCall(tx: { to?: Address; data: Hex }): Hex {
    if (!tx.to) return tx.data.startsWith(PROXY_CREATION_CODE) ? PROXY_RUNTIME_CODE : "0x"; // the creation eth_call proxyRuntimeCodeOf runs
    const to = tx.to.toLowerCase();
    if (to === SAFE_141.proxyFactory.toLowerCase()) {
      const d = decodeFunctionData({ abi: FACTORY_ABI, data: tx.data });
      if (d.functionName === "proxyCreationCode") return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "proxyCreationCode", result: PROXY_CREATION_CODE });
      const [singleton, initializer, saltNonce] = d.args as [Address, Hex, bigint];
      const salt = keccak256(concat([keccak256(initializer), encodeAbiParameters([{ type: "uint256" }], [saltNonce])]));
      const addr = getContractAddress({ opcode: "CREATE2", from: SAFE_141.proxyFactory, salt, bytecode: concat([PROXY_CREATION_CODE, word(singleton)]) });
      return encodeFunctionResult({ abi: FACTORY_ABI, functionName: "createProxyWithNonce", result: addr });
    }
    if (to === SAFE_141.singletonL2.toLowerCase()) return encodeFunctionResult({ abi: SAFE_ABI, functionName: "VERSION", result: SAFE_VERSION });
    if (isSafe(to)) {
      const d = decodeFunctionData({ abi: SAFE_ABI, data: tx.data });
      if (d.functionName === "nonce") {
        if (stale("safeNonce")) return encodeFunctionResult({ abi: SAFE_ABI, functionName: "nonce", result: BigInt(Math.max(0, safeNonce - 1)) });
      } else if (o.safe === undefined && stale("safeCall")) return "0x"; // a node without the new Safe's code: the call returns no data
      switch (d.functionName) {
        case "VERSION": return encodeFunctionResult({ abi: SAFE_ABI, functionName: "VERSION", result: SAFE_VERSION });
        case "nonce": return encodeFunctionResult({ abi: SAFE_ABI, functionName: "nonce", result: BigInt(safeNonce) });
        case "getOwners": return encodeFunctionResult({ abi: SAFE_ABI, functionName: "getOwners", result: o.owners });
        case "getThreshold": return encodeFunctionResult({ abi: SAFE_ABI, functionName: "getThreshold", result: BigInt(o.threshold) });
        case "getTransactionHash": {
          const a = d.args as readonly unknown[];
          return encodeFunctionResult({ abi: SAFE_ABI, functionName: "getTransactionHash", result: localSafeTxHash(FAKE_CHAIN_ID, safe!, a[0] as Address, a[2] as Hex, Number(a[9])) });
        }
        case "checkNSignatures": return "0x";
        case "execTransaction": return encodeFunctionResult({ abi: SAFE_ABI, functionName: "execTransaction", result: true });
        default: throw new Error(`fake rpc: Safe ${d.functionName} not served`);
      }
    }
    throw new Error(`fake rpc: eth_call to ${tx.to} not served`);
  }

  function answer(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId": return `0x${FAKE_CHAIN_ID.toString(16)}`;
      case "eth_blockNumber": return `0x${(sent ? BLOCK + 1 : BLOCK).toString(16)}`;
      case "eth_gasPrice": return "0x1";
      case "eth_estimateGas": return "0x100000";
      case "eth_getBalance": return "0xde0b6b3a7640000";
      case "eth_getCode": {
        const a = String(params[0]).toLowerCase();
        if (infra.has(a)) return "0x6001";
        if (isSafe(a)) {
          if (o.safe === undefined && stale("code")) return "0x";
          return o.wrong?.code ?? PROXY_RUNTIME_CODE;
        }
        return "0x";
      }
      case "eth_getStorageAt": {
        if (!isSafe(params[0])) return pad("0x0", { size: 32 });
        if (stale("storage")) return pad("0x0", { size: 32 });
        const slot = BigInt(params[1] as Hex);
        if (slot === 0n) return word(SAFE_141.singletonL2);
        if (slot === BigInt(FALLBACK_HANDLER_SLOT)) return word(SAFE_141.fallbackHandler);
        return pad("0x0", { size: 32 });
      }
      case "eth_getTransactionCount": {
        if (String(params[0]).toLowerCase() !== o.deployer.toLowerCase()) return "0x0";
        if (stale("deployerNonce")) return "0x0";
        return `0x${deployerNonce.toString(16)}`;
      }
      case "eth_call": return ethCall(params[0] as { to?: Address; data: Hex });
      case "eth_getTransactionReceipt": return sent ? {
        transactionHash: TX_HASH, transactionIndex: "0x0", blockHash: `0x${"cd".repeat(32)}`, blockNumber: `0x${BLOCK.toString(16)}`, from: o.deployer, to: safe ?? SAFE_141.proxyFactory,
        cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
      } : null;
      default: throw new Error(`fake rpc: ${method} not served`);
    }
  }

  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = await req.json() as { id: number; method: string; params?: unknown[] } | { id: number; method: string; params?: unknown[] }[];
      const one = (r: { id: number; method: string; params?: unknown[] }) => {
        calls.push(r.method);
        try { return { jsonrpc: "2.0", id: r.id, result: answer(r.method, r.params ?? []) }; }
        catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } }; }
      };
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    },
  });

  /** The broadcast: the creation (no Safe yet) creates it at the address the factory computes, an execTransaction moves the Safe nonce. */
  async function broadcast(req: { to: Address; data: Hex }): Promise<Hex> {
    if (req.to.toLowerCase() === SAFE_141.proxyFactory.toLowerCase()) {
      safe = getAddress(`0x${ethCall({ to: SAFE_141.proxyFactory, data: req.data }).slice(-40)}`);
    } else if (isSafe(req.to)) {
      safeNonce += 1 + (o.wrong?.safeNonceDelta ?? 0);
    } else throw new Error(`fake rpc: broadcast to ${req.to} not served`);
    deployerNonce += 1 + (o.wrong?.deployerNonceDelta ?? 0);
    sent = true;
    return TX_HASH;
  }

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls, served,
    safe: () => safe,
    safeNonce: () => safeNonce,
    deployerSigner: () => ({
      kind: "loopback-key", modes: ["raw"],
      address: async () => o.deployer,
      signSafeHash: async () => { throw new Error("the deployer does not sign Safe transactions here"); },
      send: (req) => broadcast(req as { to: Address; data: Hex }),
    }),
    stop: () => server.stop(true),
  };
}
