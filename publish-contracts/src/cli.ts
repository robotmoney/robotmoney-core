#!/usr/bin/env bun
// publish contracts: one Bun TypeScript CLI that runs every contract deploy, on the Twin chain (918453) and on Base mainnet (8453).
// bun src/cli.ts [publish|verify|govern] --chain 8453 --rpc URL --sheet FILE --signer SPEC --environment NAME --core-sha SHA [--stage S] [--row R] [--resume] [--dry-run]
// The positional verbs are the consumer contract of core's Twin harness (see README.md, "Core harness contract").
// A rehearsal and production differ only in these arguments. It spawns forge, cast, a read-only git status and core's config-check (bun). Logs are JSON on stderr.
import { createInterface } from "node:readline";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { exitCodeOf, isPublishError, PublishError } from "./errors.ts";
import { assertFloors, assertOwnerSignerSpec, assertSignerSpec, readRpcChainId, isMainnet, MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "./floors.ts";
import { ACTIONS_TOKEN_ENV, proveActions, proofLogFields, type ActionsProof } from "./actions-proof.ts";
import { kindLabel } from "./chains.ts";
import { REGISTER_ROW, assertSubmitter } from "./submitter-register.ts";
import { assertRecordInputs, recordReceipt, type RecordApi } from "./record-receipt.ts";
import { FROZEN_DIR, assertSha, loadFrozen, resolveCounts, writeFrozen, type FrozenFile } from "./counts.ts";
import { claimedOwnerOf, siblingEmergencySpec, siblingOwnerSpecs } from "./owner-signers.ts";
import { buildIsomorphismReport, dirtyTreeLines, readGitHead, writeReport } from "./isomorphism.ts";
import { scrubGitEnv } from "./git-env.ts";
import { publishLogger, type Logger } from "./log.ts";
import { planNonceBasis, stagePlan } from "./plan.ts";
import { assertBaselineCommitted, assertReleaseGate, assertUpgradeBuildGate, gitAnchorCommitted, gitFrozenDirCommitted, type CheckShaGreen } from "./release-gate.ts";
import { codeWithRetry, verifyReconstructionOnChain } from "./counts-reconstruct.ts";
import { buildLibraryArtifacts } from "./libs-build.ts";
import { DEPLOYER_STAGES, STAGE_NAMES, getStageTable, peekStageState, restoreStageState, useStageTable } from "./stages.ts";
import { TABLE_REL, loadStageTable, SYSTEM_NAMES, type SystemName } from "./stage-table.ts";
import { adoptedTxs, finalNonceCheck, loadRunManifest, measuredCounts, runStages, spawnTool, childEnv, type ProcessRunner, type RunContext } from "./runner.ts";
import { RETIRED_VAULT_VERBS, callerInputs, parseSheet, type Sheet } from "./sheet.ts";
import { isRetiredVaultKey } from "./vault-keys.ts";
import { assertVaultRulesMatch } from "./vault-rules.ts";
import { makeSigner, type PublishSigner } from "./signer.ts";
import { PROOF_STAGE } from "./control-proof.ts";
import { realVerifyDeps, runVerifyStage, type VerifyDeps } from "./verify-stage.ts";
import { APPLY_ROW } from "./apply-receipt.ts";
import { CLEAR_ROW } from "./clear-voted-weights.ts";
import { RETIRE_KEYS, RETIRE_ROW, parseRetireArgs } from "./retire-vault.ts";
import { UNWIND_GUARD_KEYS, UNWIND_GUARD_ROW, parseUnwindGuardArgs } from "./unwind-guard.ts";
import { REDEPLOY_ROW, REDEPLOY_VERB, REDEPLOY_KEYS, isRedeployKey, redeployRefusal, redeployShaPath, redeployShaRun, runRedeployVault } from "./redeploy-vault.ts";
import { FREEZE_ROW, UPGRADE_ROW } from "./upgrade-rows.ts";
import { toolingShaRun } from "./tooling-sha.ts";
import { DEPLOY_IMPL_VERB, runDeployImplementation } from "./deploy-implementation.ts";
import { proxySpecs } from "./verify/upgradeability.ts";
import { RECEIPT_ROW, SELF_ADMIN_ROWS, assertReceiptId, assertSelfAdminAllowed, govRowRefusal, isSelfAdminRow, isTwinOnlyRow, resolveGovernRow, runGovern, type GovernOpts } from "./govern.ts";
import { isHardwareSpecLike, ownerHardwareSigner, parseOwnerHardwareSpec, signerFromSpec, type CastRunner, type Signer } from "./safe/index.ts";
import { pauseAll, pauseIncomplete, pauseUnrecorded, type PauseTrigger } from "./pause-all.ts";
import { runProveControl, type LogScanOpts, type ProveOpts } from "./prove-control.ts";
import { startAnvil, type ChainStarter } from "./preflight.ts";
import { USDC_ADDRESS, assertUsdcCode } from "./usdc.ts";
import { assertExitFeeBound } from "./asset-config.ts";
import { runCoreConfigCheck, type CoreConfigCheck } from "./core-config-check.ts";

/** The environment variable core's harness sets on the child: the directory the stage manifests are written to and read from. */
export const MANIFEST_DIR_ENV = "PUBLISH_MANIFEST_DIR";
/** A PublishSigner that constructs the real one on its first use. Cleanup before then is a no-op. */
function lazyPublishSigner(spec: string, construct: () => PublishSigner, adopt: (real: PublishSigner) => void): PublishSigner {
  let real: PublishSigner | undefined;
  const get = (): PublishSigner => { if (!real) { real = construct(); adopt(real); } return real; };
  return {
    spec, kind: "keystore",
    forgeArgs: () => get().forgeArgs(), address: () => get().address(), safeSigner: () => get().safeSigner(),
    cleanup: () => { real?.cleanup(); },
  };
}

export const VERBS = ["publish", "verify", "govern", "pause-all", "record-receipt", "redeploy-vault", "deploy-implementation"] as const;
export type Verb = (typeof VERBS)[number];

export const USAGE = `publish contracts
  VERB               optional first word: publish | verify | govern | pause-all | record-receipt | redeploy-vault | deploy-implementation. An alias for a stage set (below). Not combined with --stage.
                       publish = every deployer stage up to and including timelock (the same as --stage deploy), with the prove-control step
                                 before the timelock stage: the real Safe executes one self-call signed by EVERY owner, or stage 11 refuses (exit 24)
                       verify  = the verify stage (the one verifier; a follow-on verb, so it implies --resume)
                       govern  = the govern stage (a follow-on verb, so it implies --resume)
                       record-receipt = the SUBMITTER SAFE (--submitter, executed by --signer = the gas payer, signed by its --owner-signer owners) anchors one consensus receipt DIRECTLY on the receipt contract (issue 1888), on every
                                 chain and in every mode (production 8453, rehearsal 8453, Twin). Required: --submitter, --payload FILE (the exact served bytes, already verified with 'rmpc receipt verify'), --receipt-id, --payload-digest and
                                 --payload-uri. The digest and the id are recomputed from the bytes and the Safe, its RECEIPT_SUBMITTER_ROLE and the payload are checked BEFORE any signer is built. A single key is refused in every mode.
                       redeploy-vault = REDEPLOY ONE VAULT into the live deployment (issue 1796, an experiment on a Base mainnet REHEARSAL: refused on 8453 in production): --vault PROTO. The DEPLOYER (--signer) deploys a NEW rmPROTO from the
                                 release tag that holds the fix: closed, unregistered, linked to the registry, ADMIN_ROLE on the timelock and EMERGENCY_ROLE on the emergency key. The old vault is not touched. --evidence is the run that deployed
                                 the deployment. Then run 'govern --row redeploy-vault' (the Safe, through the timelock, registers it, moves router eligibility, retires the old vault and opens the new one). --dry-run simulates only.
                                 SHA MODEL (QA plan v1 E1): --core-sha is the REDEPLOY sha (the fix's tag), recorded as the round's core_sha; the run manifest keeps the ORIGINAL sha. The govern row and the
                                 verify after it run at that redeploy sha (the row also at the original sha), with no frozen counts file for it: see --row redeploy-vault and --prior-out.
                       deploy-implementation = step 2 of a governed upgrade (issue 1861): --proxy NAME [--upgrade-build DIR]. The DEPLOYER (--signer) deploys a new implementation of the proxy
                                 from DIR/out (default the DEPLOY_SHA checkout), every library link filled with the address the LIVE implementation links. Refused (nothing sent) when the proxy
                                 reads upgradesFrozen() true, when DIR's layout snapshot does not extend the deployed one append-only, or when the build and the live implementation do not link
                                 the same libraries. It reads the runtime code back against the build (immutables and links masked), records implementation_deploys in the run manifest and
                                 prints the govern --row upgrade-proxy --implementation command to run next. A rerun with the same arguments reprints the recorded entry and sends nothing.
                       pause-all = pause deposits on ALL THREE vaults (rmUSDC, rmPROTO, rmRWA), read depositsPaused back on each, write evidence/rollout-report-<chain>.json.
                                 Withdrawals stay open. The signer is the deployer before the stage 11 handover and the EMERGENCY key after it (--emergency-signer).
                                 It also runs by itself when stage 12 (verify) or the postflight fails (the run then still exits with the verify failure's code, 13).
  --chain N          target chain id (8453 or 918453). Must equal 'cast chain-id' of the RPC.
  --rpc URL          the RPC endpoint
  --sheet FILE       the frozen sheet (parsed as data, never sourced)
  --signer SPEC      keystore:PATH[:PASSFILE], env:signer, ledger or trezor. Never a key. Plaintext material is refused on a non-loopback RPC.
                     address:0xADMIN is accepted with --dry-run only (no secret: the sender of a simulation).
  --environment NAME the GitHub Environment (or 'local' on a rehearsal)
  --core-sha SHA     the core DEPLOY_SHA (40 hex). The core checkout HEAD must equal it.
  --row R            govern only: run one govern row, by 1-based number or by name.
                     Rows: unpause-USDC, unpause-PROTO, unpause-RWA (all three vaults deploy paused; the only mainnet operation after the handover), then the Twin-only
                     demonstrations update-delay, batch, cancel (refused with USAGE on 8453). Without --row, every unpause the sheet asks for is
                     scheduled in one sitting, then one wait, then executed (on 8453 only the unpauses run).
                     Naming an unpause row whose
                     vault was paused again after an executed round opens a new numbered round: a new timelock operation, a new 48 hour delay.
                     On 8453 a wait of 48 hours exits 15 (GOVERN_PENDING) once, with the ready time and the command to run again.
                     On demand, outside the ordered rows: --row apply-receipt --receipt-id 0x<bytes32> --payload FILE applies one recorded consensus receipt (issue 1696, issue 1698):
                     ONE timelock call, RouterGovernance.applyReceipt(receiptId, payloadDigest, vaults, bps), which releases the receipt and sets the router's active vector together.
                     Refused with USAGE (nothing sent) unless the receipt is recorded and unreleased, was recorded after the last applied receipt (lastAppliedRecordedAt, issue 1831),
                     the payload's receipt digest (domain line + bytes) equals the stored digest, and the vector sums to 10000 bps and lists the registry's router-eligible vaults in
                     registry order. Not part of stage 13. After the delay the same command executes it and reads isReleased and the router weights back.
                     --row release-receipt --receipt-id 0x<bytes32> is refused with USAGE once RouterGovernance holds the receipt's RECEIPT_RELEASER_ROLE (the narrow release role, issue 1888;
                     before it, ADMIN_ROLE since issue 1698): the timelock cannot release directly and a release alone would burn the receipt, so use --row apply-receipt (issue 1831).
                     --row clear-voted-weights (no other argument) clears the router's ACTIVE (applied receipt) weight vector (issue 1743): ONE timelock call, RouterGovernance.clearVotedWeights(),
                     so routing falls back to the default vector: the emergency lever. Refused (nothing scheduled) when no active vector is in effect. Production and rehearsal, never part of stage 13.
                     --row retire-vault --admin-arg vault=0x<address> --admin-arg weights=USDC:9500,PROTO:500,RWA:0 (issue 1912, ADR-0017) retires one vault of the live deployment, rmAGENT on
                     v0.5.0: ONE timelock batch, registry.migrateEligibility(vault, false, three legs) then registry.retire(vault). The vector must name USDC, PROTO and RWA once each and sum to
                     10000, and it must be the router's current default vector without the vault, or nothing is scheduled. The preview (the vault, the vector, each call's target and data) is logged
                     before the schedule. The vault becomes withdraw-only (ADR-0009): redeem and redeemInKind stay open, deposit reverts. Production and rehearsal, never part of stage 13.
                     --row set-unwind-guard --admin-arg vault=PROTO|RWA --admin-arg token=0x<address>|all --admin-arg min-usdc-out=N --admin-arg max-loss-bps=N
                     [--admin-arg override-allowed=true|false] (QA plan v1 D7) sets a basket vault's emergency unwind guard: ONE timelock operation, BasketVault.setEmergencyUnwindGuard(token,
                     minUsdcOut, overrideAllowed, maxLossBps) for the one token or for every active asset (all). min-usdc-out is USDC (6 decimals) for the vault's whole balance of the token,
                     above zero; override-allowed defaults to true (Safe-only, issue 1705 Q2). Refused (nothing scheduled) for a token that is not an active asset; a guard already in effect is
                     recorded as skipped. Production and rehearsal, never part of stage 13. The stage 12 verifier requires it on every active asset of an open basket: run it with the unpauses.
                     --row register-submitter --submitter 0x<the submitter Safe> registers the consensus receipt submitter (issue 1888): the Safe, through the timelock, schedules ONE delayed call,
                     ConsensusRecommendationReceipt.grantRole(RECEIPT_SUBMITTER_ROLE, submitter). Pre-checks run before it is scheduled: the submitter is a canonical SafeL2 1.4.1 multisig (threshold 2 or more,
                     no module, no guard) that is not the timelock or a deployment role address, the timelock administers the role, and the Safe does not hold it yet. The submitter MAY be the governing Safe
                     and its owners may be shared. Every chain and kind. Not part of stage 13. Same two-step wait as every on-demand row.
                      --row safe-add-owner|safe-remove-owner|safe-swap-owner|safe-change-threshold|timelock-grant-role|timelock-revoke-role --admin-arg K=V (Twin chain 918453 only, refused on 8453) runs a Safe or timelock self-administration row (issue 1645):
                      the four safe-* rows are one Safe transaction to the Safe, the two timelock-* rows are a Safe -> Timelock round. Keys: owner, old-owner, new-owner, threshold, role, account.
                     In a REHEARSAL (sheet DEPLOYMENT_KIND=rehearsal) update-delay, batch and cancel also run on 8453, as explicit --row runs after the unpauses, in that order.
                     --row redeploy-vault (no other argument) replaces the vault the redeploy-vault verb deployed (issue 1796): ONE timelock batch of six calls, registry.registerVault(new),
                     router.setVaultCap(new, the old vault's approved cap), registry.migrateEligibility(new, true, five legs), registry.migrateEligibility(old, false, four legs), registry.retire(old),
                     new.unpauseDeposits(). The old vault keeps its shares, redeem and redeemInKind. Rehearsal (DEPLOYMENT_KIND=rehearsal) and Twin only, refused
                     on 8453 in production. Refused (nothing scheduled) unless the old vault is Active and router-eligible, no voted vector is active and the new vault is the closed, linked, timelock-governed one the verb left.
                     --core-sha is the round's core_sha (the sha the verb ran at) or the original deployment sha: neither needs a frozen counts file of its own (QA plan v1 E1).
                     --row freeze-upgrades (no other argument, issue 1842) freezes every unfrozen core proxy: ONE timelock batch of freezeUpgrades(implementation, implementation_code_hash), both
                     taken from the latest deployments/<chain>/upgradeability.json (run verify first). Prints a preview per proxy. Refused (nothing scheduled) while an upgrade operation is
                     pending on the timelock, or when the record is stale. Production and rehearsal, never part of stage 13. Run verify after it.
                     --row upgrade-proxy --proxy NAME --implementation 0x<address> [--upgrade-build DIR] [--migration NAME] (issue 1842) upgrades one core proxy: ONE timelock call, upgradeToAndCall(new, "")
                     or, with a typed --migration, upgradeToAndCall(new, <the migration's calldata>).
                     Refused (nothing scheduled) when the proxy is frozen, when the new implementation's storage layout snapshot (DIR, default the DEPLOY_SHA checkout) does not extend the
                     deployed one append-only, or when its runtime code is not DIR/out's build. After the execute it rewrites the proxy's stage manifest implementation fields. Run verify after it.
  --proxy NAME       govern --row upgrade-proxy and deploy-implementation: the verifier name of the proxy (gateway, registry, router, governance, receipt, vault[rmUSDC], ...).
  --implementation A govern --row upgrade-proxy only: the new implementation, already deployed (linked to the live libraries): the address deploy-implementation printed.
  --migration NAME   govern --row upgrade-proxy only (issue 1910): a typed migration run in the same upgradeToAndCall. The only name is receipt-submitter-roles, valid for --proxy receipt: the tool
                     builds migrateToSubmitterRoles(releaser) from DIR/out's ABI with the RouterGovernance address of the governance manifest. There is no raw data option on 8453.
  --upgrade-build D  govern --row upgrade-proxy and deploy-implementation: a core checkout at the commit the new implementation was built from, after forge build. Default: the DEPLOY_SHA checkout.
  --vault KEY        redeploy-vault only: the vault to redeploy. PROTO is the only one.
  --prior-out DIR    verify, after a redeploy: the forge out/ directory of a git checkout built at the ORIGINAL deployment sha (its HEAD must be that sha). Every contract the redeploy did not replace
                     (core, libraries, adapters, the other vaults, the retired one) runs the code of that build, so its code hash is compared with it; the replacing vault is compared with the
                     build of the --core-sha checkout. After a round deployed at another sha (QA plan v1 E1) the verify runs ALONE at --core-sha <the round's core_sha> WITH --prior-out: at the
                     original sha, or without --prior-out, it is refused (USAGE) before any signer, so it never fails and pauses the three vaults. The counts are the original sha's (its frozen
                     file in the counts dir, else the run manifest's per-stage counts): no frozen file for the redeploy sha.
  --receipt-id ID    govern with --row release-receipt or --row apply-receipt, and the record-receipt verb: the bytes32 receipt id.
  --payload-digest D record-receipt only: the bytes32 payload_digest of 'rmpc receipt verify' = keccak256("robotmoney:consensus-receipt:v1\n" + the canonical receipt bytes). A plain keccak256 of the served canonical file is WRONG.
  --payload-uri URL  record-receipt only: the public route that serves exactly those bytes.
  --submitter ADDR   govern --row register-submitter and the record-receipt verb: the consensus receipt SUBMITTER Safe, a SafeL2 1.4.1 multisig (threshold 2 or more, no module, no guard). It may be the governing Safe.
                     record-receipt: required on every chain; --signer is the gas payer and --owner-signer names the submitter Safe's owners (enough to reach its threshold).
  --payload FILE     govern with --row apply-receipt (required), or record-receipt (required, checked before any signer is built): the receipt payload file as served by the canonical route. Its receipt digest (domain line + bytes) is the anchored payloadDigest.
  --system S         vaults (default) | gateway (issue 1892): the independent system to deploy and verify. gateway runs the stages gateway and gateway-handover against the vaults system's
                     manifests, with its own small sheet (GATEWAY_ADMIN_ADDRESS and GATEWAY_UPGRADE_TIMELOCK, no default, no AGENT_ name, no Safe), its own --evidence directory and its own
                     verifier. Only publish and verify run in it (docs/operations/contract-release-runbooks.md 4.13).
  --stage S          plan | deploy | all | a comma list of stage names (default: everything through verify)
                     The stage names come from core's scripts/deploy/stage-table.json at the DEPLOY_SHA, plus safe, verify and govern.
  --resume           continue a run: adopt the existing Safe, skip finished stages; prove-control also adopts a proof that landed on chain before the run died (nothing is sent again)
  --dry-run          the preflight: run every check and simulate EVERY deployer stage in order on a blank local anvil it starts itself
                     (no fork). Nothing is broadcast, nothing is sent to --rpc, the checkout is left as found.
  --core-dir DIR     core checkout (default: the repo root that holds scripts/deploy/stage-table.json, found by walking up; use it only for a checkout elsewhere)
  --evidence DIR     evidence directory (run manifest, isomorphism report)
  --counts-dir DIR   frozen counts directory (default: deployments/frozen-counts in the working directory if present, else this repo's). On 8453 the plan and every run that can
                     broadcast (publish, a deployer stage, safe, prove-control, govern, redeploy-vault) pass the release gate first (issue 1816): <sha>.json must be committed and clean in its git work
                     tree (COUNTS_UNTRACKED); a reconstructed baseline needs the stricter clean-checkout proof of issue 1740 (COUNTS_MISSING).
  --counts-require-origin-dev  8453, reconstructed baseline: also refuse unless HEAD of the counts checkout is reachable from its local origin/dev (git fetch origin dev first). Required by the release runbook.
  --measure          rehearsal only: measure per-stage counts and write the frozen file for this SHA
  --logs-rpc URL     prove-control --resume and the verify stage: a separate RPC for eth_getLogs (the scan for a landed proof, the verifier's role and
                     creation scans). Every other read stays on --rpc.
  --logs-window N    prove-control --resume and the verify stage: blocks per eth_getLogs call (default 2000); prove-control halves it on a range-limit error,
                     verify shrinks it to the limit the RPC names. Verify reads each block range once for all its log checks (issue 1977).
  --check-sources    verify: also check explorer source verification (Blockscout, Sourcify); publishing, not a gate, so off by default
  --logs-tries N     prove-control --resume: tries of one throttled eth_getLogs call (HTTP 429), with exponential backoff (default 6)
  --owner-signer S   prove-control and govern: a Safe owner signer spec (repeat for each owner: prove-control needs EVERY owner, govern the threshold). On chain 918453 with none given: the SAFE_OWNER_A/B/C keystores
                     beside the DEPLOYER keystore, under the same passphrase file (the rehearsal key layout). Never on 8453: there every owner is named, as keystore:PATH (passphrase typed at the hidden
                     prompt) or a device bound to its owner, ledger:PATH@0xOWNER / trezor:PATH@0xOWNER. Hardware is optional, never required. A run on 8453 that reaches prove-control with fewer
                     specs than the sheet has owners, the same spec twice, two specs claiming one owner, or a spec claiming an address outside SAFE_OWNERS is refused before stage 1 (exit 24).
  --emergency-signer S  pause-all, and the automatic pause after a failed verify: the EMERGENCY key signer spec, needed once the handover has begun. On the Twin chain with none given: the EMERGENCY keystore beside the DEPLOYER keystore. Never defaulted on mainnet.
  --compare-sheet F  a second sheet for the sheet diff in the isomorphism report
  --call-label L --call-target ADDR --call-data 0x..   govern, Twin chain 918453 only (refused on 8453): one generic Safe -> Timelock call (schedule, wait by warp, execute),
                     for test fixtures whose action is not a mainnet govern row. Not combined with --row.
  --max-wait SECONDS govern: longest timelock wait this process accepts (default 3600)
  --no-warp          govern, Twin chain only: no time warp, the wait is real and a wait over --max-wait exits 15 (GOVERN_PENDING) as on 8453 (the Twin upgrade rehearsal
                     queues an upgrade between the freeze schedule and its execute this way, issue 1859)
Aliases: --chain-id for --chain, --deploy-sha for --core-sha.
Environment: PUBLISH_MANIFEST_DIR names the manifest directory (stage manifests are written and read there, not in the core checkout).
Govern prints one JSON line per round event on stdout: {"row":"...","phase":"scheduled|executed|cancelled","txHash":"0x...","status":1,"readyAt":1700000000}. Logs are JSON on stderr.`;

export interface CliDeps {
  run?: ProcessRunner;
  env?: Record<string, string | undefined>;
  logSink?: (line: string) => void;
  prompt?: (q: string) => Promise<string>;
  cwd?: string;
  makeSigner?: (spec: string) => PublishSigner;
  ownerSigner?: (spec: string) => Promise<Signer>;
  /** Tests: the cast runner behind hardware owner signers. */
  castRunner?: CastRunner;
  safeApi?: RunContext["safeApi"];
  govern?: Partial<GovernOpts>;
  /** Test seam: the Safe tool calls behind the prove-control step (default: the real ones). */
  prove?: Partial<ProveOpts>;
  /** Test seam: the verifier behind the verify stage (default: the real one, labels on stdout). */
  verify?: Partial<VerifyDeps>;
  /** Test seam: the pause-all behind the automatic pause on a failed verify and the pause-all verb (default: the real one). */
  pauseAll?: typeof pauseAll;
  /** Test seam: the read-only chain reader behind the config-check that runs before each vault stage. */
  chainReader?: RunContext["chainReader"];
  /** Test seam (issue 1723, QA plan v1 E6): the sleep and the bound of the reads after a landed transaction. Default: the shared read-after-write bound. */
  readRetry?: RunContext["readRetry"];
  /** Test seam: core's own config-check (bun scripts/ci/config-check.ts, read-only against live Base). Default: the real spawn. */
  coreConfigCheck?: CoreConfigCheck;
  /** Test seam only: the pinned FiatTokenProxy code hash. Production uses the pin in usdc.ts. */
  usdcCodeHash?: string;
  /** Test seams: the contracts-freeze gate of the 8453 plan job (core 1524): the release tag read and check-sha-green. Defaults: the real ones. */
  releaseTag?: (coreDir: string, sha: string) => Promise<string | null>;
  releaseTags?: (coreDir: string, sha: string) => Promise<string[]>;
  checkShaGreen?: CheckShaGreen;
  remoteTag?: (coreDir: string, tag: string) => Promise<void>;
  /** Test seam (review-security-001, issue 1927): the rc commit of --upgrade-build is on origin's releases-A.B.x. Default: git merge-base --is-ancestor. */
  rcOnReleaseBranch?: (dir: string, sha: string, branch: string) => Promise<boolean>;
  /** Test seam (review-security-003): the tracked paths of the --upgrade-build checkout. Default: git ls-files --recurse-submodules. */
  trackedFiles?: (dir: string, paths: string[]) => Promise<Set<string>>;
  /** Test seam (review-security-004): the --upgrade-build checkout's foundry config. Default: forge config --json there, FOUNDRY_ variables scrubbed. */
  forgeConfig?: (dir: string) => Promise<import("./release-gate.ts").ForgeBuildConfig>;
  /** Test seam (issue 1733): the plan-time re-verification of a reconstructed baseline against the build and the chain. Default: rebuild the libraries from the checkout and read their code with cast. */
  verifyReconstructed?: (file: FrozenFile) => Promise<void>;
  /** Test seam (issue 1861): the whole `deploy-implementation` verb. Default: the real one (runDeployImplementation). */
  deployImplementation?: typeof runDeployImplementation;
  /** Test seam (issue 1796): the whole `redeploy-vault` verb. Default: the real one (runRedeployVault). */
  redeployVault?: typeof runRedeployVault;
  /** Test seams (issue 1733): the proof that the anchor file is committed, and the sleep between the retries of a rate-limited `cast code`. */
  anchorCommitted?: (anchorPath: string, expectedHash: string) => Promise<void>;
  frozenDirCommitted?: (countsDir: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Test seams for the record-receipt verb: the whole step, or only its chain reads and send. */
  recordReceipt?: typeof recordReceipt;
  recordApi?: RecordApi;
  /** Test seam: the blank local chain a --dry-run simulates on. Default: anvil, when installed. */
  startChain?: ChainStarter;
  /** Test seam (qa-plan B2): the Actions-only proof behind CONFIRM=environment on 8453. Default: fetch and verify the job's GitHub OIDC token. */
  actionsProof?: typeof proveActions;
}

export interface Parsed {
  /** Issue 1892: the system this run deploys and verifies. Default vaults. The gateway system has its own sheet, stages, evidence and verifier. */
  system: SystemName;
  chain: number; rpc: string; sheet: string; signer?: string; environment: string; coreSha: string; stage?: string; resume: boolean; dryRun: boolean;
  verb?: Verb; row?: string; coreDir?: string; evidence?: string; countsDir?: string; countsRequireOriginDev?: boolean; measure: boolean; ownerSigners: string[]; emergencySigner?: string; compareSheet?: string; maxWait?: number; noWarp: boolean; call?: { label: string; target: string; data: string };
  /** With --row release-receipt or --row apply-receipt: the receipt. */
  receiptId?: string;
  /** With --row apply-receipt only: the receipt payload file. */
  payload?: string;
  /** With --row register-submitter and the record-receipt verb: the submitter Safe. */
  submitter?: string;
  /** record-receipt only. */
  payloadDigest?: string;
  payloadUri?: string;
  /** With a self-administration row or --row set-unwind-guard (QA plan v1 D7) only: the key=value pairs of --admin-arg. */
  adminArgs?: Record<string, string>;
  /** redeploy-vault only: the vault key. */
  vault?: string;
  /** verify only (issue 1796): forge out/ of a checkout at the original deployment sha. */
  priorOut?: string;
  /** prove-control --resume (issue 1724): --logs-rpc, --logs-window, --logs-tries. Absent when none is given. */
  logs?: LogScanOpts;
  /** --check-sources: the verify stage also checks explorer source verification. */
  checkSources?: boolean;
  /** With --row upgrade-proxy only (issue 1842): the proxy name, the new implementation and the core checkout it was built from. */
  proxy?: string;
  implementation?: string;
  upgradeBuild?: string;
  migration?: string;
}

export function parseCli(argv: string[]): Parsed {
  let v: ReturnType<typeof parseArgs>["values"];
  let positionals: string[];
  try {
    ({ values: v, positionals } = parseArgs({
      args: argv, strict: true, allowPositionals: true,
      options: {
        chain: { type: "string" }, "chain-id": { type: "string" }, rpc: { type: "string" }, sheet: { type: "string" }, signer: { type: "string" },
        environment: { type: "string" }, "core-sha": { type: "string" }, "deploy-sha": { type: "string" }, stage: { type: "string" }, row: { type: "string" },
        resume: { type: "boolean" }, "dry-run": { type: "boolean" }, "core-dir": { type: "string" }, evidence: { type: "string" }, "counts-dir": { type: "string" }, "counts-require-origin-dev": { type: "boolean" }, system: { type: "string" },
        measure: { type: "boolean" }, "owner-signer": { type: "string", multiple: true }, "emergency-signer": { type: "string" }, "compare-sheet": { type: "string" }, "max-wait": { type: "string" }, "no-warp": { type: "boolean" }, "call-label": { type: "string" }, "call-target": { type: "string" }, "call-data": { type: "string" }, "receipt-id": { type: "string" }, "admin-arg": { type: "string", multiple: true }, payload: { type: "string" }, submitter: { type: "string" }, "payload-digest": { type: "string" }, "payload-uri": { type: "string" }, vault: { type: "string" }, "prior-out": { type: "string" }, "logs-rpc": { type: "string" }, "check-sources": { type: "boolean" }, "logs-window": { type: "string" }, "logs-tries": { type: "string" }, proxy: { type: "string" }, implementation: { type: "string" }, "upgrade-build": { type: "string" }, migration: { type: "string" }, help: { type: "boolean" },
      },
    }));
  } catch (e) { throw new PublishError("USAGE", `${(e as Error).message}\n${USAGE}`); }
  if (v.help) throw new PublishError("USAGE", USAGE);
  if (positionals.length > 1) throw new PublishError("USAGE", `one verb at most, got '${positionals.join(" ")}'\n${USAGE}`);
  const verb = positionals[0] as Verb | undefined;
  if (verb !== undefined && !VERBS.includes(verb)) throw new PublishError("USAGE", `unknown verb '${verb}' (${VERBS.join(", ")})\n${USAGE}`);
  if (verb !== undefined && v.stage !== undefined) throw new PublishError("USAGE", `give a verb or --stage, not both\n${USAGE}`);
  const chainRaw = (v.chain ?? v["chain-id"]) as string | undefined;
  const sha = (v["core-sha"] ?? v["deploy-sha"]) as string | undefined;
  const need = (n: string, x: unknown) => { if (x === undefined || x === "") throw new PublishError("USAGE", `missing --${n}\n${USAGE}`); };
  need("chain", chainRaw); need("rpc", v.rpc); need("sheet", v.sheet); need("core-sha", sha);
  if (!/^[0-9]+$/.test(chainRaw!)) throw new PublishError("USAGE", `--chain must be a chain id, got '${chainRaw}'`);
  const stage = v.stage as string | undefined;
  const row = v.row as string | undefined;
  // Issue 1892: --system picks the independent system. The default is the vaults system. The gateway system deploys, hands over and verifies the gateway and has no govern row,
  // no receipt and no vault verb: its production governance is an open decision (architecture 10).
  const system = (v.system as string | undefined) ?? "vaults";
  if (!(SYSTEM_NAMES as readonly string[]).includes(system)) throw new PublishError("USAGE", `--system must be ${SYSTEM_NAMES.join(" or ")}, got '${system}'\n${USAGE}`);
  if (system === "gateway" && verb !== undefined && verb !== "publish" && verb !== "verify") throw new PublishError("USAGE", `the ${verb} verb belongs to the vaults system: the gateway system runs publish and verify only (--system gateway)\n${USAGE}`);
  if (row !== undefined && row === "") throw new PublishError("USAGE", `--row needs a number or a name\n${USAGE}`);
  if (row !== undefined) {
    const stageNames = verb === undefined ? stage : undefined;
    if (!(verb === "govern" || stageNames === "govern")) throw new PublishError("USAGE", `--row applies to the govern verb (or --stage govern) only\n${USAGE}`);
    // An unknown row fails here, before any work. Whether update-delay, batch and cancel may run on 8453 depends on the sheet's DEPLOYMENT_KIND, so runGovern decides that.
    if (isSelfAdminRow(row)) assertSelfAdminAllowed(Number(chainRaw), row);
    else if (row !== RECEIPT_ROW && row !== APPLY_ROW && row !== REGISTER_ROW && row !== CLEAR_ROW && row !== RETIRE_ROW && row !== REDEPLOY_ROW && row !== UNWIND_GUARD_ROW && row !== FREEZE_ROW && row !== UPGRADE_ROW) resolveGovernRow(row);
  }
  const vaultArg = v.vault as string | undefined;
  if (verb === REDEPLOY_VERB) {
    if (vaultArg === undefined) throw new PublishError("USAGE", `${REDEPLOY_VERB} needs --vault ${REDEPLOY_KEYS.join("|")}\n${USAGE}`);
    if (!isRedeployKey(vaultArg)) throw new PublishError("USAGE", `--vault '${vaultArg}' cannot be redeployed: only ${REDEPLOY_KEYS.join(", ")}\n${USAGE}`);
  } else if (vaultArg !== undefined) throw new PublishError("USAGE", `--vault goes with the ${REDEPLOY_VERB} verb only\n${USAGE}`);
  const priorOut = v["prior-out"] as string | undefined;
  // --prior-out is read by the verify stage only: a run whose stages include verify (the verify verb, the default set, all, or a --stage list naming verify; QA plan v1 E1).
  const reachesVerify = verb === "verify" || (verb === undefined && (stage === undefined || stage === "all" || stage.split(",").map((x) => x.trim()).includes("verify")));
  if (priorOut !== undefined && !reachesVerify) throw new PublishError("USAGE", `--prior-out goes with the verify verb (or --stage verify) only\n${USAGE}`);
  const receiptIdRaw = v["receipt-id"] as string | undefined;
  let receiptId: string | undefined;
  const submitter = v.submitter as string | undefined;
  if (row === REGISTER_ROW) assertSubmitter(submitter);
  else if (verb === "record-receipt") { if (submitter === undefined) throw new PublishError("USAGE", `record-receipt needs --submitter <the submitter Safe> and the --owner-signer of its owners: the receipt submitter is a Safe on every chain, never a single key. Nothing sent.\n${USAGE}`); assertSubmitter(submitter); } // issue 1888
  else if (submitter !== undefined) throw new PublishError("USAGE", `--submitter goes with --row ${REGISTER_ROW} (or the record-receipt verb) only\n${USAGE}`);
  const payloadDigest = v["payload-digest"] as string | undefined;
  const payloadUri = v["payload-uri"] as string | undefined;
  if (verb === "record-receipt") {
    if ((v.payload as string | undefined) === undefined) throw new PublishError("USAGE", `record-receipt needs --payload FILE: the exact served receipt bytes (already verified with 'rmpc receipt verify'). Nothing sent.\n${USAGE}`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(receiptIdRaw ?? "")) throw new PublishError("USAGE", `--receipt-id must be a 0x-prefixed bytes32\n${USAGE}`);
  }
  else if (payloadDigest !== undefined || payloadUri !== undefined) throw new PublishError("USAGE", `--payload-digest and --payload-uri go with the record-receipt verb only\n${USAGE}`);
  if (row === RECEIPT_ROW && receiptIdRaw === undefined) throw new PublishError("USAGE", `--row ${RECEIPT_ROW} needs --receipt-id 0x<bytes32>\n${USAGE}`);
  if (row === APPLY_ROW && receiptIdRaw === undefined) throw new PublishError("USAGE", `--row ${APPLY_ROW} needs --receipt-id 0x<bytes32> and --payload FILE\n${USAGE}`);
  if (receiptIdRaw !== undefined && verb !== "record-receipt") {
    if (row !== RECEIPT_ROW && row !== APPLY_ROW) throw new PublishError("USAGE", `--receipt-id goes with --row ${RECEIPT_ROW} only (or --row ${APPLY_ROW})\n${USAGE}`);
    receiptId = assertReceiptId(receiptIdRaw);
  }
  const payload = v.payload as string | undefined;
  if (row === APPLY_ROW && payload === undefined) throw new PublishError("USAGE", `--row ${APPLY_ROW} needs --payload FILE\n${USAGE}`);
  if (payload !== undefined && row !== APPLY_ROW && verb !== "record-receipt") throw new PublishError("USAGE", `--payload goes with --row ${APPLY_ROW} only (or the record-receipt verb)\n${USAGE}`);
  if (v["no-warp"] && verb !== "govern") throw new PublishError("USAGE", `--no-warp goes with the govern verb only\n${USAGE}`);
  // issue 1842: the governed upgrade row's arguments
  const proxy = v.proxy as string | undefined, implementation = v.implementation as string | undefined, upgradeBuild = v["upgrade-build"] as string | undefined, migration = v.migration as string | undefined;
  if (migration !== undefined && row !== UPGRADE_ROW) throw new PublishError("USAGE", `--migration goes with --row ${UPGRADE_ROW} only\n${USAGE}`);
  if (row === UPGRADE_ROW && (proxy === undefined || implementation === undefined)) throw new PublishError("USAGE", `--row ${UPGRADE_ROW} needs --proxy NAME and --implementation 0x<address>\n${USAGE}`);
  if (verb === DEPLOY_IMPL_VERB) {
    if (proxy === undefined) throw new PublishError("USAGE", `${DEPLOY_IMPL_VERB} needs --proxy NAME\n${USAGE}`);
    if (implementation !== undefined) throw new PublishError("USAGE", `${DEPLOY_IMPL_VERB} deploys the implementation: --implementation goes with govern --row ${UPGRADE_ROW} only\n${USAGE}`);
    if (v["dry-run"]) throw new PublishError("USAGE", `${DEPLOY_IMPL_VERB} has no --dry-run: every check runs before its one send, and a refusal sends nothing\n${USAGE}`);
  } else if ((proxy !== undefined || implementation !== undefined || upgradeBuild !== undefined) && row !== UPGRADE_ROW) throw new PublishError("USAGE", `--proxy, --implementation and --upgrade-build go with --row ${UPGRADE_ROW} (or the ${DEPLOY_IMPL_VERB} verb) only\n${USAGE}`);
  if (implementation !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(implementation)) throw new PublishError("USAGE", `--implementation must be an address, got '${implementation}'`);
  let adminArgs: Record<string, string> | undefined;
  const adminRaw = v["admin-arg"] as string[] | undefined;
  if (adminRaw !== undefined && row === UNWIND_GUARD_ROW) {
    // QA plan v1 D7: the row's own keys. They are checked here, before any signer or passphrase prompt.
    adminArgs = {};
    for (const kv of adminRaw) {
      const m = /^([a-z-]+)=(.+)$/.exec(kv);
      if (!m || !(UNWIND_GUARD_KEYS as readonly string[]).includes(m[1]!)) throw new PublishError("USAGE", `--row ${UNWIND_GUARD_ROW}: --admin-arg takes key=value with key ${UNWIND_GUARD_KEYS.join(", ")}, got '${kv}'`);
      adminArgs[m[1]!] = m[2]!;
    }
    parseUnwindGuardArgs(adminArgs);
  } else if (adminRaw !== undefined && row === RETIRE_ROW) {
    // Issue 1912: the retire row's own keys, checked here before any signer or passphrase prompt. The vector must be exactly three legs summing to 10000.
    adminArgs = {};
    for (const kv of adminRaw) {
      const m = /^([a-z-]+)=(.+)$/.exec(kv);
      if (!m || !(RETIRE_KEYS as readonly string[]).includes(m[1]!)) throw new PublishError("USAGE", `--row ${RETIRE_ROW}: --admin-arg takes key=value with key ${RETIRE_KEYS.join(", ")}, got '${kv}'`);
      adminArgs[m[1]!] = m[2]!;
    }
    parseRetireArgs(adminArgs);
  } else if (adminRaw !== undefined) {
    if (row === undefined || !isSelfAdminRow(row)) throw new PublishError("USAGE", `--admin-arg goes with a self-administration row (${SELF_ADMIN_ROWS.join(", ")}) or --row ${UNWIND_GUARD_ROW} or --row ${RETIRE_ROW} only\n${USAGE}`);
    adminArgs = {};
    for (const kv of adminRaw) {
      const m = /^(owner|old-owner|new-owner|threshold|role|account)=(.+)$/.exec(kv);
      if (!m) throw new PublishError("USAGE", `--admin-arg takes key=value with key owner, old-owner, new-owner, threshold, role or account, got '${kv}'`);
      adminArgs[m[1]!] = m[2]!;
    }
  } else if (row === UNWIND_GUARD_ROW) parseUnwindGuardArgs(undefined); // USAGE: the row needs its --admin-arg values
  else if (row === RETIRE_ROW) parseRetireArgs(undefined); // USAGE: the row needs its --admin-arg values
  let call: Parsed["call"];
  if (v["call-label"] !== undefined || v["call-target"] !== undefined || v["call-data"] !== undefined) {
    if (!(verb === "govern" || stage === "govern")) throw new PublishError("USAGE", `--call-label, --call-target and --call-data apply to the govern verb only\n${USAGE}`);
    if (row !== undefined) throw new PublishError("USAGE", `--row and the --call-* options are mutually exclusive\n${USAGE}`);
    const label = v["call-label"] as string | undefined, target = v["call-target"] as string | undefined, data = v["call-data"] as string | undefined;
    if (!label || !target || !data) throw new PublishError("USAGE", `--call-label, --call-target and --call-data go together\n${USAGE}`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(target)) throw new PublishError("USAGE", `--call-target must be an address, got '${target}'`);
    if (!/^0x([0-9a-fA-F]{2})+$/.test(data)) throw new PublishError("USAGE", "--call-data must be 0x-prefixed hex calldata");
    call = { label, target, data };
  }
  for (const s of (v["owner-signer"] as string[] | undefined) ?? []) {
    if (isHardwareSpecLike(s) && !parseOwnerHardwareSpec(s)) throw new PublishError("USAGE", `bad --owner-signer '${s}': a hardware owner is ledger:PATH@0xOWNER or trezor:PATH@0xOWNER (PATH like m/44'/60'/0'/0/0)\n${USAGE}`);
  }
  if (stage !== "plan") need("signer", v.signer); // for record-receipt it is the submitter
  if (!/^https?:\/\//.test(v.rpc as string)) throw new PublishError("USAGE", "--rpc must be an http(s) URL");
  let logs: LogScanOpts | undefined;
  if (v["logs-rpc"] !== undefined || v["logs-window"] !== undefined || v["logs-tries"] !== undefined) {
    const count = (n: string): number | undefined => {
      const x = v[n] as string | undefined;
      if (x === undefined) return undefined;
      if (!/^[1-9][0-9]*$/.test(x)) throw new PublishError("USAGE", `--${n} must be a positive integer, got '${x}'`);
      return Number(x);
    };
    const logsRpc = v["logs-rpc"] as string | undefined;
    if (logsRpc !== undefined && !/^https?:\/\//.test(logsRpc)) throw new PublishError("USAGE", "--logs-rpc must be an http(s) URL");
    const window = count("logs-window");
    logs = { logsRpc, window: window === undefined ? undefined : BigInt(window), tries: count("logs-tries") };
  }
  return {
    system: system as SystemName, chain: Number(chainRaw), rpc: v.rpc as string, sheet: v.sheet as string, signer: v.signer as string | undefined, environment: (v.environment as string | undefined) ?? "local",
    checkSources: !!v["check-sources"], coreSha: assertSha(sha!), stage, verb, row, resume: !!v.resume || verb === "verify" || verb === "govern", dryRun: !!v["dry-run"], coreDir: v["core-dir"] as string | undefined, evidence: v.evidence as string | undefined,
    countsDir: v["counts-dir"] as string | undefined, countsRequireOriginDev: !!v["counts-require-origin-dev"], measure: !!v.measure, ownerSigners: (v["owner-signer"] as string[] | undefined) ?? [], emergencySigner: v["emergency-signer"] as string | undefined, compareSheet: v["compare-sheet"] as string | undefined,
    maxWait: v["max-wait"] ? Number(v["max-wait"]) : undefined, noWarp: !!v["no-warp"], call, receiptId: verb === "record-receipt" ? receiptIdRaw : receiptId, payload, submitter, payloadDigest, payloadUri, adminArgs, vault: vaultArg, priorOut, logs, proxy, implementation, migration, upgradeBuild: upgradeBuild === undefined ? undefined : resolve(upgradeBuild),
  };
}

/** The verb to stage names: publish = every deployer stage through timelock, verify = verify, govern = govern. */
export function selectVerbStages(verb: Verb): string[] {
  if (verb === "publish") return STAGE_NAMES.slice(0, STAGE_NAMES.indexOf(DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1]!.name) + 1); // issue 1892: the last deployer stage of the system (timelock, or gateway-handover)
  return [verb];
}

/**
 * The owner-signer shortfall of a run on 8453, decided BEFORE stage 1 (owner decision 2026-10-14, qa-plan B1). prove-control needs a signer
 * for EVERY sheet owner (core 1618), and it runs after stages 1-10: with too few `--owner-signer` specs a publish used to broadcast those ten
 * stages and die at CONTROL_NOT_PROVEN with the deployer holding every role. So a run whose stages include prove-control is refused here,
 * with the same kind, when fewer specs than sheet owners are given. Not checked: the Twin chain (its owners default from the rehearsal keys,
 * owner-signers.ts), a dry run (it skips prove-control, runner.ts), the plan (no signer) and the verbs that have no proof stage. A govern run
 * keeps its own in-run refusal (GOVERN, before any send): it broadcasts nothing before the Safe's signature count is checked.
 * Security round 1 (review-security-031): counting was not enough. The same spec twice, two specs that claim the same owner, or a spec that claims an address outside
 * SAFE_OWNERS passed here and failed at prove-control after stages 1-10. Every claim that can be read before stage 1 (owner-signers.ts claimedOwnerOf: a device's
 * @0xOWNER, a keystore's unencrypted address; `claimOf` is the test seam) must be a sheet owner, and no owner may be claimed twice. A claim that cannot be read yet
 * is left to prove-control.
 */
export function ownerSignerShortfall(i: { chainId: number; verb?: Verb; stage?: string; dryRun: boolean; specs: string[]; sheet: Pick<Sheet, "safeOwners">; claimOf?: (spec: string) => string | undefined }): PublishError | undefined {
  if (i.chainId !== MAINNET_CHAIN_ID || i.dryRun || i.stage === "plan") return undefined;
  if (i.verb === "pause-all" || i.verb === "record-receipt" || i.verb === REDEPLOY_VERB) return undefined;
  const names = i.verb ? selectVerbStages(i.verb) : selectStages(i.stage);
  if (!names.includes(PROOF_STAGE)) return undefined;
  const have = i.specs.length, need = i.sheet.safeOwners.length;
  const pass = "Pass --owner-signer for each owner of the sheet (keystore:PATH, ledger:PATH@0xOWNER or trezor:PATH@0xOWNER).";
  if (have < need) return new PublishError("CONTROL_NOT_PROVEN", `${have} --owner-signer spec${have === 1 ? "" : "s"} for a Safe of ${need} owners: ${PROOF_STAGE} needs a signer for EVERY owner, so the run is refused before stage 1 and nothing was sent. ${pass}`, { have, need, stage: PROOF_STAGE });
  const refuse = (why: string, details: Record<string, unknown>) => new PublishError("CONTROL_NOT_PROVEN", `${why}: ${PROOF_STAGE} needs a signer for EVERY owner of the sheet exactly once, so the run is refused before stage 1 and nothing was sent. ${pass}`, { ...details, stage: PROOF_STAGE });
  const twice = i.specs.find((x, k) => i.specs.indexOf(x) !== k);
  if (twice !== undefined) return refuse(`--owner-signer ${twice} is given twice`, { spec: twice });
  const owners = new Set(i.sheet.safeOwners.map((x) => x.toLowerCase()));
  const byOwner = new Map<string, string>();
  for (const spec of i.specs) {
    const owner = (i.claimOf ?? claimedOwnerOf)(spec);
    if (owner === undefined) continue;
    if (!owners.has(owner)) return refuse(`--owner-signer ${spec} names ${owner}, which is not one of the sheet's SAFE_OWNERS`, { spec, owner });
    const other = byOwner.get(owner);
    if (other !== undefined) return refuse(`--owner-signer ${other} and ${spec} both name the owner ${owner}`, { spec, other, owner });
    byOwner.set(owner, spec);
  }
  return undefined;
}

/**
 * QA plan v1 E4 (issue 1816, review T7): the runs on 8453 that pass the release gate (release-gate.ts assertReleaseGate) before any signer exists. Before, only
 * `--stage plan` did, so a publish, prove-control or govern at an untagged sha, or with a hand-edited counts file, reached forge. Gated: the plan, and every run that
 * can broadcast: the publish verb, the default stage set, deploy, all, any stage list naming a stage other than verify (a deployer stage, safe, prove-control, govern),
 * the govern verb (every row) and the redeploy-vault verb (as before, dry run included). Not gated: the Twin chain, a --measure run (refused on 8453 by the floors), a dry
 * run of the stages (nothing is broadcast), verify alone (it reads; a failed verify's automatic pause-all must never wait on GitHub), pause-all (the emergency lever)
 * and record-receipt (it deploys and governs no contract of the sha; a Base mainnet rehearsal only). The stage table must be loaded (selectStages reads it).
 */
export function releaseGated(i: { chainId: number; verb?: Verb; stage?: string; dryRun: boolean; measure: boolean }): boolean {
  if (i.chainId !== MAINNET_CHAIN_ID || i.measure) return false;
  if (i.stage === "plan" || i.verb === REDEPLOY_VERB) return true;
  if (i.dryRun || i.verb === "pause-all" || i.verb === "record-receipt") return false;
  const names = i.verb ? selectVerbStages(i.verb) : selectStages(i.stage);
  return names.some((n) => n !== "verify");
}

/** `--stage` to stage names. Default: everything through verify. govern is explicit (or `all`). */
export function selectStages(stage: string | undefined): string[] {
  const through = (last: string) => STAGE_NAMES.slice(0, STAGE_NAMES.indexOf(last) + 1);
  if (stage === undefined) return through("verify");
  if (stage === "all") return [...STAGE_NAMES];
  if (stage === "deploy") return through(DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1]!.name);
  const names = stage.split(",").map((s) => s.trim());
  for (const n of names) if (!STAGE_NAMES.includes(n)) throw new PublishError("USAGE", `unknown stage '${n}' (${STAGE_NAMES.join(", ")}, plan, deploy, all)`);
  return names;
}

const ttyPrompt = (q: string): Promise<string> => new Promise((res) => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.question(q, (a) => { rl.close(); res(a); });
});

/** No --core-dir: the repo root, found by walking up from the working directory, else from this package (publish-contracts lives inside core). */
export function defaultCoreDir(cwd: string): string {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, TABLE_REL))) return d;
    if (dirname(d) === d) break;
  }
  for (let d = import.meta.dir; ; d = dirname(d)) {
    if (existsSync(join(d, TABLE_REL))) return d;
    if (dirname(d) === d) break;
  }
  return resolve(import.meta.dir, "..", "..");
}

/** QA plan v1 E1: the HEAD sha of the git checkout that holds `dir` (the build --prior-out names), found by walking up from it. Undefined outside a git checkout. */
export function checkoutShaOf(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return readGitHead(d);
    if (dirname(d) === d) return undefined;
  }
}

/** No --counts-dir: deployments/frozen-counts under the working directory when it has one, else this repo's own (the caller may run from core). */
export function defaultCountsDir(cwd: string): string {
  const here = resolve(cwd, FROZEN_DIR);
  return existsSync(here) ? here : resolve(import.meta.dir, "..", "..", FROZEN_DIR);
}

/**
 * Core 1619: stage 12 (verify) or the postflight failed. Pause deposits on all three vaults, then hand back the error the run fails with:
 * the original failure when every vault reads paused, else a PAUSE error that names the vaults still open.
 */
async function pauseOnFailure(ctx: RunContext, trigger: PauseTrigger, cause: unknown, emergency: () => PublishSigner | undefined, pause: typeof pauseAll = pauseAll): Promise<unknown> {
  const reason = (cause as Error).message ?? String(cause);
  ctx.log.log("error", "pause_all.auto", { trigger, reason });
  try {
    const manifest = loadRunManifest(ctx.evidenceDir);
    if (!manifest) throw new PublishError("RESUME", `no run manifest in ${ctx.evidenceDir}`);
    const report = await pause(ctx, manifest, { trigger, reason, emergencySigner: emergency() });
    if (report.allPaused && report.manifestRecorded === false) return pauseUnrecorded(report, `${reason}. `);
    return report.allPaused ? cause : pauseIncomplete(report, `${reason}. `);
  } catch (e) {
    if (isPublishError(e, "PAUSE")) return e;
    return new PublishError("PAUSE", `${reason}. pause-all could not run: ${(e as Error).message}. Run 'pause-all' by hand now.`);
  }
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log: Logger = publishLogger(deps.logSink);
  const run = deps.run ?? spawnTool;
  let signer: PublishSigner | undefined;
  let stageState: ReturnType<typeof peekStageState> | undefined;
  const extraSigners: PublishSigner[] = [];
  try {
    const a = parseCli(argv);
    const cwd = deps.cwd ?? process.cwd();
    const caller = callerInputs(env);
    // Issue 1833: a follow-on verb (pause-all above all) drops an old sheet's VAULT_NAME line with one warning; a deploy run refuses it.
    const sheetOpts = { system: a.system, verb: a.verb ?? (a.stage === "verify" || a.stage === "govern" ? a.stage : undefined), warn: (message: string, fields: Record<string, unknown>) => log.log("warn", "sheet.vault_name_ignored", { ...fields, message }) };
    const sheet = parseSheet(readFileSync(resolve(cwd, a.sheet), "utf8"), sheetOpts);
    // one chain-id source: the RPC
    const castEnv = childEnv({ baseEnv: env, rpc: a.rpc, chainId: a.chain });
    const rpcChainId = await readRpcChainId(async (args) => {
      const r = await run("cast", args, { env: castEnv });
      if (r.code !== 0) throw new PublishError("CHAIN", `cast chain-id failed: ${r.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
      return r.stdout;
    });
    if (rpcChainId !== MAINNET_CHAIN_ID && rpcChainId !== TWIN_CHAIN_ID) throw new PublishError("CHAIN", `chain ${rpcChainId} is not supported: publish contracts runs on ${TWIN_CHAIN_ID} (rehearsal) and ${MAINNET_CHAIN_ID} (mainnet)`);
    for (const spec of a.ownerSigners) assertOwnerSignerSpec(spec, { rpcChainId, rpc: a.rpc, env });
    // qa-plan B2 (DT-3): CONFIRM=environment on 8453 is accepted on one proof only, the job's GitHub OIDC token verified for --environment. It is
    // fetched HERE, before any floor or signer, and only when the runner's request token is present: a laptop with GITHUB_ACTIONS=true has none,
    // and the floor below refuses it by name. A token that does not verify is a FLOOR exit, never a skip.
    const githubActions = env.GITHUB_ACTIONS === "true";
    let actionsProof: ActionsProof | undefined;
    if (caller.confirm === "environment" && isMainnet(rpcChainId) && githubActions && env[ACTIONS_TOKEN_ENV]) {
      actionsProof = await (deps.actionsProof ?? proveActions)(env, { environment: a.environment });
      log.log("info", "run.actions_proof", { chain_id: rpcChainId, ...proofLogFields(actionsProof) });
    }
    assertFloors({ rpcChainId, rpc: a.rpc, sheet, argChainId: a.chain, caller, signerSpec: a.signer, env, environment: a.environment, githubActions, actionsProof, measure: a.measure });
    if (sheet.kind === "rehearsal") log.log("warn", "run.deployment_kind", { deployment_kind: sheet.kind, label: kindLabel(sheet.kind, sheet.timelockMinDelay), note: "a REHEARSAL with a short timelock delay: never a production deployment" });
    // A row this chain and kind refuse is refused HERE, before any signer exists: no passphrase prompt for a row that can never run (production update-delay, batch, cancel on 8453).
    const rowRefusal = govRowRefusal(a.row, rpcChainId, sheet.kind);
    if (rowRefusal !== undefined) throw new PublishError("USAGE", rowRefusal);
    // The single-vault redeploy is refused on 8453 in production HERE, before any signer or passphrase exists (issue 1796).
    if (a.verb === REDEPLOY_VERB) { const why = redeployRefusal(rpcChainId, sheet.kind); if (why !== undefined) throw new PublishError("USAGE", why); }
    // Too few owner signers for a run that reaches prove-control on 8453 is refused HERE, before any signer, forge call or stage 1 (qa-plan B1, review-security-031):
    // the proof needs every owner, and finding that out at stage 11 left stages 1-10 broadcast with the deployer holding every role.
    const shortfall = ownerSignerShortfall({ chainId: rpcChainId, verb: a.verb, stage: a.stage, dryRun: a.dryRun, specs: a.ownerSigners, sheet, claimOf: (spec) => claimedOwnerOf(spec, cwd) });
    if (shortfall !== undefined) throw shortfall;
    log.log("info", "run.checks_ok", { deployment_kind: sheet.kind, chain_id: rpcChainId, environment: a.environment, core_sha: a.coreSha, stage: a.stage ?? "default", dry_run: a.dryRun, resume: a.resume });

    const coreDir = a.coreDir ? resolve(cwd, a.coreDir) : defaultCoreDir(cwd);
    const manifestOut = env[MANIFEST_DIR_ENV] ? resolve(cwd, env[MANIFEST_DIR_ENV]!) : undefined;
    if (manifestOut) log.log("info", "run.manifest_dir", { dir: manifestOut, source: MANIFEST_DIR_ENV });
    const head = readGitHead(coreDir);
    if (head !== a.coreSha) throw new PublishError("USAGE", `the core checkout ${coreDir} is at ${head ?? "an unknown commit"}, not the DEPLOY_SHA ${a.coreSha}`);
    // DEPLOY_SHA: HEAD must equal it and the tree must be clean (a modified file would run code the sha does not name)
    // read-only `git -C DIR status --porcelain` through the injectable runner: the one allowed spawn besides forge and cast
    const dirty = await dirtyTreeLines(run, coreDir, rpcChainId, castEnv);
    if (dirty.length > 0) throw new PublishError("USAGE", `the core checkout ${coreDir} has uncommitted changes (${dirty.length}): ${dirty.slice(0, 5).join("; ")}. A deploy runs the DEPLOY_SHA exactly; commit, stash or clean first.`, { dirty: dirty.slice(0, 20) });
    // exitFeeBps is bounded by the vault maximum defined in the core contracts at the DEPLOY_SHA
    assertExitFeeBound(coreDir, sheet.vaults);
    // the stage table is core's, at the DEPLOY_SHA: no script, env, artifact or manifest name is kept in this repo.
    // Issue 1833: the per-vault rules this CLI loaded from its own checkout must be that table's, or the CLI runs from another sha. Checked before any verb runs.
    // Issue 1851: except the emergency pause-all, which reads no per-vault rule: a mismatch there is one warning naming both tables, never a refusal.
    const stageTable = loadStageTable(coreDir);
    // Issue 1927: the deployment checkout (--core-dir, at its DEPLOY_SHA) supplies the stage table, the manifest set and the deployed layout snapshots. A follow-on verb of the governed
    // upgrade may name the live v0.5.0 checkout, whose table also has the retired rmAGENT row (RETIRED_VAULT_KEYS). Every vault this CLI governs keeps the 1833 check.
    const followOn = (RETIRED_VAULT_VERBS as readonly string[]).includes(sheetOpts.verb ?? "");
    const tableRetired = stageTable.vaults.map((v) => v.key as string).filter(isRetiredVaultKey);
    const sheetRetired = sheet.retiredVaults ?? [];
    if (sheetRetired.some((k) => !tableRetired.includes(k)) || (followOn && tableRetired.some((k) => !sheetRetired.includes(k)))) throw new PublishError("INPUT_MISSING", `the sheet names the retired vault(s) [${sheetRetired.join(", ")}] and the stage table of ${coreDir} names [${tableRetired.join(", ")}]: the sheet and --core-dir must be the same deployment's (runbook 4.15)`, { sheet: sheetRetired, table: tableRetired });
    try { assertVaultRulesMatch(stageTable, join(coreDir, TABLE_REL), { retired: followOn }); } catch (e) {
      if (a.verb !== "pause-all" || !isPublishError(e, "INPUT_MISSING")) throw e;
      log.log("warn", "vault_rules.mismatch", { ...(e.details ?? {}), message: `${e.message}. pause-all reads no per-vault rule, so it runs anyway` });
    }
    stageState = peekStageState(); // issue 1892: the stage list is process-wide; the run puts back what it found (a test process runs many mains)
    useStageTable(stageTable, a.system);
    const evidenceDir = resolve(cwd, a.evidence ?? join("evidence", `publish-${rpcChainId}-${a.coreSha.slice(0, 12)}`));
    const buildCtx = (frozen: RunContext["frozen"], measure: boolean, lazySigner = false): RunContext => {
      if (a.signer!.startsWith("address:") && !a.dryRun) throw new PublishError("USAGE", "an address: signer cannot sign: it is accepted with --dry-run only");
      const construct = (): PublishSigner => (deps.makeSigner ?? ((s) => makeSigner(s, { env })))(a.signer!);
      // lazySigner (record-receipt): the signer is constructed by its first use, so a refusal before then constructs none (issue 1888)
      signer = lazySigner ? lazyPublishSigner(a.signer!, construct, (real) => { signer = real; }) : construct();
      return {
        chainId: rpcChainId, rpc: a.rpc, sheet, coreDir, coreSha: a.coreSha, evidenceDir,
        environment: a.environment, signer, caller, frozen, measure, dryCounts: a.dryRun ? {} : undefined, resume: a.resume, dryRun: a.dryRun, run, log,
        prompt: deps.prompt ?? (process.stdin.isTTY ? ttyPrompt : undefined), githubActions, actionsProof, baseEnv: env, safeApi: deps.safeApi, chainReader: deps.chainReader, readRetry: deps.readRetry, coreConfigCheck: deps.coreConfigCheck, logs: a.logs, checkSources: a.checkSources,
        manifestOut, startChain: a.dryRun && a.verb !== REDEPLOY_VERB ? (deps.startChain ?? startAnvil) : undefined, priorArtifactsDir: a.priorOut ? resolve(cwd, a.priorOut) : undefined,
        // security round 1 (review-security-033): a printed resume command names the absolute counts dir and --counts-require-origin-dev (govern.ts resumeCommand)
        countsDir: a.countsDir ? resolve(cwd, a.countsDir) : defaultCountsDir(cwd), countsRequireOriginDev: a.countsRequireOriginDev,
      };
    };
    // The EMERGENCY key (core 1619): --emergency-signer, else on the Twin chain the EMERGENCY keystore beside the DEPLOYER keystore. Never defaulted on mainnet.
    const emergencySigner = (): PublishSigner | undefined => {
      const spec = a.emergencySigner ?? (rpcChainId === TWIN_CHAIN_ID ? siblingEmergencySpec(a.signer) : undefined);
      if (!spec) return undefined;
      assertSignerSpec(spec, { rpcChainId, rpc: a.rpc, env });
      if (spec.startsWith("address:")) throw new PublishError("SIGNER", "an address: signer cannot sign: the EMERGENCY key must be a real signer");
      const s = (deps.makeSigner ?? ((x) => makeSigner(x, { env })))(spec);
      extraSigners.push(s);
      return s;
    };
    // pause-all by hand: nothing else of the run is needed (no frozen counts, no USDC check), so a half-finished run can still be stopped.
    if (a.verb === "pause-all") {
      const ctx = buildCtx(undefined, false);
      const manifest = loadRunManifest(ctx.evidenceDir);
      if (!manifest) throw new PublishError("RESUME", `no run manifest in ${ctx.evidenceDir}: pause-all reads it to know whether the handover has begun. Pass the same --evidence directory as the run.`);
      const report = await (deps.pauseAll ?? pauseAll)(ctx, manifest, { trigger: "manual", reason: "pause-all was run by hand", emergencySigner: emergencySigner() });
      if (!report.allPaused) throw pauseIncomplete(report);
      if (report.manifestRecorded === false) throw pauseUnrecorded(report);
      log.log("info", "run.done", { ran: ["pause-all"], skipped: [] });
      return 0;
    }
    // Safe owner signers: --owner-signer, else on the Twin chain the rehearsal's own SAFE_OWNER_* keystores beside the deployer keystore (owner-signers.ts).
    const ownerSigners = async (c: RunContext): Promise<Signer[]> => {
      // A hardware owner asks the operator for its device before every read and every signature; keystore specs need no device.
      const devicePrompt = async (r: { kind: string; owner: string; hdPath: string; phase: string }) => {
        const ask = deps.prompt ?? (process.stdin.isTTY ? ttyPrompt : undefined);
        if (!ask) throw new PublishError("SIGNER", `a ${r.kind} owner signer needs an interactive terminal to ask for the device of ${r.owner}`);
        await ask(`Attach and unlock the ${r.kind} for Safe owner ${r.owner} (${r.hdPath}) to ${r.phase === "address" ? "read its address" : r.phase === "sign" ? "sign" : "send"}, then press Enter: `);
      };
      const mk = deps.ownerSigner ?? ((s: string) => parseOwnerHardwareSpec(s) ? ownerHardwareSigner(s, { prompt: devicePrompt, runner: deps.castRunner }) : signerFromSpec(s));
      const specs = a.ownerSigners.length === 0 && c.chainId === TWIN_CHAIN_ID ? siblingOwnerSpecs(a.signer) : a.ownerSigners;
      const out: Signer[] = [];
      for (const s of specs) { const sg = await mk(s); await sg.address(); out.push(sg); } // in order, one device at a time
      return out;
    };
    // record-receipt (issues 1727, 1888): the SUBMITTER SAFE records directly on the receipt contract, on every chain and in every mode. --signer only pays the gas. No counts, no stages: it anchors one
    // receipt and records the evidence entry in the run manifest. NO signer is built here: the payload, the Safe and the live role are checked first (record-receipt.ts), and the signers are lazy.
    if (a.verb === "record-receipt") {
      let payloadBytes: Uint8Array | undefined;
      if (a.payload !== undefined) { try { payloadBytes = new Uint8Array(readFileSync(a.payload)); } catch (e) { throw new PublishError("USAGE", `--payload ${a.payload} is not readable: ${(e as Error).message}`); } }
      const request = { receiptId: a.receiptId, payloadDigest: a.payloadDigest, payloadUri: a.payloadUri, payload: payloadBytes, submitter: a.submitter };
      assertRecordInputs(request); // issue 1754, 1888: the digest and the id are checked against the bytes BEFORE the signer exists
      const ctx = buildCtx(undefined, false, true);
      const rec = await (deps.recordReceipt ?? recordReceipt)(ctx, { sender: () => ctx.signer.safeSigner(), owners: () => ownerSigners(ctx) }, request, deps.recordApi);
      console.log(JSON.stringify({ event: "record_receipt", ...rec }));
      log.log("info", "run.done", { ran: ["record-receipt"], skipped: [] });
      return 0;
    }
    // redeploy-vault (issue 1796): --signer is the DEPLOYER. No frozen counts (they belong to the original deployment sha): the sha must be a release tag of the sheet's kind with green CI on 8453.
    if (a.verb === REDEPLOY_VERB) {
      const usdc = await run("cast", ["code", USDC_ADDRESS], { env: castEnv });
      if (usdc.code !== 0) throw new PublishError("CHAIN", `cast code ${USDC_ADDRESS} failed: ${usdc.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
      assertUsdcCode(usdc.stdout.trim(), deps.usdcCodeHash);
      if (releaseGated({ chainId: rpcChainId, verb: a.verb, stage: a.stage, dryRun: a.dryRun, measure: a.measure })) {
        const tag = await assertReleaseGate({ sha: a.coreSha, coreDir, countsDir: defaultCountsDir(cwd), env, kind: sheet.kind, requireCounts: false, releaseTag: deps.releaseTag, releaseTags: deps.releaseTags, checkShaGreen: deps.checkShaGreen, remoteTag: deps.remoteTag });
        log.log("info", "redeploy.release_gate", { ok: true, tag, core_sha: a.coreSha });
      }
      const ctx = buildCtx(undefined, false);
      const rec = await (deps.redeployVault ?? runRedeployVault)(ctx, a.vault as (typeof REDEPLOY_KEYS)[number]);
      if (rec) console.log(JSON.stringify({ event: "redeploy_vault", vault: rec.vault, old_vault: rec.old_vault, new_vault: rec.new_vault, deploy_tx_hashes: rec.deploy_tx_hashes, next: `govern --row ${REDEPLOY_ROW}` }));
      log.log("info", "run.done", { ran: [REDEPLOY_VERB], skipped: [] });
      return 0;
    }
    const realVerifyReconstructed = async (f: FrozenFile): Promise<void> => verifyReconstructionOnChain(f.measured.reconstructed!, { table: getStageTable(), out: buildLibraryArtifacts(coreDir, getStageTable()), getCode: async (x) => codeWithRetry(() => run("cast", ["code", x], { env: castEnv }), { address: x, rpc: a.rpc, sleep: deps.sleep }) });
    const realFrozenDirCommitted = async (d: string): Promise<void> => {
      try { await gitFrozenDirCommitted(coreDir, d, { requireOriginDev: a.countsRequireOriginDev }); } catch (e) {
        if (a.countsDir || !isPublishError(e)) throw e;
        // the default counts dir is the one of the core checkout at the release sha: it can never track the baseline named by that sha (issue 1740)
        throw new PublishError(e.kind, `${e.message} No --counts-dir was given and the default counts dir ${d} is under the core checkout: pass --counts-dir <a clean checkout of dev at Y >= the release sha that tracks the baseline file>/deployments/frozen-counts`);
      }
    };
    const realAnchorCommitted = (anchorPath: string, hash: string): Promise<void> => gitAnchorCommitted(anchorPath, hash);
    const countsDir = a.countsDir ? resolve(cwd, a.countsDir) : defaultCountsDir(cwd);
    // QA plan v1 E1 (review DT-2, QD-6, issue 1796): the single-vault redeploy's sha model. `govern --row redeploy-vault` and `verify --prior-out` may name the sha the
    // redeploy-vault verb ran at although the run manifest names the original deployment sha (redeploy-vault.ts redeployShaRun). A verify the model cannot check
    // (the original sha after a round at another sha, the redeploy sha without --prior-out, a --prior-out that is not a checkout of the original sha) is refused HERE,
    // before any signer, frozen counts or forge: a failed verify would pause all three vaults. A stage set that reaches verify never names the redeploy sha.
    // Every run that reaches the verify stage is covered, not only the verify verb: the default stage set, --stage all and a list naming verify ("stage-set").
    const shaPath = a.stage === "plan" ? undefined : redeployShaPath({ verb: a.verb, stage: a.stage, row: a.row, dryRun: a.dryRun });
    const priorRun = shaPath ? loadRunManifest(evidenceDir) : undefined;
    const priorOutSha = a.priorOut ? checkoutShaOf(resolve(cwd, a.priorOut)) : undefined;
    const shaRun = redeployShaRun(priorRun, { coreSha: a.coreSha, path: shaPath, priorOut: a.priorOut, priorOutSha });
    if (shaRun) log.log("info", "run.redeploy_sha", { path: shaPath, original_sha: shaRun.originalSha, redeploy_sha: shaRun.redeploySha, ...(priorOutSha ? { prior_out_sha: priorOutSha } : {}) });
    // Deploy 3 (tooling-sha.ts): a descendant of the run manifest's sha whose deployed inputs are byte-identical continues that run manifest, as a redeploy round does.
    const toolRun = shaRun || a.stage === "plan" || a.dryRun ? undefined : await toolingShaRun(priorRun ?? loadRunManifest(evidenceDir), { coreSha: a.coreSha, coreDir, run, env: scrubGitEnv(castEnv) });
    if (toolRun) log.log("info", "run.tooling_sha", { original_sha: toolRun.originalSha, tooling_sha: toolRun.toolingSha, note: "the deployed inputs are byte-identical: this run continues the original run manifest" });
    // The contracts-freeze gate (core 1524; QA plan v1 E4, issue 1816): on 8453 the plan AND every run that can broadcast (releaseGated) run only at a release-tagged SHA of
    // the sheet's kind, whose frozen counts file is committed and clean in its git work tree (COUNTS_UNTRACKED; a reconstructed baseline gets the whole-dir proof of issue 1740), with green CI. No signer exists yet, no forge has run.
    // The govern row at a redeploy round's sha has no frozen file of its own (E1): like the redeploy-vault verb, it is gated on the tag and CI only.
    const names = a.stage === "plan" ? [] : a.verb ? selectVerbStages(a.verb) : selectStages(a.stage);
    const gated = releaseGated({ chainId: rpcChainId, verb: a.verb, stage: a.stage, dryRun: a.dryRun, measure: a.measure });
    if (gated) {
      // Owner decision 2026-10-19 (Deploy 3): a REHEARSAL that continues at a tool-only commit (tooling-sha.ts: a descendant whose deployed inputs are
      // byte-identical) is gated at the sha the deployment started at, which carries the tag, the green CI and the frozen counts. Production keeps its own sha.
      const gateSha = toolRun && sheet.kind === "rehearsal" ? toolRun.originalSha : a.coreSha;
      if (gateSha !== a.coreSha) log.log("info", "plan.release_gate_original_sha", { gate_sha: gateSha, core_sha: a.coreSha });
      const tag = await assertReleaseGate({ sha: gateSha, coreDir, countsDir, env, kind: sheet.kind, requireCounts: !shaRun, releaseTag: deps.releaseTag, releaseTags: deps.releaseTags, checkShaGreen: deps.checkShaGreen, remoteTag: deps.remoteTag,
        verifyReconstructed: deps.verifyReconstructed ?? realVerifyReconstructed, anchorCommitted: deps.anchorCommitted ?? realAnchorCommitted, frozenDirCommitted: deps.frozenDirCommitted ?? realFrozenDirCommitted,
        run, runEnv: scrubGitEnv(castEnv) });
      log.log("info", "plan.release_gate", { ok: true, tag, core_sha: gateSha, stage: a.stage ?? a.verb ?? "default", counts: shaRun ? "none (redeploy sha)" : "committed" });
    }
    // Review-security-001 (issue 1927): runbook 4.15 gates the LIVE build above (--core-sha of the v0.5.0 checkout). The rc build a governed upgrade deploys from (--upgrade-build) is a
    // second checkout, so on 8453 it passes its own gate here, before any signer: clean HEAD, an annotated rc tag of the kind on releases-A.B.x, the canonical remote tag, green CI.
    const upgrading = a.verb === DEPLOY_IMPL_VERB || a.row === UPGRADE_ROW;
    if (rpcChainId === MAINNET_CHAIN_ID && upgrading && a.upgradeBuild !== undefined && resolve(a.upgradeBuild) !== coreDir) {
      const ub = await assertUpgradeBuildGate({ dir: resolve(a.upgradeBuild), kind: sheet.kind, env, chainId: rpcChainId, dirty: (d) => dirtyTreeLines(run, d, rpcChainId, castEnv), readHead: readGitHead,
        releaseTag: deps.releaseTag, releaseTags: deps.releaseTags, remoteTag: deps.remoteTag, checkShaGreen: deps.checkShaGreen, onBranch: deps.rcOnReleaseBranch,
        // review-security-003: the artifacts the verb deploys and compares with must be built from that tree. An unknown --proxy names none here; the verb refuses it with USAGE.
        artifacts: proxySpecs(getStageTable()).filter((x) => x.name === a.proxy).map((x) => x.contract), trackedFiles: deps.trackedFiles, forgeConfig: deps.forgeConfig });
      log.log("info", "upgrade_build.release_gate", { ok: true, upgrade_build: resolve(a.upgradeBuild), sha: ub.sha, tag: ub.tag });
    }
    // deploy-implementation (issue 1861): the release gate above ran on 8453 as for govern. No counts, no stages: one CREATE from the deployer and its implementation_deploys entry.
    if (a.verb === DEPLOY_IMPL_VERB) {
      const ctx = buildCtx(undefined, false);
      const res = await (deps.deployImplementation ?? runDeployImplementation)(ctx, { proxy: a.proxy!, upgradeBuild: a.upgradeBuild });
      console.log(JSON.stringify({ event: "deploy_implementation", reused: res.reused, proxy: res.entry.proxy_name, implementation: res.entry.implementation, code_hash: res.entry.code_hash, deploy_tx: res.entry.deploy_tx, next: res.next }));
      log.log("info", "run.done", { ran: [DEPLOY_IMPL_VERB], skipped: [] });
      return 0;
    }
    // plan is a gate: it needs the frozen file. Every other run resolves the counts (frozen, measure, dry-run measure) by counts.ts resolveCounts; a run at a redeploy sha
    // uses the original sha's counts and needs no file for the redeploy sha (QA plan v1 E1).
    const counts = a.stage === "plan"
      ? { frozen: a.measure ? undefined : loadFrozen(countsDir, a.coreSha).counts, measure: a.measure, mode: (a.measure ? "measure-flag" : "frozen") as "measure-flag" | "frozen", file: "" }
      : resolveCounts({ dir: countsDir, sha: a.coreSha, measureFlag: a.measure, dryRun: a.dryRun, chainId: rpcChainId, warn: (ev, f) => log.log("warn", ev, f), ...(shaRun && priorRun ? { redeploy: { originalSha: shaRun.originalSha, recorded: measuredCounts(priorRun) } } : toolRun ? { redeploy: { originalSha: toolRun.originalSha, recorded: measuredCounts(loadRunManifest(evidenceDir)!) } } : {}) });
    const frozen = counts.frozen;

    // P12: the token at the constant USDC address must be the pinned FiatTokenProxy. A mock fails here, before any send.
    const usdcCode = await run("cast", ["code", USDC_ADDRESS], { env: castEnv });
    if (usdcCode.code !== 0) throw new PublishError("CHAIN", `cast code ${USDC_ADDRESS} failed: ${usdcCode.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
    assertUsdcCode(usdcCode.stdout.trim(), deps.usdcCodeHash);

    if (a.stage === "plan") {
      // the plan job: sheet, floors, chain id and counts are all checked above, and core's config-check runs read-only against live Base.
      // No signer, no state. A failing check or a missing script ends the plan job here.
      const evidenceDir = resolve(cwd, a.evidence ?? join("evidence", `publish-${rpcChainId}-${a.coreSha.slice(0, 12)}`));
      const lines = await runCoreConfigCheck({ coreDir, outDir: join(evidenceDir, "core-config-check"), chainId: rpcChainId, rpc: a.rpc, baseEnv: env }, deps.coreConfigCheck, "the plan");
      log.log("info", "plan.core_config_check", { ok: true, lines: lines.length });
      const plan = frozen ? stagePlan(frozen) : [];
      // Issue 1727: a rehearsal plan prints nonces RELATIVE to the deployer start nonce (recorded in the run manifest at the first stage), never absolute ones.
      console.log(JSON.stringify({ chainId: rpcChainId, coreSha: a.coreSha, deploymentKind: sheet.kind, startNonceBasis: planNonceBasis(sheet.kind), plan }));
      return 0;
    }
    // Issue 1733: the plan is not the only place a reconstructed baseline is re-verified against the build and the chain. A run that sends deployer transactions on 8453 does it too,
    // before any signer exists, so the order plan then publish is not something an operator can get wrong. Since QA plan v1 E4 the release gate above already did it for every
    // gated run (once: the re-verification is not repeated), so only a dry run of the deployer stages on 8453 reaches this block.
    if (!gated && rpcChainId === MAINNET_CHAIN_ID && !counts.measure && names.some((n) => DEPLOYER_STAGES.some((s) => s.name === n))) {
      const f = loadFrozen(countsDir, a.coreSha);
      if (f.measured.reconstructed) {
        await (deps.verifyReconstructed ?? realVerifyReconstructed)(f);
        await assertBaselineCommitted({ countsDir, sha: a.coreSha, frozen: f, frozenDirCommitted: deps.frozenDirCommitted ?? realFrozenDirCommitted, anchorCommitted: deps.anchorCommitted ?? realAnchorCommitted });
      }
    }
    // QA plan v1 E1: a run at a redeploy round's sha continues the run manifest of the original sha; the verify records the sha of the --prior-out checkout.
    const ctx: RunContext = { ...buildCtx(frozen, counts.measure), ...(shaRun ? { originalSha: shaRun.originalSha } : toolRun ? { originalSha: toolRun.originalSha } : {}), ...(priorOutSha ? { priorArtifactsSha: priorOutSha } : {}) };
    // A failed verify (stage 12) or postflight pauses deposits on all three vaults (core 1619) and then fails the run as before.
    let postflight: PauseTrigger | undefined;
    let result: Awaited<ReturnType<typeof runStages>>;
    try {
      result = await runStages(ctx, names, {
        prove: async (c, row, m) => {
          const p = deps.prove ?? {};
          const logs = a.logs || p.logs ? { ...a.logs, ...p.logs } : undefined; // the flags, plus the test seam (sleep)
          await runProveControl(c, row, m, { ownerSigners: await ownerSigners(c), sender: await c.signer.safeSigner(), ...p, logs });
        },
        verify: async (c, row, m) => {
          try { await runVerifyStage(c, row, m, { ...realVerifyDeps, ...(deps.verify ?? {}) }); } catch (e) {
            // A part-way govern run (GOVERN_PENDING, issue 1667) is not a failed verify: nothing was checked, so nothing is paused. Neither is a verify refused before
            // the verifier ran because it would compare a contract with the wrong build (QA plan v1 E1, redeploy-vault.ts verifyBuildRefusal).
            // Neither is a verify whose only failures are reads the RPC refused (RPC_REFUSED, issue 1851): an RPC without the data is not an incident.
            if (a.system !== "gateway" && !isPublishError(e, "GOVERN_PENDING") && !isPublishError(e, "RPC_REFUSED") && !(isPublishError(e, "USAGE") && e.details.refused_before_verify === true)) postflight = "verify";
            throw e;
          }
        },
        govern: async (c, row, m) => {
          await runGovern(c, row, m, { ownerSigners: await ownerSigners(c), sender: await c.signer.safeSigner(), maxWaitSeconds: a.maxWait, ...(a.noWarp ? { warp: false as const } : {}), row: a.row, receiptId: a.receiptId, payload: a.payload, submitter: a.submitter, proxy: a.proxy, implementation: a.implementation, migration: a.migration, upgradeBuild: a.upgradeBuild, ...(a.adminArgs && a.row === UNWIND_GUARD_ROW ? { unwindGuard: a.adminArgs } : a.adminArgs && a.row === RETIRE_ROW ? { retire: a.adminArgs } : a.adminArgs ? { selfAdmin: { owner: a.adminArgs.owner, oldOwner: a.adminArgs["old-owner"], newOwner: a.adminArgs["new-owner"], threshold: a.adminArgs.threshold, role: a.adminArgs.role, account: a.adminArgs.account } } : {}), call: a.call as GovernOpts["call"], ...(deps.govern ?? {}) });
        },
      });
      try { await finalNonceCheck(ctx, result.manifest, result.ran); } catch (e) { if (a.system !== "gateway") postflight = "postflight"; throw e; } // issue 1892: the gateway run owns no vault to pause
    } catch (e) {
      if (postflight && !a.dryRun) throw await pauseOnFailure(ctx, postflight, e, emergencySigner, deps.pauseAll);
      throw e;
    }
    if (a.dryRun && counts.mode === "dry-run-measure") log.log("warn", "dry_run.counts_measured", { counts: ctx.dryCounts, note: "measured by the dry run, not frozen: nothing was written" });
    if (!shaRun && !toolRun && (a.measure || counts.mode === "twin-measure") && DEPLOYER_STAGES.every((s) => result.manifest.stages[s.name]?.status === "done")) {
      const forge = (await run("forge", ["--version"], { env: castEnv })).stdout.trim().split("\n")[0];
      const p = writeFrozen(countsDir, a.coreSha, measuredCounts(result.manifest), { chainId: rpcChainId, at: new Date().toISOString(), forge, ...(Object.keys(adoptedTxs(result.manifest)).length ? { adopted: Object.keys(adoptedTxs(result.manifest)) } : {}) });
      log.log("info", "run.counts_measured", { file: p });
    }
    // QA plan v1 E1: the isomorphism report describes the deployment at its own sha. A run at a redeploy sha leaves it as the original run wrote it.
    // A tooling-sha run writes it only when the original run never did (it failed before its end, Deploy 3): the deployed inputs are byte-identical, so the
    // report is the deployment's, filed under the original sha (coreHead names the checkout it was read from).
    const isoPath = join(ctx.evidenceDir, `isomorphism-${rpcChainId}.json`);
    if (shaRun || (toolRun && existsSync(isoPath))) log.log("info", "run.isomorphism_kept", { original_sha: (shaRun ?? toolRun)!.originalSha, note: "a run at a redeploy or tooling sha does not rewrite the deployment's isomorphism report" });
    else if (!a.dryRun && a.system !== "gateway" && existsSync(ctx.evidenceDir)) { // issue 1892: the isomorphism report is the vaults deployment's
      const cmp = a.compareSheet ? { path: a.compareSheet, sheet: parseSheet(readFileSync(resolve(cwd, a.compareSheet), "utf8"), sheetOpts) } : undefined;
      const report = await buildIsomorphismReport(ctx, { compareTo: cmp });
      writeReport(isoPath, toolRun ? { ...report, coreSha: toolRun.originalSha } : report);
      if (toolRun) log.log("info", "run.isomorphism_written", { original_sha: toolRun.originalSha, tooling_sha: toolRun.toolingSha, note: "the deployment had no isomorphism report: written from the tooling sha, whose deployed inputs are byte-identical" });
    }
    log.log("info", "run.done", { ran: result.ran, skipped: result.skipped });
    return 0;
  } catch (e) {
    const code = exitCodeOf(e);
    log.log("error", "run.failed", { kind: isPublishError(e) ? e.kind : (e as { code?: string }).code ?? "UNEXPECTED", exit_code: code, message: (e as Error).message });
    return code;
  } finally {
    signer?.cleanup();
    if (stageState) restoreStageState(stageState);
    for (const x of extraSigners) x.cleanup();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
