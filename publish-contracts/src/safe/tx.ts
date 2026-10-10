// Safe transaction lifecycle: propose (build + hash), sign per owner, import foreign signatures, execute.
// The hash comes from the protocol-kit (and is cross-checked against an independent EIP-712 computation), signatures are packed by the
// kit sorted by owner address, and every step is re-checked against the chain, so a stale or tampered bundle is refused before signing.
import { EthSafeSignature } from "@safe-global/protocol-kit";
import { OperationType } from "@safe-global/types-kit";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { decodeFunctionData, getAddress, hashTypedData, isHex, type Address, type Hex } from "viem";
import { delayFloor, isMainnet } from "../floors.ts";
import { lc, sameAddress } from "./chain.ts";
import { SAFE_ABI, SAFE_VERSION, TIMELOCK_ABI, ZERO_ADDRESS } from "./constants.ts";
import { SafeRevertError, SafeToolError, revertReasonOf } from "./errors.ts";
import type { SafeHandle } from "./safe.ts";
import { recoverSafeSigner, splitSignature, verifySafeSignature, type SignMode } from "./sig.ts";
import type { Signer } from "./signers.ts";

export const BUNDLE_FORMAT = "robotmoney-safe-tx/1" as const;

export interface BundleSignature { owner: Address; signature: Hex }

/** Public by design: addresses, calldata, the hash and signatures. Never a key, keystore or passphrase. */
export interface SafeTxBundle {
  format: typeof BUNDLE_FORMAT;
  chain_id: number;
  safe: Address;
  safe_version: string;
  timelock?: Address;
  action: string;
  description: string;
  to: Address;
  value: "0";
  data: Hex;
  operation: 0;
  safe_tx_gas: "0"; base_gas: "0"; gas_price: "0";
  gas_token: Address; refund_receiver: Address;
  nonce: number;
  safe_tx_hash: Hex;
  timelock_operation_id?: Hex;
  timelock_min_delay?: string;
  threshold: number;
  owners: Address[];
  signatures: BundleSignature[];
  proposed_at: string;
  executed?: { tx_hash: Hex; block: number; sent_by: Address; /** Receipt status: 1 success, 0 reverted (a revert throws, so a returned bundle holds 1). */ status?: 0 | 1 };
}

export const TIMELOCK_ALLOWED_FUNCTIONS = ["schedule", "scheduleBatch", "execute", "executeBatch", "cancel"] as const;

// ---- hashing --------------------------------------------------------------------------------------------------------------------------------

/** Independent EIP-712 Safe 1.4.1 transaction hash, used to cross-check the kit and the chain. */
export function localSafeTxHash(chainId: number, safe: Address, to: Address, data: Hex, nonce: number): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: { SafeTx: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" },
    ] },
    primaryType: "SafeTx",
    message: { to, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS, nonce: BigInt(nonce) },
  });
}

async function buildSdkTx(handle: SafeHandle, to: Address, data: Hex, nonce: number) {
  const tx = await handle.sdk.createTransaction({ transactions: [{ to, value: "0", data, operation: OperationType.Call }], options: { nonce } });
  const d = tx.data;
  if (d.safeTxGas !== "0" || d.baseGas !== "0" || d.gasPrice !== "0" || !sameAddress(d.gasToken, ZERO_ADDRESS) || !sameAddress(d.refundReceiver, ZERO_ADDRESS) || d.operation !== 0 || d.nonce !== nonce) {
    throw new SafeToolError("BUNDLE_INVALID", "the SDK built a transaction with gas, refund or operation fields this tool does not sign", { data: d });
  }
  return tx;
}

/** The hash the Safe will verify: from the kit, equal to the chain's own getTransactionHash and to the local EIP-712 computation. */
export async function safeTxHashOf(handle: SafeHandle, to: Address, data: Hex, nonce: number): Promise<Hex> {
  const tx = await buildSdkTx(handle, to, data, nonce);
  const sdkHash = (await handle.sdk.getTransactionHash(tx)) as Hex;
  const local = localSafeTxHash(handle.chain.chainId, handle.address, to, data, nonce);
  if (lc(sdkHash) !== lc(local)) throw new SafeToolError("HASH_MISMATCH", "the SDK's Safe transaction hash differs from the local EIP-712 computation. Do not sign.", { sdkHash, local });
  const onchain = await handle.client.readContract({
    address: handle.address, abi: SAFE_ABI, functionName: "getTransactionHash",
    args: [to, 0n, data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, BigInt(nonce)],
  });
  if (lc(onchain) !== lc(sdkHash)) throw new SafeToolError("HASH_MISMATCH", "the SDK's Safe transaction hash differs from what the Safe computes for its own fields. Do not sign.", { sdkHash, onchain });
  return sdkHash;
}

// ---- describe -------------------------------------------------------------------------------------------------------------------------------

/** What a signer must read before signing: one line per decoded argument. Timelock calls are decoded; anything else shows its selector. */
export function describeCalldata(data: Hex, chainId?: number): string[] {
  try {
    const d = decodeFunctionData({ abi: TIMELOCK_ABI, data });
    if ((TIMELOCK_ALLOWED_FUNCTIONS as readonly string[]).includes(d.functionName)) {
      const abiItem = TIMELOCK_ABI.find((x) => x.type === "function" && x.name === d.functionName)!;
      const lines = [`call        ${d.functionName}`];
      (abiItem.inputs ?? []).forEach((inp, i) => lines.push(`${(inp.name ?? `arg${i}`).padEnd(11)} ${fmtArg((d.args as readonly unknown[])[i])}`));
      const inner = (d.args as readonly unknown[])[2];
      if (d.functionName === "schedule" || d.functionName === "execute") {
        if (typeof inner === "string" && inner.startsWith("0x") && inner.length >= 10) lines.push(...describeInner(inner as Hex, String((d.args as readonly unknown[])[0]), chainId));
      } else if (d.functionName === "scheduleBatch" || d.functionName === "executeBatch") {
        const targets = (d.args as readonly unknown[])[0] as readonly string[];
        ((d.args as readonly unknown[])[2] as readonly Hex[]).forEach((p, i) => lines.push(...describeInner(p, targets[i] ?? "?", chainId)));
      }
      return lines;
    }
  } catch { /* not a timelock call */ }
  return [`selector    ${data.slice(0, 10)} (decode it with the target's ABI before signing)`];
}

function describeInner(inner: Hex, target: string, chainId?: number): string[] {
  try {
    const u = decodeFunctionData({ abi: TIMELOCK_ABI, data: inner });
    if (u.functionName === "updateDelay") {
      const nd = (u.args as readonly bigint[])[0]!;
      const out = [`inner       updateDelay(newDelay=${nd}) on ${target}`];
      if (nd < 3600n || nd > 2592000n) out.push(`WARNING     new delay ${nd} is outside 1 hour to 30 days. If executed it can lock the timelock for good.`);
      if (chainId !== undefined && isMainnet(chainId) && nd < BigInt(delayFloor(chainId))) out.push(`WARNING     new delay ${nd} is below the ${delayFloor(chainId)} second floor on chain ${chainId}. publish contracts refuses to propose it unless the sheet says DEPLOYMENT_KIND=rehearsal.`);
      return out;
    }
  } catch { /* unknown inner call */ }
  return [`inner       selector ${inner.slice(0, 10)} on ${target} (decode it with the target's ABI before signing)`];
}

const fmtArg = (a: unknown): string => (Array.isArray(a) ? `[${a.map(fmtArg).join(", ")}]` : typeof a === "bigint" ? a.toString() : String(a));

export const describeBundle = (b: SafeTxBundle): string[] => describeCalldata(b.data, b.chain_id);

// ---- bundle files ---------------------------------------------------------------------------------------------------------------------------

export function readBundle(path: string): SafeTxBundle {
  if (!existsSync(path)) throw new SafeToolError("BUNDLE_INVALID", `bundle not found: ${path}`);
  let b: SafeTxBundle;
  try { b = JSON.parse(readFileSync(path, "utf8")) as SafeTxBundle; } catch { throw new SafeToolError("BUNDLE_INVALID", `${path} is not JSON`); }
  if (b.format !== BUNDLE_FORMAT) throw new SafeToolError("BUNDLE_INVALID", `${path} is not a ${BUNDLE_FORMAT} bundle`);
  return b;
}

/** Atomic write. `create` refuses to overwrite (a new bundle is one Safe nonce). */
export function writeBundle(path: string, bundle: SafeTxBundle, mode: "create" | "replace" = "replace"): void {
  if (mode === "create" && existsSync(path)) throw new SafeToolError("BAD_INPUT", `${path} exists; choose a new name (a bundle is one Safe nonce)`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(bundle, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, path);
}

// ---- propose --------------------------------------------------------------------------------------------------------------------------------

export interface ProposeOpts {
  to: Address;
  data: Hex;
  action?: string;
  description?: string;
  /** Marks the bundle as a timelock call: the target must be this address and the selector one of the five entry points. */
  timelock?: Address;
  timelockOperationId?: Hex;
  timelockMinDelay?: bigint;
  /** Write the bundle here (refuses an existing file). */
  out?: string;
}

/** Builds the Safe transaction at the Safe's current nonce, hashes it through the SDK, and returns a public bundle with no signatures yet. */
export async function proposeTx(handle: SafeHandle, o: ProposeOpts): Promise<SafeTxBundle> {
  if (!isHex(o.data) || (o.data.length - 2) % 2 !== 0) throw new SafeToolError("BAD_INPUT", "data must be 0x hex calldata");
  const to = getAddress(o.to);
  if (o.timelock) assertTimelockCall(to, o.data, o.timelock);
  const nonce = await handle.nonce();
  const hash = await safeTxHashOf(handle, to, o.data, nonce);
  const bundle: SafeTxBundle = {
    format: BUNDLE_FORMAT, chain_id: handle.chain.chainId, safe: handle.address, safe_version: handle.version,
    ...(o.timelock ? { timelock: getAddress(o.timelock) } : {}),
    action: o.action ?? "call", description: o.description ?? "",
    to, value: "0", data: o.data, operation: 0, safe_tx_gas: "0", base_gas: "0", gas_price: "0", gas_token: ZERO_ADDRESS, refund_receiver: ZERO_ADDRESS,
    nonce, safe_tx_hash: hash,
    ...(o.timelockOperationId ? { timelock_operation_id: o.timelockOperationId } : {}),
    ...(o.timelockMinDelay !== undefined ? { timelock_min_delay: o.timelockMinDelay.toString() } : {}),
    threshold: handle.threshold, owners: [...handle.owners], signatures: [], proposed_at: new Date().toISOString(),
  };
  if (o.out) writeBundle(o.out, bundle, "create");
  handle.logger.log("info", "safe.tx.proposed", { safe: handle.address, nonce, safe_tx_hash: hash, action: bundle.action, to, selector: o.data.slice(0, 10), out: o.out });
  return bundle;
}

export function assertTimelockCall(to: Address, data: Hex, timelock: Address): void {
  if (!sameAddress(to, timelock)) throw new SafeToolError("CALL_NOT_ALLOWED", `the bundle's target ${to} is not the timelock ${timelock}`);
  let fn: string | undefined;
  try { fn = decodeFunctionData({ abi: TIMELOCK_ABI, data }).functionName; } catch { /* below */ }
  if (!fn || !(TIMELOCK_ALLOWED_FUNCTIONS as readonly string[]).includes(fn)) {
    throw new SafeToolError("CALL_NOT_ALLOWED", `the calldata selector ${data.slice(0, 10)} is not one of the timelock's schedule, execute, scheduleBatch, executeBatch or cancel`);
  }
}

/** Re-checks a bundle against the chain. Run before signing and before executing. Throws a typed error on any difference. */
export async function reverifyBundle(handle: SafeHandle, b: SafeTxBundle): Promise<void> {
  if (b.format !== BUNDLE_FORMAT) throw new SafeToolError("BUNDLE_INVALID", `not a ${BUNDLE_FORMAT} bundle`);
  if (b.chain_id !== handle.chain.chainId) throw new SafeToolError("BUNDLE_INVALID", `the bundle is for chain ${b.chain_id}, this run is chain ${handle.chain.chainId}`);
  if (!sameAddress(b.safe, handle.address)) throw new SafeToolError("BUNDLE_INVALID", `the bundle is for Safe ${b.safe}, connected to ${handle.address}`);
  if (b.value !== "0" || b.operation !== 0) throw new SafeToolError("BUNDLE_INVALID", "the bundle carries a value or a delegatecall; this tool signs neither");
  if (b.safe_tx_gas !== "0" || b.base_gas !== "0" || b.gas_price !== "0" || !sameAddress(b.gas_token, ZERO_ADDRESS) || !sameAddress(b.refund_receiver, ZERO_ADDRESS)) {
    throw new SafeToolError("BUNDLE_INVALID", "the bundle carries gas, refund or token fields; this tool signs none");
  }
  if (b.timelock) assertTimelockCall(b.to, b.data, b.timelock);
  const live = await handle.nonce();
  if (b.nonce !== live) throw new SafeToolError("STALE_BUNDLE", `stale bundle: it was built for Safe nonce ${b.nonce}, the Safe is at nonce ${live} (the transaction was executed, or another one was). Propose again.`, { bundle: b.nonce, live });
  const hash = await safeTxHashOf(handle, b.to, b.data, b.nonce);
  if (lc(hash) !== lc(b.safe_tx_hash)) throw new SafeToolError("HASH_MISMATCH", "the bundle's safe_tx_hash does not match what the Safe computes for its own fields. Do not sign it.", { bundle: b.safe_tx_hash, computed: hash });
}

// ---- sign -----------------------------------------------------------------------------------------------------------------------------------

export interface SignOpts {
  /** raw (v 27/28) or eth_sign (prefixed, v 31/32). Default: raw when the signer can, else eth_sign. */
  mode?: SignMode;
  /** Skip the owner check (negative controls only: a non-owner signs and the Safe is asked to reject it). */
  allowNonOwner?: boolean;
  /** Skip the chain re-verification and the Safe's own checkNSignatures (negative controls only). */
  skipChainChecks?: boolean;
}

/** One owner signs. Returns a NEW bundle with that owner's signature added (replacing an earlier one from the same owner), sorted by owner. */
export async function signTx(handle: SafeHandle, bundle: SafeTxBundle, signer: Signer, opts: SignOpts = {}): Promise<SafeTxBundle> {
  if (!opts.skipChainChecks) await reverifyBundle(handle, bundle);
  const owner = await signer.address();
  if (!opts.allowNonOwner && !handle.owners.some((o) => sameAddress(o, owner))) throw new SafeToolError("NOT_OWNER", `the signer ${owner} is not an owner of the Safe. Nothing was signed.`, { signer: owner });
  const mode = opts.mode ?? (signer.modes.includes("raw") ? "raw" : "eth_sign");
  if (!signer.modes.includes(mode)) throw new SafeToolError("UNSUPPORTED_SIGN_MODE", `a ${signer.kind} signer cannot sign in mode ${mode}`);
  const hash = bundle.safe_tx_hash;
  handle.logger.log("info", "safe.tx.signing", { safe: handle.address, nonce: bundle.nonce, safe_tx_hash: hash, signer: owner, signer_kind: signer.kind, mode, review: describeBundle(bundle) });
  const sig = await signer.signSafeHash(hash, mode);
  if (!(await verifySafeSignature(hash, owner, sig))) throw new SafeToolError("SIGNATURE_INVALID", `the signature does not recover to ${owner}`);
  if (!opts.skipChainChecks) await checkSignaturesOnChain(handle, bundle, [{ owner, signature: sig }], 1);
  const next = addSignature(bundle, { owner: getAddress(owner), signature: sig });
  handle.logger.log("info", "safe.tx.signed", { signer: owner, signatures: next.signatures.length, threshold: bundle.threshold });
  return next;
}

export function addSignature(bundle: SafeTxBundle, s: BundleSignature): SafeTxBundle {
  const kept = bundle.signatures.filter((x) => lc(x.owner) !== lc(s.owner));
  const signatures = [...kept, s].sort((a, b) => (lc(a.owner) < lc(b.owner) ? -1 : 1));
  return { ...bundle, signatures };
}

// ---- signature bundle import (Safe app, a hardware workflow, another operator) ---------------------------------------------------------------

/**
 * Imports signatures made elsewhere. Accepts: a bundle JSON of ours, the Safe app's export ({ safeTxHash, signatures: [{ signer, data }] }),
 * `{ signatures: [{ owner|signer, signature|data }] }`, an array of those entries, or one hex blob of concatenated 65-byte signatures.
 * Each signature is recovered locally and must belong to an owner and to THIS transaction hash, or the import is refused.
 */
export async function importSignatureBundle(handle: Pick<SafeHandle, "owners" | "logger">, bundle: SafeTxBundle, source: string | object): Promise<SafeTxBundle> {
  let parsed: unknown = source;
  if (typeof source === "string") {
    const t = source.trim();
    if (/^0x[0-9a-fA-F]*$/.test(t)) parsed = t;
    else if (existsSync(t)) parsed = JSON.parse(readFileSync(t, "utf8"));
    else { try { parsed = JSON.parse(t); } catch { throw new SafeToolError("BUNDLE_INVALID", "signature source is neither hex, JSON nor an existing file"); } }
  }
  const claims: Array<{ owner?: string; sig: string }> = [];
  if (typeof parsed === "string") {
    const blob = parsed.slice(2);
    if (blob.length === 0 || blob.length % 130 !== 0) throw new SafeToolError("SIGNATURE_INVALID", "a signature blob must be a multiple of 65 bytes");
    for (let i = 0; i < blob.length; i += 130) claims.push({ sig: `0x${blob.slice(i, i + 130)}` });
  } else {
    const obj = parsed as { safeTxHash?: string; safe_tx_hash?: string; signatures?: unknown };
    const theirHash = obj.safeTxHash ?? obj.safe_tx_hash;
    if (theirHash && lc(theirHash) !== lc(bundle.safe_tx_hash)) throw new SafeToolError("HASH_MISMATCH", "the imported signatures are for a different Safe transaction hash", { theirs: theirHash, ours: bundle.safe_tx_hash });
    const list = Array.isArray(parsed) ? parsed : obj.signatures;
    if (!Array.isArray(list)) throw new SafeToolError("BUNDLE_INVALID", "no signatures array in the imported JSON");
    for (const e of list as Array<Record<string, string>>) {
      const sig = e.signature ?? e.data;
      if (!sig) throw new SafeToolError("BUNDLE_INVALID", "an imported entry has no signature (signature or data)");
      claims.push({ owner: e.owner ?? e.signer, sig });
    }
  }
  let out = bundle;
  for (const c of claims) {
    const sig = c.sig as Hex;
    splitSignature(sig);
    const recovered = await recoverSafeSigner(bundle.safe_tx_hash, sig);
    if (c.owner && !sameAddress(c.owner, recovered)) throw new SafeToolError("SIGNATURE_INVALID", `an imported signature claims ${c.owner} but recovers to ${recovered} for this transaction hash`);
    if (!handle.owners.some((o) => sameAddress(o, recovered))) throw new SafeToolError("NOT_OWNER", `an imported signature recovers to ${recovered}, who is not an owner of the Safe`, { signer: recovered });
    out = addSignature(out, { owner: getAddress(recovered), signature: sig });
  }
  handle.logger.log("info", "safe.tx.imported", { imported: claims.length, signatures: out.signatures.length, threshold: bundle.threshold });
  return out;
}

// ---- checking on the Safe itself (also the negative controls) -------------------------------------------------------------------------------

/** Packs signatures ascending by owner address, the order execTransaction requires. The kit does the packing. */
export function packSignatures(signatures: BundleSignature[]): Hex {
  const sorted = [...signatures].sort((a, b) => (lc(a.owner) < lc(b.owner) ? -1 : 1));
  const tx = sorted.map((s) => new EthSafeSignature(s.owner, s.signature));
  // buildSignatureBytes is what EthSafeTransaction.encodedSignatures() calls
  return ("0x" + tx.map((s) => s.data.slice(2)).join("")) as Hex;
}

/**
 * Asks the Safe to verify `signatures` over the bundle's hash (checkNSignatures, a view). A rejection comes back as SafeRevertError with
 * the Safe's own code: GS020 below threshold, GS026 a non-owner (or unsorted) signer, GS025 an unapproved hash.
 */
export async function checkSignaturesOnChain(handle: SafeHandle, bundle: SafeTxBundle, signatures: BundleSignature[], required = handle.threshold): Promise<void> {
  try {
    await handle.client.readContract({
      address: handle.address, abi: SAFE_ABI, functionName: "checkNSignatures",
      args: [bundle.safe_tx_hash, "0x", packSignatures(signatures), BigInt(required)],
    });
  } catch (e) {
    throw new SafeRevertError(revertReasonOf(e), { safe: handle.address, safe_tx_hash: bundle.safe_tx_hash, signatures: signatures.length, required });
  }
}

// ---- execute --------------------------------------------------------------------------------------------------------------------------------

export interface ExecuteOpts {
  /** Default true: verify bundle, owners, order and each signature locally before asking the chain. False sends the signatures straight to the Safe's own checks (negative controls). */
  localChecks?: boolean;
  /** Simulate only: run every check and the execTransaction call, send nothing. */
  dryRun?: boolean;
  /** Send every signature in the bundle, not only the threshold. The Safe checks the first `threshold` of them: the rest are readable from the chain by a verifier (the control proof). */
  allSignatures?: boolean;
}

export interface ExecuteResult {
  txHash?: Hex;
  block?: number;
  sentBy: Address;
  nonceBefore: number;
  nonceAfter?: number;
  bundle: SafeTxBundle;
  simulated: boolean;
}

export async function executeTx(handle: SafeHandle, bundle: SafeTxBundle, sender: Signer, opts: ExecuteOpts = {}): Promise<ExecuteResult> {
  const strict = opts.localChecks !== false;
  if (strict) await reverifyBundle(handle, bundle);
  const nonceBefore = await handle.nonce();
  const sigs = bundle.signatures;

  if (strict) {
    if (sigs.length < handle.threshold) throw new SafeToolError("BELOW_THRESHOLD", `the bundle has ${sigs.length} signatures, the Safe needs ${handle.threshold}`, { have: sigs.length, need: handle.threshold, safeCode: "GS020" });
    let prev = "";
    for (const [i, s] of sigs.entries()) {
      const o = lc(s.owner);
      if (!handle.owners.some((x) => lc(x) === o)) throw new SafeToolError("NOT_OWNER", `signature ${i} claims ${s.owner}, which is not an owner of the Safe`, { safeCode: "GS026" });
      if (prev && o === prev) throw new SafeToolError("SIGNATURE_INVALID", `signature ${i} repeats owner ${o}`);
      if (prev && !(o > prev)) throw new SafeToolError("SIGNATURE_INVALID", `signatures are not sorted by owner address ascending (${o} after ${prev})`);
      if (!(await verifySafeSignature(bundle.safe_tx_hash, s.owner, s.signature))) throw new SafeToolError("SIGNATURE_INVALID", `signature ${i} does not recover to ${s.owner} for this Safe transaction hash`);
      prev = o;
    }
  }
  const used = [...sigs].sort((a, b) => (lc(a.owner) < lc(b.owner) ? -1 : 1)).slice(0, strict && !opts.allSignatures ? handle.threshold : sigs.length);
  await checkSignaturesOnChain(handle, bundle, used, opts.allSignatures ? used.length : undefined);

  const senderAddr = await sender.address();
  const packed = packSignatures(used);
  const args = [bundle.to, 0n, bundle.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, packed] as const;
  try {
    const sim = await handle.client.simulateContract({ address: handle.address, abi: SAFE_ABI, functionName: "execTransaction", args, account: senderAddr });
    if (sim.result !== true) throw new SafeToolError("SAFE_REVERT", `simulation returned ${String(sim.result)}, not true (nothing sent)`);
  } catch (e) {
    if (e instanceof SafeToolError) throw e;
    throw new SafeRevertError(revertReasonOf(e), { safe: handle.address, phase: "simulation", note: "nothing was sent" });
  }
  handle.logger.log("info", "safe.tx.simulated", { safe: handle.address, nonce: nonceBefore, signatures: used.length, sender: senderAddr });
  if (opts.dryRun) return { sentBy: senderAddr, nonceBefore, bundle, simulated: true };

  const balance = await handle.client.getBalance({ address: senderAddr });
  if (balance === 0n) throw new SafeToolError("INSUFFICIENT_FUNDS", `the sender ${senderAddr} has no ETH for gas`);

  // the exact calldata the SDK would send, signatures packed by the kit
  const sdkTx = await buildSdkTx(handle, bundle.to, bundle.data, bundle.nonce);
  used.forEach((s) => sdkTx.addSignature(new EthSafeSignature(s.owner, s.signature)));
  const encoded = (await handle.sdk.getEncodedTransaction(sdkTx)) as Hex;

  let txHash: Hex;
  try { txHash = await sender.send({ to: handle.address, data: encoded }, handle.chain); }
  catch (e) { throw new SafeToolError("SEND_FAILED", `the send failed: ${revertReasonOf(e)}. Read the chain before retrying.`); }
  const receipt = await handle.client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new SafeToolError("TX_REVERTED", `the transaction reverted: ${txHash}`, { tx_hash: txHash });
  const nonceAfter = await handle.nonce();
  if (nonceAfter !== nonceBefore + 1) throw new SafeToolError("NONCE_DID_NOT_MOVE", `the Safe nonce did not move from ${nonceBefore} to ${nonceBefore + 1} after ${txHash} (it is ${nonceAfter})`);
  handle.logger.log("info", "safe.tx.executed", { tx_hash: txHash, block: Number(receipt.blockNumber), nonce_before: nonceBefore, nonce_after: nonceAfter, safe_tx_hash: bundle.safe_tx_hash });

  const done: SafeTxBundle = { ...bundle, executed: { tx_hash: txHash, block: Number(receipt.blockNumber), sent_by: senderAddr, status: 1 } };
  return { txHash, block: Number(receipt.blockNumber), sentBy: senderAddr, nonceBefore, nonceAfter, bundle: done, simulated: false };
}
