#!/usr/bin/env bun
// The record of an in-place upgrade of the LIVE fund system (Deploy 4, releases/v0.8.0-onevault-upgrade.yaml, flow fund-upgrade). The fund system has no govern row: every governed
// call is a Safe transaction to the fund-system timelock made with publish-contracts/src/safe/cli.ts. So nothing re-records the fund manifests after a governed upgrade, as
// `govern --row upgrade-proxy` does for the vaults system (runbook 4.12, "After a governed upgrade"). This tool does it, from the two Safe bundles of one operation and the chain:
//
//   bun publish-contracts/src/fund-upgrade-record.ts upgrade  --evidence DIR --manifest-dir DIR --rpc URL --proxy NAME --upgrade-build DIR --schedule-bundle F --execute-bundle F
//   bun publish-contracts/src/fund-upgrade-record.ts executor --evidence DIR --manifest-dir DIR --rpc URL --schedule-bundle F --execute-bundle F
//
// upgrade: the schedule bundle is ONE timelock call, schedule(proxy, 0, upgradeToAndCall(new, ""), ...), executed by the Safe; the execute bundle is the execute of that same
//   operation, executed by the Safe; the timelock reads the operation done; the proxy's ERC-1967 slot reads the new implementation; the run manifest's implementation_deploys
//   records that implementation from that --upgrade-build (deploy-implementation --system fund). Then the proxy's stage manifest re-records its implementation field (and
//   fund-timelock.json its code hash), and the run manifest gains a `proxy_upgrades` entry in the shape `govern --row upgrade-proxy` writes, with the build: the fund verifier
//   then compares that proxy with that build (verify-stage.ts proxyBuildDirsOf), and evidence-check.ts --governed-upgrades reads the operation back from the chain.
// executor: the schedule bundle is ONE timelock batch on the timelock itself, exactly [grantRole(EXECUTOR_ROLE, the Safe), revokeRole(EXECUTOR_ROLE, address(0))] (decision
//   D4-10 applied to the live timelock), executed by the Safe, and its executeBatch; the timelock reads it done, the Safe holds EXECUTOR_ROLE and address(0) does not. Then
//   fund-timelock.json re-records executorPolicy "safe-only" (with the operation that made it so) and the run manifest gains a `timelock_executor_switches` entry.
// Nothing is sent. Every check runs before any file is written; a rerun with the same bundles rewrites the same entry. Exit 1: a check failed (nothing written). Exit 2: usage.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, decodeFunctionData, encodeFunctionData, getAddress, http, keccak256, parseAbi, toHex, type Address, type Hex } from "viem";
import { loadRunManifest, saveRunManifest, type RunManifest } from "./runner.ts";
import { loadStageTable, manifestBase, scopeTable } from "./stage-table.ts";
import { UPGRADE_ROW, codeHashOf, rerecordProxyManifest } from "./upgrade-rows.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "./verify/codehash.ts";
import { proxySpecs, type ProxySpec } from "./verify/upgradeability.ts";
import type { SafeTxBundle } from "./safe/tx.ts";

export const RECORD_VERBS = ["upgrade", "executor"] as const;
export const EXECUTOR_SWITCH_STEP = "timelock-executor-safe-only";
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const EXECUTOR_ROLE = keccak256(toHex("EXECUTOR_ROLE"));
const TIMELOCK_ABI = parseAbi([
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
]);
const UPGRADE_ABI = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data)"]);
const lc = (s: string): string => s.toLowerCase();

/** What the record reads from the chain. The CLI reads it with viem; the tests give it directly. */
export interface ChainFacts {
  implementationOf: (proxy: Address) => Promise<Address>;
  code: (at: Address) => Promise<Hex>;
  isOperationDone: (timelock: Address, id: Hex) => Promise<boolean>;
  hasRole: (at: Address, role: Hex, who: Address) => Promise<boolean>;
  tx: (hash: Hex) => Promise<{ status: "success" | "reverted"; timestamp: number }>;
}

/** PURE. Why a pair of Safe bundles is not one executed timelock operation with these calls; the decoded calls when it is. */
export function operationProblems(schedule: SafeTxBundle, execute: SafeTxBundle, timelock: Address, safe: Address, batch: boolean): { problems: string[]; calls: { target: Address; value: bigint; data: Hex }[]; id?: Hex; predecessor?: Hex } {
  const p: string[] = [];
  const want = batch ? ["scheduleBatch", "executeBatch"] : ["schedule", "execute"];
  for (const [b, name, action] of [[schedule, "schedule", want[0]], [execute, "execute", want[1]]] as const) {
    if (lc(b.safe) !== lc(safe)) p.push(`the ${name} bundle is for the Safe ${b.safe}, not the fund Safe ${safe}`);
    if (lc(b.to) !== lc(timelock) || lc(b.timelock ?? "") !== lc(timelock)) p.push(`the ${name} bundle does not call the fund-system timelock ${timelock}`);
    if (b.action !== action) p.push(`the ${name} bundle's action is ${b.action}, not ${action}`);
    if (!b.executed?.tx_hash || b.executed.status === 0) p.push(`the ${name} bundle was not executed by the Safe (no executed transaction with status 1)`);
  }
  if (!schedule.timelock_operation_id || lc(schedule.timelock_operation_id) !== lc(execute.timelock_operation_id ?? "")) p.push(`the bundles name different timelock operations (${schedule.timelock_operation_id}, ${execute.timelock_operation_id})`);
  let calls: { target: Address; value: bigint; data: Hex }[] = [];
  let predecessor: Hex | undefined;
  try {
    const d = decodeFunctionData({ abi: TIMELOCK_ABI, data: schedule.data });
    if (!batch && d.functionName === "schedule") { const [t, v, data, pred] = d.args as unknown as [Address, bigint, Hex, Hex]; calls = [{ target: t, value: v, data }]; predecessor = pred; }
    else if (batch && d.functionName === "scheduleBatch") { const [ts, vs, ds, pred] = d.args as unknown as [readonly Address[], readonly bigint[], readonly Hex[], Hex]; calls = ts.map((t, i) => ({ target: t, value: vs[i]!, data: ds[i]! })); predecessor = pred; }
    else p.push(`the schedule bundle's calldata is ${d.functionName}, not ${want[0]}`);
    const e = decodeFunctionData({ abi: TIMELOCK_ABI, data: execute.data });
    const eCalls = e.functionName === "execute" ? [{ target: e.args[0] as Address, value: e.args[1] as bigint, data: e.args[2] as Hex }]
      : e.functionName === "executeBatch" ? (e.args[0] as readonly Address[]).map((t, i) => ({ target: t, value: (e.args[1] as readonly bigint[])[i]!, data: (e.args[2] as readonly Hex[])[i]! })) : [];
    if (eCalls.length !== calls.length || eCalls.some((c, i) => lc(c.target) !== lc(calls[i]!.target) || c.value !== calls[i]!.value || lc(c.data) !== lc(calls[i]!.data))) p.push("the execute bundle does not execute the calls the schedule bundle scheduled");
  } catch (x) { p.push(`a bundle's calldata does not decode as a timelock call: ${(x as Error).message}`); }
  return { problems: p, calls, ...(schedule.timelock_operation_id ? { id: schedule.timelock_operation_id } : {}), ...(predecessor ? { predecessor } : {}) };
}

/** PURE. The two calls of the executor switch, in order: grantRole(EXECUTOR_ROLE, safe), revokeRole(EXECUTOR_ROLE, address(0)), each on the timelock itself with no value. */
export function executorSwitchCalls(timelock: Address, safe: Address): { target: Address; value: bigint; data: Hex }[] {
  return [
    { target: timelock, value: 0n, data: encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "grantRole", args: [EXECUTOR_ROLE, safe] }) },
    { target: timelock, value: 0n, data: encodeFunctionData({ abi: TIMELOCK_ABI, functionName: "revokeRole", args: [EXECUTOR_ROLE, ZERO] }) },
  ];
}

const readJson = (p: string): any => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p: string, v: unknown): void => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

export interface RecordInput { evidenceDir: string; manifestDir: string; scheduleBundle: SafeTxBundle; executeBundle: SafeTxBundle; coreDir: string }

/** The `upgrade` record. Returns the problems (nothing written) or the entry it wrote. */
export async function recordUpgrade(i: RecordInput & { proxy: string; upgradeBuild: string }, chain: ChainFacts): Promise<{ problems: string[]; entry?: Record<string, unknown> }> {
  const p: string[] = [];
  const manifest = loadRunManifest(i.evidenceDir);
  if (!manifest || manifest.system !== "fund") return { problems: [`${i.evidenceDir} holds no fund-system run manifest`] };
  const specs = proxySpecs(scopeTable(loadStageTable(i.coreDir), "fund"));
  const spec: ProxySpec | undefined = specs.find((s) => s.name === i.proxy);
  if (!spec) return { problems: [`--proxy ${i.proxy} is no fund-system proxy (${specs.map((s) => s.name).join(", ")})`] };
  const t = loadStageTable(i.coreDir);
  const stageManifest = join(i.manifestDir, `${manifestBase(t.stages.find((s) => s.name === spec.stage)!.manifest)}.json`);
  const tmPath = join(i.manifestDir, "fund-timelock.json");
  for (const f of [stageManifest, tmPath, join(i.manifestDir, "safe.json")]) if (!existsSync(f)) p.push(`${f} does not exist`);
  if (p.length) return { problems: p };
  const m = readJson(stageManifest), tm = readJson(tmPath), safe = getAddress(readJson(join(i.manifestDir, "safe.json")).safe);
  const proxy = getAddress(m[spec.field]), timelock = getAddress(tm.timelock);
  const op = operationProblems(i.scheduleBundle, i.executeBundle, timelock, safe, false);
  p.push(...op.problems);
  let to: Address | undefined;
  if (op.calls.length === 1) {
    const c = op.calls[0]!;
    if (lc(c.target) !== lc(proxy)) p.push(`the operation calls ${c.target}, not the ${spec.name} proxy ${proxy}`);
    if (c.value !== 0n) p.push("the operation sends value");
    try {
      const d = decodeFunctionData({ abi: UPGRADE_ABI, data: c.data });
      to = getAddress(d.args[0]);
      if (d.args[1] !== "0x") p.push(`the upgrade carries migration data ${d.args[1]}: a fund-system upgrade here is upgradeToAndCall(new, "") only`);
    } catch { p.push("the operation's call is not upgradeToAndCall(address,bytes)"); }
  }
  if (op.predecessor && op.predecessor !== `0x${"00".repeat(32)}`) p.push(`the upgrade names a predecessor ${op.predecessor}: it is one operation of its own`);
  if (p.length || !to || !op.id) return { problems: p };
  const deploys = ((manifest as { implementation_deploys?: Record<string, unknown>[] }).implementation_deploys ?? []).filter((e) => e.system === "fund" && e.proxy_name === spec.name && lc(String(e.implementation)) === lc(to!));
  if (!deploys.some((e) => e.build === i.upgradeBuild)) p.push(`the run manifest records no deploy-implementation --system fund of ${to} for ${spec.name} from the build ${i.upgradeBuild}`);
  const from = getAddress(String(m[spec.implementationField]));
  if (lc(from) === lc(to)) p.push(`the stage manifest already names ${to}: there is nothing to re-record`);
  if (!(await chain.isOperationDone(timelock, op.id))) p.push(`the timelock does not read operation ${op.id} done`);
  const live = await chain.implementationOf(proxy);
  if (lc(live) !== lc(to)) p.push(`the ${spec.name} proxy's ERC-1967 slot reads ${live}, not the upgrade's ${to}`);
  const sched = await chain.tx(i.scheduleBundle.executed!.tx_hash), exec = await chain.tx(i.executeBundle.executed!.tx_hash);
  if (sched.status !== "success") p.push("the schedule transaction did not succeed on chain");
  if (exec.status !== "success") p.push("the execute transaction did not succeed on chain");
  if (p.length) return { problems: p };
  const toHash = codeHashOf(await chain.code(to))!, fromHash = codeHashOf(await chain.code(from)), proxyHash = codeHashOf(await chain.code(proxy))!;
  const fields = rerecordProxyManifest(stageManifest, spec, to, toHash, proxyHash);
  if (tm.code_hashes && typeof tm.code_hashes === "object" && spec.implementationField in tm.code_hashes) { tm.code_hashes[spec.implementationField] = toHash; writeJson(tmPath, tm); }
  const entry = {
    step: UPGRADE_ROW, system: "fund", via: "publish-contracts/src/safe/cli.ts", proxy_name: spec.name, proxy, from_implementation: from, to_implementation: to, from_code_hash: fromHash, to_code_hash: toHash,
    build: i.upgradeBuild, timelock, manifest_fields: fields, operation_id: op.id,
    schedule_tx: i.scheduleBundle.executed!.tx_hash, schedule_status: 1, schedule_block_timestamp: sched.timestamp, schedule_safe_tx_hash: i.scheduleBundle.safe_tx_hash,
    execute_tx: i.executeBundle.executed!.tx_hash, execute_status: 1, execute_block_timestamp: exec.timestamp, execute_safe_tx_hash: i.executeBundle.safe_tx_hash,
  };
  const list = ((manifest as { proxy_upgrades?: Record<string, unknown>[] }).proxy_upgrades ??= []);
  const at = list.findIndex((x) => lc(String(x.operation_id)) === lc(op.id!));
  if (at >= 0) list[at] = entry; else list.push(entry);
  saveRunManifest(i.evidenceDir, manifest as RunManifest);
  return { problems: [], entry };
}

/** The `executor` record. Returns the problems (nothing written) or the entry it wrote. */
export async function recordExecutorSwitch(i: RecordInput, chain: ChainFacts): Promise<{ problems: string[]; entry?: Record<string, unknown> }> {
  const p: string[] = [];
  const manifest = loadRunManifest(i.evidenceDir);
  if (!manifest || manifest.system !== "fund") return { problems: [`${i.evidenceDir} holds no fund-system run manifest`] };
  const tmPath = join(i.manifestDir, "fund-timelock.json"), safePath = join(i.manifestDir, "safe.json");
  for (const f of [tmPath, safePath]) if (!existsSync(f)) p.push(`${f} does not exist`);
  if (p.length) return { problems: p };
  const tm = readJson(tmPath), safe = getAddress(readJson(safePath).safe), timelock = getAddress(tm.timelock);
  if (lc(String(tm.safe ?? "")) !== lc(safe)) p.push(`fund-timelock.json names the Safe ${tm.safe}, safe.json ${safe}`);
  const op = operationProblems(i.scheduleBundle, i.executeBundle, timelock, safe, true);
  p.push(...op.problems);
  const want = executorSwitchCalls(timelock, safe);
  if (op.calls.length && (op.calls.length !== want.length || op.calls.some((c, k) => lc(c.target) !== lc(want[k]!.target) || c.value !== 0n || lc(c.data) !== lc(want[k]!.data)))) {
    p.push("the batch is not exactly [grantRole(EXECUTOR_ROLE, the Safe), revokeRole(EXECUTOR_ROLE, address(0))] on the timelock");
  }
  if (p.length || !op.id) return { problems: p };
  if (!(await chain.isOperationDone(timelock, op.id))) p.push(`the timelock does not read operation ${op.id} done`);
  if (!(await chain.hasRole(timelock, EXECUTOR_ROLE, safe))) p.push("the Safe does not hold EXECUTOR_ROLE");
  if (await chain.hasRole(timelock, EXECUTOR_ROLE, ZERO)) p.push("address(0) still holds EXECUTOR_ROLE: the executor is still open");
  const sched = await chain.tx(i.scheduleBundle.executed!.tx_hash), exec = await chain.tx(i.executeBundle.executed!.tx_hash);
  if (sched.status !== "success") p.push("the schedule transaction did not succeed on chain");
  if (exec.status !== "success") p.push("the execute transaction did not succeed on chain");
  if (p.length) return { problems: p };
  const entry = {
    step: EXECUTOR_SWITCH_STEP, system: "fund", timelock, safe, from_policy: tm.executorPolicy === "safe-only" && tm.executor_policy_change ? tm.executor_policy_change.from_policy : String(tm.executorPolicy ?? "open"),
    to_policy: "safe-only", operation_id: op.id, predecessor: op.predecessor ?? null,
    schedule_tx: i.scheduleBundle.executed!.tx_hash, schedule_block_timestamp: sched.timestamp, execute_tx: i.executeBundle.executed!.tx_hash, execute_block_timestamp: exec.timestamp,
  };
  tm.executorPolicy = "safe-only";
  tm.executor_policy_change = entry;
  writeJson(tmPath, tm);
  const list = ((manifest as { timelock_executor_switches?: Record<string, unknown>[] }).timelock_executor_switches ??= []);
  const at = list.findIndex((x) => lc(String(x.operation_id)) === lc(op.id!));
  if (at >= 0) list[at] = entry; else list.push(entry);
  saveRunManifest(i.evidenceDir, manifest as RunManifest);
  return { problems: [], entry };
}

/** The chain facts over viem. */
export function viemFacts(rpc: string): ChainFacts {
  const c = createPublicClient({ transport: http(rpc) });
  return {
    implementationOf: async (proxy) => getAddress(`0x${((await c.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT as Hex })) ?? "0x").slice(-40).padStart(40, "0")}`),
    code: async (at) => ((await c.getCode({ address: at })) ?? "0x") as Hex,
    isOperationDone: async (tl, id) => (await c.readContract({ address: tl, abi: TIMELOCK_ABI, functionName: "isOperationDone", args: [id] })) as boolean,
    hasRole: async (at, role, who) => (await c.readContract({ address: at, abi: TIMELOCK_ABI, functionName: "hasRole", args: [role, who] })) as boolean,
    tx: async (hash) => { const r = await c.getTransactionReceipt({ hash }); const b = await c.getBlock({ blockNumber: r.blockNumber }); return { status: r.status, timestamp: Number(b.timestamp) }; },
  };
}

export const RECORD_FLAGS = ["evidence", "manifest-dir", "rpc", "proxy", "upgrade-build", "schedule-bundle", "execute-bundle"] as const;

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const f: Record<string, string> = {};
  for (let k = 0; k < rest.length; k += 2) {
    const name = rest[k]?.replace(/^--/, "");
    if (!name || !(RECORD_FLAGS as readonly string[]).includes(name) || rest[k + 1] === undefined) { console.error(`usage: unknown or empty argument ${rest[k]}`); return 2; }
    f[name] = rest[k + 1]!;
  }
  if (!(RECORD_VERBS as readonly string[]).includes(verb ?? "")) { console.error(`usage: fund-upgrade-record.ts ${RECORD_VERBS.join("|")} ...`); return 2; }
  const need = verb === "upgrade" ? ["evidence", "manifest-dir", "rpc", "proxy", "upgrade-build", "schedule-bundle", "execute-bundle"] : ["evidence", "manifest-dir", "rpc", "schedule-bundle", "execute-bundle"];
  const miss = need.filter((k) => !f[k]);
  if (miss.length) { console.error(`usage: ${verb} needs --${miss.join(", --")}`); return 2; }
  const coreDir = new URL("../../", import.meta.url).pathname;
  const base = { evidenceDir: f.evidence!, manifestDir: f["manifest-dir"]!, scheduleBundle: readJson(f["schedule-bundle"]!), executeBundle: readJson(f["execute-bundle"]!), coreDir };
  const facts = viemFacts(f.rpc!);
  const r = verb === "upgrade" ? await recordUpgrade({ ...base, proxy: f.proxy!, upgradeBuild: f["upgrade-build"]! }, facts) : await recordExecutorSwitch(base, facts);
  if (r.problems.length) { for (const x of r.problems) console.error(`fund-upgrade-record ${verb}: ${x}`); console.error("nothing was written"); return 1; }
  console.log(JSON.stringify({ event: `fund_upgrade_record.${verb}`, ...r.entry }));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
