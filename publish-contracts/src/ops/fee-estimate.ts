// Prices the transactions a Twin chain run actually sent at the LIVE Base prices, so the
// funding amounts come from a measurement. Base fee = L2 execution (gas used x L2 gas price) + L1 data fee (GasPriceOracle).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MAINNET_CHAIN_ID } from "../chains.ts";
import { createPublicClient, http, parseAbi, type Hex } from "viem";

export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F" as const;
const ORACLE_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function l1BaseFee() view returns (uint256)", "function blobBaseFee() view returns (uint256)"]);
/** 100 bytes stand in for the signed-transaction envelope the oracle also counts. */
const ENVELOPE = "00".repeat(100);

export interface StageFee { stage: string; txs: number; gas: bigint; l2Wei: bigint; l1Wei: bigint }
export interface FeeEstimate { gasPrice: bigint; l1BaseFee: bigint; blobBaseFee: bigint; stages: StageFee[]; totalWei: bigint; recommendWei: bigint; margin: bigint }

interface BroadcastFile { transactions: { transaction: { input?: string; data?: string } }[]; receipts: { gasUsed: string }[] }

/** Read each <Script>.s.sol/<chainId>/run-latest.json under a core broadcast directory. */
export function readBroadcasts(dir: string, chainId: number): { stage: string; file: BroadcastFile }[] {
  const out: { stage: string; file: BroadcastFile }[] = [];
  for (const d of readdirSync(dir).sort()) {
    const f = join(dir, d, String(chainId), "run-latest.json");
    if (existsSync(f)) out.push({ stage: d.replace(/\.s\.sol$/, ""), file: JSON.parse(readFileSync(f, "utf8")) });
  }
  return out;
}

export async function estimateFees(o: { rpc: string; broadcastDir: string; chainId?: number; margin?: bigint }): Promise<FeeEstimate> {
  const client = createPublicClient({ transport: http(o.rpc) });
  const chainId = o.chainId ?? MAINNET_CHAIN_ID;
  if (await client.getChainId() !== MAINNET_CHAIN_ID) throw new Error("RPC is not Base mainnet (8453): the estimate prices live Base fees");
  const margin = o.margin ?? 5n;
  const gasPrice = await client.getGasPrice();
  const l1BaseFee = await client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: "l1BaseFee" });
  const blobBaseFee = await client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: "blobBaseFee" });
  const stages: StageFee[] = [];
  for (const { stage, file } of readBroadcasts(o.broadcastDir, chainId)) {
    const gas = file.receipts.reduce((s, r) => s + BigInt(r.gasUsed), 0n);
    let l1 = 0n;
    for (const t of file.transactions) {
      const input = (t.transaction.input ?? t.transaction.data ?? "0x") as string;
      l1 += await client.readContract({ address: GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: "getL1Fee", args: [`${input}${ENVELOPE}` as Hex] });
    }
    stages.push({ stage, txs: file.transactions.length, gas, l2Wei: gas * gasPrice, l1Wei: l1 });
  }
  if (stages.length === 0) throw new Error(`no run-latest.json under ${o.broadcastDir}/*/${chainId}/`);
  const totalWei = stages.reduce((s, x) => s + x.l2Wei + x.l1Wei, 0n);
  return { gasPrice, l1BaseFee, blobBaseFee, stages, totalWei, recommendWei: totalWei * margin, margin };
}

export async function balanceShort(rpc: string, accounts: Record<string, `0x${string}`>, needWei: bigint): Promise<string[]> {
  const client = createPublicClient({ transport: http(rpc) });
  const short: string[] = [];
  for (const [name, addr] of Object.entries(accounts)) if ((await client.getBalance({ address: addr })) < needWei) short.push(name);
  return short;
}
