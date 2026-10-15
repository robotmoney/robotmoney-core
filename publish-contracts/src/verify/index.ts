// The one verifier (stage 12). Same code, same labels on the Twin chain (918453) and Base mainnet (8453).
// Replaces the three superseded verifier shell scripts and the stage verifier.
// Read-only: it sends nothing.
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbiItem, toFunctionSelector, toHex } from "viem";
import { Collector } from "./collector.ts";
import { PROOF_TX_NONCES } from "../counts.ts";
import { kindLabel, rehearsalDelayProblem } from "../chains.ts";
import { compareCode, compareCodeAndLinks, loadArtifact } from "./codehash.ts";
import {
  ADMIN_ROLE, AGENT_ROLE, COMMITTEE_AGENT_ROLE, WEIGHT_SETTER_ROLE, WEIGHT_SETTER_ROTATOR_ROLE, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, CANCELLER_ROLE, coreContracts, EMERGENCY_ROLE, EXECUTOR_ROLE, DEPOSIT_PAUSER_ROLE, PROPOSER_ROLE, SIG_AGENT_AUTHORIZED,
  KEEPER_ROLE, RM_TOKEN, SIG_ADAPTER_ALLOWED_SET, SIG_ADAPTER_CODE_HASH_ALLOWED_SET, SIG_AGENT_OWNERSHIP, SIG_RECEIPT_APPLIED, SIG_ROLE_GRANTED, SIG_VOTED_WEIGHTS_CLEARED, Z32, ZERO, minDelayFloor, requiredManifests, stageManifestName,
} from "./constants.ts";
import { existsSync } from "node:fs";
import { manifestBase, type StageTable } from "../stage-table.ts";
import { AUTHORITY_STAGE, SAFE_MANIFEST, VAULT_ADAPTER_V4_FIELD, V4_ADAPTER_ARTIFACT_KEY, VENUE_V4 } from "../core-wiring.ts";
import { ERC1967_IMPLEMENTATION_SLOT, manifestProxies, proxyChecks, proxyRecordOf, readProxyState, wordAddress, type ManifestProxy, type ProxyRecord, type ProxyState } from "../proxies.ts";
import { isAddress, loadManifests, lc, type ManifestVault } from "./manifests.ts";
import { padTopic, scanLogs, topicToAddress } from "./logs.ts";
import { safeChecks } from "./safe-checks.ts";
import { USDC_ADDRESS, checkUsdcCode } from "../usdc.ts";
import type { Address, ChainReader, ExpectedAsset, Hex, LogEntry, VaultSheet, VerifyOptions, VerifyReport, WeightSetterGating, WeightSetterHolder } from "./types.ts";

export type { VerifyOptions, VerifyReport, Check, VerifySheet, VaultSheet, ChainReader, WeightSetterGating, WeightSetterHolder } from "./types.ts";
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
  // QA plan v1 E1 (DT-2): after a redeploy the checkout's build (artifactsDir) is the redeploy sha's, and only the replacing vault runs it. Every contract the original
  // deployment created runs the build of the original sha (priorArtifactsDir, --prior-out). No redeploy, or no --prior-out (every round at the original sha): one build.
  const originalDir = redeploys.length > 0 ? opts.priorArtifactsDir : undefined;
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
  // setWeights is gated by WEIGHT_SETTER_ROLE: only RouterGovernance holds it, so the timelock and the Safe cannot bypass the receipt path (applyReceipt, issue 1698).
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
  // QA plan v1 C3 (CS-6, ADR-0002): the timelock delay on a weight change holds only while the weight setter is timelock-gated. A rotation installs whatever
  // contract the Safe chose, so the run records the current holder's gating (VerifyReport.weightSetter, the verify stage record) and fails on any other gate.
  const weightSetter = await weightSetterGating(chain, { router, timelock: tl, artifactsDir: originalDir ?? opts.artifactsDir, governanceArtifact: core.find((x) => x.name === "governance")!.artifact });
  c.push(WEIGHT_SETTER_GATING_LABEL, weightSetter.gating === "timelock", gatingDetail(weightSetter));
  await c.runEq("gateway: not paused", () => chain.read(gateway, "function depositsPaused() view returns (bool)"), false);
  // The router-first split (core 1493): the gateway and the registry both name the router the router stage deployed.
  await c.runEq("gateway: router() equals the deployed router", async () => lc((await chain.read(gateway, "function router() view returns (address)")) as string), lc(router));
  await c.runEq("registry: router() equals the deployed router", async () => lc((await chain.read(registry, "function router() view returns (address)")) as string), lc(router));

  // the chain head bounds every log scan below (the applied receipt, the agents, the role history)
  const head = await chain.blockNumber().catch(() => undefined);
  const chunk = opts.logChunk ?? 2000;
  const retryBaseMs = opts.retryBaseMs ?? 500;

  // ---- deploy-time configuration, set by the deployer before the handover and never touched by govern (issue 1520)
  await deployTimeChecks(c, chain, sheet, {
    governance: byName.governance!, router, vaults: man.vaults, receipt: byName.receipt!, recorded: opts.appliedReceipt,
    scan: head === undefined ? undefined : { fromBlock: opts.fromBlock, head, chunk, retryBaseMs },
  });

  // ---- vaults
  const vaultScan = head === undefined ? undefined : { fromBlock: opts.fromBlock, head, chunk, retryBaseMs };
  for (const v of man.vaults) await vaultChecks(c, chain, v, sheet.vaults[v.key], { tl, registry, safe, sheet, recorder: byName.recorder!, artifactsDir: opts.artifactsDir, v4AdapterArtifact: table.artifacts[V4_ADAPTER_ARTIFACT_KEY], scan: vaultScan });

  // ---- gateway agents, derived from logs
  if (head === undefined) {
    for (const l of AGENT_LABELS) c.fail(l, "block number unreadable");
    c.fail("deployer: holds no role on any contract (log scan)", "block number unreadable");
    c.fail(ROLE_HOLDERS_LABEL, "block number unreadable");
  } else {
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
  // Issue 1796, QA plan v1 E1: after a redeploy only the replacing vault (and an adapter its manifest names) runs the checkout's build, the redeploy sha's. Every other
  // contract (core, libraries, the other adapters, the vaults not replaced, and the retired vault below) was created by the original deployment and runs its build.
  const redeployed = new Set(redeploys.map((r) => r.vault));
  const priorDir = opts.priorArtifactsDir;
  const codeTargets: { label: string; address: Address; artifact: string; dir?: string; original: boolean }[] = [
    ...core.map((x) => ({ label: x.name, address: x.address, artifact: x.artifact, dir: originalDir, original: true })),
    ...man.vaults.map((v) => ({ label: `vault[${v.key}]`, address: v.address, artifact: sheet.vaults[v.key]?.contract ?? v.artifact, dir: redeployed.has(v.key) ? undefined : originalDir, original: !redeployed.has(v.key) })),
    ...v4Adapters.map((a) => ({ label: `adapter[V4:${a.vault}]`, address: a.address, artifact: table.artifacts[V4_ADAPTER_ARTIFACT_KEY]!, dir: redeployed.has(a.vault) ? undefined : originalDir, original: !redeployed.has(a.vault) })),
    ...libNames.map((n) => ({ label: `library[${n}]`, address: man.libraries[n], artifact: man.libraryArtifacts[n]!, dir: originalDir, original: true })),
  ];
  // Issue 1809 (ADR-0014): a proxied contract's address holds the ERC1967Proxy, and the code that runs there is the implementation its ERC-1967 slot names: that is
  // what the label compares with the build. A proxy the run upgraded (govern --row upgrade-proxy, executed) is compared with the build that round was checked against.
  const proxied = new Map(manifestProxies(table, man.files, (st) => stageManifestName(table, st)).filter((x) => x.proxy !== undefined).map((x) => [lc(x.proxy!), x]));
  const upgradeOf = new Map((opts.upgrades ?? []).map((u) => [u.proxy, u]));
  for (const t of codeTargets) {
    await c.run(`${t.label}: runtime code equals build artifact (masked)`, async () => {
      const px = proxied.get(lc(t.address));
      const at = px ? wordAddress(await chain.getStorageAt(t.address, ERC1967_IMPLEMENTATION_SLOT)) : t.address;
      const up = px ? upgradeOf.get(px.name) : undefined;
      const dir = up ? (up.buildDir && existsSync(up.buildDir) ? up.buildDir : opts.artifactsDir) : (t.dir ?? opts.artifactsDir);
      // ADR-0014 §9: the masked compare blanks every library link, so the linked libraries are followed and compared with their builds too.
      const r = await compareCodeAndLinks((a) => chain.getCode(a), await chain.getCode(at), loadArtifact(dir, t.artifact), dir);
      const where = px ? ` (the implementation ${at} behind the proxy${up ? ", installed by govern upgrade-proxy" : ""})` : "";
      return { ok: r.ok, detail: `${t.artifact}${where}: ${r.detail}${!r.ok && redeploys.length > 0 && t.original && originalDir === undefined ? " (after a redeploy at another sha the contracts it did not replace run the original build: pass --prior-out <forge out/ of a checkout at the original sha>)" : ""}` };
    });
  }

  // ---- single-vault redeploys (issue 1796): only when the run has one, so a run without one keeps the label set of every other deployment
  for (const r of redeploys) await redeployChecks(c, chain, r, { registry, router: byName.router!, tl, vaults: man.vaults, priorDir, artifactsDir: opts.artifactsDir, artifact: man.vaults.find((v) => v.key === r.vault)?.artifact, proxyArtifact: table.proxyArtifact });

  // ---- governed proxies (issue 1809, ADR-0014 §3-§5): only for a table that lists them, so an older deployment keeps its label set
  const proxyRecords = await proxyLabels(c, chain, { table, files: man.files, timelock: tl, sheet, upgrades: opts.upgrades ?? [], freezes: opts.freezes ?? [], proxyArtifactDir: originalDir ?? opts.artifactsDir });

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

  return { ...c.report(), weightSetter, ...(proxyRecords.length ? { proxies: proxyRecords } : {}) };
}

/** Issue 1809: the labels of each governed proxy, after `proxy[<name>]: `. The same eight for every proxy, on every chain. */
export const PROXY_LABELS = [
  "runtime code equals the ERC1967Proxy build (masked)",
  "implementation slot equals the deployed or last upgraded implementation",
  "ERC-1967 admin slot is empty",
  "ERC-1967 beacon slot is empty",
  "initialized, and the implementation's initializers are locked",
  "upgradeAuthority is the timelock",
  "upgrade mode is declared and equals the sheet",
  "upgradesFrozen matches the mode and the executed freezes",
] as const;
export const AUTHORITY_LABEL = "upgrade authority: the authority stage's timelock is the handover timelock";

/**
 * Issue 1809 (ADR-0014 §3-§5): one label per property of each proxy the stage table lists (proxies.ts reads and judges; this only names the outcome). The ERC-1967 admin
 * and beacon slots must be empty, the implementation slot must name the manifest's implementation (or the last executed upgrade's), upgradeAuthority() must be the
 * authority stage's timelock, which must be the handover's timelock, the manifest's upgrade_mode must be the sheet's UPGRADE_MODE (an undeclared mode fails), and
 * upgradesFrozen() must read true exactly when that mode is frozen-at-deploy or an executed freeze row froze the proxy. Returns the evidence record of each proxy read.
 */
async function proxyLabels(
  c: Collector, chain: ChainReader,
  o: { table: StageTable; files: Record<string, any>; timelock: Address; sheet: VerifyOptions["sheet"]; upgrades: NonNullable<VerifyOptions["upgrades"]>; freezes: string[]; proxyArtifactDir: string },
): Promise<ProxyRecord[]> {
  const list: ManifestProxy[] = manifestProxies(o.table, o.files, (st) => stageManifestName(o.table, st));
  if (list.length === 0) return [];
  const hasAuthorityStage = o.table.stages.some((s) => s.name === AUTHORITY_STAGE);
  const authorityRaw = hasAuthorityStage ? o.files[stageManifestName(o.table, AUTHORITY_STAGE)]?.timelock : undefined;
  const authority = (isAddress(authorityRaw) ? authorityRaw : o.timelock) as Address;
  if (hasAuthorityStage) c.push(AUTHORITY_LABEL, isAddress(authorityRaw) && lc(authorityRaw) === lc(o.timelock), isAddress(authorityRaw) ? `authority stage ${authorityRaw}, handover ${o.timelock}` : `the ${stageManifestName(o.table, AUTHORITY_STAGE)}.json manifest names no timelock`);
  const lastUpgrade = new Map(o.upgrades.map((u) => [u.proxy, u.implementation]));
  const frozenByRow = new Set(o.freezes);
  const out: ProxyRecord[] = [];
  for (const mp of list) {
    const p = `proxy[${mp.name}]`;
    if (!mp.proxy || !mp.implementation) {
      for (const l of PROXY_LABELS) c.fail(`${p}: ${l}`, `the ${stageManifestName(o.table, mp.stage)}.json manifest names no ${!mp.proxy ? "proxy" : "implementation"} address`);
      continue;
    }
    let st: ProxyState | undefined;
    await c.run(`${p}: ${PROXY_LABELS[0]}`, async () => {
      st = await readProxyState(chain, mp.proxy!);
      const r = compareCode(st.proxyCode, loadArtifact(o.proxyArtifactDir, o.table.proxyArtifact!));
      return { ok: r.ok, detail: `${o.table.proxyArtifact}: ${r.detail}` };
    });
    if (!st) { for (const l of PROXY_LABELS.slice(1)) c.fail(`${p}: ${l}`, "the proxy could not be read"); continue; }
    const upgraded = lastUpgrade.get(mp.name);
    const ch = proxyChecks(st, { name: mp.name, implementation: upgraded ?? mp.implementation, authority, mode: o.sheet.upgradeMode, frozenByRow: frozenByRow.has(mp.name) }, mp);
    const s = st as ProxyState;
    c.push(`${p}: ${PROXY_LABELS[1]}`, !ch.implementationSlot, ch.implementationSlot ?? `${s.implementation}${upgraded ? " (installed by govern upgrade-proxy)" : " (the stage manifest's)"}`);
    c.push(`${p}: ${PROXY_LABELS[2]}`, !ch.adminSlot, ch.adminSlot ?? "zero");
    c.push(`${p}: ${PROXY_LABELS[3]}`, !ch.beaconSlot, ch.beaconSlot ?? "zero");
    c.push(`${p}: ${PROXY_LABELS[4]}`, !ch.initialized, ch.initialized ?? `proxy version ${s.initialized.version}, implementation locked`);
    c.push(`${p}: ${PROXY_LABELS[5]}`, !ch.authority, ch.authority ?? `${s.authority}`);
    c.push(`${p}: ${PROXY_LABELS[6]}`, !ch.mode, ch.mode ?? `${mp.manifestMode}`);
    c.push(`${p}: ${PROXY_LABELS[7]}`, !ch.frozen, ch.frozen ?? `upgradesFrozen ${s.frozen} (UPGRADE_MODE ${o.sheet.upgradeMode}${frozenByRow.has(mp.name) ? ", frozen by govern freeze-proxy" : ""})`);
    out.push(proxyRecordOf(mp.name, s, mp.manifestMode));
  }
  return out;
}

export const WEIGHT_SETTER_GATING_LABEL = "router: every WEIGHT_SETTER_ROLE holder is timelock-gated";
const ROLE_MEMBER_COUNT = "function getRoleMemberCount(bytes32 role) view returns (uint256)";
const ROLE_MEMBER = "function getRoleMember(bytes32 role, uint256 index) view returns (address)";
const roleMembers = async (ch: ChainReader, at: Address, r: Hex): Promise<Address[]> => {
  const n = Number((await ch.read(at, ROLE_MEMBER_COUNT, [r])) as bigint);
  const out: Address[] = [];
  for (let i = 0; i < n; i++) out.push((await ch.read(at, ROLE_MEMBER, [r, BigInt(i)])) as Address);
  return out;
};

/**
 * QA plan v1 C3 (CS-6, ADR-0002 "Why the 1522 bypass stays closed"). Reads every router `WEIGHT_SETTER_ROLE` holder and what gates its weight writes. A holder is
 * timelock-gated when its runtime code is the RouterGovernance build (its weight writes are all `onlyRole(ADMIN_ROLE)`) and the timelock is its only `ADMIN_ROLE`
 * member. Any other contract is not: its code is not the reviewed build, so nothing says the timelock stands in front of it. A failed router or code read is
 * "unreadable", never "timelock". The delay is recorded only: the timelock labels own its floor.
 */
async function weightSetterGating(chain: ChainReader, at: { router: Address; timelock: Address; artifactsDir: string; governanceArtifact: string }): Promise<WeightSetterGating> {
  const delaySeconds = await chain.read(at.timelock, "function getMinDelay() view returns (uint256)").then((d) => Number(d as bigint), () => null);
  const base = { timelock: at.timelock, delaySeconds };
  try {
    const art = loadArtifact(at.artifactsDir, at.governanceArtifact);
    const holders: WeightSetterHolder[] = [];
    for (const h of await roleMembers(chain, at.router, WEIGHT_SETTER_ROLE)) {
      const routerGovernanceCode = compareCode(await chain.getCode(h), art).ok;
      const admins = await roleMembers(chain, h, ADMIN_ROLE).catch(() => null); // no AccessControlEnumerable: no gate this verifier can read
      holders.push({ address: h, routerGovernanceCode, admins, timelockGated: routerGovernanceCode && admins !== null && admins.length === 1 && lc(admins[0]!) === lc(at.timelock) });
    }
    return { gating: holders.length > 0 && holders.every((h) => h.timelockGated) ? "timelock" : "not-timelock", holders, ...base };
  } catch {
    return { gating: "unreadable", holders: [], ...base };
  }
}

function gatingDetail(g: WeightSetterGating): string {
  const delay = g.delaySeconds === null ? "the timelock delay (unreadable)" : `the timelock delay of ${g.delaySeconds} s`;
  if (g.gating === "unreadable") return "the WEIGHT_SETTER_ROLE holders, their code or the RouterGovernance build could not be read: the gating is unknown";
  if (g.holders.length === 0) return "WEIGHT_SETTER_ROLE has no holder";
  const each = g.holders.map((h) => `${h.address} (${h.routerGovernanceCode ? "RouterGovernance build" : "not the RouterGovernance build"}, ADMIN_ROLE ${h.admins === null ? "unreadable" : `[${h.admins.join(", ")}]`})`).join("; ");
  return g.gating === "timelock"
    ? `${each}: every weight change waits ${delay}`
    : `${each}: a holder that is not the RouterGovernance build gated by the timelock ${g.timelock} alone lets weight changes skip ${delay} (ADR-0002, security-model section 7)`;
}

/** The log window every scan of the run reads: the first deploy block to the chain head. */
type ScanWindow = { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number };
/** The weight setter's last `applyReceipt` as the chain logged it (QA plan v1 C2, issue 1701). */
interface ChainApplied { receiptId: Hex; vaults: Address[]; bps: bigint[]; block: bigint }
/** What the chain says was applied: the last ReceiptApplied event, and whether the router logged VotedWeightsCleared after it (then no applied vector is active). */
interface ChainApplication { last?: ChainApplied; active: boolean; clearedAt?: bigint }

/** The later of two logs by block, then by position in the block. A tie keeps the later one in scan order. */
const later = (a: LogEntry | undefined, b: LogEntry): LogEntry => (a === undefined || b.blockNumber > a.blockNumber || (b.blockNumber === a.blockNumber && (b.logIndex ?? 0) >= (a.logIndex ?? 0)) ? b : a);

/**
 * QA plan v1 C2 (issue 1701): the applied vector is read from the chain, never from the run manifest. The weight setter emits `ReceiptApplied(receiptId, payloadDigest,
 * vaults, bps)` from `applyReceipt`, the router emits `VotedWeightsCleared()` from the clear row. A failed scan throws: it never reads as "nothing applied".
 */
async function chainApplication(chain: ChainReader, governance: Address, router: Address, w: ScanWindow): Promise<ChainApplication> {
  const scan = (address: Address, sig: string) => scanLogs(chain, { address, topics: [keccak256(toHex(sig))], fromBlock: w.fromBlock, toBlock: w.head, chunk: w.chunk, retryBaseMs: w.retryBaseMs });
  const app = (await scan(governance, SIG_RECEIPT_APPLIED)).reduce<LogEntry | undefined>(later, undefined);
  if (!app) return { active: false };
  const [, vaults, bps] = decodeAbiParameters([{ type: "bytes32" }, { type: "address[]" }, { type: "uint256[]" }], app.data);
  const last: ChainApplied = { receiptId: app.topics[1]!, vaults: [...vaults], bps: [...bps], block: app.blockNumber };
  const clear = (await scan(router, SIG_VOTED_WEIGHTS_CLEARED)).reduce<LogEntry | undefined>(later, undefined);
  const cleared = clear !== undefined && (clear.blockNumber > app.blockNumber || (clear.blockNumber === app.blockNumber && (clear.logIndex ?? 0) > (app.logIndex ?? 0)));
  return cleared ? { last, active: false, clearedAt: clear!.blockNumber } : { last, active: true };
}

const weightKey = (vaults: readonly string[], bps: readonly (bigint | number)[]): string => vaults.map((v, i) => `${lc(v)}:${bps[i]}`).join(",");

async function deployTimeChecks(
  c: Collector, chain: ChainReader, sheet: VerifyOptions["sheet"],
  at: { governance: Address; router: Address; vaults: ManifestVault[]; receipt: Address; recorded?: VerifyOptions["appliedReceipt"]; scan?: ScanWindow },
): Promise<void> {
  // Issue 1698: the weight setter has no voting surface. What stage 11 wired is read back instead: the receipt register `applyReceipt` releases from, the router it
  // writes, and the register ADMIN_ROLE the release needs. Without any of the three the first apply-receipt reverts (ReceiptContractNotSet or AccessControlUnauthorizedAccount).
  await c.runEq("governance: receiptContract() equals the consensus receipt", async () => lc((await chain.read(at.governance, "function receiptContract() view returns (address)")) as string), lc(at.receipt));
  await c.runEq("governance: router() equals the deployed router", async () => lc((await chain.read(at.governance, "function router() view returns (address)")) as string), lc(at.router));
  await c.runEq("receipt: ADMIN_ROLE held by governance", () => hasRole(chain, at.receipt, ADMIN_ROLE, at.governance), true);
  const [rVaults, rBps] = await (async () => {
    try { return (await chain.read(at.router, "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)")) as [string[], bigint[]]; } catch { return undefined; }
  })() ?? [undefined, undefined];
  const gotWeights = rVaults && rBps ? weightKey(rVaults, rBps) : undefined;
  const [eVaults, eBps] = await (async () => {
    try { return (await chain.read(at.router, "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)")) as [string[], bigint[]]; } catch { return undefined; }
  })() ?? [undefined, undefined];
  const gotEffective = eVaults && eBps ? weightKey(eVaults, eBps) : undefined;
  const sheetWant = (): { want?: string; missing: string[] } => {
    const addrOf = new Map(at.vaults.map((v) => [v.key, v.address]));
    const missing = sheet.defaultWeights.filter((w) => !addrOf.has(w.vault)).map((w) => w.vault);
    return missing.length ? { missing } : { want: sheet.defaultWeights.map((w) => `${lc(addrOf.get(w.vault)!)}:${w.bps}`).join(","), missing };
  };
  // QA plan v1 C2 (issue 1701): what was applied comes from the chain's events, never from the run manifest (an editable file, so a forged entry could mask router
  // weight drift). The labels that depend on it fail when the logs cannot be read.
  let onChain: ChainApplication | undefined;
  let scanError = "block number unreadable: the ReceiptApplied log scan cannot run";
  if (at.scan) {
    try { onChain = await chainApplication(chain, at.governance, at.router, at.scan); }
    catch (e) { scanError = `ReceiptApplied log scan failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`; }
  }
  // Issue 1696, issue 1698: after `govern --row apply-receipt` the router's ACTIVE vector is the applied receipt's; the DEFAULT vector stays the sheet's fallback.
  const active = onChain?.active ? onChain.last : undefined;
  const appliedWant = active ? weightKey(active.vaults, active.bps) : undefined;
  await c.run("router: default weights equal sheet", async () => {
    if (gotWeights === undefined) return { ok: false, detail: "getDefaultWeights unreadable" };
    const s = sheetWant();
    if (s.want === undefined) return { ok: false, detail: `no manifest vault for ${s.missing.join(",")}` };
    return { ok: gotWeights === s.want, detail: gotWeights === s.want ? `${rVaults!.length} weights${active ? " (the fallback; the applied receipt is the active vector)" : ""}` : `got ${gotWeights}, want ${s.want}` };
  });
  // Issue 1743: the DEFAULT vector alone is not what the router routes by. An active vector (setWeights, written by applyReceipt) overrides it while votedWeightsActive is true.
  // The deploy must leave none; an applied receipt must leave exactly one (a later clear drops it). The EFFECTIVE vector (what deposits use) must be the sheet's launch
  // vector, or the vector of the chain's last ReceiptApplied event while it is active.
  await c.run("router: votedWeightsActive is false after deploy, true after an applied receipt", async () => {
    if (onChain === undefined) return { ok: false, detail: scanError };
    const got = (await chain.read(at.router, "function votedWeightsActive() view returns (bool)")) as boolean;
    const want = active !== undefined;
    const why = active ? `receipt ${active.receiptId} applied in block ${active.block}` : onChain.last ? `receipt ${onChain.last.receiptId} cleared in block ${onChain.clearedAt}` : "no ReceiptApplied event";
    return { ok: got === want, detail: got === want ? `${got} (${why})` : `got ${got}, want ${want} (${why})` };
  });
  await c.run("router: effective weights equal the sheet's launch vector", async () => {
    if (gotEffective === undefined) return { ok: false, detail: "getEffectiveWeights unreadable" };
    if (onChain === undefined) return { ok: false, detail: scanError };
    let want: string;
    if (appliedWant !== undefined) want = appliedWant;
    else {
      const s = sheetWant();
      if (s.want === undefined) return { ok: false, detail: `no manifest vault for ${s.missing.join(",")}` };
      want = s.want;
    }
    return { ok: gotEffective === want, detail: gotEffective === want ? `${eVaults!.length} effective weights${active ? `, the applied receipt ${active.receiptId}` : ""}` : `getEffectiveWeights is ${gotEffective}, want ${want}` };
  });
  // Always present, so the label set is the same with and without an application. QA plan v1 C2: the run manifest's record must be what the chain did (the receipt and
  // the vector of the last ReceiptApplied event, absent exactly when there is none). Then an applied receipt reads released, and an active one routes deposits.
  await c.run("receipt: applied receipt is released and its weights are on the router", async () => {
    if (onChain === undefined) return { ok: false, detail: scanError };
    const last = onChain.last, rec = at.recorded;
    if (!last) return rec
      ? { ok: false, detail: `the run manifest records receipt ${rec.receiptId} as applied, the governance contract logged no ReceiptApplied since block ${at.scan!.fromBlock}: the record is not what the chain did` }
      : { ok: true, detail: "no receipt applied by govern" };
    if (!rec) return { ok: false, detail: `the chain applied receipt ${last.receiptId} in block ${last.block} and the run manifest records no application: every weight change must be a recorded govern round` };
    if (lc(rec.receiptId) !== lc(last.receiptId) || weightKey(rec.vaults, rec.bps) !== weightKey(last.vaults, last.bps)) {
      return { ok: false, detail: `the run manifest records receipt ${rec.receiptId} [${weightKey(rec.vaults, rec.bps)}], the chain's last ReceiptApplied (block ${last.block}) is receipt ${last.receiptId} [${weightKey(last.vaults, last.bps)}]` };
    }
    const released = (await chain.read(at.receipt, "function isReleased(bytes32 receiptId) view returns (bool)", [last.receiptId])) as boolean;
    if (!released) return { ok: false, detail: `receipt ${last.receiptId} reads not released` };
    if (!active) return { ok: true, detail: `receipt ${last.receiptId} released; its vector was cleared in block ${onChain.clearedAt}, the default vector routes deposits` };
    return { ok: gotEffective === appliedWant, detail: gotEffective === appliedWant ? `receipt ${last.receiptId} released, ${last.vaults.length} weights route deposits` : `router effective weights ${gotEffective}, the applied receipt's vector is ${appliedWant}` };
  });
}

async function vaultChecks(
  c: Collector, chain: ChainReader, v: ManifestVault, vs: VaultSheet | undefined,
  ctx: { tl: Address; registry: Address; safe: Address; sheet: VerifyOptions["sheet"]; recorder: Address; artifactsDir: string; v4AdapterArtifact?: string; scan?: VaultScan },
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
  // Issue 1705 C5: the vaults keep no role enumeration (EIP-170), so the holders are the RoleGranted grantees since the first deploy block that hold the role now.
  // "held by emergency key" alone passes with a second holder next to it; the roles enumeration label passes a second holder that is an expected account.
  await c.run(`${p}: ${EMERGENCY_ONE_HOLDER_LABEL}`, async () => {
    if (!ctx.scan) return { ok: false, detail: "block number unreadable: the RoleGranted scan cannot run" };
    const holders = await currentRoleHolders(chain, a, EMERGENCY_ROLE, ctx.scan);
    return { ok: holders.length === 1, detail: `${holders.length} holder(s)${holders.length ? `: ${holders.join(", ")}` : ""}` };
  });
  // RobotMoneyVault only: KEEPER_ROLE may call rebalance(), and a keeper could reverse an emergency drain (security review finding 6). The deploy grants it to no one.
  if (v.kind === "usdc") await c.run(`${p}: ${KEEPER_NO_HOLDER_LABEL}`, async () => {
    if (!ctx.scan) return { ok: false, detail: "block number unreadable: the RoleGranted scan cannot run" };
    const holders = await currentRoleHolders(chain, a, KEEPER_ROLE, ctx.scan);
    return { ok: holders.length === 0, detail: holders.length ? `KEEPER_ROLE is held by ${holders.join(", ")}` : "no grantee holds it" };
  });
  await c.runEq(`${p}: registry link`, () => chain.read(a, "function registry() view returns (address)"), registry);
  // setRegistry is one-shot: a second call from the deployer must revert (core 1483).
  await c.run(`${p}: a second setRegistry reverts`, async () => {
    const r = await chain.callRaw(a, encodeFunctionData({ abi: [parseAbiItem("function setRegistry(address registry)")], functionName: "setRegistry", args: [registry] }), D);
    return { ok: !r.ok, detail: r.ok ? "the call succeeded" : `reverted: ${r.reason ?? "no reason"}` };
  });
  if (!vs) {
    for (const l of ["tvlCap equals sheet", "perDepositCap equals sheet", "exitFeeBps equals sheet", "feeRecipient equals sheet", "feeRecipient is not deployer", "paused state equals sheet", "router eligibility equals sheet"]) c.fail(`${p}: ${l}`, "no sheet entry for this vault");
    if (v.kind !== "usdc") for (const l of ["asset config equals sheet", ...BASKET_GUARD_LABELS, UNWIND_GUARD_LABEL, SLIPPAGE_LABEL]) c.fail(`${p}: ${l}`, "no sheet entry for this vault");
    if (v.kind === "usdc") { for (const l of ["seed present", "totalSupply above zero", "manifest deployer share balance after seed is zero", "seed share receiver is named and is not the deployer", "deployer holds no shares", "seed share receiver holds the seed shares", ADAPTER_SET_LABEL]) c.fail(`${p}: ${l}`, "no sheet entry for this vault"); }
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
    await adapterSetCheck(c, chain, a, p, vs.adapters, ctx.scan);
  } else {
    await c.run(`${p}: asset config equals sheet`, async () => assetReadBack(chain, a, vs.assets));
    await basketGuardChecks(c, chain, a, p, vs);
    await unwindGuardCheck(c, chain, a, p, vs);
    // Issue 1705 C4 (core 1695 for rmAGENT): every basket's swap bound is read back against core's config (or the vault default the config keeps).
    await c.run(`${p}: ${SLIPPAGE_LABEL}`, async () => {
      if (vs.maxSlippageBps === undefined) return { ok: false, detail: "the verifier sheet has no expected maxSlippageBps for this vault" };
      const got = BigInt((await chain.read(a, "function maxSlippageBps() view returns (uint256)")) as bigint);
      return { ok: got === vs.maxSlippageBps, detail: got === vs.maxSlippageBps ? `${got}` : `got ${got}, want ${vs.maxSlippageBps}` };
    });
    // rmAGENT launches holding RM only (core 1554). "asset config equals sheet" ties the chain to the sheet, so this ties the sheet to RM.
    if (v.kind === "agent") await c.run(`${p}: holds RM as its one asset`, async () => ({ ok: vs.assets.length === 1 && lc(vs.assets[0]!.token) === lc(RM_TOKEN), detail: `sheet lists [${vs.assets.map((a) => a.token).join(", ")}], expected only ${RM_TOKEN}` }));
    // core 1676: every UniswapV4 asset is wired to the permissionless price recorder, the V4 adapter and the configured PoolKey.
    for (const asset of vs.assets.filter((x) => x.venue === VENUE_V4)) await v4AssetChecks(c, chain, v, asset, ctx);
  }
}

/** Issue 1705 C4 (core 1695 for rmAGENT, whose config raises the bound to 500 because the V4 pool fee alone is 291 bps). */
const SLIPPAGE_LABEL = "maxSlippageBps equals config";
/** Issue 1705 C5: one emergency key per vault, and no rebalance keeper on rmUSDC. */
const EMERGENCY_ONE_HOLDER_LABEL = "EMERGENCY_ROLE has exactly one holder";
const KEEPER_NO_HOLDER_LABEL = "KEEPER_ROLE has no holder";
/** Issue 1705 C4: rmUSDC's lending adapters against the vault stage (DeployVault.s.sol). */
const ADAPTER_SET_LABEL = "adapter set, caps and code-hash allowlist equal the deploy script";

type VaultScan = { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number };

/** The accounts that hold `role` on `at` now: every RoleGranted grantee since the first deploy block, kept when hasRole still answers true. */
async function currentRoleHolders(chain: ChainReader, at: Address, role: Hex, s: VaultScan): Promise<Address[]> {
  const logs = await scanLogs(chain, { address: at, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), role], fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs });
  const out: Address[] = [];
  for (const who of new Set(logs.map((l) => lc(topicToAddress(l.topics[2]!)) as Address))) if (await hasRole(chain, at, role, who)) out.push(who);
  return out;
}

/** The keys an allowlist setter event left allowed: the last event per key (topic 1) wins, its data word is the bool. */
async function allowlistAfterEvents(chain: ChainReader, at: Address, sig: string, s: VaultScan): Promise<Set<string>> {
  const logs = await scanLogs(chain, { address: at, topics: [keccak256(toHex(sig))], fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs });
  const last = new Map<string, boolean>();
  for (const l of [...logs].sort((x, y) => (x.blockNumber < y.blockNumber ? -1 : x.blockNumber > y.blockNumber ? 1 : 0))) last.set(lc(l.topics[1]!), BigInt(l.data === "0x" ? 0 : l.data) !== 0n);
  return new Set([...last].filter(([, on]) => on).map(([k]) => k));
}

/**
 * Issue 1705 C4: rmUSDC holds exactly the lending adapters its vault stage registered. The registry (`adapterCount`, `adapters(i)`) lists them in registration
 * order at the deploy script's caps, each active; each is on the address allowlist and its runtime code hash on the code-hash allowlist; and the allowlists hold
 * nothing else (replayed from AdapterAllowedSet and AdapterCodeHashAllowedSet since the first deploy block, because a mapping cannot be listed).
 */
async function adapterSetCheck(c: Collector, chain: ChainReader, a: Address, p: string, want: VaultSheet["adapters"], scan: VaultScan | undefined): Promise<void> {
  await c.run(`${p}: ${ADAPTER_SET_LABEL}`, async () => {
    if (!want || want.length === 0) return { ok: false, detail: "the verifier sheet names no adapter for this vault (the vault manifest names them, the deploy script sets their caps)" };
    const bad: string[] = [];
    const n = BigInt((await chain.read(a, "function adapterCount() view returns (uint256)")) as bigint);
    if (n !== BigInt(want.length)) bad.push(`adapterCount ${n}, the deploy script registers ${want.length}`);
    const hashes: string[] = [];
    for (const [i, w] of want.entries()) {
      const [adapter, capBps, active] = (await chain.read(a, "function adapters(uint256 index) view returns (address adapter, uint16 capBps, bool active)", [BigInt(i)])) as [Address, number | bigint, boolean];
      if (lc(adapter) !== lc(w.address)) bad.push(`adapters(${i}) is ${adapter}, the vault manifest names ${w.address}`);
      if (Number(capBps) !== w.capBps) bad.push(`adapters(${i}) cap ${capBps} bps, the deploy script sets ${w.capBps}`);
      if (!active) bad.push(`adapters(${i}) is not active`);
      if (!((await chain.read(a, "function adapterAllowed(address adapter) view returns (bool)", [w.address])) as boolean)) bad.push(`${w.address} is not on the adapter allowlist`);
      const hash = keccak256(await chain.getCode(w.address));
      hashes.push(lc(hash));
      if (!((await chain.read(a, "function adapterCodeHashAllowed(bytes32 codeHash) view returns (bool)", [hash])) as boolean)) bad.push(`the code hash of ${w.address} is not on the code-hash allowlist`);
    }
    if (!scan) bad.push("block number unreadable: the allowlist events cannot be replayed");
    else {
      const extraHash = [...(await allowlistAfterEvents(chain, a, SIG_ADAPTER_CODE_HASH_ALLOWED_SET, scan))].filter((h) => !hashes.includes(h));
      const extraAdapter = [...(await allowlistAfterEvents(chain, a, SIG_ADAPTER_ALLOWED_SET, scan))].map((t) => lc(topicToAddress(t as Hex))).filter((x) => !want.some((w) => lc(w.address) === x));
      if (extraHash.length) bad.push(`the code-hash allowlist also holds ${extraHash.join(", ")}`);
      if (extraAdapter.length) bad.push(`the adapter allowlist also holds ${extraAdapter.join(", ")}`);
    }
    return { ok: bad.length === 0, detail: bad.length ? bad.join("; ") : `${want.length} adapters at caps ${want.map((w) => w.capBps).join("/")} bps, both allowlists hold exactly them` };
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

/**
 * Core 1793 (QA plan D5): the live ring the recorder must hold. The USDC sell anchor reads the recorder over `BasketViews.SELL_ANCHOR_WINDOW`
 * (14,400 s). At one `record()` per 2 s block the ring keeps that window only with 14,400 / 2 + 1 = 7,201 slots
 * (`DeployUniswapV4PriceRecorder.RING_SLOTS`). A 901-slot ring (the 1800 s NAV floor, Deploy 2's recorder) lets a spammer evict the anchor's
 * history down to about 1,800 s, so the anchor gives no protection. The live `observationCardinality` is read, not `cardinalityNext`: a ring
 * grown with `grow(7201)` stays at its old size until its index wraps.
 */
export const RECORDER_RING_SLOTS = 7_201;

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
 * the recorder's live ring size (at least `RECORDER_RING_SLOTS`), and the absence of any admin selector in the recorder's runtime code (the negative invariant).
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
    const ok = Number(cardinality) >= RECORDER_RING_SLOTS;
    return {
      ok,
      detail: ok
        ? `observationCardinality ${cardinality}, the 14,400 s sell anchor window needs ${RECORDER_RING_SLOTS}`
        : `observationCardinality ${cardinality}, the 14,400 s sell anchor window needs ${RECORDER_RING_SLOTS} (core 1793): a spammer can evict the anchor's history from a smaller ring. Call grow(${RECORDER_RING_SLOTS}) and record until the index wraps, or deploy a new recorder`,
    };
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

/** QA plan v1 D7: the label unwindGuardCheck pushes on every basket vault. */
export const UNWIND_GUARD_LABEL = "emergencyUnwindGuard minUsdcOut above zero on every active asset of an open vault";
const UNWIND_GUARD_SIG = "function emergencyUnwindGuard(address token) view returns (uint256 minUsdcOut, bool overrideAllowed, uint256 maxLossBps)";

/**
 * QA plan v1 D7 (review E5, issue 1705 Q2). Before `govern --row set-unwind-guard` no stage or row set a basket's emergency unwind guard, so every guard read zero: emergencyUnwind
 * reverted EmergencyFloorUnavailable whenever a TWAP read failed, and emergencyUnwindWithOverride reverted EmergencyUnwindOverrideDisabled. A vault the sheet expects OPEN (its
 * unpause row executed) takes deposits, so each of its active assets (read from the chain) must read a non-zero minUsdcOut. A vault expected paused takes no deposit: the label
 * passes and records the values. Only the Safe, through the timelock, sets the guard (the row), so the pre-govern verify sees zeros and passes; the post-govern verify needs the row
 * run for every unpaused basket. The detail records overrideAllowed and maxLossBps too (QA plan v1 Decisions D3: override allowed, Safe-only), but only minUsdcOut is asserted.
 */
async function unwindGuardCheck(c: Collector, chain: ChainReader, vault: Address, p: string, vs: VaultSheet): Promise<void> {
  await c.run(`${p}: ${UNWIND_GUARD_LABEL}`, async () => {
    const active: Address[] = [];
    for (let i = 0; i < 64; i++) {
      let r: any;
      try { r = await chain.read(vault, ASSET_SIG, [BigInt(i)]); } catch { break; }
      const x = Array.isArray(r) ? r : [r.token, r.pool, r.swapFee, r.active, r.adapter, r.venue];
      if (Boolean(x[3])) active.push(x[0] as Address);
    }
    const guards: { token: Address; min: bigint; text: string }[] = [];
    for (const token of active) {
      const g = (await chain.read(vault, UNWIND_GUARD_SIG, [token])) as any;
      const [min, allowed, loss] = Array.isArray(g) ? g : [g.minUsdcOut, g.overrideAllowed, g.maxLossBps];
      guards.push({ token, min: BigInt(min), text: `${token} minUsdcOut ${BigInt(min)} overrideAllowed ${Boolean(allowed)} maxLossBps ${BigInt(loss)}` });
    }
    const values = guards.map((g) => g.text).join("; ");
    if (vs.expectPaused) return { ok: true, detail: `deposits paused, no guard required until the vault opens${values ? `: ${values}` : ""}` };
    if (active.length === 0) return { ok: false, detail: "the vault is open and lists no active asset: nothing proves an unwind floor" };
    const zero = guards.filter((g) => g.min === 0n).map((g) => g.token);
    return {
      ok: zero.length === 0,
      detail: zero.length === 0 ? values : `the vault is open and minUsdcOut is zero for ${zero.join(", ")}: an unwind whose TWAP read fails reverts and the override path is unusable. Run govern --row set-unwind-guard for this vault (${values})`,
    };
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
 * in the registry. The router's effective weights hold the new vault and not the old one, and the router caps the new vault's leg as it capped the old one's (QA plan v1 E3).
 */
async function redeployChecks(
  c: Collector, chain: ChainReader, r: NonNullable<VerifyOptions["redeploys"]>[number],
  ctx: { registry: Address; router: Address; tl: Address; vaults: ManifestVault[]; priorDir?: string; artifactsDir: string; artifact?: string; proxyArtifact?: string },
): Promise<void> {
  const p = `retired[${r.vault}]`;
  /**
   * Issue 1809: a vault deployed as a proxy (ADR-0014) runs its implementation. A non-zero ERC-1967 implementation slot is followed, and then the code AT the address must
   * be the proxy build too, so a contract that only writes the slot cannot borrow another's code. A direct (pre-proxy) vault reads a zero slot and is read as before.
   */
  const running = async (a: Address): Promise<{ code: Hex; proxyCode?: Hex; implementation?: Address }> => {
    const impl = wordAddress(await chain.getStorageAt(a, ERC1967_IMPLEMENTATION_SLOT));
    if (BigInt(impl) === 0n) return { code: await chain.getCode(a) };
    return { code: await chain.getCode(impl), proxyCode: await chain.getCode(a), implementation: impl };
  };
  const status = async (v: Address): Promise<number> => Number(((await chain.read(ctx.registry, "function getVault(address vault) view returns ((string name, address asset, uint256 registeredAt) metadata, uint8 status)", [v])) as [unknown, number])[1]);
  await c.run(`${p}: has code`, async () => (await chain.getCode(r.oldVault)).length > 2);
  await c.runEq(`${p}: registry status is Retired`, () => status(r.oldVault), 2);
  await c.runEq(`${p}: not router-eligible`, () => chain.read(ctx.registry, "function isRouterEligible(address vault) view returns (bool)", [r.oldVault]), false);
  await c.runEq(`${p}: deposits halted by the registry retire`, () => chain.read(r.oldVault, "function retired() view returns (bool)"), true);
  await c.runEq(`${p}: registry link`, () => chain.read(r.oldVault, "function registry() view returns (address)"), ctx.registry);
  await c.run(`${p}: runtime code serves redeemInKind`, async () => {
    const sel = toFunctionSelector("function redeemInKind(uint256 shares, address receiver, address owner)").slice(2);
    const run = await running(r.oldVault);
    return { ok: run.code.toLowerCase().includes(sel), detail: `selector ${sel}${run.implementation ? ` in the implementation ${run.implementation} behind the proxy` : ""}` };
  });
  await c.run(`${p}: runtime code equals the original build artifact (masked)`, async () => {
    if (!ctx.artifact) return { ok: false, detail: "no artifact name for the vault" };
    // QA plan v1 E1: the build that created this vault. A first round's old vault is the original deployment's (--prior-out); a later round's was deployed by the round before.
    const fromRedeploy = r.oldBuild === "redeploy";
    const dir = fromRedeploy ? ctx.artifactsDir : ctx.priorDir ?? ctx.artifactsDir;
    const run = await running(r.oldVault);
    const res = compareCode(run.code, loadArtifact(dir, ctx.artifact));
    let proxyNote = "";
    if (run.proxyCode !== undefined) {
      if (!ctx.proxyArtifact) return { ok: false, detail: `${r.oldVault} is a proxy (its ERC-1967 implementation slot names ${run.implementation}) but the stage table names no proxy build` };
      const px = compareCode(run.proxyCode, loadArtifact(dir, ctx.proxyArtifact));
      if (!px.ok) return { ok: false, detail: `${r.oldVault} names the implementation ${run.implementation} but does not run the ${ctx.proxyArtifact} build: ${px.detail}` };
      proxyNote = ` (the implementation ${run.implementation} behind the ${ctx.proxyArtifact} proxy)`;
    }
    return { ok: res.ok, detail: `${ctx.artifact}${proxyNote} (${fromRedeploy ? "the redeploy build" : "the original build"}): ${res.detail}${!res.ok && !fromRedeploy && ctx.priorDir === undefined ? " (pass --prior-out <forge out/ of a checkout at the original sha>)" : ""}` };
  });
  const q = `redeploy[${r.vault}]`;
  await c.run(`${q}: the vault manifest names the replacing vault`, async () => {
    const m = ctx.vaults.find((v) => v.key === r.vault);
    return { ok: !!m && lc(m.address) === lc(r.newVault), detail: m ? `manifest ${m.address}, run record ${r.newVault}` : "no manifest vault" };
  });
  await c.runEq(`${q}: replacing vault registry status is Active`, () => status(r.newVault), 0);
  await c.run(`${q}: router effective weights hold the replacing vault and not the retired one`, async () => {
    const [vs] = (await chain.read(ctx.router, "function getEffectiveWeights() view returns (address[] vaults, uint256[] bps)")) as [string[], bigint[]];
    const ok = vs.some((v) => lc(v) === lc(r.newVault)) && !vs.some((v) => lc(v) === lc(r.oldVault));
    return { ok, detail: `[${vs.join(", ")}]` };
  });
  // QA plan v1 E3 (review F2): `vaultCap` is keyed by address and 0 is uncapped, so a replacing vault without the batch's setVaultCap would take routed deposits with no per-leg cap
  await c.run(`${q}: router.vaultCap(new) equals router.vaultCap(old)`, async () => {
    const cap = async (v: Address): Promise<bigint> => BigInt((await chain.read(ctx.router, "function vaultCap(address vault) view returns (uint256)", [v])) as bigint);
    const [now, old] = [await cap(r.newVault), await cap(r.oldVault)];
    return { ok: now === old, detail: `router.vaultCap(new) ${now}, router.vaultCap(old) ${old}${old === 0n ? " (0: uncapped)" : ""}` };
  });
}
