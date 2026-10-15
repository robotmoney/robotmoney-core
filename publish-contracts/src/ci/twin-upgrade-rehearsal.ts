#!/usr/bin/env bun
// The Twin chain upgrade rehearsal (QA plan v1 P4, issue 1811, ADR-0014 stage 4). It is the step after the twin-publish action in the NIGHTLY job
// `twin-upgrade-rehearsal` of .github/workflows/suite-29-nightly-twin-fork.yml (never a per-pull-request job). twin-publish has already deployed the exact release
// artifacts of this checkout (publish: the authority stage's timelock first, then the nine proxies, the handover), verified them and run stage 13 through the real
// Safe and timelock. This script takes that deployment through the whole governed-proxy lifecycle with the same CLI, keys, sheet and run manifest:
//   1. GOVERNED UPGRADE. Deploy a new implementation of one proxy (default the registry) from this checkout's build artifact, then `govern --row upgrade-proxy`
//      (the Safe schedules proxy.upgradeToAndCall on the timelock, the CLI warps the delay, anyone executes). Read back the ERC-1967 slot, the frozen flag and a read
//      of the proxy's own state (unchanged across the upgrade), then `verify` (the verifier expects the proxy on the round's target, compared with its build).
//   2. FREEZE. `govern --row freeze-proxy --admin-arg proxy=all`: one timelock batch, freezeUpgrades(liveImplementation, liveCodeHash) on every proxy. Read back
//      every proxy frozen and the upgraded proxy still on the upgraded implementation.
//   3. REJECTED POST-FREEZE UPGRADE, twice, both a rollback of the frozen proxy to the implementation it ran before the upgrade:
//      a. the tool: `govern --row upgrade-proxy` must refuse with GOVERN (exit 14) naming the freeze, and send nothing;
//      b. the chain: the same upgrade scheduled by the Safe on the timelock as the generic Twin call `govern --call-label post-freeze-upgrade-<proxy>`. The schedule
//         lands, the delay is warped, and the execute is refused by the proxy itself (UpgradesAreFrozen, bubbled through the timelock): the run must end with the
//         round scheduled and never executed, and the slot must not move.
//   4. `verify` again (every proxy frozen by the executed freeze round), then the evidence tool on the run manifest AND the chain
//      (`evidence-check --proxy-lifecycle ... --rejected-upgrade post-freeze-upgrade-<proxy> --rpc`: the Upgraded and UpgradesFrozen events, the frozen state now,
//      and an eth_call of the scheduled execute that must revert UpgradesAreFrozen), then the evidence folder through the rehearsal secret scan.
// Environment in: RPC_URL, GITHUB_WORKSPACE, GITHUB_ENV, TWIN_RUN_DIR (exported by twin-publish: keys, passphrase file, merged sheet, manifests, evidence),
// UPGRADE_PROXY_IN (optional: the stage-table name of the proxy to upgrade; its build artifact must link no library, default registry).
// Out (GITHUB_ENV): TWIN_UPGRADE_REHEARSAL_DIR (the evidence folder: round lines, the refusals, the run manifest, evidence-check output, upgrade-rehearsal.json;
// it passed the secret scan) and TWIN_UPGRADE_REHEARSAL_LABELS_DIR (the two verifier label files).
// Tests replace the tools with stubs: TWIN_CLI (default src/cli.ts), TWIN_EVIDENCE_CHECK (src/evidence-check.ts), CAST (cast), TWIN_BUILD_DIR (default <core>/out).
// Any step that does not end the way the lifecycle requires fails this script. The only Twin environment step is the govern time warp inside the CLI: this script
// names no anvil or evm RPC method. Never run it against Base mainnet: the generic call is a Twin-only verb and the CLI refuses it on 8453.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOYMENT_KINDS, TWIN_CHAIN_ID } from "../chains.ts";
import { AUTHORITY_STAGE } from "../core-wiring.ts";
import { EXIT_CODES } from "../errors.ts";
import { rejectedUpgradeKey } from "../evidence-check.ts";
import { ERC1967_IMPLEMENTATION_SLOT, wordAddress } from "../proxies.ts";
import { parseSheetText } from "../sheet.ts";
import { loadStageTable, manifestFile, proxyByName, tableProxies, type StageTable, type TableProxy } from "../stage-table.ts";
import { FREEZE_ROW, UPGRADE_ROW } from "../upgrade-rows.ts";
import { scanRehearsal } from "./scan-rehearsal-secrets.ts";

/** The proxy the rehearsal upgrades unless UPGRADE_PROXY_IN names another: the registry links no library, so its build artifact deploys as is. */
const REHEARSAL_PROXY = "registry";
/** The generic-call label of the post-freeze upgrade; the run-manifest key is `call-<label>` (rejectedUpgradeKey). */
const REJECTED_LABEL_PREFIX = "post-freeze-upgrade-";
/** A read of the state each proxy holds, compared before and after the upgrade (the upgrade swaps logic, never state). Other proxies: their authority. */
const STATE_PROBES: Record<string, string> = { registry: "listVaults()(address[])" };
const DEFAULT_PROBE = "upgradeAuthority()(address)";

const env = (k: string, d = ""): string => process.env[k] ?? d;
const fail = (m: string): never => { console.error(`twin-upgrade-rehearsal: ${m}`); process.exit(1); };
const lc = (s: string): string => s.toLowerCase();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function run(cmd: string[], opts: { cwd?: string; stdoutTo?: string; quiet?: boolean; childEnv?: Record<string, string> } = {}): string {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.childEnv }, stdout: "pipe", stderr: "inherit" });
  const out = r.stdout.toString();
  if (opts.stdoutTo) writeFileSync(opts.stdoutTo, out); else if (!opts.quiet) process.stdout.write(out);
  if (r.exitCode !== 0) fail(`${cmd.slice(0, 3).join(" ")} exited ${r.exitCode}`);
  return out;
}
/** A step that is EXPECTED to fail: its exit code, stdout and stderr (stderr is also echoed to the job log). */
function attempt(cmd: string[], opts: { cwd?: string; childEnv?: Record<string, string> } = {}): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, env: { ...process.env, ...opts.childEnv }, stdout: "pipe", stderr: "pipe" });
  const err = r.stderr.toString();
  process.stderr.write(err);
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err };
}

/** One JSON line of `govern` stdout: {"row","phase","txHash","status","readyAt"} (src/cli.ts USAGE). */
interface RowLine { row: string; phase: string; txHash?: string; status?: number }
const rowLines = (text: string): RowLine[] => text.split("\n").filter((l) => l.trim().startsWith("{")).flatMap((l) => {
  try { const j = JSON.parse(l) as RowLine; return typeof j?.row === "string" && typeof j?.phase === "string" ? [j] : []; } catch { return []; }
});
/** A round that ran to the end: one scheduled and one executed line of `row`, both status 1. */
function mustScheduleAndExecute(file: string, row: string, what: string): void {
  const ls = rowLines(readFileSync(file, "utf8")).filter((l) => l.row === row);
  if (!ls.some((l) => l.phase === "scheduled" && l.status === 1) || !ls.some((l) => l.phase === "executed" && l.status === 1)) {
    fail(`${what}: govern printed no scheduled and executed ${row} lines with status 1 (${JSON.stringify(ls)}): the round did not run through the Safe and the timelock`);
  }
}

const core = env("GITHUB_WORKSPACE") || fail("GITHUB_WORKSPACE is not set");
const rpc = env("RPC_URL") || fail("RPC_URL is not set");
const rh = env("TWIN_RUN_DIR") || fail("TWIN_RUN_DIR is not set: run the twin-publish action (verify and govern) in this job first");
const ghEnv = env("GITHUB_ENV");
const exportVar = (k: string, v: string) => { if (ghEnv) appendFileSync(ghEnv, `${k}=${v}\n`); };
const sheet = join(rh, "sheet.env");
const pass = join(rh, "passphrase");
const deployerKey = join(rh, "keys", "DEPLOYER");
const manifests = join(rh, "manifests");
const evidence = join(rh, "evidence");
const runManifest = join(evidence, "publish-run.json");
for (const [what, path] of [["the merged sheet", sheet], ["the passphrase file", pass], ["the DEPLOYER keystore", deployerKey], ["the stage manifests", manifests], ["the run manifest", runManifest]] as const) {
  if (!existsSync(path)) fail(`${what} ${path} is missing: run the twin-publish action with verify and govern in this job first`);
}
const sha = run(["git", "-C", core, "rev-parse", "HEAD"], { quiet: true }).trim();
const pc = join(core, "publish-contracts");
const bun = process.execPath;
const cli = env("TWIN_CLI", "src/cli.ts");
const evidenceCheck = env("TWIN_EVIDENCE_CHECK", "src/evidence-check.ts");
const castBin = env("CAST", "cast");
const out = join(rh, "upgrade-rehearsal");
const labels = join(rh, "upgrade-rehearsal-labels");
mkdirSync(out, { recursive: true });
mkdirSync(labels, { recursive: true });

// ---- what the deployment is: an upgradeable Twin deployment of this checkout's stage table ----
const merged = parseSheetText(readFileSync(sheet, "utf8"));
if (merged.UPGRADE_MODE !== "upgradeable") fail(`the merged sheet says UPGRADE_MODE=${merged.UPGRADE_MODE ?? "(unset)"}: the lifecycle rehearsal needs upgradeable proxies (a frozen-at-deploy deployment has no upgrade to rehearse)`);
const kind = (DEPLOYMENT_KINDS as readonly string[]).includes(merged.DEPLOYMENT_KIND ?? "") ? merged.DEPLOYMENT_KIND! : "production";
const table: StageTable = (() => { try { return loadStageTable(core); } catch (e) { return fail((e as Error).message); } })();
const proxies = tableProxies(table);
if (proxies.length === 0) fail("the core stage table lists no proxies: this checkout predates ADR-0014, there is nothing to upgrade or freeze");
const target: TableProxy = (() => { try { return proxyByName(table, env("UPGRADE_PROXY_IN") || REHEARSAL_PROXY); } catch (e) { return fail((e as Error).message); } })();
const manifestOf = (stage: string): Record<string, unknown> => {
  const st = table.stages.find((s) => s.name === stage) ?? fail(`the stage table has no stage ${stage}`);
  const f = join(manifests, manifestFile(st.manifest));
  if (!existsSync(f)) fail(`the ${stage} stage manifest ${f} is missing`);
  return JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
};
const addressIn = (stage: string, field: string): string => {
  const v = manifestOf(stage)[field];
  return typeof v === "string" && ADDRESS.test(v) ? v : fail(`the ${stage} stage manifest has no address in ${field}`);
};
const proxy = addressIn(target.stage, target.field);
const timelock = addressIn(AUTHORITY_STAGE, "timelock");

// The exact release artifact: this checkout's build of the proxy's contract (the build the publish deployed and the verifier compares with).
const buildDir = env("TWIN_BUILD_DIR") || join(core, "out");
const artifactPath = join(buildDir, `${target.artifact}.sol`, `${target.artifact}.json`);
if (!existsSync(artifactPath)) fail(`no build artifact ${artifactPath}: the publish builds it, run this after twin-publish in the same checkout`);
const art = JSON.parse(readFileSync(artifactPath, "utf8")) as { bytecode?: { object?: string; linkReferences?: Record<string, unknown> } };
if (Object.keys(art.bytecode?.linkReferences ?? {}).length > 0) fail(`${target.artifact} links libraries: this rehearsal deploys the new implementation from the unlinked build artifact, so it upgrades a proxy whose build links nothing (registry, router, icpolicy, receipt); set UPGRADE_PROXY_IN to one of them`);
const creation = String(art.bytecode?.object ?? "");
if (!/^0x([0-9a-fA-F]{2})+$/.test(creation)) fail(`${artifactPath} has no creation bytecode`);

// ---- the tools ----
const stageArgs = (verb: string, extra: string[] = []): string[] => [bun, cli, verb, "--chain", String(TWIN_CHAIN_ID), "--rpc", rpc, "--sheet", sheet,
  "--signer", `keystore:${deployerKey}:${pass}`, "--environment", "stage", "--core-sha", sha, "--counts-dir", join(rh, "counts"), "--evidence", evidence, ...extra];
const cliEnv = { PUBLISH_MANIFEST_DIR: manifests, YES: "1" };
// One CLI verb with the flags twin-publish used, so the rows land in the same run manifest. The unattended Twin chain run needs YES=1 (the CLI refuses it on 8453).
const stage = (verb: string, stdoutTo: string, extra: string[] = []) => run(stageArgs(verb, extra), { cwd: pc, stdoutTo, childEnv: cliEnv });
const read = (...args: string[]): string => run([castBin, ...args, "--rpc-url", rpc], { quiet: true }).trim();
const slotOf = (addr: string): string => lc(wordAddress(read("storage", addr, ERC1967_IMPLEMENTATION_SLOT) as `0x${string}`));
const frozenOf = (addr: string): boolean => {
  const v = read("call", addr, "upgradesFrozen()(bool)");
  return v === "true" ? true : v === "false" ? false : fail(`upgradesFrozen() on ${addr} read '${v}', not true or false: no governed proxy`);
};
/** A new implementation of the target's contract, created by the deployer from the build artifact's creation code (the constructor locks its initializers). */
function deployImplementation(what: string): string {
  // `--create` is a cast subcommand: every option of `cast send` goes before it.
  const text = run([castBin, "send", "--keystore", deployerKey, "--password-file", pass, "--rpc-url", rpc, "--json", "--create", creation], { quiet: true });
  let rc: { status?: unknown; contractAddress?: unknown; transactionHash?: unknown };
  try { rc = JSON.parse(text); } catch { return fail(`${what}: cast send --create printed no receipt JSON`); }
  if (!(rc.status === "0x1" || rc.status === 1 || rc.status === "1")) fail(`${what}: the deploy transaction ${String(rc.transactionHash)} failed (status ${String(rc.status)})`);
  const a = String(rc.contractAddress ?? "");
  return ADDRESS.test(a) ? a : fail(`${what}: the deploy receipt names no created contract`);
}

// ---- 1. the governed upgrade ----
const original = slotOf(proxy);
const deployedImpl = lc(addressIn(target.stage, target.implementationField));
if (original !== deployedImpl) fail(`${target.name} ${proxy} runs ${original}, not the implementation its stage deployed (${deployedImpl}): the rehearsal starts from a fresh twin-publish deployment`);
if (frozenOf(proxy)) fail(`${target.name} ${proxy} is already frozen before the rehearsal: nothing can be upgraded`);
const probe = STATE_PROBES[target.name] ?? DEFAULT_PROBE;
const stateBefore = read("call", proxy, probe);
const upgraded = lc(deployImplementation(`the new ${target.artifact} implementation`));
if (upgraded === original) fail(`the new implementation ${upgraded} is the live one: nothing would be upgraded`);
const upgradeRows = join(out, "upgrade-rows.txt");
stage("govern", upgradeRows, ["--row", UPGRADE_ROW, "--admin-arg", `proxy=${target.name}`, "--admin-arg", `implementation=${upgraded}`]);
mustScheduleAndExecute(upgradeRows, UPGRADE_ROW, `the upgrade of ${target.name}`);
if (slotOf(proxy) !== upgraded) fail(`after the upgrade the ERC-1967 slot of ${target.name} names ${slotOf(proxy)}, not ${upgraded}`);
if (frozenOf(proxy)) fail(`${target.name} reads frozen right after the upgrade, before any freeze round`);
const stateAfter = read("call", proxy, probe);
if (stateAfter !== stateBefore) fail(`${target.name}.${probe} changed across the upgrade (${stateBefore} -> ${stateAfter}): an upgrade swaps logic, never state`);
stage("verify", join(labels, "verify-labels-post-upgrade.txt"));

// ---- 2. the freeze: every proxy, one batch ----
const freezeRows = join(out, "freeze-rows.txt");
stage("govern", freezeRows, ["--row", FREEZE_ROW, "--admin-arg", "proxy=all"]);
mustScheduleAndExecute(freezeRows, FREEZE_ROW, "the freeze of every proxy");
const frozen = proxies.map((px) => ({ name: px.name, proxy: addressIn(px.stage, px.field) }));
for (const x of frozen) if (!frozenOf(x.proxy)) fail(`${x.name} ${x.proxy} reads upgradesFrozen() false after the freeze round executed`);
if (slotOf(proxy) !== upgraded) fail(`the freeze moved the ERC-1967 slot of ${target.name} off the upgraded implementation ${upgraded}`);

// ---- 3a. a post-freeze upgrade through the tool: refused, nothing sent ----
const refused = attempt(stageArgs("govern", ["--row", UPGRADE_ROW, "--admin-arg", `proxy=${target.name}`, "--admin-arg", `implementation=${original}`]), { cwd: pc, childEnv: cliEnv });
if (refused.code === 0) fail(`govern --row ${UPGRADE_ROW} of the frozen ${target.name} exited 0: the tool scheduled an upgrade of a frozen proxy`);
if (refused.code !== EXIT_CODES.GOVERN) fail(`govern --row ${UPGRADE_ROW} of the frozen ${target.name} exited ${refused.code}, not ${EXIT_CODES.GOVERN} (GOVERN): it was refused for another reason than the freeze`);
if (rowLines(refused.out).length > 0) fail(`the refused upgrade printed round lines (${refused.out.trim()}): something was sent`);
/** The refusal text the CLI logged (a JSON log line on stderr): the first string in it that names the freeze. */
const refusalText = (() => {
  const line = refused.err.split("\n").find((l) => /is frozen/.test(l));
  if (line === undefined) return undefined;
  try {
    const walk = (v: unknown): string | undefined => typeof v === "string" ? (/is frozen/.test(v) ? v : undefined) : v && typeof v === "object" ? Object.values(v).map(walk).find((x) => x !== undefined) : undefined;
    return walk(JSON.parse(line)) ?? line.trim();
  } catch { return line.trim(); }
})() ?? fail(`the refusal of the post-freeze upgrade does not name the freeze ('is frozen'): exit ${refused.code}`);
writeFileSync(join(out, "refused-upgrade.json"), JSON.stringify({ row: UPGRADE_ROW, proxy: target.name, proxy_address: proxy, implementation: original, exit_code: refused.code, refusal: refusalText }, null, 2) + "\n");

// ---- 3b. the same upgrade scheduled by the Safe on the timelock: the proxy refuses the execute ----
const label = `${REJECTED_LABEL_PREFIX}${target.name}`;
const key = rejectedUpgradeKey(label);
const callData = run([castBin, "calldata", "upgradeToAndCall(address,bytes)", original, "0x"], { quiet: true }).trim();
if (!/^0x([0-9a-fA-F]{2})+$/.test(callData)) fail(`cast calldata printed '${callData}', not calldata`);
const rejected = attempt(stageArgs("govern", ["--call-label", label, "--call-target", proxy, "--call-data", callData]), { cwd: pc, childEnv: cliEnv });
writeFileSync(join(out, "rejected-upgrade-rows.txt"), rejected.out);
const lines = rowLines(rejected.out).filter((l) => l.row === key);
if (rejected.code === 0 || lines.some((l) => l.phase === "executed")) fail(`the Safe executed the upgrade of the frozen ${target.name} through the timelock (exit ${rejected.code}): ADR-0014 §5 is broken`);
if (!lines.some((l) => l.phase === "scheduled" && l.status === 1)) fail(`the post-freeze upgrade was never scheduled through the Safe on the timelock (exit ${rejected.code}): the rehearsal must show the proxy refusing a scheduled, ready upgrade, not a tool that stopped early`);
if (slotOf(proxy) !== upgraded) fail(`the refused upgrade moved the ERC-1967 slot of ${target.name}: it names ${slotOf(proxy)}`);
if (!frozenOf(proxy)) fail(`${target.name} reads unfrozen after the refused upgrade`);

// ---- 4. verify, the evidence tool on the run manifest and the chain, the secret scan ----
stage("verify", join(labels, "verify-labels-post-freeze.txt"));
const delay = (/^[0-9]+/.exec(read("call", timelock, "getMinDelay()(uint256)"))?.[0]) ?? fail("the timelock's getMinDelay() read no number");
if (delay === "0") fail("the timelock's minimum delay is 0: the lifecycle must run through a real delay");
run([bun, evidenceCheck, "--proxy-lifecycle", runManifest, "--timelock", timelock, "--rejected-upgrade", label, "--delay-floor", delay, "--rpc", rpc, "--deployment-kind", kind],
  { cwd: pc, stdoutTo: join(out, "evidence-check.txt") });
copyFileSync(runManifest, join(out, "publish-run.json"));
writeFileSync(join(out, "upgrade-rehearsal.json"), JSON.stringify({
  chain_id: TWIN_CHAIN_ID, core_sha: sha, deployment_kind: kind, upgrade_mode: "upgradeable", timelock, timelock_min_delay: Number(delay),
  upgrade: { proxy: target.name, proxy_address: proxy, artifact: target.artifact, from_implementation: original, implementation: upgraded, state_read: probe, state_before: stateBefore, state_after: stateAfter },
  freeze: { proxies: frozen.map((x) => x.name) },
  rejected_upgrades: [
    { by: "tool", row: UPGRADE_ROW, implementation: original, exit_code: refused.code, file: "refused-upgrade.json" },
    { by: "proxy", call_label: label, run_manifest_key: key, implementation: original, exit_code: rejected.code, file: "rejected-upgrade-rows.txt" },
  ],
  evidence_check: "evidence-check.txt",
}, null, 2) + "\n");
const hits = scanRehearsal(out, [readFileSync(pass, "utf8").trim()]);
if (hits.length) fail(`the evidence folder failed the secret scan:\n  ${hits.join("\n  ")}`);
exportVar("TWIN_UPGRADE_REHEARSAL_DIR", out);
exportVar("TWIN_UPGRADE_REHEARSAL_LABELS_DIR", labels);
console.log(`twin-upgrade-rehearsal: ${target.name} upgraded ${original} -> ${upgraded}, ${frozen.length} proxies frozen, the post-freeze upgrade refused by the tool and by the proxy; evidence in ${out}`);
