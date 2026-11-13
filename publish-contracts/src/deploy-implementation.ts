// Issue 1861: the `deploy-implementation` verb, step 2 of the governed upgrade runbook (docs/operations/contract-release-runbooks.md 4.12): deploy the NEW implementation of one
// core proxy, linked to the libraries the LIVE implementation links, so `govern --row upgrade-proxy --implementation <address>` can then schedule the upgrade.
//
//   bun src/cli.ts deploy-implementation --proxy NAME [--upgrade-build DIR] (plus the usual --chain, --rpc, --sheet, --signer, --core-sha, --evidence)
//
// It reads the proxy from upgradeability.json (the record verify writes), its live implementation from the ERC-1967 slot, and the build artifact of the proxy's implementation
// contract from DIR/out (default: the DEPLOY_SHA checkout). Refused, with nothing sent, when:
//   - the proxy reads upgradesFrozen() true (a frozen proxy is never upgraded again),
//   - DIR's storage layout snapshot does not extend the deployed snapshot append-only (layoutGateProblems: the same gate govern --row upgrade-proxy runs),
//   - the live implementation is not the build it was recorded from (its link offsets cannot be trusted),
//   - the build links a library the live implementation does not link (a placeholder would be left), or the live implementation links a library the build does not name,
//   - forge is not the pinned release-build version (issue 1926, forge-version.ts), read before anything else,
//   - a library address read from the live implementation has no code (issue 1926: nothing ever links an address without code).
// It then sends ONE CREATE from the deployer signer (ADMIN_ADDRESS), reads the runtime code back, compares it with the build artifact with immutables and library links masked
// (runtimeCodeProblems, as govern and verify do), records an `implementation_deploys` entry in the run manifest and prints the exact `govern --row upgrade-proxy` command.
// A rerun with the same --proxy and --upgrade-build whose recorded implementation still has the build's code sends nothing and reprints the entry.
// The release gate on 8453 runs in cli.ts before this module, as for govern.
//
// Deploy 4, `--system fund`: the same verb for a proxy of the fund system (the one-vault prototype), resolved from the fund system's table scope, with every check above.
// The fund verifier writes no upgradeability.json, so the proxy is the fund stage manifest's and the run manifest must record a passed fund verify; the deployed snapshot is
// the DEPLOY_SHA checkout's, which the live-code check above ties to the chain. `--contract NAME` names the proxy's reviewed second implementation (FUND_SECOND_IMPLEMENTATIONS,
// a test-only child that really changes code): its own pinned snapshot must extend the deployed one, append-only, besides the base contract's gate. The fund system has no
// govern row, so the printed next step is the fund Safe's schedule on the fund-system timelock (publish-contracts/src/safe/cli.ts).
//
// Canonical: docs/technical/contract-upgradeability-plan.md, docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md, docs/operations/contract-release-runbooks.md 4.12.
import { scopeTable } from "./stage-table.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { assertPinnedForgeWith } from "./forge-version.ts";
import { LIBRARY_ADDRESS_CAUSE } from "./libs-adopt.ts";
import { childEnv, confirmStage, loadRunManifest, manifestDir, receiptBlock, saveRunManifest, waitForReceiptBlock, type RunContext, type RunManifest } from "./runner.ts";
import { getStageTable } from "./stages.ts";
import { manifestBase } from "./stage-table.ts";
import { UPGRADE_ROW, layoutExtensionProblems, layoutGateProblems, layoutRenames, runtimeCodeProblems } from "./upgrade-rows.ts";
import { artifactJson, compareCode, ERC1967_IMPLEMENTATION_SLOT, linkedLibraries, loadArtifact } from "./verify/codehash.ts";
import { viemReader } from "./verify/reader.ts";
import { layoutId, proxySpecs, type ProxySpec } from "./verify/upgradeability.ts";
import { proxyBuildDirsOf, UPGRADEABILITY_MANIFEST } from "./verify-stage.ts";

export const DEPLOY_IMPL_VERB = "deploy-implementation";

/**
 * Deploy 4: the reviewed second implementation of a fund-system proxy, by verifier name. Each is a test-only child of the release contract (contracts/test/helpers) that adds
 * code and no state, with its own storage layout snapshot pinned by scripts/ci/check-core-storage-layout.sh. No stage deploys it: only `deploy-implementation --system fund
 * --contract NAME` does, for the runbook's upgrade lifecycle. The vaults system has none (its second implementation is another checkout's build, --upgrade-build).
 */
export const FUND_SECOND_IMPLEMENTATIONS: Readonly<Record<string, { contract: string; layout: string }>> = {
  rebalancer: { contract: "RebalancerV2", layout: "contracts/test/fixtures/storage-layout/RebalancerV2.json" },
};

/** One `implementation_deploys` entry of the run manifest. */
export interface ImplementationDeploy {
  step: typeof DEPLOY_IMPL_VERB;
  proxy_name: string;
  proxy: Address;
  contract: string;
  /** The core checkout the implementation was built from (--upgrade-build, default the DEPLOY_SHA checkout). `govern --row upgrade-proxy --upgrade-build` takes the same. */
  build: string;
  /** The implementation the proxy ran when this one was deployed. */
  live_implementation: Address;
  implementation: Address;
  code_hash: Hex;
  /** Library name to the address the live implementation links and the new one was linked to. */
  libraries: Record<string, Address>;
  deploy_tx: Hex;
  deployer: Address;
  core_sha: string;
  deployed_at: string;
  /** Deploy 4: present (fund) only for a fund-system proxy. A vaults entry carries no system. */
  system?: "fund";
}

/** The chain reads and the one send of the verb. Tests replace it with a stub chain. */
export interface DeployImplApi {
  getCode(a: Address): Promise<Hex>;
  implementationOf(proxy: Address): Promise<Address>;
  upgradesFrozen(proxy: Address): Promise<boolean>;
  /** Issue 1926: runs `forge --version` (the build this verb links must come from the pinned forge). */
  forgeVersion(): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Sends one CREATE of `creationCode` from the deployer signer. Returns the mined receipt's hash, status and contract address. */
  create(creationCode: Hex): Promise<{ txHash: Hex; status: boolean; address: Address | null }>;
}

const lc = (x: unknown): string => String(x ?? "").toLowerCase();
const strip = (x: string): string => x.replace(/^0x/, "");

export const implementationDeploysOf = (m: RunManifest): ImplementationDeploy[] => (Array.isArray(m.implementation_deploys) ? m.implementation_deploys : []);

/** The govern command that upgrades `proxy` to the deployed implementation. The operator adds the same --chain, --rpc, --sheet, --signer and --evidence. */
export function upgradeCommand(ctx: Pick<RunContext, "chainId" | "coreSha" | "coreDir">, d: Pick<ImplementationDeploy, "proxy_name" | "implementation" | "build">): string {
  const build = d.build === ctx.coreDir ? "" : ` --upgrade-build ${d.build}`;
  return `bun publish-contracts/src/cli.ts govern --row ${UPGRADE_ROW} --proxy ${d.proxy_name} --implementation ${d.implementation}${build} --chain ${ctx.chainId} --core-sha ${ctx.coreSha} (plus the same --rpc, --sheet, --signer and --evidence)`;
}

/** Deploy 4: the fund system has no govern row. Its upgrade is ONE call the fund Safe schedules on the fund-system timelock with the Safe tool, then executes after the delay. */
export function fundUpgradeCommand(ctx: Pick<RunContext, "chainId">, d: Pick<ImplementationDeploy, "proxy" | "implementation">): string {
  return `bun publish-contracts/src/safe/cli.ts propose --action schedule --chain-id ${ctx.chainId} --target ${d.proxy} --data "$(cast calldata "upgradeToAndCall(address,bytes)" ${d.implementation} 0x)" (plus --rpc, --safe <the fund Safe>, --timelock <the fund-system timelock>, --salt and --out), then sign with two owners and execute; after the delay the same with --action execute`;
}

/**
 * The creation code of the build's `contract` with every library placeholder filled with the address in `libraries`, or the problems that stop it: a library the build links
 * that `libraries` lacks, a library in `libraries` the build does not name, a placeholder left over.
 */
export function linkCreationCode(art: any, libraries: Record<string, Address>, contract: string): { code?: Hex; problems: string[] } {
  const problems: string[] = [];
  const refs: { lib: string; start: number; length: number }[] = [];
  for (const file of Object.values<any>(art?.bytecode?.linkReferences ?? {})) for (const [lib, list] of Object.entries<any>(file)) for (const r of list) refs.push({ lib, start: r.start, length: r.length });
  const named = new Set(refs.map((r) => r.lib));
  for (const lib of named) if (!(lib in libraries)) problems.push(`the build's ${contract} links ${lib}, which the live implementation does not link (expected: an address the live implementation links; derived: none). ${LIBRARY_ADDRESS_CAUSE}`);
  for (const lib of Object.keys(libraries)) if (!named.has(lib)) problems.push(`the live implementation links ${lib}, which the build's ${contract} does not name (expected: ${libraries[lib]}, the address the live implementation links; derived: no link site in the build). ${LIBRARY_ADDRESS_CAUSE}`);
  let code = strip(String(art?.bytecode?.object ?? ""));
  if (code === "") problems.push(`the build's ${contract} artifact has no creation bytecode`);
  if (problems.length) return { problems };
  for (const r of refs) code = code.slice(0, r.start * 2) + strip(libraries[r.lib]!).toLowerCase() + code.slice((r.start + r.length) * 2);
  if (code.includes("__$")) return { problems: [`the ${contract} creation code still has an unlinked library placeholder`] };
  return { code: `0x${code}` as Hex, problems: [] };
}

/** The real chain reads (viem over --rpc) and the CREATE (cast send --create, signed by the deployer signer, as pause-all sends). */
export function realDeployImplApi(ctx: RunContext): DeployImplApi {
  const chain = (ctx.chainReader ?? viemReader)(ctx.rpc);
  return {
    getCode: (a) => chain.getCode(a),
    forgeVersion: () => ctx.run("forge", ["--version"], { env: childEnv(ctx), cwd: ctx.coreDir }),
    implementationOf: async (proxy) => getAddress(`0x${strip(await chain.getStorageAt(proxy, ERC1967_IMPLEMENTATION_SLOT)).padStart(64, "0").slice(24)}`),
    upgradesFrozen: async (proxy) => (await chain.read(proxy, "function upgradesFrozen() view returns (bool)")) === true,
    create: async (creationCode) => {
      const signerArgs = (await ctx.signer.forgeArgs()).map((a) => (a === "--sender" ? "--from" : a));
      // `--create CODE` is cast's trailing subcommand: every option goes before it, or cast reads the options as the constructor signature and arguments.
      const r = await ctx.run("cast", ["send", "--json", ...signerArgs, "--create", creationCode], { env: childEnv(ctx), interactive: true });
      if (r.code !== 0) throw new PublishError("BROADCAST", `cast send --create failed: ${r.stderr.trim().split("\n").filter((l) => l.trim() !== "").slice(-3).join(" ")}`);
      const rc = JSON.parse(r.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
      // Issue 1981: the code read-back runs only once the RPC serves the receipt's block (a lagging node answers no code for a contract that is there).
      const block = receiptBlock(rc);
      if (block !== undefined) await waitForReceiptBlock(ctx, block, `the CREATE ${String(rc.transactionHash)}`);
      return { txHash: rc.transactionHash as Hex, status: ["0x1", "1", "success"].includes(lc(rc.status)) || rc.status === 1, address: (rc.contractAddress ?? null) as Address | null };
    },
  };
}

/**
 * The `deploy-implementation` verb. Returns the entry it recorded (or reused) and the govern command to run next. Throws REFUSED with nothing sent for every refusal of the
 * header, and VERIFY (no entry recorded) when the deployed runtime code is not the build.
 */
export async function runDeployImplementation(ctx: RunContext, o: { proxy: string; upgradeBuild?: string; system?: "vaults" | "fund"; contract?: string }, api: DeployImplApi = realDeployImplApi(ctx)): Promise<{ entry: ImplementationDeploy; reused: boolean; next: string }> {
  // Issue 1926: the build this verb reads and links must come from the pinned forge version. Read first: TOOL, before any file or chain read and before anything is sent.
  await assertPinnedForgeWith(() => api.forgeVersion());
  const t = getStageTable();
  const fund = o.system === "fund";
  const specs = proxySpecs(scopeTable(t, fund ? "fund" : "legacy"));
  const spec: ProxySpec | undefined = specs.find((x) => x.name === o.proxy);
  if (!spec) throw new PublishError("USAGE", `${DEPLOY_IMPL_VERB}${fund ? " --system fund" : ""} needs --proxy NAME, one of ${specs.map((x) => x.name).join(", ")}; got ${o.proxy}`);
  // Deploy 4: the contract to deploy is the proxy's own, or the reviewed second implementation of a fund-system proxy. Nothing else.
  const second = fund ? FUND_SECOND_IMPLEMENTATIONS[spec.name] : undefined;
  if (o.contract !== undefined && o.contract !== spec.contract && o.contract !== second?.contract) {
    throw new PublishError("USAGE", `${DEPLOY_IMPL_VERB} --proxy ${spec.name}: --contract ${o.contract} is not a reviewed implementation of ${spec.name} (expected ${[spec.contract, ...(second ? [second.contract] : [])].join(" or ")}). Nothing was sent.`);
  }
  const contract = o.contract ?? spec.contract;
  const candidateLayout = contract === spec.contract ? spec.layout : second!.layout;
  const manifest = loadRunManifest(ctx.evidenceDir);
  if (!manifest) throw new PublishError("RESUME", `no run manifest in ${ctx.evidenceDir}: ${DEPLOY_IMPL_VERB} deploys into a deployment that exists. Pass the --evidence directory of the run that deployed it.`);
  const u = t.upgradeAuthority;
  const stageManifest = join(manifestDir(ctx), `${manifestBase(t.stages.find((x) => x.name === spec.stage)!.manifest)}.json`);
  let proxy: Address, recordedLayoutId: string | null | undefined;
  if (!fund) {
    const recPath = join(manifestDir(ctx), UPGRADEABILITY_MANIFEST);
    if (!existsSync(recPath)) throw new PublishError("INPUT_MISSING", `${DEPLOY_IMPL_VERB} reads ${recPath}, which does not exist: run verify first`, { path: recPath });
    const rec = JSON.parse(readFileSync(recPath, "utf8"));
    if (rec.chain_id !== undefined && Number(rec.chain_id) !== ctx.chainId) throw new PublishError("REFUSED", `${recPath} is for chain ${rec.chain_id}, not ${ctx.chainId}`);
    const r = rec.proxies?.[spec.name];
    if (!r?.proxy) throw new PublishError("REFUSED", `upgradeability.json has no ${spec.name}. Run verify first. Nothing was sent.`);
    proxy = getAddress(r.proxy) as Address;
    recordedLayoutId = r.layout_id;
    const m = JSON.parse(readFileSync(stageManifest, "utf8"));
    if (lc(m[spec.field]) !== lc(proxy)) throw new PublishError("REFUSED", `${stageManifest} names ${spec.field} ${String(m[spec.field])}, upgradeability.json ${proxy}. Nothing was sent.`);
  } else {
    // Deploy 4: the fund verifier records no upgradeability.json. The run must be the fund system's and its fund verify must have passed; the proxy is the stage manifest's.
    if (manifest.system !== "fund") throw new PublishError("REFUSED", `the run manifest in ${ctx.evidenceDir} is the ${manifest.system ?? "vaults"} system's, not the fund system's. Nothing was sent.`);
    const v = manifest.stages?.verify;
    if (v?.status !== "done" || v.system !== "fund") throw new PublishError("REFUSED", `the fund run manifest in ${ctx.evidenceDir} records no passed fund verify: run verify --system fund first. Nothing was sent.`);
    if (!existsSync(stageManifest)) throw new PublishError("INPUT_MISSING", `${DEPLOY_IMPL_VERB} reads ${stageManifest}, which does not exist`, { path: stageManifest });
    const m = JSON.parse(readFileSync(stageManifest, "utf8"));
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(m[spec.field] ?? ""))) throw new PublishError("REFUSED", `${stageManifest} names no ${spec.field} address (got ${String(m[spec.field])}). Nothing was sent.`);
    if (m.chain_id !== undefined && Number(m.chain_id) !== ctx.chainId) throw new PublishError("REFUSED", `${stageManifest} is for chain ${m.chain_id}, not ${ctx.chainId}`);
    proxy = getAddress(m[spec.field]) as Address;
    // The deployed snapshot is the DEPLOY_SHA checkout's: the live-code check below refuses a live implementation that is not this checkout's build.
    if (u && existsSync(join(ctx.coreDir, spec.layout)) && existsSync(join(ctx.coreDir, u.layoutPins))) recordedLayoutId = layoutId(ctx.coreDir, spec.layout, u.layoutPins);
  }
  const refuse = (why: string, details: Record<string, unknown> = {}): never => { throw new PublishError("REFUSED", `${DEPLOY_IMPL_VERB} --proxy ${spec.name}: ${why.replace(/\.$/, "")}. Nothing was sent.`, { proxy: spec.name, ...details }); };

  if (await api.upgradesFrozen(proxy)) refuse(`${proxy} reads upgradesFrozen() true. A frozen proxy is never upgraded again`);
  const build = o.upgradeBuild ?? ctx.coreDir;
  const outDir = join(build, "out");
  if (!u) refuse("the stage table has no upgradeAuthority (layout pins)");
  const layout = layoutGateProblems(spec, ctx.coreDir, build, u!.layoutPins, recordedLayoutId);
  // Deploy 4: a second implementation's own pinned snapshot must extend the deployed snapshot too (the base contract's gate above stays).
  if (layout.length === 0 && candidateLayout !== spec.layout) {
    const cand = join(build, candidateLayout);
    if (!existsSync(cand)) layout.push(`${cand} does not exist`);
    else layout.push(...layoutExtensionProblems(JSON.parse(readFileSync(join(ctx.coreDir, spec.layout), "utf8")), JSON.parse(readFileSync(cand, "utf8")), layoutRenames(build), spec.contract).map((p) => `${contract}: ${p}`));
  }
  if (layout.length) refuse(`the storage layout gate refuses the build ${build}${contract !== spec.contract ? ` (${contract})` : ""}: ${layout.join("; ")}`, { layout });
  const nextOf = (e: ImplementationDeploy): string => (fund ? fundUpgradeCommand(ctx, e) : upgradeCommand(ctx, e));

  // A rerun with the same arguments: the recorded implementation, when it still has the build's code, is the answer.
  const list = implementationDeploysOf(manifest);
  const prior = [...list].reverse().find((e) => e.proxy_name === spec.name && e.build === build && (e.contract ?? spec.contract) === contract);
  if (prior) {
    let bad: string[];
    try { bad = await runtimeCodeProblems((a) => api.getCode(a), prior.implementation, outDir, contract); } catch (e) { bad = [(e as Error).message]; }
    if (bad.length === 0) {
      ctx.log.log("info", "deploy_implementation.reused", { proxy: spec.name, implementation: prior.implementation, deploy_tx: prior.deploy_tx, note: "recorded by an earlier run with the same arguments; nothing was sent" });
      return { entry: prior, reused: true, next: nextOf(prior) };
    }
    ctx.log.log("warn", "deploy_implementation.recorded_stale", { proxy: spec.name, implementation: prior.implementation, problems: bad, note: "the recorded implementation no longer has the build's code: deploying a new one" });
  }

  // The libraries the live implementation links, read from its code at the link offsets of the build it was recorded from (the DEPLOY_SHA checkout, or the build of the
  // proxy's last governed upgrade, the per-proxy build directory verify reads).
  const live = await api.implementationOf(proxy);
  const liveCode = await api.getCode(live);
  const liveOut = proxyBuildDirsOf(manifest, join(ctx.coreDir, "out")).proxyBuildDirs?.[spec.name] ?? join(ctx.coreDir, "out");
  let liveCmp: { ok: boolean; detail: string };
  try { liveCmp = compareCode(liveCode, loadArtifact(liveOut, spec.contract)); } catch (e) { liveCmp = { ok: false, detail: (e as Error).message }; }
  if (!liveCmp.ok) refuse(`the live implementation ${live} is not the ${spec.contract} of ${liveOut} (${liveCmp.detail}), so the libraries it links cannot be read`);
  const libraries: Record<string, Address> = {};
  for (const l of linkedLibraries(liveOut, spec.contract)) {
    const at = getAddress(`0x${strip(liveCode).slice(l.start * 2, (l.start + 20) * 2)}`);
    if (libraries[l.name] !== undefined && lc(libraries[l.name]) !== lc(at)) refuse(`the live implementation links ${l.name} at two addresses (${libraries[l.name]}, ${at}): expected one address, derived ${libraries[l.name]} and ${at}. ${LIBRARY_ADDRESS_CAUSE}`, { library: l.name, expected: libraries[l.name], derived: at });
    libraries[l.name] = at;
  }
  // Issue 1926: nothing ever links an address without code. Every library address read from the live implementation must hold code on this chain before the CREATE.
  for (const [name, at] of Object.entries(libraries)) {
    const code = lc(await api.getCode(at));
    if (code === "" || code === "0x") refuse(`the live implementation links ${name} at ${at}, which has NO code on chain ${ctx.chainId}: the new implementation would link an empty address`, { library: name, address: at });
  }
  let art: any;
  try { art = artifactJson(outDir, contract); } catch (e) { refuse(`${(e as Error).message}: run forge build in the upgrade build first`); }
  const linked = linkCreationCode(art, libraries, contract);
  if (!linked.code) refuse(linked.problems.join("; "), { problems: linked.problems, expected: libraries });

  const deployer = await ctx.signer.address();
  if (lc(deployer) !== lc(ctx.sheet.admin)) throw new PublishError("SIGNER", `the signer ${deployer} is not ADMIN_ADDRESS ${ctx.sheet.admin}: the deployer deploys the implementation`);
  ctx.log.log("info", "deploy_implementation.preview", { proxy: spec.name, proxy_address: proxy, contract, build, live_implementation: live, libraries });
  await confirmStage(ctx, DEPLOY_IMPL_VERB, `one CREATE from ${deployer}: a new ${contract} for ${spec.name} (${proxy}) from ${outDir}, linked to ${Object.entries(libraries).map(([n, a]) => `${n} ${a}`).join(", ") || "no library"}`);
  const sent = await api.create(linked.code!);
  if (!sent.status || !sent.address) throw new PublishError("BROADCAST", `the ${contract} deploy ${sent.txHash} reverted or created no contract. No entry was recorded.`, { tx: sent.txHash });
  const implementation = getAddress(sent.address) as Address;
  let bad: string[];
  try { bad = await runtimeCodeProblems((a) => api.getCode(a), implementation, outDir, contract); } catch (e) { bad = [(e as Error).message]; }
  if (bad.length) throw new PublishError("VERIFY", `the deployed ${implementation} (tx ${sent.txHash}) is not the build's ${contract}: ${bad.join("; ")}. No entry was recorded: do not upgrade to it.`, { implementation, tx: sent.txHash, problems: bad });

  const entry: ImplementationDeploy = {
    step: DEPLOY_IMPL_VERB, proxy_name: spec.name, proxy, contract, build, live_implementation: live, implementation,
    code_hash: keccak256(await api.getCode(implementation)), libraries, deploy_tx: sent.txHash, deployer, core_sha: ctx.coreSha, deployed_at: (ctx.now?.() ?? new Date()).toISOString(),
    ...(fund ? { system: "fund" as const } : {}),
  };
  manifest.implementation_deploys = [...list.filter((e) => e !== prior), entry];
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "deploy_implementation.done", { proxy: spec.name, contract, implementation, code_hash: entry.code_hash, deploy_tx: sent.txHash });
  return { entry, reused: false, next: nextOf(entry) };
}
