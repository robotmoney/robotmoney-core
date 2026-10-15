// Issue 1811 (upgradeability stage 4): the evidence of the Twin upgrade rehearsal, and its check. The rehearsal (src/ci/twin-upgrade-lifecycle.ts) deploys the release
// artifacts UPGRADE_MODE=upgradeable, upgrades the gateway proxy to a second copy of the release implementation through the real Safe and timelock, queues a
// second gateway upgrade, freezes every core proxy through the Safe and timelock, and shows the queued upgrade is refused after the freeze (UpgradesAreFrozen).
// The record (`upgrade-lifecycle.json`) carries the verifier's upgradeability record after each step and the transactions of each timelock operation.
// Offline: the steps tell one story (deploy upgradeable, one upgrade of the gateway only, the freeze targets are the reviewed record, the final record claims
// core immutability). Online (--rpc): every transaction is read back (CallScheduled and CallExecuted of the recorded operation, Upgraded and UpgradesFrozen from
// each proxy, the schedule-to-execute gap), the refused operation is still pending and ready and a simulated execute from the Safe reverts with UpgradesAreFrozen
// now, and every proxy fact of the final record is read back (evidence-upgradeability.ts).
// Canonical: docs/technical/contract-upgradeability-plan.md (Delivery sequence, step 4), docs/operations/contract-release-runbooks.md 4.12.
import { decodeEventLog, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { upgradeabilityEvidenceProblems, upgradeabilityOnChainProblems, type UpgradeabilityChain } from "./evidence-upgradeability.ts";

export const LIFECYCLE_KIND = "twin-upgrade-lifecycle";
/** The proxy the rehearsal upgrades: the gateway, the one proxy every signing client pins (issue 1810). */
export const UPGRADED_PROXY = "gateway";

export const GOVERNED_UUPS_ABI = parseAbi([
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)",
  "event Upgraded(address indexed implementation)",
  "event UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash)",
  "error UpgradesAreFrozen()",
  "error NotUpgradeTimelock(address caller)",
  "error FreezeTargetMismatch(address liveImplementation, bytes32 liveCodeHash)",
]);
const LIFECYCLE_TIMELOCK_ABI = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
]);
/** The 4-byte selector of GovernedUpgrade.UpgradesAreFrozen(). */
export const UPGRADES_ARE_FROZEN_SELECTOR: Hex = keccak256(new TextEncoder().encode("UpgradesAreFrozen()")).slice(0, 10) as Hex;
const ZERO32: Hex = `0x${"0".repeat(64)}`;

export const upgradeCalldata = (impl: string): Hex => encodeFunctionData({ abi: GOVERNED_UUPS_ABI, functionName: "upgradeToAndCall", args: [impl as Hex, "0x"] });
export const freezeCalldata = (impl: string, codeHash: string): Hex => encodeFunctionData({ abi: GOVERNED_UUPS_ABI, functionName: "freezeUpgrades", args: [impl as Hex, codeHash as Hex] });
/** The timelock `execute` of a single-call operation (no predecessor), as the Safe would send it. */
export const executeCalldata = (target: string, data: string, salt: string): Hex =>
  encodeFunctionData({ abi: LIFECYCLE_TIMELOCK_ABI, functionName: "execute", args: [target as Hex, 0n, data as Hex, ZERO32, salt as Hex] });

/** One proxy's freeze target, from the reviewed upgradeability record. */
export interface FreezeTarget { proxy: string; implementation: string; implementation_code_hash: string }

/** The record the rehearsal writes. Each `upgradeability` is the verifier's upgradeability.json after that step. */
export interface UpgradeLifecycleRecord {
  kind: typeof LIFECYCLE_KIND;
  chain_id: number;
  core_sha: string;
  safe: string;
  timelock: { address: string; min_delay: string };
  deploy: { upgradeability: any };
  upgrade: {
    proxy: string; proxy_address: string; from_implementation: string; to_implementation: string; to_code_hash: string;
    deploy_tx: string; operation_id: string; salt: string; schedule_tx: string; execute_tx: string; upgradeability: any;
  };
  rejected_upgrade: {
    proxy: string; proxy_address: string; target_implementation: string; operation_id: string; salt: string; schedule_tx: string;
    /** The Safe tool's refusal when the Safe was asked to execute the operation after the freeze (nothing was sent). */
    safe_tool_refusal: string;
    revert_selector: string; revert_error: string;
  };
  freeze: { operation_id: string; salt: string; schedule_tx: string; execute_tx: string; targets: Record<string, FreezeTarget> };
  final: { upgradeability: any; verifier_exit_code: number };
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (x: unknown): string => String(x ?? "").toLowerCase();

/** The proxies of a verifier record, by verifier name (`gateway`, `vault[rmUSDC]`, ...). */
const proxiesOf = (u: any): Record<string, any> => (u && typeof u.proxies === "object" && u.proxies) || {};

/** Offline problems of a lifecycle record. `proxies` is the full proxied core set of the stage table (verifier names). */
export function upgradeLifecycleProblems(r: any, proxies: readonly string[]): string[] {
  const p: string[] = [];
  const bad = (m: string) => p.push(`upgrade-lifecycle: ${m}`);
  if (r?.kind !== LIFECYCLE_KIND) { bad(`kind is ${String(r?.kind)}, not ${LIFECYCLE_KIND}`); return p; }
  if (!ADDR.test(r.safe ?? "")) bad("safe is not an address");
  if (!ADDR.test(r.timelock?.address ?? "")) bad("timelock.address is not an address");
  if (!/^[1-9][0-9]*$/.test(String(r.timelock?.min_delay ?? ""))) bad("timelock.min_delay is not a positive number of seconds");
  const ev = (u: any, exit: number) => ({ upgradeability: u, timelock: r.timelock, verifier: { exit_code: exit } });

  // 1. deploy: the release artifacts deployed upgradeable, nothing frozen, no claim
  const d = r.deploy?.upgradeability;
  if (d?.mode !== "upgradeable") bad(`deploy: mode is ${String(d?.mode)}, the rehearsal deploys upgradeable`);
  for (const x of upgradeabilityEvidenceProblems(ev(d, 0), proxies, "production")) bad(`deploy: ${x}`);
  const openAtDeploy = proxies.filter((n) => proxiesOf(d)[n]?.upgrades_frozen !== false);
  if (openAtDeploy.length) bad(`deploy: ${openAtDeploy.join(", ")} are not recorded upgradeable after the deploy`);
  if (d?.core_immutable !== false) bad("deploy: core_immutable is not false for an upgradeable deployment");

  // 2. the governed upgrade of the gateway, and only the gateway
  const u = r.upgrade ?? {};
  const after = u.upgradeability;
  if (u.proxy !== UPGRADED_PROXY) bad(`upgrade: proxy is ${String(u.proxy)}, the rehearsal upgrades ${UPGRADED_PROXY}`);
  for (const f of ["proxy_address", "from_implementation", "to_implementation"]) if (!ADDR.test(u[f] ?? "")) bad(`upgrade: ${f} is not an address`);
  for (const f of ["to_code_hash", "deploy_tx", "operation_id", "salt", "schedule_tx", "execute_tx"]) if (!B32.test(u[f] ?? "")) bad(`upgrade: ${f} is not a bytes32`);
  const dg = proxiesOf(d)[UPGRADED_PROXY], ag = proxiesOf(after)[UPGRADED_PROXY];
  if (lc(dg?.proxy) !== lc(u.proxy_address)) bad(`upgrade: proxy_address ${u.proxy_address} is not the deployed ${UPGRADED_PROXY} ${dg?.proxy}`);
  if (lc(dg?.implementation) !== lc(u.from_implementation)) bad(`upgrade: from_implementation ${u.from_implementation} is not the deployed implementation ${dg?.implementation}`);
  if (lc(u.to_implementation) === lc(u.from_implementation)) bad("upgrade: to_implementation equals from_implementation, nothing was upgraded");
  if (lc(ag?.implementation) !== lc(u.to_implementation) || lc(ag?.implementation_code_hash) !== lc(u.to_code_hash)) bad(`upgrade: the verifier record after the upgrade names ${ag?.implementation} (${ag?.implementation_code_hash}), not ${u.to_implementation} (${u.to_code_hash})`);
  for (const x of upgradeabilityEvidenceProblems(ev(after, 0), proxies, "production")) bad(`upgrade: ${x}`);
  for (const n of proxies) {
    if (n === UPGRADED_PROXY) continue;
    const a = proxiesOf(d)[n], b = proxiesOf(after)[n];
    if (lc(a?.implementation) !== lc(b?.implementation) || lc(a?.implementation_code_hash) !== lc(b?.implementation_code_hash)) bad(`upgrade: ${n} changed implementation between the deploy and the upgrade record, only ${UPGRADED_PROXY} is upgraded`);
  }
  if (Object.values(proxiesOf(after)).some((x: any) => x?.upgrades_frozen !== false)) bad("upgrade: a proxy is recorded frozen before the freeze");

  // 3. the freeze: one batch, one freezeUpgrades per proxy, bound to the record reviewed after the upgrade
  const f = r.freeze ?? {};
  for (const k of ["operation_id", "salt", "schedule_tx", "execute_tx"]) if (!B32.test(f[k] ?? "")) bad(`freeze: ${k} is not a bytes32`);
  const targets: Record<string, any> = (f.targets && typeof f.targets === "object") ? f.targets : {};
  const tn = Object.keys(targets);
  const missing = proxies.filter((n) => !tn.includes(n)), extra = tn.filter((n) => !proxies.includes(n));
  if (missing.length || extra.length) bad(`freeze: the targets are not the full core set: missing [${missing.join(", ")}] unexpected [${extra.join(", ")}]`);
  for (const n of proxies) {
    const t = targets[n], a = proxiesOf(after)[n];
    if (!t) continue;
    if (lc(t.proxy) !== lc(a?.proxy) || lc(t.implementation) !== lc(a?.implementation) || lc(t.implementation_code_hash) !== lc(a?.implementation_code_hash)) bad(`freeze: ${n} target is not the reviewed record after the upgrade (${a?.implementation}, ${a?.implementation_code_hash})`);
  }

  // 4. the queued upgrade refused after the freeze
  const x = r.rejected_upgrade ?? {};
  if (lc(x.proxy_address) !== lc(u.proxy_address) || x.proxy !== UPGRADED_PROXY) bad(`rejected_upgrade: it does not target the ${UPGRADED_PROXY} proxy ${u.proxy_address}`);
  if (!ADDR.test(x.target_implementation ?? "")) bad("rejected_upgrade: target_implementation is not an address");
  for (const k of ["operation_id", "salt", "schedule_tx"]) if (!B32.test(x[k] ?? "")) bad(`rejected_upgrade: ${k} is not a bytes32`);
  if (lc(x.revert_selector) !== lc(UPGRADES_ARE_FROZEN_SELECTOR) || x.revert_error !== "UpgradesAreFrozen") bad(`rejected_upgrade: the recorded revert is ${String(x.revert_error)} (${String(x.revert_selector)}), want UpgradesAreFrozen (${UPGRADES_ARE_FROZEN_SELECTOR})`);
  if (typeof x.safe_tool_refusal !== "string" || x.safe_tool_refusal.length === 0) bad("rejected_upgrade: safe_tool_refusal is empty: the Safe tool must have refused to execute the queued upgrade");
  const ops = [u.operation_id, f.operation_id, x.operation_id].map(lc);
  if (new Set(ops).size !== 3) bad("the upgrade, the freeze and the refused upgrade must be three different timelock operations");

  // 5. the final record: every proxy frozen by governance, the claim made, the gateway still on the upgraded implementation
  const fin = r.final?.upgradeability;
  if (r.final?.verifier_exit_code !== 0) bad(`final: the verifier exit code is ${String(r.final?.verifier_exit_code)}, not 0`);
  if (fin?.mode !== "upgradeable") bad(`final: mode is ${String(fin?.mode)}, the release mode never changes`);
  for (const y of upgradeabilityEvidenceProblems(ev(fin, r.final?.verifier_exit_code), proxies, "production")) bad(`final: ${y}`);
  if (fin?.core_immutable !== true) bad(`final: core_immutable is not true after the governed freeze (${JSON.stringify(fin?.immutability_refused_because ?? [])})`);
  const fg = proxiesOf(fin)[UPGRADED_PROXY];
  if (lc(fg?.implementation) !== lc(u.to_implementation)) bad(`final: ${UPGRADED_PROXY} implementation is ${fg?.implementation}, the refused upgrade must leave ${u.to_implementation} in place`);
  for (const n of proxies) {
    const t = targets[n], y = proxiesOf(fin)[n];
    if (t && (lc(y?.implementation) !== lc(t.implementation) || lc(y?.implementation_code_hash) !== lc(t.implementation_code_hash))) bad(`final: ${n} is frozen on ${y?.implementation}, not the freeze target ${t.implementation}`);
  }
  return p;
}

/** What the online check reads. viem PublicClient names, plus `callRevert`: an eth_call that returns the revert data (undefined when the call succeeds). */
export interface LifecycleChain extends UpgradeabilityChain {
  getTransactionReceipt(a: { hash: Hex }): Promise<{ status: "success" | "reverted"; blockNumber: bigint; contractAddress?: string | null; logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] }>;
  getBlock(a: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
  readContract(a: { address: `0x${string}`; abi: any; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  callRevert(a: { from: string; to: string; data: Hex }): Promise<Hex | undefined>;
}

type Log = { address: string; topics: readonly Hex[]; data: Hex };
function decoded(logs: readonly Log[], address: string, abi: any, name: string): any[] {
  const out: any[] = [];
  for (const l of logs) {
    if (lc(l.address) !== lc(address)) continue;
    try {
      const e = decodeEventLog({ abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) as { eventName: string; args: unknown };
      if (e.eventName === name) out.push(e.args);
    } catch { /* another event */ }
  }
  return out;
}

/** Every recorded transaction and the refused operation read back from the chain. Run it after the offline check passes. */
export async function upgradeLifecycleOnChainProblems(r: UpgradeLifecycleRecord, chain: LifecycleChain): Promise<string[]> {
  const p: string[] = [];
  const bad = (m: string) => p.push(`upgrade-lifecycle: ${m}`);
  const tl = r.timelock.address, floor = BigInt(r.timelock.min_delay);
  const rc = async (what: string, hash: string) => {
    try {
      const x = await chain.getTransactionReceipt({ hash: hash as Hex });
      if (x.status !== "success") { bad(`${what}: the receipt on chain is ${x.status}`); return undefined; }
      return x;
    } catch (e) { bad(`${what}: the receipt is not readable on chain (${(e as Error).message})`); return undefined; }
  };
  const ts = async (b: bigint) => (await chain.getBlock({ blockNumber: b })).timestamp;
  const scheduled = (x: { logs: readonly Log[] }) => decoded(x.logs, tl, LIFECYCLE_TIMELOCK_ABI, "CallScheduled");
  const executed = (x: { logs: readonly Log[] }) => decoded(x.logs, tl, LIFECYCLE_TIMELOCK_ABI, "CallExecuted");

  // the upgrade: the new implementation's creation, then ONE timelock call upgradeToAndCall(new, "") on the gateway proxy
  const u = r.upgrade;
  const dep = await rc("upgrade deploy_tx", u.deploy_tx);
  if (dep && lc(dep.contractAddress) !== lc(u.to_implementation)) bad(`upgrade: deploy_tx created ${String(dep.contractAddress)}, not ${u.to_implementation}`);
  const code = chain.getCode ? await chain.getCode({ address: u.to_implementation as Hex }) : undefined;
  if (!code || code.length <= 2 || lc(keccak256(code)) !== lc(u.to_code_hash)) bad(`upgrade: the code hash at ${u.to_implementation} is not ${u.to_code_hash}`);
  const us = await rc("upgrade schedule_tx", u.schedule_tx), ue = await rc("upgrade execute_tx", u.execute_tx);
  if (us) {
    const s = scheduled(us);
    if (s.length !== 1 || lc(s[0].id) !== lc(u.operation_id) || lc(s[0].target) !== lc(u.proxy_address) || lc(s[0].data) !== lc(upgradeCalldata(u.to_implementation))) bad(`upgrade: the schedule tx is not exactly one CallScheduled ${u.operation_id} of upgradeToAndCall(${u.to_implementation}, "") on ${u.proxy_address}`);
    else if (BigInt(s[0].delay) < floor) bad(`upgrade: CallScheduled delay ${s[0].delay} is under the timelock min delay ${floor}`);
  }
  if (ue) {
    if (!executed(ue).some((e) => lc(e.id) === lc(u.operation_id) && lc(e.target) === lc(u.proxy_address))) bad(`upgrade: the execute tx has no CallExecuted for ${u.operation_id}`);
    if (!decoded(ue.logs, u.proxy_address, GOVERNED_UUPS_ABI, "Upgraded").some((e) => lc(e.implementation) === lc(u.to_implementation))) bad(`upgrade: the execute tx has no Upgraded(${u.to_implementation}) from the proxy ${u.proxy_address}`);
  }
  if (us && ue && (await ts(ue.blockNumber)) - (await ts(us.blockNumber)) < floor) bad(`upgrade: the schedule-to-execute gap is under ${floor} s`);

  // the freeze: ONE batch, index i is freezeUpgrades(target) on proxy i, executed with an UpgradesFrozen from every proxy
  const f = r.freeze;
  const want = Object.values(f.targets);
  const fs = await rc("freeze schedule_tx", f.schedule_tx), fe = await rc("freeze execute_tx", f.execute_tx);
  if (fs) {
    const s = scheduled(fs).sort((a, b) => Number(a.index - b.index));
    if (s.length !== want.length) bad(`freeze: the schedule tx has ${s.length} CallScheduled events, want ${want.length} (one per core proxy)`);
    want.forEach((t, i) => {
      const e = s[i];
      if (!e || lc(e.id) !== lc(f.operation_id) || lc(e.target) !== lc(t.proxy) || lc(e.data) !== lc(freezeCalldata(t.implementation, t.implementation_code_hash))) bad(`freeze: batch call ${i} is not freezeUpgrades(${t.implementation}, ${t.implementation_code_hash}) on ${t.proxy} in operation ${f.operation_id}`);
      else if (BigInt(e.delay) < floor) bad(`freeze: CallScheduled delay ${e.delay} is under the timelock min delay ${floor}`);
    });
  }
  if (fe) {
    const ex = executed(fe);
    for (const t of want) {
      if (!ex.some((e) => lc(e.id) === lc(f.operation_id) && lc(e.target) === lc(t.proxy))) bad(`freeze: the execute tx has no CallExecuted on ${t.proxy}`);
      if (!decoded(fe.logs, t.proxy, GOVERNED_UUPS_ABI, "UpgradesFrozen").some((e) => lc(e.implementation) === lc(t.implementation) && lc(e.codeHash) === lc(t.implementation_code_hash))) bad(`freeze: the execute tx has no UpgradesFrozen(${t.implementation}) from ${t.proxy}`);
    }
  }
  if (fs && fe && (await ts(fe.blockNumber)) - (await ts(fs.blockNumber)) < floor) bad(`freeze: the schedule-to-execute gap is under ${floor} s`);

  // the refused upgrade: queued before the freeze executed, still pending and ready, and an execute by the Safe reverts with UpgradesAreFrozen now
  const x = r.rejected_upgrade;
  const data = upgradeCalldata(x.target_implementation);
  const xs = await rc("rejected_upgrade schedule_tx", x.schedule_tx);
  if (xs) {
    const s = scheduled(xs);
    if (s.length !== 1 || lc(s[0].id) !== lc(x.operation_id) || lc(s[0].target) !== lc(x.proxy_address) || lc(s[0].data) !== lc(data)) bad(`rejected_upgrade: the schedule tx is not exactly one CallScheduled ${x.operation_id} of upgradeToAndCall(${x.target_implementation}, "") on ${x.proxy_address}`);
    if (fe && xs.blockNumber >= fe.blockNumber) bad("rejected_upgrade: it was scheduled after the freeze executed, the rehearsal must show a queued upgrade fails");
  }
  const st = async (fn: string) => chain.readContract({ address: tl as Hex, abi: LIFECYCLE_TIMELOCK_ABI, functionName: fn, args: [x.operation_id] });
  try {
    const [pending, ready, done] = [await st("isOperationPending"), await st("isOperationReady"), await st("isOperationDone")];
    if (pending !== true || ready !== true || done !== false) bad(`rejected_upgrade: operation ${x.operation_id} reads pending ${String(pending)}, ready ${String(ready)}, done ${String(done)}; want a ready operation that never executed`);
  } catch (e) { bad(`rejected_upgrade: the operation state is not readable (${(e as Error).message})`); }
  const rev = await chain.callRevert({ from: r.safe, to: tl, data: executeCalldata(x.proxy_address, data, x.salt) });
  if (rev === undefined) bad("rejected_upgrade: a simulated execute by the Safe SUCCEEDS now: the proxy accepts an upgrade");
  else if (!lc(rev).startsWith(lc(UPGRADES_ARE_FROZEN_SELECTOR))) bad(`rejected_upgrade: a simulated execute by the Safe reverts with ${rev.slice(0, 10)}, not UpgradesAreFrozen (${UPGRADES_ARE_FROZEN_SELECTOR})`);

  // the final record against the chain: every proxy frozen, the slots and code hashes as recorded
  for (const y of await upgradeabilityOnChainProblems({ upgradeability: r.final.upgradeability }, chain)) bad(`final: ${y}`);
  return p;
}
