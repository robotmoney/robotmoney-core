#!/usr/bin/env bun
// Issue 1811 (upgradeability stage 4): the Twin rehearsal of the governed proxy lifecycle, after twin-publish deployed the release artifacts with the upgrade
// overlay (deployments/twin-918453/upgrade-rehearsal.env: UPGRADE_MODE=upgradeable) and ran publish, verify, govern and verify. On that deployment it runs:
//   1. deploy record    the verifier's upgradeability.json after the post-govern verify: every proxy upgradeable, no immutability claim.
//   2. upgrade          `deploy-implementation --proxy gateway` (issue 1861): the deployer creates a second copy of the gateway implementation from the build artifact, linked to
//                       the libraries the live one uses, the verb reads its code back and records implementation_deploys (a rerun reuses the entry and sends nothing), then
//                       `govern --row upgrade-proxy` (issue 1859): the governing Safe (two owner keystores sign, the deployer pays the gas) schedules
//                       upgradeToAndCall(new, "") on the timelock, the Twin clock is warped past the real delay, the Safe executes it, and the row re-records the gateway
//                       manifest's implementation pin and records `proxy_upgrades` in the run manifest. verify runs again.
//   2b. receipt migration (issue 1910): a v0.5.0-shaped, populated receipt proxy (the legacy helper of contracts/test/helpers) behind the same timelock is upgraded to a second copy of the
//                       current receipt with `govern --row upgrade-proxy --proxy receipt --migration receipt-submitter-roles` through the real Safe and timelock. The tool builds
//                       migrateToSubmitterRoles(RouterGovernance) itself. The step asserts RECEIPT_RELEASER_ROLE on RouterGovernance only, ADMIN_ROLE on the timelock only, the receipts and
//                       retired slots unchanged, a second migration refused (InvalidInitialization), and `evidence-check --governed-upgrades --rpc` reading the scheduled data back
//                       from the chain (and failing an entry that hides the migration).
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
import { appendFileSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
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
import { FREEZE_ROW, UPGRADE_ROW, pinnedMigrationData, upgradeRecordKey } from "../upgrade-rows.ts";
import { UPGRADEABILITY_MANIFEST } from "../verify-stage.ts";
import { DEPLOY_IMPL_VERB } from "../deploy-implementation.ts";
import { ADMIN_ROLE, IC_POLICY_STANDIN, RECEIPT_IDS, castSender, deployPopulatedLegacyReceipt, keystoreAddress } from "./twin-legacy-receipt.ts";

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
const stage = (verb: string, stdoutTo: string, extra: string[] = [], exitCode = 0, manifestsDir: string = manifests) => run([bun, env("TWIN_CLI", "src/cli.ts"), verb, "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet,
  "--signer", `keystore:${key("DEPLOYER")}:${pass}`, "--environment", "stage", "--core-sha", sha, "--counts-dir", join(rh, "counts"), "--evidence", evidenceDir, ...extra],
  { cwd: pc, stdoutTo, childEnv: { PUBLISH_MANIFEST_DIR: manifestsDir, YES: "1" }, exitCode });
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

// ---- 2b. the receipt upgrade WITH its typed migration (issue 1910) ----
// The deployed v0.5.0 receipt gates recordReceipt on the gateway and lets RouterGovernance release as an ADMIN_ROLE holder. The Twin deployment already runs the current receipt, so
// this step builds the v0.5.0 shape next to it: the legacy helper (contracts/test/helpers, the Solidity-level proof is ConsensusReceiptMigration.t.sol) behind an ERC1967 proxy governed
// by the SAME timelock, populated with two receipts (one released), ADMIN_ROLE on the timelock and on the deployment's RouterGovernance. A copy of the manifests names that proxy as
// the receipt, so `govern --row upgrade-proxy --proxy receipt --migration receipt-submitter-roles` runs the real row through the real Safe and timelock. The new implementation is
// a second copy of the current receipt from `deploy-implementation --proxy receipt`. Nothing here touches the deployment the freeze below acts on.
const MIGRATION = "receipt-submitter-roles";
const rcSpec = specs.find((s) => s.name === "receipt") ?? fail("the stage table has no receipt proxy");
const governanceAddr = getAddress(json(join(manifests, "governance.json")).governance as string) as Address;
const deployerAddr = keystoreAddress(key("DEPLOYER"));
const outDir = join(core, "out");
const RECEIPT_READ_ABI = parseAbi([
  "function ADMIN_ROLE() view returns (bytes32)", "function RECEIPT_SUBMITTER_ROLE() view returns (bytes32)", "function RECEIPT_RELEASER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)", "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMember(bytes32 role, uint256 index) view returns (address)", "function getRoleAdmin(bytes32 role) view returns (bytes32)",
  "function receiptCount() view returns (uint256)", "function icPolicy() view returns (address)", "function upgradeTimelock() view returns (address)",
  "function getReceiptById(bytes32 receiptId) view returns ((bytes32 receiptId, bytes32 payloadDigest, string payloadUri, address submitter, uint64 recordedAt, uint64 releasedAt, bool released))",
]);
const MIGRATE_ABI = parseAbi(["function migrateToSubmitterRoles(address releaser)"]);
const INVALID_INITIALIZATION: Hex = keccak256(toBytes("InvalidInitialization()")).slice(0, 10) as Hex;
const INITIALIZABLE_SLOT: Hex = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
// the new implementation: a second copy of the current receipt, linked to the live libraries (the operator verb)
const rcDep = JSON.parse(stage(DEPLOY_IMPL_VERB, join(rh, "deploy-implementation-receipt.txt"), ["--proxy", rcSpec.name]).split("\n").find((l) => l.includes('"event":"deploy_implementation"')) ?? fail(`${DEPLOY_IMPL_VERB} --proxy ${rcSpec.name} printed no deploy_implementation line`));
const rcNewImpl = rcDep.implementation as Address;
if (rcDep.reused !== false) fail(`deploy-implementation --proxy receipt did not deploy: ${JSON.stringify(rcDep)}`);
const rcDepEntry = (runManifest().implementation_deploys ?? []).find((e: any) => e?.proxy_name === rcSpec.name && String(e?.implementation).toLowerCase() === rcNewImpl.toLowerCase()) ?? fail(`no implementation_deploys entry for the receipt implementation ${rcNewImpl}`);
const rcLibs = rcDepEntry.libraries as Record<string, Address>;

// the v0.5.0 receipt: the populated legacy proxy (fixture module), under the same timelock
const legacy = deployPopulatedLegacyReceipt({ send: castSender({ rpc, keystore: key("DEPLOYER"), passFile: pass, from: deployerAddr, scratchDir: rh }), outDir, libraries: rcLibs, deployer: deployerAddr, timelock, governance: governanceAddr });
const legacyProxy = legacy.proxy, legacyImpl = legacy.implementation;
const [RID1, RID2] = RECEIPT_IDS;
const rd = <T>(functionName: string, args: unknown[] = []): Promise<T> => client.readContract({ address: legacyProxy, abi: RECEIPT_READ_ABI, functionName, args } as any) as Promise<T>;
const initializedVersion = async (): Promise<bigint> => BigInt(`0x${((await client.getStorageAt({ address: legacyProxy, slot: INITIALIZABLE_SLOT })) ?? "0x0").replace(/^0x/, "").padStart(64, "0").slice(-16)}`);
const lcEq = (x: unknown, y: unknown): boolean => String(x).toLowerCase() === String(y).toLowerCase();
// the populated v0.5.0 shape before the upgrade
if (!(await rd<boolean>("hasRole", [ADMIN_ROLE, governanceAddr])) || !(await rd<boolean>("hasRole", [ADMIN_ROLE, timelock])) || (await rd<bigint>("getRoleMemberCount", [ADMIN_ROLE])) !== 2n) fail("the v0.5.0 receipt does not hold ADMIN_ROLE on the timelock and RouterGovernance only");
if ((await rd<bigint>("receiptCount")) !== 2n || (await initializedVersion()) !== 1n || (await implOf(legacyProxy)).toLowerCase() !== legacyImpl.toLowerCase()) fail("the v0.5.0 receipt proxy is not populated at initialized version 1");
const slot0Before = await client.getStorageAt({ address: legacyProxy, slot: `0x${"0".repeat(64)}` });
const receiptsBefore = [await rd<any>("getReceiptById", [RID1]), await rd<any>("getReceiptById", [RID2])];
if (receiptsBefore[0].released !== true || receiptsBefore[1].released !== false) fail("the populated receipts are not one released and one unreleased");

// the manifests the row reads: a copy that names the legacy proxy as the receipt
const sandbox = join(rh, "manifests-legacy-receipt");
cpSync(manifests, sandbox, { recursive: true });
const sandboxReceiptManifest = join(sandbox, `${manifestBase(table.stages.find((s) => s.name === rcSpec.stage)!.manifest)}.json`);
writeFileSync(sandboxReceiptManifest, JSON.stringify({ ...json(sandboxReceiptManifest), [rcSpec.field]: legacyProxy, [rcSpec.implementationField]: legacyImpl }, null, 2) + "\n");
const sandboxRecord = json(join(sandbox, UPGRADEABILITY_MANIFEST));
sandboxRecord.proxies.receipt = { ...sandboxRecord.proxies.receipt, proxy: legacyProxy, implementation: legacyImpl };
writeFileSync(join(sandbox, UPGRADEABILITY_MANIFEST), JSON.stringify(sandboxRecord, null, 2) + "\n");

// the row, with the typed migration: the tool builds migrateToSubmitterRoles(RouterGovernance) from the build ABI and the governance manifest
stage("govern", join(rh, "govern-upgrade-receipt.txt"), ["--row", UPGRADE_ROW, "--proxy", rcSpec.name, "--implementation", rcNewImpl, "--migration", MIGRATION], 0, sandbox);
const rcMigrationData = pinnedMigrationData(MIGRATION, governanceAddr);
const rcEntry = (runManifest().proxy_upgrades ?? []).find((e: any) => e?.proxy_name === rcSpec.name && e?.migration?.name === MIGRATION) ?? fail(`govern --row ${UPGRADE_ROW} --migration wrote no proxy_upgrades entry for the receipt`);
if (!lcEq(rcEntry.to_implementation, rcNewImpl) || !lcEq(rcEntry.proxy, legacyProxy) || !lcEq(rcEntry.migration.releaser, governanceAddr) || !lcEq(rcEntry.migration.data, rcMigrationData) || !lcEq(rcEntry.migration.data_hash, keccak256(rcMigrationData)) || rcEntry.migration.function !== "migrateToSubmitterRoles") fail(`the receipt proxy_upgrades entry does not record the typed migration: ${JSON.stringify(rcEntry)}`);
if (!isTx(rcEntry.schedule_tx) || !isTx(rcEntry.execute_tx)) fail(`the receipt proxy_upgrades entry has no schedule or execute transaction: ${JSON.stringify(rcEntry)}`);
const rcCall: TimelockCall = { target: legacyProxy, data: upgradeCalldata(rcNewImpl, rcMigrationData) };
const rcId = (await operationId(handle, { timelock, calls: [rcCall], salt: governSalt(sha, TWIN_CHAIN_ID, upgradeRecordKey(rcSpec.name, rcNewImpl, MIGRATION)), form: "single" })).toLowerCase();
if (String(rcEntry.operation_id).toLowerCase() !== rcId) fail(`the receipt proxy_upgrades operation ${rcEntry.operation_id} is not upgradeToAndCall(${rcNewImpl}, migrateToSubmitterRoles(${governanceAddr}))`);

// after the upgrade: the roles, the history, the slots, the one-time reinitializer
if ((await implOf(legacyProxy)).toLowerCase() !== rcNewImpl.toLowerCase()) fail(`the receipt proxy's implementation slot reads ${await implOf(legacyProxy)}, not ${rcNewImpl}`);
if ((await initializedVersion()) !== 2n) fail(`the receipt proxy's initialized version is ${await initializedVersion()}, want 2 (reinitializer(2) ran)`);
const releaserRole = await rd<Hex>("RECEIPT_RELEASER_ROLE"), submitterRole = await rd<Hex>("RECEIPT_SUBMITTER_ROLE");
if ((await rd<bigint>("getRoleMemberCount", [releaserRole])) !== 1n || !lcEq(await rd<string>("getRoleMember", [releaserRole, 0n]), governanceAddr)) fail("RECEIPT_RELEASER_ROLE is not held by RouterGovernance only");
if (await rd<boolean>("hasRole", [ADMIN_ROLE, governanceAddr])) fail("RouterGovernance still holds ADMIN_ROLE on the migrated receipt");
if ((await rd<bigint>("getRoleMemberCount", [ADMIN_ROLE])) !== 1n || !lcEq(await rd<string>("getRoleMember", [ADMIN_ROLE, 0n]), timelock)) fail("ADMIN_ROLE is not held by the timelock only");
if ((await rd<bigint>("getRoleMemberCount", [submitterRole])) !== 0n) fail("the migration granted RECEIPT_SUBMITTER_ROLE: submitters are granted by the timelock afterwards");
if ((await rd<string>("getRoleAdmin", [submitterRole])) !== ADMIN_ROLE || (await rd<string>("getRoleAdmin", [releaserRole])) !== ADMIN_ROLE) fail("the migration did not wire the role admins to ADMIN_ROLE");
if (!lcEq(await rd<string>("upgradeTimelock"), timelock)) fail("the migrated receipt's upgrade timelock moved");
if ((await rd<bigint>("receiptCount")) !== 2n) fail("the migration changed the receipt count");
for (const [i, id] of [RID1, RID2].entries()) {
  const now = await rd<any>("getReceiptById", [id]), was = receiptsBefore[i];
  if (now.receiptId !== was.receiptId || now.payloadDigest !== was.payloadDigest || now.payloadUri !== was.payloadUri || !lcEq(now.submitter, was.submitter) || now.recordedAt !== was.recordedAt || now.releasedAt !== was.releasedAt || now.released !== was.released) fail(`receipt ${id} changed in the migration: ${JSON.stringify([was, now], (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
if ((await client.getStorageAt({ address: legacyProxy, slot: `0x${"0".repeat(64)}` })) !== slot0Before || !lcEq(await rd<string>("icPolicy"), IC_POLICY_STANDIN)) fail("a retired storage slot (the writer or the IC policy) changed in the migration");
// the reinitializer cannot run twice: even the timelock is refused now
const rerun = await rpcCallRevert(rpc)({ from: timelock, to: legacyProxy, data: encodeFunctionData({ abi: MIGRATE_ABI, functionName: "migrateToSubmitterRoles", args: [governanceAddr] }) });
if (rerun === undefined || !rerun.toLowerCase().startsWith(INVALID_INITIALIZATION)) fail(`a second migrateToSubmitterRoles from the timelock ${rerun === undefined ? "succeeds" : `reverts with ${rerun.slice(0, 10)}`}, want InvalidInitialization (${INVALID_INITIALIZATION})`);
// evidence-check reads the entry back from the chain: the scheduled data must equal the typed migration, and an entry that hides the migration fails
const govEvidence = join(rh, "governed-upgrades-evidence.txt");
const rcMinDelay = String(await timelockMinDelay(handle, timelock));
const evidenceArgs = (file: string) => [bun, env("TWIN_EVIDENCE_CHECK", "src/evidence-check.ts"), "--governed-upgrades", file, "--timelock", timelock, "--governance", governanceAddr, "--delay-floor", rcMinDelay, "--rpc", rpc];
run(evidenceArgs(join(evidenceDir, "publish-run.json")), { cwd: pc, stdoutTo: govEvidence });
if (!/^evidence ok \(governed upgrades: \d+ upgrade\(s\), 1 with a typed migration, chain read\)$/m.test(readFileSync(govEvidence, "utf8"))) fail(`evidence-check --governed-upgrades did not read the migration from the chain: ${readFileSync(govEvidence, "utf8")}`);
const hidden = runManifest();
hidden.proxy_upgrades = (hidden.proxy_upgrades ?? []).map((e: any) => (e?.proxy_name === rcSpec.name ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== "migration")) : e));
const hiddenFile = join(rh, "publish-run-hidden-migration.json");
writeFileSync(hiddenFile, JSON.stringify(hidden, null, 2) + "\n");
run(evidenceArgs(hiddenFile), { cwd: pc, stdoutTo: join(rh, "governed-upgrades-evidence-hidden.txt"), exitCode: 1 });
say("receipt_migrated", { legacy_proxy: legacyProxy, legacy_implementation: legacyImpl, implementation: rcNewImpl, operation_id: rcEntry.operation_id, schedule_tx: rcEntry.schedule_tx, execute_tx: rcEntry.execute_tx, releaser: governanceAddr, data_hash: keccak256(rcMigrationData) });

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
