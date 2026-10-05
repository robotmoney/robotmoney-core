// Stage 13 govern: the post-handover matrix (runbook Q2) through the REAL Safe and the REAL timelock, with the Safe tool (src/safe).
// After the timelock stage the deployer holds no role. Everything here is a Safe transaction that schedules or executes a timelock operation.
//   Round 1 (one scheduleBatch, one executeBatch): voting power, quorum, voting period and execution delay, the vault setters,
//     agent registration, migrateEligibility per eligible basket, router default weights, unpause of the chosen vaults.
//   Round 2: updateDelay (schedule, wait, execute) and a schedule-then-cancel of a harmless operation.
// Whether a vault is unpaused, and which baskets become eligible, is sheet data (GOVERN_UNPAUSE_VAULTS, GOVERN_ELIGIBLE_VAULTS).
// This module decides nothing about pause semantics. The delay is the timelock's real delay: on 8453 each wait is 48 hours, so the
// run saves its state and exits with GOVERN_PENDING, and a later --resume continues.
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

/** The default-weight vector after step i of the eligibility migration. The last step is exactly the sheet's weights. */
export function migrationVector(sheet: Sheet, a: GovernAddrs, step: number): { vaults: Address[]; bps: bigint[] } {
  const order: VaultKey[] = ["USDC", ...sheet.govern.eligibleVaults];
  const keys = order.slice(0, step + 2);
  const w = new Map(sheet.govern.weights.map((x) => [x.key, x.bps]));
  const final = keys.map((k) => w.get(k) ?? 0);
  const isLast = step === sheet.govern.eligibleVaults.length - 1;
  let bps = final;
  if (!isLast) {
    const sum = final.reduce((x, y) => x + y, 0);
    bps = sum === 0 ? keys.map((_, i) => Math.floor(10000 / keys.length) + (i === 0 ? 10000 % keys.length : 0)) : final.map((x) => Math.floor((x * 10000) / sum));
    bps[0] = bps[0]! + (10000 - bps.reduce((x, y) => x + y, 0));
  }
  return { vaults: keys.map((k) => a.vaults[k]), bps: bps.map(BigInt) };
}

/** Round 1: every setter, registration, migration, weight and unpause in one scheduleBatch. */
export function buildRound1(sheet: Sheet, a: GovernAddrs): LabelledCall[] {
  const calls: LabelledCall[] = [];
  const add = (label: string, target: Address, data: Hex) => calls.push({ label, target, data });
  for (const v of sheet.voters) add(`governance.setVotingPower(${v})`, a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setVotingPower", args: [v, sheet.voterPower] }));
  add("governance.setQuorumThreshold", a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setQuorumThreshold", args: [sheet.quorum] }));
  add("governance.setVotingPeriod", a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setVotingPeriod", args: [sheet.votingPeriod] }));
  add("governance.setExecutionDelay", a.governance, encodeFunctionData({ abi: GOV_ABI, functionName: "setExecutionDelay", args: [sheet.executionDelay] }));
  const feeRecipient = (sheet.feeRecipient === "@safe" ? a.safe : sheet.feeRecipient) as Address;
  for (const k of VAULT_KEYS) {
    const v = sheet.vaults[k], t = a.vaults[k], n = VAULT_NAME[k];
    add(`${n}.setPerDepositCap`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setPerDepositCap", args: [v.perDepositCap] }));
    add(`${n}.setTvlCap`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setTvlCap", args: [v.tvlCap] }));
    add(`${n}.setExitFeeBps`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setExitFeeBps", args: [v.exitFeeBps] }));
    add(`${n}.setFeeRecipient`, t, encodeFunctionData({ abi: VAULT_ABI, functionName: "setFeeRecipient", args: [feeRecipient] }));
  }
  const p = sheet.agentPolicy;
  for (const agent of sheet.govern.agents) {
    add(`gateway.authorizeAgent(${agent})`, a.gateway, encodeFunctionData({
      abi: GATEWAY_ABI, functionName: "authorizeAgent",
      args: [agent, { active: true, validUntil: p.validUntil, maxPerPayment: p.maxPerPayment, maxPerWindow: p.maxPerWindow, shareReceiver: sheet.shareReceiver,
        allowedDestinations: [a.vaults.USDC], assetRecipient: sheet.shareReceiver, maxWithdrawPerPayment: p.maxWithdrawPerPayment, maxWithdrawPerWindow: p.maxWithdrawPerWindow, allowedSourceVaults: [a.vaults.USDC] }],
    }));
  }
  sheet.govern.eligibleVaults.forEach((k, i) => {
    const m = migrationVector(sheet, a, i);
    add(`registry.migrateEligibility(${VAULT_NAME[k]})`, a.registry, encodeFunctionData({ abi: REGISTRY_ABI, functionName: "migrateEligibility", args: [a.vaults[k], true, m.vaults, m.bps] }));
  });
  const all: VaultKey[] = ["USDC", ...sheet.govern.eligibleVaults];
  const w = new Map(sheet.govern.weights.map((x) => [x.key, x.bps]));
  add("router.setDefaultWeights", a.router, encodeFunctionData({ abi: ROUTER_ABI, functionName: "setDefaultWeights", args: [all.map((k) => a.vaults[k]), all.map((k) => BigInt(w.get(k)!))] }));
  for (const k of sheet.govern.unpauseVaults) add(`${VAULT_NAME[k]}.unpause`, a.vaults[k], encodeFunctionData({ abi: VAULT_ABI, functionName: "unpause" }));
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

/** The govern rows in run order. A row is one Safe transaction (or one wait-then-send pair) and is a resumable step. `--row` takes the 1-based number or the name. */
export const GOVERN_ROWS = ["round1.schedule", "round1.execute", "round2.cancel.schedule", "round2.cancel.cancel", "round2.updateDelay.schedule", "round2.updateDelay.execute"] as const;
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

/** One stdout line of the govern run, the contract core's harness parses: {"row":"..","txHash":"0x..","status":1}. */
export interface GovernRowLine { row: string; txHash: string; status: 0 | 1 }

export interface GovernOpts {
  ownerSigners: Signer[];
  /** Pays gas for execTransaction. Holds no role. */
  sender: Signer;
  api?: GovernApi;
  /** Longest wait this process accepts for a timelock delay, in seconds. Longer: save state and exit GOVERN_PENDING. */
  maxWaitSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /**
   * Moves chain time forward by this many seconds. Default: on a Twin fork only (eth_chainId is not 8453 and the RPC answers anvil_nodeInfo)
   * the anvil time warp, so the 48 hour waits run in seconds. On Base mainnet there is no warp: the run waits or exits GOVERN_PENDING.
   * `false` turns the warp off (tests with a stub chain).
   */
  warp?: ((seconds: bigint) => Promise<void>) | false;
  /** Run one row only (number or name). Other rows are neither run nor recorded. */
  row?: string;
  /** Where a row line goes. Default: stdout (console.log). */
  emit?: (line: string) => void;
}

interface StepRecord { tx_hash?: string; safe_tx_hash?: string; status?: number; at: string; [k: string]: unknown }
type GovernState = Record<string, StepRecord | Record<string, unknown>>;

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
  if (o.warp === false) return undefined;
  if (o.warp) return o.warp;
  if (ctx.chainId === BASE_CHAIN_ID) return undefined;
  const rpc = httpRpc(ctx.rpc);
  let twin = detected.get(ctx);
  if (twin === undefined) { twin = await isTwinFork(rpc); detected.set(ctx, twin); }
  return twin ? async (s) => { await warpBy(rpc, s); } : undefined;
}
const detected = new WeakMap<object, boolean>();

async function waitReady(ctx: RunContext, o: GovernOpts, api: GovernApi, handle: SafeHandle, timelock: Address, id: Hex, label: string): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const st = await api.operationState(handle, timelock, id);
    if (st.ready || st.done) return;
    if (!st.pending) throw new PublishError("GOVERN", `operation ${id} (${label}) is not pending: it was cancelled or never scheduled`, { id });
    const remaining = Number(st.readyAt - (await chainTime(handle)));
    const warp = remaining > 0 ? await warpFor(ctx, o) : undefined;
    if (warp) {
      const seconds = remaining + 1;
      await warp(BigInt(seconds));
      ctx.log.log("info", "govern.warped", { label, seconds });
      continue;
    }
    if (remaining > (o.maxWaitSeconds ?? 3600)) {
      throw new PublishError("GOVERN_PENDING", `${label} is scheduled and becomes ready at ${st.readyAt} (in about ${remaining} s). Run again with --resume --stage govern after that time.`, { id, ready_at: st.readyAt.toString(), remaining });
    }
    ctx.log.log("info", "govern.waiting", { label, remaining_s: remaining });
    await sleep(o.pollMs ?? 5000);
  }
}

/** Prints the row line of a step that sent a Safe transaction. A step with no transaction of its own (adopted from an earlier run) prints none. */
function emitRow(o: GovernOpts, key: string, rec: StepRecord): void {
  if (!rec.tx_hash) return;
  // executeTx throws on a reverted receipt, so a recorded transaction (even one from an earlier run) has status 1 unless the record says otherwise
  const line: GovernRowLine = { row: key, txHash: rec.tx_hash, status: rec.status === 0 ? 0 : 1 };
  (o.emit ?? ((l: string) => console.log(l)))(JSON.stringify(line));
}

/** Runs one step once: a recorded step is skipped on resume. A row line goes to stdout either way. With --row, other steps do nothing. */
async function step(ctx: RunContext, o: GovernOpts, manifest: RunManifest, key: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  if (!isSelected(o, key)) { ctx.log.log("info", "govern.row_not_selected", { step: key, selected: o.row }); return; }
  const st = (manifest.govern ??= {}) as GovernState;
  if (st[key]) { ctx.log.log("info", "govern.step_skipped", { step: key }); emitRow(o, key, st[key] as StepRecord); return; }
  const out = await fn();
  st[key] = { at: new Date().toISOString(), ...out };
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "govern.step_done", { step: key });
  emitRow(o, key, st[key] as StepRecord);
}

const isSelected = (o: GovernOpts, key: string): boolean => o.row === undefined || resolveGovernRow(o.row) === key;

export async function readBackRound1(handle: SafeHandle, sheet: Sheet, a: GovernAddrs): Promise<string[]> {
  const bad: string[] = [];
  const rd = <T,>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
    handle.client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never }) as Promise<T>;
  for (const v of sheet.voters) if ((await rd<bigint>(a.governance, GOV_ABI, "votingPower", [v])) !== sheet.voterPower) bad.push(`votingPower(${v})`);
  if ((await rd<bigint>(a.governance, GOV_ABI, "quorumThreshold")) !== sheet.quorum) bad.push("quorumThreshold");
  for (const k of VAULT_KEYS) {
    const v = sheet.vaults[k];
    if ((await rd<bigint>(a.vaults[k], VAULT_ABI, "tvlCap")) !== v.tvlCap) bad.push(`${VAULT_NAME[k]}.tvlCap`);
    if ((await rd<bigint>(a.vaults[k], VAULT_ABI, "perDepositCap")) !== v.perDepositCap) bad.push(`${VAULT_NAME[k]}.perDepositCap`);
    if ((await rd<bigint>(a.vaults[k], VAULT_ABI, "exitFeeBps")) !== v.exitFeeBps) bad.push(`${VAULT_NAME[k]}.exitFeeBps`);
  }
  for (const k of sheet.govern.eligibleVaults) if (!(await rd<boolean>(a.registry, REGISTRY_ABI, "isRouterEligible", [a.vaults[k]]))) bad.push(`registry.isRouterEligible(${VAULT_NAME[k]})`);
  for (const k of sheet.govern.unpauseVaults) if (await rd<boolean>(a.vaults[k], VAULT_ABI, "paused")) bad.push(`${VAULT_NAME[k]}.paused`);
  return bad;
}

export interface GovernResult { round1: string[]; opIds: Record<string, Hex> }

export async function runGovern(ctx: RunContext, row: StageRow, manifest: RunManifest, o: GovernOpts): Promise<GovernResult> {
  const api = o.api ?? realGovernApi;
  const a = loadGovernAddrs(ctx);
  const sheet = ctx.sheet;
  const handle = await api.connectSafe({ rpcUrl: ctx.rpc, chainId: ctx.chainId, safeAddress: a.safe, logger: ctx.log });
  if (handle.owners.map((x) => x.toLowerCase()).sort().join() !== sheet.safeOwners.map((x) => x.toLowerCase()).sort().join()) throw new PublishError("GOVERN", "the Safe's owners on chain differ from the sheet", {});
  ctx.log.log("info", "stage.start", { stage: row.name, safe: a.safe, timelock: a.timelock });
  const minDelay = await api.timelockMinDelay(handle, a.timelock);
  const opIds: Record<string, Hex> = {};
  const salt = (l: string) => governSalt(ctx.coreSha, ctx.chainId, l);
  const bundleNote = (bundle: SafeTxBundle) => ({ tx_hash: bundle.executed?.tx_hash, safe_tx_hash: bundle.safe_tx_hash, status: bundle.executed?.status });

  // ---- round 1: one scheduleBatch, one executeBatch --------------------------------------------------------------------------
  const labelled = buildRound1(sheet, a);
  const calls: TimelockCall[] = labelled.map(({ target, data }) => ({ target, data }));
  const r1 = { timelock: a.timelock, calls, salt: salt("round1") };
  opIds.round1 = await api.operationId(handle, r1);
  await step(ctx, o, manifest, "round1.schedule", async () => {
    if ((await api.operationState(handle, a.timelock, opIds.round1!)).exists) return { operation_id: opIds.round1, note: "already scheduled by an earlier run" };
    const b = await api.scheduleOnTimelock(handle, { ...r1, description: `round 1 (${labelled.length} calls): ${labelled.map((c) => c.label).join("; ")}` });
    return { operation_id: opIds.round1, calls: labelled.map((c) => c.label), ...bundleNote(await signAndExecute(ctx, o, api, handle, b)) };
  });
  if (isSelected(o, "round1.execute")) await waitReady(ctx, o, api, handle, a.timelock, opIds.round1, "round 1");
  await step(ctx, o, manifest, "round1.execute", async () => {
    if ((await api.operationState(handle, a.timelock, opIds.round1!)).done) {
      const bad = await readBackRound1(handle, sheet, a);
      if (bad.length) throw new PublishError("GOVERN", `round 1 read-back differs from the sheet: ${bad.join(", ")}`, { bad });
      return { operation_id: opIds.round1, note: "already executed by an earlier run" };
    }
    const b = await api.executeOnTimelock(handle, { ...r1, description: "round 1 execute" });
    const done = await signAndExecute(ctx, o, api, handle, b);
    const eff = await api.verifyTimelockEffect(handle, done);
    if (!eff.ok) throw new PublishError("GOVERN", `round 1 effect not observed: ${eff.detail}`);
    const bad = await readBackRound1(handle, sheet, a);
    if (bad.length) throw new PublishError("GOVERN", `round 1 read-back differs from the sheet: ${bad.join(", ")}`, { bad });
    return { operation_id: opIds.round1, ...bundleNote(done) };
  });

  // ---- round 2: cancel, then updateDelay ------------------------------------------------------------------------------------
  const noop: TimelockCall = { target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [minDelay] }) };
  const r2n = { timelock: a.timelock, calls: [noop], salt: salt("round2.cancel"), form: "single" as const };
  opIds.cancel = await api.operationId(handle, r2n);
  await step(ctx, o, manifest, "round2.cancel.schedule", async () => {
    if ((await api.operationState(handle, a.timelock, opIds.cancel!)).exists) return { operation_id: opIds.cancel, note: "already scheduled by an earlier run" };
    const b = await api.scheduleOnTimelock(handle, { ...r2n, description: "round 2: a no-op operation that the Safe cancels" });
    return { operation_id: opIds.cancel, ...bundleNote(await signAndExecute(ctx, o, api, handle, b)) };
  });
  await step(ctx, o, manifest, "round2.cancel.cancel", async () => {
    const b = await api.cancelOnTimelock(handle, { timelock: a.timelock, id: opIds.cancel!, description: "round 2: cancel the no-op" });
    const done = await signAndExecute(ctx, o, api, handle, b);
    const st = await api.operationState(handle, a.timelock, opIds.cancel!);
    if (st.pending || st.exists) throw new PublishError("GOVERN", "the cancelled operation is still on the timelock");
    return { operation_id: opIds.cancel, ...bundleNote(done) };
  });
  const newDelay = sheet.govern.newDelay;
  const delaySalt = salt("round2.updateDelay");
  const delayOp = await api.operationId(handle, { timelock: a.timelock, calls: [{ target: a.timelock, data: encodeFunctionData({ abi: TL_ABI, functionName: "updateDelay", args: [newDelay] }) }], salt: delaySalt, form: "single" });
  opIds.updateDelay = delayOp;
  await step(ctx, o, manifest, "round2.updateDelay.schedule", async () => {
    if ((await api.operationState(handle, a.timelock, delayOp)).exists) return { operation_id: delayOp, note: "already scheduled by an earlier run" };
    const b = await api.updateTimelockDelay(handle, { timelock: a.timelock, newDelay, phase: "schedule", salt: delaySalt, description: `round 2: updateDelay to ${newDelay}` });
    return { operation_id: delayOp, ...bundleNote(await signAndExecute(ctx, o, api, handle, b)) };
  });
  if (isSelected(o, "round2.updateDelay.execute")) await waitReady(ctx, o, api, handle, a.timelock, delayOp, "round 2 updateDelay");
  await step(ctx, o, manifest, "round2.updateDelay.execute", async () => {
    if ((await api.operationState(handle, a.timelock, delayOp)).done) return { operation_id: delayOp, note: "already executed by an earlier run" };
    const b = await api.updateTimelockDelay(handle, { timelock: a.timelock, newDelay, phase: "execute", salt: delaySalt, description: `round 2: execute updateDelay to ${newDelay}` });
    const done = await signAndExecute(ctx, o, api, handle, b);
    const now = await api.timelockMinDelay(handle, a.timelock);
    if (now !== newDelay) throw new PublishError("GOVERN", `getMinDelay is ${now} after updateDelay, want ${newDelay}`);
    return { operation_id: delayOp, ...bundleNote(done) };
  });

  // a single-row run leaves the stage open: only a full run marks govern done
  if (o.row === undefined) manifest.stages[row.name] = { status: "done", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: Object.keys(manifest.govern ?? {}).length };
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", o.row === undefined ? "stage.done" : "govern.row_done", { stage: row.name, row: o.row });
  return { round1: labelled.map((c) => c.label), opIds };
}
