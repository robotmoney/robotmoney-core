// The prove-control step (core 1618, plan decision 21), between stage 10 and stage 11. The real Safe executes one self-call (value 0, empty
// data) that EVERY owner signed, through the Safe tool: proposeTx, signTx per owner, the Safe's own checkNSignatures over all of them, then
// executeTx with every signature in the calldata, submitted by the DEPLOYER (the only funded key; owners only sign, core 1712). The proof goes
// straight through the Safe, never through the timelock.
// The run manifest keeps the transaction hash and the signers. Stage 11 refuses without that record (control-proof.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { PROOF_STAGE, controlNotProven, inspectProofTx, type ControlProofRecord } from "./control-proof.ts";
import { PublishError } from "./errors.ts";
import type { Logger } from "./log.ts";
import { confirmStage, manifestDir, readManifestField, saveRunManifest, type RunContext, type RunManifest } from "./runner.ts";
import { manifestRef, type StageRow } from "./stages.ts";
import {
  checkSignaturesOnChain, connectSafe, executeTx, localSafeTxHash, proposeTx, readUntil, rpcHost, signTx, verifySafeSignature, type SafeHandle, type SafeTxBundle, type Signer,
} from "./safe/index.ts";

/** One Safe execution event read from the chain. `safeTxHash` is the Safe transaction hash the Safe itself emitted (indexed in Safe 1.4.1). */
export interface SafeExecution { txHash: Hex; safeTxHash: Hex; success: boolean; block: number; logIndex: number }
export interface LandedTx { from: Address; to: string | null; input: Hex; value: bigint; status: "success" | "reverted"; block: number }
/**
 * QA plan v1 E7 (issue 1724): the run's settings of the adoption's chain reads. `logsRpc` (--logs-rpc) takes eth_getLogs and the one eth_chainId read that proves it
 * serves this chain (`chainId`); every other read stays on --rpc. `retry` bounds how a failed read is read again (defaults LOG_READ_TRIES, LOG_RETRY_DELAY_MS; `sleep` is
 * the test seam). `window` and `maxWindows` are test seams of the scan (defaults LOG_WINDOW, MAX_LOG_WINDOWS).
 */
export interface ProveReadOpts {
  logsRpc?: string;
  chainId?: number;
  log?: Logger;
  retry?: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };
  window?: bigint;
  maxWindows?: bigint;
}
/** The chain reads behind the adoption of a landed proof. Injected in tests, viem in production. Nothing here sends. */
export interface ProveChain {
  /**
   * The ExecutionSuccess and ExecutionFailure events the Safe itself emitted from `fromBlock` on, oldest first: those of the FIRST log window that holds any, or none
   * when no window up to the latest block does. Each execTransaction emits exactly one of the two and moves the Safe nonce by one, so a Safe at nonce 1 has exactly
   * one: the scan stops there instead of walking to the latest block (QA plan v1 E7). A read that fails is a refusal (RPC_REFUSED), never an empty answer.
   */
  executions(handle: SafeHandle, fromBlock: number, o?: ProveReadOpts): Promise<SafeExecution[]>;
  /** The transaction and its receipt. Null only when the RPC answers that it does not know the hash. A read the RPC refuses throws RPC_REFUSED. */
  transaction(handle: SafeHandle, hash: Hex, o?: ProveReadOpts): Promise<LandedTx | null>;
}

const EXECUTION_EVENTS = [
  parseAbiItem("event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)"),
  parseAbiItem("event ExecutionFailure(bytes32 indexed txHash, uint256 payment)"),
] as const;
/**
 * eth_getLogs window. Base RPC providers cap the range of one call (commonly 2000 to 10000 blocks), so the scan walks the range in windows of this size. A provider that
 * refuses the range (a range-limit error) gets half the window, again down to one block, and the scan goes on with the smaller window.
 */
export const LOG_WINDOW = 2000n;
/**
 * The scan's bound: at most this many windows, and never past this many LOG_WINDOWs (about 93 days of Base blocks) after the safe stage block. The proof is taken right
 * after stage 10, so it lies in the first windows. A scan that reaches the bound with no event is refused by name (LOG_SCAN_LIMIT), never walked further.
 */
export const MAX_LOG_WINDOWS = 2000n;
/**
 * A read that fails (HTTP 429, a rate limit, a timeout, any refusal that is not a range limit) is read again: this many reads in all, the wait doubling from
 * LOG_RETRY_DELAY_MS (1, 2, 4, 8 and 16 s, about 31 s at most per read). Then it is refused by name (RPC_REFUSED), with the RPC host, the method and the range.
 */
export const LOG_READ_TRIES = 6;
export const LOG_RETRY_DELAY_MS = 1000;

const LOGS_HINT = "Rerun the same command with --resume and --logs-rpc URL, an RPC that serves eth_getLogs over this range (only eth_getLogs and one eth_chainId read go there).";
const TX_HINT = "Rerun the same command with --resume against an --rpc that serves the whole transaction history (not a pruned node).";
const AGAIN_HINT = "Rerun the same command with --resume once the RPC answers.";

/** What a failed RPC read says, gathered from the error and its causes (viem wraps them). A URL is cut to its host: its path may carry an API key. */
export interface RpcFailure { status?: number; code?: number; text: string; rateLimited: boolean; rangeLimited: boolean; notFound: boolean }
const RATE_LIMIT = /rate.?limit|too many requests|throttl|exceeded .*(capacity|quota|compute units)/i;
const RANGE_LIMIT = /block range|blocks range|range (is )?too (large|wide|big)|range limit|max(imum)? (block )?range|exceeds? (the )?max(imum)? .*range|ranges? over \S+ blocks|limited to a \S+ (block )?range|response size (is )?exceeded|query returned more than|too many (blocks|logs|results)/i;
const hostOf = (url: string | undefined): string => { if (!url) return "(unknown host)"; try { return rpcHost(url); } catch { return "(unknown host)"; } };

export function rpcFailure(e: unknown): RpcFailure {
  const parts: string[] = [];
  let status: number | undefined, code: number | undefined, notFound = false;
  let x: unknown = e;
  for (let depth = 0; x !== null && x !== undefined && depth < 8; depth++, x = (x as { cause?: unknown }).cause) {
    if (typeof x !== "object") { parts.push(String(x)); break; }
    const o = x as { name?: unknown; status?: unknown; code?: unknown; shortMessage?: unknown; details?: unknown; message?: unknown };
    if (status === undefined && typeof o.status === "number") status = o.status;
    if (code === undefined && typeof o.code === "number") code = o.code;
    if (o.name === "TransactionNotFoundError" || o.name === "TransactionReceiptNotFoundError") notFound = true;
    // A viem error's message carries the URL and the request body: its short message and details are enough. A plain error has its message only.
    for (const t of typeof o.shortMessage === "string" ? [o.shortMessage, o.details] : [o.message]) if (typeof t === "string" && t !== "" && !parts.includes(t)) parts.push(t);
  }
  const text = parts.join("; ").replace(/https?:\/\/[^\s"'<>]+/g, (u) => hostOf(u)).slice(0, 400);
  const rateLimited = status === 429 || code === 429 || RATE_LIMIT.test(text);
  return { status, code, text, rateLimited, rangeLimited: !rateLimited && RANGE_LIMIT.test(text), notFound };
}

interface RpcRead { host: string; method: string; subject: string; hint: string; tries: number; delayMs: number; sleep: (ms: number) => Promise<void>; log?: Logger }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const readsOf = (o: ProveReadOpts) => ({ tries: Math.max(1, Math.floor(o.retry?.tries ?? LOG_READ_TRIES)), delayMs: o.retry?.delayMs ?? LOG_RETRY_DELAY_MS, sleep: o.retry?.sleep ?? realSleep, log: o.log });

function rpcRefused(r: RpcRead, reads: number, f: RpcFailure): PublishError {
  const how = [f.status !== undefined ? `HTTP ${f.status}` : "", f.code !== undefined ? `code ${f.code}` : ""].filter((s) => s !== "").join(", ");
  return new PublishError("SAFE", `RPC_REFUSED: the RPC at ${r.host} refused ${r.method} for ${r.subject} (${reads} read${reads === 1 ? "" : "s"}${how ? `, ${how}` : ""}): ${f.text || "no detail"}. The landed proof was not adopted and nothing was sent. ${r.hint}`,
    { error: "RPC_REFUSED", rpc_host: r.host, method: r.method, subject: r.subject, reads, status: f.status, code: f.code });
}

/** One read, read again after a failure with a doubling wait, `tries` reads in all, then RPC_REFUSED. `settle` ends the reads at once with its own answer (a range limit, a not-found). */
async function readRpc<T, S = never>(read: () => Promise<T>, r: RpcRead, settle?: (f: RpcFailure) => S | undefined): Promise<T | S> {
  let delay = r.delayMs;
  for (let attempt = 1; ; attempt++) {
    try { return await read(); } catch (e) {
      const f = rpcFailure(e);
      const s = settle?.(f);
      if (s !== undefined) return s;
      if (attempt >= r.tries) throw rpcRefused(r, attempt, f);
      r.log?.log("warn", "prove_control.rpc_retry", { rpc_host: r.host, method: r.method, subject: r.subject, attempt, delay_ms: delay, status: f.status, code: f.code, rate_limited: f.rateLimited, error: f.text });
      await r.sleep(delay);
      delay *= 2;
    }
  }
}

const minOf = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

export const realProveChain: ProveChain = {
  async executions(handle, fromBlock, o = {}) {
    const reads = readsOf(o);
    const host = hostOf(handle.chain?.rpcUrl);
    const latest = await readRpc(() => handle.client.getBlockNumber(), { ...reads, host, method: "eth_blockNumber", subject: "the latest block", hint: AGAIN_HINT });
    // --logs-rpc: eth_getLogs only, on an RPC that answers this chain's id. Its own client, without viem's retry: the reads below are the only bound.
    const logs = o.logsRpc ? (createPublicClient({ transport: http(o.logsRpc, { retryCount: 0 }) }) as unknown as PublicClient) : handle.client;
    const logsHost = o.logsRpc ? hostOf(o.logsRpc) : host;
    if (o.logsRpc && o.chainId !== undefined) {
      const id = await readRpc(() => logs.getChainId(), { ...reads, host: logsHost, method: "eth_chainId", subject: "the --logs-rpc chain id", hint: AGAIN_HINT });
      if (id !== o.chainId) {
        throw new PublishError("CHAIN", `LOGS_RPC_WRONG_CHAIN: --logs-rpc ${logsHost} answers chain id ${id}, not ${o.chainId}: its logs are another chain's. No log was read, nothing was adopted or sent.`, { error: "LOGS_RPC_WRONG_CHAIN", rpc_host: logsHost, got: id, want: o.chainId });
      }
    }
    const start = BigInt(fromBlock);
    if (start > latest) return [];
    const first = o.window !== undefined && o.window > 0n ? o.window : LOG_WINDOW;
    const maxWindows = o.maxWindows ?? MAX_LOG_WINDOWS;
    const bound = start + maxWindows * first - 1n; // the last block the scan may read
    let size = first;
    let windows = 0n;
    for (let from = start; from <= latest;) {
      if (windows >= maxWindows || from > bound) {
        const wider = size < first ? `, or pass --logs-rpc URL with an RPC that serves wider eth_getLogs ranges (${logsHost} took ${size} block${size === 1n ? "" : "s"} at most)` : "";
        throw new PublishError("SAFE", `LOG_SCAN_LIMIT: no execution event of Safe ${handle.address} in blocks ${start} to ${from - 1n} (${windows} eth_getLogs windows on ${logsHost} from the safe stage block; the bound is ${maxWindows} windows and ${maxWindows * first} blocks), the latest block is ${latest}. Not scanned further: the landed proof was not adopted and nothing was sent. The proof is taken right after stage 10, so it lies close to the safe stage block: check the safe stage block the run recorded${wider}.`,
          { error: "LOG_SCAN_LIMIT", from: Number(start), to: Number(from - 1n), latest: Number(latest), windows: Number(windows), window: Number(size) });
      }
      const to = minOf(from + size - 1n, latest, bound);
      const read: RpcRead = { ...reads, host: logsHost, method: "eth_getLogs", subject: `blocks ${from} to ${to} of Safe ${handle.address}`, hint: LOGS_HINT };
      const got = await readRpc(() => logs.getLogs({ address: handle.address, events: EXECUTION_EVENTS, fromBlock: from, toBlock: to }), read, (f) => (f.rangeLimited ? f : undefined));
      if (!Array.isArray(got)) {
        // A range limit: the same blocks again in half the window. One block refused is a refusal like any other.
        if (size === 1n) throw rpcRefused(read, 1, got);
        size /= 2n;
        reads.log?.log("warn", "prove_control.logs_window_shrunk", { rpc_host: logsHost, from: Number(from), window: Number(size), error: got.text });
        continue;
      }
      windows += 1n;
      const found: SafeExecution[] = [];
      for (const l of got) {
        if (l.transactionHash == null || l.blockNumber == null || l.logIndex == null || l.removed) continue;
        found.push({ txHash: l.transactionHash, safeTxHash: l.args.txHash as Hex, success: l.eventName === "ExecutionSuccess", block: Number(l.blockNumber), logIndex: l.logIndex });
      }
      if (found.length > 0) {
        reads.log?.log("info", "prove_control.logs_found", { rpc_host: logsHost, from: Number(start), to: Number(to), windows: Number(windows), events: found.length });
        return found.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
      }
      from = to + 1n;
    }
    return [];
  },
  async transaction(handle, hash, o = {}) {
    const base = { ...readsOf(o), host: hostOf(handle.chain?.rpcUrl), subject: `transaction ${hash}`, hint: TX_HINT };
    // "Not found" is an answer (the adoption refuses: cannot be read). Any other failure is read again, then RPC_REFUSED: a pruned node's refusal never reads as "not found".
    const notFound = (f: RpcFailure) => (f.notFound ? null : undefined);
    const tx = await readRpc(() => handle.client.getTransaction({ hash }), { ...base, method: "eth_getTransactionByHash" }, notFound);
    if (tx === null) return null;
    const receipt = await readRpc(() => handle.client.getTransactionReceipt({ hash }), { ...base, method: "eth_getTransactionReceipt" }, notFound);
    if (receipt === null) return null;
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
  /** Pays the gas of the execTransaction: the deployer, the only funded key (core 1712). Every owner still signs. The deployer's own signer, never an owner. */
  sender: Signer;
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
  // QA plan v1 E6 (issue 1723): nonce 0 is the one read that leads to proposing, signing and sending the proof. The Safe nonce never goes down, so a 0 from a
  // load-balanced RPC node behind a proof that landed (a run that died, then a rerun) is caught by reading again: the first read above 0 is the nonce, and 0 holds only
  // when every read of the bound says 0. A normal first proof pays the whole bound (about 4 s, once per deployment). The nonce after the proof is executeTx's awaitSafeNonce.
  const nonce = await readUntil(() => handle.nonce(), (n) => n !== 0, ctx.readRetry);
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

  const res = await api.executeTx(handle, bundle, o.sender, { allSignatures: true });
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
 *  - the Safe nonce is exactly 1 and exactly one execution event is found (the nonce-0 execution; the scan stops at the first log window that holds one,
 *    QA plan v1 E7, because each execTransaction emits one event and moves the nonce by one: nonce 1 is one execution in all);
 *  - the event is ExecutionSuccess (a landed-but-failed Safe transaction is refused) and the transaction receipt succeeded;
 *  - the event's Safe transaction hash is the hash of the self-call at nonce 0 on THIS chain and Safe (not a module, delegatecall, other target or data);
 *  - the transaction goes to the Safe itself with value 0 and its execTransaction calldata is the plain self-call (inspectProofTx), and the
 *    packed signatures recover over that hash to exactly the current owner set: every owner, no stranger, no repeat.
 * The chain reads (QA plan v1 E7, issue 1724) ride out a rate-limited public RPC with a bounded backoff, read eth_getLogs from --logs-rpc when it is given, and
 * refuse by name when the RPC refuses (RPC_REFUSED, exit 19) or the scan reaches its bound (LOG_SCAN_LIMIT): a refused read is never an empty answer.
 */
async function adoptLandedProof(ctx: RunContext, row: StageRow, manifest: RunManifest, api: ProveApi, handle: SafeHandle, safe: Address, nonce: number, startedAt: string): Promise<ControlProofRecord> {
  const refuse = (why: string, details: Record<string, unknown> = {}): never => { throw controlNotProven(`the landed proof was not adopted: ${why}`, { safe, nonce, ...details }); };
  if (nonce !== 1) refuse(`the Safe nonce is ${nonce}: only a Safe at nonce 1 holds exactly the one proof, and a proof is taken on a new Safe only`);
  const from = safeStageBlock(ctx, manifest);
  const reads: ProveReadOpts = { logsRpc: ctx.logsRpc, chainId: ctx.chainId, log: ctx.log, retry: { sleep: ctx.readRetry?.sleep } };
  const found = await api.chain.executions(handle, from, reads);
  if (found.length === 0) refuse(`the Safe nonce is 1 but no execution event of ${safe} exists from block ${from}`, { from });
  if (found.length !== 1) refuse(`${found.length} execution events of ${safe} exist from block ${from}, expected exactly one`, { from, count: found.length });
  const ev = found[0]!;
  if (!ev.success) refuse(`the nonce-0 execution ${ev.txHash} emitted ExecutionFailure: the Safe transaction failed`, { txHash: ev.txHash });
  const want = localSafeTxHash(ctx.chainId, safe, safe, "0x", 0);
  if (ev.safeTxHash.toLowerCase() !== want.toLowerCase()) {
    refuse(`the nonce-0 execution ${ev.txHash} is Safe transaction ${ev.safeTxHash}, not the self-call ${want} (value 0, empty data, call to the Safe itself)`, { txHash: ev.txHash, got: ev.safeTxHash, want });
  }
  const tx = await api.chain.transaction(handle, ev.txHash, reads);
  if (!tx) refuse(`transaction ${ev.txHash} cannot be read from the chain: the RPC at ${hostOf(ctx.rpc)} answers that it does not know it (a node with a pruned transaction index answers so too)`, { txHash: ev.txHash });
  if (tx!.status !== "success") refuse(`transaction ${ev.txHash} did not succeed`, { txHash: ev.txHash });
  const seen = await inspectProofTx({ chainId: ctx.chainId, safe, owners: handle.owners, nonce: 0, tx: { to: tx!.to, input: tx!.input, value: tx!.value } });
  if (!seen.ok) refuse(`${ev.txHash}: ${seen.detail}`, { txHash: ev.txHash });
  const rec: ControlProofRecord = {
    status: "done", safe, txHash: ev.txHash, safeTxHash: want, nonce: 0, signers: handle.owners.map(lc).sort() as Address[], block: tx!.block, sentBy: tx!.from, adopted: true,
  };
  manifest.stages[row.name] = { ...rec, startedAt, finishedAt: new Date().toISOString() };
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.control_proof_adopted", { stage: row.name, tx_hash: ev.txHash, safe_tx_hash: want, signers: rec.signers.length, block: tx!.block, detail: seen.detail, ...(ctx.logsRpc ? { logs_rpc_host: hostOf(ctx.logsRpc) } : {}) });
  return rec;
}
