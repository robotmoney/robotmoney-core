// Stage 13 govern: the post-handover operations through the REAL Safe and the REAL timelock, with the Safe tool (src/safe).
// After the timelock stage the deployer holds no role. Everything here is a Safe transaction that schedules, executes or cancels a timelock operation.
// ONE CLASS OF OPERATION AFTER THE HANDOVER (owner decision, 2026-10-05, issue 1520): the unpause of each basket vault. The docs put exactly this
// there: unpause needs ADMIN_ROLE through the timelock (docs/technical/security-model.md, the pause-key abuse and pause-trigger rows). Voting power,
// quorum, voting period, execution delay, the vault setters, router eligibility and the router default weights are DEPLOY-TIME configuration the
// deployer sets before the handover (the governance and basket vault stages), and the verify stage asserts them against the sheet.
// The rows (GOVERN_ROWS):
//   unpause-PROTO, unpause-AGENT, unpause-RWA   one timelock operation per unpause (never a shared operation), all scheduled in ONE sitting
//   update-delay, batch, cancel                 Twin-only demonstrations of the Safe tool. Refused with USAGE on 8453.
// A run schedules every unpause the sheet asks for (GOVERN_UNPAUSE_VAULTS), waits ONE timelock delay, then executes each and reads depositsPaused() back.
// An operation declared dependent on another carries that operation's id as the timelock predecessor and runs in the same resume (no second wait).
// On demand, outside the matrix (it never blocks or completes the govern stage):
//   release-receipt              ConsensusRecommendationReceipt.releaseReceipt(receiptId), one round per receipt id (--receipt-id)
// The receipt contract's ADMIN_ROLE is held by the TimelockController after the timelock stage (INV-3), so the release is the same Safe ->
// Timelock round as every other row. It runs on the Twin chain AND on 8453 (issue 1611): on 8453 it is a standalone post-launch action, its own
// timelock operation with its own 48-hour delay, never part of stage 13 (stageRows stays the three unpauses). The first run schedules and exits
// GOVERN_PENDING with the resume command, the resume after the delay executes and reads isReleased back. Its run-manifest key and salt are `release-receipt-<receiptId>`.
// A basket the sheet does not list in GOVERN_UNPAUSE_VAULTS is recorded as skipped (it stays paused). This module decides nothing about pause semantics.
// The wait is the timelock's real delay. On a Twin fork (chain id is not 8453 and the RPC answers anvil_nodeInfo) it runs by ONE time warp to one second
// past the latest ready time. On 8453 there is no warp and no long sleep: the run exits GOVERN_PENDING once, with the ready time and the exact next
// command, and the same command resumes the stage.
import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { BASE_CHAIN_ID, httpRpc, isTwinFork, warpBy } from "./rehearsal/twin.ts";
import { readManifestField, saveRunManifest, type RunContext, type RunManifest } from "./runner.ts";
import { BASKET_KEYS, VAULT_NAME, type Sheet, type VaultKey } from "./sheet.ts";
import { VAULT_STAGES, manifestRef, type StageRow } from "./stages.ts";
import {
  cancelOnTimelock, connectSafe, executeOnTimelock, executeTx, operationId, operationState, scheduleOnTimelock, signTx, timelockMinDelay,
  updateTimelockDelay, verifyTimelockEffect, type Signer, type SafeHandle, type SafeTxBundle, type TimelockCall,
} from "./safe/index.ts";

export const VAULT_ABI = parseAbi([
  "function setPerDepositCap(uint256 newCap)",
  "function unpauseDeposits()",
  "function depositsPaused() view returns (bool)",
  "function perDepositCap() view returns (uint256)",
]);
export const RECEIPT_ABI = parseAbi([
  "function releaseReceipt(bytes32 receiptId)",
  "function isRecorded(bytes32 receiptId) view returns (bool)",
  "function isReleased(bytes32 receiptId) view returns (bool)",
]);
const TL_ABI = parseAbi(["function updateDelay(uint256 newDelay)"]);

export interface GovernAddrs {
  timelock: Address; safe: Address;
  vaults: Record<VaultKey, Address>;
}

export function loadGovernAddrs(ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): GovernAddrs {
  const r = (ref: string) => readManifestField(ctx, ref) as Address;
  return {
    timelock: r(manifestRef("timelock", "timelock")), safe: r(manifestRef("safe", "safe")),
    vaults: Object.fromEntries(VAULT_STAGES.map((v) => [v.key, r(manifestRef(v.stage, "vault"))])) as Record<VaultKey, Address>,
  };
}

export interface LabelledCall extends TimelockCall { label: string }

/** The mainnet rows: one unpause per basket vault. Each is its own timelock operation, all scheduled in one sitting. */
export { BASKET_KEYS };
export const UNPAUSE_ROWS = ["unpause-PROTO", "unpause-AGENT", "unpause-RWA"] as const;
/** Demonstrations of the Safe tool. They exist only as Twin-fork runs and are refused with USAGE on 8453. */
export const TWIN_ONLY_ROWS = ["update-delay", "batch", "cancel"] as const;
/** The govern rows in run order: the unpauses, then the Twin-only demonstrations. `--row` takes the 1-based number or the name. */
export const GOVERN_ROWS = [...UNPAUSE_ROWS, ...TWIN_ONLY_ROWS] as const;
export type GovernRowName = (typeof GOVERN_ROWS)[number];
export const governRowNames = (): readonly string[] => GOVERN_ROWS;
export const isTwinOnlyRow = (row: string): boolean => (TWIN_ONLY_ROWS as readonly string[]).includes(row);
/** The rows a stage run needs on a chain: the unpauses on 8453, every row elsewhere. */
export const stageRows = (chainId: number): readonly GovernRowName[] => (chainId === BASE_CHAIN_ID ? UNPAUSE_ROWS : GOVERN_ROWS);
/**
 * Declared dependencies between rows (row to the row it must follow). The dependent operation carries the other's operation id as the timelock
 * predecessor, so both run in the same resume with no second wait. The basket unpauses are independent: none is declared.
 */
export const GOVERN_DEPENDENCIES: Readonly<Record<string, string>> = {};

/**
 * The on-demand row: release one consensus receipt. Not in GOVERN_ROWS (the ordered matrix): it needs a receipt id, runs any number of times
 * (once per receipt), and neither waits for nor completes the matrix. It is still one round through the real Safe and the real timelock.
 */
export const RECEIPT_ROW = "release-receipt";
const RECEIPT_ID = /^0x[0-9a-fA-F]{64}$/;

/** `--receipt-id` value check: a 0x-prefixed bytes32. */
export function assertReceiptId(id: string): Hex {
  if (!RECEIPT_ID.test(id)) throw new PublishError("USAGE", `--receipt-id must be a 0x-prefixed bytes32 (64 hex), got '${id}'`);
  return id.toLowerCase() as Hex;
}

/** The run-manifest key, salt input and description prefix of one receipt's release round. One receipt id is one operation. */
export const releaseRecordKey = (receiptId: Hex): string => `${RECEIPT_ROW}-${receiptId.toLowerCase()}`;

/** The one call of a release round: releaseReceipt(receiptId) on the deployed ConsensusRecommendationReceipt. */
export function buildReleaseCall(receipt: Address, receiptId: Hex): LabelledCall {
  return { label: `receipt.releaseReceipt(${receiptId})`, target: receipt, data: encodeFunctionData({ abi: RECEIPT_ABI, functionName: "releaseReceipt", args: [receiptId] }) };
}

/** The deployed ConsensusRecommendationReceipt, from the ic-policy stage manifest (field consensus_receipt). */
export const loadReceiptAddr = (ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): Address => readManifestField(ctx, manifestRef("ic-policy", "consensus_receipt")) as Address;

/** `--row` value to a row name: a 1-based number or a name. Anything else is a usage error. */
export function resolveGovernRow(row: string): GovernRowName {
  if (row === RECEIPT_ROW) throw new PublishError("USAGE", `--row ${RECEIPT_ROW} is the on-demand receipt release: it needs --receipt-id 0x<bytes32>`);
  if (/^[0-9]+$/.test(row)) {
    const n = Number(row);
    const name = GOVERN_ROWS[n - 1];
    if (name === undefined) throw new PublishError("USAGE", `--row ${row}: there are ${GOVERN_ROWS.length} govern rows (1 to ${GOVERN_ROWS.length})`);
    return name;
  }
  if ((GOVERN_ROWS as readonly string[]).includes(row)) return row as GovernRowName;
  throw new PublishError("USAGE", `unknown govern row '${row}' (${GOVERN_ROWS.join(", ")}, or 1 to ${GOVERN_ROWS.length}; on demand: ${RECEIPT_ROW} --receipt-id 0x<bytes32>)`);
}

/** The calls of one unpause row. Empty means the sheet does not ask for it (the basket stays paused): the row is skipped. */
export function buildStepCalls(sheet: Sheet, a: GovernAddrs, row: GovernRowName): LabelledCall[] {
  const calls: LabelledCall[] = [];
  if (row.startsWith("unpause-")) {
    const k = row.slice("unpause-".length) as VaultKey;
    if (sheet.govern.unpauseVaults.includes(k)) calls.push({ label: `${VAULT_NAME[k]}.unpauseDeposits`, target: a.vaults[k], data: encodeFunctionData({ abi: VAULT_ABI, functionName: "unpauseDeposits" }) });
  }
  return calls;
}

export const governSalt = (coreSha: string, chainId: number, label: string): Hex => keccak256(toBytes(`publish-contracts:govern:${coreSha}:${chainId}:${label}`));

// ---- Safe API (injectable) ------------------------------------------------------------------------------------------------

export interface GovernApi {
  connectSafe: typeof connectSafe;
  scheduleOnTimelock: typeof scheduleOnTimelock;
  executeOnTimelock: typeof executeOnTimelock;
  cancelOnTimelock: typeof cancelOnTimelock;
  updateTimelockDelay: typeof updateTimelockDelay;
  operationId: typeof operationId;
  operationState: typeof operationState;
  timelockMinDelay: typeof timelockMinDelay;
  signTx: typeof signTx;
  executeTx: typeof executeTx;
  verifyTimelockEffect: typeof verifyTimelockEffect;
}
export const realGovernApi: GovernApi = { connectSafe, scheduleOnTimelock, executeOnTimelock, cancelOnTimelock, updateTimelockDelay, operationId, operationState, timelockMinDelay, signTx, executeTx, verifyTimelockEffect };

export type GovernPhase = "scheduled" | "executed" | "cancelled";

/** One stdout line per round event, the contract core's harness parses: {"row":"..","phase":"scheduled","txHash":"0x..","status":1,"readyAt":1700000000}. */
export interface GovernRowLine { row: string; phase: GovernPhase; txHash: string; status: 0 | 1; readyAt: number }

export interface GovernOpts {
  ownerSigners: Signer[];
  /** Pays gas for execTransaction. Holds no role. */
  sender: Signer;
  api?: GovernApi;
  /** Longest wait this process accepts for a timelock delay, in seconds (default 3600, and never more than 3600 on 8453). Longer: exit GOVERN_PENDING. */
  maxWaitSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /**
   * Moves chain time forward by this many seconds. Default: on a Twin fork only (eth_chainId is not 8453 and the RPC answers anvil_nodeInfo)
   * the anvil time warp, so the 48 hour waits run in seconds. On Base mainnet there is no warp: the run exits GOVERN_PENDING.
   * `false` turns the warp off (tests with a stub chain).
   */
  warp?: ((seconds: bigint) => Promise<void>) | false;
  /** Run one row only, by number or name. A Twin-only row needs the rows before it done first. `release-receipt` (with `receiptId`) is on demand. */
  row?: string;
  /** Declared dependencies (row to the row it follows), default GOVERN_DEPENDENCIES. The dependent carries the other's operation id as predecessor. */
  dependsOn?: Readonly<Record<string, string>>;
  /** With row `release-receipt` only: the bytes32 receipt id to release. */
  receiptId?: string;
  /** Where a row line goes. Default: stdout (console.log). */
  emit?: (line: string) => void;
  /**
   * Twin chain only: one generic Safe -> Timelock call (schedule, real delay by warp, execute) instead of a govern row. Test fixtures use it for
   * actions that are not mainnet govern rows (gateway unpause, agent revoke or authorize). Refused on chain 8453. Not combined with `row`.
   */
  call?: TwinCall;
}

/** One generic timelock call, named by `label` (the manifest key, the salt input and the `row` of the output lines). */
export interface TwinCall { label: string; target: Address; data: Hex }

interface PhaseRecord { tx_hash?: string; safe_tx_hash?: string; status?: number; at: string; operation_id?: string; ready_at?: string; note?: string; [k: string]: unknown }
/** What the run manifest keeps per row. A row is complete when it is skipped, executed or (for cancel) cancelled. */
export interface RowRecord { skipped?: { at: string; reason: string }; scheduled?: PhaseRecord; executed?: PhaseRecord; cancelled?: PhaseRecord }
type GovernState = Record<string, RowRecord>;

const rowComplete = (r: RowRecord | undefined): boolean => !!r && !!(r.skipped || r.executed || r.cancelled);

async function chainTime(handle: SafeHandle): Promise<bigint> {
  return (await handle.client.getBlock({ blockTag: "latest" })).timestamp;
}

async function signAndExecute(ctx: RunContext, o: GovernOpts, api: GovernApi, handle: SafeHandle, bundle: SafeTxBundle): Promise<SafeTxBundle> {
  let b = bundle;
  const owners = new Set(handle.owners.map((x) => x.toLowerCase()));
  let signed = 0;
  for (const s of o.ownerSigners) {
    if (signed >= handle.threshold) break;
    const who = (await s.address()).toLowerCase();
    if (!owners.has(who)) continue;
    b = await api.signTx(handle, b, s);
    signed++;
  }
  if (signed < handle.threshold) throw new PublishError("GOVERN", `only ${signed} of the ${handle.threshold} required Safe owner signers are available: pass --owner-signer for each`, { have: signed, need: handle.threshold });
  const res = await api.executeTx(handle, b, o.sender);
  ctx.log.log("info", "govern.safe_tx", { action: b.action, tx_hash: res.txHash, safe_tx_hash: b.safe_tx_hash, nonce: b.nonce });
  return res.bundle;
}

/** The warp to use for a wait: the injected one, else the anvil warp when the RPC is a Twin fork, else none (Base mainnet never warps). */
async function warpFor(ctx: RunContext, o: GovernOpts): Promise<((seconds: bigint) => Promise<void>) | undefined> {
  if (ctx.chainId === BASE_CHAIN_ID) return undefined;
  if (o.warp === false) return undefined;
  if (o.warp) return o.warp;
  const rpc = httpRpc(ctx.rpc);
  let twin = detected.get(ctx);
  if (twin === undefined) { twin = await isTwinFork(rpc); detected.set(ctx, twin); }
  return twin ? async (s) => { await warpBy(rpc, s); } : undefined;
}
const detected = new WeakMap<object, boolean>();

/** The exact command that resumes a pending run. Arguments that carry no secret are spelled out, the rest are the same as this run's. No row: the whole stage. */
export function resumeCommand(ctx: Pick<RunContext, "chainId" | "coreSha">, row?: string): string {
  if (row?.startsWith(`${RECEIPT_ROW}-`)) row = `${RECEIPT_ROW} --receipt-id ${row.slice(RECEIPT_ROW.length + 1)}`;
  return `bun publish-contracts/src/cli.ts govern${row === undefined ? "" : ` --row ${row}`} --chain ${ctx.chainId} --core-sha ${ctx.coreSha} (plus the same --rpc, --sheet, --signer, --environment and --owner-signer arguments as this run)`;
}

/**
 * Waits until every operation is ready (or done), with ONE wait for the whole set: on a Twin fork one warp to one second past the latest ready
 * time, on 8453 the run exits GOVERN_PENDING once with that latest ready time. `resumeRow` is the `--row` of the resume command (none: the stage).
 */
async function waitReady(ctx: RunContext, o: GovernOpts, api: GovernApi, handle: SafeHandle, timelock: Address, ops: { id: Hex; row: string }[], resumeRow?: string): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = ctx.chainId === BASE_CHAIN_ID ? Math.min(o.maxWaitSeconds ?? 3600, 3600) : (o.maxWaitSeconds ?? 3600);
  for (;;) {
    let latest = 0n;
    for (const op of ops) {
      const st = await api.operationState(handle, timelock, op.id);
      if (st.ready || st.done) continue;
      if (!st.pending) throw new PublishError("GOVERN", `operation ${op.id} (${op.row}) is not pending: it was cancelled or never scheduled`, { id: op.id });
      if (st.readyAt > latest) latest = st.readyAt;
    }
    if (latest === 0n) return;
    const remaining = Number(latest - (await chainTime(handle)));
    const rows = ops.map((x) => x.row);
    const warp = remaining > 0 ? await warpFor(ctx, o) : undefined;
    if (warp) {
      const seconds = remaining + 1;
      await warp(BigInt(seconds));
      ctx.log.log("info", "govern.warped", { rows, seconds });
      continue;
    }
    if (remaining > maxWait) {
      const next = resumeCommand(ctx, resumeRow);
      const what = rows.length === 1 ? `govern row ${rows[0]} is scheduled` : `govern rows ${rows.join(", ")} are scheduled`;
      throw new PublishError("GOVERN_PENDING", `${what} and become${rows.length === 1 ? "s" : ""} ready at ${latest} (${new Date(Number(latest) * 1000).toISOString()}, in about ${remaining} s). After that time run: ${next}`,
        { ids: ops.map((x) => x.id), row: rows[0], rows, ready_at: latest.toString(), remaining, next_command: next });
    }
    ctx.log.log("info", "govern.waiting", { rows, remaining_s: remaining });
    await sleep(o.pollMs ?? 5000);
  }
}

/** Prints the line of a phase that sent a Safe transaction. A phase adopted from the chain (no transaction of its own) prints none. */
function emitPhase(o: GovernOpts, row: string, phase: GovernPhase, rec: PhaseRecord): void {
  if (!rec.tx_hash) return;
  // executeTx throws on a reverted receipt, so a recorded transaction (even one from an earlier run) has status 1 unless the record says otherwise
  const line: GovernRowLine = { row, phase, txHash: rec.tx_hash, status: rec.status === 0 ? 0 : 1, readyAt: Number(rec.ready_at ?? 0) };
  (o.emit ?? ((l: string) => console.log(l)))(JSON.stringify(line));
}

type Rd = <T>(address: Address, abi: readonly unknown[], functionName: string, args?: unknown[]) => Promise<T>;
const reader = (handle: SafeHandle): Rd => (address, abi, functionName, args = []) =>
  handle.client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<never>;

/** Read-back of one unpause row: the problems found on chain after the round executed. An empty list is a pass. */
export async function readBackStep(handle: SafeHandle, a: GovernAddrs, row: GovernRowName): Promise<string[]> {
  const bad: string[] = [];
  const rd = reader(handle);
  if (row.startsWith("unpause-")) {
    const k = row.slice("unpause-".length) as VaultKey;
    if (await rd<boolean>(a.vaults[k], VAULT_ABI, "depositsPaused")) bad.push(`${VAULT_NAME[k]}.depositsPaused`);
  }
  return bad;
}

/** One round, ready to run: the operation, how to send each phase, and how to check the effect. */
interface RoundPlan {
  id: Hex;
  /** The row whose operation this one follows (the timelock predecessor). */
  dependsOn?: string;
  schedule: () => Promise<SafeTxBundle>;
  /** Absent for the cancel round: its second phase is the cancel. */
  execute?: () => Promise<SafeTxBundle>;
  cancel?: () => Promise<SafeTxBundle>;
  readBack: () => Promise<string[]>;
  description: string;
}

export interface GovernResult { rows: string[]; skipped: string[]; opIds: Record<string, Hex> }

export async function runGovern(ctx: RunContext, row: StageRow, manifest: RunManifest, o: GovernOpts): Promise<GovernResult> {
  const api = o.api ?? realGovernApi;
  // Usage errors first, before the Safe is read or anything is sent.
  if (o.call && ctx.chainId === BASE_CHAIN_ID) throw new PublishError("USAGE", "a generic timelock call is a Twin-chain test verb: it is refused on chain 8453");
  if (o.call && o.row !== undefined) throw new PublishError("USAGE", "a generic timelock call and --row are mutually exclusive");
  if (o.receiptId !== undefined && o.row !== RECEIPT_ROW) throw new PublishError("USAGE", `--receipt-id goes with --row ${RECEIPT_ROW} only`);
  if (o.call && o.receiptId !== undefined) throw new PublishError("USAGE", "a generic timelock call and --receipt-id are mutually exclusive");
  const releasing = o.row === RECEIPT_ROW;
  const selected: GovernRowName | undefined = o.row === undefined || releasing ? undefined : resolveGovernRow(o.row);
  if (selected !== undefined && isTwinOnlyRow(selected) && ctx.chainId === BASE_CHAIN_ID) {
    throw new PublishError("USAGE", `--row ${selected} is a demonstration of the Safe tool: it runs on a Twin fork only and is refused on chain 8453 (the only mainnet govern stage operation is the basket unpause; the one other mainnet action is --row ${RECEIPT_ROW})`);
  }
  const a = loadGovernAddrs(ctx);
  const sheet = ctx.sheet;
  const handle = await api.connectSafe({ rpcUrl: ctx.rpc, chainId: ctx.chainId, safeAddress: a.safe, logger: ctx.log });
  if (handle.owners.map((x) => x.toLowerCase()).sort().join() !== sheet.safeOwners.map((x) => x.toLowerCase()).sort().join()) throw new PublishError("GOVERN", "the Safe's owners on chain differ from the sheet", {});
  ctx.log.log("info", "stage.start", { stage: row.name, safe: a.safe, timelock: a.timelock });
  const state = (manifest.govern ??= {}) as GovernState;
  const salt = (name: string) => governSalt(ctx.coreSha, ctx.chainId, name);
  const note = (b: SafeTxBundle) => ({ tx_hash: b.executed?.tx_hash, safe_tx_hash: b.safe_tx_hash, status: b.executed?.status });
  const save = () => saveRunManifest(ctx.evidenceDir, manifest);
  const opIds: Record<string, Hex> = {};
  const ran: string[] = [];
  const skipped: string[] = [];
  const dependsOn = o.dependsOn ?? GOVERN_DEPENDENCIES;
  for (const [dep, pre] of Object.entries(dependsOn)) {
    const di = (GOVERN_ROWS as readonly string[]).indexOf(dep), pi = (GOVERN_ROWS as readonly string[]).indexOf(pre);
    if (di < 0 || pi < 0 || pi >= di) throw new PublishError("USAGE", `row ${dep} cannot follow ${pre}: both must be govern rows and the predecessor comes first`, { dep, pre });
  }

  /** The plan of a row, or a reason to skip it. A declared predecessor must be a row of this run with an operation id. */
  async function plan(name: GovernRowName): Promise<RoundPlan | string> {
    const pre = dependsOn[name];
    let predecessor: Hex | undefined;
    if (pre !== undefined) {
      predecessor = opIds[pre];
      if (predecessor === undefined) throw new PublishError("GOVERN", `govern row ${name} follows ${pre}, which has no operation in this run (skipped or not selected)`, { row: name, depends_on: pre });
    }
    const orderedPlan = async (calls: LabelledCall[], saltName: string, readBack: () => Promise<string[]>, description: string): Promise<RoundPlan> => {
      const form = calls.length === 1 ? ("single" as const) : ("batch" as const);
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(saltName), form, ...(predecessor ? { predecessor } : {}) };
      return {
        id: await api.operationId(handle, p), readBack, description, ...(pre !== undefined ? { dependsOn: pre } : {}),
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${name} (${calls.length} calls): ${calls.map((c) => c.label).join("; ")}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${name} execute` }),
      };
    };
    if (name === "update-delay") {
      const newDelay = sheet.govern.newDelay;
      const s = salt(name);
      const inner = { target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [newDelay] }) };
      return {
        id: await api.operationId(handle, { timelock: a.timelock, calls: [inner], salt: s, form: "single" }),
        description: `updateDelay to ${newDelay}`,
        schedule: () => api.updateTimelockDelay(handle, { timelock: a.timelock, newDelay, phase: "schedule", salt: s, description: `update-delay: updateDelay to ${newDelay}` }),
        execute: () => api.updateTimelockDelay(handle, { timelock: a.timelock, newDelay, phase: "execute", salt: s, description: `update-delay: execute updateDelay to ${newDelay}` }),
        readBack: async () => { const now = await api.timelockMinDelay(handle, a.timelock); return now === newDelay ? [] : [`getMinDelay is ${now}, want ${newDelay}`]; },
      };
    }
    if (name === "batch") {
      // one scheduleBatch round that changes nothing: the delay set to itself and one cap set to the sheet value it already has
      const delay = await api.timelockMinDelay(handle, a.timelock);
      const calls: LabelledCall[] = [
        { label: "timelock.updateDelay(unchanged)", target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [delay] }) },
        { label: "rmUSDC.setPerDepositCap(unchanged)", target: a.vaults.USDC, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "setPerDepositCap", args: [sheet.vaults.USDC.perDepositCap] }) },
      ];
      return orderedPlan(calls, name, async () => {
        const bad: string[] = [];
        if ((await api.timelockMinDelay(handle, a.timelock)) !== delay) bad.push("getMinDelay changed");
        if ((await reader(handle)<bigint>(a.vaults.USDC, VAULT_ABI, "perDepositCap")) !== sheet.vaults.USDC.perDepositCap) bad.push("rmUSDC.perDepositCap changed");
        return bad;
      }, "batch scheduling proof");
    }
    if (name === "cancel") {
      const delay = await api.timelockMinDelay(handle, a.timelock);
      const p = { timelock: a.timelock, calls: [{ target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [delay] }) }], salt: salt(name), form: "single" as const };
      const id = await api.operationId(handle, p);
      return {
        id, description: "a no-op operation that the Safe cancels",
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: "cancel: a no-op operation that the Safe cancels" }),
        cancel: () => api.cancelOnTimelock(handle, { timelock: a.timelock, id, description: "cancel: cancel the no-op" }),
        readBack: async () => { const st = await api.operationState(handle, a.timelock, id); return st.pending || st.exists ? ["the cancelled operation is still on the timelock"] : []; },
      };
    }
    const calls = buildStepCalls(sheet, a, name);
    if (calls.length === 0) return `${name.slice("unpause-".length)} is not in GOVERN_UNPAUSE_VAULTS: it stays paused`;
    return orderedPlan(calls, name, () => readBackStep(handle, a, name), `${calls.length} call(s)`);
  }

  /** Phase 1 of a round: schedule (or, for an operation already on the timelock, adopt it). `emitAs` is the `row` of the printed lines. */
  async function schedulePhase(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    opIds[name] = p.id;
    const rec: RowRecord = state[name] ?? {};
    if (rec.scheduled) {
      ctx.log.log("info", "govern.phase_skipped", { row: name, phase: "scheduled" });
      emitPhase(o, emitAs, "scheduled", rec.scheduled);
      return;
    }
    const st = await api.operationState(handle, a.timelock, p.id);
    let sched: PhaseRecord;
    if (st.exists) sched = { at: new Date().toISOString(), operation_id: p.id, ready_at: st.readyAt.toString(), note: "already scheduled by an earlier run" };
    else {
      const done = await signAndExecute(ctx, o, api, handle, await p.schedule());
      const after = await api.operationState(handle, a.timelock, p.id);
      sched = { at: new Date().toISOString(), operation_id: p.id, ready_at: after.readyAt.toString(), ...note(done) };
    }
    rec.scheduled = sched;
    state[name] = rec;
    save();
    ctx.log.log("info", "govern.phase_done", { row: name, phase: "scheduled" });
    emitPhase(o, emitAs, "scheduled", sched);
  }

  /** Phase 2 of a cancel round: the Safe cancels the scheduled operation. */
  async function cancelPhase(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    const rec = state[name]!;
    if (rec.cancelled) { emitPhase(o, emitAs, "cancelled", rec.cancelled); return; }
    let cancelled: PhaseRecord;
    if (!(await api.operationState(handle, a.timelock, p.id)).exists) cancelled = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, note: "already cancelled by an earlier run" };
    else cancelled = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, ...note(await signAndExecute(ctx, o, api, handle, await p.cancel!())) };
    const bad = await p.readBack();
    if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back failed: ${bad.join(", ")}`, { bad });
    rec.cancelled = cancelled;
    save();
    emitPhase(o, emitAs, "cancelled", rec.cancelled);
  }

  /** Phase 2 of an executing round, once the delay has passed: execute (or adopt an execution already on chain), read back, record. */
  async function executePhase(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    const rec = state[name]!;
    if (rec.executed) { emitPhase(o, emitAs, "executed", rec.executed); return; }
    let ex: PhaseRecord;
    if ((await api.operationState(handle, a.timelock, p.id)).done) {
      const bad = await p.readBack();
      if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back differs from the sheet: ${bad.join(", ")}`, { bad });
      ex = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, note: "already executed by an earlier run" };
    } else {
      const done = await signAndExecute(ctx, o, api, handle, await p.execute!());
      const eff = await api.verifyTimelockEffect(handle, done);
      if (!eff.ok) throw new PublishError("GOVERN", `govern row ${name} effect not observed: ${eff.detail}`);
      const bad = await p.readBack();
      if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back differs from the sheet: ${bad.join(", ")}`, { bad });
      ex = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled!.ready_at, ...note(done) };
    }
    rec.executed = ex;
    save();
    ctx.log.log("info", "govern.phase_done", { row: name, phase: "executed" });
    emitPhase(o, emitAs, "executed", ex);
  }

  /** One round on its own: schedule, then cancel or wait for the real delay and execute. The receipt release, the generic call and the Twin-only rows. */
  async function round(name: string, p: RoundPlan, emitAs: string = name): Promise<void> {
    await schedulePhase(name, p, emitAs);
    if (p.cancel) return cancelPhase(name, p, emitAs);
    if (state[name]!.executed) return executePhase(name, p, emitAs);
    await waitReady(ctx, o, api, handle, a.timelock, [{ id: p.id, row: name }], name);
    await executePhase(name, p, emitAs);
  }

  /** Reprint the lines of a row that is already complete. */
  function reprint(name: string): void {
    const r = state[name]!;
    if (r.scheduled) emitPhase(o, name, "scheduled", r.scheduled);
    if (r.executed) emitPhase(o, name, "executed", r.executed);
    if (r.cancelled) emitPhase(o, name, "cancelled", r.cancelled);
  }

  /**
   * The unpause rows as one set: every operation scheduled in one sitting (each its own timelock operation and its own Safe transaction), ONE wait
   * for the latest ready time, then each executed in order and read back. A resume finds the schedules recorded and goes straight to the wait.
   */
  async function runSet(names: readonly GovernRowName[], resumeRow?: string): Promise<void> {
    const live: { name: GovernRowName; p: RoundPlan }[] = [];
    for (const name of names) {
      if (rowComplete(state[name])) {
        ctx.log.log("info", "govern.row_complete", { row: name });
        const doneId = state[name]!.scheduled?.operation_id;
        if (doneId) opIds[name] = doneId as Hex; // a dependent row of this run still needs its predecessor's id
        reprint(name);
        continue;
      }
      const p = await plan(name);
      if (typeof p === "string") {
        state[name] = { skipped: { at: new Date().toISOString(), reason: p } };
        save();
        skipped.push(name);
        ctx.log.log("info", "govern.row_skipped", { row: name, reason: p });
        continue;
      }
      await schedulePhase(name, p);
      live.push({ name, p });
    }
    await waitReady(ctx, o, api, handle, a.timelock, live.map((x) => ({ id: x.p.id, row: x.name })), resumeRow);
    for (const { name, p } of live) {
      await executePhase(name, p);
      ran.push(name);
      ctx.log.log("info", "govern.row_done", { row: name });
    }
  }

  if (releasing) {
    if (o.receiptId === undefined) throw new PublishError("USAGE", `--row ${RECEIPT_ROW} needs --receipt-id 0x<bytes32>`);
    const receiptId = assertReceiptId(o.receiptId);
    const receipt = loadReceiptAddr(ctx);
    const name = releaseRecordKey(receiptId);
    const c = buildReleaseCall(receipt, receiptId);
    const p = { timelock: a.timelock, calls: [{ target: c.target, data: c.data }], salt: salt(name), form: "single" as const };
    const id = await api.operationId(handle, p);
    // The receipt id is the salt input, so one receipt is one operation. A record under this key for a different operation (another receipt
    // contract, say) would adopt the wrong round: refuse it, as the generic call refuses a reused label with different calldata.
    const prior = state[name]?.scheduled?.operation_id;
    if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `${name} was already used for a different call (operation ${prior}, this call is ${id})`, { row: RECEIPT_ROW, receipt_id: receiptId, prior, id });
    const rd = reader(handle);
    const readBack = async () => ((await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId])) ? [] : [`receipt.isReleased(${receiptId}) is false`]);
    if (!rowComplete(state[name])) {
      if (state[name]?.scheduled === undefined && !(await api.operationState(handle, a.timelock, id)).exists) {
        // Nothing of this round exists yet. Refuse a round whose execute can only revert, before the Safe schedules it and the delay is spent.
        if (!(await rd<boolean>(receipt, RECEIPT_ABI, "isRecorded", [receiptId]))) throw new PublishError("GOVERN", `receipt ${receiptId} is not recorded on ${receipt}: nothing to release`, { receipt_id: receiptId });
        if (await rd<boolean>(receipt, RECEIPT_ABI, "isReleased", [receiptId])) throw new PublishError("GOVERN", `receipt ${receiptId} is already released on ${receipt}, not by this row's operation: nothing to schedule`, { receipt_id: receiptId });
      }
      await round(name, {
        id, description: `release receipt ${receiptId}`, readBack,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${RECEIPT_ROW}: ${c.label}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${RECEIPT_ROW} execute` }),
      }, RECEIPT_ROW);
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, RECEIPT_ROW, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, RECEIPT_ROW, "executed", r.executed);
    }
    save();
    ctx.log.log("info", "govern.row_run_done", { stage: row.name, row: RECEIPT_ROW, receipt_id: receiptId });
    return { rows: [name], skipped: [], opIds };
  }

  if (o.call) {
    const { label, target, data } = o.call;
    if (!/^[A-Za-z0-9._-]+$/.test(label) || (GOVERN_ROWS as readonly string[]).includes(label) || label === RECEIPT_ROW) throw new PublishError("USAGE", `call label '${label}': letters, digits, . _ - only, and not a govern row name`);
    const name = `call-${label}`;
    const p = { timelock: a.timelock, calls: [{ target, data }], salt: salt(name), form: "single" as const };
    const id = await api.operationId(handle, p);
    // The label is the salt, so one label is one operation. A second, different call under a used label would adopt the first call's record (and its spent or reverted operation): refuse it.
    const prior = state[name]?.scheduled?.operation_id;
    if (prior !== undefined && prior.toLowerCase() !== id.toLowerCase()) throw new PublishError("USAGE", `call label '${label}' was already used for a different call (operation ${prior}, this call is ${id}): use a unique label per call`, { label, prior, id });
    if (!rowComplete(state[name])) {
      await round(name, {
        id, description: `generic call ${label} to ${target}`,
        schedule: () => api.scheduleOnTimelock(handle, { ...p, description: `${name}: ${label}` }),
        execute: () => api.executeOnTimelock(handle, { ...p, description: `${name} execute` }),
        readBack: async () => [],
      });
    } else {
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, name, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, name, "executed", r.executed);
    }
    save();
    return { rows: [name], skipped: [], opIds };
  }

  // The unpauses are one set: they have no order among themselves. A single --row unpause-X is the set of one.
  const wanted = selected === undefined ? stageRows(ctx.chainId) : [selected];
  const unpauses = wanted.filter((n) => !isTwinOnlyRow(n));
  if (unpauses.length) await runSet(unpauses, selected);
  // The Twin-only demonstrations run one round at a time, in order, after every unpause is complete.
  for (const name of wanted.filter((n) => isTwinOnlyRow(n))) {
    if (rowComplete(state[name])) { ctx.log.log("info", "govern.row_complete", { row: name }); reprint(name); continue; }
    const idx = GOVERN_ROWS.indexOf(name);
    const open = GOVERN_ROWS.slice(0, idx).find((n) => !rowComplete(state[n]));
    if (open) throw new PublishError("GOVERN", `govern row ${name} cannot start: row ${open} is not complete. The Twin-only rows run one round at a time, after the unpauses. Run ${open} first.`, { row: name, blocked_by: open });
    const p = await plan(name);
    if (typeof p === "string") throw new PublishError("GOVERN", `govern row ${name} has nothing to run: ${p}`, { row: name });
    await round(name, p);
    ran.push(name);
    ctx.log.log("info", "govern.row_done", { row: name });
  }

  // a single-row run leaves the stage open: only a run that finds every row of this chain complete marks govern done
  if (stageRows(ctx.chainId).every((n) => rowComplete(state[n]))) {
    if (!manifest.stages[row.name] || manifest.stages[row.name]!.status !== "done") {
      manifest.stages[row.name] = { status: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: Object.keys(state).length };
    }
  }
  save();
  ctx.log.log("info", selected === undefined ? "stage.done" : "govern.row_run_done", { stage: row.name, row: selected });
  return { rows: ran, skipped, opIds };
}
