// The one verifier (stage 12). Same code, same labels on the Twin chain (918453) and Base mainnet (8453).
// Replaces the three superseded verifier shell scripts and the stage verifier.
// Read-only: it sends nothing.
import { encodeFunctionData, keccak256, parseAbiItem, toHex } from "viem";
import { Collector } from "./collector.ts";
import { compareCode, loadArtifact } from "./codehash.ts";
import {
  ADMIN_ROLE, WEIGHT_SETTER_ROLE, CANCELLER_ROLE, coreContracts, EMERGENCY_ROLE, EXECUTOR_ROLE, DEPOSIT_PAUSER_ROLE, PROPOSER_ROLE, SIG_AGENT_AUTHORIZED,
  SIG_AGENT_OWNERSHIP, SIG_ROLE_GRANTED, Z32, ZERO, minDelayFloor, requiredManifests, stageManifestName,
} from "./constants.ts";
import { manifestBase } from "../stage-table.ts";
import { SAFE_MANIFEST } from "../core-wiring.ts";
import { isAddress, loadManifests, lc, type ManifestVault } from "./manifests.ts";
import { padTopic, scanLogs, topicToAddress } from "./logs.ts";
import { safeChecks } from "./safe-checks.ts";
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
  const manifestSet = man.vaults.map((v) => lc(v.address));
  await c.run("vault set: manifests equal registry.listVaults", async () => {
    if (!listOk) return { ok: false, detail: "listVaults unreadable" };
    const missingOnChain = manifestSet.filter((a) => !chainVaults.includes(a));
    const missingInManifest = chainVaults.filter((a) => !manifestSet.includes(a));
    const dupes = manifestSet.length !== new Set(manifestSet).size;
    const ok = !missingOnChain.length && !missingInManifest.length && !dupes;
    return { ok, detail: ok ? `${manifestSet.length} vaults` : `in manifests only: [${missingOnChain}] on chain only: [${missingInManifest}]${dupes ? " duplicate manifest address" : ""}` };
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
  const targets: { name: string; address: Address }[] = [
    ...core.map((x) => ({ name: x.name, address: x.address })),
    ...man.vaults.map((v) => ({ name: `vault[${v.key}]`, address: v.address })),
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
  // setWeights is gated by WEIGHT_SETTER_ROLE: only RouterGovernance holds it, so the timelock and the Safe cannot bypass the vote.
  await c.runEq("router: WEIGHT_SETTER_ROLE held by governance", () => hasRole(chain, router, WEIGHT_SETTER_ROLE, byName.governance), true);
  const setterHolders: Array<[string, Address]> = [["timelock", tl], ["deployer", D], ["safe", safe], ["pauser", sheet.pauser], ["emergency", sheet.emergency]];
  for (const [who, addr] of setterHolders) {
    await c.runEq(`router: WEIGHT_SETTER_ROLE not held by ${who}`, () => hasRole(chain, router, WEIGHT_SETTER_ROLE, addr), false);
  }
  await c.runEq("gateway: not paused", () => chain.read(gateway, "function depositsPaused() view returns (bool)"), false);
  // The router-first split (core 1493): the gateway and the registry both name the router the router stage deployed.
  await c.runEq("gateway: router() equals the deployed router", async () => lc((await chain.read(gateway, "function router() view returns (address)")) as string), lc(router));
  await c.runEq("registry: router() equals the deployed router", async () => lc((await chain.read(registry, "function router() view returns (address)")) as string), lc(router));

  // ---- deploy-time configuration, set by the deployer before the handover and never touched by govern (issue 1520)
  await deployTimeChecks(c, chain, sheet, { governance: byName.governance!, router, vaults: man.vaults });

  // ---- vaults
  for (const v of man.vaults) await vaultChecks(c, chain, v, sheet.vaults[v.key], { tl, registry, safe, sheet });

  // ---- gateway agents, derived from logs
  const head = await chain.blockNumber().catch(() => undefined);
  const chunk = opts.logChunk ?? 2000;
  const retryBaseMs = opts.retryBaseMs ?? 500;
  if (head === undefined) {
    c.fail("agents: every deployer agent is owned by timelock", "block number unreadable");
    c.fail("agents: at least one deployer agent found in gateway logs", "block number unreadable");
    c.fail("agents: manifest listed count equals derived count", "block number unreadable");
    c.fail("agents: manifest says deployer owns no listed agent", "block number unreadable");
    c.fail("deployer: holds no role on any contract (log scan)", "block number unreadable");
  } else {
    await agentChecks(c, chain, gateway, tl, D, tlManifest, { fromBlock: opts.fromBlock, head, chunk, retryBaseMs });
    await roleScan(c, chain, D, { fromBlock: opts.fromBlock, head, chunk, retryBaseMs });
  }

  // ---- timelock
  const floor = minDelayFloor(sheet.chainId);
  let delay = 0n;
  await c.run("timelock: min delay at least chain floor", async () => {
    delay = BigInt((await chain.read(tl, "function getMinDelay() view returns (uint256)")) as bigint);
    return { ok: delay >= BigInt(floor), detail: `delay ${delay}, floor ${floor}` };
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
  await safeChecks(c, chain, safe, sheet, tlManifest.code_hashes?.safe);

  // ---- libraries recorded
  const libNames = Object.keys(man.libraries).sort();
  c.push(`libraries: recorded in ${stageManifestName(table, "libs")}.json`, libNames.length > 0, libNames.length ? `${libNames.length} recorded` : "none recorded");
  for (const n of libNames) await c.run(`library[${n}]: has code`, async () => (await chain.getCode(man.libraries[n])).length > 2);

  // ---- code hashes against the build, immutables and links masked
  const codeTargets: { label: string; address: Address; artifact: string }[] = [
    ...core.map((x) => ({ label: x.name, address: x.address, artifact: x.artifact })),
    ...man.vaults.map((v) => ({ label: `vault[${v.key}]`, address: v.address, artifact: sheet.vaults[v.key]?.contract ?? v.artifact })),
    ...libNames.map((n) => ({ label: `library[${n}]`, address: man.libraries[n], artifact: man.libraryArtifacts[n]! })),
  ];
  for (const t of codeTargets) {
    await c.run(`${t.label}: runtime code equals build artifact (masked)`, async () => {
      const r = compareCode(await chain.getCode(t.address), loadArtifact(opts.artifactsDir, t.artifact));
      return { ok: r.ok, detail: `${t.artifact}: ${r.detail}` };
    });
  }

  // ---- deployer nonce equals the sum of the frozen counts
  await c.run("deployer: nonce equals sum of frozen counts", async () => {
    const want = Object.values(opts.frozenCounts).reduce((a, b) => a + b, 0);
    const got = await chain.nonce(D);
    const frozen = Object.keys(opts.frozenCounts).length > 0;
    // After govern the deployer has paid Safe execTransaction gas, so the live nonce is above the sum. The runner's own record of the nonce
    // at the end of the deploy stages stands in for it, and the live nonce may only be at or above that record.
    const rec = opts.deployerNonceAtDeployEnd;
    if (rec !== undefined) return { ok: frozen && rec === want && got >= rec, detail: `recorded nonce at deploy end ${rec}, frozen sum ${want}, live nonce ${got} (govern ran)` };
    return { ok: frozen && got === want, detail: `nonce ${got}, frozen sum ${want}` };
  });

  return c.report();
}

async function deployTimeChecks(
  c: Collector, chain: ChainReader, sheet: VerifyOptions["sheet"], at: { governance: Address; router: Address; vaults: ManifestVault[] },
): Promise<void> {
  const g = sheet.governance;
  await c.run("governance: votingPower of every voter equals sheet", async () => {
    const bad: string[] = [];
    for (const v of g.voters) if (BigInt((await chain.read(at.governance, "function votingPower(address voter) view returns (uint256)", [v])) as bigint) !== g.voterPower) bad.push(v);
    return { ok: bad.length === 0, detail: bad.length ? `differs from ${g.voterPower} for ${bad.join(",")}` : `${g.voters.length} voters at ${g.voterPower}` };
  });
  await c.runEq("governance: quorumThreshold equals sheet", () => chain.read(at.governance, "function quorumThreshold() view returns (uint256)"), g.quorum);
  await c.runEq("governance: votingPeriod equals sheet", () => chain.read(at.governance, "function votingPeriod() view returns (uint64)"), g.votingPeriod);
  await c.runEq("governance: executionDelay equals sheet", () => chain.read(at.governance, "function executionDelay() view returns (uint64)"), g.executionDelay);
  await c.run("router: default weights equal sheet", async () => {
    const addrOf = new Map(at.vaults.map((v) => [v.key, v.address]));
    const missing = sheet.defaultWeights.filter((w) => !addrOf.has(w.vault)).map((w) => w.vault);
    if (missing.length) return { ok: false, detail: `no manifest vault for ${missing.join(",")}` };
    const [vaults, bps] = (await chain.read(at.router, "function getDefaultWeights() view returns (address[] vaults, uint256[] bps)")) as [string[], bigint[]];
    const got = vaults.map((v, i) => `${lc(v)}:${bps[i]}`).join(",");
    const want = sheet.defaultWeights.map((w) => `${lc(addrOf.get(w.vault)!)}:${w.bps}`).join(",");
    return { ok: got === want, detail: got === want ? `${vaults.length} weights` : `got ${got}, want ${want}` };
  });
}

async function vaultChecks(
  c: Collector, chain: ChainReader, v: ManifestVault, vs: VaultSheet | undefined,
  ctx: { tl: Address; registry: Address; safe: Address; sheet: VerifyOptions["sheet"] },
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
    if (v.kind !== "usdc") c.fail(`${p}: asset config equals sheet`, "no sheet entry for this vault");
    else { for (const l of ["seed present", "totalSupply above zero", "manifest deployer share balance after seed is zero", "seed share receiver is named and is not the deployer", "deployer holds no shares", "seed share receiver holds the seed shares"]) c.fail(`${p}: ${l}`, "no sheet entry for this vault"); }
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
    if (v.kind === "agent") await c.run(`${p}: ships with no assets`, async () => ({ ok: vs.assets.length === 0, detail: `sheet lists ${vs.assets.length} assets` }));
  }
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

async function agentChecks(
  c: Collector, chain: ChainReader, gateway: Address, tl: Address, deployer: Address, timelockManifest: any,
  s: { fromBlock: bigint; head: bigint; chunk: number; retryBaseMs: number },
): Promise<void> {
  let agents: string[] = [];
  let scanErr: string | undefined;
  try {
    const t1 = keccak256(toHex(SIG_AGENT_AUTHORIZED)), t2 = keccak256(toHex(SIG_AGENT_OWNERSHIP));
    const base = { address: gateway, fromBlock: s.fromBlock, toBlock: s.head, chunk: s.chunk, retryBaseMs: s.retryBaseMs };
    const l1 = await scanLogs(chain, { ...base, topics: [t1, null, padTopic(deployer)] });
    const l2 = await scanLogs(chain, { ...base, topics: [t2, null, null, padTopic(deployer)] });
    agents = [...new Set([...l1, ...l2].map((l) => lc(topicToAddress(l.topics[1]))))];
  } catch (e: any) { scanErr = String(e?.message ?? e); }
  if (scanErr) {
    for (const l of ["agents: every deployer agent is owned by timelock", "agents: at least one deployer agent found in gateway logs", "agents: manifest listed count equals derived count"]) c.fail(l, scanErr);
  } else {
    await c.run("agents: every deployer agent is owned by timelock", async () => {
      const bad: string[] = [];
      for (const ag of agents) {
        const o = lc((await chain.read(gateway, "function agentOwner(address) view returns (address)", [ag])) as string);
        const admin = await hasRole(chain, gateway, ADMIN_ROLE, ag as Address);
        if (o !== lc(tl) || admin) bad.push(ag);
      }
      return { ok: bad.length === 0, detail: bad.length ? `not owned by timelock or holds ADMIN: ${bad}` : `${agents.length} agents` };
    });
    c.push("agents: at least one deployer agent found in gateway logs", agents.length > 0, `${agents.length} found from block ${s.fromBlock}`);
    c.eq("agents: manifest listed count equals derived count", timelockManifest.roles?.gateway_agents_listed_count, agents.length);
  }
  c.eq("agents: manifest says deployer owns no listed agent", timelockManifest.roles?.deployer_owns_a_listed_gateway_agent, false);
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
