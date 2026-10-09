// The prove-control step (core 1618, plan decision 21), between stage 10 and stage 11. The real Safe executes one self-call (value 0, empty
// data) that EVERY owner signed, through the Safe tool: proposeTx, signTx per owner, the Safe's own checkNSignatures over all of them, then
// executeTx with every signature in the calldata. The proof goes straight through the Safe, never through the timelock.
// The run manifest keeps the transaction hash and the signers. Stage 11 refuses without that record (control-proof.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbiItem, type Address, type Hex } from "viem";
import { PROOF_STAGE, controlNotProven, inspectProofTx, type ControlProofRecord } from "./control-proof.ts";
import { PublishError } from "./errors.ts";
import { confirmStage, manifestDir, readManifestField, saveRunManifest, type RunContext, type RunManifest } from "./runner.ts";
import { manifestRef, type StageRow } from "./stages.ts";
import {
  checkSignaturesOnChain, connectSafe, executeTx, localSafeTxHash, proposeTx, signTx, verifySafeSignature, type SafeHandle, type SafeTxBundle, type Signer,
} from "./safe/index.ts";

/** One Safe execution event read from the chain. `safeTxHash` is the Safe transaction hash the Safe itself emitted (indexed in Safe 1.4.1). */
export interface SafeExecution { txHash: Hex; safeTxHash: Hex; success: boolean; block: number; logIndex: number }
export interface LandedTx { from: Address; to: string | null; input: Hex; value: bigint; status: "success" | "reverted"; block: number }
/** The chain reads behind the adoption of a landed proof. Injected in tests, viem in production. Nothing here sends. */
export interface ProveChain {
  /** Every ExecutionSuccess and ExecutionFailure the Safe itself emitted from `fromBlock` to the latest block, oldest first. */
  executions(handle: SafeHandle, fromBlock: number): Promise<SafeExecution[]>;
  transaction(handle: SafeHandle, hash: Hex): Promise<LandedTx | null>;
}

const EXECUTION_EVENTS = [
  parseAbiItem("event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)"),
  parseAbiItem("event ExecutionFailure(bytes32 indexed txHash, uint256 payment)"),
] as const;
/** eth_getLogs window. Base RPC providers cap the range of one call (commonly 2000 to 10000 blocks), so the scan walks the range in windows of this size. */
export const LOG_WINDOW = 2000n;
/** About 93 days of Base blocks. A proof older than this is not a crashed run: refuse instead of scanning forever. */
export const MAX_LOG_WINDOWS = 2000n;

export const realProveChain: ProveChain = {
  async executions(handle, fromBlock) {
    const latest = await handle.client.getBlockNumber();
    if (BigInt(fromBlock) > latest) return [];
    if ((latest - BigInt(fromBlock)) / LOG_WINDOW > MAX_LOG_WINDOWS) throw new PublishError("SAFE", `the Safe stage block ${fromBlock} is more than ${MAX_LOG_WINDOWS * LOG_WINDOW} blocks behind ${latest}: not scanned`);
    const out: SafeExecution[] = [];
    for (let from = BigInt(fromBlock); from <= latest; from += LOG_WINDOW) {
      const to = from + LOG_WINDOW - 1n < latest ? from + LOG_WINDOW - 1n : latest;
      let logs;
      try { logs = await handle.client.getLogs({ address: handle.address, events: EXECUTION_EVENTS, fromBlock: from, toBlock: to }); }
      catch (e) { throw new PublishError("SAFE", `reading the Safe's execution events for blocks ${from} to ${to} failed (${(e as Error).message}): the proof was not adopted`); }
      for (const l of logs) {
        if (l.transactionHash == null || l.blockNumber == null || l.logIndex == null || l.removed) continue;
        out.push({ txHash: l.transactionHash, safeTxHash: l.args.txHash as Hex, success: l.eventName === "ExecutionSuccess", block: Number(l.blockNumber), logIndex: l.logIndex });
      }
    }
    return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  },
  async transaction(handle, hash) {
    let tx, receipt;
    try { [tx, receipt] = await Promise.all([handle.client.getTransaction({ hash }), handle.client.getTransactionReceipt({ hash })]); } catch { return null; }
    return { from: tx.from, to: tx.to ?? null, input: tx.input, value: tx.value, status: receipt.status, block: Number(receipt.blockNumber) };
  },
};

export interface ProveApi {
  connectSafe: typeof connectSafe;
  proposeTx: typeof proposeTx;
  signTx: typeof signTx;
  checkSignaturesOnChain: typeof checkSignaturesOnChain;
  executeTx: typeof executeTx;
  /** Reads only. Used by --resume to find a proof that landed before the run died. */
  chain: ProveChain;
}
export const realProveApi: ProveApi = { connectSafe, proposeTx, signTx, checkSignaturesOnChain, executeTx, chain: realProveChain };

export interface ProveOpts {
  /** One signer per Safe owner (the same specs govern takes). Every owner must be covered. */
  ownerSigners: Signer[];
  /** Pays the gas of the execTransaction. Default: the first owner signer. It is never the deployer: the deployer nonce is the frozen-count record. */
  sender?: Signer;
  api?: ProveApi;
}

const lc = (a: string): string => a.toLowerCase();

/** Every owner has one valid signature over the bundle's hash, checked here by recovery (not trusted from the signer). Throws before anything is sent. */
export async function assertEveryOwnerSigned(owners: readonly string[], bundle: SafeTxBundle): Promise<void> {
  for (const o of owners) {
    const s = bundle.signatures.find((x) => lc(x.owner) === lc(o));
    if (!s) throw controlNotProven(`owner ${o} has no signature on the proof transaction`, { owner: o });
    if (!(await verifySafeSignature(bundle.safe_tx_hash, o, s.signature))) throw controlNotProven(`the signature of owner ${o} does not recover to ${o} for this Safe transaction hash`, { owner: o });
  }
  const strangers = bundle.signatures.filter((s) => !owners.some((o) => lc(o) === lc(s.owner)));
  if (strangers.length > 0) throw controlNotProven(`the proof transaction carries signatures from non-owners: ${strangers.map((s) => s.owner).join(", ")}`);
}

export async function runProveControl(ctx: RunContext, row: StageRow, manifest: RunManifest, o: ProveOpts): Promise<ControlProofRecord> {
  const api = o.api ?? realProveApi;
  const safe = readManifestField(ctx, manifestRef("safe", "safe")) as Address;
  const startedAt = new Date().toISOString();
  const handle: SafeHandle = await api.connectSafe({ rpcUrl: ctx.rpc, chainId: ctx.chainId, safeAddress: safe, logger: ctx.log });
  if (handle.owners.map(lc).sort().join() !== ctx.sheet.safeOwners.map(lc).sort().join()) {
    throw controlNotProven("the Safe's owners on chain differ from the sheet", { safe });
  }
  const nonce = await handle.nonce();
  if (nonce !== 0) {
    if (!ctx.resume) {
      throw controlNotProven(`the Safe nonce is ${nonce}, not 0: the Safe moved outside this run, and a proof is taken on a new Safe only. If this run died after its own proof landed, rerun the same command with --resume to adopt it from the chain`, { nonce });
    }
    return adoptLandedProof(ctx, row, manifest, api, handle, safe, nonce, startedAt);
  }
  // A signer for every owner, named before anything is proposed, signed or sent.
  const byOwner = new Map<string, Signer>();
  for (const s of o.ownerSigners) {
    const a = lc(await s.address());
    if (byOwner.has(a)) throw controlNotProven(`two owner signers resolve to the same address ${a}: each Safe owner needs its own device`, { address: a });
    byOwner.set(a, s);
  }
  const missing = handle.owners.filter((x) => !byOwner.has(lc(x)));
  if (missing.length > 0) {
    throw controlNotProven(`no owner signer for ${missing.join(", ")}: the proof needs a signature from every one of the ${handle.owners.length} owners (pass --owner-signer for each)`, { missing });
  }
  ctx.log.log("info", "stage.start", { stage: row.name, safe, owners: handle.owners.length, threshold: handle.threshold });
  await confirmStage(ctx, row.name, `${row.name}: one self-call of Safe ${safe} signed by all ${handle.owners.length} owners`);

  let bundle = await api.proposeTx(handle, { to: safe, data: "0x", action: PROOF_STAGE, description: `Control proof: the Safe calls itself with value 0 and empty data, signed by every owner (${ctx.coreSha})` });
  for (const owner of handle.owners) bundle = await api.signTx(handle, bundle, byOwner.get(lc(owner))!);
  // Each signature is checked here by recovery, then the Safe itself checks all of them (checkNSignatures over every owner, a view): nothing is sent before both pass.
  await assertEveryOwnerSigned(handle.owners, bundle);
  try { await api.checkSignaturesOnChain(handle, bundle, bundle.signatures, handle.owners.length); }
  catch (e) { throw controlNotProven(`the Safe rejected the owner signatures before execution: ${(e as Error).message}`); }

  const sender = o.sender ?? byOwner.get(lc(handle.owners[0]!))!;
  const res = await api.executeTx(handle, bundle, sender, { allSignatures: true });
  if (!res.txHash || res.block === undefined) throw new PublishError("SAFE", "the control proof was not sent");
  const rec: ControlProofRecord = {
    status: "done", safe, txHash: res.txHash, safeTxHash: bundle.safe_tx_hash, nonce, signers: handle.owners.map(lc).sort() as Address[], block: res.block, sentBy: res.sentBy,
  };
  manifest.stages[row.name] = { ...rec, startedAt, finishedAt: new Date().toISOString() };
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.done", { stage: row.name, tx_hash: res.txHash, safe_tx_hash: bundle.safe_tx_hash, signers: rec.signers.length, nonce_after: res.nonceAfter });
  return rec;
}

/** The block to scan from: the Safe's creation block, which no Safe execution can precede. Absent: refused (never a guess of block 0). */
function safeStageBlock(ctx: RunContext, manifest: RunManifest): number {
  const fromRecord = manifest.stages.safe?.firstBlock;
  let fromFile: unknown;
  const p = join(manifestDir(ctx), "safe.json");
  if (existsSync(p)) { try { fromFile = JSON.parse(readFileSync(p, "utf8")).block; } catch { /* reported below */ } }
  for (const b of [fromRecord, fromFile, manifest.firstBlock]) if (typeof b === "number" && Number.isInteger(b) && b >= 0) return b;
  throw controlNotProven("the run records no safe stage block, so the chain cannot be scanned for a landed proof");
}

/**
 * --resume after a crash between the Safe execution and the manifest write (issue 1670). Sends NOTHING: no proposeTx, signTx or executeTx.
 * The proof is found on chain, from the Safe's own ExecutionSuccess and ExecutionFailure events (address = this Safe, so another Safe's
 * transaction cannot be replayed here), from the safe stage block. It is adopted only when ALL of these hold, else CONTROL_NOT_PROVEN:
 *  - the Safe nonce is exactly 1 and exactly one execution event exists (the nonce-0 execution, nothing after it);
 *  - the event is ExecutionSuccess (a landed-but-failed Safe transaction is refused) and the transaction receipt succeeded;
 *  - the event's Safe transaction hash is the hash of the self-call at nonce 0 on THIS chain and Safe (not a module, delegatecall, other target or data);
 *  - the transaction goes to the Safe itself with value 0 and its execTransaction calldata is the plain self-call (inspectProofTx), and the
 *    packed signatures recover over that hash to exactly the current owner set: every owner, no stranger, no repeat.
 */
async function adoptLandedProof(ctx: RunContext, row: StageRow, manifest: RunManifest, api: ProveApi, handle: SafeHandle, safe: Address, nonce: number, startedAt: string): Promise<ControlProofRecord> {
  const refuse = (why: string, details: Record<string, unknown> = {}): never => { throw controlNotProven(`the landed proof was not adopted: ${why}`, { safe, nonce, ...details }); };
  if (nonce !== 1) refuse(`the Safe nonce is ${nonce}: only a Safe at nonce 1 holds exactly the one proof, and a proof is taken on a new Safe only`);
  const from = safeStageBlock(ctx, manifest);
  const found = await api.chain.executions(handle, from);
  if (found.length === 0) refuse(`the Safe nonce is 1 but no execution event of ${safe} exists from block ${from}`, { from });
  if (found.length !== 1) refuse(`${found.length} execution events of ${safe} exist from block ${from}, expected exactly one`, { from, count: found.length });
  const ev = found[0]!;
  if (!ev.success) refuse(`the nonce-0 execution ${ev.txHash} emitted ExecutionFailure: the Safe transaction failed`, { txHash: ev.txHash });
  const want = localSafeTxHash(ctx.chainId, safe, safe, "0x", 0);
  if (ev.safeTxHash.toLowerCase() !== want.toLowerCase()) {
    refuse(`the nonce-0 execution ${ev.txHash} is Safe transaction ${ev.safeTxHash}, not the self-call ${want} (value 0, empty data, call to the Safe itself)`, { txHash: ev.txHash, got: ev.safeTxHash, want });
  }
  const tx = await api.chain.transaction(handle, ev.txHash);
  if (!tx) refuse(`transaction ${ev.txHash} cannot be read from the chain`, { txHash: ev.txHash });
  if (tx!.status !== "success") refuse(`transaction ${ev.txHash} did not succeed`, { txHash: ev.txHash });
  const seen = await inspectProofTx({ chainId: ctx.chainId, safe, owners: handle.owners, nonce: 0, tx: { to: tx!.to, input: tx!.input, value: tx!.value } });
  if (!seen.ok) refuse(`${ev.txHash}: ${seen.detail}`, { txHash: ev.txHash });
  const rec: ControlProofRecord = {
    status: "done", safe, txHash: ev.txHash, safeTxHash: want, nonce: 0, signers: handle.owners.map(lc).sort() as Address[], block: tx!.block, sentBy: tx!.from, adopted: true,
  };
  manifest.stages[row.name] = { ...rec, startedAt, finishedAt: new Date().toISOString() };
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.control_proof_adopted", { stage: row.name, tx_hash: ev.txHash, safe_tx_hash: want, signers: rec.signers.length, block: tx!.block, detail: seen.detail });
  return rec;
}
