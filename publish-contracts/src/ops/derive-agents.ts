// The gateway agents the deployer still owns, derived from chain logs (never guessed,
// never copied from a manifest). Scans in 2,000-block chunks because the public Base RPC caps eth_getLogs at 2,000 blocks.
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Address } from "viem";

const AUTHORIZED = parseAbiItem("event AgentAuthorized(address indexed agent, address indexed owner, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver)");
const TRANSFERRED = parseAbiItem("event AgentOwnershipTransferred(address indexed agent, address indexed previousOwner, address indexed newOwner)");
const OWNER_ABI = parseAbi(["function agentOwner(address) view returns (address)"]);

export interface DeriveAgentsOpts { rpc: string; gateway: Address; deployer: Address; fromBlock: bigint; chunk?: bigint }

export async function deriveAgents(o: DeriveAgentsOpts): Promise<Address[]> {
  const client = createPublicClient({ transport: http(o.rpc) });
  const head = await client.getBlockNumber();
  const step = o.chunk ?? 2000n;
  const found = new Set<Address>();
  for (let lo = o.fromBlock; lo <= head; lo += step) {
    const hi = lo + step - 1n > head ? head : lo + step - 1n;
    const a = await client.getLogs({ address: o.gateway, event: AUTHORIZED, args: { owner: o.deployer }, fromBlock: lo, toBlock: hi });
    const t = await client.getLogs({ address: o.gateway, event: TRANSFERRED, args: { newOwner: o.deployer }, fromBlock: lo, toBlock: hi });
    for (const l of a) found.add(getAddress(l.args.agent as Address));
    for (const l of t) found.add(getAddress(l.args.agent as Address));
  }
  const kept: Address[] = [];
  for (const agent of [...found].sort()) {
    const owner = await client.readContract({ address: o.gateway, abi: OWNER_ABI, functionName: "agentOwner", args: [agent] });
    if (owner.toLowerCase() === o.deployer.toLowerCase()) kept.push(agent);
  }
  return kept;
}
