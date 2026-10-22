#!/usr/bin/env bun
// Issue 1811 (upgradeability stage 4): the Twin rehearsal of the governed proxy lifecycle, after twin-publish deployed the release artifacts with the upgrade
// overlay (deployments/twin-918453/upgrade-rehearsal.env: UPGRADE_MODE=upgradeable) and ran publish, verify, govern and verify. On that deployment it runs:
//   1. deploy record    the verifier's upgradeability.json after the post-govern verify: every proxy upgradeable, no immutability claim.
//   2. upgrade          `deploy-implementation --proxy gateway` (issue 1861): the deployer creates a second copy of the gateway implementation from the build artifact, linked to
//                       the libraries the live one uses, the verb reads its code back and records implementation_deploys (a rerun reuses the entry and sends nothing), then
//                       `govern --row upgrade-proxy` (issue 1859): the governing Safe (two owner keystores sign, the deployer pays the gas) schedules
//                       upgradeToAndCall(new, "") on the timelock, the Twin clock is warped past the real delay, the Safe executes it, and the row re-records the gateway
//                       manifest's implementation pin and records `proxy_upgrades` in the run manifest. verify runs again.
//   3. freeze schedule  `govern --row freeze-upgrades --no-warp --max-wait 0`: the Safe schedules ONE batch, freezeUpgrades(implementation, implementation_code_hash) on every
//                       core proxy, both values taken from the upgradeability.json the verify of step 2 wrote. With no warp the row exits 15 (GOVERN_PENDING) after the schedule.
//   4. queued upgrade   the Safe schedules a second gateway upgrade (back to the first implementation) BEFORE the freeze executes. It is never cancelled. It goes through the
//                       Safe library directly: no row schedules an upgrade it never executes, and the freeze row refuses to schedule while an upgrade is pending.
//   5. freeze execute   `govern --row freeze-upgrades` again: the Twin clock is warped past the delay, the Safe executes the batch, the row reads every proxy frozen and records
//                       `upgrade_freezes` in the run manifest.
//   6. refused upgrade  the Safe is asked to execute the queued upgrade of step 4: the Safe tool refuses (its simulation reverts, nothing is sent), and a
//                       simulated execute from the Safe reverts with UpgradesAreFrozen. The operation stays pending.
//   7. final verify     verify claims core immutability (an upgradeable release frozen by governance).
// It checks the run manifest's `proxy_upgrades` and `upgrade_freezes` (evidence-check's governedUpgradeProblems), writes <TWIN_RUN_DIR>/upgrade-lifecycle.json and checks it
// with the evidence tool against the chain (evidence-check --upgrade-lifecycle --rpc).
// Every step goes through the real contracts, the real Safe and the real timelock; the only Twin environment step is the time warp. Any failure exits non-zero.
// Environment in: RPC_URL, TWIN_RUN_DIR (twin-publish's run directory: keys, passphrase, sheet.env, manifests), GITHUB_WORKSPACE, GITHUB_ENV (optional).
// Tests and local runs may replace the tools: TWIN_CLI (default src/cli.ts), TWIN_EVIDENCE_CHECK (default src/evidence-check.ts). Never use this against Base mainnet.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { TWIN_CHAIN_ID } from "../chains.ts";
import { httpRpc, latestTimestamp, requireTwin, warpTo } from "../rehearsal/twin.ts";
import { connectSafe, executeOnTimelock, executeTx, jsonLogger, keystoreSigner, operationId, operationState, scheduleOnTimelock, signTx, timelockMinDelay, verifyTimelockEffect, type SafeTxBundle, type TimelockCall } from "../safe/index.ts";
import { loadStageTable, manifestBase, scopeTable } from "../stage-table.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../verify/codehash.ts";
import { PINNED_PROXIES, proxySpecs } from "../verify/upgradeability.ts";
import { UPGRADED_PROXY, UPGRADES_ARE_FROZEN_SELECTOR, executeCalldata, freezeCalldata, upgradeCalldata, LIFECYCLE_KIND, type FreezeTarget, type UpgradeLifecycleRecord } from "../upgrade-lifecycle.ts";
import { governedUpgradeProblems, rpcCallRevert } from "../evidence-check.ts";
import { governSalt } from "../govern.ts";
import { loadRunManifest } from "../runner.ts";
import { FREEZE_ROW, UPGRADE_ROW, upgradeRecordKey } from "../upgrade-rows.ts";
import { UPGRADEABILITY_MANIFEST } from "../verify-stage.ts";
import { DEPLOY_IMPL_VERB } from "../deploy-implementation.ts";

const env = (k: string, d = ""): string => process.env[k] ?? d;
const fail = (m: string): never => { console.error(`twin-upgrade-lifecycle: ${m}`); process.exit(1); };
const say = (event: string, fields: Record<string, unknown> = {}) => console.error(JSON.stringify({ ts: new Date().toISOString(), event: `upgrade_lifecycle.${event}`, ...fields }));

/** Runs a command. Any exit code but `exitCode` (default 0) fails the rehearsal. */
function run(cmd: string[], opts: { cwd?: string; stdoutTo?: string; childEnv?: Record<string, string>; exitCode?: number } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.childEnv }, stdout: "pipe", stderr: "inherit" });
  const out = r.stdout.toString();
  if (opts.stdoutTo) writeFileSync(opts.stdoutTo, out); else process.stdout.write(out);
  if (r.exitCode !== (opts.exitCode ?? 0)) fail(`${cmd.slice(0, 3).join(" ")} exited ${r.exitCode}, want ${opts.exitCode ?? 0}`);
  return out;
}

const core = env("GITHUB_WORKSPACE") || fail("GITHUB_WORKSPACE is not set");
const rpc = env("RPC_URL") || fail("RPC_URL is not set");
const rh = env("TWIN_RUN_DIR") || fail("TWIN_RUN_DIR is not set: run twin-publish first");
const pc = join(core, "publish-contracts");
const bun = process.execPath;
const sha = run(["git", "-C", core, "rev-parse", "HEAD"]).trim();
const pass = join(rh, "passphrase"), sheet = join(rh, "sheet.env"), manifests = join(rh, "manifests");
const key = (name: string) => join(rh, "keys", name);
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const upgradeabilityNow = (): any => json(join(manifests, UPGRADEABILITY_MANIFEST));
const rpcFn = httpRpc(rpc);
await requireTwin(rpcFn);

// The same CLI verb invocation twin-publish uses (one driver, the same flags). govern signs with the SAFE_OWNER_* keystores beside the deployer keystore (cli.ts, Twin default).
const evidenceDir = join(rh, "evidence");
const stage = (verb: string, stdoutTo: string, extra: string[] = [], exitCode = 0) => run([bun, env("TWIN_CLI", "src/cli.ts"), verb, "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet,
  "--signer", `keystore:${key("DEPLOYER")}:${pass}`, "--environment", "stage", "--core-sha", sha, "--counts-dir", join(rh, "counts"), "--evidence", evidenceDir, ...extra],
  { cwd: pc, stdoutTo, childEnv: { PUBLISH_MANIFEST_DIR: manifests, YES: "1" }, exitCode });
/** The run manifest the govern rows wrote (publish-run.json in the evidence directory). */
const runManifest = (): any => loadRunManifest(evidenceDir) ?? fail(`no run manifest in ${evidenceDir}`);
const isTx = (x: unknown): x is Hex => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);

const table = loadStageTable(core);
const specs = proxySpecs(scopeTable(table, "vaults")); // issue 1892: the vaults system's proxies (the gateway system is deployed and governed by its own release)
const gw = specs.find((s) => s.name === UPGRADED_PROXY) ?? fail(`the stage table has no ${UPGRADED_PROXY} proxy`);
const gwManifestPath = join(manifests, `${manifestBase(table.stages.find((s) => s.name === gw.stage)!.manifest)}.json`);
const safeAddr = json(join(manifests, "safe.json")).safe as Address;
const timelock = json(join(manifests, "timelock.json")).timelock as Address;
const client = createPublicClient({ transport: http(rpc) });
const implOf = async (proxy: Address): Promise<Address> => `0x${((await client.getStorageAt({ address: proxy, slot: ERC1967_IMPLEMENTATION_SLOT })) ?? "0x").replace(/^0x/, "").padStart(64, "0").slice(24)}` as Address;
const codeHash = async (a: Address): Promise<Hex> => keccak256((await client.getCode({ address: a })) ?? "0x");

// ---- 1. the deploy record ----
const deployRec = upgradeabilityNow();
if (deployRec.mode !== "upgradeable") fail(`the deployment's upgradeability.json says mode ${deployRec.mode}: run twin-publish with SHEET_OVERLAY_IN=deployments/twin-918453/upgrade-rehearsal.env`);
const gwProxy = deployRec.proxies?.[UPGRADED_PROXY]?.proxy as Address ?? fail(`upgradeability.json has no ${UPGRADED_PROXY}`);
const fromImpl = await implOf(gwProxy);
say("deploy_recorded", { proxies: Object.keys(deployRec.proxies).length, gateway: gwProxy, implementation: fromImpl });

// ---- the Safe: two of the three owner keystores sign, the deployer pays the gas ----
const handle = await connectSafe({ rpcUrl: rpc, chainId: TWIN_CHAIN_ID, safeAddress: safeAddr, logger: jsonLogger() });
const owners = await Promise.all(["SAFE_OWNER_A", "SAFE_OWNER_B", "SAFE_OWNER_C"].map((n) => keystoreSigner({ path: key(n), passphrase: { file: pass } })));
const sender = await keystoreSigner({ path: key("DEPLOYER"), passphrase: { file: pass } });
async function signed(b: SafeTxBundle): Promise<SafeTxBundle> {
  let out = b;
  for (const s of owners.slice(0, handle.threshold)) out = await signTx(handle, out, s);
  return out;
}
async function safeTx(b: SafeTxBundle): Promise<Hex> {
  const res = await executeTx(handle, await signed(b), sender);
  await verifyTimelockEffect(handle, res.bundle);
  return res.txHash!;
}
const saltOf = (step: string): Hex => keccak256(toBytes(`robotmoney.twin.upgrade-lifecycle.${step}.${sha}.${Date.now()}`));
/** The real delay of every listed operation, passed by ONE warp of the Twin clock to one second after the latest ready time. */
async function waitReady(ids: Hex[]): Promise<void> {
  let latest = 0n;
  for (const id of ids) { const st = await operationState(handle, timelock, id); if (!st.pending) fail(`operation ${id} is not pending`); if (st.readyAt > latest) latest = st.readyAt; }
  if ((await latestTimestamp(rpcFn)) < latest) await warpTo(rpcFn, latest + 1n);
}

// ---- 2. the governed upgrade of the gateway ----
// The new implementation: the operator verb (issue 1861) deploys the build's creation code with every library placeholder filled with the address the live implementation
// links (the same reviewed release artifact at a new address; its immutable self-address makes its code hash differ from the first copy) and records it in the run manifest.
const deployImpl = (stdoutTo: string): any => JSON.parse(stage(DEPLOY_IMPL_VERB, stdoutTo, ["--proxy", UPGRADED_PROXY]).split("\n").find((l) => l.includes('"event":"deploy_implementation"')) ?? fail(`${DEPLOY_IMPL_VERB} printed no deploy_implementation line (${stdoutTo})`));
const dep = deployImpl(join(rh, "deploy-implementation.txt"));
const toImpl = dep.implementation as Address;
const deployTx = dep.deploy_tx as Hex;
if (dep.reused !== false || !isTx(deployTx)) fail(`deploy-implementation did not deploy: ${JSON.stringify(dep)}`);
if (!String(dep.next).includes(`--row ${UPGRADE_ROW} --proxy ${UPGRADED_PROXY} --implementation ${toImpl}`)) fail(`deploy-implementation printed no govern --row ${UPGRADE_ROW} command for ${toImpl}: ${dep.next}`);
const depEntry = (runManifest().implementation_deploys ?? []).find((e: any) => e?.proxy_name === UPGRADED_PROXY && String(e?.implementation).toLowerCase() === toImpl.toLowerCase())
  ?? fail(`deploy-implementation recorded no implementation_deploys entry for ${toImpl}`);
const toHash = await codeHash(toImpl);
if (String(depEntry.code_hash).toLowerCase() !== toHash.toLowerCase() || String(depEntry.live_implementation).toLowerCase() !== fromImpl.toLowerCase()) fail(`the implementation_deploys entry does not match the chain: ${JSON.stringify(depEntry)}`);
// a rerun with the same arguments reuses the entry and sends nothing
const again = deployImpl(join(rh, "deploy-implementation-rerun.txt"));
if (again.reused !== true || String(again.implementation).toLowerCase() !== toImpl.toLowerCase()) fail(`a rerun of deploy-implementation did not reuse ${toImpl}: ${JSON.stringify(again)}`);
say("implementation_deployed", { implementation: toImpl, code_hash: toHash, tx: deployTx, libraries: depEntry.libraries });

// the row: schedule through the Safe, warp past the real delay, execute, read the slot back, re-record the gateway manifest, record proxy_upgrades
stage("govern", join(rh, "govern-upgrade-proxy.txt"), ["--row", UPGRADE_ROW, "--proxy", UPGRADED_PROXY, "--implementation", toImpl]);
const upCall: TimelockCall = { target: gwProxy, data: upgradeCalldata(toImpl) };
const upSalt = governSalt(sha, TWIN_CHAIN_ID, upgradeRecordKey(UPGRADED_PROXY, toImpl));
const upEntry = (runManifest().proxy_upgrades ?? []).find((e: any) => e?.proxy_name === UPGRADED_PROXY && String(e?.to_implementation).toLowerCase() === toImpl.toLowerCase())
  ?? fail(`govern --row ${UPGRADE_ROW} wrote no proxy_upgrades entry for ${UPGRADED_PROXY} to ${toImpl}`);
const upId = upEntry.operation_id as Hex;
if (upId.toLowerCase() !== (await operationId(handle, { timelock, calls: [upCall], salt: upSalt, form: "single" })).toLowerCase()) fail(`the proxy_upgrades operation ${upId} is not the row's upgradeToAndCall(${toImpl}) operation`);
if (!isTx(upEntry.schedule_tx) || !isTx(upEntry.execute_tx)) fail(`the proxy_upgrades entry has no schedule or execute transaction: ${JSON.stringify(upEntry)}`);
const upSchedTx = upEntry.schedule_tx as Hex, upExecTx = upEntry.execute_tx as Hex;
if ((await implOf(gwProxy)).toLowerCase() !== toImpl.toLowerCase()) fail(`after the upgrade the gateway proxy's implementation slot reads ${await implOf(gwProxy)}, not ${toImpl}`);
const gm = json(gwManifestPath);
// only a pinned proxy (the gateway) records its implementation runtime hash; the router, upgraded since issue 1892, records the implementation address only
const pinnedUpgrade = PINNED_PROXIES.includes(UPGRADED_PROXY);
if (String(gm[gw.implementationField]).toLowerCase() !== toImpl.toLowerCase() || (pinnedUpgrade && String(gm[`${gw.implementationField}_runtime_hash`]).toLowerCase() !== toHash.toLowerCase())) fail(`govern --row ${UPGRADE_ROW} did not re-record ${gwManifestPath}: ${gw.implementationField} ${gm[gw.implementationField]}, runtime hash ${gm[`${gw.implementationField}_runtime_hash`]}`);
say("upgraded", { operation_id: upId, schedule_tx: upSchedTx, execute_tx: upExecTx, manifest_fields: upEntry.manifest_fields });
stage("verify", join(rh, "verify-labels-post-upgrade.txt"));
const upgradeRec = upgradeabilityNow();

// ---- 3. the freeze schedule: the row binds the batch to the record verify wrote after the upgrade, schedules it and stops (no warp: exit 15, GOVERN_PENDING) ----
stage("govern", join(rh, "govern-freeze-schedule.txt"), ["--row", FREEZE_ROW, "--no-warp", "--max-wait", "0"], 15);
const frId = (runManifest().govern?.[FREEZE_ROW]?.scheduled?.operation_id as Hex | undefined) ?? fail(`govern --row ${FREEZE_ROW} recorded no scheduled operation`);
if (!(await operationState(handle, timelock, frId)).pending) fail(`the freeze operation ${frId} is not pending after its schedule`);
say("freeze_scheduled", { operation_id: frId });

// ---- 4. a second gateway upgrade, queued after the freeze schedule and before its execute, never cancelled ----
const rejCall: TimelockCall = { target: gwProxy, data: upgradeCalldata(fromImpl) };
const rejSalt = saltOf("queued-upgrade");
const rejSched = await scheduleOnTimelock(handle, { timelock, calls: [rejCall], salt: rejSalt, form: "single", description: "rehearsal: an upgrade queued before the freeze" });
const rejId = rejSched.timelock_operation_id as Hex;
const rejSchedTx = await safeTx(rejSched);
say("upgrade_queued", { operation_id: rejId, schedule_tx: rejSchedTx });

// ---- 5. the freeze execute: the same row again warps past the delay, executes, reads every proxy frozen and records upgrade_freezes ----
stage("govern", join(rh, "govern-freeze-execute.txt"), ["--row", FREEZE_ROW]);
const frEntry = (runManifest().upgrade_freezes ?? []).find((e: any) => String(e?.operation_id).toLowerCase() === frId.toLowerCase()) ?? fail(`govern --row ${FREEZE_ROW} wrote no upgrade_freezes entry for ${frId}`);
if (!isTx(frEntry.schedule_tx) || !isTx(frEntry.execute_tx)) fail(`the upgrade_freezes entry has no schedule or execute transaction: ${JSON.stringify(frEntry)}`);
const frSalt = governSalt(sha, TWIN_CHAIN_ID, FREEZE_ROW);
const frSchedTx = frEntry.schedule_tx as Hex, frExecTx = frEntry.execute_tx as Hex;
const targets = frEntry.targets as Record<string, FreezeTarget>;
const frCalls: TimelockCall[] = Object.values(targets).map((t) => ({ target: t.proxy as Address, data: freezeCalldata(t.implementation, t.implementation_code_hash) }));
if (frId.toLowerCase() !== (await operationId(handle, { timelock, calls: frCalls, salt: frSalt })).toLowerCase()) fail(`the upgrade_freezes operation ${frId} is not the row's freeze batch`);
for (const s of specs) {
  const r = upgradeRec.proxies?.[s.name] ?? fail(`upgradeability.json has no ${s.name}`);
  const t = targets[s.name] ?? fail(`the freeze row left ${s.name} out`);
  if (t.proxy.toLowerCase() !== String(r.proxy).toLowerCase() || t.implementation.toLowerCase() !== String(r.implementation).toLowerCase() || t.implementation_code_hash.toLowerCase() !== String(r.implementation_code_hash).toLowerCase()) fail(`the freeze target of ${s.name} is not the record verify wrote after the upgrade`);
}
for (const t of Object.values(targets)) {
  const frozen = await client.readContract({ address: t.proxy as Address, abi: [{ type: "function", name: "upgradesFrozen", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }], functionName: "upgradesFrozen" });
  if (frozen !== true) fail(`${t.proxy} reads upgradesFrozen() ${String(frozen)} after the freeze executed`);
}
say("frozen", { operation_id: frId, schedule_tx: frSchedTx, execute_tx: frExecTx, proxies: frCalls.length });
// the evidence lists the two rows wrote, as evidence-check reads them (well formed, executed once, one delay apart, no cancel field)
const minDelay = await timelockMinDelay(handle, timelock);
const listProblems = governedUpgradeProblems({ timelock: { address: timelock }, proxy_upgrades: runManifest().proxy_upgrades, upgrade_freezes: runManifest().upgrade_freezes }, Number(minDelay), specs.map((x) => x.name));
if (listProblems.length) fail(`the run manifest's governed-upgrade evidence: ${listProblems.join("; ")}`);
await waitReady([rejId]);

// ---- 6. the queued upgrade, after the freeze: the Safe tool must refuse and the proxy must revert with UpgradesAreFrozen ----
let refusal = "";
try {
  const tx = await safeTx(await executeOnTimelock(handle, { timelock, calls: [rejCall], salt: rejSalt, form: "single" }));
  fail(`the Safe EXECUTED the queued upgrade after the freeze (${tx}): the freeze did not hold`);
} catch (e) { refusal = (e as Error).message; }
const revData = await rpcCallRevert(rpc)({ from: safeAddr, to: timelock, data: executeCalldata(gwProxy, rejCall.data, rejSalt) });
if (revData === undefined || !revData.toLowerCase().startsWith(UPGRADES_ARE_FROZEN_SELECTOR)) fail(`a simulated execute of the queued upgrade by the Safe ${revData === undefined ? "succeeds" : `reverts with ${revData.slice(0, 10)}`}, want UpgradesAreFrozen (${UPGRADES_ARE_FROZEN_SELECTOR})`);
const rev = revData as Hex;
if ((await implOf(gwProxy)).toLowerCase() !== toImpl.toLowerCase()) fail("the gateway implementation moved after the freeze");
say("upgrade_refused", { operation_id: rejId, revert_selector: rev.slice(0, 10), safe_tool_refusal: refusal });

// ---- 7. final verify: the full core set frozen by governance, the claim made ----
stage("verify", join(rh, "verify-labels-post-freeze.txt"));
const finalRec = upgradeabilityNow();
if (finalRec.core_immutable !== true) fail(`the final verify makes no immutability claim: ${JSON.stringify(finalRec.immutability_refused_because)}`);

const record: UpgradeLifecycleRecord = {
  kind: LIFECYCLE_KIND, chain_id: TWIN_CHAIN_ID, core_sha: sha, safe: safeAddr,
  timelock: { address: timelock, min_delay: String(finalRec.timelock?.min_delay) },
  deploy: { upgradeability: deployRec },
  upgrade: { proxy: UPGRADED_PROXY, proxy_address: gwProxy, from_implementation: fromImpl, to_implementation: toImpl, to_code_hash: toHash, deploy_tx: deployTx,
    operation_id: upId, salt: upSalt, schedule_tx: upSchedTx, execute_tx: upExecTx, upgradeability: upgradeRec },
  rejected_upgrade: { proxy: UPGRADED_PROXY, proxy_address: gwProxy, target_implementation: fromImpl, operation_id: rejId, salt: rejSalt, schedule_tx: rejSchedTx,
    safe_tool_refusal: refusal, revert_selector: rev.slice(0, 10), revert_error: "UpgradesAreFrozen" },
  freeze: { operation_id: frId, salt: frSalt, schedule_tx: frSchedTx, execute_tx: frExecTx, targets },
  final: { upgradeability: finalRec, verifier_exit_code: 0 },
};
const out = join(rh, "upgrade-lifecycle.json");
writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
run([bun, env("TWIN_EVIDENCE_CHECK", "src/evidence-check.ts"), "--upgrade-lifecycle", out, "--rpc", rpc], { cwd: pc, stdoutTo: join(rh, "upgrade-lifecycle-evidence.txt") });
process.stdout.write(readFileSync(join(rh, "upgrade-lifecycle-evidence.txt"), "utf8"));
const ghEnv = env("GITHUB_ENV");
if (ghEnv) appendFileSync(ghEnv, `TWIN_UPGRADE_LIFECYCLE=${out}\nTWIN_UPGRADE_LIFECYCLE_EVIDENCE=${join(rh, "upgrade-lifecycle-evidence.txt")}\n`);
