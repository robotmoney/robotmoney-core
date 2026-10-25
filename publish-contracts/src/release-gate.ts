// The contracts-freeze gate (core 1524). On chain 8453 the plan, and since issue 1816 every non-dry run that broadcasts (cli.ts releaseGated: publish, every deployer stage, safe,
// prove-control, govern, redeploy-vault; not verify alone, pause-all, record-receipt), refuses unless, in this order:
//   1. an annotated release/<version> tag points at DEPLOY_SHA, and the remote holds the same tag object (RELEASE_SHA_UNTAGGED, RELEASE_TAG_REMOTE_MISMATCH)
//      The TAG KIND must match the deployment kind of the sheet (issue 1727): a production plan needs release/<version>, a rehearsal plan needs release/<version>-rehearsal.
//      A rehearsal tag never satisfies a production plan and the reverse (RELEASE_TAG_KIND).
//   2. deployments/frozen-counts/<sha>.json exists for it                 (COUNTS_MISSING), and is committed and clean in its git work tree (COUNTS_UNTRACKED, issue 1816). A reconstructed baseline is also proven committed in the COUNTS checkout (issue 1740, gitFrozenDirCommitted)
//   3. a GitHub token is present and scripts/ci/check-sha-green.ts <sha> --repo robotmoney/robotmoney-core exits 0 (CI_NOT_GREEN); the repository is never the caller's GITHUB_REPOSITORY
//   Security round 2 (review: SECURITY_TRUST_ROOT): step 1 checks the tag on the canonical repository (the origin's effective URL must be robotmoney/robotmoney-core,
//   release-tag.ts verifyCanonicalRemoteTag).
//   Security round 3 (review: SECURITY_TRUST_ROOT): step 1 reads the local tags with replace refs off and a scrubbed environment, and asks the canonical repository
//   (its https URL, from outside the checkout) for the tag object and the commit it peels to, which must be the sha. A refs/replace ref, a GIT_DIR in the
//   environment or a repo-local config of the checkout under test can no longer make an untagged commit pass. The step 2 git status runs with replace refs off too.
//   (the single-vault redeploy, issue 1796, skips step 2: it has no frozen counts of its own)
// Each refusal happens before any signer is built. On the Twin chain none of these apply, so rehearsals keep measuring.
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { keccak256 } from "viem";
import { artifactJson } from "./verify/codehash.ts";
import { basename, dirname, resolve } from "node:path";
import { anchorChainOf, fileHashOf, frozenPath, loadFrozen, type FrozenFile } from "./counts.ts";
import { PublishError } from "./errors.ts";
import { gitEnv, scrubGitEnv } from "./git-env.ts";
import { spawnTool, type ProcessRunner } from "./runner.ts";
import { releaseTagsFor, tagKind, verifyCanonicalRemoteTag, type RemoteTagCheck } from "./release-tag.ts";
import type { DeploymentKind } from "./chains.ts";

export const CHECK_SHA_GREEN_SCRIPT = join("scripts", "ci", "check-sha-green.ts");
/**
 * Security round 1: the repository whose check runs prove a core sha green. It is named on the command line, never taken from GITHUB_REPOSITORY: inside the devops
 * repo's mainnet workflow that variable names the devops repo, so the gate asked GitHub about a core sha in the wrong repository and refused every 8453 run.
 * It is check-sha-green's own default (scripts/ci/check-sha-green.ts resolveRepo).
 */
export const CORE_REPO = "robotmoney/robotmoney-core";
export interface CiGreenResult { code: number; output: string }
/** Test seam. The real one runs `bun scripts/ci/check-sha-green.ts <sha> --repo <repo>` in `coreDir` with the caller's GitHub token. */
export type CheckShaGreen = (i: { coreDir: string; sha: string; repo: string; env: Record<string, string> }) => Promise<CiGreenResult>;

/** The argv of one check-sha-green run: the script, the sha and the repository, always named. */
export const checkShaGreenArgv = (sha: string, repo: string = CORE_REPO): string[] => ["bun", CHECK_SHA_GREEN_SCRIPT, sha, "--repo", repo];

export const spawnCheckShaGreen: CheckShaGreen = async (i) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(checkShaGreenArgv(i.sha, i.repo), { cwd: i.coreDir, env: i.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new PublishError("TOOL", `cannot start bun for check-sha-green: ${(e as Error).message}`);
  }
  const [out, err, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code, output: `${out}${err}` };
};

/**
 * Issue 1816: the frozen counts file must be committed and unmodified in its git work tree. `git status --porcelain --ignored` on that one path prints nothing.
 * Untracked, modified, staged-new and ignored files are refused, and a git that fails (no work tree) is refused too, never read as clean.
 */
export async function assertCountsTracked(run: ProcessRunner, countsDir: string, sha: string, env: Record<string, string> = {}): Promise<void> {
  const file = frozenPath(countsDir, sha);
  const r = await run("git", ["-C", countsDir, "status", "--porcelain", "--untracked-files=all", "--ignored", "--", file], { env });
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  if (r.code !== 0 || lines.length > 0) {
    const why = r.code !== 0 ? ` (git status failed: ${r.stderr.trim().split("\n").slice(-1)[0] ?? ""})` : `: ${lines.join("; ")}`;
    throw new PublishError("COUNTS_UNTRACKED", `the frozen counts file ${file} is not committed and clean in its git work tree${why}. Review it, commit it, and run again.`, { sha });
  }
}

export interface ReleaseGateInput {
  sha: string; coreDir: string; countsDir: string; env: Record<string, string | undefined>;
  /** The deployment kind of the sheet (issue 1727). Required: there is no default, so a caller cannot forget it. */
  kind: DeploymentKind;
  /** Test seams. Defaults: the real git tag read and the real check-sha-green. `releaseTag` names the one tag found at the sha (or none); `releaseTags` names every tag found. */
  releaseTag?: (coreDir: string, sha: string) => Promise<string | null>;
  releaseTags?: (coreDir: string, sha: string) => Promise<string[]>;
  checkShaGreen?: CheckShaGreen;
  /**
   * Default: the origin of the core checkout must be the canonical repository and hold the tag with the same tag object (RELEASE_TAG_REMOTE_MISMATCH,
   * release-tag.ts verifyCanonicalRemoteTag; the canonical check since security round 2).
   */
  remoteTag?: RemoteTagCheck;
  /**
   * Issue 1733: re-verifies a RECONSTRUCTED baseline (counts-reconstruct.ts) against the build and the chain at plan time. Required when the frozen file is a reconstruction:
   * without it the gate refuses (COUNTS_MISSING), because an offline load proves only the arithmetic, not the adoption records.
   */
  verifyReconstructed?: (file: FrozenFile) => Promise<void>;
  /**
   * Issue 1733: proves the anchor file of a reconstructed baseline (measured.crossChecked) is COMMITTED at the HEAD of the counts checkout with the bytes that were checked, so deleting or
   * swapping it in the working tree cannot hide the cross-check. Required when the file has a crossChecked record (COUNTS_MISSING without it). Default seam in the CLI: gitAnchorCommitted.
   */
  anchorCommitted?: (anchorPath: string, expectedHash: string) => Promise<void>;
  /**
   * Issue 1733 and 1740: the counts dir of a reconstructed baseline must be a clean dir of a checkout at the release sha or a descendant of it, tracking every frozen file in it with the
   * same bytes (gitFrozenDirCommitted). Required for any reconstructed file. Default seam in the CLI: gitFrozenDirCommitted.
   */
  frozenDirCommitted?: (countsDir: string) => Promise<void>;
  /**
   * Default true. False for the single-vault redeploy (issue 1796): it deploys one vault into a live deployment and has no frozen counts of its own (the counts file belongs to the
   * original deployment sha). The tag of the kind, the remote tag object and green CI are still required.
   */
  requireCounts?: boolean;
  /** Issue 1816: the runner of the tracked-and-clean check of the counts file (default: the real read-only git status) and the environment its git child gets. */
  run?: ProcessRunner;
  runEnv?: Record<string, string>;
}

const DUBIOUS = "git refuses a checkout owned by another user (safe.directory): the counts checkout must be owned by the operator";
/** `git --no-replace-objects -C dir args`: the output, or the refusal. A git that cannot run, and a git that fails, are told apart. */
function gitRead(git: string, dir: string, args: string[], what: string): { ok: boolean; out: Buffer; err: string } {
  const r = spawnSync(git, ["--no-replace-objects", "-C", dir, ...args], { maxBuffer: 1 << 24, env: gitEnv() });
  if (r.error || r.status === null) throw new PublishError("COUNTS_MISSING", `git could not run (${r.error?.message ?? "killed by a signal"}): ${what}`);
  const stderr = String(r.stderr);
  const last = stderr.trim().split("\n").pop() ?? "";
  return { ok: r.status === 0, out: r.stdout, err: /dubious ownership/.test(stderr) ? `${last} (${DUBIOUS})` : last };
}

export interface FrozenDirOptions { git?: string; /** Also require HEAD of the counts checkout to be an ancestor of (or equal to) its local refs/remotes/origin/dev. */ requireOriginDev?: boolean }

/**
 * Issue 1740: the counts dir of a reconstructed baseline is a directory of a git checkout of THIS repository, and that checkout proves the dir.
 * A baseline is named by the DEPLOY sha X, so its file can never be in the checkout at X (it holds X, the hash of a tree that would hold it). The release flow tags X, then merges the file
 * as a data-only commit Y after the tag. The operator runs the code from a clean checkout at X (`coreDir`) and the counts from a clean checkout at Y or later (`countsDir`). The proofs,
 * all run in the COUNTS checkout, nothing is read from the core checkout but its HEAD:
 *   1. countsDir is inside a git work tree, and the HEAD of that work tree is X or a descendant of X (so it holds X's whole history: the same repository, and the data came after the tag);
 *   2. every `<40 hex>.json` in the dir is tracked at HEAD with the same bytes (the baseline X.json, every anchor, any extra file), and every one tracked at HEAD is in the dir (no deleted anchor);
 *   3. the dir is clean: nothing modified and nothing untracked under it.
 */
export async function gitFrozenDirCommitted(coreDir: string, countsDir: string, opt: FrozenDirOptions | string = {}): Promise<void> {
  const o: FrozenDirOptions = typeof opt === "string" ? { git: opt } : opt;
  const git = o.git ?? "git";
  const head = gitRead(git, coreDir, ["rev-parse", "HEAD"], `the commit of the core checkout ${coreDir} cannot be read`);
  const x = head.out.toString().trim();
  if (!head.ok || !/^[0-9a-f]{40}$/.test(x)) throw new PublishError("COUNTS_MISSING", `cannot read HEAD of the core checkout ${coreDir}: ${head.err}`);
  const top = gitRead(git, countsDir, ["rev-parse", "--is-inside-work-tree"], `the counts dir ${countsDir} cannot be proven committed`);
  if (!top.ok) throw new PublishError("COUNTS_MISSING", `the counts dir ${countsDir} is not inside a git work tree (${top.err}): a reconstructed baseline needs the committed frozen-counts dir of a checkout of this repository at the release sha ${x} or a later commit`);
  const anc = gitRead(git, countsDir, ["merge-base", "--is-ancestor", x, "HEAD"], `the history of the counts checkout ${countsDir} cannot be read`);
  if (!anc.ok) throw new PublishError("COUNTS_MISSING", `HEAD of the counts checkout ${countsDir} is not a descendant of the release sha ${x} of the core checkout (or does not contain it): the counts come from a checkout of the same repository at ${x} or a later commit (the data-only commit that adds the baseline), not from an older or another repository`);
  const ls = gitRead(git, countsDir, ["ls-tree", "--name-only", "HEAD"], `the frozen files tracked in ${countsDir} cannot be listed`);
  if (!ls.ok) throw new PublishError("COUNTS_MISSING", `git ls-tree HEAD failed in ${countsDir}: ${ls.err}`);
  const frozen = /^[0-9a-f]{40}\.json$/;
  const tracked = new Set(ls.out.toString().split("\n").filter((n) => frozen.test(n)));
  const onDisk = readdirSync(resolve(countsDir)).filter((n) => frozen.test(n));
  for (const name of tracked) if (!onDisk.includes(name)) throw new PublishError("COUNTS_MISSING", `${name} is tracked at HEAD of ${countsDir} but missing from the counts dir: restore it (git checkout)`);
  for (const name of onDisk) {
    if (!tracked.has(name)) throw new PublishError("COUNTS_MISSING", `${name} in the counts dir ${countsDir} is not tracked at HEAD: commit it (the data-only commit after the release tag) and run from that checkout`);
    const committed = gitRead(git, countsDir, ["show", `HEAD:./${name}`], `${name} cannot be compared with its committed bytes`);
    if (!committed.ok || !committed.out.equals(readFileSync(resolve(countsDir, name)))) throw new PublishError("COUNTS_MISSING", `${name} in the counts dir ${countsDir} differs from the committed bytes at HEAD: restore the committed bytes (git checkout)`);
  }
  const st = gitRead(git, countsDir, ["status", "--porcelain", "--untracked-files=all", "--ignored", "--", "."], `the counts dir ${countsDir} cannot be checked for changes`);
  if (!st.ok) throw new PublishError("COUNTS_MISSING", `git status failed in ${countsDir}: ${st.err}`);
  const dirty = st.out.toString().split("\n").filter((l) => l.trim() !== "");
  if (dirty.length > 0) throw new PublishError("COUNTS_MISSING", `the counts dir ${countsDir} is not clean (${dirty.length}): ${dirty.slice(0, 5).join("; ")}. Commit or remove it (ignored files count too), the counts are read from a clean checkout`);
  if (o.requireOriginDev) {
    const od = gitRead(git, countsDir, ["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/dev"], `the counts checkout ${countsDir} cannot be compared with origin/dev`);
    if (!od.ok) throw new PublishError("COUNTS_MISSING", `HEAD of the counts checkout ${countsDir} is not reachable from its origin/dev (--counts-require-origin-dev): run 'git fetch origin dev' there and use a reviewed commit that is merged to dev (${od.err || "no refs/remotes/origin/dev"})`);
  }
}

/** The proofs a reconstructed baseline needs before anything is signed: the dir is the committed one, and every anchor of its chain is committed with the checked bytes. */
export async function assertBaselineCommitted(o: { countsDir: string; sha: string; frozen: FrozenFile; frozenDirCommitted?: (d: string) => Promise<void>; anchorCommitted?: (p: string, h: string) => Promise<void> }): Promise<void> {
  if (!o.frozen.measured.reconstructed) return;
  if (!o.frozenDirCommitted) throw new PublishError("COUNTS_MISSING", `the reconstructed baseline ${o.sha} needs a proof that the counts dir is the committed one and none was given: refused`, { sha: o.sha });
  await o.frozenDirCommitted(o.countsDir);
  for (const hop of anchorChainOf(o.countsDir, o.sha)) {
    if (!o.anchorCommitted) throw new PublishError("COUNTS_MISSING", `the reconstructed baseline names the anchor ${hop.sha} and there is no way to prove it is committed: refused`, { sha: o.sha });
    await o.anchorCommitted(join(o.countsDir, `${hop.sha}.json`), hop.fileHash);
  }
}

/** The anchor file at `abs` must be a tracked file of the git checkout that holds it, equal at HEAD to the bytes whose sha256 is `expectedHash` (the counts checkout, not the core checkout). */
export async function gitAnchorCommitted(abs: string, expectedHash: string, git = "git"): Promise<void> {
  const file = resolve(abs);
  const rel = basename(file);
  const r = spawnSync(git, ["--no-replace-objects", "-C", dirname(file), "show", `HEAD:./${rel}`], { maxBuffer: 1 << 24, env: gitEnv() });
  if (r.error || r.status === null) throw new PublishError("COUNTS_MISSING", `git could not run (${r.error?.message ?? "killed by a signal"}): the anchor file ${rel} cannot be proven committed`);
  if (r.status !== 0) throw new PublishError("COUNTS_MISSING", `the anchor file ${file} is not committed at HEAD of its checkout (git show: ${String(r.stderr).trim().split("\n").pop() ?? ""}): commit the earlier frozen file the baseline was cross-checked against`);
  if (fileHashOf(r.stdout) !== expectedHash) throw new PublishError("COUNTS_MISSING", `the anchor file ${rel} committed at HEAD differs from the bytes the baseline was cross-checked against: restore the committed bytes`);
}

/**
 * The release tag of the sha that satisfies the deployment kind. Throws RELEASE_SHA_UNTAGGED when no annotated release tag points at the sha, and
 * RELEASE_TAG_KIND when tags exist but none is of the kind the sheet asks for.
 */
export async function tagForKind(i: Pick<ReleaseGateInput, "sha" | "coreDir" | "kind" | "releaseTag" | "releaseTags">): Promise<string | null> {
  const found = i.releaseTags ? await i.releaseTags(i.coreDir, i.sha) : i.releaseTag ? [await i.releaseTag(i.coreDir, i.sha)].filter((t): t is string => !!t) : await releaseTagsFor(i.coreDir, i.sha);
  if (found.length === 0) return null;
  const match = found.filter((t) => tagKind(t) === i.kind).sort()[0];
  if (match) return match;
  const want = i.kind === "rehearsal" ? "release/<version>-rehearsal" : "release/<version> (no -rehearsal suffix)";
  const have = found.map((t) => `${t} (${tagKind(t)})`).join(", ");
  throw new PublishError("RELEASE_TAG_KIND", `the sheet says DEPLOYMENT_KIND ${i.kind} and needs an annotated ${want} tag at ${i.sha}, but the tag(s) there are: ${have}. A rehearsal tag never satisfies a production deployment and a production tag never satisfies a rehearsal.`, { sha: i.sha, kind: i.kind, tags: found });
}

/** Returns the release tag name. Throws RELEASE_SHA_UNTAGGED, RELEASE_TAG_KIND, COUNTS_MISSING, COUNTS_UNTRACKED or CI_NOT_GREEN. */
export async function assertReleaseGate(i: ReleaseGateInput): Promise<string> {
  const tag = await tagForKind(i);
  if (!tag) throw new PublishError("RELEASE_SHA_UNTAGGED", `DEPLOY_SHA ${i.sha} is not a release SHA: no annotated release/<version>${i.kind === "rehearsal" ? "-rehearsal" : ""} tag in ${i.coreDir} points at it. Tag the release SHA, rehearse on the Twin chain at that SHA, commit its frozen counts, then plan.`, { sha: i.sha });
  // security round 3: the sha goes with the tag, so the canonical repository must peel the tag to it (a local peel alone is no proof: release-tag.ts)
  await (i.remoteTag ?? ((d, t, s) => verifyCanonicalRemoteTag(d, t, undefined, s)))(i.coreDir, tag, i.sha);
  const frozen = i.requireCounts === false ? undefined : loadFrozen(i.countsDir, i.sha); // throws COUNTS_MISSING; a reconstructed baseline is also verified against the stage table here
  // Issue 1816: a measured file must be committed and clean (COUNTS_UNTRACKED). A reconstructed baseline gets the stricter whole-dir proof below instead (gitFrozenDirCommitted, COUNTS_MISSING).
  if (frozen && !frozen.measured.reconstructed) await assertCountsTracked(i.run ?? spawnTool, i.countsDir, i.sha, scrubGitEnv(i.runEnv ?? gitEnv())); // replace refs off, no GIT_* of the caller (security round 3)
  if (frozen?.measured.reconstructed) {
    if (!i.verifyReconstructed) throw new PublishError("COUNTS_MISSING", `deployments/frozen-counts/${i.sha}.json is a reconstructed baseline (issue 1733) and the gate has no way to re-verify it on chain: it is refused`, { sha: i.sha });
    await i.verifyReconstructed(frozen); // throws LIBS_ADOPTION when a record differs from the build or the chain
    await assertBaselineCommitted({ countsDir: i.countsDir, sha: i.sha, frozen, frozenDirCommitted: i.frozenDirCommitted, anchorCommitted: i.anchorCommitted });
  }
  const token = i.env.GITHUB_TOKEN || i.env.GH_TOKEN;
  if (!token) throw new PublishError("CI_NOT_GREEN", `cannot check that CI is green at ${i.sha}: GITHUB_TOKEN is not set. The check is never skipped on 8453.`, { sha: i.sha });
  const env: Record<string, string> = { GITHUB_TOKEN: token };
  // GITHUB_REPOSITORY is not forwarded: the repository is CORE_REPO, named on the command line (security round 1).
  for (const k of ["PATH", "HOME"]) if (i.env[k]) env[k] = i.env[k]!;
  const r = await (i.checkShaGreen ?? spawnCheckShaGreen)({ coreDir: i.coreDir, sha: i.sha, repo: CORE_REPO, env });
  if (r.code !== 0) {
    const lines = r.output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    throw new PublishError("CI_NOT_GREEN", `CI is not green at ${i.sha} (check-sha-green exit ${r.code}): ${lines.slice(0, 12).join(" | ")}`, { sha: i.sha, exit: r.code });
  }
  return tag;
}

/**
 * Review-security-001 (issue 1927): the rc checkout a governed upgrade deploys from. Runbook 4.15 names the LIVE v0.5.0 checkout as --core-dir, so the release gate above proves that
 * sha (tagged, counted, green), and the rc checkout given as --upgrade-build needs its own proof, before any signer exists: its HEAD, a clean tracked tree, an annotated rc tag of the
 * sheet's kind at HEAD (release/vA.B.C-rc.N, with -rehearsal on a rehearsal), that tag on the canonical repository with the same commit, the tagged commit on the release branch
 * releases-A.B.x of the origin, and green CI at it. No counts: an rc build deploys implementations, not the stages.
 * The build output out/ is gitignored, so the tree checks alone prove nothing about it (review-security-003). The gate therefore also proves that the build artifacts the verb
 * deploys and compares with (`artifacts`: the proxy's implementation contract and every library it links, transitively) were compiled from this tree: every source their solc
 * metadata names is a tracked file of the checkout (its submodules included) whose bytes hash to the keccak256 the metadata records. The tree is clean, so those bytes are HEAD's.
 * Review-security-004: each artifact's compiler settings must also be what the tree's own foundry config yields (`forge config --json` in the checkout, every FOUNDRY_ and
 * DAPP_ variable scrubbed): the compiler version, the optimizer, the EVM version, viaIR, the metadata bytecodeHash and the remappings. It does not prove a setting outside that
 * list or the forge binary itself (issue 1926 pins it); the deployed code is still read back against the artifact by the verb. Returns the sha and the tag.
 */
export const RC_TAG_PATTERN = /^release\/v(\d+)\.(\d+)\.\d+-rc\.\d+(?:-rehearsal)?$/;
export interface UpgradeBuildGateInput {
  dir: string; kind: DeploymentKind; env: Record<string, string | undefined>; chainId: number;
  /** The read-only git status of the work tree (isomorphism.ts dirtyTreeLines over the CLI's runner). */
  dirty: (dir: string) => Promise<string[]>;
  readHead: (dir: string) => string | undefined;
  releaseTag?: ReleaseGateInput["releaseTag"]; releaseTags?: ReleaseGateInput["releaseTags"]; remoteTag?: RemoteTagCheck; checkShaGreen?: CheckShaGreen;
  /** Test seam: the tagged commit is an ancestor of (or equal to) refs/remotes/origin/<branch>. Default: git merge-base --is-ancestor, replace refs off. */
  onBranch?: (dir: string, sha: string, branch: string) => Promise<boolean>;
  /** Review-security-003: the build artifacts (names under <dir>/out) whose sources must be this tree's. Empty or absent: none (the verb names them). */
  artifacts?: string[];
  /** Test seam: the paths of `paths` git tracks in the checkout, submodules included. Default: git ls-files --recurse-submodules, replace refs off. */
  trackedFiles?: (dir: string, paths: string[]) => Promise<Set<string>>;
  /** Test seam (review-security-004): the tree's foundry config. Default: `forge config --json` in the checkout under a scrubbed environment. */
  forgeConfig?: (dir: string) => Promise<ForgeBuildConfig>;
}
/** The keys of `forge config --json` the build settings are compared with (review-security-004). */
export interface ForgeBuildConfig { solc?: string | null; solc_version?: string | null; optimizer?: boolean; optimizer_runs?: number; evm_version?: string; via_ir?: boolean; bytecode_hash?: string; remappings?: string[] }
export const defaultForgeConfig = async (dir: string): Promise<ForgeBuildConfig> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(FOUNDRY_|DAPP_)/.test(k)) env[k] = v;
  const r = spawnSync("forge", ["config", "--json"], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new PublishError("USAGE", `forge config --json failed in ${dir}: ${String(r.stderr ?? "").trim().split("\n").slice(-1)[0] ?? ""}`);
  return JSON.parse(String(r.stdout)) as ForgeBuildConfig;
};

/** Review-security-004: why one artifact's solc metadata was not compiled with the tree's config. `dir` is the checkout: a remapping context under it is read relative to it. */
export function buildSettingsProblems(name: string, meta: any, cfg: ForgeBuildConfig, dir: string): string[] {
  const out: string[] = [];
  const st = meta?.settings ?? {};
  const solc = cfg.solc_version ?? cfg.solc;
  const version = String(meta?.compiler?.version ?? "").split("+")[0];
  if (!solc) out.push(`the tree's foundry config pins no solc version, so the ${name} compiler (${version || "unknown"}) cannot be tied to it`);
  else if (version !== String(solc).replace(/^v/, "")) out.push(`the ${name} artifact was compiled with solc ${version || "unknown"}, the tree's config pins ${solc}`);
  const opt = st.optimizer ?? {};
  if ((opt.enabled === true) !== (cfg.optimizer === true) || (cfg.optimizer === true && Number(opt.runs) !== Number(cfg.optimizer_runs))) out.push(`the ${name} artifact's optimizer is ${JSON.stringify(opt)}, the tree's config is enabled ${cfg.optimizer} runs ${cfg.optimizer_runs}`);
  if (String(st.evmVersion ?? "").toLowerCase() !== String(cfg.evm_version ?? "").toLowerCase()) out.push(`the ${name} artifact's evmVersion is ${st.evmVersion}, the tree's config is ${cfg.evm_version}`);
  if ((st.viaIR === true) !== (cfg.via_ir === true)) out.push(`the ${name} artifact's viaIR is ${st.viaIR === true}, the tree's config is ${cfg.via_ir === true}`);
  if (String(st.metadata?.bytecodeHash ?? "ipfs") !== String(cfg.bytecode_hash ?? "ipfs")) out.push(`the ${name} artifact's metadata bytecodeHash is ${st.metadata?.bytecodeHash}, the tree's config is ${cfg.bytecode_hash}`);
  // solc records a remapping's context as an absolute path under the build directory, and forge also passes the relative form: both are the same remapping
  const root = `${dir.replace(/\/+$/, "")}/`;
  const norm = (list: unknown): string[] => [...new Set((Array.isArray(list) ? list : []).map((r) => String(r)).map((r) => (r.startsWith(root) ? r.slice(root.length) : r)))].sort();
  const got = norm(st.remappings), want = norm(cfg.remappings);
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`the ${name} artifact's remappings are not the tree's config's (only in the artifact: ${got.filter((r) => !want.includes(r)).join(", ") || "none"}; only in the config: ${want.filter((r) => !got.includes(r)).join(", ") || "none"})`);
  return out;
}
const defaultTrackedFiles = async (dir: string, paths: string[]): Promise<Set<string>> => {
  const r = spawnSync("git", ["--no-replace-objects", "-C", dir, "ls-files", "--recurse-submodules", "-z", "--", ...paths], { env: gitEnv(), maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new PublishError("USAGE", `git ls-files failed in ${dir}: ${String(r.stderr ?? "").trim().split("\n").slice(-1)[0] ?? ""}`);
  return new Set(String(r.stdout).split("\0").filter(Boolean));
};

/**
 * Review-security-003: why the named artifacts of `dir`/out were not compiled from the tree of `dir`, transitively over the libraries each links. An empty list proves it: every
 * source in each artifact's solc metadata is tracked and hashes (keccak256 of the working-tree bytes) to the metadata's value.
 */
export async function buildProvenanceProblems(dir: string, artifacts: readonly string[], tracked: (dir: string, paths: string[]) => Promise<Set<string>> = defaultTrackedFiles, config?: ForgeBuildConfig): Promise<string[]> {
  const out = join(dir, "out");
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [...artifacts];
  const sources = new Map<string, { hash: string; artifact: string }>();
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    let art: any;
    try { art = artifactJson(out, name); } catch (e) { problems.push((e as Error).message); continue; }
    const meta = typeof art.metadata === "object" && art.metadata ? art.metadata : typeof art.rawMetadata === "string" ? JSON.parse(art.rawMetadata) : undefined;
    const src = meta?.sources;
    if (!src || typeof src !== "object" || Object.keys(src).length === 0) { problems.push(`the ${name} artifact carries no solc metadata sources, so its build cannot be tied to the tree`); continue; }
    if (config) problems.push(...buildSettingsProblems(name, meta, config, dir));
    for (const [path, v] of Object.entries<any>(src)) {
      if (typeof v?.keccak256 !== "string") { problems.push(`the ${name} artifact names ${path} with no keccak256`); continue; }
      const prev = sources.get(path);
      if (prev && prev.hash.toLowerCase() !== v.keccak256.toLowerCase()) problems.push(`${path} is ${prev.hash} in the ${prev.artifact} artifact and ${v.keccak256} in the ${name} artifact`);
      sources.set(path, { hash: v.keccak256, artifact: name });
    }
    for (const file of Object.values<any>(art.deployedBytecode?.linkReferences ?? {})) for (const lib of Object.keys(file)) queue.push(lib);
  }
  const paths = [...sources.keys()];
  const known = paths.length ? await tracked(dir, paths) : new Set<string>();
  for (const [path, { hash, artifact }] of sources) {
    if (!known.has(path)) { problems.push(`${path} (a source of the ${artifact} artifact) is not a tracked file of the checkout`); continue; }
    let bytes: Buffer;
    try { bytes = readFileSync(join(dir, path)); } catch { problems.push(`${path} (a source of the ${artifact} artifact) is missing from the checkout`); continue; }
    const got = keccak256(bytes);
    if (got.toLowerCase() !== hash.toLowerCase()) problems.push(`${path}: the ${artifact} artifact was built from bytes with keccak256 ${hash}, the checkout holds ${got}`);
  }
  return problems;
}
const defaultOnBranch = async (dir: string, sha: string, branch: string): Promise<boolean> => {
  const r = spawnSync("git", ["--no-replace-objects", "-C", dir, "merge-base", "--is-ancestor", sha, `refs/remotes/origin/${branch}`], { env: gitEnv() });
  return r.status === 0;
};
export async function assertUpgradeBuildGate(i: UpgradeBuildGateInput): Promise<{ sha: string; tag: string }> {
  const refuse = (kind: "RELEASE_SHA_UNTAGGED" | "USAGE" | "CI_NOT_GREEN", why: string, d: Record<string, unknown> = {}): never => {
    throw new PublishError(kind, `--upgrade-build ${i.dir}: ${why}. The rc build is gated like a DEPLOY_SHA (runbook 4.14, 4.15 step 0); no signer was built, nothing was sent.`, { upgrade_build: i.dir, ...d });
  };
  const sha = i.readHead(i.dir);
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) return refuse("USAGE", "is not a git checkout with a readable HEAD");
  const dirty = await i.dirty(i.dir);
  if (dirty.length > 0) refuse("USAGE", `has uncommitted changes (${dirty.length}): ${dirty.slice(0, 5).join("; ")}`, { dirty: dirty.slice(0, 20) });
  if (i.artifacts?.length) {
    const stale = await buildProvenanceProblems(i.dir, i.artifacts, i.trackedFiles, await (i.forgeConfig ?? defaultForgeConfig)(i.dir));
    if (stale.length) refuse("USAGE", `its out/ was not built from its tree (run forge build in it): ${stale.slice(0, 5).join("; ")}${stale.length > 5 ? ` (and ${stale.length - 5} more)` : ""}`, { stale: stale.slice(0, 20) });
  }
  const found = i.releaseTags ? await i.releaseTags(i.dir, sha) : i.releaseTag ? [await i.releaseTag(i.dir, sha)].filter((t): t is string => !!t) : await releaseTagsFor(i.dir, sha);
  const tag = found.filter((t) => RC_TAG_PATTERN.test(t) && tagKind(t) === i.kind).sort()[0];
  if (!tag) refuse("RELEASE_SHA_UNTAGGED", `HEAD ${sha} carries no annotated rc tag of kind ${i.kind} (release/vA.B.C-rc.N${i.kind === "rehearsal" ? "-rehearsal" : ""}); tags there: ${found.join(", ") || "none"}`, { sha, tags: found });
  await (i.remoteTag ?? ((d, t, s) => verifyCanonicalRemoteTag(d, t, undefined, s)))(i.dir, tag!, sha);
  const m = RC_TAG_PATTERN.exec(tag!)!;
  const branch = `releases-${m[1]}.${m[2]}.x`;
  if (!(await (i.onBranch ?? defaultOnBranch)(i.dir, sha, branch))) refuse("USAGE", `the rc ${tag} at ${sha} is not on origin/${branch} (fetch it, or the tag is on a QA branch or on dev)`, { sha, tag, branch });
  const token = i.env.GITHUB_TOKEN || i.env.GH_TOKEN;
  if (!token) refuse("CI_NOT_GREEN", `cannot check that CI is green at ${sha}: GITHUB_TOKEN is not set. The check is never skipped on 8453`, { sha });
  const env: Record<string, string> = { GITHUB_TOKEN: token! };
  for (const k of ["PATH", "HOME"]) if (i.env[k]) env[k] = i.env[k]!;
  const r = await (i.checkShaGreen ?? spawnCheckShaGreen)({ coreDir: i.dir, sha, repo: CORE_REPO, env });
  if (r.code !== 0) refuse("CI_NOT_GREEN", `CI is not green at ${sha} (check-sha-green exit ${r.code}): ${r.output.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 12).join(" | ")}`, { sha, exit: r.code });
  return { sha, tag: tag! };
}
