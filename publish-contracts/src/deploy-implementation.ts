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
//   - the build links a library the live implementation does not link (a placeholder would be left), or the live implementation links a library the build does not name.
// It then sends ONE CREATE from the deployer signer (ADMIN_ADDRESS), reads the runtime code back, compares it with the build artifact with immutables and library links masked
// (runtimeCodeProblems, as govern and verify do), records an `implementation_deploys` entry in the run manifest and prints the exact `govern --row upgrade-proxy` command.
// A rerun with the same --proxy and --upgrade-build whose recorded implementation still has the build's code sends nothing and reprints the entry.
// The release gate on 8453 runs in cli.ts before this module, as for govern.
//
// Canonical: docs/technical/contract-upgradeability-plan.md, docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md, docs/operations/contract-release-runbooks.md 4.12.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { childEnv, confirmStage, loadRunManifest, manifestDir, receiptBlock, saveRunManifest, waitForReceiptBlock, type RunContext, type RunManifest } from "./runner.ts";
import { getStageTable } from "./stages.ts";
import { manifestBase } from "./stage-table.ts";
import { UPGRADE_ROW, layoutGateProblems, runtimeCodeProblems } from "./upgrade-rows.ts";
import { artifactJson, compareCode, ERC1967_IMPLEMENTATION_SLOT, linkedLibraries, loadArtifact } from "./verify/codehash.ts";
import { viemReader } from "./verify/reader.ts";
import { proxySpecs, type ProxySpec } from "./verify/upgradeability.ts";
import { proxyBuildDirsOf, UPGRADEABILITY_MANIFEST } from "./verify-stage.ts";

export const DEPLOY_IMPL_VERB = "deploy-implementation";

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
}

/** The chain reads and the one send of the verb. Tests replace it with a stub chain. */
export interface DeployImplApi {
  getCode(a: Address): Promise<Hex>;
  implementationOf(proxy: Address): Promise<Address>;
  upgradesFrozen(proxy: Address): Promise<boolean>;
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

/**
 * The creation code of the build's `contract` with every library placeholder filled with the address in `libraries`, or the problems that stop it: a library the build links
 * that `libraries` lacks, a library in `libraries` the build does not name, a placeholder left over.
 */
export function linkCreationCode(art: any, libraries: Record<string, Address>, contract: string): { code?: Hex; problems: string[] } {
  const problems: string[] = [];
  const refs: { lib: string; start: number; length: number }[] = [];
  for (const file of Object.values<any>(art?.bytecode?.linkReferences ?? {})) for (const [lib, list] of Object.entries<any>(file)) for (const r of list) refs.push({ lib, start: r.start, length: r.length });
  const named = new Set(refs.map((r) => r.lib));
  for (const lib of named) if (!(lib in libraries)) problems.push(`the build's ${contract} links ${lib}, which the live implementation does not link`);
  for (const lib of Object.keys(libraries)) if (!named.has(lib)) problems.push(`the live implementation links ${lib}, which the build's ${contract} does not name`);
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
export async function runDeployImplementation(ctx: RunContext, o: { proxy: string; upgradeBuild?: string }, api: DeployImplApi = realDeployImplApi(ctx)): Promise<{ entry: ImplementationDeploy; reused: boolean; next: string }> {
  const t = getStageTable();
  const spec: ProxySpec | undefined = proxySpecs(t).find((x) => x.name === o.proxy);
  if (!spec) throw new PublishError("USAGE", `${DEPLOY_IMPL_VERB} needs --proxy NAME, one of ${proxySpecs(t).map((x) => x.name).join(", ")}; got ${o.proxy}`);
  const manifest = loadRunManifest(ctx.evidenceDir);
  if (!manifest) throw new PublishError("RESUME", `no run manifest in ${ctx.evidenceDir}: ${DEPLOY_IMPL_VERB} deploys into a deployment that exists. Pass the --evidence directory of the run that deployed it.`);
  const recPath = join(manifestDir(ctx), UPGRADEABILITY_MANIFEST);
  if (!existsSync(recPath)) throw new PublishError("INPUT_MISSING", `${DEPLOY_IMPL_VERB} reads ${recPath}, which does not exist: run verify first`, { path: recPath });
  const rec = JSON.parse(readFileSync(recPath, "utf8"));
  if (rec.chain_id !== undefined && Number(rec.chain_id) !== ctx.chainId) throw new PublishError("REFUSED", `${recPath} is for chain ${rec.chain_id}, not ${ctx.chainId}`);
  const r = rec.proxies?.[spec.name];
  if (!r?.proxy) throw new PublishError("REFUSED", `upgradeability.json has no ${spec.name}. Run verify first. Nothing was sent.`);
  const proxy = getAddress(r.proxy) as Address;
  const stageManifest = join(manifestDir(ctx), `${manifestBase(t.stages.find((x) => x.name === spec.stage)!.manifest)}.json`);
  const m = JSON.parse(readFileSync(stageManifest, "utf8"));
  if (lc(m[spec.field]) !== lc(proxy)) throw new PublishError("REFUSED", `${stageManifest} names ${spec.field} ${String(m[spec.field])}, upgradeability.json ${proxy}. Nothing was sent.`);
  const refuse = (why: string, details: Record<string, unknown> = {}): never => { throw new PublishError("REFUSED", `${DEPLOY_IMPL_VERB} --proxy ${spec.name}: ${why}. Nothing was sent.`, { proxy: spec.name, ...details }); };

  if (await api.upgradesFrozen(proxy)) refuse(`${proxy} reads upgradesFrozen() true. A frozen proxy is never upgraded again`);
  const build = o.upgradeBuild ?? ctx.coreDir;
  const outDir = join(build, "out");
  const u = t.upgradeAuthority;
  if (!u) refuse("the stage table has no upgradeAuthority (layout pins)");
  const layout = layoutGateProblems(spec, ctx.coreDir, build, u!.layoutPins, r.layout_id);
  if (layout.length) refuse(`the storage layout gate refuses the build ${build}: ${layout.join("; ")}`, { layout });

  // A rerun with the same arguments: the recorded implementation, when it still has the build's code, is the answer.
  const list = implementationDeploysOf(manifest);
  const prior = [...list].reverse().find((e) => e.proxy_name === spec.name && e.build === build);
  if (prior) {
    let bad: string[];
    try { bad = await runtimeCodeProblems((a) => api.getCode(a), prior.implementation, outDir, spec.contract); } catch (e) { bad = [(e as Error).message]; }
    if (bad.length === 0) {
      ctx.log.log("info", "deploy_implementation.reused", { proxy: spec.name, implementation: prior.implementation, deploy_tx: prior.deploy_tx, note: "recorded by an earlier run with the same arguments; nothing was sent" });
      return { entry: prior, reused: true, next: upgradeCommand(ctx, prior) };
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
    if (libraries[l.name] !== undefined && lc(libraries[l.name]) !== lc(at)) refuse(`the live implementation links ${l.name} at two addresses (${libraries[l.name]}, ${at})`);
    libraries[l.name] = at;
  }
  let art: any;
  try { art = artifactJson(outDir, spec.contract); } catch (e) { refuse(`${(e as Error).message}: run forge build in the upgrade build first`); }
  const linked = linkCreationCode(art, libraries, spec.contract);
  if (!linked.code) refuse(linked.problems.join("; "), { problems: linked.problems });

  const deployer = await ctx.signer.address();
  if (lc(deployer) !== lc(ctx.sheet.admin)) throw new PublishError("SIGNER", `the signer ${deployer} is not ADMIN_ADDRESS ${ctx.sheet.admin}: the deployer deploys the implementation`);
  ctx.log.log("info", "deploy_implementation.preview", { proxy: spec.name, proxy_address: proxy, contract: spec.contract, build, live_implementation: live, libraries });
  await confirmStage(ctx, DEPLOY_IMPL_VERB, `one CREATE from ${deployer}: a new ${spec.contract} for ${spec.name} (${proxy}) from ${outDir}, linked to ${Object.entries(libraries).map(([n, a]) => `${n} ${a}`).join(", ") || "no library"}`);
  const sent = await api.create(linked.code!);
  if (!sent.status || !sent.address) throw new PublishError("BROADCAST", `the ${spec.contract} deploy ${sent.txHash} reverted or created no contract. No entry was recorded.`, { tx: sent.txHash });
  const implementation = getAddress(sent.address) as Address;
  let bad: string[];
  try { bad = await runtimeCodeProblems((a) => api.getCode(a), implementation, outDir, spec.contract); } catch (e) { bad = [(e as Error).message]; }
  if (bad.length) throw new PublishError("VERIFY", `the deployed ${implementation} (tx ${sent.txHash}) is not the build's ${spec.contract}: ${bad.join("; ")}. No entry was recorded: do not upgrade to it.`, { implementation, tx: sent.txHash, problems: bad });

  const entry: ImplementationDeploy = {
    step: DEPLOY_IMPL_VERB, proxy_name: spec.name, proxy, contract: spec.contract, build, live_implementation: live, implementation,
    code_hash: keccak256(await api.getCode(implementation)), libraries, deploy_tx: sent.txHash, deployer, core_sha: ctx.coreSha, deployed_at: (ctx.now?.() ?? new Date()).toISOString(),
  };
  manifest.implementation_deploys = [...list.filter((e) => e !== prior), entry];
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "deploy_implementation.done", { proxy: spec.name, implementation, code_hash: entry.code_hash, deploy_tx: sent.txHash });
  return { entry, reused: false, next: upgradeCommand(ctx, entry) };
}
