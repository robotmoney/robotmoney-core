// The `record-receipt` verb (issue 1727): the registered committee submitter anchors ONE consensus receipt on chain through the gateway,
// RobotMoneyGateway.consensusRecordReceipt(receiptId, payloadDigest, payloadUri). Docs: docs/technical/consensus-receipt-submitter-runbook.md.
//
// WHY THIS VERB EXISTS. `rmpc receipt submit` is the production path, but it refuses a software signer on a production-grade chain (ErrProductionSignerRequired: only an HSM
// or KMS backend counts, and none is implemented). A Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) therefore records through this verb, with the operator's own
// signer spec (a hardware wallet, or an encrypted keystore whose passphrase is typed at the hidden prompt). It is refused on 8453 in production kind: production records through rmpc with an HSM/KMS.
//
// THE KEY. --signer is the SUBMITTER: the address registered by `govern --row register-committee`. It is supplied by the operator at run time. No key, passphrase or keystore
// path is ever written to the repo, the evidence or the run manifest (only the submitter ADDRESS is). The submitter holds AGENT_ROLE on the gateway and COMMITTEE_AGENT_ROLE on
// the IC policy and nothing else. Recording is signalling only (INV-4): it moves no value and sets no weight. (AGENT_ROLE also allows allocation-signalling votes and tiny deposits: Withdrawals are disabled (the policy's withdraw caps are 0, so withdraw reverts WithdrawalNotEnabled); deposits are capped at 1 raw unit of USDC per payment and per window, paid from the submitter's own funds, with the shares going to the timelock.)
//
// BEFORE ANYTHING IS SENT it checks, on chain: the receipt contract is the one the gateway routes to, the submitter holds both roles, the receipt id is not recorded yet (or is
// recorded with exactly this digest, uri and submitter, which is reported and not sent again). AFTER it reads the receipt back and compares id, digest, uri and submitter.
// The digest and id come from `rmpc receipt verify` (read-only, no signer, it checks every analyst signature off chain): pass its payload_digest and receipt_id.
import { createPublicClient, encodeFunctionData, http, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { isMainnet } from "./chains.ts";
import { loadRunManifest, readManifestField, saveRunManifest, confirmStage, type RunContext } from "./runner.ts";
import { manifestRef } from "./stages.ts";
import type { Signer } from "./safe/index.ts";

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
}

/** The chain reads and the one send of the verb. Tests inject a fake; the real one is viem over the run's RPC and the Safe tool signer. */
export interface RecordApi {
  read<T>(address: Address, abi: readonly unknown[], fn: string, args?: unknown[]): Promise<T>;
  send(signer: Signer, to: Address, data: Hex): Promise<{ txHash: Hex; status: "success" | "reverted"; blockNumber: bigint }>;
}

export function realRecordApi(rpc: string, chainId: number): RecordApi {
  const client = createPublicClient({ transport: http(rpc) });
  return {
    read: (address, abi, fn, args = []) => client.readContract({ address, abi: abi as never, functionName: fn as never, args: args as never }) as Promise<never>,
    send: async (signer, to, data) => {
      const txHash = await signer.send({ to, data }, { rpcUrl: rpc, chainId });
      const rc = await client.waitForTransactionReceipt({ hash: txHash });
      return { txHash, status: rc.status, blockNumber: rc.blockNumber };
    },
  };
}

const B32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (x: string) => x.toLowerCase();

export function assertRecordInputs(i: { receiptId?: string; payloadDigest?: string; payloadUri?: string }): RecordInputs {
  if (!i.receiptId || !B32.test(i.receiptId)) throw new PublishError("USAGE", "--receipt-id must be a 0x-prefixed bytes32 (the receipt_id that `rmpc receipt verify` prints)");
  if (!i.payloadDigest || !B32.test(i.payloadDigest)) throw new PublishError("USAGE", "--payload-digest must be a 0x-prefixed bytes32 (the payload_digest that `rmpc receipt verify` prints)");
  if (!i.payloadUri || !/^https?:\/\/\S+$/.test(i.payloadUri)) throw new PublishError("USAGE", "--payload-uri must be the public http(s) route that serves the exact payload bytes");
  return { receiptId: i.receiptId.toLowerCase() as Hex, payloadDigest: i.payloadDigest.toLowerCase() as Hex, payloadUri: i.payloadUri };
}

/** The addresses the verb talks to, from the stage manifests of the run. */
export const loadRecordAddrs = (ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): { gateway: Address; icPolicy: Address; receipt: Address } => ({
  gateway: readManifestField(ctx, manifestRef("gateway", "gateway")) as Address,
  icPolicy: readManifestField(ctx, manifestRef("ic-policy", "policy")) as Address,
  receipt: readManifestField(ctx, manifestRef("ic-policy", "consensus_receipt")) as Address,
});

export async function recordReceipt(ctx: RunContext, signer: Signer, i: RecordInputs, api: RecordApi = realRecordApi(ctx.rpc, ctx.chainId)): Promise<RecordedReceipt> {
  if (ctx.sheet.kind !== "rehearsal" && isMainnet(ctx.chainId)) {
    throw new PublishError("USAGE", "record-receipt is refused on this chain in production: production records receipts with `rmpc receipt submit` and an HSM or KMS signer. It runs on a Base mainnet REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) and on the Twin chain.");
  }
  const a = loadRecordAddrs(ctx);
  const submitter = await signer.address();
  // The submitter holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else: a Safe owner or a role key is refused here, not only by the on-chain role checks.
  const reserved = new Map<string, string>([...ctx.sheet.safeOwners.map((o, i) => [o.toLowerCase(), `Safe owner ${i + 1}`] as const), [ctx.sheet.pauser.toLowerCase(), "PAUSER_ADDRESS"], [ctx.sheet.emergency.toLowerCase(), "EMERGENCY_ADDRESS"]]);
  const why = reserved.get(submitter.toLowerCase());
  if (why) throw new PublishError("USAGE", `the signer ${submitter} is ${why}: the submitter holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else. Use a dedicated key. Nothing sent.`, { submitter });
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
    return finish(ctx, { receipt_id: i.receiptId, payload_digest: i.payloadDigest, payload_uri: i.payloadUri, submitter, status: 1, already_recorded: true });
  }
  await confirmStage(ctx, "record-receipt", `record receipt ${i.receiptId} (digest ${i.payloadDigest}) from ${submitter} through the gateway ${a.gateway}`);
  const data = encodeFunctionData({ abi: GATEWAY_RECORD_ABI, functionName: "consensusRecordReceipt", args: [i.receiptId, i.payloadDigest, i.payloadUri] });
  const sent = await api.send(signer, a.gateway, data);
  if (sent.status !== "success") throw new PublishError("GOVERN", `consensusRecordReceipt reverted in ${sent.txHash}: nothing was recorded`, { tx_hash: sent.txHash });
  await readBack();
  ctx.log.log("info", "record_receipt.done", { receipt_id: i.receiptId, submitter, tx_hash: sent.txHash });
  return finish(ctx, { receipt_id: i.receiptId, payload_digest: i.payloadDigest, payload_uri: i.payloadUri, submitter, tx_hash: sent.txHash, status: 1, block_number: Number(sent.blockNumber) });
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
