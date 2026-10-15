// Stage 12 verify: the one verifier (src/verify). The CLI builds the verifier's sheet from the frozen sheet, reads the expected
// asset config from the core config file (never from the chain it is checking) and fails the run on any failed check.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { PublishError } from "./errors.ts";
import { effectiveCounts } from "./counts.ts";
import { resumeCommand } from "./govern.ts";
import { MAINNET_CHAIN_ID } from "./floors.ts";
import { kindLabel } from "./chains.ts";
import { adoptedTxs, governHasRun, measuredCounts, manifestDir, saveRunManifest, readManifestField, type RunContext, type RunManifest } from "./runner.ts";
import { BASKET_KEYS, VAULT_KEYS, VAULT_NAME, eligibleInOrder, type VaultKey } from "./sheet.ts";
import { LENDING_ADAPTERS, RECORDER_STAGE, VAULT_RECORDER_FIELD, VENUE_V4, adapterFieldFor } from "./core-wiring.ts";
import { ROUTER_STAGE_ELIGIBLE, STAGE13_UNPAUSE_VAULTS, expectPausedAfter, isSeeded, routerEligibleAtDeploy, vaultRule } from "./vault-rules.ts";
import { PROOF_STAGE } from "./control-proof.ts";
import { expectedMaxSlippageBps, loadConfigAssets } from "./asset-config.ts";
import { manifestBase, tableProxies } from "./stage-table.ts";
import { checkoutRootOf } from "./build-provenance.ts";
import { immutabilityOf, layoutIdFieldOf, type ProxyRecord } from "./proxies.ts";
import { DEPLOYER_STAGES, VAULT_STAGES, getStageTable, manifestRef, type StageRow } from "./stages.ts";
import { upgradeBuildDir, upgradeBuildProblem, verifyDeployment, verifySources, viemReader, type VerifyReport, type VerifySheet, type VerifyOptions, type VaultSheet } from "./verify/index.ts";
import { recordDependencyManifest, type RecorderSpawn } from "./record-dependencies.ts";
import { contractsFromManifests } from "./verify/sources.ts";
import { REDEPLOY_ROW, oldVaultBuild, redeploysOf, retiredProxiesOf, verifyBuildRefusal } from "./redeploy-vault.ts";

/**
 * The expected asset config of one vault: core's config files (poolFee becomes swapFee) with the adapter this run deployed, read from the
 * vault manifest. rmUSDC holds no basket assets and rmAGENT launches with RM only.
 */
export function loadExpectedAssets(ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">, key: VaultKey): VaultSheet["assets"] {
  const configured = loadConfigAssets(ctx.coreDir, key);
  if (configured.length === 0) return [];
  const vaultStage = getStageTable().vaults.find((v) => v.key === key)!.stage;
  const vaultManifest = manifestBase(getStageTable().stages.find((s) => s.name === vaultStage)!.manifest);
  return configured.map((a) => {
    // A UniswapV4 asset is registered with the price recorder as its pool (V4 has no pool address) and the V4 adapter the vault stage deployed.
    const adapter = readManifestField(ctx, `${vaultManifest}:${adapterFieldFor(a.venue)}`) as `0x${string}`;
    const pool = a.venue === VENUE_V4 ? (readManifestField(ctx, `${manifestBase(getStageTable().stages.find((s) => s.name === RECORDER_STAGE)!.manifest)}:${VAULT_RECORDER_FIELD}`) as `0x${string}`) : a.pool;
    return { token: a.token, pool, swapFee: a.swapFee, adapter, venue: a.venue, ...(a.v4 ? { v4: a.v4 } : {}) };
  });
}

/**
 * Issue 1705 C4: the lending adapters the vault stage registered, in registration order: each address from the vault manifest (the adapters are
 * deployed per run) and its cap from the deploy script (core-wiring LENDING_ADAPTERS, checked against the script by core parity). A missing manifest
 * field is an error, not a silent skip.
 */
export function loadExpectedAdapters(ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">, key: VaultKey): NonNullable<VaultSheet["adapters"]> {
  const wiring = LENDING_ADAPTERS[key];
  if (!wiring) return [];
  const vaultManifest = manifestBase(getStageTable().stages.find((s) => s.name === wiring.stage)!.manifest);
  return wiring.adapters.map((w) => ({ address: readManifestField(ctx, `${vaultManifest}:${w.field}`) as `0x${string}`, capBps: w.capBps }));
}

/**
 * The vaults the govern unpause rows have unpaused: a vault is listed once the run manifest records the executed phase of its own row
 * `unpause-<VAULT>` (one round per vault). Before that phase, none. A vault whose row was skipped (not in GOVERN_UNPAUSE_VAULTS) stays paused.
 */
export function unpausedByGovern(manifest: Pick<RunManifest, "govern">, sheet: RunContext["sheet"]): VaultKey[] {
  const g = manifest.govern as Record<string, { executed?: unknown } | undefined> | undefined;
  return sheet.govern.unpauseVaults.filter((k) => !!g?.[vaultRule(k).unpauseRow]?.executed);
}

/** The vaults whose unpause rows are stage 13 on 8453: the stage table's `unpauseInStage13` (all four since issue 1710; the sheet parser requires every one listed). */
export const MAINNET_UNPAUSE_VAULTS: readonly VaultKey[] = STAGE13_UNPAUSE_VAULTS;

type RowPhase = "none" | "scheduled" | "executed";
const phaseOf = (g: Record<string, { scheduled?: unknown; executed?: unknown } | undefined> | undefined, row: string): RowPhase =>
  g?.[row]?.executed ? "executed" : g?.[row]?.scheduled ? "scheduled" : "none";

/**
 * The govern state stage 12 verifies on 8453 (issue 1667, four vaults since issue 1710), read from the run manifest's CURRENT round of each unpause row.
 *   pre-govern   no unpause row is scheduled: all four vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA) must read paused.
 *   post-govern  all four unpause rows are executed: all four vaults must read unpaused.
 *   part-way     anything else (some but not all rows scheduled or executed): verify refuses.
 * The manifest picks the mode only. runVerifyStage then confirms it against the chain and fails closed when they disagree.
 */
export type MainnetGovernMode = { mode: "pre-govern" | "post-govern" } | { mode: "part-way"; detail: string };
export function mainnetGovernMode(manifest: Pick<RunManifest, "govern">): MainnetGovernMode {
  const g = manifest.govern as Record<string, { scheduled?: unknown; executed?: unknown } | undefined> | undefined;
  const rows = MAINNET_UNPAUSE_VAULTS.map((k) => [vaultRule(k).unpauseRow, phaseOf(g, vaultRule(k).unpauseRow)] as const);
  if (!(rows.every(([, p]) => p === "none") || rows.every(([, p]) => p === "executed"))) {
    return { mode: "part-way", detail: rows.map(([r, p]) => `${r} ${p === "none" ? "not scheduled" : p}`).join(", ") };
  }
  return { mode: rows[0]![1] === "executed" ? "post-govern" : "pre-govern" };
}

/** The timelock delay the chain should read: GOVERN_NEW_DELAY once the executed phase of the govern row `update-delay` ran, else TIMELOCK_MIN_DELAY. */
export function expectedTimelockDelay(manifest: Pick<RunManifest, "govern">, sheet: RunContext["sheet"]): number {
  const g = manifest.govern as Record<string, { executed?: unknown } | undefined> | undefined;
  return g?.["update-delay"]?.executed ? Number(sheet.govern.newDelay) : Number(sheet.timelockMinDelay);
}

/**
 * The verifier's sheet, from the frozen sheet. Every per-vault rule comes from the stage table's vault rules (issue 1705, src/vault-rules.ts), never from a
 * vault literal: a vault the table deploys paused reads paused until its unpause row executed (all four since issue 1710), router eligibility comes from the
 * router stage or from ELIGIBLE_VAULTS, and only a seeded vault carries the seed. The link between the govern rows and the reads: a vault the unpause rows
 * unpaused is expected paused=false. So a verify run after govern fails when an unpause row ran and the vault still reads paused, and when a vault reads
 * unpaused with no unpause row behind it. The rmUSDC lending adapters come from the vault manifest and the deploy script's caps (core-wiring LENDING_ADAPTERS),
 * each basket's swap bound from its config or the vault default (expectedMaxSlippageBps).
 */
export function buildVerifySheet(ctx: Pick<RunContext, "sheet" | "coreDir" | "chainId" | "manifestOut">, safeAddress: string, unpaused: readonly VaultKey[] = [], timelockDelay?: number): VerifySheet {
  const s = ctx.sheet;
  const vaults: Record<string, VaultSheet> = {};
  for (const k of VAULT_KEYS) {
    const v = s.vaults[k];
    vaults[VAULT_NAME[k]] = {
      tvlCap: v.tvlCap, perDepositCap: v.perDepositCap, exitFeeBps: v.exitFeeBps,
      ...((BASKET_KEYS as readonly VaultKey[]).includes(k) ? { navDeviationBps: v.navDeviationBps, minPoolLiquidity: v.minPoolLiquidity, maxSlippageBps: expectedMaxSlippageBps(ctx.coreDir, k) } : {}),
      feeRecipient: (s.feeRecipient === "@safe" ? safeAddress : s.feeRecipient) as `0x${string}`,
      expectPaused: expectPausedAfter(k, unpaused),
      routerEligible: routerEligibleAtDeploy(k, s.eligibleVaults),
      assets: loadExpectedAssets(ctx, k),
      ...(LENDING_ADAPTERS[k] ? { adapters: loadExpectedAdapters(ctx, k) } : {}),
      ...(isSeeded(k) ? { seed: s.seedDeposit, seedShareReceiver: s.shareReceiver } : {}),
    };
  }
  return {
    chainId: ctx.chainId, deployer: s.admin, pauser: s.pauser, emergency: s.emergency, safeOwners: s.safeOwners, safeThreshold: s.safeThreshold,
    timelockDelay: timelockDelay ?? Number(s.timelockMinDelay), deploymentKind: s.kind, vaults,
    // issue 1698: no governance block. The weight setter has no voting surface; the verifier reads its receipt register and router wiring instead.
    defaultWeights: ([...ROUTER_STAGE_ELIGIBLE, ...eligibleInOrder(s)] as VaultKey[]).map((k) => ({ vault: VAULT_NAME[k], bps: s.weights.find((w) => w.key === k)!.bps })),
    // issue 1809: the release mode every proxy must carry (ADR-0014 §5)
    upgradeMode: s.upgradeMode,
  };
}

/**
 * Security round 2 (review: SECURITY_LIFECYCLE_GAP): the address a table proxy name reaches NOW (its stage manifest), or undefined. Upgrade and freeze history is
 * recorded by name AND address: after a redeploy-vault the vault's manifest names the NEW vault under the table's name, so an entry recorded at the old address is
 * the retired proxy's (`<vault>.retired-<n>`), never the new one's. Without it the new vault inherited the old one's freeze (its frozen label failed and pause-all fired)
 * or its upgrade (its slot was expected on the old upgrade's target).
 */
export type ProxyAddressOf = (proxy: string) => string | undefined;
/** An entry recorded for `name` at `recorded` belongs to the proxy that name reaches now: always without `addressOf`, a recorded address, or a current one. */
const sameProxy = (addressOf: ProxyAddressOf | undefined, name: string, recorded: unknown): boolean => {
  if (!addressOf || typeof recorded !== "string") return true;
  const now = addressOf(name);
  return now === undefined || now.toLowerCase() === recorded.toLowerCase();
};
/** The address each table proxy names in this run's stage manifests (undefined when the manifest or the field is absent). */
export function currentProxyAddresses(ctx: Parameters<typeof readManifestField>[0]): ProxyAddressOf {
  const byName = new Map(tableProxies(getStageTable()).map((p) => [p.name, p]));
  return (name) => {
    const p = byName.get(name);
    if (!p) return undefined;
    try { return readManifestField(ctx, manifestRef(p.stage, p.field)); } catch { return undefined; }
  };
}

/**
 * Issue 1809: the implementation each proxy names since the last EXECUTED `govern --row upgrade-proxy` round, from the run manifest's `proxy_upgrades` (later entries
 * win), with the forge out/ the round compared it with. A record only picks which implementation and build the verifier expects; the chain is read for both.
 * Security round 1: with the commit the round proved that build was made from (`build_sha`), which the verifier holds the build directory to.
 * Security round 2: with `addressOf`, only rounds recorded at the address the name reaches now (`proxy_address`) count.
 */
export function upgradesOf(manifest: Pick<RunManifest, "proxy_upgrades">, addressOf?: ProxyAddressOf): NonNullable<VerifyOptions["upgrades"]> {
  const last = new Map<string, { proxy: string; implementation: `0x${string}`; buildDir?: string; buildSha?: string }>();
  for (const e of (Array.isArray(manifest.proxy_upgrades) ? manifest.proxy_upgrades : []) as { proxy?: unknown; proxy_address?: unknown; implementation?: unknown; build_dir?: unknown; build_sha?: unknown; execute_tx?: unknown }[]) {
    if (typeof e?.proxy !== "string" || typeof e.implementation !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(e.implementation) || typeof e.execute_tx !== "string") continue;
    if (!sameProxy(addressOf, e.proxy, e.proxy_address)) continue;
    last.set(e.proxy, { proxy: e.proxy, implementation: e.implementation as `0x${string}`, ...(typeof e.build_dir === "string" ? { buildDir: e.build_dir } : {}), ...(typeof e.build_sha === "string" ? { buildSha: e.build_sha } : {}) });
  }
  return [...last.values()];
}

/**
 * Security round 1: per proxy, the storage-layout identifier the last EXECUTED upgrade-proxy round recorded for the build it installed (`build_layout_hash`) and that
 * build's directory. proxyEvidence records it as the proxy's layout and holds it to the snapshot of the build's own checkout. Security round 2: bound to the address
 * like upgradesOf.
 */
export function upgradeLayoutsOf(manifest: Pick<RunManifest, "proxy_upgrades">, addressOf?: ProxyAddressOf): Map<string, { layoutHash?: string; buildDir?: string }> {
  const out = new Map<string, { layoutHash?: string; buildDir?: string }>();
  for (const e of (Array.isArray(manifest.proxy_upgrades) ? manifest.proxy_upgrades : []) as { proxy?: unknown; proxy_address?: unknown; build_layout_hash?: unknown; build_dir?: unknown; execute_tx?: unknown }[]) {
    if (typeof e?.proxy !== "string" || typeof e.execute_tx !== "string") continue;
    if (!sameProxy(addressOf, e.proxy, e.proxy_address)) continue;
    out.set(e.proxy, { ...(typeof e.build_layout_hash === "string" ? { layoutHash: e.build_layout_hash } : {}), ...(typeof e.build_dir === "string" ? { buildDir: e.build_dir } : {}) });
  }
  return out;
}

/**
 * Security round 3 (review: RELIABILITY_FAIL_CLOSED_OUTAGE): the run manifest as this verify reads it, with `--upgrade-build <proxy>=<dir>` (`overrides`, absolute
 * directories) standing for the `build_dir` of that proxy's upgrade rounds. A copy: the override is never written into the run manifest or the evidence.
 */
export function withUpgradeBuilds<M extends Pick<RunManifest, "proxy_upgrades">>(manifest: M, overrides: Readonly<Record<string, string>> | undefined): M {
  if (!overrides || Object.keys(overrides).length === 0 || !Array.isArray(manifest.proxy_upgrades)) return manifest;
  const at = (e: unknown): string | undefined => { const p = (e as { proxy?: unknown } | null)?.proxy; return typeof p === "string" && Object.prototype.hasOwnProperty.call(overrides, p) ? overrides[p] : undefined; };
  return { ...manifest, proxy_upgrades: manifest.proxy_upgrades.map((e) => (at(e) !== undefined ? { ...(e as object), build_dir: at(e) } : e)) } as M;
}

/**
 * Security round 3 (review: SECURITY_AVAILABILITY_SELF_PAUSE, RELIABILITY_FAIL_CLOSED_OUTAGE): the verify of a run with an executed upgrade-proxy round compares the
 * upgraded proxy with the round's build (`build_dir`, held to `build_sha`). That directory is a path on the machine that ran govern: deleted, moved, checked out at the
 * next release, written relative to govern's working directory, or simply absent on the machine that verifies. The code label then failed, verify threw VERIFY and
 * cli.ts paused deposits on all four vaults, though nothing on chain was wrong. This runs the verifier's own build rules (verify/index.ts upgradeBuildProblem) and the
 * layout label's (the build checkout's snapshot hashes to the round's build_layout_hash) BEFORE the verifier, for every upgrade it will compare, and returns a refusal
 * (USAGE, `details.refused_before_verify`, so cli.ts pauses nothing) that names each build and the `--upgrade-build` that supplies it. Undefined: every build holds.
 * Pass the manifest through withUpgradeBuilds first. `ctx.upgradeBuilds` names the overrides, which must each name an upgraded proxy.
 */
export function upgradeBuildRefusal(manifest: Pick<RunManifest, "proxy_upgrades">, ctx: Pick<RunContext, "chainId" | "coreDir" | "upgradeBuilds">, addressOf?: ProxyAddressOf): PublishError | undefined {
  const ups = upgradesOf(manifest, addressOf);
  const rounds = upgradeLayoutsOf(manifest, addressOf);
  const byName = new Map(tableProxies(getStageTable()).map((p) => [p.name, p]));
  const mainnet = ctx.chainId === MAINNET_CHAIN_ID;
  const problems: string[] = [];
  for (const name of Object.keys(ctx.upgradeBuilds ?? {})) {
    if (!ups.some((u) => u.proxy === name)) problems.push(`--upgrade-build names ${name}, which no executed upgrade-proxy round of this run moved (upgraded: ${ups.map((u) => u.proxy).join(", ") || "none"})`);
  }
  for (const u of ups) {
    const px = byName.get(u.proxy);
    // the verifier holds a round to its build only when the round recorded build_sha (every 8453 round does; a Twin build outside a checkout does not)
    if (u.buildSha === undefined || !px) continue;
    if (u.buildDir !== undefined && !isAbsolute(u.buildDir)) { problems.push(`${u.proxy}: the round recorded build_dir ${u.buildDir}, a path relative to the directory govern ran in, which the record does not keep`); continue; }
    if (u.buildDir !== undefined && !existsSync(u.buildDir)) { problems.push(`${u.proxy}: the round's build ${u.buildDir} does not exist on this machine (deleted, moved, or recorded on another host)`); continue; }
    const dir = upgradeBuildDir(u, join(ctx.coreDir, "out"));
    const why = upgradeBuildProblem({ dir, buildSha: u.buildSha, artifact: px.artifact, mainnet });
    if (why) { problems.push(`${u.proxy}: ${why}`); continue; }
    const recorded = rounds.get(u.proxy)?.layoutHash;
    const checkout = u.buildDir !== undefined ? checkoutRootOf(u.buildDir) : undefined;
    const built = checkout && recorded !== undefined && /^0x[0-9a-fA-F]{64}$/.test(recorded) && !/^0x0{64}$/.test(recorded) ? layoutHashOf(checkout, px.artifact) : undefined;
    if (built !== undefined && built !== recorded!.toLowerCase()) problems.push(`${u.proxy}: the storage-layout snapshot of the build checkout ${checkout} hashes to ${built}, the round recorded build_layout_hash ${recorded}: the checkout is modified (restore it with git checkout)`);
  }
  if (problems.length === 0) return undefined;
  const fix = `Each upgraded proxy is compared with the build its round proved: a checkout at the round's build_sha${mainnet ? ", whose own out/ was built there with forge build" : ""}. Restore it at the recorded path, or check it out anywhere and name its out/: bun publish-contracts/src/cli.ts verify --upgrade-build <proxy>=<out/ of that checkout> (one per proxy, plus the same --chain, --rpc, --sheet, --signer, --environment and --evidence arguments)`;
  return new PublishError("USAGE", `verify refused before the verifier ran: ${problems.join("; ")}. ${fix}. Nothing was checked or paused.`, { refused_before_verify: true, upgrade_builds: problems });
}

/**
 * Issue 1809: the proxies an EXECUTED `govern --row freeze-proxy` round froze, from the run manifest's `proxy_freezes`. Security round 2: with `addressOf`, a proxy
 * counts only when the round froze the address its name reaches now (`proxies[].proxy`): a vault a redeploy replaced was frozen at its old address.
 */
export function freezesOf(manifest: Pick<RunManifest, "proxy_freezes">, addressOf?: ProxyAddressOf): string[] {
  const out = new Set<string>();
  for (const e of (Array.isArray(manifest.proxy_freezes) ? manifest.proxy_freezes : []) as { proxies?: unknown; execute_tx?: unknown }[]) {
    if (typeof e?.execute_tx !== "string" || !Array.isArray(e.proxies)) continue;
    for (const p of e.proxies as { name?: unknown; proxy?: unknown }[]) if (typeof p?.name === "string" && sameProxy(addressOf, p.name, p.proxy)) out.add(p.name);
  }
  return [...out];
}

/** ADR-0014 §8 (issue 1809): the storage-layout identifier of a proxied contract, 0x + the sha256 of its normalized snapshot in the checkout. Undefined: no snapshot. */
export function layoutHashOf(coreDir: string, artifact: string): `0x${string}` | undefined {
  const p = join(coreDir, "contracts", "test", "fixtures", "storage-layout", `${artifact}.json`);
  return existsSync(p) ? `0x${createHash("sha256").update(readFileSync(p)).digest("hex")}` : undefined;
}

/**
 * The verify stage's evidence of the proxies (issue 1809): what the verifier read, each with the storage-layout identifier of its implementation (ADR-0014 §8).
 * `layout_hash` is the identifier the proxy's stage wrote into its deploy manifest (`<field>_layout_id`) when there is one and no executed upgrade replaced that
 * implementation since; else the checkout's snapshot. `checkout_layout_hash` is the checkout's snapshot either way. `layoutManifest` reads one stage manifest field
 * (undefined when absent); `upgraded` names the proxies an executed upgrade-proxy round moved.
 * Security round 1: `rounds` (upgradeLayoutsOf) gives an upgraded proxy the layout its round recorded (`layout_source: "upgrade-round"`), held to the snapshot of the
 * round's build checkout (`checkout_layout_hash`). Before, an upgraded proxy fell back to this checkout's snapshot, so no label ever compared an upgraded layout.
 */
export function proxyEvidence(
  ctx: Pick<RunContext, "coreDir">,
  records: readonly ProxyRecord[],
  layoutManifest: (stage: string, field: string) => string | undefined = () => undefined,
  upgraded: ReadonlySet<string> = new Set(),
  rounds: ReadonlyMap<string, { layoutHash?: string; buildDir?: string }> = new Map(),
): ProxyRecord[] {
  const byName = new Map(tableProxies(getStageTable()).map((p) => [p.name, p]));
  const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
  return records.map((r) => {
    const p = byName.get(r.name);
    const round = upgraded.has(r.name) ? rounds.get(r.name) : undefined;
    if (p && round?.layoutHash !== undefined && BYTES32.test(round.layoutHash) && !/^0x0{64}$/.test(round.layoutHash)) {
      const buildCheckout = round.buildDir ? checkoutRootOf(round.buildDir) : undefined;
      const built = buildCheckout ? layoutHashOf(buildCheckout, p.artifact) : undefined;
      return { ...r, layout_hash: round.layoutHash.toLowerCase() as `0x${string}`, layout_source: "upgrade-round", ...(built ? { checkout_layout_hash: built } : {}) };
    }
    const checkout = p ? layoutHashOf(ctx.coreDir, p.artifact) : undefined;
    const recorded = p && !upgraded.has(r.name) ? layoutManifest(p.stage, layoutIdFieldOf(p)) : undefined;
    const deployId = recorded !== undefined && /^0x[0-9a-fA-F]{64}$/.test(recorded) && !/^0x0{64}$/.test(recorded) ? (recorded.toLowerCase() as `0x${string}`) : undefined;
    const out: ProxyRecord = { ...r };
    if (deployId) Object.assign(out, { layout_hash: deployId, layout_source: "deploy-manifest" });
    else if (checkout) Object.assign(out, { layout_hash: checkout, layout_source: "checkout" });
    if (checkout) out.checkout_layout_hash = checkout;
    return out;
  });
}

/**
 * Security round 1 (review: SECURITY_LIFECYCLE_GAP): the immutability statement counts every vault a redeploy replaced (redeploy-vault.ts retiredProxiesOf). Each is
 * still a proxy the timelock can upgrade until an EXECUTED freeze-proxy round froze its address, so until then core logic is not immutable and the retired name is
 * listed as upgradeable. A record only: evidence-check refuses a claim on the same rule and reads the freeze from the chain.
 */
export function withRetiredProxies<T extends { core_logic_immutable: boolean; upgradeable: string[] }>(immutability: T, manifest: Pick<RunManifest, "vault_redeploys" | "proxy_freezes">): T {
  const frozenAt = new Set<string>();
  for (const e of (Array.isArray(manifest.proxy_freezes) ? manifest.proxy_freezes : []) as { proxies?: unknown; execute_tx?: unknown }[]) {
    if (typeof e?.execute_tx !== "string" || !Array.isArray(e.proxies)) continue;
    for (const p of e.proxies as { proxy?: unknown }[]) if (typeof p?.proxy === "string") frozenAt.add(p.proxy.toLowerCase());
  }
  const open = retiredProxiesOf(manifest).filter((r) => !frozenAt.has(r.address.toLowerCase())).map((r) => r.name);
  return open.length === 0 ? immutability : { ...immutability, core_logic_immutable: false, upgradeable: [...immutability.upgradeable, ...open] };
}

/** The deployer nonce recorded at the end of the last deployer stage, only when govern has started (its gas moves the live nonce). */
export function deployEndNonce(manifest: RunManifest): number | undefined {
  if (!governHasRun(manifest)) return undefined;
  return manifest.stages[DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1]!.name]?.endNonce;
}

/** The last block of the last deployer stage (the timelock handover). Agents depositors authorize after it are theirs, not the deploy's. */
export function handoverBlock(manifest: RunManifest): bigint | undefined {
  const b = manifest.stages[DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1]!.name]?.lastBlock;
  return b === undefined ? undefined : BigInt(b);
}

/** The Safe control proof the run manifest holds (core 1618), for the verifier to read back from the chain. */
export function controlProofOf(manifest: Pick<RunManifest, "stages">): { txHash: `0x${string}`; nonce: number } | undefined {
  const r = manifest.stages[PROOF_STAGE];
  return r?.status === "done" && typeof r.txHash === "string" && Number.isInteger(r.nonce) ? { txHash: r.txHash as `0x${string}`, nonce: r.nonce as number } : undefined;
}

/**
 * The last receipt the run manifest's `receipt_applications` records as applied by `govern --row apply-receipt` (issue 1696): its id and vector. A RECORD only: the run
 * manifest is an editable file, so the verifier never checks the router against it (QA plan v1 C2, issue 1701). It reads the weight setter's ReceiptApplied events
 * instead and fails the applied-receipt label when this record is not the chain's last application.
 */
export function appliedReceiptOf(manifest: Pick<RunManifest, "receipt_applications">): VerifyOptions["appliedReceipt"] {
  const last = (manifest.receipt_applications ?? []).filter((x): x is { receipt_id: `0x${string}`; vaults: `0x${string}`[]; bps: number[] } => {
    const e = x as { receipt_id?: unknown; vaults?: unknown; bps?: unknown } | undefined;
    return typeof e?.receipt_id === "string" && Array.isArray(e.vaults) && Array.isArray(e.bps) && e.vaults.length === e.bps.length;
  }).pop();
  return last ? { receiptId: last.receipt_id, vaults: last.vaults, bps: last.bps } : undefined;
}

export interface VerifyDeps {
  verifyDeployment: (o: VerifyOptions) => Promise<VerifyReport>;
  verifySources: typeof verifySources;
  /** Injected for tests: the spawn that runs core's dependency manifest recorder. */
  recorderSpawn?: RecorderSpawn;
  /** Where a label line goes. Default: stdout (console.log). */
  emit?: (line: string) => void;
  /** 8453 only: depositsPaused() of one vault, read from the chain independently of the verifier (the mode cross-check). Default: viem over the run's RPC. */
  depositsPaused?: (rpc: string, vault: `0x${string}`) => Promise<boolean>;
}
const PAUSED_ABI = parseAbi(["function depositsPaused() view returns (bool)"]);
const readDepositsPaused = async (rpc: string, vault: `0x${string}`): Promise<boolean> =>
  (await createPublicClient({ transport: http(rpc) }).readContract({ address: vault, abi: PAUSED_ABI, functionName: "depositsPaused" })) as boolean;
export const realVerifyDeps: VerifyDeps = { verifyDeployment, verifySources, depositsPaused: readDepositsPaused };

export async function runVerifyStage(ctx: RunContext, row: StageRow, manifest: RunManifest, deps: VerifyDeps = realVerifyDeps): Promise<VerifyReport> {
  const frozenFile = ctx.frozen ?? (ctx.measure ? measuredCounts(manifest) : undefined);
  if (!frozenFile) throw new PublishError("COUNTS_MISSING", "the verifier needs the frozen counts for this DEPLOY_SHA");
  const frozen = effectiveCounts(frozenFile, adoptedTxs(manifest)); // an adopted stage (libs, issue 1721) counts the transactions this deployer sent for it
  if (manifest.firstBlock === undefined) throw new PublishError("INPUT_MISSING", "the run manifest has no first deploy block: the role scan needs it. Run the deploy stages first.");
  const safe = readManifestField(ctx, manifestRef("safe", "safe"));
  const startedAt = Date.now();
  const mainnet = ctx.chainId === MAINNET_CHAIN_ID;
  // 8453 (issue 1667): verify runs before govern (all four paused) and after it (all four open). The manifest names the mode, the chain is read
  // below to confirm it. A part-way govern run is neither: verify refuses, names the govern command and pauses nothing (GOVERN_PENDING is not a VERIFY failure).
  let mode: "pre-govern" | "post-govern" | undefined;
  if (mainnet) {
    const m = mainnetGovernMode(manifest);
    if (m.mode === "part-way") {
      const next = [resumeCommand(ctx)];
      throw new PublishError("GOVERN_PENDING", `verify refused: govern is part-way (${m.detail}), so neither the pre-govern nor the post-govern state can be checked. Nothing was paused. Finish govern first: ${next.join("  then  ")}`, { next_command: next[0], next_commands: next });
    }
    mode = m.mode;
  }
  // Issue 1796: a single-vault redeploy that is deployed and not yet governed is neither the state before nor the state after: the vault manifest names a vault the registry does not list.
  const redeployRecs = redeploysOf(manifest);
  const openRedeploy = redeployRecs.find((r) => r.status !== "governed");
  if (openRedeploy) {
    // QA plan v1 E1: the row runs at the round's own sha (the verb's), whatever sha this verify names.
    const next = openRedeploy.status === "deployed" ? `bun publish-contracts/src/cli.ts govern --row ${REDEPLOY_ROW} --chain ${ctx.chainId} --core-sha ${openRedeploy.core_sha || ctx.coreSha} (plus the same --rpc, --sheet, --signer, --environment, --evidence and --owner-signer arguments as this run)` : `the redeploy-vault verb with --resume at --core-sha ${openRedeploy.core_sha || ctx.coreSha} (it died part-way)`;
    throw new PublishError("GOVERN_PENDING", `verify refused: the redeploy of ${openRedeploy.vault} is ${openRedeploy.status} (round ${openRedeploy.ordinal}), so neither the state before it nor the state after it can be checked. Nothing was paused. Finish it first: ${next}`, { next_command: next, redeploy: openRedeploy.status });
  }
  const governedRedeploys = redeployRecs.filter((r) => r.status === "governed" && r.new_vault);
  // QA plan v1 E1 (DT-2): after a round at another sha this verify must run at that sha with --prior-out of the original build. cli.ts refuses every other run
  // before any signer (redeployShaRun); this is the stage's own check, so no caller can compare the replacing vault with the wrong build and pause all four vaults.
  const buildRefusal = verifyBuildRefusal(manifest, ctx);
  if (buildRefusal) throw buildRefusal;
  const unpaused = mode ? (mode === "post-govern" ? [...MAINNET_UNPAUSE_VAULTS] : []) : unpausedByGovern(manifest, ctx.sheet);
  const proxyAt = currentProxyAddresses(ctx);
  // Security round 3 (review: SECURITY_AVAILABILITY_SELF_PAUSE): every upgraded proxy's build is checked before the verifier, so a build that is gone, relative or at
  // another sha refuses here (nothing paused) instead of failing a code label and pausing all four vaults. `rounds` is the manifest with --upgrade-build applied.
  const rounds = withUpgradeBuilds(manifest, ctx.upgradeBuilds ? Object.fromEntries(Object.entries(ctx.upgradeBuilds).map(([k, d]) => [k, resolve(d)])) : undefined);
  const upgradeRefusal = upgradeBuildRefusal(rounds, ctx, proxyAt);
  if (upgradeRefusal) throw upgradeRefusal;
  ctx.log.log("info", "stage.start", { stage: row.name });
  const report = await deps.verifyDeployment({
    chain: viemReader(ctx.rpc), manifestDir: manifestDir(ctx), table: getStageTable(), sheet: buildVerifySheet(ctx, safe, unpaused, expectedTimelockDelay(manifest, ctx.sheet)), fromBlock: BigInt(manifest.firstBlock),
    logChunk: 2000, frozenCounts: frozen, artifactsDir: join(ctx.coreDir, "out"),
    deployerNonceAtDeployEnd: deployEndNonce(manifest),
    ...(ctx.sheet.kind === "rehearsal" ? { deployerStartNonce: manifest.deployerStartNonce } : {}),
    handoverBlock: handoverBlock(manifest),
    controlProof: controlProofOf(manifest),
    appliedReceipt: appliedReceiptOf(manifest),
    // issue 1809: which implementation each upgraded proxy names and which proxies a freeze row froze; the verifier reads the slots and upgradesFrozen() from the chain.
    // Security round 2: only the rounds recorded at the address each name reaches now (a vault a redeploy replaced keeps its history under its retired name).
    upgrades: upgradesOf(rounds, proxyAt),
    freezes: freezesOf(manifest, proxyAt),
    // QA plan v1 E1 (DT-2): artifactsDir is the build of this checkout. After a round at another sha that is the redeploy sha (cli.ts accepts it with --prior-out only):
    // the replacing vault is compared with it, every contract the original deployment created with priorArtifactsDir (--prior-out, a build of the original sha).
    ...(governedRedeploys.length > 0 ? {
      redeploys: governedRedeploys.map((r) => ({ vault: r.vault, oldVault: r.old_vault, newVault: r.new_vault!, oldBuild: oldVaultBuild(redeployRecs, r, manifest.coreSha) })),
      redeployDeployerTxs: governedRedeploys.reduce((t, r) => t + (r.deploy_count ?? 0), 0),
      ...(ctx.priorArtifactsDir ? { priorArtifactsDir: ctx.priorArtifactsDir } : {}),
    } : {}),
  });
  if (mainnet) {
    // The mode came from the manifest, which an operator can edit or lose: read depositsPaused of all four vaults and fail on any disagreement with it.
    // The paused state each vault must read is the stage table's rule for it (issue 1705): deployPaused, until its stage 13 unpause row executed.
    const read = deps.depositsPaused ?? readDepositsPaused;
    for (const v of VAULT_STAGES) {
      const want = expectPausedAfter(v.key, unpaused);
      const vault = readManifestField(ctx, manifestRef(v.stage, "vault")) as `0x${string}`;
      let got: boolean | string;
      try { got = await read(ctx.rpc, vault); } catch (e) { got = (e as Error).message; }
      if (got !== want) report.checks.push({ label: `govern ${mode}: ${VAULT_NAME[v.key]} depositsPaused is ${want}`, ok: false, detail: `the run manifest says ${mode}, so ${VAULT_NAME[v.key]} must read depositsPaused ${want}, the chain reads ${String(got)}${mode === "post-govern" ? `. If pause-all ran, reopen it: ${resumeCommand(ctx, vaultRule(v.key).unpauseRow)}` : ""}` });
    }
    report.ok = report.checks.every((c) => c.ok);
    // Security round 2: a proxy an executed upgrade-proxy round moved runs that round's implementation, so its source is the one that must be verified on the
    // explorers (contractsFromManifests names the deploy-time implementation only).
    const contracts = contractsFromManifests(manifestDir(ctx), getStageTable());
    for (const u of upgradesOf(manifest, proxyAt)) contracts[`implementation[${u.proxy}]`] = u.implementation;
    const s = await deps.verifySources({ chainId: ctx.chainId, contracts });
    report.checks.push(...s.checks);
    report.ok = report.ok && s.ok;
  }
  // issue 1809: the proxies as the verifier read them (proxy and implementation addresses, code hashes, admin and beacon slots, authority, mode, frozen, layout identifier)
  const layoutManifest = (stage: string, field: string): string | undefined => { try { return readManifestField(ctx, manifestRef(stage, field)); } catch { return undefined; } };
  // With --prior-out the checkout is not the build of the original contracts, so its snapshot hash is not recorded next to their deploy identifiers.
  const proxies = report.proxies
    ? proxyEvidence(ctx, report.proxies, layoutManifest, new Set(upgradesOf(rounds, proxyAt).map((u) => u.proxy)), upgradeLayoutsOf(rounds, proxyAt)).map((p): ProxyRecord => {
      if (!ctx.priorArtifactsDir || p.layout_source === "upgrade-round") return p; // an upgrade round's build checkout is its own, not this checkout
      const { checkout_layout_hash: _skipped, ...rest } = p;
      return rest;
    })
    : undefined;
  if (proxies) ctx.log.log("info", "verify.proxies", { proxies });
  // ADR-0014 §8: the layout identifier the deployment recorded must be the layout of the checkout this verify compared its code with (the CI gate pins the
  // checkout's). Only a mismatch adds a label (failed), like the mainnet depositsPaused disagreements above, so a healthy run keeps the shared label set.
  // A run with --prior-out (a redeploy at another sha) compares the original contracts with the original build, not this checkout: no checkout hash, no label.
  for (const p of (proxies ?? []).filter((x) => (x.layout_source === "deploy-manifest" || x.layout_source === "upgrade-round") && x.checkout_layout_hash !== undefined && x.layout_hash !== x.checkout_layout_hash)) {
    report.checks.push({ label: `proxy[${p.name}]: deploy layout identifier equals the checkout's layout snapshot`, ok: false, detail: p.layout_source === "upgrade-round"
      ? `the upgrade-proxy round that installed ${p.name}'s implementation recorded layout ${p.layout_hash}, the snapshot of that round's build checkout hashes to ${p.checkout_layout_hash}: the build directory no longer holds the reviewed build`
      : `the ${p.name} stage recorded layout ${p.layout_hash}, the checkout's snapshot hashes to ${p.checkout_layout_hash}: verify from the release's own checkout, or record the upgrade that moved it` });
    report.ok = false;
  }
  // Issue 1727: the kind and the delay go to the log (stderr), never to stdout: stdout is the label contract core's harness parses and the Twin and mainnet label sets must compare equal.
  ctx.log.log("info", "verify.deployment_kind", { deployment_kind: ctx.sheet.kind, label: kindLabel(ctx.sheet.kind, expectedTimelockDelay(manifest, ctx.sheet)) });
  // QA plan v1 C3 (CS-6): the gating of the router's weight setter goes to the log and to the stage record below, so the run says whether every weight change
  // waits the timelock delay. Like the kind, it stays off stdout: the label contract is unchanged.
  const gating = report.weightSetter;
  if (gating) ctx.log.log(gating.gating === "timelock" ? "info" : "error", "verify.weight_setter_gating", { gating: gating.gating, holders: gating.holders, timelock: gating.timelock, delay_seconds: gating.delaySeconds });
  for (const c of report.checks) ctx.log.log(c.ok ? "info" : "error", "verify.check", { label: c.label, ok: c.ok, detail: c.ok ? undefined : c.detail });
  // stdout: the verifier labels, one per line under [verify], the format of deployments/base-8453/verifier-labels.txt, so a caller can diff stage against mainnet.
  // Pass or fail is the exit code (and the verify.check log lines on stderr).
  const emit = deps.emit ?? ((l: string) => console.log(l));
  emit("[verify]");
  for (const c of report.checks) emit(c.label);
  const failed = report.checks.filter((c) => !c.ok);
  // QA plan v1 E1: the builds the code hashes were compared with go into the evidence: the stage record names --prior-out and the sha of its checkout, and a verify that
  // passed writes onto each governed redeploy entry the sha it ran at and that prior-out sha (evidence-check requires it to be the deployment's core_sha).
  const priorOut = ctx.priorArtifactsDir ? { prior_out: { dir: ctx.priorArtifactsDir, sha: ctx.priorArtifactsSha ?? null }, core_sha: ctx.coreSha } : {};
  // ADR-0014 §5: core logic is immutable only when every proxy reads frozen; governed parameters and upstream contracts stay mutable regardless. Recorded, never claimed here.
  const immutability = proxies ? withRetiredProxies(immutabilityOf(proxies, tableProxies(getStageTable()).map((p) => p.name)), manifest) : undefined;
  if (immutability) ctx.log.log("info", "verify.immutability", { core_logic_immutable: immutability.core_logic_immutable, upgradeable: immutability.upgradeable });
  manifest.stages[row.name] = { status: report.ok ? "done" : "started", startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), checks: report.checks.length, failed: failed.length, ...(gating ? { weightSetterGating: gating } : {}), ...(proxies ? { proxies } : {}), ...(immutability ? { immutability } : {}), ...priorOut };
  if (report.ok && ctx.priorArtifactsSha) for (const r of governedRedeploys) Object.assign(r, { verified_at_sha: ctx.coreSha, prior_out_sha: ctx.priorArtifactsSha });
  saveRunManifest(ctx.evidenceDir, manifest);
  if (!report.ok) throw new PublishError("VERIFY", `the verifier reports ${failed.length} failure(s): ${failed.slice(0, 5).map((c) => c.label).join(", ")}`, { failed: failed.map((c) => c.label) });
  ctx.log.log("info", "stage.done", { stage: row.name, checks: report.checks.length });
  // release deploy only (8453): record the third-party dependency manifest. Non-fatal: a failure is a named WARN.
  await recordDependencyManifest({ chainId: ctx.chainId, rpc: ctx.rpc, coreDir: ctx.coreDir, coreSha: ctx.coreSha, log: ctx.log, baseEnv: ctx.baseEnv ?? {}, dryRun: ctx.dryRun }, deps.recorderSpawn);
  return report;
}
