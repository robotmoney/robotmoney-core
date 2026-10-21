// The `record-receipt` verb (issue 1727, amended by issue 1888): the SUBMITTER SAFE anchors ONE consensus receipt DIRECTLY on the receipt contract,
// ConsensusRecommendationReceipt.recordReceipt(receiptId, payloadDigest, payloadUri). There is no gateway and no committee registry (docs/architecture.md 4.8, 4.9).
// Docs: docs/technical/consensus-receipt-submitter-runbook.md.
//
// THE SUBMITTER IS A SAFE ON EVERY CHAIN AND IN EVERY MODE (production 8453, rehearsal 8453, the Twin). --submitter is a SafeL2 1.4.1 proxy that holds RECEIPT_SUBMITTER_ROLE on the
// receipt (granted by `govern --row register-submitter`, one delayed timelock call). It MAY be the governing Safe, and its owners may be shared. The verb proposes recordReceipt to the
// receipt contract through that Safe, collects the signatures of `threshold` of its owners (--owner-signer) and executes with --signer, the gas payer. A single key (an EOA, no code) is
// refused in every mode. No key, passphrase or keystore path is ever written to the repo, the evidence or the run manifest.
//
// THE PAYLOAD BYTES ARE MANDATORY (issue 1888, RS-1019-17). The operator first verifies the analyst signatures with `rmpc receipt verify` on the exact served bytes. This verb then requires
// those same bytes (--payload FILE), recomputes the domain-separated digest (keccak256("robotmoney:consensus-receipt:v1\n" + compact JSON + "\n")) and the receipt id
// (keccak256("robotmoney:consensus-receipt-id:v1\n" + session_id + "\n" + subject_id)) and refuses a --receipt-id or --payload-digest that differs. All of that, the Safe checks and the live
// RECEIPT_SUBMITTER_ROLE read run BEFORE any signer is constructed: a refusal never prompts for a passphrase, constructs no signer and sends nothing.
//
// BEFORE ANYTHING IS SENT it also checks, on chain: the receipt id is not recorded yet (or is recorded with exactly this digest, uri and submitter, which is reported and not sent again).
// AFTER it requires the Safe's ExecutionSuccess and the receipt contract's ReceiptRecorded log, then reads the receipt back and compares id, digest, uri and submitter.
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseAbiItem, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { supportedReceiptPayload } from "./receipt-digest.ts";
import { RECEIPT_SUBMITTER_ROLE } from "./verify/constants.ts";
import { loadRunManifest, readManifestField, saveRunManifest, confirmStage, type RunContext } from "./runner.ts";
import { manifestRef } from "./stages.ts";
import { checkSignaturesOnChain, connectSafe, executeTx, proposeTx, signTx, type Logger, type Signer } from "./safe/index.ts";
import { assertSubmitterSafe, chainFromClient, forbiddenSubmitters, submitterSafeEvidence, type SubmitterChain, type SubmitterSafeEvidence } from "./submitter-safe.ts";

export const RECEIPT_RECORD_ABI = parseAbi([
  "function recordReceipt(bytes32 receiptId, bytes32 payloadDigest, string payloadUri) returns (uint256 index)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
export const RECEIPT_READ_ABI = parseAbi([
  "function isRecorded(bytes32 receiptId) view returns (bool)",
  "function getReceiptById(bytes32 receiptId) view returns ((bytes32 receiptId, bytes32 payloadDigest, string payloadUri, address submitter, uint64 recordedAt, uint64 releasedAt, bool released))",
]);
export { RECEIPT_SUBMITTER_ROLE };

export interface RecordInputs { receiptId: Hex; payloadDigest: Hex; payloadUri: string }
export interface RecordedReceipt {
  receipt_id: Hex; payload_digest: Hex; payload_uri: string; submitter: Address; tx_hash?: Hex; status: 1; block_number?: number;
  /** True when the receipt was already on chain with the same digest, uri and submitter: nothing was sent. */
  already_recorded?: boolean;
  /** Issue 1750: present when the submitter is a Safe (always, on 8453): its threshold and owners, and how the receipt tx was authorised. Facts only, never a key. */
  submitter_safe?: SubmitterSafeRecord;
}
export interface SubmitterSafeRecord extends SubmitterSafeEvidence {
  address: Address;
  /** The Safe transaction hash, nonce and the owners that signed it. Absent when the receipt was already on chain and nothing was sent. */
  safe_tx_hash?: Hex; nonce?: number; signers?: Address[]; sent_by?: Address;
}

/** What one Safe execution of consensusRecordReceipt reports back. */
export interface SafeSendResult {
  txHash: Hex; status: "success" | "reverted"; blockNumber: bigint;
  /** The Safe that executed (the handle's address): must equal the submitter. */
  safe: Address; safeTxHash: Hex; nonce: number; signers: Address[]; sentBy: Address;
  /** The Safe emitted ExecutionSuccess for this Safe transaction hash. */
  executionSuccess: boolean;
  /** The receipt contract emitted ReceiptRecorded for the receipt id with the Safe as submitter, in this transaction. */
  receiptRecorded: boolean;
}
export interface SafeSendRequest { safe: Address; ownerSigners: Signer[]; sender: Signer; to: Address; data: Hex; description: string; receiptId: Hex }

/** The chain reads and the one send of the verb. Tests inject a fake; the real one is viem over the run's RPC and the Safe tool signer. */
export interface RecordApi {
  read<T>(address: Address, abi: readonly unknown[], fn: string, args?: unknown[]): Promise<T>;
  /** Issue 1750: code, storage and reads of the submitter, for the canonical-Safe check. Required: the submitter is a Safe on every chain. */
  chain?: SubmitterChain;
  /** Issue 1750: the transaction that recorded `receiptId` (the receipt contract's ReceiptRecorded log) and the Safe transaction hash of the Safe's ExecutionSuccess in it. Null when not found. */
  findRecordTx?(receipt: Address, receiptId: Hex, safe: Address): Promise<{ txHash: Hex; blockNumber: bigint; safeTxHash?: Hex } | null>;
  /** Issue 1750: propose, sign with the owners, execute with the sender (the deployer pays the gas). Needed in Safe mode. */
  sendViaSafe?(req: SafeSendRequest): Promise<SafeSendResult>;
}

const EXECUTION_SUCCESS = parseAbiItem("event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)");
const RECEIPT_RECORDED = parseAbiItem("event ReceiptRecorded(bytes32 indexed receiptId, address indexed submitter, uint256 indexed index, bytes32 payloadDigest, string payloadUri, uint64 recordedAt)");

type LogLike = { address: Address; topics: readonly Hex[]; data: Hex };
/** True when the Safe emitted ExecutionSuccess for `safeTxHash` in `logs`. */
export function hasExecutionSuccess(logs: readonly LogLike[], safe: Address, safeTxHash: Hex): boolean {
  const events = parseEventLogs({ abi: [EXECUTION_SUCCESS], logs: logs as never, eventName: "ExecutionSuccess" });
  return events.some((e) => e.address.toLowerCase() === safe.toLowerCase() && String(e.args.txHash).toLowerCase() === safeTxHash.toLowerCase());
}
/**
 * The ExecutionSuccess lookup, bounded (issue 1723: a stale load-balanced RPC may answer a receipt without its logs). The logs already in hand are tried first, then the
 * receipt is fetched again `tries - 1` more times with `delayMs` between. Still absent: false, and the caller fails closed.
 */
export async function awaitExecutionSuccess(fetchLogs: () => Promise<readonly LogLike[]>, safe: Address, safeTxHash: Hex, first: readonly LogLike[], o: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const tries = o.tries ?? 5, delay = o.delayMs ?? 1000, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (hasExecutionSuccess(first, safe, safeTxHash)) return true;
  for (let i = 1; i < tries; i++) {
    await sleep(delay);
    let logs: readonly LogLike[] = [];
    try { logs = await fetchLogs(); } catch { /* try again */ }
    if (hasExecutionSuccess(logs, safe, safeTxHash)) return true;
  }
  return false;
}

export function realRecordApi(rpc: string, chainId: number, logger?: Logger): RecordApi {
  const client = createPublicClient({ transport: http(rpc) });
  return {
    read: (address, abi, fn, args = []) => client.readContract({ address, abi: abi as never, functionName: fn as never, args: args as never }) as Promise<never>,
    chain: chainFromClient(client as never),
    findRecordTx: async (receipt, receiptId, safe) => {
      const logs = await client.getLogs({ address: receipt, event: RECEIPT_RECORDED, args: { receiptId }, fromBlock: 0n, toBlock: "latest" });
      const l = logs[0];
      if (!l?.transactionHash) return null;
      const rc = await client.getTransactionReceipt({ hash: l.transactionHash });
      const ev = parseEventLogs({ abi: [EXECUTION_SUCCESS], logs: rc.logs as never, eventName: "ExecutionSuccess" }).find((e) => e.address.toLowerCase() === safe.toLowerCase());
      return { txHash: l.transactionHash, blockNumber: rc.blockNumber, ...(ev ? { safeTxHash: ev.args.txHash as Hex } : {}) };
    },
    sendViaSafe: async (req) => {
      const handle = await connectSafe({ rpcUrl: rpc, chainId, safeAddress: req.safe, logger });
      if (handle.address.toLowerCase() !== req.safe.toLowerCase()) throw new PublishError("USAGE", `the Safe the tool connected to (${handle.address}) is not --submitter ${req.safe}: nothing sent`);
      let bundle = await proposeTx(handle, { to: req.to, data: req.data, action: "record-receipt", description: req.description });
      for (const s of req.ownerSigners) bundle = await signTx(handle, bundle, s);
      try { await checkSignaturesOnChain(handle, bundle, bundle.signatures, handle.threshold); }
      catch (e) { throw new PublishError("GOVERN", `the submitter Safe rejected the owner signatures before execution: ${(e as Error).message}. Nothing sent.`); }
      const res = await executeTx(handle, bundle, req.sender);
      if (!res.txHash) throw new PublishError("GOVERN", "the submitter Safe transaction was not sent");
      const rc = await client.waitForTransactionReceipt({ hash: res.txHash });
      const executionSuccess = await awaitExecutionSuccess(async () => (await client.getTransactionReceipt({ hash: res.txHash! })).logs as never, handle.address, bundle.safe_tx_hash, rc.logs as never);
      const receiptRecorded = parseEventLogs({ abi: [RECEIPT_RECORDED], logs: rc.logs as never, eventName: "ReceiptRecorded" })
        .some((e) => e.address.toLowerCase() === req.to.toLowerCase() && String(e.args.receiptId).toLowerCase() === req.receiptId.toLowerCase() && String(e.args.submitter).toLowerCase() === handle.address.toLowerCase());
      return { txHash: res.txHash, status: rc.status, blockNumber: rc.blockNumber, safe: handle.address, safeTxHash: bundle.safe_tx_hash, nonce: bundle.nonce, signers: bundle.signatures.map((x) => x.owner), sentBy: res.sentBy, executionSuccess, receiptRecorded };
    },
  };
}

const B32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (x: string) => x.toLowerCase();

/**
 * Issue 1888: the payload bytes are MANDATORY. The digest and the receipt id are recomputed from them (receipt-digest.ts supportedReceiptPayload) and a --receipt-id or
 * --payload-digest that differs is refused naming both. Pure: no chain, no signer. Throws USAGE (nothing sent).
 */
export function assertRecordInputs(i: { receiptId?: string; payloadDigest?: string; payloadUri?: string; payload?: Uint8Array }): RecordInputs {
  if (!i.receiptId || !B32.test(i.receiptId)) throw new PublishError("USAGE", "--receipt-id must be a 0x-prefixed bytes32 (the receipt_id that `rmpc receipt verify` prints)");
  if (!i.payloadDigest || !B32.test(i.payloadDigest)) throw new PublishError("USAGE", "--payload-digest must be a 0x-prefixed bytes32 (the payload_digest that `rmpc receipt verify` prints)");
  if (!i.payloadUri || !/^https?:\/\/\S+$/.test(i.payloadUri)) throw new PublishError("USAGE", "--payload-uri must be the public http(s) route that serves the exact payload bytes");
  const p = supportedReceiptPayload(i.payload);
  if (p.digest.toLowerCase() !== i.payloadDigest.toLowerCase()) {
    throw new PublishError("USAGE", `--payload-digest ${i.payloadDigest} is not the receipt digest of the payload bytes ${p.digest}: the digest is keccak256("robotmoney:consensus-receipt:v1\\n" + the canonical receipt bytes), not a plain keccak256 of the file (plain keccak256 of these bytes is ${keccak256(i.payload!)})`, { digest: i.payloadDigest, computed: p.digest });
  }
  if (p.receiptId.toLowerCase() !== i.receiptId.toLowerCase()) throw new PublishError("USAGE", `--receipt-id ${i.receiptId} is not the receipt id ${p.receiptId} derived from the payload's session_id and subject_id`, { receipt_id: i.receiptId, derived: p.receiptId });
  return { receiptId: i.receiptId.toLowerCase() as Hex, payloadDigest: i.payloadDigest.toLowerCase() as Hex, payloadUri: i.payloadUri };
}

/** The addresses the verb talks to, from the stage manifests of the run. */
export const loadRecordAddrs = (ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): { receipt: Address; safe: Address; timelock: Address } => ({
  safe: readManifestField(ctx, manifestRef("safe", "safe")) as Address,
  timelock: readManifestField(ctx, manifestRef("timelock", "timelock")) as Address,
  receipt: readManifestField(ctx, manifestRef("receipt", "consensus_receipt")) as Address,
});

/** What the verb is asked to record. `payload` and `submitter` are mandatory: a missing one is refused before anything is read or built. */
export interface RecordRequest { receiptId?: string; payloadDigest?: string; payloadUri?: string; payload?: Uint8Array; submitter?: string }
/**
 * The signers, as FACTORIES: nothing is constructed (no keystore read, no passphrase prompt, no device prompt) until every input and chain check has passed.
 * `sender` is the gas payer (--signer). `owners` are the submitter Safe's owner signers (--owner-signer).
 */
export interface RecordSigners { sender(): Promise<Signer>; owners(): Promise<Signer[]> }

export async function recordReceipt(ctx: RunContext, signers: RecordSigners, req: RecordRequest, api: RecordApi = realRecordApi(ctx.rpc, ctx.chainId, ctx.log)): Promise<RecordedReceipt> {
  // 1. Pure input checks: the payload bytes, the digest and the id. No chain read, no signer.
  const i = assertRecordInputs(req);
  if (req.submitter === undefined || !/^0x[0-9a-fA-F]{40}$/.test(req.submitter) || /^0x0{40}$/.test(req.submitter)) {
    throw new PublishError("USAGE", "record-receipt needs --submitter <the submitter Safe> (a SafeL2 1.4.1 multisig) and the --owner-signer of its owners: the consensus receipt submitter is a Safe on every chain, never a single key. --signer is the gas payer. Nothing sent.");
  }
  const submitter = getAddress(req.submitter);
  const a = loadRecordAddrs(ctx);
  if (!api.chain || !api.sendViaSafe) throw new PublishError("USAGE", "this record API cannot read or execute a Safe: nothing sent");
  // 2. The submitter is a canonical Safe (an EOA, a bad configuration or a forbidden address is refused), then it holds the live role on the receipt. Still no signer.
  const forbidden = forbiddenSubmitters({ timelock: a.timelock, admin: ctx.sheet.admin, pauser: ctx.sheet.pauser, emergency: ctx.sheet.emergency });
  const safeInfo = await assertSubmitterSafe(api.chain, submitter, forbidden);
  if (!(await api.read<boolean>(a.receipt, RECEIPT_RECORD_ABI, "hasRole", [RECEIPT_SUBMITTER_ROLE, submitter]))) {
    throw new PublishError("GOVERN", `the submitter ${submitter} does not hold RECEIPT_SUBMITTER_ROLE on the receipt ${a.receipt}: run govern --row register-submitter --submitter ${submitter} first. Nothing sent.`, { submitter });
  }
  const recorded = await api.read<boolean>(a.receipt, RECEIPT_READ_ABI, "isRecorded", [i.receiptId]);
  const readBack = async (): Promise<void> => {
    const r = await api.read<{ receiptId: Hex; payloadDigest: Hex; payloadUri: string; submitter: Address }>(a.receipt, RECEIPT_READ_ABI, "getReceiptById", [i.receiptId]);
    const bad: string[] = [];
    if (lc(r.receiptId) !== lc(i.receiptId)) bad.push(`receiptId ${r.receiptId}`);
    if (lc(r.payloadDigest) !== lc(i.payloadDigest)) bad.push(`payloadDigest ${r.payloadDigest}`);
    if (r.payloadUri !== i.payloadUri) bad.push(`payloadUri ${r.payloadUri}`);
    if (lc(r.submitter) !== lc(submitter)) bad.push(`submitter ${r.submitter}`);
    if (bad.length) throw new PublishError("GOVERN", `the receipt on chain differs from what was asked: ${bad.join(", ")}`, { receipt_id: i.receiptId });
  };
  if (recorded) {
    await readBack(); // same digest, uri and submitter: nothing to send. Anything else throws: an id is recorded once and a wrong digest blocks it for good.
    ctx.log.log("info", "record_receipt.already_recorded", { receipt_id: i.receiptId, submitter });
    // Issue 1750: the earlier run may have died after the Safe transaction landed (a stale RPC read). If the evidence has no transaction for this receipt yet, find it on chain
    // (the receipt contract's ReceiptRecorded log, then the Safe's ExecutionSuccess in that transaction) and write tx_hash and safe_tx_hash. Not found: no guess, the entry stays
    // already_recorded without a transaction (the runbook says how to add it by hand).
    let found: Awaited<ReturnType<NonNullable<RecordApi["findRecordTx"]>>> = null;
    const prior = (loadRunManifest(ctx.evidenceDir)?.recorded_receipts as RecordedReceipt[] | undefined)?.find((x) => lc(x.receipt_id) === lc(i.receiptId));
    if (!prior?.tx_hash && api.findRecordTx) {
      try { found = await api.findRecordTx(a.receipt, i.receiptId, submitter); } catch (e) { ctx.log.log("warn", "record_receipt.find_tx_failed", { receipt_id: i.receiptId, error: (e as Error).message }); }
    }
    return finish(ctx, {
      receipt_id: i.receiptId, payload_digest: i.payloadDigest, payload_uri: i.payloadUri, submitter, status: 1, already_recorded: true,
      ...(found ? { tx_hash: found.txHash, block_number: Number(found.blockNumber) } : {}),
      submitter_safe: { address: submitter, ...submitterSafeEvidence(safeInfo), ...(found?.safeTxHash ? { safe_tx_hash: found.safeTxHash } : {}) },
    });
  }
  // 3. Only now are signers constructed. Enough owner signers to reach the threshold, named before anything is proposed or signed. Signers that are not owners of the Safe are ignored.
  const sender = await signers.sender();
  const ownerSigners = await signers.owners();
  const byOwner = new Map<string, Signer>();
  for (const s of ownerSigners) { const who = (await s.address()).toLowerCase(); if (safeInfo.owners.some((o) => o.toLowerCase() === who) && !byOwner.has(who)) byOwner.set(who, s); }
  if (byOwner.size < safeInfo.threshold) {
    throw new PublishError("USAGE", `the submitter Safe ${submitter} needs ${safeInfo.threshold} owner signatures and ${byOwner.size} owner signer(s) were given: pass --owner-signer for at least ${safeInfo.threshold} of its ${safeInfo.owners.length} owners. Nothing sent.`, { submitter, threshold: safeInfo.threshold, have: byOwner.size });
  }
  const chosen = [...byOwner.values()].slice(0, safeInfo.threshold);
  await confirmStage(ctx, "record-receipt", `record receipt ${i.receiptId} (digest ${i.payloadDigest}) from the submitter Safe ${submitter} (${safeInfo.threshold} of ${safeInfo.owners.length} owners sign; gas paid by ${await sender.address()}) directly on the receipt ${a.receipt}`);
  const data = encodeFunctionData({ abi: RECEIPT_RECORD_ABI, functionName: "recordReceipt", args: [i.receiptId, i.payloadDigest, i.payloadUri] });
  const r = await api.sendViaSafe({ safe: submitter, ownerSigners: chosen, sender, to: a.receipt, data, description: `record receipt ${i.receiptId} (digest ${i.payloadDigest}) on the receipt contract`, receiptId: i.receiptId });
  if (r.safe.toLowerCase() !== submitter.toLowerCase()) throw new PublishError("GOVERN", `the Safe that executed (${r.safe}) is not --submitter ${submitter}: the receipt is not attributed to the submitter. Check the chain before anything else.`, { executed: r.safe, submitter, tx_hash: r.txHash });
  if (r.status !== "success") throw new PublishError("GOVERN", `the submitter Safe transaction reverted in ${r.txHash}: nothing was recorded`, { tx_hash: r.txHash });
  if (!r.executionSuccess) throw new PublishError("GOVERN", `the submitter Safe emitted no ExecutionSuccess for Safe transaction ${r.safeTxHash} in ${r.txHash}: nothing is taken as recorded`, { tx_hash: r.txHash, safe_tx_hash: r.safeTxHash });
  if (!r.receiptRecorded) throw new PublishError("GOVERN", `the receipt contract emitted no ReceiptRecorded for ${i.receiptId} from ${submitter} in ${r.txHash}: nothing is taken as recorded`, { tx_hash: r.txHash, receipt_id: i.receiptId });
  const safeRec: SubmitterSafeRecord = { address: submitter, ...submitterSafeEvidence(safeInfo), safe_tx_hash: r.safeTxHash, nonce: r.nonce, signers: r.signers.map((x) => getAddress(x)).sort(), sent_by: r.sentBy };
  await readBack();
  ctx.log.log("info", "record_receipt.done", { receipt_id: i.receiptId, submitter, tx_hash: r.txHash });
  return finish(ctx, { receipt_id: i.receiptId, payload_digest: i.payloadDigest, payload_uri: i.payloadUri, submitter, tx_hash: r.txHash, status: 1, block_number: Number(r.blockNumber), submitter_safe: safeRec });
}

/** The evidence entry (`recorded_receipts` of the run manifest): the receipt id, digest, uri, submitter ADDRESS and the transaction. Never a key. */
function finish(ctx: RunContext, entry: RecordedReceipt): RecordedReceipt {
  const manifest = loadRunManifest(ctx.evidenceDir);
  if (!manifest) throw new PublishError("RESUME", `no run manifest in ${ctx.evidenceDir}: record-receipt writes its evidence entry there. Pass the same --evidence directory as the run.`);
  const list = (manifest.recorded_receipts ??= []) as RecordedReceipt[];
  const at = list.findIndex((x) => lc(x.receipt_id) === lc(entry.receipt_id));
  if (at >= 0) { if (entry.already_recorded && list[at]!.tx_hash) entry = { ...list[at]! }; list[at] = entry; } else list.push(entry);
  saveRunManifest(ctx.evidenceDir, manifest);
  return entry;
}
