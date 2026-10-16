// Stage 12 verify: the one verifier (src/verify). The CLI builds the verifier's sheet from the frozen sheet, reads the expected
// asset config from the core config file (never from the chain it is checking) and fails the run on any failed check.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { keccak256 } from "viem";
import { checkReceiptApplications, checkReceiptApplicationsOnChain, checkVaultRedeploys, checkVaultRedeploysOnChain, type ChainReader as EvidenceChainReader } from "./evidence-check.ts";
import { buildMigrationOverlay } from "./migration-overlay.ts";
import { join } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { PublishError } from "./errors.ts";
import { effectiveCounts } from "./counts.ts";
import { loadReceiptAddr, resumeCommand } from "./govern.ts";
import { MAINNET_CHAIN_ID, delayFloor } from "./floors.ts";
import { kindLabel } from "./chains.ts";
import { runDeployTxs } from "./verify/manifests.ts";
import { adoptedTxs, governHasRun, measuredCounts, manifestDir, saveRunManifest, readManifestField, type RunContext, type RunManifest } from "./runner.ts";
import { BASKET_KEYS, VAULT_KEYS, VAULT_NAME, eligibleInOrder, type VaultKey } from "./sheet.ts";
import { ROUTER_STAGE_ELIGIBLE, SEEDED_VAULTS, STAGE13_UNPAUSE_VAULTS, expectPaused, routerEligible, vaultRule } from "./vault-rules.ts";
import { RECORDER_STAGE, STRATEGY_ADAPTER_VAULT_ARTIFACT, STRATEGY_ADAPTER_WIRING, VAULT_RECORDER_FIELD, VENUE_V4, adapterFieldFor } from "./core-wiring.ts";
import { PROOF_STAGE } from "./control-proof.ts";
import { loadConfigAssets, loadExpectedMaxSlippageBps } from "./asset-config.ts";
import { manifestBase } from "./stage-table.ts";
import { DEPLOYER_STAGES, VAULT_STAGES, getStageTable, manifestRef, type StageRow } from "./stages.ts";
import { RPC_REFUSED_DETAIL, verifyDeployment, verifySources, viemReader, type VerifyReport, type VerifySheet, type VerifyOptions, type VaultSheet } from "./verify/index.ts";
import { recordDependencyManifest, type RecorderSpawn } from "./record-dependencies.ts";
import { contractsFromManifests } from "./verify/sources.ts";
import { REDEPLOY_ROW, redeploysOf } from "./redeploy-vault.ts";

/** Issue 1809: the record of the upgradeability labels, written by verify under deployments/<chain>/. */
export const UPGRADEABILITY_MANIFEST = "upgradeability.json";

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
 * The strategy adapters a RobotMoneyVault stage registered (issue 1705 C4), in registration order: each address from the vault manifest and its bps cap from the
 * deploy script's constant, both at the DEPLOY_SHA. Undefined for a vault whose artifact registers no strategy adapters (the baskets).
 */
export function loadExpectedStrategyAdapters(ctx: Pick<RunContext, "coreDir" | "chainId" | "manifestOut">, key: VaultKey): VaultSheet["adapters"] {
  const row = getStageTable().vaults.find((v) => v.key === key)!;
  if (row.artifact !== STRATEGY_ADAPTER_VAULT_ARTIFACT) return undefined;
  const stage = getStageTable().stages.find((s) => s.name === row.stage)!;
  const scriptPath = join(ctx.coreDir, stage.script.split(":")[0]!);
  const src = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";
  return STRATEGY_ADAPTER_WIRING.map((w) => {
    const m = new RegExp(`uint16 public constant ${w.capConstant} = ([\\d_]+);`).exec(src);
    if (!m) throw new PublishError("INPUT_MISSING", `${stage.script.split(":")[0]} has no ${w.capConstant}: the expected adapter cap of ${VAULT_NAME[key]} is read from the deploy script`, { path: scriptPath });
    return { adapter: readManifestField(ctx, `${manifestBase(stage.manifest)}:${w.field}`) as `0x${string}`, capBps: Number(m[1]!.replaceAll("_", "")) };
  });
}

/**
 * The vaults the govern unpause rows have unpaused: a vault is listed once the run manifest records the executed phase of its own row
 * `unpause-<VAULT>` (one round per vault). Before that phase, none. A vault whose row was skipped (not in GOVERN_UNPAUSE_VAULTS) stays paused.
 */
export function unpausedByGovern(manifest: Pick<RunManifest, "govern">, sheet: RunContext["sheet"]): VaultKey[] {
  const g = manifest.govern as Record<string, { executed?: unknown } | undefined> | undefined;
  return sheet.govern.unpauseVaults.filter((k) => !!g?.[vaultRule(k).unpauseRow]?.executed);
}

/** The vaults whose unpause rows are stage 13 on 8453 (the sheet parser requires all of them listed, issue 1710): the stage table's vault rules (issue 1705). */
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
  const rows = MAINNET_UNPAUSE_VAULTS.map((k) => vaultRule(k).unpauseRow).map((r) => [r, phaseOf(g, r)] as const);
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
 * The verifier's sheet, from the frozen sheet. The per-vault rules come from the stage table (issue 1705, vault-rules.ts): every vault the table marks
 * deployPaused ships paused until its unpause row. The link between the govern rows and the reads: a vault the unpause rows unpaused is expected
 * paused=false, every other deployPaused vault is expected paused=true. So a verify run after govern fails when an unpause row ran and the vault still
 * reads paused, and when a vault reads unpaused with no unpause row behind it. Router eligibility is the table's eligibilitySource: the router stage's
 * base leg always, a basket when the sheet lists it in ELIGIBLE_VAULTS. The seed is checked on the vaults the table seeds.
 */
export function buildVerifySheet(ctx: Pick<RunContext, "sheet" | "coreDir" | "chainId" | "manifestOut">, safeAddress: string, unpaused: readonly VaultKey[] = [], timelockDelay?: number): VerifySheet {
  const s = ctx.sheet;
  const vaults: Record<string, VaultSheet> = {};
  for (const k of VAULT_KEYS) {
    const v = s.vaults[k];
    const adapters = loadExpectedStrategyAdapters(ctx, k);
    vaults[VAULT_NAME[k]] = {
      tvlCap: v.tvlCap, perDepositCap: v.perDepositCap, exitFeeBps: v.exitFeeBps,
      ...((BASKET_KEYS as readonly VaultKey[]).includes(k) ? { navDeviationBps: v.navDeviationBps, minPoolLiquidity: v.minPoolLiquidity } : {}),
      feeRecipient: (s.feeRecipient === "@safe" ? safeAddress : s.feeRecipient) as `0x${string}`,
      expectPaused: expectPaused(k, unpaused),
      routerEligible: routerEligible(k, s.eligibleVaults),
      assets: loadExpectedAssets(ctx, k),
      ...((BASKET_KEYS as readonly VaultKey[]).includes(k) ? { maxSlippageBps: loadExpectedMaxSlippageBps(ctx.coreDir, k, getStageTable().vaults.find((x) => x.key === k)!.artifact) } : {}),
      ...(adapters ? { adapters } : {}),
      ...(SEEDED_VAULTS.includes(k) ? { seed: s.seedDeposit, seedShareReceiver: s.shareReceiver } : {}),
    };
  }
  return {
    chainId: ctx.chainId, deployer: s.admin, pauser: s.pauser, emergency: s.emergency, safeOwners: s.safeOwners, safeThreshold: s.safeThreshold,
    timelockDelay: timelockDelay ?? Number(s.timelockMinDelay), deploymentKind: s.kind, vaults,
    upgradeMode: s.upgrade.mode, ...(s.upgrade.freezeDeadline ? { freezeDeadline: s.upgrade.freezeDeadline } : {}),
    defaultWeights: ([...ROUTER_STAGE_ELIGIBLE, ...eligibleInOrder(s)] as VaultKey[]).map((k) => ({ vault: VAULT_NAME[k], bps: s.weights.find((w) => w.key === k)!.bps })),
  };
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

/** The last receipt `govern --row apply-receipt` applied (issue 1696): its id and vector, from the run manifest's `receipt_applications`. */
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
  /** 8453 only (issue 1701): the transaction reader that backs each `receipt_applications` entry with its timelock batch. Default: viem over the run's RPC. */
  receiptChain?: EvidenceChainReader;
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
    const next = openRedeploy.status === "deployed" ? `bun publish-contracts/src/cli.ts govern --row ${REDEPLOY_ROW} --chain ${ctx.chainId} --core-sha ${ctx.coreSha} (plus the same --rpc, --sheet, --signer, --environment and --owner-signer arguments as this run)` : `the redeploy-vault verb with --resume (it died part-way)`;
    throw new PublishError("GOVERN_PENDING", `verify refused: the redeploy of ${openRedeploy.vault} is ${openRedeploy.status} (round ${openRedeploy.ordinal}), so neither the state before it nor the state after it can be checked. Nothing was paused. Finish it first: ${next}`, { next_command: next, redeploy: openRedeploy.status });
  }
  const governedRedeploys = redeployRecs.filter((r) => r.status === "governed" && r.new_vault);
  const unpaused = mode ? (mode === "post-govern" ? [...MAINNET_UNPAUSE_VAULTS] : []) : unpausedByGovern(manifest, ctx.sheet);
  ctx.log.log("info", "stage.start", { stage: row.name });
  const report = await deps.verifyDeployment({
    chain: viemReader(ctx.rpc), manifestDir: manifestDir(ctx), table: getStageTable(), sheet: buildVerifySheet(ctx, safe, unpaused, expectedTimelockDelay(manifest, ctx.sheet)), fromBlock: BigInt(manifest.firstBlock),
    deployTxs: runDeployTxs(manifest),
    logChunk: 2000, frozenCounts: frozen, artifactsDir: join(ctx.coreDir, "out"), coreDir: ctx.coreDir,
    deployerNonceAtDeployEnd: deployEndNonce(manifest),
    ...(ctx.sheet.kind === "rehearsal" ? { deployerStartNonce: manifest.deployerStartNonce } : {}),
    handoverBlock: handoverBlock(manifest),
    controlProof: controlProofOf(manifest),
    appliedReceipt: appliedReceiptOf(manifest),
    ...(governedRedeploys.length > 0 ? {
      redeploys: governedRedeploys.map((r) => ({ vault: r.vault, oldVault: r.old_vault, newVault: r.new_vault!, replacementManifest: r.replacement_manifest, routerVaultCap: typeof r.router_vault_cap === "string" ? r.router_vault_cap : undefined })),
      redeployDeployerTxs: governedRedeploys.reduce((t, r) => t + (r.deploy_count ?? 0), 0),
      ...(ctx.priorArtifactsDir ? { priorArtifactsDir: ctx.priorArtifactsDir } : {}),
    } : {}),
  });
  if (mainnet) {
    // The mode came from the manifest, which an operator can edit or lose: read depositsPaused of all four vaults and fail on any disagreement with it.
    const read = deps.depositsPaused ?? readDepositsPaused;
    for (const v of VAULT_STAGES) {
      // pre-govern: the table's deployPaused. post-govern: open when the vault's unpause row is a stage 13 row, else still its deploy state.
      const want = expectPaused(v.key, mode === "post-govern" ? MAINNET_UNPAUSE_VAULTS : []);
      const vault = governedRedeploys.find((r) => r.key === v.key)?.new_vault ?? readManifestField(ctx, manifestRef(v.stage, "vault")) as `0x${string}`;
      let got: boolean | string;
      try { got = await read(ctx.rpc, vault); } catch (e) { got = (e as Error).message; }
      if (got !== want) report.checks.push({ label: `govern ${mode}: ${VAULT_NAME[v.key]} depositsPaused is ${want}`, ok: false, detail: `the run manifest says ${mode}, so ${VAULT_NAME[v.key]} must read depositsPaused ${want}, the chain reads ${String(got)}${mode === "post-govern" ? `. If pause-all ran, reopen it: ${resumeCommand(ctx, vaultRule(v.key).unpauseRow)}` : ""}` });
    }
    // Issue 1701: the router weight check above trusts the applied vector of the run manifest, which an operator can edit. On 8453 every receipt_applications
    // entry must be backed by its timelock batch on chain (the evidence-check --receipt-applications --rpc check), so a forged entry cannot hide router weight drift.
    const apps = (manifest.receipt_applications ?? []) as unknown[];
    if (apps.length > 0) {
      const ev = {
        consensus_receipt: { address: loadReceiptAddr(ctx) }, governance: { address: readManifestField(ctx, manifestRef("governance", "governance")) },
        timelock: { address: readManifestField(ctx, manifestRef("timelock", "timelock")) }, receipt_applications: apps,
      };
      const floor = delayFloor(ctx.chainId, ctx.sheet.kind);
      const chain = deps.receiptChain ?? (createPublicClient({ transport: http(ctx.rpc) }) as unknown as EvidenceChainReader);
      let problems: string[];
      try { problems = [...checkReceiptApplications(ev, floor), ...await checkReceiptApplicationsOnChain(ev, chain, floor)]; } catch (e) { problems = [(e as Error).message]; }
      if (problems.length) report.checks.push({ label: "govern post-govern: receipt_applications are backed by their timelock batches on chain", ok: false, detail: `the run manifest's applied receipt vector is not backed by the chain, so the router weight check cannot trust it: ${problems.join("; ")}` });
    }
    report.ok = report.checks.every((c) => c.ok);
    const s = await deps.verifySources({ chainId: ctx.chainId, contracts: contractsFromManifests(manifestDir(ctx), getStageTable()) });
    report.checks.push(...s.checks);
    report.ok = report.ok && s.ok;
  }
  // Issue 1727: the kind and the delay go to the log (stderr), never to stdout: stdout is the label contract core's harness parses and the Twin and mainnet label sets must compare equal.
  ctx.log.log("info", "verify.deployment_kind", { deployment_kind: ctx.sheet.kind, label: kindLabel(ctx.sheet.kind, expectedTimelockDelay(manifest, ctx.sheet)) });
  for (const c of report.checks) ctx.log.log(c.ok ? "info" : "error", "verify.check", { label: c.label, ok: c.ok, detail: c.ok ? undefined : c.detail });
  // stdout: the verifier labels, one per line under [verify], the format of deployments/base-8453/verifier-labels.txt, so a caller can diff stage against mainnet.
  // Pass or fail is the exit code (and the verify.check log lines on stderr).
  // Issue 1809: the upgradeability record (proxies, implementations, code hashes, layout ids, authority, delay, initialization, freeze state, the immutability claim and what
  // stays governed) is written beside the deployment manifests on every run, pass or fail, and copied into the evidence as its `upgradeability` section.
  if (report.upgradeability) {
    writeFileSync(join(manifestDir(ctx), UPGRADEABILITY_MANIFEST), JSON.stringify({ chain_id: ctx.chainId, core_sha: ctx.coreSha, ...report.upgradeability }, null, 2) + "\n");
    ctx.log.log(report.upgradeability.core_immutable ? "info" : "warn", "verify.upgradeability", { file: UPGRADEABILITY_MANIFEST, mode: report.upgradeability.mode, core_immutable: report.upgradeability.core_immutable, refused_because: report.upgradeability.immutability_refused_because });
  }
  const emit = deps.emit ?? ((l: string) => console.log(l));
  emit("[verify]");
  for (const c of report.checks) emit(c.label);
  const failed = report.checks.filter((c) => !c.ok);
  manifest.stages[row.name] = { status: report.ok ? "done" : "started", startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), checks: report.checks.length, failed: failed.length };
  saveRunManifest(ctx.evidenceDir, manifest);
  // Issue 1851: when every failure is a read the RPC refused (a pruned node, a throttle), nothing on chain was found wrong: RPC_REFUSED, which does not pause the vaults.
  if (!report.ok && failed.every((c) => c.detail.startsWith(RPC_REFUSED_DETAIL))) {
    throw new PublishError("RPC_REFUSED", `the verifier could not read ${failed.length} label(s) because the RPC refused a read: ${failed.slice(0, 5).map((c) => c.label).join(", ")}. Nothing on chain was found wrong and no vault was paused. Rerun verify against an RPC that serves eth_getTransactionReceipt for the run's deploy transactions: ${failed[0]!.detail.slice(0, 300)}`, { failed: failed.map((c) => c.label) });
  }
  if (!report.ok) throw new PublishError("VERIFY", `the verifier reports ${failed.length} failure(s): ${failed.slice(0, 5).map((c) => c.label).join(", ")}`, { failed: failed.map((c) => c.label) });
  if (governedRedeploys.length) {
    const evidence = { deployment_kind: ctx.sheet.kind, registry: { address: governedRedeploys[0]!.registry }, timelock: { address: governedRedeploys[0]!.timelock }, vault_redeploys: governedRedeploys, vaults: Object.fromEntries(governedRedeploys.map((r) => [r.vault, { address: r.new_vault }])) };
    const chain = viemReader(ctx.rpc);
    const floor = Number(await chain.read(governedRedeploys[0]!.timelock, "function getMinDelay() view returns (uint256)"));
    const problems = [...checkVaultRedeploys(evidence, floor, ctx.sheet.kind), ...await checkVaultRedeploysOnChain(evidence, createPublicClient({ transport: http(ctx.rpc) }), floor)];
    if (problems.length) throw new PublishError("VERIFY", `migration evidence failed: ${problems.join("; ")}`);
    const hashes: Record<string, string> = {};
    for (const r of governedRedeploys) for (const a of [r.old_vault, r.new_vault!]) hashes[a.toLowerCase()] = keccak256(await chain.getCode(a));
    const overlay = buildMigrationOverlay(ctx.chainId, await chain.blockNumber(), governedRedeploys, hashes);
    writeFileSync(join(manifestDir(ctx), "current-vaults.json"), JSON.stringify(overlay, null, 2) + "\n");
  }
  ctx.log.log("info", "stage.done", { stage: row.name, checks: report.checks.length });
  // release deploy only (8453): record the third-party dependency manifest. Non-fatal: a failure is a named WARN.
  await recordDependencyManifest({ chainId: ctx.chainId, rpc: ctx.rpc, coreDir: ctx.coreDir, coreSha: ctx.coreSha, log: ctx.log, baseEnv: ctx.baseEnv ?? {}, dryRun: ctx.dryRun }, deps.recorderSpawn);
  return report;
}
