// Stage 12 verify: the one verifier (src/verify). The CLI builds the verifier's sheet from the frozen sheet, reads the expected
// asset config from the core config file (never from the chain it is checking) and fails the run on any failed check.
import { join } from "node:path";
import { PublishError } from "./errors.ts";
import { MAINNET_CHAIN_ID } from "./floors.ts";
import { governHasRun, measuredCounts, manifestDir, saveRunManifest, readManifestField, type RunContext, type RunManifest } from "./runner.ts";
import { VAULT_KEYS, VAULT_NAME, eligibleInOrder, type VaultKey } from "./sheet.ts";
import { VAULT_ADAPTER_FIELD } from "./core-wiring.ts";
import { PROOF_STAGE } from "./control-proof.ts";
import { loadConfigAssets } from "./asset-config.ts";
import { manifestBase } from "./stage-table.ts";
import { DEPLOYER_STAGES, getStageTable, manifestRef, type StageRow } from "./stages.ts";
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
  const adapter = readManifestField(ctx, `${manifestBase(getStageTable().stages.find((s) => s.name === vaultStage)!.manifest)}:${VAULT_ADAPTER_FIELD}`) as `0x${string}`;
  return configured.map((a) => ({ token: a.token, pool: a.pool, swapFee: a.swapFee, adapter, venue: a.venue }));
}

/**
 * The vaults the govern unpause rows have unpaused: a vault is listed once the run manifest records the executed phase of its own row
 * `unpause-<VAULT>` (one round per vault). Before that phase, none. A vault whose row was skipped (not in GOVERN_UNPAUSE_VAULTS) stays paused.
 */
export function unpausedByGovern(manifest: Pick<RunManifest, "govern">, sheet: RunContext["sheet"]): VaultKey[] {
  const g = manifest.govern as Record<string, { executed?: unknown } | undefined> | undefined;
  return sheet.govern.unpauseVaults.filter((k) => !!g?.[`unpause-${k}`]?.executed);
}

/** The basket vaults whose unpause row never ran: on 8453 stage 13 must have executed all three (the sheet parser requires all three listed). */
export const MAINNET_UNPAUSE_BASKETS: readonly VaultKey[] = ["PROTO", "AGENT", "RWA"];
export function unexecutedMainnetUnpauses(manifest: Pick<RunManifest, "govern">): VaultKey[] {
  const g = manifest.govern as Record<string, { executed?: unknown } | undefined> | undefined;
  return MAINNET_UNPAUSE_BASKETS.filter((k) => !g?.[`unpause-${k}`]?.executed);
}

/** The timelock delay the chain should read: GOVERN_NEW_DELAY once the executed phase of the govern row `update-delay` ran, else TIMELOCK_MIN_DELAY. */
export function expectedTimelockDelay(manifest: Pick<RunManifest, "govern">, sheet: RunContext["sheet"]): number {
  const g = manifest.govern as Record<string, { executed?: unknown } | undefined> | undefined;
  return g?.["update-delay"]?.executed ? Number(sheet.govern.newDelay) : Number(sheet.timelockMinDelay);
}

/**
 * The verifier's sheet, from the frozen sheet. Basket and agent vaults ship paused until stage 13. The link between the govern rows and the
 * reads: a vault the unpause rows unpaused is expected paused=false, every other basket and agent vault is expected paused=true. So a verify
 * run after govern fails when an unpause row ran and the vault still reads paused, and when a vault reads unpaused with no unpause row behind it.
 */
export function buildVerifySheet(ctx: Pick<RunContext, "sheet" | "coreDir" | "chainId" | "manifestOut">, safeAddress: string, unpaused: readonly VaultKey[] = [], timelockDelay?: number): VerifySheet {
  const s = ctx.sheet;
  const vaults: Record<string, VaultSheet> = {};
  for (const k of VAULT_KEYS) {
    const v = s.vaults[k];
    vaults[VAULT_NAME[k]] = {
      tvlCap: v.tvlCap, perDepositCap: v.perDepositCap, exitFeeBps: v.exitFeeBps,
      feeRecipient: (s.feeRecipient === "@safe" ? safeAddress : s.feeRecipient) as `0x${string}`,
      expectPaused: k !== "USDC" && !unpaused.includes(k),
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

export interface VerifyDeps {
  verifyDeployment: (o: VerifyOptions) => Promise<VerifyReport>;
  verifySources: typeof verifySources;
  /** Injected for tests: the spawn that runs core's dependency manifest recorder. */
  recorderSpawn?: RecorderSpawn;
  /** Where a label line goes. Default: stdout (console.log). */
  emit?: (line: string) => void;
}
export const realVerifyDeps: VerifyDeps = { verifyDeployment, verifySources };

export async function runVerifyStage(ctx: RunContext, row: StageRow, manifest: RunManifest, deps: VerifyDeps = realVerifyDeps): Promise<VerifyReport> {
  const frozen = ctx.frozen ?? (ctx.measure ? measuredCounts(manifest) : undefined);
  if (!frozen) throw new PublishError("COUNTS_MISSING", "the verifier needs the frozen counts for this DEPLOY_SHA");
  if (manifest.firstBlock === undefined) throw new PublishError("INPUT_MISSING", "the run manifest has no first deploy block: the role scan needs it. Run the deploy stages first.");
  const safe = readManifestField(ctx, manifestRef("safe", "safe"));
  const startedAt = Date.now();
  const mainnet = ctx.chainId === MAINNET_CHAIN_ID;
  // 8453: all three baskets ship unpaused, so every one is expected unpaused on chain whatever the manifest says (a part-way govern run must not pass).
  const unpaused = mainnet ? [...MAINNET_UNPAUSE_BASKETS] : unpausedByGovern(manifest, ctx.sheet);
  ctx.log.log("info", "stage.start", { stage: row.name });
  const report = await deps.verifyDeployment({
    chain: viemReader(ctx.rpc), manifestDir: manifestDir(ctx), table: getStageTable(), sheet: buildVerifySheet(ctx, safe, unpaused, expectedTimelockDelay(manifest, ctx.sheet)), fromBlock: BigInt(manifest.firstBlock),
    logChunk: 2000, frozenCounts: frozen, artifactsDir: join(ctx.coreDir, "out"),
    deployerNonceAtDeployEnd: deployEndNonce(manifest),
    handoverBlock: handoverBlock(manifest),
    controlProof: controlProofOf(manifest),
  });
  if (mainnet) {
    for (const k of unexecutedMainnetUnpauses(manifest)) report.checks.push({ label: `govern unpause-${k} executed (stage 13)`, ok: false, detail: `the run manifest records no executed unpause-${k} row: stage 13 did not fully run` });
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
