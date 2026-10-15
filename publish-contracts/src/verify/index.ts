import { join } from "node:path";
import { readFileSync } from "node:fs";
// The one verifier (stage 12). Same code, same labels on the Twin chain (918453) and Base mainnet (8453).
// Replaces the three superseded verifier shell scripts and the stage verifier.
// Read-only: it sends nothing.
import { encodeAbiParameters, encodeFunctionData, hexToBytes, keccak256, parseAbiItem, toFunctionSelector, toHex } from "viem";
import { Collector } from "./collector.ts";
import { PROOF_TX_NONCES } from "../counts.ts";
import { kindLabel, rehearsalDelayProblem } from "../chains.ts";
import { ERC1967_PROXY_ARTIFACT, compareDeployedCode, loadArtifact, logicCode, tryLoadArtifact } from "./codehash.ts";
import {
  ADMIN_ROLE, AGENT_ROLE, COMMITTEE_AGENT_ROLE, KEEPER_ROLE, WEIGHT_SETTER_ROLE, WEIGHT_SETTER_ROTATOR_ROLE, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, CANCELLER_ROLE, coreContracts, EMERGENCY_ROLE, EXECUTOR_ROLE, DEPOSIT_PAUSER_ROLE, PROPOSER_ROLE, SIG_AGENT_AUTHORIZED,
  RM_TOKEN, SIG_AGENT_OWNERSHIP, SIG_ROLE_GRANTED, Z32, ZERO, minDelayFloor, requiredManifests, stageManifestName,
} from "./constants.ts";
import { manifestBase } from "../stage-table.ts";
import { SAFE_MANIFEST, VAULT_ADAPTER_V4_FIELD, V4_ADAPTER_ARTIFACT_KEY, VENUE_V4 } from "../core-wiring.ts";
import { isAddress, loadManifests, lc, type ManifestVault } from "./manifests.ts";
import { padTopic, scanLogs, topicToAddress } from "./logs.ts";
import { safeChecks } from "./safe-checks.ts";
import { CODE_LABEL, finishUpgradeability, manifestDataOf, upgradeabilityChecks } from "./upgradeability.ts";
import { USDC_ADDRESS, checkUsdcCode } from "../usdc.ts";
import type { Address, ChainReader, ExpectedAsset, Hex, VaultSheet, VerifyOptions, VerifyReport } from "./types.ts";

export type { VerifyOptions, VerifyReport, Check, VerifySheet, VaultSheet, ChainReader } from "./types.ts";
export { viemReader } from "./reader.ts";
export { loadFrozenCounts, sumFrozenCounts } from "./frozen.ts";
export { verifySources } from "./sources.ts";

const HAS_ROLE = "function hasRole(bytes32 role, address account) view returns (bool)";
const hasRole = async (ch: ChainReader, at: Address, r: Hex, who: Address): Promise<boolean> =>
  (await ch.read(at, HAS_ROLE, [r, who])) as boolean;

export async function verifyDeployment(opts: VerifyOptions): Promise<VerifyReport> {
  const c = new Collector();
  const { chain, sheet } = opts;
  const { table } = opts;
  const man = loadManifests(opts.manifestDir, table);
  for (const r of opts.redeploys ?? []) {
    if (!r.replacementManifest) continue;
    const v = man.vaults.find((v) => v.key === r.vault);
    if (!v) throw new Error(`missing original generation manifest for ${r.vault}`);
    const replacement = JSON.parse(readFileSync(join(opts.manifestDir, r.replacementManifest), "utf8"));
    if (!isAddress(replacement.vault) || lc(replacement.vault) !== lc(r.newVault)) throw new Error("replacement manifest address differs from migration record");
    v.address = r.newVault;
    v.data = replacement;
    v.source = r.replacementManifest;
  }
  const safeName = manifestBase(SAFE_MANIFEST);
  const tlName = stageManifestName(table, "timelock");

  // ---- chain
  await c.runEq("chain: id equals sheet", () => chain.chainId(), sheet.chainId);

  // ---- manifests
  for (const f of requiredManifests(table)) {
    const missing = man.missing.find((m) => m.startsWith(`${f}.json`));
    c.push(`manifest: ${f}.json present`, !missing, missing ? `${missing}` : "ok");
  }
  if (man.missing.length > 0) return c.report(); // nothing below can be read without them
  for (const st of table.stages) {
    const f = manifestBase(st.manifest);
    c.eq(`manifest: ${f}.json chain_id equals sheet`, man.files[f].chain_id, sheet.chainId);
  }
  const safe = man.safe;
  if (!safe) { c.fail(`manifest: ${safeName}.json has a valid safe address`, "no valid .safe"); return c.report(); }
  c.pass(`manifest: ${safeName}.json has a valid safe address`, safe);
  const tlManifest = man.files[tlName];
  c.eq(`manifest: ${tlName}.json safe equals ${safeName}.json`, tlManifest.safe, safe);
  c.eq(`manifest: ${tlName}.json emergency equals sheet`, tlManifest.emergency, sheet.emergency);

  const core = coreContracts(table).map((x) => ({ ...x, address: man.files[x.file.replace(/\.json$/, "")][x.field] as Address }));
  const byName = Object.fromEntries(core.map((x) => [x.name, x.address])) as Record<string, Address>;
  const tl = byName.timelock!, registry = byName.registry!, router = byName.router!, gateway = byName.gateway!;

  // ---- vault set: manifests equal registry.listVaults()
  let chainVaults: string[] = [];
  let listOk = false;
  await c.run("vault set: registry.listVaults readable", async () => {
    chainVaults = ((await chain.read(registry, "function listVaults() view returns (address[])")) as string[]).map(lc);
    listOk = true;
    return { ok: true, detail: `${chainVaults.length} vaults on chain` };
  });
  const redeploys = opts.redeploys ?? [];
  if (opts.appliedReceipt && redeploys.length) opts = { ...opts, appliedReceipt: { ...opts.appliedReceipt, vaults: opts.appliedReceipt.vaults.map((v) => redeploys.find((r) => lc(r.oldVault) === lc(v))?.newVault ?? v) } };
  const manifestSet = man.vaults.map((v) => lc(v.address));
  // Issue 1796: a vault the registry still lists after a redeploy is the retired one. The label stays the same: the manifests plus the retired vaults equal the registry.
  const expectedSet = [...manifestSet, ...redeploys.map((r) => lc(r.oldVault))];
  await c.run("vault set: manifests equal registry.listVaults", async () => {
    if (!listOk) return { ok: false, detail: "listVaults unreadable" };
    const missingOnChain = expectedSet.filter((a) => !chainVaults.includes(a));
    const missingInManifest = chainVaults.filter((a) => !expectedSet.includes(a));
    const dupes = expectedSet.length !== new Set(expectedSet).size;
    const ok = !missingOnChain.length && !missingInManifest.length && !dupes;
    return { ok, detail: ok ? `${manifestSet.length} vaults${redeploys.length ? ` and ${redeploys.length} retired` : ""}` : `in manifests only: [${missingOnChain}] on chain only: [${missingInManifest}]${dupes ? " duplicate manifest address" : ""}` };
  });
  await c.run("vault set: registry vaultCount equals listVaults length", async () =>
    Number(await chain.read(registry, "function vaultCount() view returns (uint256)")) === chainVaults.length);
  await c.run("vault set: sheet and manifests name the same vaults", async () => {
    const a = man.vaults.map((v) => v.key).sort().join();
    const b = Object.keys(sheet.vaults).sort().join();
    return { ok: a === b, detail: a === b ? a : `manifests [${a}] sheet [${b}]` };
  });

  // ---- USDC is the pinned FiatTokenProxy: a mock token fails here
  await c.run("usdc: code hash equals pinned FiatTokenProxy", async () => checkUsdcCode(await chain.getCode(USDC_ADDRESS), opts.usdcCodeHash));

  // ---- code present
  // core 1676: the V4 swap adapter a vault stage deployed (the agent vault manifest names it) is checked like a core contract.
  const v4Adapters = man.vaults.flatMap((v) => (isAddress(v.data?.[VAULT_ADAPTER_V4_FIELD]) && lc(v.data[VAULT_ADAPTER_V4_FIELD]) !== lc(ZERO) ? [{ vault: v.key, address: v.data[VAULT_ADAPTER_V4_FIELD] as Address }] : []));
  const targets: { name: string; address: Address }[] = [
    ...core.map((x) => ({ name: x.name, address: x.address })),
    ...man.vaults.map((v) => ({ name: `vault[${v.key}]`, address: v.address })),
    ...v4Adapters.map((a) => ({ name: `adapter[V4:${a.vault}]`, address: a.address })),
  ];
  for (const t of targets) await c.run(`${t.name}: has code`, async () => (await chain.getCode(t.address)).length > 2);

  // ---- role matrix on the core contracts
  const D = sheet.deployer;
  const roleChecks = async (name: string, at: Address) => {
    await c.runEq(`${name}: ADMIN_ROLE held by timelock`, () => hasRole(chain, at, ADMIN_ROLE, tl), true);
    await c.runEq(`${name}: ADMIN_ROLE not held by deployer`, () => hasRole(chain, at, ADMIN_ROLE, D), false);
    await c.runEq(`${name}: DEFAULT_ADMIN not held by deployer`, () => hasRole(chain, at, Z32, D), false);
    await c.runEq(`${name}: ADMIN_ROLE not held by pauser`, () => hasRole(chain, at, ADMIN_ROLE, sheet.pauser), false);
    await c.runEq(`${name}: ADMIN_ROLE not held by emergency`, () => hasRole(chain, at, ADMIN_ROLE, sheet.emergency), false);
    await c.runEq(`${name}: ADMIN_ROLE not held by safe`, () => hasRole(chain, at, ADMIN_ROLE, safe), false);
  };
  for (const n of ["gateway", "registry", "router", "governance", "icpolicy", "receipt"]) await roleChecks(n, byName[n]);
  for (const n of ["gateway", "icpolicy", "receipt"]) await c.runEq(`${n}: DEFAULT_ADMIN held by timelock`, () => hasRole(chain, byName[n], Z32, tl), true);
  await c.runEq("gateway: DEPOSIT_PAUSER_ROLE held by pauser", () => hasRole(chain, gateway, DEPOSIT_PAUSER_ROLE, sheet.pauser), true);
  await c.runEq("gateway: DEPOSIT_PAUSER_ROLE not held by deployer", () => hasRole(chain, gateway, DEPOSIT_PAUSER_ROLE, D), false);
  await c.runEq("router: ADMIN_ROLE held by governance", () => hasRole(chain, router, ADMIN_ROLE, byName.governance), true);
  // setWeights is gated by WEIGHT_SETTER_ROLE: only RouterGovernance holds it, so the timelock and the Safe reach it only through applyReceipt (issue 1698).
  await c.runEq("router: WEIGHT_SETTER_ROLE held by governance", () => hasRole(chain, router, WEIGHT_SETTER_ROLE, byName.governance), true);
  const setterHolders: Array<[string, Address]> = [["timelock", tl], ["deployer", D], ["safe", safe], ["pauser", sheet.pauser], ["emergency", sheet.emergency]];
  for (const [who, addr] of setterHolders) {
    await c.runEq(`router: WEIGHT_SETTER_ROLE not held by ${who}`, () => hasRole(chain, router, WEIGHT_SETTER_ROLE, addr), false);
  }
  // Rotation of the weight setter (core 1616, ADR-0002): exactly one holder, a Safe-only proposer, a timelock-only executor, and nothing pending.
  // A pending rotation fails closed: the run is not accepted mid-rotation. After a completed rotation the governance manifest names the new holder.
  await c.runEq("router: WEIGHT_SETTER_ROLE has exactly one holder", async () => (await chain.read(router, "function getRoleMemberCount(bytes32 role) view returns (uint256)", [WEIGHT_SETTER_ROLE])) as bigint, 1n);
  await c.runEq("router: no weight setter rotation pending", async () => {
    const [holder] = (await chain.read(router, "function pendingWeightSetterRotation() view returns (address newHolder, uint64 proposedAt)")) as [string, bigint];
    return lc(holder);
  }, lc(ZERO));
  for (const r of ["WEIGHT_SETTER_ROTATOR_ROLE", "WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE"] as const) {
    const id = r === "WEIGHT_SETTER_ROTATOR_ROLE" ? WEIGHT_SETTER_ROTATOR_ROLE : WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE;
    await c.runEq(`router: ${r} has exactly one holder`, async () => (await chain.read(router, "function getRoleMemberCount(bytes32 role) view returns (uint256)", [id])) as bigint, 1n);
  }
  await c.runEq("router: WEIGHT_SETTER_ROTATOR_ROLE held by safe", () => hasRole(chain, router, WEIGHT_SETTER_ROTATOR_ROLE, safe), true);
  for (const [who, addr] of [["timelock", tl], ["deployer", D], ["governance", byName.governance!], ["pauser", sheet.pauser], ["emergency", sheet.emergency]] as Array<[string, Address]>) {
    await c.runEq(`router: WEIGHT_SETTER_ROTATOR_ROLE not held by ${who}`, () => hasRole(chain, router, WEIGHT_SETTER_ROTATOR_ROLE, addr), false);
  }
  await c.runEq("router: WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE held by timelock", () => hasRole(chain, router, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, tl), true);
  for (const [who, addr] of [["safe", safe], ["deployer", D], ["governance", byName.governance!], ["pauser", sheet.pauser], ["emergency", sheet.emergency]] as Array<[string, Address]>) {
    await c.runEq(`router: WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE not held by ${who}`, () => hasRole(chain, router, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, addr), false);
  }
  await c.runEq("gateway: not paused", () => chain.read(gateway, "function depositsPaused() view returns (bool)"), false);
  // The router-first split (core 1493): the gateway and the registry both name the router the router stage deployed.
  await c.runEq("gateway: router() equals the deployed router", async () => lc((await chain.read(gateway, "function router() view returns (address)")) as string), lc(router));
  await c.runEq("registry: router() equals the deployed router", async () => lc((await chain.read(registry, "function router() view returns (address)")) as string), lc(router));

  // ---- the weight setter (issue 1698): applyReceipt is gated by governance's own WEIGHT_SETTER_ROLE, held by the timelock alone, and releases receipts on the deployed
  // receipt register, whose ADMIN_ROLE it holds. Its runtime code has no voting function.
  const gov = byName.governance!;
  await c.runEq("governance: WEIGHT_SETTER_ROLE (applyReceipt) held by timelock", () => hasRole(chain, gov, WEIGHT_SETTER_ROLE, tl), true);
  await c.runEq("governance: WEIGHT_SETTER_ROLE (applyReceipt) has exactly one holder", async () => (await chain.read(gov, "function getRoleMemberCount(bytes32 role) view returns (uint256)", [WEIGHT_SETTER_ROLE])) as bigint, 1n);
  await c.runEq("governance: router() equals the deployed router", async () => lc((await chain.read(gov, "function router() view returns (address)")) as string), lc(router));
  await c.runEq("governance: receipts() equals the deployed receipt register", async () => lc((await chain.read(gov, "function receipts() view returns (address)")) as string), lc(byName.receipt!));
  await c.runEq("receipt: ADMIN_ROLE held by governance (applyReceipt releases)", () => hasRole(chain, byName.receipt!, ADMIN_ROLE, gov), true);
  await c.run("governance: runtime code has no voting function", async () => {
    // Issue 1808: RouterGovernance runs behind an ERC-1967 proxy, so the scan reads the implementation's code.
    const found = votingSelectorsIn(await logicCode(chain, gov, tryLoadArtifact(opts.artifactsDir, ERC1967_PROXY_ARTIFACT)));
    return { ok: found.length === 0, detail: found.length ? `voting selectors in the runtime code: ${found.join(", ")}` : `none of the ${VOTING_SIGNATURES.length} deleted voting signatures is dispatched` };
  });

  // ---- deploy-time configuration, set by the deployer before the handover and never touched by govern (issue 1520)
  await deployTimeChecks(c, chain, sheet, { router, vaults: man.vaults, receipt: byName.receipt!, applied: opts.appliedReceipt });

  // ---- vaults
  for (const v of man.vaults) await vaultChecks(c, chain, v, sheet.vaults[v.key], { tl, registry, safe, sheet, recorder: byName.recorder!, artifactsDir: opts.artifactsDir, v4AdapterArtifact: table.artifacts[V4_ADAPTER_ARTIFACT_KEY] });

  // ---- gateway agents, derived from logs
  const head = await chain.blockNumber().catch(() => undefined);
  const chunk = opts.logChunk ?? 2000;
  const retryBaseMs = opts.retryBaseMs ?? 500;
  if (head === undefined) {
    for (const l of AGENT_LABELS) c.fail(l, "block number unreadable");
    for (const v of man.vaults) for (const l of vaultScanLabels(v)) c.fail(l, "block number unreadable");
    c.fail("deployer: holds no role on any contract (log scan)", "block number unreadable");
    c.fail(ROLE_HOLDERS_LABEL, "block number unreadable");
  } else {
    // each label is a c.run, so a failed log scan fails that label with the error and never skips it
    for (const v of man.vaults) await vaultScanChecks(c, chain, v, sheet.vaults[v.key], sheet.emergency, { fromBlock: opts.fromBlock, head, chunk, retryBaseMs });
    await agentChecks(c, chain, gateway, tlManifest, { fromBlock: opts.fromBlock, head: opts.handoverBlock !== undefined && opts.handoverBlock < head ? opts.handoverBlock : head, chunk, retryBaseMs });
    await roleScan(c, chain, D, { fromBlock: opts.fromBlock, head, chunk, retryBaseMs });
    await roleHolderEnumeration(c, chain, [...core, ...man.vaults.map((v) => ({ name: `vault[${v.key}]`, address: v.address }))], {
      timelock: tl, accounts: [tl, safe, byName.governance!, sheet.emergency, sheet.pauser], icPolicy: byName.icpolicy!, gateway, router,
    }, { fromBlock: opts.fromBlock, head, chunk, retryBaseMs });
  }

  // ---- timelock
  const kind = sheet.deploymentKind ?? "production";
  const floor = minDelayFloor(sheet.chainId, kind);
  let delay = 0n;
  await c.run("timelock: min delay at least chain floor", async () => {
    delay = BigInt((await chain.read(tl, "function getMinDelay() view returns (uint256)")) as bigint);
    return { ok: delay >= BigInt(floor), detail: `delay ${delay}, floor ${floor} (deployment kind ${kind})` };
  });
  // Issue 1727: the kind and the delay on chain must agree, so a rehearsal can never be read as production. A production verify against a delay below the production
  // floor fails above (and here). A rehearsal verify against a delay at or above the production floor fails here. The label states the kind and the delay.
  // The label text is the same for both kinds (the Twin and mainnet label sets stay identical); the kind and the delay are in the detail and in the verify.deployment_kind log event.
  await c.run("deployment kind: the timelock delay agrees with the kind", async () => {
    if (kind === "production") return { ok: delay >= BigInt(minDelayFloor(sheet.chainId, "production")), detail: `${kindLabel(kind, delay)} a production deployment needs a delay of at least ${minDelayFloor(sheet.chainId, "production")}, the chain reads ${delay}` };
    const why = rehearsalDelayProblem(delay);
    return { ok: why === "", detail: why === "" ? `${kindLabel(kind, delay)} rehearsal delay ${delay}` : `${kindLabel(kind, delay)} rehearsal: ${why}` };
  });
  await c.run("timelock: min delay equals sheet", async () => ({ ok: delay === BigInt(sheet.timelockDelay), detail: `delay ${delay}, sheet ${sheet.timelockDelay}` }));
  // Policy (core 1521): PROPOSER_ROLE and CANCELLER_ROLE are the Safe only. EXECUTOR_ROLE is open (address(0)).
  c.eq("timelock: manifest executorPolicy is open", tlManifest.executorPolicy, "open");
  c.eq("timelock: manifest cancellerPolicy is safe-only", tlManifest.cancellerPolicy, "safe-only");
  for (const [nm, r] of [["PROPOSER_ROLE", PROPOSER_ROLE], ["CANCELLER_ROLE", CANCELLER_ROLE]] as const) {
    await c.runEq(`timelock: ${nm} held by safe`, () => hasRole(chain, tl, r, safe), true);
    await c.runEq(`timelock: ${nm} not held by deployer`, () => hasRole(chain, tl, r, D), false);
    await c.runEq(`timelock: ${nm} not open to address zero`, () => hasRole(chain, tl, r, ZERO), false);
  }
  await c.runEq("timelock: EXECUTOR_ROLE open to address zero", () => hasRole(chain, tl, EXECUTOR_ROLE, ZERO), true);
  await c.runEq("timelock: EXECUTOR_ROLE not held by deployer", () => hasRole(chain, tl, EXECUTOR_ROLE, D), false);
  await timelockHolderScan(c, chain, tl, safe, { fromBlock: opts.fromBlock, head, chunk, retryBaseMs });
  await c.runEq("timelock: admin role held by timelock itself", () => hasRole(chain, tl, Z32, tl), true);
  await c.runEq("timelock: admin role not held by deployer", () => hasRole(chain, tl, Z32, D), false);
  await c.runEq("timelock: admin role not held by safe", () => hasRole(chain, tl, Z32, safe), false);

  // ---- safe
  await safeChecks(c, chain, safe, sheet, tlManifest.code_hashes?.safe, opts.controlProof);

  // ---- libraries recorded
  const libNames = Object.keys(man.libraries).sort();
  c.push(`libraries: recorded in ${stageManifestName(table, "libs")}.json`, libNames.length > 0, libNames.length ? `${libNames.length} recorded` : "none recorded");
  for (const n of libNames) await c.run(`library[${n}]: has code`, async () => (await chain.getCode(man.libraries[n])).length > 2);

  // ---- code hashes against the build, immutables and links masked
  // Issue 1796: after a redeploy only the new vault runs the current build. The others (and the retired vault, below) run the build of the original deployment sha.
  const redeployed = new Set(redeploys.map((r) => r.vault));
  const priorDir = opts.priorArtifactsDir;
  const codeTargets: { label: string; address: Address; artifact: string; dir?: string }[] = [
    ...core.map((x) => ({ label: x.name, address: x.address, artifact: x.artifact })),
    ...man.vaults.map((v) => ({ label: `vault[${v.key}]`, address: v.address, artifact: sheet.vaults[v.key]?.contract ?? v.artifact, ...(redeploys.length > 0 && !redeployed.has(v.key) ? { dir: priorDir } : {}) })),
    ...v4Adapters.map((a) => ({ label: `adapter[V4:${a.vault}]`, address: a.address, artifact: table.artifacts[V4_ADAPTER_ARTIFACT_KEY]! })),
    ...libNames.map((n) => ({ label: `library[${n}]`, address: man.libraries[n], artifact: man.libraryArtifacts[n]! })),
  ];
  for (const t of codeTargets) {
    await c.run(`${t.label}: ${CODE_LABEL}`, async () => {
      // Issue 1808: a core contract behind an ERC-1967 proxy is checked through the implementation its slot names.
      const r = await compareDeployedCode(chain, t.address, loadArtifact(t.dir ?? opts.artifactsDir, t.artifact), tryLoadArtifact(t.dir ?? opts.artifactsDir, ERC1967_PROXY_ARTIFACT));
      return { ok: r.ok, detail: `${t.artifact}: ${r.detail}${!r.ok && redeploys.length > 0 && t.dir === undefined && t.label.startsWith("vault[") ? " (after a redeploy the vaults it did not replace run the original build: pass --prior-out <forge out/ of the original sha>)" : ""}` };
    });
  }

  // ---- upgradeability (issue 1809): every proxied core contract is the build's ERC-1967 proxy in the sheet's release mode, governed by the timelock alone
  const upgradeability = await upgradeabilityChecks(c, chain, table, { sheet, timelock: tl, artifactsDir: opts.artifactsDir, coreDir: opts.coreDir, data: manifestDataOf(table, man.files, man.vaults), now: opts.now });

  // ---- single-vault redeploys (issue 1796): only when the run has one, so a run without one keeps the label set of every other deployment
  for (const r of redeploys) await redeployChecks(c, chain, r, { registry, router: byName.router!, tl, emergency: sheet.emergency, vaults: man.vaults, priorDir, artifactsDir: opts.artifactsDir, artifact: man.vaults.find((v) => v.key === r.vault)?.artifact });

  // ---- deployer nonce equals the sum of the frozen counts
  await c.run("deployer: nonce equals sum of frozen counts", async () => {
    // the deployer also sent the one prove-control transaction (core 1712), which is outside every stage count
    // rehearsal (issue 1727): the deployer was not fresh, the run manifest recorded the nonce it started at. Production has no start: 0.
    const start = kind === "rehearsal" ? (opts.deployerStartNonce ?? Number.NaN) : 0;
    const want = start + Object.values(opts.frozenCounts).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES;
    const wantNow = want + (opts.redeployDeployerTxs ?? 0); // the single-vault redeploys' deploy transactions (issue 1796) are outside every frozen stage count
    const got = await chain.nonce(D);
    const frozen = Object.keys(opts.frozenCounts).length > 0;
    // After govern the deployer has paid Safe execTransaction gas, so the live nonce is above the sum. The runner's own record of the nonce
    // at the end of the deploy stages stands in for it, and the live nonce may only be at or above that record.
    const rec = opts.deployerNonceAtDeployEnd;
    if (rec !== undefined) return { ok: frozen && rec === want && got >= rec, detail: `recorded nonce at deploy end ${rec}, frozen sum plus the prove-control transaction ${want}, live nonce ${got} (govern ran)` };
    return { ok: frozen && got === wantNow, detail: `nonce ${got}, frozen sum plus the prove-control transaction ${want}${wantNow !== want ? ` plus ${wantNow - want} redeploy transaction(s)` : ""}` };
  });

  // ---- the immutability claim (issue 1809), last: it needs every other check of the run
  finishUpgradeability(c, table, upgradeability);
  return { ...c.report(), upgradeability };
}

async function deployTimeChecks(
  c: Collector, chain: ChainReader, sheet: VerifyOptions["sheet"], at: { router: Address; vaults: ManifestVault[]; receipt: Address; applied?: VerifyOptions["appliedReceipt"] },
): Promise<void> {
  const read = async (fn: string): Promise<[string[], bigint[]] | undefined> => {
    try { return (await chain.read(at.router, `function ${fn}() view returns (address[] vaults, uint256[] bps)`)) as [string[], bigint[]]; } catch { return undefined; }
  };
  const key = (v: [string[], bigint[]] | undefined) => (v ? v[0].map((x, i) => `${lc(x)}:${v[1][i]}`).join(",") : undefined);
  const addrOf = new Map(at.vaults.map((v) => [v.key, v.address]));
  const missing = sheet.defaultWeights.filter((w) => !addrOf.has(w.vault)).map((w) => w.vault);
  const sheetWant = missing.length ? undefined : sheet.defaultWeights.map((w) => `${lc(addrOf.get(w.vault)!)}:${w.bps}`).join(",");
  // Issue 1696, issue 1698: `govern --row apply-receipt` sets the router's ACTIVE vector to the applied receipt's (applyReceipt -> setWeights). The DEFAULT vector stays the sheet's.
  const appliedWant = at.applied ? at.applied.vaults.map((v, i) => `${lc(v)}:${at.applied!.bps[i]}`).join(",") : undefined;
  await c.run("router: default weights equal sheet", async () => {
    const got = key(await read("getDefaultWeights"));
    if (got === undefined) return { ok: false, detail: "getDefaultWeights unreadable" };
    if (sheetWant === undefined) return { ok: false, detail: `no manifest vault for ${missing.join(",")}` };
    return { ok: got === sheetWant, detail: got === sheetWant ? `${sheet.defaultWeights.length} weights` : `got ${got}, want ${sheetWant}` };
  });
  // Issue 1743: the DEFAULT vector alone is not what the router routes by. The active vector overrides it while votedWeightsActive is true: the deploy leaves none, an applied
  // receipt leaves its own. The EFFECTIVE vector (what deposits use) must be the sheet's launch vector, or the applied receipt's.
  await c.runEq("router: votedWeightsActive is true only after an applied receipt", () => chain.read(at.router, "function votedWeightsActive() view returns (bool)"), at.applied !== undefined);
  await c.run("router: effective weights equal the sheet's launch vector", async () => {
    const got = key(await read("getEffectiveWeights"));
    if (got === undefined) return { ok: false, detail: "getEffectiveWeights unreadable" };
    const want = appliedWant ?? sheetWant;
    if (want === undefined) return { ok: false, detail: `no manifest vault for ${missing.join(",")}` };
    return { ok: got === want, detail: got === want ? `effective weights ${appliedWant !== undefined ? `set by the applied receipt ${at.applied!.receiptId}` : "are the launch vector"}` : `getEffectiveWeights is ${got}, want ${want}` };
  });
  // Always present, so the label set is the same with and without an application. Nothing applied: nothing to check. Applied: released, and the vector is the router's active one.
  await c.run("receipt: applied receipt is released and its weights are on the router", async () => {
    if (!at.applied) return { ok: true, detail: "no receipt applied by govern" };
    const released = (await chain.read(at.receipt, "function isReleased(bytes32 receiptId) view returns (bool)", [at.applied.receiptId])) as boolean;
    if (!released) return { ok: false, detail: `receipt ${at.applied.receiptId} reads not released` };
    const got = key(await read("getWeights"));
    return { ok: got === appliedWant, detail: got === appliedWant ? `receipt ${at.applied.receiptId} released, ${at.applied.vaults.length} weights active on the router` : `router getWeights ${got}, the applied receipt's vector is ${appliedWant}` };
  });
}

/** The RouterGovernance voting surface deleted by issue 1698. The final artifact must dispatch none of them. */
export const VOTING_SIGNATURES = [
  "propose(address[],uint256[])", "vote(uint256)", "execute(uint256)", "cancel(uint256)", "proposalState(uint256)", "activeProposal()", "cadenceParams()",
  "hasVoted(uint256,address)", "proposalVoteSnapshot(uint256)", "getPastVotes(address,uint256)", "setQuorumThreshold(uint256)", "setVotingPeriod(uint64)",
  "setExecutionDelay(uint64)", "setVotingPower(address,uint256)", "votingPower(address)", "totalVotingPower()", "quorumThreshold()", "votingPeriod()",
  "executionDelay()", "nextProposalId()", "proposals(uint256)",
] as const;

/**
 * The voting signatures whose selector the runtime code dispatches: a PUSH4 of the selector, walking opcodes so PUSH immediates are never read as
 * instructions. Solidity's dispatcher pushes every external selector, so an empty list means none of them is callable.
 */
export function votingSelectorsIn(code: Hex): string[] {
  const b = hexToBytes(code);
  const pushed = new Set<string>();
  for (let i = 0; i < b.length; i++) {
    const op = b[i]!;
    if (op === 0x63 && i + 4 < b.length) pushed.add(toHex(b.slice(i + 1, i + 5)));
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return VOTING_SIGNATURES.filter((sig) => pushed.has(toFunctionSelector(sig)));
}

async function vaultChecks(
  c: Collector, chain: ChainReader, v: ManifestVault, vs: VaultSheet | undefined,
  ctx: { tl: Address; registry: Address; safe: Address; sheet: VerifyOptions["sheet"]; recorder: Address; artifactsDir: string; v4AdapterArtifact?: string },
): Promise<void> {
  const p = `vault[${v.key}]`;
  const { tl, registry, safe, sheet } = ctx;
  const D = sheet.deployer;
  const a = v.address;
  await c.runEq(`${p}: ADMIN_ROLE held by timelock`, () => hasRole(chain, a, ADMIN_ROLE, tl), true);
  await c.runEq(`${p}: ADMIN_ROLE not held by deployer`, () => hasRole(chain, a, ADMIN_ROLE, D), false);
  await c.runEq(`${p}: DEFAULT_ADMIN not held by deployer`, () => hasRole(chain, a, Z32, D), false);
  await c.runEq(`${p}: ADMIN_ROLE not held by pauser`, () => hasRole(chain, a, ADMIN_ROLE, sheet.pauser), false);
  await c.runEq(`${p}: ADMIN_ROLE not held by emergency`, () => hasRole(chain, a, ADMIN_ROLE, sheet.emergency), false);
  await c.runEq(`${p}: ADMIN_ROLE not held by safe`, () => hasRole(chain, a, ADMIN_ROLE, safe), false);
  await c.runEq(`${p}: EMERGENCY_ROLE held by emergency key`, () => hasRole(chain, a, EMERGENCY_ROLE, sheet.emergency), true);
  await c.runEq(`${p}: EMERGENCY_ROLE not held by deployer`, () => hasRole(chain, a, EMERGENCY_ROLE, D), false);
  await c.runEq(`${p}: registry link`, () => chain.read(a, "function registry() view returns (address)"), registry);
  // setRegistry is one-shot: a second call from the deployer must revert (core 1483).
  await c.run(`${p}: a second setRegistry reverts`, async () => {
    const r = await chain.callRaw(a, encodeFunctionData({ abi: [parseAbiItem("function setRegistry(address registry)")], functionName: "setRegistry", args: [registry] }), D);
    return { ok: !r.ok, detail: r.ok ? "the call succeeded" : `reverted: ${r.reason ?? "no reason"}` };
  });
  if (!vs) {
    for (const l of ["tvlCap equals sheet", "perDepositCap equals sheet", "exitFeeBps equals sheet", "feeRecipient equals sheet", "feeRecipient is not deployer", "paused state equals sheet", "router eligibility equals sheet"]) c.fail(`${p}: ${l}`, "no sheet entry for this vault");
    if (v.kind !== "usdc") for (const l of ["asset config equals sheet", ...BASKET_GUARD_LABELS]) c.fail(`${p}: ${l}`, "no sheet entry for this vault");
    if (v.kind !== "usdc") c.fail(`${p}: ${SLIPPAGE_LABEL}`, "no sheet entry for this vault");
    if (v.kind === "usdc") { for (const l of ["seed present", "totalSupply above zero", "manifest deployer share balance after seed is zero", "seed share receiver is named and is not the deployer", "deployer holds no shares", "seed share receiver holds the seed shares"]) c.fail(`${p}: ${l}`, "no sheet entry for this vault"); }
    return;
  }
  await c.runEq(`${p}: tvlCap equals sheet`, () => chain.read(a, "function tvlCap() view returns (uint256)"), vs.tvlCap);
  await c.runEq(`${p}: perDepositCap equals sheet`, () => chain.read(a, "function perDepositCap() view returns (uint256)"), vs.perDepositCap);
  await c.runEq(`${p}: exitFeeBps equals sheet`, () => chain.read(a, "function exitFeeBps() view returns (uint256)"), vs.exitFeeBps);
  await c.runEq(`${p}: feeRecipient equals sheet`, () => chain.read(a, "function feeRecipient() view returns (address)"), vs.feeRecipient);
  await c.run(`${p}: feeRecipient is not deployer`, async () =>
    lc((await chain.read(a, "function feeRecipient() view returns (address)")) as string) !== lc(D));
  await c.runEq(`${p}: paused state equals sheet`, () => chain.read(a, "function depositsPaused() view returns (bool)"), vs.expectPaused);
  await c.runEq(`${p}: router eligibility equals sheet`, () => chain.read(registry, "function isRouterEligible(address vault) view returns (bool)", [a]), vs.routerEligible);
  if (v.kind === "usdc") {
    await c.run(`${p}: seed present`, async () => {
      const total = BigInt((await chain.read(a, "function totalAssets() view returns (uint256)")) as bigint);
      const seed = vs.seed ?? 0n;
      return { ok: seed > 0n && total >= (seed * 9999n) / 10000n, detail: `totalAssets ${total}, seed ${seed}` };
    });
    await c.run(`${p}: totalSupply above zero`, async () =>
      BigInt((await chain.read(a, "function totalSupply() view returns (uint256)")) as bigint) > 0n);
    await seedShareChecks(c, chain, v, D, vs.seedShareReceiver);
  } else {
    await c.run(`${p}: asset config equals sheet`, async () => assetReadBack(chain, a, vs.assets));
    await basketGuardChecks(c, chain, a, p, vs);
    // rmAGENT launches holding RM only (core 1554). "asset config equals sheet" ties the chain to the sheet, so this ties the sheet to RM.
    if (v.kind === "agent") await c.run(`${p}: holds RM as its one asset`, async () => ({ ok: vs.assets.length === 1 && lc(vs.assets[0]!.token) === lc(RM_TOKEN), detail: `sheet lists [${vs.assets.map((a) => a.token).join(", ")}], expected only ${RM_TOKEN}` }));
    // core 1676: every UniswapV4 asset is wired to the permissionless price recorder, the V4 adapter and the configured PoolKey.
    for (const asset of vs.assets.filter((x) => x.venue === VENUE_V4)) await v4AssetChecks(c, chain, v, asset, ctx);
    // core 1695, issue 1705 C4: the swap bound is read back from every basket and compared with the config (its maxSlippageBps, else the vault default).
    // rmAGENT's config raises it to 500 because the V4 pool fee alone is 291 bps.
    await c.run(`${p}: ${SLIPPAGE_LABEL}`, async () => {
      if (vs.maxSlippageBps === undefined) return { ok: false, detail: "the sheet has no expected maxSlippageBps for this vault" };
      const got = BigInt((await chain.read(a, "function maxSlippageBps() view returns (uint256)")) as bigint);
      return { ok: got === vs.maxSlippageBps, detail: `chain ${got}, config ${vs.maxSlippageBps}` };
    });
  }
}

/** Every basket's maxSlippageBps equals the config value the deploy applies, or the vault default when the config sets none (core 1676, 1695, issue 1705 C4). */
const SLIPPAGE_LABEL = "maxSlippageBps equals config";
/** Issue 1705 C5, C4: log-enumerated per-vault role and allowlist labels (vaultScanChecks). */
const KEEPER_LABEL = "KEEPER_ROLE has no holder";
const EMERGENCY_ONE_LABEL = "EMERGENCY_ROLE has exactly one holder";
const ADAPTERS_LABEL = "adapter set, caps and code-hash allowlist equal the deploy script";
const SIG_ADAPTER_ALLOWED = "AdapterAllowedSet(address,bool)";
const SIG_CODEHASH_ALLOWED = "AdapterCodeHashAllowedSet(bytes32,bool)";

/** The labels vaultScanChecks pushes for one vault. */
export const vaultScanLabels = (v: ManifestVault): string[] => [KEEPER_LABEL, EMERGENCY_ONE_LABEL, ...(v.kind === "usdc" ? [ADAPTERS_LABEL] : [])].map((l) => `vault[${v.key}]: ${l}`);

/** The accounts that hold `role` on `at` now: every RoleGranted grantee in the scanned range that hasRole still answers true for. */
async function currentHolders(chain: ChainReader, at: Address, role: Hex, s: { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number }): Promise<Address[]> {
  const logs = await scanLogs(chain, { address: at, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), role], fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs });
  const out: Address[] = [];
  for (const who of new Set(logs.map((l) => lc(topicToAddress(l.topics[2]))))) if (await hasRole(chain, at, role, who as Address)) out.push(who as Address);
  return out;
}

/** Issue 1833: why the scan from `fromBlock` cannot see the vault's whole history (it has code at fromBlock - 1, or that read failed), or undefined. */
async function createdBefore(chain: ChainReader, at: Address, fromBlock: bigint): Promise<string | undefined> {
  if (fromBlock === 0n) return undefined;
  const before = fromBlock - 1n;
  try {
    const code = await chain.getCode(at, before);
    return code.length > 2 ? `from-block ${fromBlock} is after the vault's creation: ${at} already has code at block ${before}, so a role or allowlist grant before the scan start is never seen. Pass the block of the first deploy receipt` : undefined;
  } catch (e) {
    return `the vault's code at block ${before} (the block before from-block) is not readable, so the scan start cannot be shown to precede the vault's creation: ${(e as Error).message}`;
  }
}

/**
 * Issue 1705. Per vault, from the logs: no account holds KEEPER_ROLE (RobotMoneyVault.rebalance; the deploy grants it to nobody, and a basket has no keeper), EMERGENCY_ROLE has
 * exactly one holder and it is the sheet's emergency key. For rmUSDC also: the active adapters and their caps are the deploy script's, in order, and the adapter and
 * code-hash allowlists hold exactly those adapters and their code hashes (every AdapterAllowedSet and AdapterCodeHashAllowedSet key still allowed is enumerated).
 */
async function vaultScanChecks(
  c: Collector, chain: ChainReader, v: ManifestVault, vs: VaultSheet | undefined, emergency: Address,
  s: { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number },
): Promise<void> {
  const p = `vault[${v.key}]`;
  const a = v.address;
  // Issue 1833: the scans see only grants from fromBlock on. A vault that already has code at fromBlock - 1 was created earlier, so a grant before the scan start
  // would never be seen: every scan label of the vault fails instead of passing on a partial log.
  const late = await createdBefore(chain, a, s.fromBlock);
  if (late !== undefined) { for (const l of vaultScanLabels(v)) c.fail(l, late); return; }
  await c.run(`${p}: ${KEEPER_LABEL}`, async () => {
    const h = await currentHolders(chain, a, KEEPER_ROLE, s);
    return { ok: h.length === 0, detail: h.length ? `KEEPER_ROLE held by ${h.join(", ")}` : "no KEEPER_ROLE grant is held" };
  });
  await c.run(`${p}: ${EMERGENCY_ONE_LABEL}`, async () => {
    const h = await currentHolders(chain, a, EMERGENCY_ROLE, s);
    return { ok: h.length === 1 && lc(h[0]!) === lc(emergency), detail: `holders ${h.join(", ") || "none"}, want only the emergency key ${emergency}` };
  });
  if (v.kind !== "usdc") return;
  await c.run(`${p}: ${ADAPTERS_LABEL}`, async () => {
    const want = vs?.adapters;
    if (!want || want.length === 0) return { ok: false, detail: "the sheet has no expected adapters for this vault" };
    const active: string[] = [];
    for (let i = 0; i < 64; i++) {
      let r: any;
      try { r = await chain.read(a, "function adapters(uint256) view returns (address adapter, uint16 capBps, bool active)", [BigInt(i)]); } catch { break; }
      const x = Array.isArray(r) ? r : [r.adapter, r.capBps, r.active];
      if (x[2]) active.push(`${lc(x[0])}:${Number(x[1])}`);
    }
    const wantActive = want.map((w) => `${lc(w.adapter)}:${w.capBps}`);
    const problems: string[] = [];
    if (active.join(",") !== wantActive.join(",")) problems.push(`active adapters [${active.join(", ")}], deploy script [${wantActive.join(", ")}]`);
    const allowed = async (sig: string, fn: string): Promise<string[]> => {
      const logs = await scanLogs(chain, { address: a, topics: [keccak256(toHex(sig))], fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs });
      const out: string[] = [];
      for (const k of new Set(logs.map((l) => lc(l.topics[1] ?? "")))) {
        const arg = fn === "adapterAllowed" ? topicToAddress(k as Hex) : k;
        if ((await chain.read(a, `function ${fn}(${fn === "adapterAllowed" ? "address" : "bytes32"}) view returns (bool)`, [arg])) === true) out.push(lc(arg));
      }
      return out.sort();
    };
    const wantAddrs = want.map((w) => lc(w.adapter)).sort();
    const gotAddrs = await allowed(SIG_ADAPTER_ALLOWED, "adapterAllowed");
    if (gotAddrs.join(",") !== wantAddrs.join(",")) problems.push(`allowed adapters [${gotAddrs.join(", ")}], deploy script [${wantAddrs.join(", ")}]`);
    const wantHashes = [...new Set(await Promise.all(want.map(async (w) => lc(keccak256(await chain.getCode(w.adapter))))))].sort();
    const gotHashes = await allowed(SIG_CODEHASH_ALLOWED, "adapterCodeHashAllowed");
    if (gotHashes.join(",") !== wantHashes.join(",")) problems.push(`allowed code hashes [${gotHashes.join(", ")}], deployed adapters [${wantHashes.join(", ")}]`);
    return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `${want.length} adapters, caps and allowlists equal the deploy script` };
  });
}

/** The labels v4AssetChecks pushes. A vault whose sheet lists a V4 asset must pass every one. */
const V4_LABELS = [
  "asset row is venue V4 with the price recorder as its pool",
  "V4 adapter codehash is allowed",
  "V4 adapter is bound to the recorder, the PoolManager and the pool key",
] as const;
const RECORDER_LABELS = [
  "recorder: PoolKey and PoolManager equal config",
  "recorder: observation ring holds the full window floor",
  "recorder: has no owner, role or setter",
] as const;

/** Function selectors that would make the recorder administrable. None may be in its runtime code (it has no owner, role or setter). */
const ADMIN_SELECTORS = [
  "owner()", "admin()", "pendingOwner()", "transferOwnership(address)", "renounceOwnership()", "acceptOwnership()", "hasRole(bytes32,address)",
  "grantRole(bytes32,address)", "revokeRole(bytes32,address)", "renounceRole(bytes32,address)", "DEFAULT_ADMIN_ROLE()", "ADMIN_ROLE()",
  "setPoolManager(address)", "setMaxStaleness(uint32)", "setTick(int24)", "upgradeTo(address)", "upgradeToAndCall(address,bytes)", "setImplementation(address)",
].map((sig) => toFunctionSelector(`function ${sig}`).slice(2).toLowerCase());

/**
 * Core 1676 (owner decision 2026-10-08). The rmAGENT asset is a Uniswap V4 pool. Its vault pool is the price recorder, its adapter the V4 swap
 * adapter. Read from the chain and compared with core's config (never with the chain itself): the asset row's venue and pool, the adapter's
 * codehash on the vault allowlist, the adapter's immutable binding, the recorder's PoolKey (and that the key hashes to the configured pool id),
 * the recorder's ring size, and the absence of any admin selector in the recorder's runtime code (the negative invariant).
 */
async function v4AssetChecks(
  c: Collector, chain: ChainReader, v: ManifestVault, asset: ExpectedAsset,
  ctx: { recorder: Address; artifactsDir: string; v4AdapterArtifact?: string },
): Promise<void> {
  const p = `vault[${v.key}]`;
  const x = asset.v4;
  const rec = asset.pool; // the recorder the asset must be registered with
  await c.run(`${p}: ${V4_LABELS[0]}`, async () => {
    if (!x) return { ok: false, detail: "the expected asset has no V4 config" };
    let row: any;
    for (let i = 0; i < 64; i++) {
      let r: any;
      try { r = await chain.read(v.address, ASSET_SIG, [BigInt(i)]); } catch { break; }
      const t = Array.isArray(r) ? r : [r.token, r.pool, r.swapFee, r.active, r.adapter, r.venue];
      if (lc(t[0]) === lc(asset.token)) row = t;
    }
    if (!row) return { ok: false, detail: `no asset row for ${asset.token}` };
    const ok = Number(row[5]) === VENUE_V4 && lc(row[1]) === lc(rec) && lc(rec) === lc(ctx.recorder) && Number(row[2]) === x.key.fee;
    return { ok, detail: `venue ${row[5]}, pool ${row[1]}, swapFee ${row[2]}; recorder ${ctx.recorder}, fee in config ${x.key.fee}` };
  });
  await c.run(`${p}: ${V4_LABELS[1]}`, async () => {
    const code = await chain.getCode(asset.adapter);
    if (code.length <= 2) return { ok: false, detail: `no code at the adapter ${asset.adapter}` };
    const allowed = (await chain.read(v.address, "function adapterCodeHashAllowed(bytes32) view returns (bool)", [keccak256(code)])) as boolean;
    return { ok: allowed === true, detail: `adapterCodeHashAllowed(${keccak256(code)}) ${String(allowed)}` };
  });
  await c.run(`${p}: ${V4_LABELS[2]}`, async () => {
    if (!x) return { ok: false, detail: "the expected asset has no V4 config" };
    const a = asset.adapter;
    const got = {
      pm: lc((await chain.read(a, "function POOL_MANAGER() view returns (address)")) as string),
      recorder: lc((await chain.read(a, "function RECORDER() view returns (address)")) as string),
      id: String(await chain.read(a, "function POOL_ID() view returns (bytes32)")).toLowerCase(),
      c0: lc((await chain.read(a, "function CURRENCY0() view returns (address)")) as string),
      c1: lc((await chain.read(a, "function CURRENCY1() view returns (address)")) as string),
      fee: Number(await chain.read(a, "function POOL_FEE() view returns (uint24)")),
      spacing: Number(await chain.read(a, "function TICK_SPACING() view returns (int24)")),
    };
    const ok = got.pm === lc(x.poolManager) && got.recorder === lc(rec) && got.id === x.poolId.toLowerCase() && got.c0 === lc(x.key.currency0) && got.c1 === lc(x.key.currency1) && got.fee === x.key.fee && got.spacing === x.key.tickSpacing;
    return { ok, detail: ok ? `bound to recorder ${rec}` : `adapter reads ${JSON.stringify(got)}, config says PoolManager ${x.poolManager} recorder ${rec} poolId ${x.poolId} key ${JSON.stringify(x.key)}` };
  });
  await c.run(RECORDER_LABELS[0], async () => {
    if (!x) return { ok: false, detail: "the expected asset has no V4 config" };
    const r = ctx.recorder;
    const got = {
      pm: lc((await chain.read(r, "function POOL_MANAGER() view returns (address)")) as string),
      id: String(await chain.read(r, "function POOL_ID() view returns (bytes32)")).toLowerCase(),
      c0: lc((await chain.read(r, "function token0() view returns (address)")) as string),
      c1: lc((await chain.read(r, "function token1() view returns (address)")) as string),
      fee: Number(await chain.read(r, "function fee() view returns (uint24)")),
      spacing: Number(await chain.read(r, "function tickSpacing() view returns (int24)")),
      hooks: lc((await chain.read(r, "function hooks() view returns (address)")) as string),
    };
    // the configured key must hash to the configured pool id (abi.encode of the five fields), and the recorder must read that very pool
    const hash = keccak256(encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [x.key.currency0, x.key.currency1, x.key.fee, x.key.tickSpacing, x.key.hooks]));
    const ok = got.pm === lc(x.poolManager) && got.id === x.poolId.toLowerCase() && hash.toLowerCase() === x.poolId.toLowerCase() && got.c0 === lc(x.key.currency0) && got.c1 === lc(x.key.currency1)
      && got.fee === x.key.fee && got.spacing === x.key.tickSpacing && got.hooks === lc(x.key.hooks);
    return { ok, detail: ok ? `pool id ${x.poolId}` : `recorder reads ${JSON.stringify(got)}, hash of the config key ${hash}, config says ${JSON.stringify({ pm: x.poolManager, id: x.poolId, key: x.key })}` };
  });
  await c.run(RECORDER_LABELS[1], async () => {
    const [, , , cardinality] = (await chain.read(ctx.recorder, "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality)")) as readonly [bigint, number, number, number];
    return { ok: Number(cardinality) >= 901, detail: `observationCardinality ${cardinality}, the 1800 s window needs 901` };
  });
  await c.run(RECORDER_LABELS[2], async () => {
    const code = (await chain.getCode(ctx.recorder)).slice(2).toLowerCase();
    if (code.length === 0) return { ok: false, detail: `no code at the recorder ${ctx.recorder}` };
    const found = ADMIN_SELECTORS.filter((sel) => code.includes(sel));
    return { ok: found.length === 0, detail: found.length ? `the runtime code carries admin selector(s) ${found.join(", ")}` : `none of ${ADMIN_SELECTORS.length} admin selectors in ${code.length / 2} bytes of runtime code` };
  });
}

/** The labels basketGuardChecks pushes (a vault with no sheet entry fails them by name). */
const BASKET_GUARD_LABELS = ["navDeviationGuardBps equals sheet", "navDeviationGuardBps above zero", "pool liquidity meets the sheet floor"];

/**
 * Issue 1666. A basket ships with the ORA-4 deposit guard set (the vault default 0 disables it) and only on pools whose in-range
 * liquidity meets the sheet floor. Both are read from the chain: the guard from the vault, the liquidity from each asset pool
 * (`IUniswapV3Pool.liquidity()`, a uint128 L). The guard is checked against the sheet AND against zero: a sheet that says 0 cannot pass.
 */
async function basketGuardChecks(c: Collector, chain: ChainReader, vault: Address, p: string, vs: VaultSheet): Promise<void> {
  const read = () => chain.read(vault, "function navDeviationGuardBps() view returns (uint256)");
  if (vs.navDeviationBps === undefined) c.fail(`${p}: ${BASKET_GUARD_LABELS[0]}`, "the sheet has no navDeviationBps for this vault");
  else await c.runEq(`${p}: ${BASKET_GUARD_LABELS[0]}`, read, vs.navDeviationBps);
  await c.run(`${p}: ${BASKET_GUARD_LABELS[1]}`, async () => {
    const got = BigInt((await read()) as bigint);
    return { ok: got > 0n, detail: `navDeviationGuardBps ${got}` };
  });
  await c.run(`${p}: ${BASKET_GUARD_LABELS[2]}`, async () => {
    const floor = vs.minPoolLiquidity;
    if (floor === undefined || floor <= 0n) return { ok: false, detail: `the sheet has no pool liquidity floor above zero for this vault (${String(floor)})` };
    if (vs.assets.length === 0) return { ok: false, detail: "the sheet lists no asset pool to check" };
    const short: string[] = [];
    for (const asset of vs.assets) {
      const liq = BigInt((await chain.read(asset.pool, "function liquidity() view returns (uint128)")) as bigint);
      if (liq < floor) short.push(`${asset.pool} has ${liq}`);
    }
    return { ok: short.length === 0, detail: short.length ? `below the floor ${floor}: ${short.join(", ")}` : `${vs.assets.length} pools at or above ${floor}` };
  });
}

/** rmUSDC seed shares: the deployer ends with none and the seed share receiver holds them (stage 12, core's stage table note). */
async function seedShareChecks(c: Collector, chain: ChainReader, v: ManifestVault, deployer: Address, sheetReceiver: Address | undefined): Promise<void> {
  const p = `vault[${v.key}]`;
  const BAL = "function balanceOf(address) view returns (uint256)";
  const receiver = v.data?.seed_share_receiver;
  const seedShares = (() => { try { return BigInt(v.data?.seed_shares); } catch { return undefined; } })();
  await c.run(`${p}: manifest deployer share balance after seed is zero`, async () => {
    const got = v.data?.deployer_share_balance_after;
    return { ok: got !== undefined && BigInt(got) === 0n, detail: `deployer_share_balance_after ${String(got)}` };
  });
  await c.run(`${p}: seed share receiver is named and is not the deployer`, async () => ({
    ok: isAddress(receiver) && lc(receiver) !== lc(deployer), detail: `seed_share_receiver ${String(receiver)}`,
  }));
  if (sheetReceiver) await c.run(`${p}: seed share receiver equals sheet`, async () => ({ ok: isAddress(receiver) && lc(receiver) === lc(sheetReceiver), detail: `manifest ${String(receiver)}, sheet ${sheetReceiver}` }));
  await c.run(`${p}: deployer holds no shares`, async () => {
    const bal = BigInt((await chain.read(v.address, BAL, [deployer])) as bigint);
    return { ok: bal === 0n, detail: `deployer balance ${bal}` };
  });
  await c.run(`${p}: seed share receiver holds the seed shares`, async () => {
    if (!isAddress(receiver)) return { ok: false, detail: "no seed_share_receiver in the manifest" };
    if (seedShares === undefined || seedShares <= 0n) return { ok: false, detail: `seed_shares ${String(v.data?.seed_shares)} is not above zero` };
    const bal = BigInt((await chain.read(v.address, BAL, [receiver])) as bigint);
    return { ok: bal >= seedShares, detail: `receiver balance ${bal}, manifest seed_shares ${seedShares}` };
  });
}

const ASSET_SIG = "function assets(uint256) view returns (address token, address pool, uint24 swapFee, bool active, address adapter, uint8 venue)";

async function assetReadBack(chain: ChainReader, vault: Address, want: ExpectedAsset[]): Promise<{ ok: boolean; detail: string }> {
  const got: string[] = [];
  for (let i = 0; i < 64; i++) {
    let r: any;
    try { r = await chain.read(vault, ASSET_SIG, [BigInt(i)]); } catch { break; }
    const x = Array.isArray(r) ? r : [r.token, r.pool, r.swapFee, r.active, r.adapter, r.venue];
    got.push([lc(x[0]), lc(x[1]), Number(x[2]), Boolean(x[3]), lc(x[4]), Number(x[5])].join("|"));
  }
  const exp = want.map((w) => {
    const g = got.find((s) => s.startsWith(`${lc(w.token)}|`));
    const venue = w.venue ?? (g ? Number(g.split("|")[5]) : 0);
    return [lc(w.token), lc(w.pool), w.swapFee, w.active ?? true, lc(w.adapter), venue].join("|");
  });
  const a = [...got].sort().join("\n"), b = [...exp].sort().join("\n");
  return { ok: a === b, detail: a === b ? `${got.length} assets` : `on chain [${got.join("; ")}] sheet [${exp.join("; ")}]` };
}

// NEGATIVE-INVARIANT labels: each passes only when something is ABSENT (no agent log, zero listed agents, no AGENT_ROLE holder,
// no deployer-owned agent). They are deliberate after the no-agent deploy (core 1527). Do not delete them as dead code.
const AGENT_LABELS = [
  "agents: no agent authorized at handover",
  "agents: manifest lists zero agents",
  "agents: no address holds AGENT_ROLE after handover",
  "agents: manifest says deployer owns no listed agent",
];

/** The deploy authorizes no agent (architecture 5.2 and 6.3): an agent belongs to a depositor. The gateway has no agent log since the deploy began, the timelock manifest lists none and nobody holds AGENT_ROLE. */
async function agentChecks(
  c: Collector, chain: ChainReader, gateway: Address, timelockManifest: any,
  s: { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number },
): Promise<void> {
  const base = { address: gateway, fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs };
  try {
    const t1 = keccak256(toHex(SIG_AGENT_AUTHORIZED)), t2 = keccak256(toHex(SIG_AGENT_OWNERSHIP));
    const logs = [...(await scanLogs(chain, { ...base, topics: [t1] })), ...(await scanLogs(chain, { ...base, topics: [t2] }))];
    const agents = [...new Set(logs.map((l) => lc(topicToAddress(l.topics[1]))))];
    c.push(AGENT_LABELS[0]!, logs.length === 0, logs.length ? `${logs.length} agent logs from block ${s.fromBlock}, agents ${agents.join(", ")}` : `no AgentAuthorized or AgentOwnershipTransferred log from block ${s.fromBlock}`);
  } catch (e: any) { c.fail(AGENT_LABELS[0]!, `scan failed: ${String(e?.message ?? e).slice(0, 300)}`); }
  c.eq(AGENT_LABELS[1]!, timelockManifest.roles?.gateway_agents_listed_count, 0);
  try {
    const logs = await scanLogs(chain, { ...base, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), AGENT_ROLE] });
    const holders: string[] = [];
    for (const who of new Set(logs.map((l) => topicToAddress(l.topics[2])))) if (await hasRole(chain, gateway, AGENT_ROLE, who)) holders.push(who);
    c.push(AGENT_LABELS[2]!, holders.length === 0, holders.length ? `holders ${holders.join(", ")}` : `${logs.length} AGENT_ROLE grants scanned, none held`);
  } catch (e: any) { c.fail(AGENT_LABELS[2]!, `scan failed: ${String(e?.message ?? e).slice(0, 300)}`); }
  c.eq(AGENT_LABELS[3]!, timelockManifest.roles?.deployer_owns_a_listed_gateway_agent, false);
}

/** Log-enumerated scan of the timelock's PROPOSER, CANCELLER and EXECUTOR holders: only the Safe, plus address(0) as the open executor. An EOA holder is named. */
async function timelockHolderScan(c: Collector, chain: ChainReader, tl: Address, safe: Address, s: { fromBlock: bigint; head: bigint | undefined; chunk: number; retryBaseMs: number }): Promise<void> {
  const label = "timelock: only the safe holds PROPOSER, CANCELLER or EXECUTOR role (log scan)";
  if (s.head === undefined) { c.fail(label, "block number unreadable"); return; }
  try {
    const sig = keccak256(toHex(SIG_ROLE_GRANTED));
    const roles = [PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE];
    const logs = await scanLogs(chain, { address: tl, topics: [sig, roles], fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs });
    const pairs = new Map<string, { role: Hex; who: Address }>();
    for (const l of logs) { const who = topicToAddress(l.topics[2]); pairs.set(`${l.topics[1]}:${lc(who)}`, { role: l.topics[1], who }); }
    const bad: string[] = [];
    for (const { role, who } of pairs.values()) {
      if (!(await hasRole(chain, tl, role, who))) continue;
      const isSafe = lc(who) === lc(safe);
      const isOpenExecutor = lc(who) === lc(ZERO) && role === EXECUTOR_ROLE;
      if (isSafe || isOpenExecutor) continue;
      const eoa = (await chain.getCode(who)).length <= 2;
      bad.push(`${who} holds ${role}${eoa ? " (EOA)" : ""}`);
    }
    c.push(label, bad.length === 0, bad.length ? bad.join(", ") : `${pairs.size} grants scanned, holders are the safe and the open executor`);
  } catch (e: any) {
    c.fail(label, `scan failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

const ROLE_HOLDERS_LABEL = "roles: every holder of every role on every governed contract is an expected account (log scan)";

/**
 * Core 1668. The named checks above ask about the accounts we expect to hold (or not hold) a role, so a fourth holder passes them.
 * This lists every account that was ever granted any role on a governed contract (RoleGranted), keeps those that hold it now, and
 * fails naming each one that is not the timelock, the Safe, RouterGovernance, the emergency key or the pauser. The open executor
 * (address zero) is expected on the timelock's EXECUTOR_ROLE only. The gateway holds ADMIN_ROLE on the IC policy by design (the
 * IC deploy script grants it so committeeRegister can call registerAgent): that one pair is expected.
 */
async function roleHolderEnumeration(
  c: Collector, chain: ChainReader, governed: { name: string; address: Address }[],
  expect: { timelock: Address; accounts: Address[]; icPolicy: Address; gateway: Address; router: Address },
  s: { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number },
): Promise<void> {
  try {
    const sig = keccak256(toHex(SIG_ROLE_GRANTED));
    const ok = new Set(expect.accounts.map(lc));
    const bad: string[] = [];
    let grants = 0;
    for (const g of governed) {
      const logs = await scanLogs(chain, { address: g.address, topics: [sig], fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs });
      const pairs = new Map<string, { role: Hex; who: Address }>();
      for (const l of logs) { const who = topicToAddress(l.topics[2]); pairs.set(`${l.topics[1]}:${lc(who)}`, { role: l.topics[1], who }); }
      grants += logs.length;
      for (const { role, who } of pairs.values()) {
        if (!(await hasRole(chain, g.address, role, who))) continue;
        // The router's weight setter is rotatable (core 1616): its single holder is checked by "WEIGHT_SETTER_ROLE has exactly one holder", so a rotated holder is not unexpected here.
        if (lc(g.address) === lc(expect.router) && role === WEIGHT_SETTER_ROLE) continue;
        // A depositor authorizes its own agent on the gateway after handover (architecture 5.2): AGENT_ROLE holders are users, not
        // governance accounts. "agents: no address holds AGENT_ROLE after handover" already pins zero holders up to the handover block.
        if (lc(g.address) === lc(expect.gateway) && role === AGENT_ROLE) continue;
        // The consensus receipt submitter Safe (issue 1750) holds COMMITTEE_AGENT_ROLE on the IC policy by design.
        if (lc(g.address) === lc(expect.icPolicy) && role === COMMITTEE_AGENT_ROLE) continue;
        const expected = ok.has(lc(who))
          || (lc(g.address) === lc(expect.timelock) && role === EXECUTOR_ROLE && lc(who) === lc(ZERO))
          || (lc(g.address) === lc(expect.icPolicy) && role === ADMIN_ROLE && lc(who) === lc(expect.gateway));
        if (!expected) bad.push(`${who} holds ${role} on ${g.name}`);
      }
    }
    c.push(ROLE_HOLDERS_LABEL, bad.length === 0, bad.length ? `unexpected holders: ${bad.join(", ")}` : `${grants} grants scanned on ${governed.length} contracts, every holder is expected`);
  } catch (e: any) {
    c.fail(ROLE_HOLDERS_LABEL, `scan failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

/** Log-enumerated scan: every (contract, role) the deployer was ever granted must be gone now. Covers contracts no manifest names. */
async function roleScan(c: Collector, chain: ChainReader, deployer: Address, s: { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number }): Promise<void> {
  const label = "deployer: holds no role on any contract (log scan)";
  try {
    const sig = keccak256(toHex(SIG_ROLE_GRANTED));
    const logs = await scanLogs(chain, { topics: [sig, null, padTopic(deployer)], fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs });
    const pairs = new Map<string, { at: Address; role: Hex }>();
    for (const l of logs) pairs.set(`${lc(l.address)}:${l.topics[1]}`, { at: l.address, role: l.topics[1] });
    const held: string[] = [];
    for (const { at, role } of pairs.values()) if (await hasRole(chain, at, role, deployer)) held.push(`${at}:${role}`);
    c.push(label, held.length === 0, held.length ? `deployer still holds ${held.join(", ")}` : `${pairs.size} grants scanned, none held`);
  } catch (e: any) {
    c.fail(label, `scan failed: ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

/**
 * Issue 1796: one single-vault redeploy, after its govern row executed. The vault the registry still lists is RETIRED: withdraw-only, out of the router, still holding its code (the
 * shares of its holders redeem through `redeem`, `withdraw` and `redeemInKind`). The vault that replaced it is the one the vault manifest names (every other label already checks it) and it is Active
 * in the registry. The router's effective weights hold the new vault and not the old one.
 */
async function redeployChecks(
  c: Collector, chain: ChainReader, r: NonNullable<VerifyOptions["redeploys"]>[number],
  ctx: { registry: Address; router: Address; tl: Address; emergency: Address; vaults: ManifestVault[]; priorDir?: string; artifactsDir: string; artifact?: string },
): Promise<void> {
  const p = `retired[${r.vault}]`;
  const status = async (v: Address): Promise<number> => Number(((await chain.read(ctx.registry, "function getVault(address vault) view returns ((string name, address asset, uint256 registeredAt) metadata, uint8 status)", [v])) as [unknown, number])[1]);
  await c.run(`${p}: has code`, async () => (await chain.getCode(r.oldVault)).length > 2);
  await c.runEq(`${p}: registry status is Retired`, () => status(r.oldVault), 2);
  await c.runEq(`${p}: not router-eligible`, () => chain.read(ctx.registry, "function isRouterEligible(address vault) view returns (bool)", [r.oldVault]), false);
  await c.runEq(`${p}: deposits halted by the registry retire`, () => chain.read(r.oldVault, "function retired() view returns (bool)"), true);
  await c.runEq(`${p}: registry link`, () => chain.read(r.oldVault, "function registry() view returns (address)"), ctx.registry);
  await c.runEq(`${p}: timelock holds ADMIN_ROLE`, () => chain.read(r.oldVault, "function hasRole(bytes32 role, address account) view returns (bool)", [ADMIN_ROLE, ctx.tl]), true);
  await c.runEq(`${p}: emergency key holds EMERGENCY_ROLE`, () => chain.read(r.oldVault, "function hasRole(bytes32 role, address account) view returns (bool)", [EMERGENCY_ROLE, ctx.emergency]), true);
  await c.run(`${p}: runtime code serves redeemInKind`, async () => {
    const sel = toFunctionSelector("function redeemInKind(uint256 shares, address receiver, address owner)").slice(2);
    // Issue 1808: behind an ERC-1967 proxy the selector is in the implementation's code.
    const code = (await logicCode(chain, r.oldVault, tryLoadArtifact(ctx.priorDir ?? ctx.artifactsDir, ERC1967_PROXY_ARTIFACT))).toLowerCase();
    return { ok: code.includes(sel), detail: `selector ${sel}` };
  });
  await c.run(`${p}: runtime code equals the original build artifact (masked)`, async () => {
    if (!ctx.artifact) return { ok: false, detail: "no artifact name for the vault" };
    const dir = ctx.priorDir ?? ctx.artifactsDir;
    const res = await compareDeployedCode(chain, r.oldVault, loadArtifact(dir, ctx.artifact), tryLoadArtifact(dir, ERC1967_PROXY_ARTIFACT));
    return { ok: res.ok, detail: `${ctx.artifact}: ${res.detail}${!res.ok && ctx.priorDir === undefined ? " (pass --prior-out <forge out/ of the original sha>)" : ""}` };
  });
  const q = `redeploy[${r.vault}]`;
  await c.run(`${q}: the vault manifest names the replacing vault`, async () => {
    const m = ctx.vaults.find((v) => v.key === r.vault);
    return { ok: !!m && lc(m.address) === lc(r.newVault), detail: m ? `manifest ${m.address}, run record ${r.newVault}` : "no manifest vault" };
  });
  if (r.routerVaultCap !== undefined) await c.runEq(`${q}: router per-address cap equals approved old cap`, () => chain.read(ctx.router, "function vaultCap(address vault) view returns (uint256)", [r.newVault]), BigInt(r.routerVaultCap));
  await c.runEq(`${q}: replacing vault registry status is Active`, () => status(r.newVault), 0);
  await c.runEq(`${q}: no voted vector is active`, () => chain.read(ctx.router, "function votedWeightsActive() view returns (bool)"), false);
  await c.run(`${q}: default and effective vectors are the same unique four legs`, async () => {
    const [dv, db] = (await chain.read(ctx.router, "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)")) as [string[], bigint[]];
    const [ev, eb] = (await chain.read(ctx.router, "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)")) as [string[], bigint[]];
    const same = dv.length === ev.length && dv.every((a, i) => lc(a) === lc(ev[i]!) && db[i] === eb[i]);
    const ok = same && new Set(dv.map(lc)).size === dv.length && dv.length === 4 && db.reduce((t, x) => t + x, 0n) === 10000n;
    return { ok, detail: `default [${dv.join(", ")}] effective [${ev.join(", ")}]` };
  });
  await c.run(`${q}: router effective weights hold the replacing vault and not the retired one`, async () => {
    const [vs] = (await chain.read(ctx.router, "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)")) as [string[], bigint[]];
    const ok = vs.length === 4 && new Set(vs.map(lc)).size === 4 && vs.filter((v) => lc(v) === lc(r.newVault)).length === 1 && !vs.some((v) => lc(v) === lc(r.oldVault));
    return { ok, detail: `[${vs.join(", ")}]` };
  });
}
