// Security round 1 (review: SECURITY_PROVENANCE_BYPASS, SECURITY_TRUST_ROOT): where the build an upgrade-proxy or freeze-proxy round compares with came from.
// Before, `--admin-arg build=DIR` was taken as given: any forge out/ the operator named became "the reviewed build", and on 8453 the release gate covered only the
// deployment checkout (--core-sha), never the code the round installs or freezes. Now the build is bound to a git checkout and, on 8453, to a release:
//   - DIR must sit inside a git checkout (the .git found by walking up from DIR); its HEAD is the build's sha (`build_sha` in the round's record and evidence);
//   - on chain 8453 that checkout must be clean and its HEAD must pass the release gate of the sheet's kind without counts (release-gate.ts assertReleaseGate,
//     requireCounts false): an annotated release tag of the kind, the same tag object on the remote, green CI. A refusal is the gate's own kind
//     (RELEASE_SHA_UNTAGGED, RELEASE_TAG_KIND, RELEASE_TAG_REMOTE_MISMATCH, CI_NOT_GREEN) or GOVERN, and comes before anything is scheduled;
//   - the deployment checkout itself at the deployment sha is already gated by the CLI (cli.ts releaseGated), so it is accepted as is ("deploy-checkout").
// Off 8453 the sha is recorded when DIR is in a checkout and nothing is refused: a Twin rehearsal compares with its own checkout.
// Security round 2 (review: SECURITY_PROVENANCE_BYPASS): the proof above binds the checkout's HEAD, but the forge out/ the code is compared with is git-ignored, so a
// clean, tagged, green checkout could hold artifacts of any other source (a stale build of a feature branch, or a planted one), and an ignored out/ deeper in the
// deployment checkout passed as "deploy-checkout" with no gate at all. On 8453 the build is now also bound to the commit's sources, on both paths (release gate and
// deploy checkout):
//   - DIR must be exactly `<checkout>/out` (forge's out = "out", foundry.toml);
//   - every artifact the round compares (the proxied contract, `artifacts`) and every library it links, recursively, must carry compiler metadata whose compilation
//     target is that contract and whose every source hash (metadata.sources[*].keccak256) equals keccak256 of that file committed at the build's sha, read with git from
//     the commit (submodule gitlinks followed), never from the working tree (artifactSourceProblems). A stale or foreign artifact is refused with GOVERN.
// What this does not prove: solc's metadata is a claim the artifact makes, so a hand-forged artifact that copies the reviewed metadata next to other bytecode is not
// caught here; only a rebuild at the sha would catch it. The release gate, the Safe signers' review and the verify of the round stay the controls for that case.
// This module also reads a checkout's storage-layout snapshot (ADR-0014 §8): contracts/test/fixtures/storage-layout/<Artifact>.json and its identifier, 0x + sha256 of
// the file's bytes (the identifier the deploy scripts write as `<field>_layout_id`, GovernedProxyDeploy._layoutId).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { keccak256 } from "viem";
import { PublishError } from "./errors.ts";
import { gitEnv } from "./git-env.ts";
import { readGitHead } from "./isomorphism.ts";
import { BASE_CHAIN_ID } from "./rehearsal/twin.ts";
import { artifactPathOf } from "./verify/codehash.ts";

/** How a build directory was proven. */
export type BuildProof = "release-gate" | "deploy-checkout" | "checkout-sha" | "none";

export interface BuildProvenance {
  /** The build directory, absolute. */
  dir: string;
  /** The root of the git checkout that holds `dir`. Undefined: `dir` is in no checkout (refused on 8453). */
  checkout?: string;
  /** HEAD of that checkout: the sha the build was made from. */
  sha?: string;
  /** The release tag the gate found at `sha` (8453 only). */
  tag?: string;
  proof: BuildProof;
  /** Security round 2 (8453): the artifacts proven compiled from the sources committed at `sha`, the linked libraries included. */
  sourcesProven?: string[];
}

/** The release gate of one build checkout: returns the release tag, or throws the gate's refusal. The govern row passes the sheet's kind and the CLI's seams. */
export type BuildGate = (i: { checkout: string; sha: string }) => Promise<string>;

/** The root of the git checkout that holds `dir` (a `.git` directory or file, found by walking up), or undefined. */
export function checkoutRootOf(dir: string): string | undefined {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** HEAD of the checkout that holds `dir`, or undefined outside a checkout. */
export const checkoutShaOfDir = (dir: string): string | undefined => {
  const root = checkoutRootOf(dir);
  return root ? readGitHead(root) : undefined;
};

/** `git status --porcelain --untracked-files=all` of a checkout: one line per change. Ignored files (a forge out/) are not changes. */
export function gitDirtyLines(root: string, git = "git"): string[] {
  const r = spawnSync(git, ["--no-replace-objects", "-C", root, "status", "--porcelain", "--untracked-files=all"], { maxBuffer: 1 << 24, env: gitEnv() });
  if (r.error || r.status !== 0) throw new PublishError("GOVERN", `git status failed in the build checkout ${root}: ${r.error?.message ?? String(r.stderr).trim().split("\n").pop() ?? "unknown error"}. Nothing was sent`, { checkout: root });
  return String(r.stdout).split("\n").filter((l) => l.trim() !== "");
}

/** The bytes of each path at commit `sha` of the git checkout `root`, submodule gitlinks followed; undefined for a path that is no file of that tree. */
export type TreeReader = (root: string, sha: string, paths: readonly string[]) => Map<string, Buffer | undefined>;

function gitRun(root: string, args: string[], input?: string): { ok: boolean; out: Buffer; err: string } {
  const r = spawnSync("git", ["--no-replace-objects", "-C", root, ...args], { maxBuffer: 1 << 28, env: gitEnv(), ...(input !== undefined ? { input } : {}) });
  if (r.error || r.status === null) throw new PublishError("GOVERN", `git could not run in ${root} (${r.error?.message ?? "killed by a signal"}): the build's sources cannot be read. Nothing was sent`, { checkout: root });
  return { ok: r.status === 0, out: r.stdout, err: String(r.stderr).trim().split("\n").pop() ?? "" };
}

/** A relative path inside a tree: no leading slash, no `.` or `..` part, no line break (git cat-file --batch reads one name per line). */
const treePath = (p: string): boolean => p !== "" && !p.startsWith("/") && !/[\n\r\0]/.test(p) && !p.split("/").some((x) => x === "" || x === "." || x === "..");

/**
 * Security round 2: the committed bytes of `paths` at `sha`, read from git objects (`git cat-file --batch`), never from the working tree. A path under a submodule is
 * read from that submodule's repository at the commit the tree's gitlink pins (lib/openzeppelin-contracts and the others), recursively.
 */
export const gitTreeReader: TreeReader = (root, sha, paths) => {
  const out = new Map<string, Buffer | undefined>();
  const wanted = paths.filter((p) => (treePath(p) ? true : (out.set(p, undefined), false)));
  if (wanted.length === 0) return out;
  const ls = gitRun(root, ["ls-tree", "-r", "-z", sha]);
  if (!ls.ok) throw new PublishError("GOVERN", `git ls-tree ${sha} failed in ${root}: ${ls.err}. The build's sources cannot be read. Nothing was sent`, { checkout: root, sha });
  const subs: { path: string; commit: string }[] = [];
  for (const entry of ls.out.toString("utf8").split("\0")) {
    const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (m) subs.push({ path: m[2]!, commit: m[1]! });
  }
  const own: string[] = [];
  const inSub = new Map<string, { commit: string; paths: Map<string, string> }>();
  for (const p of wanted) {
    const sub = subs.filter((x) => p.startsWith(`${x.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!sub) { own.push(p); continue; }
    const e = inSub.get(sub.path) ?? { commit: sub.commit, paths: new Map<string, string>() };
    e.paths.set(p.slice(sub.path.length + 1), p);
    inSub.set(sub.path, e);
  }
  if (own.length > 0) {
    const r = gitRun(root, ["cat-file", "--batch"], own.map((p) => `${sha}:${p}\n`).join(""));
    if (!r.ok) throw new PublishError("GOVERN", `git cat-file failed in ${root}: ${r.err}. The build's sources cannot be read. Nothing was sent`, { checkout: root, sha });
    let at = 0;
    for (const p of own) {
      const nl = r.out.indexOf(0x0a, at);
      if (nl < 0) { out.set(p, undefined); continue; }
      const head = r.out.subarray(at, nl).toString("utf8").split(" ");
      at = nl + 1;
      if (head.length !== 3 || !/^\d+$/.test(head[2]!)) { out.set(p, undefined); continue; } // `<name> missing` or `<name> ambiguous`
      const size = Number(head[2]);
      out.set(p, head[1] === "blob" ? Buffer.from(r.out.subarray(at, at + size)) : undefined);
      at += size + 1;
    }
  }
  for (const [sp, e] of inSub) {
    const inner = gitTreeReader(join(root, sp), e.commit, [...e.paths.keys()]);
    for (const [rest, full] of e.paths) out.set(full, inner.get(rest));
  }
  return out;
};

/** The libraries one artifact links (forge's deployedBytecode.linkReferences), by contract name. */
const linkedNames = (j: any): string[] => Object.values<any>(j?.deployedBytecode?.linkReferences ?? {}).flatMap((file) => Object.keys(file ?? {}));

/**
 * Security round 2 (see the header): why the artifacts `artifacts` in the forge out/ `dir`, and every library they link (recursively), are not the build of the sources
 * committed at `sha` in `checkout`. Empty: each carries compiler metadata (rawMetadata and metadata, both read when present) whose compilation target is that contract
 * and whose every source hash equals keccak256 of the committed file. `read` is a test seam (default: gitTreeReader).
 */
export function artifactSourceProblems(o: { dir: string; checkout: string; sha: string; artifacts: readonly string[]; read?: TreeReader }): string[] {
  const problems: string[] = [];
  /** source path -> each keccak256 an artifact names for it -> the first artifact that names it */
  const want = new Map<string, Map<string, string>>();
  const queue = [...o.artifacts];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    let j: any;
    try { j = JSON.parse(readFileSync(artifactPathOf(o.dir, name), "utf8")); } catch (e) { problems.push(`${name}: no readable build artifact in ${o.dir} (${(e as Error).message})`); continue; }
    const metas: any[] = [];
    if (typeof j?.rawMetadata === "string") { try { metas.push(JSON.parse(j.rawMetadata)); } catch { problems.push(`${name}: the artifact's rawMetadata is not JSON`); } }
    if (j?.metadata && typeof j.metadata === "object") metas.push(j.metadata);
    if (metas.length === 0) problems.push(`${name}: the artifact carries no compiler metadata, so nothing ties it to the sources at ${o.sha}`);
    for (const m of metas) {
      const target = m?.settings?.compilationTarget;
      const entries = target && typeof target === "object" && !Array.isArray(target) ? Object.entries(target) : [];
      if (entries.length !== 1 || entries[0]![1] !== name) problems.push(`${name}: the artifact's compilation target is ${JSON.stringify(target ?? null)}, not the contract ${name}`);
      const sources = m?.sources && typeof m.sources === "object" && !Array.isArray(m.sources) ? Object.entries<any>(m.sources) : [];
      if (sources.length === 0) problems.push(`${name}: the artifact's metadata lists no sources`);
      else if (entries.length === 1 && !sources.some(([p]) => p === entries[0]![0])) problems.push(`${name}: the artifact's metadata does not list its own source ${entries[0]![0]}`);
      for (const [p, src] of sources) {
        const h = typeof src?.keccak256 === "string" ? src.keccak256.toLowerCase() : "";
        if (!/^0x[0-9a-f]{64}$/.test(h)) { problems.push(`${name}: the metadata names ${p} with no keccak256`); continue; }
        const hashes = want.get(p) ?? new Map<string, string>();
        if (hashes.size > 0 && !hashes.has(h)) problems.push(`${name} and ${[...hashes.values()][0]} were compiled from different versions of ${p}: the out/ mixes builds`);
        if (!hashes.has(h)) hashes.set(h, name);
        want.set(p, hashes);
      }
    }
    queue.push(...linkedNames(j));
  }
  if (want.size > 0) {
    const bytes = (o.read ?? gitTreeReader)(o.checkout, o.sha, [...want.keys()]);
    for (const [p, hashes] of want) {
      const b = bytes.get(p);
      const committed = b === undefined ? undefined : keccak256(b).toLowerCase();
      for (const [h, by] of hashes) {
        if (committed === undefined) problems.push(`${by} was compiled from ${p}, which is no file of the tree at ${o.sha}`);
        else if (committed !== h) problems.push(`${by} was compiled from a ${p} that differs from the one committed at ${o.sha}`);
      }
    }
  }
  return problems;
}

/** The names `artifacts` reaches: each named one and every library it links, recursively (an unreadable artifact ends its branch). */
function linkedClosure(dir: string, artifacts: readonly string[]): string[] {
  const out: string[] = [];
  const queue = [...artifacts];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (out.includes(name)) continue;
    out.push(name);
    try { queue.push(...linkedNames(JSON.parse(readFileSync(artifactPathOf(dir, name), "utf8")))); } catch { /* artifactSourceProblems names it */ }
  }
  return out;
}

/**
 * Proves one build directory before an upgrade or a freeze is planned (see the header). `coreDir`/`coreSha`: the deployment checkout the CLI gated. `artifacts`: the
 * contracts the round compares with this build (security round 2: on 8453 each, and every library it links, must be compiled from the sources at the build's sha).
 * `dirty`, `head` and `read` are test seams (defaults: git status, the checkout's HEAD file, gitTreeReader).
 */
export async function proveBuild(o: {
  dir: string; chainId: number; coreDir: string; coreSha: string; gate: BuildGate; row: string; artifacts?: readonly string[];
  dirty?: (root: string) => string[]; head?: (root: string) => string | undefined; read?: TreeReader;
}): Promise<BuildProvenance> {
  const dir = resolve(o.dir);
  const mainnet = o.chainId === BASE_CHAIN_ID;
  const root = checkoutRootOf(dir);
  const sha = root ? (o.head ?? readGitHead)(root) : undefined;
  if (!root || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
    if (!mainnet) return { dir, proof: "none" };
    throw new PublishError("GOVERN", `govern row ${o.row}: the build ${dir} is not inside a git checkout with a readable HEAD. On chain 8453 the build a round compares the code with must be the forge out/ of a clean checkout at a release-tagged sha with green CI, so the evidence can name the reviewed commit. Nothing was sent`, { row: o.row, build: dir });
  }
  // security round 2: on 8453 the build is the checkout's own out/ (an ignored directory elsewhere under the checkout is tied to nothing), on both paths below
  if (mainnet && dir !== join(root, "out")) throw new PublishError("GOVERN", `govern row ${o.row}: the build ${dir} is not the forge out/ of its checkout (${join(root, "out")}). On chain 8453 the build is the checkout's own out/, built at its HEAD. Nothing was sent`, { row: o.row, build: dir, checkout: root });
  /** On 8453: every artifact the round compares, and every library it links, compiled from the sources committed at `sha`; else GOVERN before anything is sent. */
  const sourcesProven = (): string[] | undefined => {
    if (!mainnet || !o.artifacts || o.artifacts.length === 0) return undefined;
    const problems = artifactSourceProblems({ dir, checkout: root, sha, artifacts: o.artifacts, read: o.read });
    if (problems.length > 0) throw new PublishError("GOVERN", `govern row ${o.row}: the build ${dir} is not the build of the sources committed at ${sha} (${problems.length} problem${problems.length === 1 ? "" : "s"}): ${problems.slice(0, 5).join("; ")}. Rebuild it at that commit (forge build in the clean checkout) and run again. Nothing was sent`, { row: o.row, build: dir, sha, problems: problems.slice(0, 20) });
    return linkedClosure(dir, o.artifacts);
  };
  if (resolve(root) === resolve(o.coreDir) && sha === o.coreSha) {
    const proven = sourcesProven();
    return { dir, checkout: root, sha, proof: "deploy-checkout", ...(proven ? { sourcesProven: proven } : {}) };
  }
  if (!mainnet) return { dir, checkout: root, sha, proof: "checkout-sha" };
  const dirty = (o.dirty ?? gitDirtyLines)(root);
  if (dirty.length > 0) throw new PublishError("GOVERN", `govern row ${o.row}: the build checkout ${root} has uncommitted changes (${dirty.length}): ${dirty.slice(0, 5).join("; ")}. The build must be the release commit exactly. Nothing was sent`, { row: o.row, checkout: root, dirty: dirty.slice(0, 20) });
  const tag = await o.gate({ checkout: root, sha });
  const proven = sourcesProven();
  return { dir, checkout: root, sha, tag, proof: "release-gate", ...(proven ? { sourcesProven: proven } : {}) };
}

/** The storage-layout snapshot of `artifact` in a checkout and its identifier (0x + sha256 of the bytes), or undefined when the checkout has none. */
export function layoutSnapshotOf(checkout: string | undefined, artifact: string): { id: `0x${string}`; snapshot: unknown; path: string } | undefined {
  if (!checkout) return undefined;
  const path = join(checkout, "contracts", "test", "fixtures", "storage-layout", `${artifact}.json`);
  if (!existsSync(path)) return undefined;
  const bytes = readFileSync(path);
  let snapshot: unknown;
  try { snapshot = JSON.parse(bytes.toString("utf8")); } catch { return undefined; }
  return { id: `0x${createHash("sha256").update(bytes).digest("hex")}`, snapshot, path };
}
