// pause-all (core 1619, plan decision 22): pause deposits on ALL THREE vaults (rmUSDC, rmPROTO, rmRWA). rmUSDC is not special.
// It runs by itself when stage 12 (verify) or the postflight fails, and by hand as `pause-all`. Withdrawals stay open (core 1494): pauseDeposits() sets
// `depositsPaused` only. No contract change: every vault already has pauseDeposits(), gated by EMERGENCY_ROLE.
// Signer by stage: the DEPLOYER before the stage 11 handover (it holds EMERGENCY_ROLE on every vault until the timelock stage moves the role),
// the EMERGENCY key after it. Every vault is read back (`depositsPaused`) and the result goes into the rollout report file.
// Issue 1981: each send takes a fresh (pending) nonce, and the read-back waits until the RPC serves the receipt block, so a lagging load-balanced node cannot fail it.
// Issue 1686: the run manifest gets a `pauses` entry BEFORE the first send (see runner.ts PauseEntry); govern's execute phase refuses an unpause scheduled before it.
// Docs: docs/operations/contract-release-runbooks.md sections 4.5 and 4.6, docs/operations/manual-admin-actions.md, docs/prd.md.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { PublishError } from "./errors.ts";
import { beginPauseEntry, castOut, childEnv, nextNonce, readManifestField, receiptBlock, updatePauseEntry, waitForReceiptBlock, type PauseEntry, type RunContext, type RunManifest } from "./runner.ts";
import { vaultDisplayName, type VaultKey } from "./sheet.ts";
import type { RetiredVaultKey } from "./vault-keys.ts";
import type { PublishSigner } from "./signer.ts";
import { RETIRED_VAULT_STAGES, VAULT_STAGES, manifestRef } from "./stages.ts";
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
  key: VaultKey | RetiredVaultKey;
  address: string;
  /**
   * Review-security-002 (issue 1927): a vault of a prior line's table this line never deploys (rmAGENT of the live v0.5.0 deployment). It counts as covered when it reads retired() true
   * (the registry retire halts its deposits for good); otherwise it is paused like the others.
   */
  retired?: boolean;
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
  /** Issue 1688: false when the pause entry could not be written to the run manifest, so govern cannot see this pause-all. */
  manifestRecorded: boolean;
  /** Issue 1712: set when nothing was sent because a signer that had to pay holds no ETH. The text names the address and asks for funding. */
  blocked?: string;
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

/**
 * Issue 1712: only the deployer is funded, so the EMERGENCY key usually holds no ETH on 8453 until the owner funds it. A send from an unfunded key
 * fails, and a pause that starts on four vaults must not fail half way for that reason. The check is `balance == 0`, read before the first send:
 * it needs no gas estimate (an estimate is one more RPC call that can fail or disagree with the send), and a key with any ETH is never blocked,
 * because a pauseDeposits() on Base costs a fraction of a cent and a higher threshold could stop a pause that would have gone out. A key with some
 * ETH but not enough still fails at the send, per vault, as before. A balance that cannot be read does not block either.
 */
async function unfundedSigner(ctx: RunContext, who: string, label: string): Promise<string | undefined> {
  let balance: bigint;
  try { balance = BigInt((await castOut(ctx, ["balance", who])).trim()); } catch (e) {
    ctx.log.log("warn", "pause_all.balance_unread", { signer: who, label, message: (e as Error).message });
    return undefined;
  }
  if (balance > 0n) return undefined;
  return `the ${label} signer ${who} holds no ETH on chain ${ctx.chainId}, so it cannot pay for pauseDeposits(). Nothing was sent. Fund ${who} (only the deployer is funded: fund the emergency key when you need to pause), then run pause-all again.`;
}

const sentOk = (receipt: Record<string, unknown>): boolean => ["0x1", "1", "success"].includes(String(receipt.status).toLowerCase()) || receipt.status === 1;

async function hasEmergencyRole(ctx: RunContext, vault: string, who: string): Promise<boolean> {
  return (await castOut(ctx, ["call", vault, "hasRole(bytes32,address)(bool)", EMERGENCY_ROLE, who])).trim() === "true";
}

/**
 * Pauses deposits on all three vaults, reads `depositsPaused` back on each, and writes the rollout report. It tries every vault even when one fails.
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

  // Issue 1686: the pause entry goes into the run manifest BEFORE the first pauseDeposits() is sent, so a crash half way still leaves a record that
  // govern's execute phase refuses on. Decision (issue 1688): a failure to write it NEVER stops the pause (pausing the vaults comes first, an emergency must not wait on bookkeeping),
  // but it is never quiet: it is logged at error level, `manifestRecorded` is false in the report, and the caller turns that into a PAUSE error (pauseUnrecorded).
  const at = (ctx.now?.() ?? new Date()).toISOString();
  let entry: PauseEntry | undefined;
  const record = (fn: () => void): void => {
    try { fn(); } catch (e) { ctx.log.log("error", "pause_all.manifest_record_failed", { message: (e as Error).message, note: "govern cannot see this pause-all: cancel any pending unpause through the Safe by hand" }); }
  };
  record(() => { entry = beginPauseEntry(ctx.evidenceDir, { at, trigger: o.trigger, reason: o.reason }); });
  if (!entry) ctx.log.log("warn", "pause_all.no_manifest_entry", { evidence_dir: ctx.evidenceDir });
  // Issue 1712: every signer that has to pay must hold ETH before the first send, so the pause cannot start and fail half way. The EMERGENCY key
  // is named in the message. In the `unsure` case the signer of each vault is read now (reads only) and only the keys that will send are checked.
  // Review-security-002 (issue 1927): the live v0.5.0 deployment still has rmAGENT (RETIRED_VAULT_STAGES of its table). It is covered only once it reads retired() true.
  const stages: { key: VaultKey | RetiredVaultKey; stage: string; retiredLine: boolean }[] = [...VAULT_STAGES.map((v) => ({ ...v, retiredLine: false })), ...RETIRED_VAULT_STAGES.map((v) => ({ key: v.key, stage: v.stage, retiredLine: true }))];
  const roles: (PauseSignerRole | undefined)[] = [];
  for (const v of stages) {
    if (stageRole !== "unsure") { roles.push(stageRole); continue; }
    try { roles.push((await hasEmergencyRole(ctx, readManifestField(ctx, manifestRef(v.stage, VAULT_ADDRESS_FIELD)), deployerAddr!)) ? "deployer" : "emergency"); } catch { roles.push(undefined); }
  }
  let blocked: string | undefined;
  if (roles.includes("deployer")) blocked = await unfundedSigner(ctx, deployerAddr!, "deployer");
  if (!blocked && roles.includes("emergency")) blocked = await unfundedSigner(ctx, emergencyAddr!, "EMERGENCY");
  if (blocked) ctx.log.log("error", "pause_all.blocked", { reason: blocked });
  const vaults: PauseVaultResult[] = [];
  // Issue 1981: the last nonce this run sent from each key (lower-case address). The next send from that key never takes a nonce below it + 1.
  const sentNonce = new Map<string, number>();
  for (const [i, v] of stages.entries()) {
    const name = vaultDisplayName(v.key);
    let address = "";
    let role: PauseSignerRole = stageRole === "unsure" ? "deployer" : stageRole;
    const res: PauseVaultResult = { vault: name, key: v.key, address, signerRole: role, signer: "" };
    try {
      address = readManifestField(ctx, manifestRef(v.stage, VAULT_ADDRESS_FIELD));
      res.address = address;
      if (v.retiredLine) {
        let out = "";
        try { out = (await castOut(ctx, ["call", address, "retired()(bool)"])).trim(); } catch { /* unreadable: not proven retired, so it is paused below */ }
        if (out === "true") {
          res.retired = true;
          ctx.log.log("info", "pause_all.vault", { vault: name, address, retired: true, note: "retired by the registry: deposits are halted for good, nothing to send" });
          vaults.push(res);
          if (entry) { const e = entry; record(() => updatePauseEntry(ctx.evidenceDir, { ...e, vaults: vaults.map((x) => ({ ...x })) })); }
          continue;
        }
      }
      if (stageRole === "unsure") role = roles[i] ?? ((await hasEmergencyRole(ctx, address, deployerAddr!)) ? "deployer" : "emergency");
      res.signerRole = role;
      const signer = role === "deployer" ? deployer : emergency!;
      res.signer = role === "deployer" ? deployerAddr! : emergencyAddr!;
      if (blocked) throw new PublishError("PAUSE", blocked);
      // Issue 1981: the nonce is read fresh (pending) for every send, never below one past this key's last send in this run: a lagging node answered a stale nonce on 8453.
      const nonce = await nextNonce(ctx, res.signer, sentNonce.get(lc(res.signer)));
      const r = await ctx.run("cast", ["send", address, "pauseDeposits()", "--json", ...(nonce === undefined ? [] : ["--nonce", String(nonce)]), ...(await castSignerArgs(signer))], { env: childEnv(ctx), interactive: true });
      if (r.code !== 0) throw new PublishError("TOOL", `cast send pauseDeposits() on ${name} failed: ${r.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${r.code} with no error text${nonce === undefined ? "" : ` (nonce ${nonce})`}`}`);
      let receipt: Record<string, unknown> = {};
      try { receipt = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}"); } catch { /* read-back below is the proof */ }
      if (nonce !== undefined) sentNonce.set(lc(res.signer), nonce);
      if (typeof receipt.transactionHash === "string") res.txHash = receipt.transactionHash;
      // Issue 1981: the read-back below and the next send wait until the RPC serves the receipt's block (three reads in a row, as scripts/runbook/cast-send.sh).
      const block = receiptBlock(receipt);
      if (block === undefined) ctx.log.log("warn", "pause_all.no_receipt_block", { vault: name, tx_hash: res.txHash, note: "the receipt names no block: the read-back cannot wait for it" });
      else await waitForReceiptBlock(ctx, block, `pauseDeposits() on ${name}`);
      if (receipt.status !== undefined && !sentOk(receipt)) throw new PublishError("BROADCAST", `pauseDeposits() on ${name} was mined and reverted (${String(receipt.transactionHash)})`);
    } catch (e) {
      res.error = (e as Error).message;
      if (!blocked) ctx.log.log("error", "pause_all.send_failed", { vault: name, address: address || undefined, message: res.error });
    }
    // the read-back runs whether or not the send worked: the state on chain is the answer
    if (address) {
      try {
        const out = (await castOut(ctx, ["call", address, "depositsPaused()(bool)"])).trim();
        if (out !== "true" && out !== "false") throw new PublishError("TOOL", `depositsPaused() on ${name} returned '${out}'`);
        res.depositsPaused = out === "true";
        if (blocked && res.depositsPaused) delete res.error; // already paused: nothing needed to be sent
      } catch (e) { res.error ??= (e as Error).message; }
    }
    ctx.log.log(res.depositsPaused ? "info" : "error", "pause_all.vault", { vault: name, address: address || undefined, signer_role: res.signerRole, tx_hash: res.txHash, deposits_paused: res.depositsPaused ?? null });
    vaults.push(res);
    if (entry) { const e = entry; record(() => updatePauseEntry(ctx.evidenceDir, { ...e, vaults: vaults.map((x) => ({ ...x })) })); }
  }
  const report: PauseAllReport = { trigger: o.trigger, reason: o.reason, at, allPaused: vaults.every((x) => x.depositsPaused === true || x.retired === true), manifestRecorded: entry !== undefined, ...(blocked ? { blocked } : {}), vaults };
  if (entry) { const e = entry; record(() => updatePauseEntry(ctx.evidenceDir, { ...e, status: "done", allPaused: report.allPaused, vaults: vaults.map((x) => ({ ...x })) })); }
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

/** Issue 1688: the error for a pause-all that paused the vaults but could not record itself in the run manifest: govern cannot see it. */
export function pauseUnrecorded(report: PauseAllReport, prefix = ""): PublishError {
  return new PublishError("PAUSE", `${prefix}pause-all paused the vaults, but it could NOT be recorded in the run manifest, so govern will not refuse an unpause scheduled before it. Cancel every pending unpause operation through the Safe by hand now.`, { manifest_recorded: false, trigger: report.trigger });
}

/**
 * The error for a pause-all that did not leave all three vaults paused. Issue 1701: when the pause could not be recorded either, the message also carries the
 * cancel-pending-unpauses instruction of `pauseUnrecorded` (govern cannot see an unrecorded pause) and the details say `manifest_recorded: false`.
 */
export function pauseIncomplete(report: PauseAllReport, prefix = ""): PublishError {
  const unrecorded = report.manifestRecorded === false;
  const cancel = unrecorded ? " The pause could NOT be recorded in the run manifest either, so govern will not refuse an unpause scheduled before it. Cancel every pending unpause operation through the Safe by hand now." : "";
  const rec = unrecorded ? { manifest_recorded: false } : {};
  if (report.blocked) return new PublishError("PAUSE", `${prefix}pause-all could not send: ${report.blocked}${cancel}`, { unpaused: report.vaults.filter((v) => v.depositsPaused !== true && v.retired !== true).map((v) => v.vault), blocked: true, ...rec });
  const bad = report.vaults.filter((v) => v.depositsPaused !== true && v.retired !== true);
  return new PublishError("PAUSE", `${prefix}pause-all left ${bad.length} of ${report.vaults.length} vaults NOT confirmed paused: ${bad.map((v) => `${v.vault}${v.error ? ` (${v.error})` : ""}`).join(", ")}. Pause them by hand now.${cancel}`, { unpaused: bad.map((v) => v.vault), ...rec });
}
