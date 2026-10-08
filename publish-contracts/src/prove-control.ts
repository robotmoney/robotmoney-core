// The prove-control step (core 1618, plan decision 21), between stage 10 and stage 11. The real Safe executes one self-call (value 0, empty
// data) that EVERY owner signed, through the Safe tool: proposeTx, signTx per owner, the Safe's own checkNSignatures over all of them, then
// executeTx with every signature in the calldata. The proof goes straight through the Safe, never through the timelock.
// The run manifest keeps the transaction hash and the signers. Stage 11 refuses without that record (control-proof.ts).
import { type Address } from "viem";
import { PROOF_STAGE, controlNotProven, type ControlProofRecord } from "./control-proof.ts";
import { PublishError } from "./errors.ts";
import { confirmStage, readManifestField, saveRunManifest, type RunContext, type RunManifest } from "./runner.ts";
import { manifestRef, type StageRow } from "./stages.ts";
import {
  checkSignaturesOnChain, connectSafe, executeTx, proposeTx, signTx, verifySafeSignature, type SafeHandle, type SafeTxBundle, type Signer,
} from "./safe/index.ts";

export interface ProveApi {
  connectSafe: typeof connectSafe;
  proposeTx: typeof proposeTx;
  signTx: typeof signTx;
  checkSignaturesOnChain: typeof checkSignaturesOnChain;
  executeTx: typeof executeTx;
}
export const realProveApi: ProveApi = { connectSafe, proposeTx, signTx, checkSignaturesOnChain, executeTx };

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
  if (nonce !== 0) throw controlNotProven(`the Safe nonce is ${nonce}, not 0: the Safe moved outside this run, and a proof is taken on a new Safe only`, { nonce });
  // A signer for every owner, named before anything is proposed, signed or sent.
  const byOwner = new Map<string, Signer>();
  for (const s of o.ownerSigners) byOwner.set(lc(await s.address()), s);
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
