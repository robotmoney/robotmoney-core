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
import { assertFloors, readRpcChainId, MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "./floors.ts";
import { FROZEN_DIR, assertSha, loadFrozen, resolveCounts, writeFrozen } from "./counts.ts";
import { siblingOwnerSpecs } from "./owner-signers.ts";
import { buildIsomorphismReport, dirtyTreeLines, readGitHead, writeReport } from "./isomorphism.ts";
import { publishLogger, type Logger } from "./log.ts";
import { stagePlan } from "./plan.ts";
import { assertReleaseGate, type CheckShaGreen } from "./release-gate.ts";
import { DEPLOYER_STAGES, STAGE_NAMES, useStageTable } from "./stages.ts";
import { TABLE_REL, loadStageTable } from "./stage-table.ts";
import { finalNonceCheck, measuredCounts, runStages, spawnTool, childEnv, type ProcessRunner, type RunContext } from "./runner.ts";
import { callerInputs, parseSheet } from "./sheet.ts";
import { loadCorrelatedOwners } from "./correlated-owners.ts";
import { makeSigner, type PublishSigner } from "./signer.ts";
import { realVerifyDeps, runVerifyStage, type VerifyDeps } from "./verify-stage.ts";
import { RECEIPT_REFUSED_ON_MAINNET, RECEIPT_ROW, assertReceiptId, isTwinOnlyRow, resolveGovernRow, runGovern, type GovernOpts } from "./govern.ts";
import { signerFromSpec, type Signer } from "./safe/index.ts";
import { startAnvil, type ChainStarter } from "./preflight.ts";
import { USDC_ADDRESS, assertUsdcCode } from "./usdc.ts";
import { assertExitFeeBound } from "./asset-config.ts";
import { runCoreConfigCheck, type CoreConfigCheck } from "./core-config-check.ts";

/** The environment variable core's harness sets on the child: the directory the stage manifests are written to and read from. */
export const MANIFEST_DIR_ENV = "PUBLISH_MANIFEST_DIR";
export const VERBS = ["publish", "verify", "govern"] as const;
export type Verb = (typeof VERBS)[number];

export const USAGE = `publish contracts
  VERB               optional first word: publish | verify | govern. An alias for a stage set (below). Not combined with --stage.
                       publish = every deployer stage up to and including timelock (the same as --stage deploy)
                       verify  = the verify stage (the one verifier; a follow-on verb, so it implies --resume)
                       govern  = the govern stage (a follow-on verb, so it implies --resume)
  --chain N          target chain id (8453 or 918453). Must equal 'cast chain-id' of the RPC.
  --rpc URL          the RPC endpoint
  --sheet FILE       the frozen sheet (parsed as data, never sourced)
  --signer SPEC      keystore:PATH[:PASSFILE], env:signer, ledger or trezor. Never a key. Plaintext material is refused on a non-loopback RPC.
                     address:0xADMIN is accepted with --dry-run only (no secret: the sender of a simulation).
  --environment NAME the GitHub Environment (or 'local' on a rehearsal)
  --core-sha SHA     the core DEPLOY_SHA (40 hex). The core checkout HEAD must equal it.
  --row R            govern only: run one govern row, by 1-based number or by name.
                     Rows: unpause-PROTO, unpause-AGENT, unpause-RWA (the only mainnet operation after the handover), then the Twin-only
                     demonstrations update-delay, batch, cancel (refused with USAGE on 8453). Without --row, every unpause the sheet asks for is
                     scheduled in one sitting, then one wait, then executed (on 8453 only the unpauses run).
                     On 8453 a wait of 48 hours exits 15 (GOVERN_PENDING) once, with the ready time and the command to run again.
                     On demand, outside the ordered rows: --row release-receipt --receipt-id 0x<bytes32> releases one recorded consensus receipt
                     (ConsensusRecommendationReceipt.releaseReceipt) as its own Safe -> Timelock round, on 918453 only (refused with USAGE on 8453).
  --receipt-id ID    govern with --row release-receipt only: the bytes32 receipt id to release.
  --stage S          plan | deploy | all | a comma list of stage names (default: everything through verify)
                     The stage names come from core's scripts/deploy/stage-table.json at the DEPLOY_SHA, plus safe, verify and govern.
  --resume           continue a run: adopt the existing Safe, skip finished stages
  --dry-run          the preflight: run every check and simulate EVERY deployer stage in order on a blank local anvil it starts itself
                     (no fork). Nothing is broadcast, nothing is sent to --rpc, the checkout is left as found.
  --core-dir DIR     core checkout (default: the repo root that holds scripts/deploy/stage-table.json, found by walking up; use it only for a checkout elsewhere)
  --correlated-owners-file F   chain 8453: REQUIRED (or env CORRELATED_OWNERS_FILE). A file of addresses that share one root of trust. Two or more of them in SAFE_OWNERS is refused.
  --evidence DIR     evidence directory (run manifest, isomorphism report)
  --counts-dir DIR   frozen counts directory (default: deployments/frozen-counts in the working directory if present, else this repo's)
  --measure          rehearsal only: measure per-stage counts and write the frozen file for this SHA
  --owner-signer S   govern: a Safe owner signer spec (repeat for each owner needed). On chain 918453 with none given: the SAFE_OWNER_A/B/C keystores
                     beside the DEPLOYER keystore, under the same passphrase file (the rehearsal key layout). Never on 8453.
  --compare-sheet F  a second sheet for the sheet diff in the isomorphism report
  --call-label L --call-target ADDR --call-data 0x..   govern, Twin chain 918453 only (refused on 8453): one generic Safe -> Timelock call (schedule, wait by warp, execute),
                     for test fixtures whose action is not a mainnet govern row. Not combined with --row.
  --max-wait SECONDS govern: longest timelock wait this process accepts (default 3600)
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
  /** Test seam: replaces the read of the correlated-owners file (used on chain 8453 only). */
  correlatedOwners?: () => string[] | Promise<string[]>;
  ownerSigner?: (spec: string) => Promise<Signer>;
  safeApi?: RunContext["safeApi"];
  govern?: Partial<GovernOpts>;
  /** Test seam: the verifier behind the verify stage (default: the real one, labels on stdout). */
  verify?: Partial<VerifyDeps>;
  /** Test seam: the read-only chain reader behind the config-check that runs before each vault stage. */
  chainReader?: RunContext["chainReader"];
  /** Test seam: core's own config-check (bun scripts/ci/config-check.ts, read-only against live Base). Default: the real spawn. */
  coreConfigCheck?: CoreConfigCheck;
  /** Test seam only: the pinned FiatTokenProxy code hash. Production uses the pin in usdc.ts. */
  usdcCodeHash?: string;
  /** Test seams: the contracts-freeze gate of the 8453 plan job (core 1524): the release tag read and check-sha-green. Defaults: the real ones. */
  releaseTag?: (coreDir: string, sha: string) => Promise<string | null>;
  checkShaGreen?: CheckShaGreen;
  remoteTag?: (coreDir: string, tag: string) => Promise<void>;
  /** Test seam: the blank local chain a --dry-run simulates on. Default: anvil, when installed. */
  startChain?: ChainStarter;
}

export interface Parsed {
  chain: number; rpc: string; sheet: string; signer?: string; environment: string; coreSha: string; stage?: string; resume: boolean; dryRun: boolean;
  verb?: Verb; row?: string; coreDir?: string; correlatedOwnersFile?: string; evidence?: string; countsDir?: string; measure: boolean; ownerSigners: string[]; compareSheet?: string; maxWait?: number; call?: { label: string; target: string; data: string };
  /** With --row release-receipt only: the receipt to release. */
  receiptId?: string;
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
        resume: { type: "boolean" }, "dry-run": { type: "boolean" }, "core-dir": { type: "string" }, "correlated-owners-file": { type: "string" }, evidence: { type: "string" }, "counts-dir": { type: "string" },
        measure: { type: "boolean" }, "owner-signer": { type: "string", multiple: true }, "compare-sheet": { type: "string" }, "max-wait": { type: "string" }, "call-label": { type: "string" }, "call-target": { type: "string" }, "call-data": { type: "string" }, "receipt-id": { type: "string" }, help: { type: "boolean" },
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
  if (row !== undefined && row === "") throw new PublishError("USAGE", `--row needs a number or a name\n${USAGE}`);
  if (row !== undefined) {
    const stageNames = verb === undefined ? stage : undefined;
    if (!(verb === "govern" || stageNames === "govern")) throw new PublishError("USAGE", `--row applies to the govern verb (or --stage govern) only\n${USAGE}`);
    if (row === RECEIPT_ROW && Number(chainRaw) === MAINNET_CHAIN_ID) throw new PublishError("USAGE", `${RECEIPT_REFUSED_ON_MAINNET}\n${USAGE}`);
    if (row !== RECEIPT_ROW) {
      const resolved = resolveGovernRow(row); // an unknown row fails here, before any work
      if (isTwinOnlyRow(resolved) && Number(chainRaw) === MAINNET_CHAIN_ID) throw new PublishError("USAGE", `--row ${resolved} is a Twin-fork demonstration of the Safe tool: it is refused on chain ${MAINNET_CHAIN_ID}\n${USAGE}`);
    }
  }
  const receiptIdRaw = v["receipt-id"] as string | undefined;
  let receiptId: string | undefined;
  if (row === RECEIPT_ROW && receiptIdRaw === undefined) throw new PublishError("USAGE", `--row ${RECEIPT_ROW} needs --receipt-id 0x<bytes32>\n${USAGE}`);
  if (receiptIdRaw !== undefined) {
    if (row !== RECEIPT_ROW) throw new PublishError("USAGE", `--receipt-id goes with --row ${RECEIPT_ROW} only\n${USAGE}`);
    receiptId = assertReceiptId(receiptIdRaw);
  }
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
  if (stage !== "plan") need("signer", v.signer);
  if (!/^https?:\/\//.test(v.rpc as string)) throw new PublishError("USAGE", "--rpc must be an http(s) URL");
  return {
    chain: Number(chainRaw), rpc: v.rpc as string, sheet: v.sheet as string, signer: v.signer as string | undefined, environment: (v.environment as string | undefined) ?? "local",
    coreSha: assertSha(sha!), stage, verb, row, resume: !!v.resume || verb === "verify" || verb === "govern", dryRun: !!v["dry-run"], coreDir: v["core-dir"] as string | undefined, correlatedOwnersFile: v["correlated-owners-file"] as string | undefined, evidence: v.evidence as string | undefined,
    countsDir: v["counts-dir"] as string | undefined, measure: !!v.measure, ownerSigners: (v["owner-signer"] as string[] | undefined) ?? [], compareSheet: v["compare-sheet"] as string | undefined,
    maxWait: v["max-wait"] ? Number(v["max-wait"]) : undefined, call, receiptId,
  };
}

/** The verb to stage names: publish = every deployer stage through timelock, verify = verify, govern = govern. */
export function selectVerbStages(verb: Verb): string[] {
  if (verb === "publish") return STAGE_NAMES.slice(0, STAGE_NAMES.indexOf("timelock") + 1);
  return [verb];
}

/** `--stage` to stage names. Default: everything through verify. govern is explicit (or `all`). */
export function selectStages(stage: string | undefined): string[] {
  const through = (last: string) => STAGE_NAMES.slice(0, STAGE_NAMES.indexOf(last) + 1);
  if (stage === undefined) return through("verify");
  if (stage === "all") return [...STAGE_NAMES];
  if (stage === "deploy") return through("timelock");
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

/** No --counts-dir: deployments/frozen-counts under the working directory when it has one, else this repo's own (the caller may run from core). */
export function defaultCountsDir(cwd: string): string {
  const here = resolve(cwd, FROZEN_DIR);
  return existsSync(here) ? here : resolve(import.meta.dir, "..", "..", FROZEN_DIR);
}

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const log: Logger = publishLogger(deps.logSink);
  const run = deps.run ?? spawnTool;
  let signer: PublishSigner | undefined;
  try {
    const a = parseCli(argv);
    const cwd = deps.cwd ?? process.cwd();
    const caller = callerInputs(env);
    const sheet = parseSheet(readFileSync(resolve(cwd, a.sheet), "utf8"));
    // one chain-id source: the RPC
    const castEnv = childEnv({ baseEnv: env, rpc: a.rpc, chainId: a.chain });
    const rpcChainId = await readRpcChainId(async (args) => {
      const r = await run("cast", args, { env: castEnv });
      if (r.code !== 0) throw new PublishError("CHAIN", `cast chain-id failed: ${r.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
      return r.stdout;
    });
    if (rpcChainId !== MAINNET_CHAIN_ID && rpcChainId !== TWIN_CHAIN_ID) throw new PublishError("CHAIN", `chain ${rpcChainId} is not supported: publish contracts runs on ${TWIN_CHAIN_ID} (rehearsal) and ${MAINNET_CHAIN_ID} (mainnet)`);
    // The correlated-owners floor is on by default on 8453 and its file is required: the caller (devops) supplies it.
    const correlatedOwners = rpcChainId === MAINNET_CHAIN_ID ? await (deps.correlatedOwners ?? (() => loadCorrelatedOwners({ file: a.correlatedOwnersFile, env, cwd })))() : undefined;
    assertFloors({ rpcChainId, rpc: a.rpc, sheet, argChainId: a.chain, caller, signerSpec: a.signer, env, environment: a.environment, githubActions: env.GITHUB_ACTIONS === "true", measure: a.measure, correlatedOwners });
    log.log("info", "run.checks_ok", { chain_id: rpcChainId, environment: a.environment, core_sha: a.coreSha, stage: a.stage ?? "default", dry_run: a.dryRun, resume: a.resume });

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
    // the stage table is core's, at the DEPLOY_SHA: no script, env, artifact or manifest name is kept in this repo
    useStageTable(loadStageTable(coreDir));
    const countsDir = a.countsDir ? resolve(cwd, a.countsDir) : defaultCountsDir(cwd);
    // the contracts-freeze gate (core 1524): on 8453 the plan runs only at a release-tagged SHA with committed counts and green CI. No signer exists yet.
    if (a.stage === "plan" && rpcChainId === MAINNET_CHAIN_ID && !a.measure) {
      const tag = await assertReleaseGate({ sha: a.coreSha, coreDir, countsDir, env, releaseTag: deps.releaseTag, checkShaGreen: deps.checkShaGreen, remoteTag: deps.remoteTag });
      log.log("info", "plan.release_gate", { ok: true, tag, core_sha: a.coreSha });
    }
    // plan is a gate: it needs the frozen file. Every other run resolves the counts (frozen, measure, dry-run measure) by counts.ts resolveCounts.
    const counts = a.stage === "plan"
      ? { frozen: a.measure ? undefined : loadFrozen(countsDir, a.coreSha).counts, measure: a.measure, mode: (a.measure ? "measure-flag" : "frozen") as "measure-flag" | "frozen", file: "" }
      : resolveCounts({ dir: countsDir, sha: a.coreSha, measureFlag: a.measure, dryRun: a.dryRun, chainId: rpcChainId, warn: (ev, f) => log.log("warn", ev, f) });
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
      console.log(JSON.stringify({ chainId: rpcChainId, coreSha: a.coreSha, plan }));
      return 0;
    }
    const names = a.verb ? selectVerbStages(a.verb) : selectStages(a.stage);
    if (a.signer!.startsWith("address:") && !a.dryRun) throw new PublishError("USAGE", "an address: signer cannot sign: it is accepted with --dry-run only");
    signer = (deps.makeSigner ?? ((s) => makeSigner(s, { env })))(a.signer!);
    const ctx: RunContext = {
      chainId: rpcChainId, rpc: a.rpc, sheet, coreDir, coreSha: a.coreSha, evidenceDir: resolve(cwd, a.evidence ?? join("evidence", `publish-${rpcChainId}-${a.coreSha.slice(0, 12)}`)),
      environment: a.environment, signer, caller, frozen, measure: counts.measure, dryCounts: a.dryRun ? {} : undefined, resume: a.resume, dryRun: a.dryRun, run, log,
      prompt: deps.prompt ?? (process.stdin.isTTY ? ttyPrompt : undefined), githubActions: env.GITHUB_ACTIONS === "true", baseEnv: env, safeApi: deps.safeApi, chainReader: deps.chainReader, coreConfigCheck: deps.coreConfigCheck,
      manifestOut, startChain: a.dryRun ? (deps.startChain ?? startAnvil) : undefined,
    };
    const result = await runStages(ctx, names, {
      verify: async (c, row, m) => { await runVerifyStage(c, row, m, { ...realVerifyDeps, ...(deps.verify ?? {}) }); },
      govern: async (c, row, m) => {
        const mk = deps.ownerSigner ?? ((s: string) => signerFromSpec(s));
        // no --owner-signer on the Twin chain: the rehearsal's own SAFE_OWNER_* keystores beside the deployer keystore (owner-signers.ts)
        const specs = a.ownerSigners.length === 0 && c.chainId === TWIN_CHAIN_ID ? siblingOwnerSpecs(a.signer) : a.ownerSigners;
        const owners = await Promise.all(specs.map((s) => mk(s)));
        await runGovern(c, row, m, { ownerSigners: owners, sender: await c.signer.safeSigner(), maxWaitSeconds: a.maxWait, row: a.row, receiptId: a.receiptId, call: a.call as GovernOpts["call"], ...(deps.govern ?? {}) });
      },
    });
    await finalNonceCheck(ctx, result.manifest, result.ran);
    if (a.dryRun && counts.mode === "dry-run-measure") log.log("warn", "dry_run.counts_measured", { counts: ctx.dryCounts, note: "measured by the dry run, not frozen: nothing was written" });
    if ((a.measure || counts.mode === "twin-measure") && DEPLOYER_STAGES.every((s) => result.manifest.stages[s.name]?.status === "done")) {
      const forge = (await run("forge", ["--version"], { env: castEnv })).stdout.trim().split("\n")[0];
      const p = writeFrozen(countsDir, a.coreSha, measuredCounts(result.manifest), { chainId: rpcChainId, at: new Date().toISOString(), forge });
      log.log("info", "run.counts_measured", { file: p });
    }
    if (!a.dryRun && existsSync(ctx.evidenceDir)) {
      const cmp = a.compareSheet ? { path: a.compareSheet, sheet: parseSheet(readFileSync(resolve(cwd, a.compareSheet), "utf8")) } : undefined;
      const report = await buildIsomorphismReport(ctx, { compareTo: cmp });
      writeReport(join(ctx.evidenceDir, `isomorphism-${rpcChainId}.json`), report);
    }
    log.log("info", "run.done", { ran: result.ran, skipped: result.skipped });
    return 0;
  } catch (e) {
    const code = exitCodeOf(e);
    log.log("error", "run.failed", { kind: isPublishError(e) ? e.kind : (e as { code?: string }).code ?? "UNEXPECTED", exit_code: code, message: (e as Error).message });
    return code;
  } finally {
    signer?.cleanup();
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
