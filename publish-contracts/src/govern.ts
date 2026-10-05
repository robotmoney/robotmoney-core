// Stage 13 govern: the post-handover matrix (runbook Q2) through the REAL Safe and the REAL timelock, with the Safe tool (src/safe).
// After the timelock stage the deployer holds no role. Everything here is a Safe transaction that schedules, executes or cancels a timelock operation.
// ONE ROUND PER STEP (owner decision, 2026-10-05). Each step is its own schedule, its own wait for the timelock's real delay, its own execute and
// its own on-chain read-back. Steps are never batched into a shared round. The steps, in order (GOVERN_ROWS):
//   1 voting-power-quorum        setVotingPower per voter, setQuorumThreshold, setVotingPeriod, setExecutionDelay
//   2 agents                     gateway.authorizeAgent per sheet agent
//   3 other-setters              the vault setters: per-deposit cap, TVL cap, exit fee, fee recipient (re-assertion of the deployed values)
//   4 migrate-eligibility-<B>    registry.migrateEligibility for one basket (atomic: one call per basket, PROTO then AGENT then RWA)
//   5 router-weights             router.setDefaultWeights
//   6 unpause-<B>                unpause of one basket vault
//   7 update-delay, batch, cancel   updateDelay; one scheduleBatch round that proves batch scheduling; a schedule then a cancel
// A step the sheet does not ask for (no agents, a basket that is not eligible, a vault that stays paused) is recorded as skipped.
// Whether a vault is unpaused, and which baskets become eligible, is sheet data (GOVERN_UNPAUSE_VAULTS, GOVERN_ELIGIBLE_VAULTS).
// This module decides nothing about pause semantics.
// The wait is the timelock's real delay. On a Twin fork (chain id is not 8453 and the RPC answers anvil_nodeInfo) it runs by time warp to one second past
// the ready time. On 8453 there is no warp and no long sleep: the run exits GOVERN_PENDING with the ready time and the exact next command, and the same
// --row resumes the round.
import { encodeFunctionData, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { BASE_CHAIN_ID, httpRpc, isTwinFork, warpBy } from "./rehearsal/twin.ts";
import { readManifestField, saveRunManifest, type RunContext, type RunManifest } from "./runner.ts";
import { VAULT_KEYS, VAULT_NAME, type Sheet, type VaultKey } from "./sheet.ts";
import { VAULT_STAGES, manifestRef, type StageRow } from "./stages.ts";
import {
  cancelOnTimelock, connectSafe, executeOnTimelock, executeTx, operationId, operationState, scheduleOnTimelock, signTx, timelockMinDelay,
  updateTimelockDelay, verifyTimelockEffect, type Signer, type SafeHandle, type SafeTxBundle, type TimelockCall,
} from "./safe/index.ts";

export const GOV_ABI = parseAbi([
  "function setVotingPower(address voter, uint256 power)",
  "function setQuorumThreshold(uint256 threshold)",
  "function setVotingPeriod(uint64 period)",
  "function setExecutionDelay(uint64 delay)",
  "function votingPower(address voter) view returns (uint256)",
  "function quorumThreshold() view returns (uint256)",
  "function votingPeriod() view returns (uint64)",
  "function executionDelay() view returns (uint64)",
]);
export const VAULT_ABI = parseAbi([
  "function setTvlCap(uint256 newCap)",
  "function setPerDepositCap(uint256 newCap)",
  "function setExitFeeBps(uint256 newBps)",
  "function setFeeRecipient(address newRecipient)",
  "function unpause()",
  "function paused() view returns (bool)",
  "function tvlCap() view returns (uint256)",
  "function perDepositCap() view returns (uint256)",
  "function exitFeeBps() view returns (uint256)",
  "function feeRecipient() view returns (address)",
]);
export const GATEWAY_ABI = parseAbi([
  "function authorizeAgent(address agent, (bool active, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver, address[] allowedDestinations, address assetRecipient, uint256 maxWithdrawPerPayment, uint256 maxWithdrawPerWindow, address[] allowedSourceVaults) p)",
  "function agents(address) view returns (bool active, uint64 validUntil, uint256 maxPerPayment, uint256 maxPerWindow, address shareReceiver, address assetRecipient, uint256 maxWithdrawPerPayment, uint256 maxWithdrawPerWindow)",
]);
export const REGISTRY_ABI = parseAbi([
  "function migrateEligibility(address vault, bool eligible, address[] defaultVaults, uint256[] defaultBps)",
  "function isRouterEligible(address vault) view returns (bool)",
]);
export const ROUTER_ABI = parseAbi([
  "function setDefaultWeights(address[] vaults, uint256[] bps)",
  "function defaultWeightsLength() view returns (uint256)",
]);
const TL_ABI = parseAbi(["function updateDelay(uint256 newDelay)"]);

export interface GovernAddrs {
  timelock: Address; safe: Address; router: Address; registry: Address; gateway: Address; governance: Address;
  vaults: Record<VaultKey, Address>;
}

export function loadGovernAddrs(ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">): GovernAddrs {
  const r = (ref: string) => readManifestField(ctx, ref) as Address;
  return {
    timelock: r(manifestRef("timelock", "timelock")), safe: r(manifestRef("safe", "safe")), router: r(manifestRef("router", "router")), registry: r(manifestRef("registry", "registry")),
    gateway: r(manifestRef("gateway", "gateway")), governance: r(manifestRef("governance", "governance")),
    vaults: Object.fromEntries(VAULT_STAGES.map((v) => [v.key, r(manifestRef(v.stage, "vault"))])) as Record<VaultKey, Address>,
  };
}

export interface LabelledCall extends TimelockCall { label: string }

/** The govern rows in run order. One row is one round: schedule, wait for the real delay, execute, read back. `--row` takes the 1-based number or the name. */
export const BASKET_KEYS = ["PROTO", "AGENT", "RWA"] as const satisfies readonly VaultKey[];
export const GOVERN_ROWS = [
  "voting-power-quorum", "agents", "other-setters",
  "migrate-eligibility-PROTO", "migrate-eligibility-AGENT", "migrate-eligibility-RWA",
  "router-weights",
  "unpause-PROTO", "unpause-AGENT", "unpause-RWA",
  "update-delay", "batch", "cancel",
] as const;
export type GovernRowName = (typeof GOVERN_ROWS)[number];
export const governRowNames = (): readonly string[] => GOVERN_ROWS;

/** `--row` value to a row name: a 1-based number or a name. Anything else is a usage error. */
export function resolveGovernRow(row: string): GovernRowName {
  if (/^[0-9]+$/.test(row)) {
    const n = Number(row);
    const name = GOVERN_ROWS[n - 1];
    if (name === undefined) throw new PublishError("USAGE", `--row ${row}: there are ${GOVERN_ROWS.length} govern rows (1 to ${GOVERN_ROWS.length})`);
    return name;
  }
  if ((GOVERN_ROWS as readonly string[]).includes(row)) return row as GovernRowName;
  throw new PublishError("USAGE", `unknown govern row '${row}' (${GOVERN_ROWS.join(", ")}, or 1 to ${GOVERN_ROWS.length})`);
}

/** The baskets the sheet makes eligible, in migration order (PROTO, AGENT, RWA). The default-weight vector grows in this order. */
export const eligibleInOrder = (sheet: Sheet): VaultKey[] => BASKET_KEYS.filter((k) => sheet.govern.eligibleVaults.includes(k));

/** The default-weight vector after step i of the eligibility migration (i indexes eligibleInOrder). The last step is exactly the sheet's weights. */
export function migrationVector(sheet: Sheet, a: GovernAddrs, step: number): { vaults: Address[]; bps: bigint[] } {
  const eligible = eligibleInOrder(sheet);
  const order: VaultKey[] = ["USDC", ...eligible];
  const keys = order.slice(0, step + 2);
  const w = new Map(sheet.govern.weights.map((x) => [x.key, x.bps]));
  const final = keys.map((k) => w.get(k) ?? 0);
  const isLast = step === eligible.length - 1;
  let bps = final;
  if (!isLast) {
    const sum = final.reduce((x, y) => x + y, 0);
    bps = sum === 0 ? keys.map((_, i) => Math.floor(10000 / keys.length) + (i === 0 ? 10000 % keys.length : 0)) : final.map((x) => Math.floor((x * 10000) / sum));
    bps[0] = bps[0]! + (10000 - bps.reduce((x, y) => x + y, 0));
  }
  return { vaults: keys.map((k) => a.vaults[k]), bps: bps.map(BigInt) };
}

const feeRecipientOf = (sheet: Sheet, a: GovernAddrs): Address => (sheet.feeRecipient === "@safe" ? a.safe : sheet.feeRecipient) as Address;

/**
 * The calls of one ordered step (rows 1 to 10). Empty means the sheet asks for nothing in this step: the row is skipped.
 * update-delay, batch and cancel are built in runGovern: they depend on the timelock's delay at that point of the run.
 */
export function buildStepCalls(sheet: Sheet, a: GovernAddrs, row: GovernRowName): LabelledCall[] {
  const calls: LabelledCall[] = [];
  const add = (label: string, target: Address, data: Hex) => calls.push({ label, target, data });
  if (row === "voting-power-quorum") {
    for (const v of sheet.voters) add(`governance.setVotingPower(${v})`, a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setVotingPower", args: [v, sheet.voterPower] }));
    add("governance.setQuorumThreshold", a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setQuorumThreshold", args: [sheet.quorum] }));
    add("governance.setVotingPeriod", a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setVotingPeriod", args: [sheet.votingPeriod] }));
    add("governance.setExecutionDelay", a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setExecutionDelay", args: [sheet.executionDelay] }));
  } else if (row === "agents") {
    const p = sheet.agentPolicy;
    for (const agent of sheet.govern.agents) {
      add(`gateway.authorizeAgent(${agent})`, a.gateway, encodeFunctionData({
        abi: GATEWAY_ABI, functionName: "authorizeAgent",
        args: [agent, { active: true, validUntil: p.validUntil, maxPerPayment: p.maxPerPayment, maxPerWindow: p.maxPerWindow, shareReceiver: sheet.shareReceiver,
          allowedDestinations: [a.vaults.USDC], assetRecipient: sheet.shareReceiver, maxWithdrawPerPayment: p.maxWithdrawPerPayment, maxWithdrawPerWindow: p.maxWithdrawPerWindow, allowedSourceVaults: [a.vaults.USDC] }],
      }));
    }
  } else if (row === "other-setters") {
    const feeRecipient = feeRecipientOf(sheet, a);
    for (const k of VAULT_KEYS) {
      const v = sheet.vaults[k], t = a.vaults[k], n = VAULT_NAME[k];
      add(`${n}.setPerDepositCap`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setPerDepositCap", args: [v.perDepositCap] }));
      add(`${n}.setTvlCap`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setTvlCap", args: [v.tvlCap] }));
      add(`${n}.setExitFeeBps`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setExitFeeBps", args: [v.exitFeeBps] }));
      add(`${n}.setFeeRecipient`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setFeeRecipient", args: [feeRecipient] }));
    }
  } else if (row.startsWith("migrate-eligibility-")) {
    const k = row.slice("migrate-eligibility-".length) as VaultKey;
    const i = eligibleInOrder(sheet).indexOf(k);
    if (i >= 0) {
      const m = migrationVector(sheet, a, i);
      add(`registry.migrateEligibility(${VAULT_NAME[k]})`, a.registry, encodeFunctionData({ abi: REGISTRY_ABI, functionName: "migrateEligibility", args: [a.vaults[k], true, m.vaults, m.bps] }));
    }
  } else if (row === "router-weights") {
    const all: VaultKey[] = ["USDC", ...eligibleInOrder(sheet)];
    const w = new Map(sheet.govern.weights.map((x) => [x.key, x.bps]));
    add("router.setDefaultWeights", a.router, encodeFunctionData({ abi: ROUTER_ABI, functionName: "setDefaultWeights", args: [all.map((k) => a.vaults[k]), all.map((k) => BigInt(w.get(k)!))] }));
  } else if (row.startsWith("unpause-")) {
    const k = row.slice("unpause-".length) as VaultKey;
    if (sheet.govern.unpauseVaults.includes(k)) add(`${VAULT_NAME[k]}.unpause`, a.vaults[k], encodeFunctionData({ abi: VAULT_ABI, functionName: "unpause" }));
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
  /** Run one row (one round) only, by number or name. Earlier rows must be done first. */
  row?: string;
  /** Where a row line goes. Default: stdout (console.log). */
  emit?: (line: string) => void;
}

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

/** The exact command that resumes a pending round. Arguments that carry no secret are spelled out, the rest are the same as this run's. */
export function resumeCommand(ctx: Pick<RunContext, "chainId" | "coreSha">, row: string): string {
  return `bun publish-contracts/src/cli.ts govern --row ${row} --chain ${ctx.chainId} --core-sha ${ctx.coreSha} (plus the same --rpc, --sheet, --signer, --environment and --owner-signer arguments as this run)`;
}

async function waitReady(ctx: RunContext, o: GovernOpts, api: GovernApi, handle: SafeHandle, timelock: Address, id: Hex, row: string): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWait = ctx.chainId === BASE_CHAIN_ID ? Math.min(o.maxWaitSeconds ?? 3600, 3600) : (o.maxWaitSeconds ?? 3600);
  for (;;) {
    const st = await api.operationState(handle, timelock, id);
    if (st.ready || st.done) return;
    if (!st.pending) throw new PublishError("GOVERN", `operation ${id} (${row}) is not pending: it was cancelled or never scheduled`, { id });
    const remaining = Number(st.readyAt - (await chainTime(handle)));
    const warp = remaining > 0 ? await warpFor(ctx, o) : undefined;
    if (warp) {
      const seconds = remaining + 1;
      await warp(BigInt(seconds));
      ctx.log.log("info", "govern.warped", { row, seconds });
      continue;
    }
    if (remaining > maxWait) {
      const next = resumeCommand(ctx, row);
      throw new PublishError("GOVERN_PENDING", `govern row ${row} is scheduled and becomes ready at ${st.readyAt} (${new Date(Number(st.readyAt) * 1000).toISOString()}, in about ${remaining} s). After that time run: ${next}`, { id, row, ready_at: st.readyAt.toString(), remaining, next_command: next });
    }
    ctx.log.log("info", "govern.waiting", { row, remaining_s: remaining });
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

/** Read-back of one ordered step: the problems found on chain after the round executed. An empty list is a pass. */
export async function readBackStep(handle: SafeHandle, sheet: Sheet, a: GovernAddrs, row: GovernRowName): Promise<string[]> {
  const bad: string[] = [];
  const rd = reader(handle);
  if (row === "voting-power-quorum") {
    for (const v of sheet.voters) if ((await rd<bigint>(a.governance, GOV_ABI, "votingPower", [v])) !== sheet.voterPower) bad.push(`votingPower(${v})`);
    if ((await rd<bigint>(a.governance, GOV_ABI, "quorumThreshold")) !== sheet.quorum) bad.push("quorumThreshold");
    if (BigInt(await rd<bigint>(a.governance, GOV_ABI, "votingPeriod")) !== BigInt(sheet.votingPeriod)) bad.push("votingPeriod");
    if (BigInt(await rd<bigint>(a.governance, GOV_ABI, "executionDelay")) !== BigInt(sheet.executionDelay)) bad.push("executionDelay");
  } else if (row === "agents") {
    for (const agent of sheet.govern.agents) {
      const r = await rd<readonly unknown[]>(a.gateway, GATEWAY_ABI, "agents", [agent]);
      if (r[0] !== true) bad.push(`gateway.agents(${agent}).active`);
    }
  } else if (row === "other-setters") {
    const feeRecipient = feeRecipientOf(sheet, a).toLowerCase();
    for (const k of VAULT_KEYS) {
      const v = sheet.vaults[k], n = VAULT_NAME[k];
      if ((await rd<bigint>(a.vaults[k], VAULT_ABI, "tvlCap")) !== v.tvlCap) bad.push(`${n}.tvlCap`);
      if ((await rd<bigint>(a.vaults[k], VAULT_ABI, "perDepositCap")) !== v.perDepositCap) bad.push(`${n}.perDepositCap`);
      if ((await rd<bigint>(a.vaults[k], VAULT_ABI, "exitFeeBps")) !== v.exitFeeBps) bad.push(`${n}.exitFeeBps`);
      if ((await rd<string>(a.vaults[k], VAULT_ABI, "feeRecipient")).toLowerCase() !== feeRecipient) bad.push(`${n}.feeRecipient`);
    }
  } else if (row.startsWith("migrate-eligibility-")) {
    const k = row.slice("migrate-eligibility-".length) as VaultKey;
    if (!(await rd<boolean>(a.registry, REGISTRY_ABI, "isRouterEligible", [a.vaults[k]]))) bad.push(`registry.isRouterEligible(${VAULT_NAME[k]})`);
  } else if (row === "router-weights") {
    const want = BigInt(1 + eligibleInOrder(sheet).length);
    if ((await rd<bigint>(a.router, ROUTER_ABI, "defaultWeightsLength")) !== want) bad.push("router.defaultWeightsLength");
  } else if (row.startsWith("unpause-")) {
    const k = row.slice("unpause-".length) as VaultKey;
    if (await rd<boolean>(a.vaults[k], VAULT_ABI, "paused")) bad.push(`${VAULT_NAME[k]}.paused`);
  }
  return bad;
}

/** One round, ready to run: the operation, how to send each phase, and how to check the effect. */
interface RoundPlan {
  id: Hex;
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
  const a = loadGovernAddrs(ctx);
  const sheet = ctx.sheet;
  const handle = await api.connectSafe({ rpcUrl: ctx.rpc, chainId: ctx.chainId, safeAddress: a.safe, logger: ctx.log });
  if (handle.owners.map((x) => x.toLowerCase()).sort().join() !== sheet.safeOwners.map((x) => x.toLowerCase()).sort().join()) throw new PublishError("GOVERN", "the Safe's owners on chain differ from the sheet", {});
  ctx.log.log("info", "stage.start", { stage: row.name, safe: a.safe, timelock: a.timelock });
  const state = (manifest.govern ??= {}) as GovernState;
  const selected: GovernRowName | undefined = o.row === undefined ? undefined : resolveGovernRow(o.row);
  const salt = (name: string) => governSalt(ctx.coreSha, ctx.chainId, name);
  const note = (b: SafeTxBundle) => ({ tx_hash: b.executed?.tx_hash, safe_tx_hash: b.safe_tx_hash, status: b.executed?.status });
  const save = () => saveRunManifest(ctx.evidenceDir, manifest);
  const opIds: Record<string, Hex> = {};
  const ran: string[] = [];
  const skipped: string[] = [];

  /** The plan of a row, or a reason to skip it. */
  async function plan(name: GovernRowName): Promise<RoundPlan | string> {
    const orderedPlan = async (calls: LabelledCall[], saltName: string, readBack: () => Promise<string[]>, description: string): Promise<RoundPlan> => {
      const form = calls.length === 1 ? ("single" as const) : ("batch" as const);
      const p = { timelock: a.timelock, calls: calls.map(({ target, data }) => ({ target, data })), salt: salt(saltName), form };
      return {
        id: await api.operationId(handle, p), readBack, description,
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
    if (calls.length === 0) {
      if (name === "agents") return "the sheet registers no agents (GOVERN_AGENT_ADDRESSES is none)";
      if (name.startsWith("migrate-eligibility-")) return `${name.slice("migrate-eligibility-".length)} is not in GOVERN_ELIGIBLE_VAULTS`;
      if (name.startsWith("unpause-")) return `${name.slice("unpause-".length)} is not in GOVERN_UNPAUSE_VAULTS: it stays paused`;
      return "no calls";
    }
    return orderedPlan(calls, name, () => readBackStep(handle, sheet, a, name), `${calls.length} call(s)`);
  }

  async function round(name: GovernRowName, p: RoundPlan): Promise<void> {
    opIds[name] = p.id;
    const rec: RowRecord = state[name] ?? {};
    // phase 1: schedule (or, for a row whose operation is already on the timelock, adopt it)
    if (rec.scheduled) {
      ctx.log.log("info", "govern.phase_skipped", { row: name, phase: "scheduled" });
      emitPhase(o, name, "scheduled", rec.scheduled);
    } else {
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
      emitPhase(o, name, "scheduled", sched);
    }
    // phase 2: cancel (cancel row), or wait for the real delay and execute
    if (p.cancel) {
      if (rec.cancelled) { emitPhase(o, name, "cancelled", rec.cancelled); return; }
      let cancelled: PhaseRecord;
      if (!(await api.operationState(handle, a.timelock, p.id)).exists) cancelled = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled.ready_at, note: "already cancelled by an earlier run" };
      else cancelled = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled.ready_at, ...note(await signAndExecute(ctx, o, api, handle, await p.cancel())) };
      const bad = await p.readBack();
      if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back failed: ${bad.join(", ")}`, { bad });
      rec.cancelled = cancelled;
      save();
      emitPhase(o, name, "cancelled", rec.cancelled);
      return;
    }
    if (rec.executed) { emitPhase(o, name, "executed", rec.executed); return; }
    await waitReady(ctx, o, api, handle, a.timelock, p.id, name);
    let ex: PhaseRecord;
    if ((await api.operationState(handle, a.timelock, p.id)).done) {
      const bad = await p.readBack();
      if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back differs from the sheet: ${bad.join(", ")}`, { bad });
      ex = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled.ready_at, note: "already executed by an earlier run" };
    } else {
      const done = await signAndExecute(ctx, o, api, handle, await p.execute!());
      const eff = await api.verifyTimelockEffect(handle, done);
      if (!eff.ok) throw new PublishError("GOVERN", `govern row ${name} effect not observed: ${eff.detail}`);
      const bad = await p.readBack();
      if (bad.length) throw new PublishError("GOVERN", `govern row ${name} read-back differs from the sheet: ${bad.join(", ")}`, { bad });
      ex = { at: new Date().toISOString(), operation_id: p.id, ready_at: rec.scheduled.ready_at, ...note(done) };
    }
    rec.executed = ex;
    save();
    ctx.log.log("info", "govern.phase_done", { row: name, phase: "executed" });
    emitPhase(o, name, "executed", ex);
  }

  for (const name of GOVERN_ROWS) {
    if (selected !== undefined && selected !== name) continue;
    if (rowComplete(state[name])) {
      ctx.log.log("info", "govern.row_complete", { row: name });
      const r = state[name]!;
      if (r.scheduled) emitPhase(o, name, "scheduled", r.scheduled);
      if (r.executed) emitPhase(o, name, "executed", r.executed);
      if (r.cancelled) emitPhase(o, name, "cancelled", r.cancelled);
      continue;
    }
    // one round at a time, in order: a row starts only when every earlier row is complete
    const idx = GOVERN_ROWS.indexOf(name);
    const open = GOVERN_ROWS.slice(0, idx).find((n) => !rowComplete(state[n]));
    if (open) throw new PublishError("GOVERN", `govern row ${name} cannot start: row ${open} is not complete. Rows run one round at a time, in order. Run ${open} first.`, { row: name, blocked_by: open });
    const p = await plan(name);
    if (typeof p === "string") {
      state[name] = { skipped: { at: new Date().toISOString(), reason: p } };
      save();
      skipped.push(name);
      ctx.log.log("info", "govern.row_skipped", { row: name, reason: p });
      continue;
    }
    await round(name, p);
    ran.push(name);
    ctx.log.log("info", "govern.row_done", { row: name });
  }

  // a single-row run leaves the stage open: only a run that finds every row complete marks govern done
  if (GOVERN_ROWS.every((n) => rowComplete(state[n]))) {
    if (!manifest.stages[row.name] || manifest.stages[row.name]!.status !== "done") {
      manifest.stages[row.name] = { status: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: Object.keys(state).length };
    }
  }
  save();
  ctx.log.log("info", selected === undefined ? "stage.done" : "govern.row_run_done", { stage: row.name, row: selected });
  return { rows: ran, skipped, opIds };
}
