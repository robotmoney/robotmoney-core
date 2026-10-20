// The verify stage of the gateway system (issue 1892): the gateway run's own verifier, on its own run manifest and stage table. It checks the gateway proxy, the explicit
// upgrade timelock, the role handover and the chain-backed "no agent authorized" invariants, and nothing of the vaults system but its unchanged manifests.
// A failed gateway verify fails the run. It pauses no vault: the vaults system is a separate system with its own pause-all, and the gateway run owns no vault.
import { join } from "node:path";
import { PublishError } from "./errors.ts";
import { effectiveCounts } from "./counts.ts";
import { adoptedTxs, manifestDir, saveRunManifest, type RunContext, type RunManifest } from "./runner.ts";
import { DEPLOYER_STAGES, getStageTable, type StageRow } from "./stages.ts";
import { RPC_REFUSED_DETAIL, type VerifyOptions, type VerifyReport, type VerifySheet } from "./verify/index.ts";

/** The verifier's sheet of the gateway run: the deployer, the pauser, the release mode and the two explicit governance inputs. Every vault field is empty. */
export function buildGatewayVerifySheet(ctx: Pick<RunContext, "sheet" | "chainId">): VerifySheet {
  const s = ctx.sheet;
  if (!s.gateway) throw new PublishError("SHEET", "the gateway verify stage needs a gateway sheet (--system gateway)");
  return {
    chainId: ctx.chainId, deployer: s.admin, pauser: s.pauser, emergency: s.emergency, safeOwners: [], safeThreshold: 0, timelockDelay: 0, deploymentKind: s.kind, vaults: {}, defaultWeights: [],
    upgradeMode: s.upgrade.mode, gateway: { admin: s.gateway.admin, upgradeTimelock: s.gateway.upgradeTimelock },
  };
}

/** The last block of the gateway handover stage: agents depositors authorize after it are theirs, not the deploy's. */
export function gatewayHandoverBlock(manifest: Pick<RunManifest, "stages">): bigint | undefined {
  const b = manifest.stages["gateway-handover"]?.lastBlock;
  return b === undefined ? undefined : BigInt(b);
}

export interface GatewayVerifyDeps { verifyDeployment: (o: VerifyOptions) => Promise<VerifyReport>; chain: VerifyOptions["chain"]; emit?: (line: string) => void }

export async function runGatewayVerifyStage(ctx: RunContext, row: StageRow, manifest: RunManifest, deps: GatewayVerifyDeps): Promise<VerifyReport> {
  const frozenFile = ctx.frozen;
  if (!frozenFile) throw new PublishError("COUNTS_MISSING", "the gateway verifier needs the frozen counts for this DEPLOY_SHA");
  if (manifest.firstBlock === undefined) throw new PublishError("INPUT_MISSING", "the run manifest has no first deploy block: the log scans need it. Run the gateway stages first.");
  const startedAt = Date.now();
  ctx.log.log("info", "stage.start", { stage: row.name });
  const report = await deps.verifyDeployment({
    system: "gateway", chain: deps.chain, manifestDir: manifestDir(ctx), table: getStageTable(), sheet: buildGatewayVerifySheet(ctx), fromBlock: BigInt(manifest.firstBlock),
    frozenCounts: effectiveCounts(frozenFile, adoptedTxs(manifest)), artifactsDir: join(ctx.coreDir, "out"), coreDir: ctx.coreDir,
    logChunk: ctx.logs?.window !== undefined ? Number(ctx.logs.window) : 2000,
    deployerStartNonce: manifest.deployerStartNonce, handoverBlock: gatewayHandoverBlock(manifest), consumedVaultsManifests: manifest.consumedVaultsManifests,
  });
  for (const c of report.checks) ctx.log.log(c.ok ? "info" : "error", "verify.check", { label: c.label, ok: c.ok, detail: c.ok ? undefined : c.detail });
  const emit = deps.emit ?? ((l: string) => console.log(l));
  emit("[verify]");
  for (const c of report.checks) emit(c.label);
  const failed = report.checks.filter((c) => !c.ok);
  manifest.stages[row.name] = { status: report.ok ? "done" : "started", startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(), checks: report.checks.length, failed: failed.length, system: "gateway" };
  saveRunManifest(ctx.evidenceDir, manifest);
  if (!report.ok && failed.every((c) => c.detail.startsWith(RPC_REFUSED_DETAIL))) {
    throw new PublishError("RPC_REFUSED", `the gateway verifier could not read ${failed.length} label(s) because the RPC refused a read: ${failed.slice(0, 5).map((c) => c.label).join(", ")}. The gateway is NOT verified.`);
  }
  if (!report.ok) throw new PublishError("VERIFY", `the gateway verifier reports ${failed.length} failure(s): ${failed.slice(0, 5).map((c) => c.label).join(", ")}`, { failed: failed.map((c) => c.label), system: "gateway" });
  ctx.log.log("info", "stage.done", { stage: row.name, checks: report.checks.length, system: "gateway", deployer_stages: DEPLOYER_STAGES.length });
  return report;
}
