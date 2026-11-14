#!/usr/bin/env bun
// Owner key liveness record (Deploy 4 hardening, owner 2026-11-13). A reviewer read the Safe owners at nonce 0 as possibly dead keys: the owners never
// send a transaction themselves. They sign off chain and the deployer relays (core 1712). The publish's prove-control stage (prove-control.ts) executes
// one Safe self-call carrying EVERY owner's signature, so that transaction proves each owner's key signs. This tool reads the prove-control record from
// the run manifest, reads its transaction back from the chain, recovers each packed signature over the Safe transaction hash, and prints, for each
// SAFE_OWNERS entry, the signature and the transaction that prove that owner's key. It fails when any owner has no signature there. It only reads.
//
// Usage: bun publish-contracts/src/ci/owner-liveness.ts --run-manifest FILE --owners A,B,C --rpc URL --chain-id N [--out FILE]
// Exit 0: every owner proven. Exit 1: an owner lacks a signature, or the record or transaction does not hold. Exit 2: usage.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createPublicClient, decodeFunctionData, http, parseAbi, type Address, type Hex } from "viem";
import { PROOF_STAGE } from "../control-proof.ts";
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

async function main(argv: string[]): Promise<number> {
  let f: Record<string, string>;
  try { f = flags(argv); } catch (e) { console.error((e as Error).message); return 2; }
  const need = ["run-manifest", "owners", "rpc", "chain-id"];
  const miss = need.filter((k) => !f[k]);
  if (miss.length) { console.error(`usage: owner-liveness.ts --run-manifest FILE --owners A,B,C --rpc URL --chain-id N [--out FILE] (missing --${miss.join(", --")})`); return 2; }
  if (!existsSync(f["run-manifest"]!)) { console.error(`no run manifest ${f["run-manifest"]}`); return 1; }
  const manifest = JSON.parse(readFileSync(f["run-manifest"]!, "utf8"));
  const record = manifest?.stages?.[PROOF_STAGE] as Record<string, unknown> | undefined;
  const owners = f.owners!.split(",").map((x) => x.trim()).filter(Boolean);
  const client = createPublicClient({ transport: http(f.rpc) });
  let tx: LivenessInput["tx"] = null;
  if (typeof record?.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.txHash)) {
    try {
      const [t, r] = await Promise.all([client.getTransaction({ hash: record.txHash as Hex }), client.getTransactionReceipt({ hash: record.txHash as Hex })]);
      tx = { to: t.to ?? null, input: t.input, status: r.status, block: Number(r.blockNumber) };
    } catch { tx = null; }
  }
  const res = await ownerLiveness({ chainId: Number(f["chain-id"]), owners, record, tx });
  console.log(`Safe ${res.safe}: ${PROOF_STAGE} transaction ${res.txHash}${res.block !== null ? ` (block ${res.block})` : ""}, Safe transaction hash ${res.safeTxHash ?? "unknown"}`);
  for (const o of res.owners) console.log(`  owner ${o.owner}: ${o.signature ? `signature ${o.signature} recovers to this owner` : "NO SIGNATURE"}`);
  if (f.out) writeFileSync(f.out, JSON.stringify(res, null, 2) + "\n");
  for (const p of res.problems) console.error(`owner-liveness: ${p}`);
  if (res.ok) console.log(`every one of the ${res.owners.length} Safe owners signed the ${PROOF_STAGE} transaction: each key is live`);
  return res.ok ? 0 : 1;
}

if (import.meta.main) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`owner-liveness: ${(e as Error).message}`); process.exit(1); });
