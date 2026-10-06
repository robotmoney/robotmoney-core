// OpenZeppelin TimelockController helpers. Each builds a Safe transaction whose only target is the timelock (value 0, CALL).
// The Safe must already hold the role the entry point needs, the operation must be in the right state, and the delay must be sane,
// so a transaction that can only revert (or can brick the timelock) is refused before anyone signs.
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { sameAddress } from "./chain.ts";
import { MAX_SAFE_DELAY, MIN_SAFE_DELAY, TIMELOCK_ABI, ZERO_ADDRESS, ZERO_BYTES32, type TimelockRole } from "./constants.ts";
import { SafeToolError } from "./errors.ts";
import { delayFloor } from "../floors.ts";
import type { SafeHandle } from "./safe.ts";
import { proposeTx, type SafeTxBundle } from "./tx.ts";
import { keccak256, toBytes } from "viem";

export interface TimelockCall { target: Address; value?: bigint; data: Hex }

interface Common {
  timelock: Address;
  description?: string;
  out?: string;
}
interface Ordered extends Common {
  calls: TimelockCall[];
  predecessor?: Hex;
  /** A fresh 32-byte salt per operation. */
  salt: Hex;
  /** `batch` (default) uses scheduleBatch/executeBatch. `single` uses schedule/execute and needs exactly one call. */
  form?: "batch" | "single";
}
export interface ScheduleParams extends Ordered { delay?: bigint }
export type ExecuteParams = Ordered;
export interface CancelParams extends Common { id: Hex }
export interface UpdateDelayParams extends Common {
  newDelay: bigint;
  phase: "schedule" | "execute";
  salt: Hex;
  predecessor?: Hex;
  delay?: bigint;
  allowUnsafeDelay?: boolean;
}

const is32 = (h: string): boolean => /^0x[0-9a-fA-F]{64}$/.test(h);
export const roleId = (r: TimelockRole): Hex => keccak256(toBytes(r));

export async function timelockMinDelay(handle: SafeHandle, timelock: Address): Promise<bigint> {
  const code = await handle.client.getCode({ address: timelock });
  if (!code || code === "0x") throw new SafeToolError("TIMELOCK_INVALID", `no contract at the timelock address ${timelock}`);
  try { return await handle.client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getMinDelay" }); }
  catch { throw new SafeToolError("TIMELOCK_INVALID", `${timelock} does not answer getMinDelay(): not a timelock`); }
}

async function hasRole(handle: SafeHandle, timelock: Address, role: TimelockRole, who: Address): Promise<boolean> {
  return handle.client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "hasRole", args: [roleId(role), who] });
}

async function requireRole(handle: SafeHandle, timelock: Address, role: TimelockRole): Promise<void> {
  if (await hasRole(handle, timelock, role, handle.address)) return;
  if (role === "EXECUTOR_ROLE" && (await hasRole(handle, timelock, role, ZERO_ADDRESS))) return; // open executor
  throw new SafeToolError("TIMELOCK_ROLE_MISSING", role === "EXECUTOR_ROLE" ? "neither the Safe nor address(0) holds EXECUTOR_ROLE on the timelock" : `the Safe does not hold ${role} on the timelock`, { role });
}

function splitCalls(p: Ordered) {
  if (p.calls.length === 0) throw new SafeToolError("BAD_INPUT", "at least one call is required");
  if (p.form === "single" && p.calls.length !== 1) throw new SafeToolError("BAD_INPUT", "form single needs exactly one call");
  if (!is32(p.salt)) throw new SafeToolError("BAD_INPUT", "salt must be 0x + 32 bytes (a fresh salt per operation)");
  const predecessor = p.predecessor ?? ZERO_BYTES32;
  if (!is32(predecessor)) throw new SafeToolError("BAD_INPUT", "predecessor must be 32 bytes");
  return {
    single: p.form === "single",
    targets: p.calls.map((c) => getAddress(c.target)),
    values: p.calls.map((c) => c.value ?? 0n),
    datas: p.calls.map((c) => c.data),
    predecessor, salt: p.salt,
  };
}

/** The operation id the timelock itself computes for these calls (a pure call on the timelock). */
export async function operationId(handle: SafeHandle, p: Ordered): Promise<Hex> {
  const s = splitCalls(p);
  return s.single
    ? handle.client.readContract({ address: p.timelock, abi: TIMELOCK_ABI, functionName: "hashOperation", args: [s.targets[0]!, s.values[0]!, s.datas[0]!, s.predecessor, s.salt] })
    : handle.client.readContract({ address: p.timelock, abi: TIMELOCK_ABI, functionName: "hashOperationBatch", args: [s.targets, s.values, s.datas, s.predecessor, s.salt] });
}

export interface OperationState { exists: boolean; pending: boolean; ready: boolean; done: boolean; readyAt: bigint }
export async function operationState(handle: SafeHandle, timelock: Address, id: Hex): Promise<OperationState> {
  const r = (fn: "isOperation" | "isOperationPending" | "isOperationReady" | "isOperationDone") =>
    handle.client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: fn, args: [id] });
  const [exists, pending, ready, done, readyAt] = await Promise.all([r("isOperation"), r("isOperationPending"), r("isOperationReady"), r("isOperationDone"),
    handle.client.readContract({ address: timelock, abi: TIMELOCK_ABI, functionName: "getTimestamp", args: [id] })]);
  return { exists, pending, ready, done, readyAt };
}

async function propose(handle: SafeHandle, p: Common, action: string, data: Hex, id: Hex, minDelay: bigint): Promise<SafeTxBundle> {
  return proposeTx(handle, {
    to: p.timelock, data, action, description: p.description, timelock: p.timelock, timelockOperationId: id, timelockMinDelay: minDelay, out: p.out,
  });
}

/** Safe transaction that schedules an operation on the timelock. */
export async function scheduleOnTimelock(handle: SafeHandle, p: ScheduleParams): Promise<SafeTxBundle> {
  const timelock = getAddress(p.timelock);
  const minDelay = await timelockMinDelay(handle, timelock);
  const s = splitCalls(p);
  const delay = p.delay ?? minDelay;
  if (delay < minDelay) throw new SafeToolError("TIMELOCK_STATE", `delay ${delay} is below the timelock's minimum delay ${minDelay}`);
  await requireRole(handle, timelock, "PROPOSER_ROLE");
  const id = await operationId(handle, { ...p, timelock });
  if ((await operationState(handle, timelock, id)).exists) throw new SafeToolError("TIMELOCK_STATE", `operation ${id} already exists on the timelock; use a new salt`, { id });
  const data = s.single
    ? encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "schedule", args: [s.targets[0]!, s.values[0]!, s.datas[0]!, s.predecessor, s.salt, delay] })
    : encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "scheduleBatch", args: [s.targets, s.values, s.datas, s.predecessor, s.salt, delay] });
  return propose(handle, { ...p, timelock }, s.single ? "schedule" : "scheduleBatch", data, id, minDelay);
}

/** Safe transaction that executes a scheduled, ready operation. A not-yet-ready operation is warned about, not refused (the Safe tx reverts until then). */
export async function executeOnTimelock(handle: SafeHandle, p: ExecuteParams): Promise<SafeTxBundle> {
  const timelock = getAddress(p.timelock);
  const minDelay = await timelockMinDelay(handle, timelock);
  const s = splitCalls(p);
  await requireRole(handle, timelock, "EXECUTOR_ROLE");
  const id = await operationId(handle, { ...p, timelock });
  const st = await operationState(handle, timelock, id);
  if (!st.pending) throw new SafeToolError("TIMELOCK_STATE", `operation ${id} is not scheduled (or already done): nothing to execute`, { id });
  if (!st.ready) handle.logger.log("warn", "timelock.not_ready", { id, ready_at: st.readyAt.toString(), note: "the Safe transaction reverts until then" });
  const data = s.single
    ? encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "execute", args: [s.targets[0]!, s.values[0]!, s.datas[0]!, s.predecessor, s.salt] })
    : encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "executeBatch", args: [s.targets, s.values, s.datas, s.predecessor, s.salt] });
  return propose(handle, { ...p, timelock }, s.single ? "execute" : "executeBatch", data, id, minDelay);
}

/** Safe transaction that cancels a pending operation. */
export async function cancelOnTimelock(handle: SafeHandle, p: CancelParams): Promise<SafeTxBundle> {
  const timelock = getAddress(p.timelock);
  const minDelay = await timelockMinDelay(handle, timelock);
  if (!is32(p.id)) throw new SafeToolError("BAD_INPUT", "id must be the 32-byte operation id");
  await requireRole(handle, timelock, "CANCELLER_ROLE");
  if (!(await operationState(handle, timelock, p.id)).pending) throw new SafeToolError("TIMELOCK_STATE", `operation ${p.id} is not pending: nothing to cancel`, { id: p.id });
  return propose(handle, { ...p, timelock }, "cancel", encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "cancel", args: [p.id] }), p.id, minDelay);
}

/** updateDelay is called by the timelock itself, so it goes through schedule (phase one) then execute (phase two). Bounded to 1 hour to 30 days. */
export async function updateTimelockDelay(handle: SafeHandle, p: UpdateDelayParams): Promise<SafeTxBundle> {
  if (p.newDelay < 0n) throw new SafeToolError("BAD_INPUT", "newDelay must not be negative");
  // Bounds no flag lifts, allowUnsafeDelay included: the chain-keyed floor (172800 s on 8453, at least 1 s elsewhere) and the 30 day ceiling.
  const chainId = handle.chain.chainId;
  const floor = BigInt(delayFloor(chainId));
  if (p.newDelay < floor) {
    throw new SafeToolError("UNSAFE_DELAY", `newDelay ${p.newDelay} is below the ${floor} second floor on chain ${chainId}. No flag lifts this floor.`, { newDelay: p.newDelay.toString(), floor: floor.toString() });
  }
  if (p.newDelay > MAX_SAFE_DELAY) {
    throw new SafeToolError("UNSAFE_DELAY", `newDelay ${p.newDelay} is above the ${MAX_SAFE_DELAY} second ceiling (30 days). No flag lifts this ceiling: a delay that long can lock the timelock for good.`, { newDelay: p.newDelay.toString(), ceiling: MAX_SAFE_DELAY.toString() });
  }
  if ((p.newDelay < MIN_SAFE_DELAY || p.newDelay > MAX_SAFE_DELAY) && !p.allowUnsafeDelay) {
    throw new SafeToolError("UNSAFE_DELAY", `newDelay ${p.newDelay} is outside 1 hour to 30 days (${MIN_SAFE_DELAY} to ${MAX_SAFE_DELAY} seconds). A wrong delay can lock the timelock for good.`, { newDelay: p.newDelay.toString() });
  }
  if (p.allowUnsafeDelay && (p.newDelay < MIN_SAFE_DELAY || p.newDelay > MAX_SAFE_DELAY)) handle.logger.log("warn", "timelock.unsafe_delay_allowed", { new_delay: p.newDelay.toString() });
  const timelock = getAddress(p.timelock);
  const inner = encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "updateDelay", args: [p.newDelay] });
  const common = { timelock, calls: [{ target: timelock, data: inner }], salt: p.salt, predecessor: p.predecessor, form: "single" as const, description: p.description, out: p.out };
  const b = p.phase === "schedule" ? await scheduleOnTimelock(handle, { ...common, delay: p.delay }) : await executeOnTimelock(handle, common);
  return { ...b, action: `updateDelay-${p.phase}` };
}

export interface TimelockEffect { ok: boolean; detail: string; state: OperationState }

/** After the Safe transaction executed: reads the timelock back and confirms the effect the bundle's action promised. */
export async function verifyTimelockEffect(handle: SafeHandle, b: SafeTxBundle): Promise<TimelockEffect> {
  if (!b.timelock || !b.timelock_operation_id) throw new SafeToolError("BUNDLE_INVALID", "not a timelock bundle");
  const state = await operationState(handle, b.timelock, b.timelock_operation_id);
  const id = b.timelock_operation_id;
  const a = b.action;
  let ok: boolean, detail: string;
  if (a.startsWith("schedule") || a === "updateDelay-schedule") { ok = state.pending; detail = ok ? `operation ${id} is pending, ready at unix time ${state.readyAt}` : `operation ${id} is not pending after the Safe transaction`; }
  else if (a === "cancel") { ok = !state.exists; detail = ok ? `operation ${id} no longer exists (cancelled)` : `operation ${id} still exists after cancel`; }
  else { ok = state.done; detail = ok ? `operation ${id} is done` : `operation ${id} is not done after the Safe transaction`; }
  handle.logger.log(ok ? "info" : "error", "timelock.effect", { id, action: a, ok, detail });
  if (!ok) throw new SafeToolError("EFFECT_NOT_OBSERVED", detail, { id, action: a });
  return { ok, detail, state };
}

export { sameAddress };
