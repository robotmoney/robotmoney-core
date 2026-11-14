// Deploy 4 (owner exception 2026-11-12): the verify stage of the fund system, the one-vault prototype deployed as a rehearsal. The fund run's own verifier (verify/fund.ts), on
// its own run manifest and stage table. A failed fund verify fails the run. It pauses nothing by itself: the vaults system's pause-all knows no fund, and the fund's
// emergency levers (pauseDeposits on the fund, the queue's own pause) are the emergency key's, driven by the runbook's pause drill.
import { join } from "node:path";
import { PublishError } from "./errors.ts";
import { effectiveCounts } from "./counts.ts";
import { adoptedTxs, manifestDir, saveRunManifest, type RunContext, type RunManifest } from "./runner.ts";
import { proxyBuildDirsOf } from "./verify-stage.ts";
import { DEPLOYER_STAGES, getStageTable, handoverStage, type StageRow } from "./stages.ts";
import { RPC_REFUSED_DETAIL, type VerifyOptions, type VerifyReport, type VerifySheet } from "./verify/index.ts";

/** The verifier's sheet of the fund run: the shared fields and the fund's own values. No vault of the vaults system, no router vector. */
export function buildFundVerifySheet(ctx: Pick<RunContext, "sheet" | "chainId">): VerifySheet {
  const s = ctx.sheet;
  if (!s.fund) throw new PublishError("SHEET", "the fund verify stage needs a fund sheet (--system fund)");
  const f = s.fund;
  return {
    chainId: ctx.chainId, deployer: s.admin, pauser: s.pauser, emergency: s.emergency, safeOwners: s.safeOwners, safeThreshold: s.safeThreshold, timelockDelay: Number(s.timelockMinDelay),
    deploymentKind: s.kind, upgradeMode: s.upgrade.mode, ...(s.upgrade.freezeDeadline ? { freezeDeadline: s.upgrade.freezeDeadline } : {}), vaults: {}, defaultWeights: [],
    fund: { keeper: f.keeper, tvlCap: f.tvlCap, perDepositCap: f.perDepositCap, exitFeeBps: f.exitFeeBps, maxSlippageBps: f.maxSlippageBps, navDeviationBps: f.navDeviationBps, minSeedUsdc: f.minSeedUsdc, params: f.params },
  };
}

export interface FundVerifyDeps { verifyDeployment: (o: VerifyOptions) => Promise<VerifyReport>; chain: VerifyOptions["chain"]; emit?: (line: string) => void }

export async function runFundVerifyStage(ctx: RunContext, row: StageRow, manifest: RunManifest, deps: FundVerifyDeps): Promise<VerifyReport> {
  const frozenFile = ctx.frozen;
  if (!frozenFile) throw new PublishError("COUNTS_MISSING", "the fund verifier needs the frozen counts for this DEPLOY_SHA");
  if (manifest.firstBlock === undefined) throw new PublishError("INPUT_MISSING", "the run manifest has no first deploy block. Run the fund stages first.");
  const startedAt = Date.now();
  ctx.log.log("info", "stage.start", { stage: row.name, system: "fund" });
  // The nonce at the end of the handover, as the run recorded it: the deployer sends the runbook's QA transactions after it, so the live nonce is not the deploy's.
  const handover = manifest.stages[handoverStage()];
  const report = await deps.verifyDeployment({
    system: "fund", chain: deps.chain, manifestDir: manifestDir(ctx), table: getStageTable(), sheet: buildFundVerifySheet(ctx), fromBlock: BigInt(manifest.firstBlock),
    frozenCounts: effectiveCounts(frozenFile, adoptedTxs(manifest)), artifactsDir: join(ctx.coreDir, "out"), coreDir: ctx.coreDir,
    // An in-place upgrade (the fund-upgrade flow): a proxy the run manifest records as upgraded (proxy_upgrades, fund-upgrade-record.ts) is compared with its upgrade's build.
    ...proxyBuildDirsOf(manifest, join(ctx.coreDir, "out")),
    deployerStartNonce: manifest.deployerStartNonce, ...(handover?.status === "done" && handover.endNonce !== undefined ? { deployerNonceAtDeployEnd: handover.endNonce } : {}),
  });
  for (const c of report.checks) ctx.log.log(c.ok ? "info" : "error", "verify.check", { label: c.label, ok: c.ok, detail: c.ok ? undefined : c.detail });
  const emit = deps.emit ?? ((l: string) => console.log(l));
  emit("[verify]");
  for (const c of report.checks) emit(c.label);
  const failed = report.checks.filter((c) => !c.ok);
  manifest.stages[row.name] = { status: report.ok ? "done" : "started", startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), checks: report.checks.length, failed: failed.length, system: "fund" };
  saveRunManifest(ctx.evidenceDir, manifest);
  if (!report.ok && failed.every((c) => c.detail.startsWith(RPC_REFUSED_DETAIL))) {
    throw new PublishError("RPC_REFUSED", `the fund verifier could not read ${failed.length} label(s) because the RPC refused a read: ${failed.slice(0, 5).map((c) => c.label).join(", ")}. The fund is NOT verified.`);
  }
  if (!report.ok) throw new PublishError("VERIFY", `the fund verifier reports ${failed.length} failure(s): ${failed.slice(0, 5).map((c) => c.label).join(", ")}`, { failed: failed.map((c) => c.label), system: "fund" });
  ctx.log.log("info", "stage.done", { stage: row.name, checks: report.checks.length, system: "fund", deployer_stages: DEPLOYER_STAGES.length });
  return report;
}
