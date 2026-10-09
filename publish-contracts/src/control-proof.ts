// The Safe control proof (core 1618, plan decision 21): before the stage 11 handover the real Safe executes one self-call (value 0, empty
// data) signed by EVERY owner, so a Safe whose keys cannot sign is found while the deployer still holds every role.
// This file holds what both sides share: the run manifest record, the stage 11 refusal, and the read-back of the proof transaction
// (the verifier). It imports no runner code at run time. The step itself is prove-control.ts.
import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { recoverSafeSigner } from "./safe/sig.ts";
import { localSafeTxHash } from "./safe/tx.ts";
import type { StageRecord } from "./runner.ts";

/** The run manifest key of the proof record, and the name of the CLI stage between stage 10 and stage 11. */
export const PROOF_STAGE = "prove-control";

/** What the run manifest keeps under `stages["prove-control"]`. */
export interface ControlProofRecord {
  status: "done";
  safe: Address;
  /** The execTransaction hash. */
  txHash: Hex;
  /** The Safe transaction hash every owner signed. */
  safeTxHash: Hex;
  /** The Safe nonce the proof used (0: the Safe is new). */
  nonce: number;
  /** Every owner who signed, lowercase, sorted. */
  signers: Address[];
  block: number;
  sentBy: Address;
  /** True when the run died after the proof landed and a rerun with --resume found it on chain (prove-control.ts adoptLandedProof). Absent on a proof this run sent. */
  adopted?: boolean;
}

const lc = (a: string): string => a.toLowerCase();

const notProven = (message: string, details: Record<string, unknown> = {}): PublishError =>
  new PublishError("CONTROL_NOT_PROVEN", `${message}. Run the ${PROOF_STAGE} stage with every Safe owner signing before stage 11.`, details);

export { notProven as controlNotProven };

/**
 * The stage 11 gate. Refuses unless the run manifest holds a finished proof on THIS Safe, signed by every owner the Safe has now, and the
 * Safe nonce is 1 or more. `owners` and `nonce` are read from the live Safe by the caller. Stage 0 asserts nonce 0, so a nonce of 1 or more
 * here means the Safe really executed something.
 */
export function assertControlProven(rec: StageRecord | undefined, o: { safe: string; owners: readonly string[]; nonce: number }): ControlProofRecord {
  if (!rec || rec.status !== "done" || typeof rec.txHash !== "string" || !Array.isArray(rec.signers)) {
    throw notProven("the run manifest records no finished Safe control proof transaction", { stage: PROOF_STAGE });
  }
  if (typeof rec.safe !== "string" || lc(rec.safe) !== lc(o.safe)) {
    throw notProven(`the recorded control proof is for Safe ${String(rec.safe)}, not the Safe ${o.safe} this run hands over to`, { recorded: rec.safe, safe: o.safe });
  }
  const signed = new Set((rec.signers as string[]).map(lc));
  const missing = o.owners.filter((x) => !signed.has(lc(x)));
  if (missing.length > 0) throw notProven(`the recorded control proof lacks a signature from ${missing.join(", ")}`, { missing });
  if (!Number.isInteger(o.nonce) || o.nonce < 1) throw notProven(`the Safe nonce is ${o.nonce}: the Safe has executed nothing`, { nonce: o.nonce });
  return rec as unknown as ControlProofRecord;
}

const EXEC_ABI = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);

export interface ProofTxRead { to: string | null; input: Hex; value: bigint }

/**
 * Reads the proof transaction back (the verifier): a call to the Safe that is execTransaction(safe, 0, empty, call, no gas fields) at the
 * recorded nonce, whose packed signatures recover, over the Safe transaction hash, to exactly the owners. Returns what it found.
 */
export async function inspectProofTx(a: { chainId: number; safe: Address; owners: readonly string[]; nonce: number; tx: ProofTxRead }): Promise<{ ok: boolean; detail: string }> {
  const { tx } = a;
  if (!tx.to || lc(tx.to) !== lc(a.safe)) return { ok: false, detail: `the proof transaction goes to ${tx.to ?? "no address"}, not the Safe ${a.safe}` };
  if (tx.value !== 0n) return { ok: false, detail: `the proof transaction carries value ${tx.value}` };
  let args: readonly unknown[];
  try { args = decodeFunctionData({ abi: EXEC_ABI, data: tx.input }).args as readonly unknown[]; } catch { return { ok: false, detail: "the proof transaction is not an execTransaction call" }; }
  const [to, value, data, operation, safeTxGas, baseGas, gasPrice, , , signatures] = args as [string, bigint, Hex, number, bigint, bigint, bigint, string, string, Hex];
  if (lc(to) !== lc(a.safe)) return { ok: false, detail: `the proof calls ${to}, not the Safe itself` };
  if (value !== 0n || data !== "0x" || operation !== 0 || safeTxGas !== 0n || baseGas !== 0n || gasPrice !== 0n) {
    return { ok: false, detail: "the proof is not a plain call with value 0, empty data and no gas fields" };
  }
  const blob = signatures.slice(2);
  if (blob.length === 0 || blob.length % 130 !== 0) return { ok: false, detail: `the proof carries ${blob.length / 2} signature bytes, not a multiple of 65` };
  const hash = localSafeTxHash(a.chainId, a.safe, a.safe, "0x", a.nonce);
  const recovered = new Set<string>();
  for (let i = 0; i < blob.length; i += 130) {
    try { recovered.add(lc(await recoverSafeSigner(hash, `0x${blob.slice(i, i + 130)}` as Hex))); } catch { return { ok: false, detail: `signature ${i / 130} is not an EOA signature` }; }
  }
  if (recovered.size !== blob.length / 130) return { ok: false, detail: `the proof carries ${blob.length / 130} signatures from ${recovered.size} distinct signers: a signer is repeated` };
  const missing = a.owners.filter((x) => !recovered.has(lc(x)));
  if (missing.length > 0) return { ok: false, detail: `no valid signature over the proof hash from ${missing.join(", ")}` };
  const extra = [...recovered].filter((x) => !a.owners.some((o) => lc(o) === x));
  if (extra.length > 0) return { ok: false, detail: `signatures from non-owners: ${extra.join(", ")}` };
  return { ok: true, detail: `${recovered.size} of ${a.owners.length} owners signed, hash ${hash}` };
}
