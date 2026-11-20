#!/usr/bin/env bun
// Owner key liveness record (Deploy 4 hardening, owner 2026-11-13). A reviewer read the Safe owners at nonce 0 as possibly dead keys: the owners never
// send a transaction themselves. They sign off chain and the deployer relays (core 1712). The publish's prove-control stage (prove-control.ts) executes
// one Safe self-call carrying EVERY owner's signature, so that transaction proves each owner's key signs. This tool reads the prove-control record from
// the run manifest, reads its transaction back from the chain, recovers each packed signature over the Safe transaction hash, and prints, for each
// SAFE_OWNERS entry, the signature and the transaction that prove that owner's key. It fails when any owner has no signature there. It only reads.
//
// Usage: bun publish-contracts/src/ci/owner-liveness.ts --run-manifest FILE --owners A,B,C --rpc URL --chain-id N [--timelock ADDR] [--threshold N] [--out FILE]
// On the Twin (918453) a proof at or before the fork pin gets the state variant (runLiveness below), which needs --timelock.
// Exit 0: every owner proven. Exit 1: an owner lacks a signature, or the record or transaction does not hold. Exit 2: usage.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createPublicClient, decodeFunctionData, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { PROOF_STAGE } from "../control-proof.ts";
import { TWIN_CHAIN_ID } from "../chains.ts";
import { recoverSafeSigner } from "../safe/sig.ts";
import { localSafeTxHash } from "../safe/tx.ts";

const EXEC_ABI = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);
const lc = (s: string): string => s.toLowerCase();

/** One owner's line: the signature that recovers to it, or none. */
export interface OwnerProof { owner: string; signature: Hex | null }
export interface LivenessResult { ok: boolean; problems: string[]; safe: string; txHash: string; safeTxHash: Hex | null; block: number | null; owners: OwnerProof[] }

/** What the tool reads: the prove-control record of the run manifest and the landed transaction. */
export interface LivenessInput {
  chainId: number;
  owners: readonly string[];
  record: Record<string, unknown> | undefined;
  tx: { to: string | null; input: Hex; status: "success" | "reverted"; block: number } | null;
}

/** PURE apart from signature recovery. Every SAFE_OWNERS entry must have a signature in the proof transaction that recovers to it over the proof's Safe hash. */
export async function ownerLiveness(i: LivenessInput): Promise<LivenessResult> {
  const problems: string[] = [];
  const rec = i.record;
  const safe = String(rec?.safe ?? ""), txHash = String(rec?.txHash ?? "");
  const out: LivenessResult = { ok: false, problems, safe, txHash, safeTxHash: null, block: i.tx?.block ?? null, owners: i.owners.map((o) => ({ owner: o, signature: null })) };
  if (!rec || rec.status !== "done" || !/^0x[0-9a-fA-F]{64}$/.test(txHash) || !/^0x[0-9a-fA-F]{40}$/.test(safe) || !Number.isInteger(rec.nonce)) {
    problems.push(`the run manifest holds no finished ${PROOF_STAGE} record (status done, safe, txHash, nonce): the owners' keys are not proven`);
    return out;
  }
  if (i.owners.length === 0) problems.push("SAFE_OWNERS is empty");
  if (!i.tx) { problems.push(`the ${PROOF_STAGE} transaction ${txHash} is not on this chain`); return out; }
  if (i.tx.status !== "success") problems.push(`the ${PROOF_STAGE} transaction ${txHash} reverted`);
  if (!i.tx.to || lc(i.tx.to) !== lc(safe)) problems.push(`the ${PROOF_STAGE} transaction goes to ${i.tx.to ?? "no address"}, not the Safe ${safe}`);
  let args: readonly unknown[];
  try { args = decodeFunctionData({ abi: EXEC_ABI, data: i.tx.input }).args as readonly unknown[]; } catch { problems.push(`the ${PROOF_STAGE} transaction is not an execTransaction call`); return out; }
  const [to, , data, , , , , , , signatures] = args as [string, bigint, Hex, number, bigint, bigint, bigint, string, string, Hex];
  if (lc(to) !== lc(safe) || data !== "0x") problems.push(`the ${PROOF_STAGE} transaction is not the Safe's empty self-call`);
  const hash = localSafeTxHash(i.chainId, safe as Address, safe as Address, "0x", rec.nonce as number);
  out.safeTxHash = hash;
  const blob = signatures.slice(2);
  if (blob.length === 0 || blob.length % 130 !== 0) { problems.push(`the ${PROOF_STAGE} transaction carries ${blob.length / 2} signature bytes, not a multiple of 65`); return out; }
  const bySigner = new Map<string, Hex>();
  for (let k = 0; k < blob.length; k += 130) {
    const sig = `0x${blob.slice(k, k + 130)}` as Hex;
    try { bySigner.set(lc(await recoverSafeSigner(hash, sig)), sig); } catch { /* a contract or approved-hash signature proves no EOA key */ }
  }
  for (const o of out.owners) {
    o.signature = bySigner.get(lc(o.owner)) ?? null;
    if (!o.signature) problems.push(`owner ${o.owner} has no signature over Safe transaction hash ${hash} in ${txHash}: its key is not proven`);
  }
  out.ok = problems.length === 0;
  return out;
}

function flags(argv: string[]): Record<string, string> {
  const f: Record<string, string> = {};
  for (let k = 0; k < argv.length; k += 2) {
    const name = argv[k]!, v = argv[k + 1];
    if (!name.startsWith("--") || v === undefined) throw new Error(`bad argument ${name}`);
    f[name.slice(2)] = v;
  }
  return f;
}

/**
 * Issue 2044, owner decision 2026-11-20: on the Twin (chain 918453, an anvil fork of Base) no check reads Base history before the fork pin. The Deploy 4 prove-control
 * transaction landed on 8453 before the pin, so reading it back through the fork would ask the public Base RPC. Its signatures are checked on 8453 by the live run.
 * The Twin variant proves the state that transaction left instead: the Safe's owners equal SAFE_OWNERS and its threshold is sane NOW, and the Safe holds the timelock's
 * PROPOSER, EXECUTOR and CANCELLER roles NOW. A proof recorded after the pin (a fresh Twin deploy) is still read back in full.
 */
const role = (n: string): Hex => keccak256(toHex(n));
export const TIMELOCK_ROLES = { PROPOSER_ROLE: role("PROPOSER_ROLE"), EXECUTOR_ROLE: role("EXECUTOR_ROLE"), CANCELLER_ROLE: role("CANCELLER_ROLE") } as const;

/** What the CLI reads from the chain. A stub implements it in tests. */
export interface LivenessChain {
  chainId(): Promise<number>;
  /** anvil_nodeInfo forkConfig.forkBlockNumber, or undefined when the node is no anvil fork. */
  forkPin(): Promise<bigint | undefined>;
  tx(hash: Hex): Promise<LivenessInput["tx"]>;
  safeOwners(safe: Address): Promise<string[]>;
  safeThreshold(safe: Address): Promise<number>;
  hasRole(at: Address, r: Hex, who: Address): Promise<boolean>;
}

export interface TwinStateResult { ok: boolean; variant: "twin-state"; label: string; problems: string[]; safe: string; txHash: string; pin: string; owners: string[]; threshold: number | null; roles: Record<string, boolean> }

export interface LivenessArgs { chainId: number; owners: string[]; record: Record<string, unknown> | undefined; timelock?: string; threshold?: number }

/** The tool's whole run against `chain`. On 918453 a proof at or before the fork pin (or with no recorded block) gets the Twin state variant and its transaction is never read. */
export async function runLiveness(a: LivenessArgs, chain: LivenessChain): Promise<LivenessResult | TwinStateResult> {
  const rec = a.record;
  if ((await chain.chainId()) === TWIN_CHAIN_ID) {
    const pin = await chain.forkPin();
    const block = typeof rec?.block === "number" ? BigInt(rec.block) : undefined;
    if (pin === undefined || block === undefined || block <= pin) return await twinState(a, chain, pin);
  }
  let tx: LivenessInput["tx"] = null;
  if (typeof rec?.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(rec.txHash)) {
    try { tx = await chain.tx(rec.txHash as Hex); } catch { tx = null; }
  }
  return await ownerLiveness({ chainId: a.chainId, owners: a.owners, record: rec, tx });
}

async function twinState(a: LivenessArgs, chain: LivenessChain, pin: bigint | undefined): Promise<TwinStateResult> {
  const problems: string[] = [];
  const safe = String(a.record?.safe ?? ""), txHash = String(a.record?.txHash ?? "");
  const out: TwinStateResult = { ok: false, variant: "twin-state", label: `owner liveness (Twin: Safe owners, threshold and timelock roles now; the ${PROOF_STAGE} signatures before the fork pin are checked on 8453 by the live record)`, problems, safe, txHash, pin: pin === undefined ? "none" : String(pin), owners: [], threshold: null, roles: {} };
  if (pin === undefined) { problems.push("chain 918453 is not an anvil fork (anvil_nodeInfo names no fork block): no Base history is read through it"); return out; }
  if (!/^0x[0-9a-fA-F]{40}$/.test(safe)) { problems.push(`the run manifest holds no ${PROOF_STAGE} record naming the Safe`); return out; }
  if (!a.timelock || !/^0x[0-9a-fA-F]{40}$/.test(a.timelock)) { problems.push("the Twin variant needs --timelock ADDR (the fund-system timelock) to check the Safe's roles"); return out; }
  out.owners = (await chain.safeOwners(safe as Address)).map(lc).sort();
  const want = a.owners.map(lc).sort();
  if (want.length === 0) problems.push("SAFE_OWNERS is empty");
  if (out.owners.join(",") !== want.join(",")) problems.push(`the Safe's owners now are [${out.owners.join(",")}], not SAFE_OWNERS [${want.join(",")}]`);
  out.threshold = await chain.safeThreshold(safe as Address);
  if (a.threshold !== undefined ? out.threshold !== a.threshold : !(out.threshold >= 1 && out.threshold <= want.length)) problems.push(`the Safe's threshold now is ${out.threshold}${a.threshold !== undefined ? `, not ${a.threshold}` : `, outside 1..${want.length}`}`);
  for (const [n, r] of Object.entries(TIMELOCK_ROLES)) {
    out.roles[n] = await chain.hasRole(a.timelock as Address, r, safe as Address);
    if (!out.roles[n]) problems.push(`the Safe does not hold the timelock's ${n} now`);
  }
  out.ok = problems.length === 0;
  return out;
}

function viemLivenessChain(rpc: string): LivenessChain {
  const client = createPublicClient({ transport: http(rpc) });
  const abi = parseAbi(["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)", "function hasRole(bytes32 role, address account) view returns (bool)"]);
  return {
    chainId: () => client.getChainId(),
    forkPin: async () => {
      try { const n = ((await client.request({ method: "anvil_nodeInfo" } as any)) as any)?.forkConfig?.forkBlockNumber; return n === undefined || n === null ? undefined : BigInt(n); } catch { return undefined; }
    },
    tx: async (hash) => {
      const [t, r] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
      return { to: t.to ?? null, input: t.input, status: r.status, block: Number(r.blockNumber) };
    },
    safeOwners: async (safe) => [...((await client.readContract({ address: safe, abi, functionName: "getOwners" })) as readonly string[])],
    safeThreshold: async (safe) => Number(await client.readContract({ address: safe, abi, functionName: "getThreshold" })),
    hasRole: async (at, r, who) => (await client.readContract({ address: at, abi, functionName: "hasRole", args: [r, who] })) as boolean,
  };
}

async function main(argv: string[]): Promise<number> {
  let f: Record<string, string>;
  try { f = flags(argv); } catch (e) { console.error((e as Error).message); return 2; }
  const need = ["run-manifest", "owners", "rpc", "chain-id"];
  const miss = need.filter((k) => !f[k]);
  if (miss.length) { console.error(`usage: owner-liveness.ts --run-manifest FILE --owners A,B,C --rpc URL --chain-id N [--timelock ADDR] [--threshold N] [--out FILE] (missing --${miss.join(", --")})`); return 2; }
  if (!existsSync(f["run-manifest"]!)) { console.error(`no run manifest ${f["run-manifest"]}`); return 1; }
  const manifest = JSON.parse(readFileSync(f["run-manifest"]!, "utf8"));
  const record = manifest?.stages?.[PROOF_STAGE] as Record<string, unknown> | undefined;
  const owners = f.owners!.split(",").map((x) => x.trim()).filter(Boolean);
  const res = await runLiveness({ chainId: Number(f["chain-id"]), owners, record, timelock: f.timelock, ...(f.threshold ? { threshold: Number(f.threshold) } : {}) }, viemLivenessChain(f.rpc!));
  if (f.out) writeFileSync(f.out, JSON.stringify(res, null, 2) + "\n");
  for (const p of res.problems) console.error(`owner-liveness: ${p}`);
  if ("variant" in res) {
    console.log(`${res.label}: Safe ${res.safe}, fork pin ${res.pin}, owners [${res.owners.join(",")}], threshold ${res.threshold ?? "unread"}, roles ${JSON.stringify(res.roles)}`);
    if (res.ok) console.log("Twin: the Safe's owners, threshold and timelock roles hold now; the proof transaction is before the fork pin, verified on 8453 by the live record");
    return res.ok ? 0 : 1;
  }
  console.log(`Safe ${res.safe}: ${PROOF_STAGE} transaction ${res.txHash}${res.block !== null ? ` (block ${res.block})` : ""}, Safe transaction hash ${res.safeTxHash ?? "unknown"}`);
  for (const o of res.owners) console.log(`  owner ${o.owner}: ${o.signature ? `signature ${o.signature} recovers to this owner` : "NO SIGNATURE"}`);
  if (res.ok) console.log(`every one of the ${res.owners.length} Safe owners signed the ${PROOF_STAGE} transaction: each key is live`);
  return res.ok ? 0 : 1;
}

if (import.meta.main) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`owner-liveness: ${(e as Error).message}`); process.exit(1); });
