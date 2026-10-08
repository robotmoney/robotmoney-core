// pause-all (core 1619, plan decision 22): pause deposits on ALL FOUR vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA). rmUSDC is not special.
// It runs by itself when stage 12 (verify) or the postflight fails, and by hand as `pause-all`. Withdrawals stay open (core 1494): pauseDeposits() sets
// `depositsPaused` only. No contract change: every vault already has pauseDeposits(), gated by EMERGENCY_ROLE.
// Signer by stage: the DEPLOYER before the stage 11 handover (it holds EMERGENCY_ROLE on every vault until the timelock stage moves the role),
// the EMERGENCY key after it. Every vault is read back (`depositsPaused`) and the result goes into the rollout report file.
// Docs: docs/operations/contract-release-runbooks.md sections 4.5 and 4.6, docs/operations/manual-admin-actions.md, docs/prd.md.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { PublishError } from "./errors.ts";
import { castOut, childEnv, readManifestField, type RunContext, type RunManifest } from "./runner.ts";
import { VAULT_NAME, type VaultKey } from "./sheet.ts";
import type { PublishSigner } from "./signer.ts";
import { VAULT_STAGES, manifestRef } from "./stages.ts";
import { VAULT_ADDRESS_FIELD } from "./core-wiring.ts";

/** The stage that moves EMERGENCY_ROLE from the deployer to the EMERGENCY key (the stage 11 handover). */
export const HANDOVER_STAGE = "timelock";
export const EMERGENCY_ROLE = keccak256(toHex("EMERGENCY_ROLE"));

export type PauseSignerRole = "deployer" | "emergency";
export type PauseTrigger = "verify" | "postflight" | "manual";

/**
 * Who signs, by stage. No timelock stage record: the handover has not started, the deployer signs. A finished timelock stage: the EMERGENCY key signs.
 * A started but unfinished one is `unsure`: each vault is then decided by who holds EMERGENCY_ROLE on it right now.
 */
export function pauseSignerRole(manifest: Pick<RunManifest, "stages">): PauseSignerRole | "unsure" {
  const rec = manifest.stages[HANDOVER_STAGE];
  if (!rec) return "deployer";
  return rec.status === "done" ? "emergency" : "unsure";
}

export interface PauseVaultResult {
  vault: string;
  key: VaultKey;
  address: string;
  signerRole: PauseSignerRole;
  signer: string;
  txHash?: string;
  /** The depositsPaused value read back from the vault after the send. Undefined when the read failed. */
  depositsPaused?: boolean;
  error?: string;
}

export interface PauseAllReport {
  trigger: PauseTrigger;
  /** Why it ran: the failure that fired it, or `manual`. */
  reason: string;
  at: string;
  allPaused: boolean;
  vaults: PauseVaultResult[];
}

export interface PauseOpts {
  trigger: PauseTrigger;
  reason: string;
  /** The EMERGENCY key signer. Needed once the handover has begun. */
  emergencySigner?: PublishSigner;
}

export const rolloutReportPath = (ctx: Pick<RunContext, "evidenceDir" | "chainId">): string => join(ctx.evidenceDir, `rollout-report-${ctx.chainId}.json`);

const lc = (a: string): string => a.toLowerCase();

/** cast send takes the signer flags forge takes, except the sender is named --from. */
async function castSignerArgs(s: PublishSigner): Promise<string[]> {
  return (await s.forgeArgs()).map((a) => (a === "--sender" ? "--from" : a));
}

const sentOk = (receipt: Record<string, unknown>): boolean => ["0x1", "1", "success"].includes(String(receipt.status).toLowerCase()) || receipt.status === 1;

async function hasEmergencyRole(ctx: RunContext, vault: string, who: string): Promise<boolean> {
  return (await castOut(ctx, ["call", vault, "hasRole(bytes32,address)(bool)", EMERGENCY_ROLE, who])).trim() === "true";
}

/**
 * Pauses deposits on all four vaults, reads `depositsPaused` back on each, and writes the rollout report. It tries every vault even when one fails.
 * Returns the report. `allPaused` is false when any vault could not be sent or does not read back paused: the caller turns that into an error.
 */
export async function pauseAll(ctx: RunContext, manifest: Pick<RunManifest, "stages">, o: PauseOpts): Promise<PauseAllReport> {
  if (ctx.dryRun) throw new PublishError("USAGE", "pause-all sends real transactions: it is not part of a --dry-run");
  const deployer = ctx.signer;
  const emergency = o.emergencySigner;
  const stageRole = pauseSignerRole(manifest);
  if (stageRole !== "deployer" && !emergency) {
    throw new PublishError("SIGNER", `the handover (stage ${HANDOVER_STAGE}) has ${stageRole === "emergency" ? "run" : "started"}: pause-all needs the EMERGENCY key (--emergency-signer SPEC). The deployer no longer holds EMERGENCY_ROLE on every vault.`);
  }
  const check = async (s: PublishSigner, want: string, name: string): Promise<string> => {
    const a = await s.address();
    if (lc(a) !== lc(want)) throw new PublishError("SIGNER", `the ${name} signer ${a} is not the sheet's ${name === "deployer" ? "ADMIN_ADDRESS" : "EMERGENCY_ADDRESS"} ${want}`);
    return a;
  };
  const deployerAddr = stageRole === "emergency" ? undefined : await check(deployer, ctx.sheet.admin, "deployer");
  const emergencyAddr = stageRole === "deployer" || !emergency ? undefined : await check(emergency, ctx.sheet.emergency, "emergency");

  const vaults: PauseVaultResult[] = [];
  for (const v of VAULT_STAGES) {
    const name = VAULT_NAME[v.key];
    let address = "";
    let role: PauseSignerRole = stageRole === "unsure" ? "deployer" : stageRole;
    const res: PauseVaultResult = { vault: name, key: v.key, address, signerRole: role, signer: "" };
    try {
      address = readManifestField(ctx, manifestRef(v.stage, VAULT_ADDRESS_FIELD));
      res.address = address;
      if (stageRole === "unsure") role = (await hasEmergencyRole(ctx, address, deployerAddr!)) ? "deployer" : "emergency";
      res.signerRole = role;
      const signer = role === "deployer" ? deployer : emergency!;
      res.signer = role === "deployer" ? deployerAddr! : emergencyAddr!;
      const r = await ctx.run("cast", ["send", address, "pauseDeposits()", "--json", ...(await castSignerArgs(signer))], { env: childEnv(ctx), interactive: true });
      if (r.code !== 0) throw new PublishError("TOOL", `cast send pauseDeposits() on ${name} failed: ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
      let receipt: Record<string, unknown> = {};
      try { receipt = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}"); } catch { /* read-back below is the proof */ }
      if (typeof receipt.transactionHash === "string") res.txHash = receipt.transactionHash;
      if (receipt.status !== undefined && !sentOk(receipt)) throw new PublishError("BROADCAST", `pauseDeposits() on ${name} was mined and reverted (${String(receipt.transactionHash)})`);
    } catch (e) {
      res.error = (e as Error).message;
      ctx.log.log("error", "pause_all.send_failed", { vault: name, address: address || undefined, message: res.error });
    }
    // the read-back runs whether or not the send worked: the state on chain is the answer
    if (address) {
      try {
        const out = (await castOut(ctx, ["call", address, "depositsPaused()(bool)"])).trim();
        if (out !== "true" && out !== "false") throw new PublishError("TOOL", `depositsPaused() on ${name} returned '${out}'`);
        res.depositsPaused = out === "true";
      } catch (e) { res.error ??= (e as Error).message; }
    }
    ctx.log.log(res.depositsPaused ? "info" : "error", "pause_all.vault", { vault: name, address: address || undefined, signer_role: res.signerRole, tx_hash: res.txHash, deposits_paused: res.depositsPaused ?? null });
    vaults.push(res);
  }
  const report: PauseAllReport = { trigger: o.trigger, reason: o.reason, at: (ctx.now?.() ?? new Date()).toISOString(), allPaused: vaults.every((x) => x.depositsPaused === true), vaults };
  writeRolloutReport(ctx, report);
  ctx.log.log(report.allPaused ? "info" : "error", "pause_all.done", { all_paused: report.allPaused, trigger: o.trigger, report: rolloutReportPath(ctx) });
  return report;
}

/** The rollout report: the run's identity and the pause-all result with each vault's paused state. Written atomically, rewritten by a later pause-all. */
export function writeRolloutReport(ctx: Pick<RunContext, "evidenceDir" | "chainId" | "coreSha" | "environment">, pause: PauseAllReport): string {
  mkdirSync(ctx.evidenceDir, { recursive: true });
  const p = rolloutReportPath(ctx);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ chainId: ctx.chainId, coreSha: ctx.coreSha, environment: ctx.environment, pauseAll: pause }, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, p);
  return p;
}

/** The error for a pause-all that did not leave all four vaults paused. */
export function pauseIncomplete(report: PauseAllReport, prefix = ""): PublishError {
  const bad = report.vaults.filter((v) => v.depositsPaused !== true);
  return new PublishError("PAUSE", `${prefix}pause-all left ${bad.length} of ${report.vaults.length} vaults NOT confirmed paused: ${bad.map((v) => `${v.vault}${v.error ? ` (${v.error})` : ""}`).join(", ")}. Pause them by hand now.`, { unpaused: bad.map((v) => v.vault) });
}
