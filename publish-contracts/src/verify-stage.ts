// Stage 12 verify: the one verifier (src/verify). The CLI builds the verifier's sheet from the frozen sheet, reads the expected
// asset config from the core config file (never from the chain it is checking) and fails the run on any failed check.
import { join } from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { PublishError } from "./errors.ts";
import { effectiveCounts } from "./counts.ts";
import { resumeCommand } from "./govern.ts";
import { MAINNET_CHAIN_ID } from "./floors.ts";
import { adoptedTxs, governHasRun, measuredCounts, manifestDir, saveRunManifest, readManifestField, type RunContext, type RunManifest } from "./runner.ts";
import { VAULT_KEYS, VAULT_NAME, eligibleInOrder, type VaultKey } from "./sheet.ts";
import { RECORDER_STAGE, VAULT_RECORDER_FIELD, VENUE_V4, adapterFieldFor } from "./core-wiring.ts";
import { PROOF_STAGE } from "./control-proof.ts";
import { loadConfigAssets } from "./asset-config.ts";
import { manifestBase } from "./stage-table.ts";
import { DEPLOYER_STAGES, VAULT_STAGES, getStageTable, manifestRef, type StageRow } from "./stages.ts";
import { verifyDeployment, verifySources, viemReader, type VerifyReport, type VerifySheet, type VerifyOptions, type VaultSheet } from "./verify/index.ts";
import { recordDependencyManifest, type RecorderSpawn } from "./record-dependencies.ts";
import { contractsFromManifests } from "./verify/sources.ts";

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
 * The vaults the govern unpause rows have unpaused: a vault is listed once the run manifest records the executed phase of its own row
 * `unpause-<VAULT>` (one round per vault). Before that phase, none. A vault whose row was skipped (not in GOVERN_UNPAUSE_VAULTS) stays paused.
 */
export function unpausedByGovern(manifest: Pick<RunManifest, "govern">, sheet: RunContext["sheet"]): VaultKey[] {
  const g = manifest.govern as Record<string, { executed?: unknown } | undefined> | undefined;
  return sheet.govern.unpauseVaults.filter((k) => !!g?.[`unpause-${k}`]?.executed);
}

/** The four vaults whose unpause rows are stage 13 on 8453 (the sheet parser requires all four listed, issue 1710). */
export const MAINNET_UNPAUSE_VAULTS: readonly VaultKey[] = ["USDC", "PROTO", "AGENT", "RWA"];

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
  const rows = MAINNET_UNPAUSE_VAULTS.map((k) => [`unpause-${k}`, phaseOf(g, `unpause-${k}`)] as const);
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
 * The verifier's sheet, from the frozen sheet. Basket and agent vaults ship paused until stage 13. The link between the govern rows and the
 * reads: a vault the unpause rows unpaused is expected paused=false, every other vault is expected paused=true. So a verify
 * run after govern fails when an unpause row ran and the vault still reads paused, and when a vault reads unpaused with no unpause row behind it.
 */
export function buildVerifySheet(ctx: Pick<RunContext, "sheet" | "coreDir" | "chainId" | "manifestOut">, safeAddress: string, unpaused: readonly VaultKey[] = [], timelockDelay?: number): VerifySheet {
  const s = ctx.sheet;
  const vaults: Record<string, VaultSheet> = {};
  for (const k of VAULT_KEYS) {
    const v = s.vaults[k];
    vaults[VAULT_NAME[k]] = {
      tvlCap: v.tvlCap, perDepositCap: v.perDepositCap, exitFeeBps: v.exitFeeBps,
      ...(k !== "USDC" ? { navDeviationBps: v.navDeviationBps, minPoolLiquidity: v.minPoolLiquidity } : {}),
      feeRecipient: (s.feeRecipient === "@safe" ? safeAddress : s.feeRecipient) as `0x${string}`,
      expectPaused: !unpaused.includes(k),
      routerEligible: k === "USDC" || s.eligibleVaults.includes(k),
      assets: loadExpectedAssets(ctx, k),
      ...(k === "USDC" ? { seed: s.seedDeposit, seedShareReceiver: s.shareReceiver } : {}),
    };
  }
  return {
    chainId: ctx.chainId, deployer: s.admin, pauser: s.pauser, emergency: s.emergency, safeOwners: s.safeOwners, safeThreshold: s.safeThreshold,
    timelockDelay: timelockDelay ?? Number(s.timelockMinDelay), vaults,
    governance: { voters: s.voters, voterPower: s.voterPower, quorum: s.quorum, votingPeriod: s.votingPeriod, executionDelay: s.executionDelay },
    defaultWeights: (["USDC", ...eligibleInOrder(s)] as VaultKey[]).map((k) => ({ vault: VAULT_NAME[k], bps: s.weights.find((w) => w.key === k)!.bps })),
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
  const unpaused = mode ? (mode === "post-govern" ? [...MAINNET_UNPAUSE_VAULTS] : []) : unpausedByGovern(manifest, ctx.sheet);
  ctx.log.log("info", "stage.start", { stage: row.name });
  const report = await deps.verifyDeployment({
    chain: viemReader(ctx.rpc), manifestDir: manifestDir(ctx), table: getStageTable(), sheet: buildVerifySheet(ctx, safe, unpaused, expectedTimelockDelay(manifest, ctx.sheet)), fromBlock: BigInt(manifest.firstBlock),
    logChunk: 2000, frozenCounts: frozen, artifactsDir: join(ctx.coreDir, "out"),
    deployerNonceAtDeployEnd: deployEndNonce(manifest),
    handoverBlock: handoverBlock(manifest),
    controlProof: controlProofOf(manifest),
    appliedReceipt: appliedReceiptOf(manifest),
  });
  if (mainnet) {
    // The mode came from the manifest, which an operator can edit or lose: read depositsPaused of all four vaults and fail on any disagreement with it.
    const read = deps.depositsPaused ?? readDepositsPaused;
    for (const v of VAULT_STAGES) {
      const want = mode === "pre-govern";
      const vault = readManifestField(ctx, manifestRef(v.stage, "vault")) as `0x${string}`;
      let got: boolean | string;
      try { got = await read(ctx.rpc, vault); } catch (e) { got = (e as Error).message; }
      if (got !== want) report.checks.push({ label: `govern ${mode}: ${VAULT_NAME[v.key]} depositsPaused is ${want}`, ok: false, detail: `the run manifest says ${mode}, so ${VAULT_NAME[v.key]} must read depositsPaused ${want}, the chain reads ${String(got)}${mode === "post-govern" ? `. If pause-all ran, reopen it: ${resumeCommand(ctx, `unpause-${v.key}`)}` : ""}` });
    }
    report.ok = report.checks.every((c) => c.ok);
    const s = await deps.verifySources({ chainId: ctx.chainId, contracts: contractsFromManifests(manifestDir(ctx), getStageTable()) });
    report.checks.push(...s.checks);
    report.ok = report.ok && s.ok;
  }
  for (const c of report.checks) ctx.log.log(c.ok ? "info" : "error", "verify.check", { label: c.label, ok: c.ok, detail: c.ok ? undefined : c.detail });
  // stdout: the verifier labels, one per line under [verify], the format of deployments/base-8453/verifier-labels.txt, so a caller can diff stage against mainnet.
  // Pass or fail is the exit code (and the verify.check log lines on stderr).
  const emit = deps.emit ?? ((l: string) => console.log(l));
  emit("[verify]");
  for (const c of report.checks) emit(c.label);
  const failed = report.checks.filter((c) => !c.ok);
  manifest.stages[row.name] = { status: report.ok ? "done" : "started", startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), checks: report.checks.length, failed: failed.length };
  saveRunManifest(ctx.evidenceDir, manifest);
  if (!report.ok) throw new PublishError("VERIFY", `the verifier reports ${failed.length} failure(s): ${failed.slice(0, 5).map((c) => c.label).join(", ")}`, { failed: failed.map((c) => c.label) });
  ctx.log.log("info", "stage.done", { stage: row.name, checks: report.checks.length });
  // release deploy only (8453): record the third-party dependency manifest. Non-fatal: a failure is a named WARN.
  await recordDependencyManifest({ chainId: ctx.chainId, rpc: ctx.rpc, coreDir: ctx.coreDir, coreSha: ctx.coreSha, log: ctx.log, baseEnv: ctx.baseEnv ?? {}, dryRun: ctx.dryRun }, deps.recorderSpawn);
  return report;
}
