// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1 (Stack), §8.1.6 (rpcUrl, rpcFallbackUrls).
// viem clients over the primary RPC with the fallbacks behind it, and the ChainIO the sender and duties use.
import {
  createPublicClient, createWalletClient, decodeFunctionResult, defineChain, encodeFunctionData, fallback, http,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainIO, ReceiptLike, TxRequest } from "./sender.ts";

export function makeChainIO(rpcUrls: string[], chainId: number, privateKey: Uint8Array): { io: ChainIO; address: Address } {
  const account = privateKeyToAccount(`0x${Buffer.from(privateKey).toString("hex")}` as Hex);
  privateKey.fill(0);
  const chain = defineChain({
    id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
  const transport = rpcUrls.length > 1 ? fallback(rpcUrls.map((u) => http(u, { timeout: 20_000 }))) : http(rpcUrls[0], { timeout: 20_000 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ chain, transport, account });

  const io: ChainIO = {
    chainId: () => pub.getChainId(),
    async call({ from, to, data, gas, blockNumber }) {
      const r = await pub.call({ account: from, to, data, gas, blockNumber });
      return (r.data ?? "0x") as Hex;
    },
    estimateGas: ({ from, to, data }) => pub.estimateGas({ account: from, to, data }),
    blockGasLimit: async () => (await pub.getBlock({ blockTag: "latest" })).gasLimit,
    async fees() {
      const b = await pub.getBlock({ blockTag: "latest" });
      let priorityFee = 0n;
      try {
        priorityFee = await pub.estimateMaxPriorityFeePerGas();
      } catch { /* a node without eth_maxPriorityFeePerGas: tip 0 */ }
      return { baseFee: b.baseFeePerGas ?? 0n, priorityFee };
    },
    pendingNonce: (addr) => pub.getTransactionCount({ address: addr, blockTag: "pending" }),
    sendTx: (tx: TxRequest) =>
      wallet.sendTransaction({
        account, chain, to: tx.to, data: tx.data, gas: tx.gas, nonce: tx.nonce,
        maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      }),
    async receipt(hash) {
      try {
        const r = (await pub.getTransactionReceipt({ hash })) as any;
        // OP-stack receipts (Base) carry l1Fee; without an OP formatter viem leaves it as a hex string.
        return {
          transactionHash: r.transactionHash, status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed,
          effectiveGasPrice: r.effectiveGasPrice, l1Fee: r.l1Fee != null ? BigInt(r.l1Fee) : null,
        };
      } catch (e) {
        if ((e as Error).name === "TransactionReceiptNotFoundError") return null;
        throw e;
      }
    },
    balance: (addr) => pub.getBalance({ address: addr }),
    blockTimestamp: async () => (await pub.getBlock({ blockTag: "latest" })).timestamp,
  };
  return { io, address: account.address };
}

/** A typed read through ChainIO.call, decoded with the ABI. `from` matters for reads that check msg.sender. */
export async function read<T = unknown>(io: ChainIO, abi: Abi, to: Address, functionName: string, args: readonly unknown[] = [], from?: Address): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as any);
  const ret = await io.call({ from: from ?? "0x0000000000000000000000000000000000000000", to, data });
  return decodeFunctionResult({ abi, functionName, data: ret } as any) as T;
}

export const calldata = (abi: Abi, functionName: string, args: readonly unknown[] = []) =>
  encodeFunctionData({ abi, functionName, args } as any) as Hex;
