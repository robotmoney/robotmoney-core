#!/usr/bin/env bun
// Issue 1811 (upgradeability stage 4): the Twin rehearsal of the governed proxy lifecycle, after twin-publish deployed the release artifacts with the upgrade
// overlay (deployments/twin-918453/upgrade-rehearsal.env: UPGRADE_MODE=upgradeable) and ran publish, verify, govern and verify. On that deployment it runs:
//   1. deploy record    the verifier's upgradeability.json after the post-govern verify: every proxy upgradeable, no immutability claim.
//   2. upgrade          the deployer creates a second copy of the gateway implementation from the build artifact (linked to the libraries the live one uses), then
//                       the governing Safe (two owner keystores sign, the deployer pays the gas) schedules upgradeToAndCall(new, "") on the timelock, the Twin
//                       clock is warped past the real delay and the Safe executes it. The gateway manifest's implementation pin is re-recorded from the chain (the
//                       operator step a governed upgrade needs, runbook 4.12) and verify runs again.
//   3. queued upgrade   the Safe schedules a second gateway upgrade (back to the first implementation) BEFORE the freeze. It is never cancelled.
//   4. freeze           the Safe schedules ONE batch: freezeUpgrades(implementation, implementation_code_hash) on every core proxy, both values taken from the
//                       upgradeability.json the verify of step 2 wrote; after the delay the Safe executes it.
//   5. refused upgrade  the Safe is asked to execute the queued upgrade of step 3: the Safe tool refuses (its simulation reverts, nothing is sent), and a
//                       simulated execute from the Safe reverts with UpgradesAreFrozen. The operation stays pending.
//   6. final verify     verify claims core immutability (an upgradeable release frozen by governance).
// It writes <TWIN_RUN_DIR>/upgrade-lifecycle.json and checks it with the evidence tool against the chain (evidence-check --upgrade-lifecycle --rpc).
// Every step goes through the real contracts, the real Safe and the real timelock; the only Twin environment step is the time warp. Any failure exits non-zero.
// Environment in: RPC_URL, TWIN_RUN_DIR (twin-publish's run directory: keys, passphrase, sheet.env, manifests), GITHUB_WORKSPACE, GITHUB_ENV (optional).
// Tests and local runs may replace the tools: TWIN_CLI (default src/cli.ts), TWIN_EVIDENCE_CHECK (default src/evidence-check.ts), CAST (cast). Never use this against Base mainnet.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, keccak256, toBytes, type Address, type Hex } from "viem";
import { TWIN_CHAIN_ID } from "../chains.ts";
import { httpRpc, latestTimestamp, requireTwin, warpTo } from "../rehearsal/twin.ts";
import { connectSafe, executeOnTimelock, executeTx, jsonLogger, keystoreSigner, operationState, scheduleOnTimelock, signTx, verifyTimelockEffect, type SafeTxBundle, type TimelockCall } from "../safe/index.ts";
import { loadStageTable, manifestBase } from "../stage-table.ts";
import { ERC1967_IMPLEMENTATION_SLOT } from "../verify/codehash.ts";
import { proxySpecs } from "../verify/upgradeability.ts";
import { UPGRADED_PROXY, UPGRADES_ARE_FROZEN_SELECTOR, executeCalldata, freezeCalldata, upgradeCalldata, LIFECYCLE_KIND, type FreezeTarget, type UpgradeLifecycleRecord } from "../upgrade-lifecycle.ts";
import { rpcCallRevert } from "../evidence-check.ts";
import { UPGRADEABILITY_MANIFEST } from "../verify-stage.ts";

const env = (k: string, d = ""): string => process.env[k] ?? d;
const fail = (m: string): never => { console.error(`twin-upgrade-lifecycle: ${m}`); process.exit(1); };
const say = (event: string, fields: Record<string, unknown> = {}) => console.error(JSON.stringify({ ts: new Date().toISOString(), event: `upgrade_lifecycle.${event}`, ...fields }));

function run(cmd: string[], opts: { cwd?: string; stdoutTo?: string; childEnv?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.childEnv }, stdout: "pipe", stderr: "inherit" });
  const out = r.stdout.toString();
  if (opts.stdoutTo) writeFileSync(opts.stdoutTo, out); else process.stdout.write(out);
  if (r.exitCode !== 0) fail(`${cmd.slice(0, 3).join(" ")} exited ${r.exitCode}`);
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
const castBin = env("CAST", "cast");
const rpcFn = httpRpc(rpc);
await requireTwin(rpcFn);

// The same CLI verb invocation twin-publish uses (one driver, the same flags).
const stage = (verb: string, stdoutTo: string) => run([bun, env("TWIN_CLI", "src/cli.ts"), verb, "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet,
  "--signer", `keystore:${key("DEPLOYER")}:${pass}`, "--environment", "stage", "--core-sha", sha, "--counts-dir", join(rh, "counts"), "--evidence", join(rh, "evidence")],
  { cwd: pc, stdoutTo, childEnv: { PUBLISH_MANIFEST_DIR: manifests, YES: "1" } });

const table = loadStageTable(core);
const specs = proxySpecs(table);
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
// The new implementation: the build's creation code with every library placeholder filled with the address the live implementation links (so it is the same
// reviewed release artifact at a new address; its immutable self-address makes its code hash differ from the first copy).
const art = json(join(core, "out", `${gw.contract}.sol`, `${gw.contract}.json`));
const liveCode = ((await client.getCode({ address: fromImpl })) ?? "0x").replace(/^0x/, "");
const libAddr = new Map<string, string>();
for (const file of Object.values<any>(art.deployedBytecode?.linkReferences ?? {})) for (const [lib, refs] of Object.entries<any>(file)) libAddr.set(lib, liveCode.slice(refs[0].start * 2, (refs[0].start + 20) * 2));
let creation = String(art.bytecode.object).replace(/^0x/, "");
for (const file of Object.values<any>(art.bytecode?.linkReferences ?? {})) for (const [lib, refs] of Object.entries<any>(file)) {
  const a = libAddr.get(lib) ?? fail(`the live ${gw.contract} implementation links no ${lib}`);
  for (const r of refs) creation = creation.slice(0, r.start * 2) + a + creation.slice((r.start + r.length) * 2);
}
if (creation.includes("__$")) fail(`${gw.contract} creation code still has an unlinked library placeholder`);
const created = JSON.parse(run([castBin, "send", "--keystore", key("DEPLOYER"), "--password-file", pass, "--rpc-url", rpc, "--json", "--create", `0x${creation}`], { stdoutTo: join(rh, "upgrade-impl-deploy.json") }));
if (created.status !== "0x1" && created.status !== 1 && created.status !== "1") fail(`the implementation deploy ${created.transactionHash} reverted`);
const toImpl = created.contractAddress as Address;
const toHash = await codeHash(toImpl);
say("implementation_deployed", { implementation: toImpl, code_hash: toHash, tx: created.transactionHash });

const upCall: TimelockCall = { target: gwProxy, data: upgradeCalldata(toImpl) };
const upSalt = saltOf("upgrade");
const upSched = await scheduleOnTimelock(handle, { timelock, calls: [upCall], salt: upSalt, form: "single", description: "rehearsal: upgrade the gateway proxy" });
const upId = upSched.timelock_operation_id as Hex;
const upSchedTx = await safeTx(upSched);
await waitReady([upId]);
const upExecTx = await safeTx(await executeOnTimelock(handle, { timelock, calls: [upCall], salt: upSalt, form: "single" }));
if ((await implOf(gwProxy)).toLowerCase() !== toImpl.toLowerCase()) fail(`after the upgrade the gateway proxy's implementation slot reads ${await implOf(gwProxy)}, not ${toImpl}`);
say("upgraded", { operation_id: upId, schedule_tx: upSchedTx, execute_tx: upExecTx });
// Re-record the gateway manifest's implementation pin from the chain: the manifest names the implementation the release runs, and the signing clients take their pin from it.
const gm = json(gwManifestPath);
gm[gw.implementationField] = toImpl;
if (`${gw.implementationField}_runtime_hash` in gm) gm[`${gw.implementationField}_runtime_hash`] = toHash;
writeFileSync(gwManifestPath, JSON.stringify(gm, null, 2) + "\n");
stage("verify", join(rh, "verify-labels-post-upgrade.txt"));
const upgradeRec = upgradeabilityNow();

// ---- 3. a second gateway upgrade, queued before the freeze and never cancelled ----
const rejCall: TimelockCall = { target: gwProxy, data: upgradeCalldata(fromImpl) };
const rejSalt = saltOf("queued-upgrade");
const rejSched = await scheduleOnTimelock(handle, { timelock, calls: [rejCall], salt: rejSalt, form: "single", description: "rehearsal: an upgrade queued before the freeze" });
const rejId = rejSched.timelock_operation_id as Hex;
const rejSchedTx = await safeTx(rejSched);
say("upgrade_queued", { operation_id: rejId, schedule_tx: rejSchedTx });

// ---- 4. the freeze of every core proxy, bound to the record verify wrote after the upgrade ----
const targets: Record<string, FreezeTarget> = {};
for (const s of specs) {
  const r = upgradeRec.proxies?.[s.name] ?? fail(`upgradeability.json has no ${s.name}`);
  targets[s.name] = { proxy: r.proxy, implementation: r.implementation, implementation_code_hash: r.implementation_code_hash };
}
const frCalls: TimelockCall[] = Object.values(targets).map((t) => ({ target: t.proxy as Address, data: freezeCalldata(t.implementation, t.implementation_code_hash) }));
const frSalt = saltOf("freeze");
const frSched = await scheduleOnTimelock(handle, { timelock, calls: frCalls, salt: frSalt, description: "rehearsal: freeze every core proxy" });
const frId = frSched.timelock_operation_id as Hex;
const frSchedTx = await safeTx(frSched);
await waitReady([frId, rejId]);
const frExecTx = await safeTx(await executeOnTimelock(handle, { timelock, calls: frCalls, salt: frSalt }));
for (const t of Object.values(targets)) {
  const frozen = await client.readContract({ address: t.proxy as Address, abi: [{ type: "function", name: "upgradesFrozen", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }], functionName: "upgradesFrozen" });
  if (frozen !== true) fail(`${t.proxy} reads upgradesFrozen() ${String(frozen)} after the freeze executed`);
}
say("frozen", { operation_id: frId, schedule_tx: frSchedTx, execute_tx: frExecTx, proxies: frCalls.length });

// ---- 5. the queued upgrade, after the freeze: the Safe tool must refuse and the proxy must revert with UpgradesAreFrozen ----
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

// ---- 6. final verify: the full core set frozen by governance, the claim made ----
stage("verify", join(rh, "verify-labels-post-freeze.txt"));
const finalRec = upgradeabilityNow();
if (finalRec.core_immutable !== true) fail(`the final verify makes no immutability claim: ${JSON.stringify(finalRec.immutability_refused_because)}`);

const record: UpgradeLifecycleRecord = {
  kind: LIFECYCLE_KIND, chain_id: TWIN_CHAIN_ID, core_sha: sha, safe: safeAddr,
  timelock: { address: timelock, min_delay: String(finalRec.timelock?.min_delay) },
  deploy: { upgradeability: deployRec },
  upgrade: { proxy: UPGRADED_PROXY, proxy_address: gwProxy, from_implementation: fromImpl, to_implementation: toImpl, to_code_hash: toHash, deploy_tx: created.transactionHash,
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
