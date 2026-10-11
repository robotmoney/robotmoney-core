// The `record-receipt` verb (issue 1727): the registered committee submitter anchors ONE consensus receipt on chain through the gateway,
// RobotMoneyGateway.consensusRecordReceipt(receiptId, payloadDigest, payloadUri). Docs: docs/technical/consensus-receipt-submitter-runbook.md.
//
// WHY THIS VERB EXISTS. `rmpc receipt submit` is the production path, but it refuses a software signer on a production-grade chain (ErrProductionSignerRequired: only an HSM
// or KMS backend counts, and none is implemented). A Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) therefore records through this verb, with the operator's own
// signer spec (a hardware wallet, or an encrypted keystore whose passphrase is typed at the hidden prompt). It is refused on 8453 in production kind: production records through rmpc with an HSM/KMS.
//
// THE SUBMITTER IS A MULTISIG (issue 1750, owner decision 2026-10-10: no single key). --submitter is a SECOND Safe (a SafeL2 1.4.1 proxy, separate from the governing Safe)
// registered by `govern --row register-committee --submitter <Safe>`. The verb proposes consensusRecordReceipt to the gateway through that Safe, collects the signatures of
// `threshold` of its owners (--owner-signer), and executes with --signer, the DEPLOYER, as the gas payer. On 8453 there is no other mode. The Twin chain still accepts the old
// single-key mode (no --submitter; --signer is then the submitter). The same three owner keys control BOTH Safes: the proposer/approver separation is the multisig plus the Safe nonces, not different keys.
// No key, passphrase or keystore path is ever written to the repo, the evidence or the run manifest (only addresses, the Safe tx hash and the nonce are). The submitter holds AGENT_ROLE on
// the gateway and COMMITTEE_AGENT_ROLE on the IC policy and nothing else. Recording is signalling only (INV-4): it moves no value and sets no weight. (AGENT_ROLE also allows allocation-signalling votes and tiny deposits: Withdrawals are disabled (the policy's withdraw caps are 0, so withdraw reverts WithdrawalNotEnabled); deposits are capped at 1 raw unit of USDC per payment and per window, paid from the submitter's own funds, with the shares going to the timelock.)
//
// BEFORE ANYTHING IS SENT it checks, on chain: the receipt contract is the one the gateway routes to, the submitter holds both roles, the receipt id is not recorded yet (or is
// recorded with exactly this digest, uri and submitter, which is reported and not sent again). AFTER it reads the receipt back and compares id, digest, uri and submitter.
// The digest and id come from `rmpc receipt verify` (read-only, no signer, it checks every analyst signature off chain): pass its payload_digest and receipt_id.
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseAbiItem, parseEventLogs, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { assertDigestMatchesBytes, receiptIdOfBytes } from "./receipt-digest.ts";
import { isMainnet } from "./chains.ts";
import { loadRunManifest, readManifestField, saveRunManifest, confirmStage, type RunContext } from "./runner.ts";
import { manifestRef } from "./stages.ts";
import { checkSignaturesOnChain, connectSafe, executeTx, proposeTx, signTx, type Logger, type Signer } from "./safe/index.ts";
import { assertSubmitterSafe, chainFromClient, forbiddenSubmitters, submitterSafeEvidence, type SubmitterChain, type SubmitterSafeEvidence } from "./submitter-safe.ts";

export const GATEWAY_RECORD_ABI = parseAbi([
  "function consensusRecordReceipt(bytes32 receiptId, bytes32 payloadDigest, string payloadUri) returns (uint256 index)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function consensusReceipt() view returns (address)",
  "function icPolicy() view returns (address)",
]);
export const IC_ROLE_ABI = parseAbi(["function hasRole(bytes32 role, address account) view returns (bool)"]);
export const RECEIPT_READ_ABI = parseAbi([
  "function isRecorded(bytes32 receiptId) view returns (bool)",
  "function getReceiptById(bytes32 receiptId) view returns ((bytes32 receiptId, bytes32 payloadDigest, string payloadUri, address submitter, uint64 recordedAt, uint64 releasedAt, bool released))",
]);
export const AGENT_ROLE = keccak256(toBytes("AGENT_ROLE"));
export const COMMITTEE_AGENT_ROLE = keccak256(toBytes("COMMITTEE_AGENT_ROLE"));

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
}
export interface SafeSendRequest { safe: Address; ownerSigners: Signer[]; sender: Signer; to: Address; data: Hex; description: string }

/** The chain reads and the one send of the verb. Tests inject a fake; the real one is viem over the run's RPC and the Safe tool signer. */
export interface RecordApi {
  read<T>(address: Address, abi: readonly unknown[], fn: string, args?: unknown[]): Promise<T>;
  send(signer: Signer, to: Address, data: Hex): Promise<{ txHash: Hex; status: "success" | "reverted"; blockNumber: bigint }>;
  /** Issue 1750: code, storage and reads of the submitter, for the canonical-Safe check. Needed whenever the submitter has code or the chain is 8453. */
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
    send: async (signer, to, data) => {
      const txHash = await signer.send({ to, data }, { rpcUrl: rpc, chainId });
      const rc = await client.waitForTransactionReceipt({ hash: txHash });
      return { txHash, status: rc.status, blockNumber: rc.blockNumber };
    },
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
      return { txHash: res.txHash, status: rc.status, blockNumber: rc.blockNumber, safe: handle.address, safeTxHash: bundle.safe_tx_hash, nonce: bundle.nonce, signers: bundle.signatures.map((x) => x.owner), sentBy: res.sentBy, executionSuccess };
    },
  };
}

const B32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (x: string) => x.toLowerCase();

/** With `payload` (the receipt file's bytes) the digest and the id are checked against the bytes with the shared scheme (receipt-digest.ts) and a mismatch is refused naming both. */
export function assertRecordInputs(i: { receiptId?: string; payloadDigest?: string; payloadUri?: string; payload?: Uint8Array }): RecordInputs {
  if (!i.receiptId || !B32.test(i.receiptId)) throw new PublishError("USAGE", "--receipt-id must be a 0x-prefixed bytes32 (the receipt_id that `rmpc receipt verify` prints)");
  if (!i.payloadDigest || !B32.test(i.payloadDigest)) throw new PublishError("USAGE", "--payload-digest must be a 0x-prefixed bytes32 (the payload_digest that `rmpc receipt verify` prints)");
  if (!i.payloadUri || !/^https?:\/\/\S+$/.test(i.payloadUri)) throw new PublishError("USAGE", "--payload-uri must be the public http(s) route that serves the exact payload bytes");
  if (i.payload !== undefined) {
    assertDigestMatchesBytes(i.payload, i.payloadDigest, "--payload-digest");
    const idOfBytes = receiptIdOfBytes(i.payload);
    if (idOfBytes !== undefined && idOfBytes.toLowerCase() !== i.receiptId.toLowerCase()) throw new PublishError("USAGE", `--receipt-id ${i.receiptId} is not the receipt id ${idOfBytes} derived from the payload's session_id and subject_id`, { receipt_id: i.receiptId, derived: idOfBytes });
  }
  return { receiptId: i.receiptId.toLowerCase() as Hex, payloadDigest: i.payloadDigest.toLowerCase() as Hex, payloadUri: i.payloadUri };
}

/** The addresses the verb talks to, from the stage manifests of the run. */
export const loadRecordAddrs = (ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): { gateway: Address; icPolicy: Address; receipt: Address; safe: Address; timelock: Address } => ({
  safe: readManifestField(ctx, manifestRef("safe", "safe")) as Address,
  timelock: readManifestField(ctx, manifestRef("timelock", "timelock")) as Address,
  gateway: readManifestField(ctx, manifestRef("gateway", "gateway")) as Address,
  icPolicy: readManifestField(ctx, manifestRef("ic-policy", "policy")) as Address,
  receipt: readManifestField(ctx, manifestRef("ic-policy", "consensus_receipt")) as Address,
});

/** Issue 1750: Safe mode. `safe` is the submitter (--submitter); `ownerSigners` are the submitter Safe's owner signers (--owner-signer). The `signer` argument of recordReceipt is then the GAS PAYER (the deployer), not the submitter. */
export interface SafeSubmitterOpts { safe: Address; ownerSigners: Signer[] }

export async function recordReceipt(ctx: RunContext, signer: Signer, i: RecordInputs, api: RecordApi = realRecordApi(ctx.rpc, ctx.chainId, ctx.log), safeMode?: SafeSubmitterOpts): Promise<RecordedReceipt> {
  if (ctx.sheet.kind !== "rehearsal" && isMainnet(ctx.chainId)) {
    throw new PublishError("USAGE", "record-receipt is refused on this chain in production: production records receipts with `rmpc receipt submit` and an HSM or KMS signer. It runs on a Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) and on the Twin chain.");
  }
  const a = loadRecordAddrs(ctx);
  // Owner decision 2026-10-10 (issue 1750): the submitter is a multisig. On Base mainnet there is no single-key mode.
  if (!safeMode && isMainnet(ctx.chainId)) {
    throw new PublishError("USAGE", "record-receipt on 8453 needs --submitter <the submitter Safe> and the --owner-signer of its owners: the consensus receipt submitter is a multisig (a SafeL2 1.4.1 proxy), never a single key. --signer is then the deployer that pays the gas. Nothing sent.");
  }
  const forbidden = forbiddenSubmitters({ governingSafe: a.safe, timelock: a.timelock, admin: ctx.sheet.admin, pauser: ctx.sheet.pauser, emergency: ctx.sheet.emergency });
  let submitter: Address;
  let safeInfo: Awaited<ReturnType<typeof assertSubmitterSafe>> | undefined;
  let chosen: Signer[] = [];
  if (safeMode) {
    submitter = getAddress(safeMode.safe);
    if (!api.chain || !api.sendViaSafe) throw new PublishError("USAGE", "this record API cannot read or execute a Safe: nothing sent");
    safeInfo = await assertSubmitterSafe(api.chain, submitter, forbidden); // the forbidden list, then the canonical-Safe facts, before any signer is touched
    // Enough owner signers to reach the threshold, named before anything is proposed or signed. Signers that are not owners of the submitter Safe are ignored.
    const byOwner = new Map<string, Signer>();
    for (const s of safeMode.ownerSigners) { const who = (await s.address()).toLowerCase(); if (safeInfo.owners.some((o) => o.toLowerCase() === who) && !byOwner.has(who)) byOwner.set(who, s); }
    if (byOwner.size < safeInfo.threshold) {
      throw new PublishError("USAGE", `the submitter Safe ${submitter} needs ${safeInfo.threshold} owner signatures and ${byOwner.size} owner signer(s) were given: pass --owner-signer for at least ${safeInfo.threshold} of its ${safeInfo.owners.length} owners. Nothing sent.`, { submitter, threshold: safeInfo.threshold, have: byOwner.size });
    }
    chosen = [...byOwner.values()].slice(0, safeInfo.threshold);
  } else {
    submitter = await signer.address();
    // The submitter holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else: a Safe owner or a role key is refused here, not only by the on-chain role checks.
    const reserved = new Map<string, string>([...ctx.sheet.safeOwners.map((o, i) => [o.toLowerCase(), `Safe owner ${i + 1}`] as const), [ctx.sheet.pauser.toLowerCase(), "PAUSER_ADDRESS"], [ctx.sheet.emergency.toLowerCase(), "EMERGENCY_ADDRESS"]]);
    const why = reserved.get(submitter.toLowerCase());
    if (why) throw new PublishError("USAGE", `the signer ${submitter} is ${why}: the submitter holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else. Use a dedicated key. Nothing sent.`, { submitter });
    // A single-key submitter that is a role key is refused (admin and deployer included); a contract is never taken for a key.
    if (forbidden.has(submitter.toLowerCase())) throw new PublishError("USAGE", `the signer ${submitter} is ${forbidden.get(submitter.toLowerCase())}: the submitter holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else. Use a dedicated key. Nothing sent.`, { submitter });
  }
  const routed = await api.read<Address>(a.gateway, GATEWAY_RECORD_ABI, "consensusReceipt");
  if (lc(routed) !== lc(a.receipt)) throw new PublishError("GOVERN", `the gateway routes receipts to ${routed}, the run's receipt contract is ${a.receipt}: nothing sent`, { routed, receipt: a.receipt });
  if (!(await api.read<boolean>(a.gateway, GATEWAY_RECORD_ABI, "hasRole", [AGENT_ROLE, submitter]))) throw new PublishError("GOVERN", `the submitter ${submitter} does not hold AGENT_ROLE on the gateway: run govern --row register-committee --submitter ${submitter} first. Nothing sent.`, { submitter });
  if (!(await api.read<boolean>(a.icPolicy, IC_ROLE_ABI, "hasRole", [COMMITTEE_AGENT_ROLE, submitter]))) throw new PublishError("GOVERN", `the submitter ${submitter} does not hold COMMITTEE_AGENT_ROLE on the IC policy: run govern --row register-committee --submitter ${submitter} first. Nothing sent.`, { submitter });
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
    if (safeInfo && !prior?.tx_hash && api.findRecordTx) {
      try { found = await api.findRecordTx(a.receipt, i.receiptId, submitter); } catch (e) { ctx.log.log("warn", "record_receipt.find_tx_failed", { receipt_id: i.receiptId, error: (e as Error).message }); }
    }
    return finish(ctx, {
      receipt_id: i.receiptId, payload_digest: i.payloadDigest, payload_uri: i.payloadUri, submitter, status: 1, already_recorded: true,
      ...(found ? { tx_hash: found.txHash, block_number: Number(found.blockNumber) } : {}),
      ...(safeInfo ? { submitter_safe: { address: submitter, ...submitterSafeEvidence(safeInfo), ...(found?.safeTxHash ? { safe_tx_hash: found.safeTxHash } : {}) } } : {}),
    });
  }
  await confirmStage(ctx, "record-receipt", `record receipt ${i.receiptId} (digest ${i.payloadDigest}) from ${safeMode ? `the submitter Safe ${submitter} (${safeInfo!.threshold} of ${safeInfo!.owners.length} owners sign; gas paid by ${await signer.address()})` : submitter} through the gateway ${a.gateway}`);
  const data = encodeFunctionData({ abi: GATEWAY_RECORD_ABI, functionName: "consensusRecordReceipt", args: [i.receiptId, i.payloadDigest, i.payloadUri] });
  let sent: { txHash: Hex; status: "success" | "reverted"; blockNumber: bigint };
  let safeRec: SubmitterSafeRecord | undefined;
  if (safeMode && safeInfo) {
    const r = await api.sendViaSafe!({ safe: submitter, ownerSigners: chosen, sender: signer, to: a.gateway, data, description: `record receipt ${i.receiptId} (digest ${i.payloadDigest}) through the gateway` });
    if (r.safe.toLowerCase() !== submitter.toLowerCase()) throw new PublishError("GOVERN", `the Safe that executed (${r.safe}) is not --submitter ${submitter}: the receipt is not attributed to the submitter. Check the chain before anything else.`, { executed: r.safe, submitter, tx_hash: r.txHash });
    if (r.status !== "success") throw new PublishError("GOVERN", `the submitter Safe transaction reverted in ${r.txHash}: nothing was recorded`, { tx_hash: r.txHash });
    if (!r.executionSuccess) throw new PublishError("GOVERN", `the submitter Safe emitted no ExecutionSuccess for Safe transaction ${r.safeTxHash} in ${r.txHash}: nothing is taken as recorded`, { tx_hash: r.txHash, safe_tx_hash: r.safeTxHash });
    sent = r;
    safeRec = { address: submitter, ...submitterSafeEvidence(safeInfo), safe_tx_hash: r.safeTxHash, nonce: r.nonce, signers: r.signers.map((x) => getAddress(x)).sort(), sent_by: r.sentBy };
  } else {
    sent = await api.send(signer, a.gateway, data);
  }
  if (sent.status !== "success") throw new PublishError("GOVERN", `consensusRecordReceipt reverted in ${sent.txHash}: nothing was recorded`, { tx_hash: sent.txHash });
  await readBack();
  ctx.log.log("info", "record_receipt.done", { receipt_id: i.receiptId, submitter, tx_hash: sent.txHash });
  return finish(ctx, { receipt_id: i.receiptId, payload_digest: i.payloadDigest, payload_uri: i.payloadUri, submitter, tx_hash: sent.txHash, status: 1, block_number: Number(sent.blockNumber), ...(safeRec ? { submitter_safe: safeRec } : {}) });
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
