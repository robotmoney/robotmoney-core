#!/usr/bin/env bun
// Canonical: docs/operations/contract-release-runbooks.md (the v0.6.0 governed upgrade, section 4.15), core issue 1914 (Task B).
//
// Proves a set of contracts is logic-identical between two git refs. Each ref is built with forge in a temporary detached worktree. The runtime
// bytecode of every named contract is read from the build artifact, the immutable references, the library link slots and the CBOR metadata
// trailer are zeroed with the verifier's own masking (publish-contracts/src/verify/codehash.ts loadArtifact + maskHex), and the keccak256 of the
// result is compared. A comment-only source change moves the metadata hash and nothing else, so the masked hashes must match.
//
// Usage: bun publish-contracts/src/ci/check-comment-only-contracts.ts [--baseline REF] [--candidate REF] [--contracts A,B,...]
//        bun publish-contracts/src/ci/check-comment-only-contracts.ts --baseline-out DIR --candidate-out DIR [--contracts A,B,...]   (forge out/ directories already built)
// Defaults: baseline release/v0.5.0-rehearsal, candidate HEAD, the seven contracts v0.6.0 does not upgrade.
// Exit 0: every contract matches and at least one was compared. Exit 1: a masked hash differs, or an artifact is missing. Exit 2: tooling or input error.
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keccak256 } from "viem";
import { loadArtifact, maskHex } from "../verify/codehash.ts";

export const DEFAULT_BASELINE = "release/v0.5.0-rehearsal";
/** The seven contracts of the v0.6.0 line whose source changed in comments only (issue 1914). */
export const COMMENT_ONLY_CONTRACTS = ["RouterGovernance", "VaultRegistry", "PortfolioRouter", "RobotMoneyVault", "ProtocolAssetVault", "AgentTokenVault", "RwaBasketVault"];
const SUBMODULES = ["forge-std", "openzeppelin-contracts", "openzeppelin-contracts-upgradeable"];

export interface Row { contract: string; baseline: string; candidate: string; ok: boolean; detail: string }

/** keccak256 of the masked runtime code, or the reason there is none. */
export function strippedHash(outDir: string, name: string): { hash?: string; error?: string } {
  try {
    const art = loadArtifact(outDir, name);
    return { hash: keccak256(maskHex(art.object, art.refs)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function compareBuilds(baselineOut: string, candidateOut: string, contracts: string[]): Row[] {
  return contracts.map((contract) => {
    const a = strippedHash(baselineOut, contract);
    const b = strippedHash(candidateOut, contract);
    const short = (h?: string) => (h ? h.slice(2, 14) : "missing");
    if (!a.hash || !b.hash) return { contract, baseline: short(a.hash), candidate: short(b.hash), ok: false, detail: a.error ?? b.error ?? "no artifact" };
    const ok = a.hash === b.hash;
    return { contract, baseline: short(a.hash), candidate: short(b.hash), ok, detail: ok ? "logic identical" : "RUNTIME LOGIC DIFFERS" };
  });
}

function sh(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} (cwd ${cwd}) exited ${r.exitCode}: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`);
  return r.stdout.toString().trim();
}

/** A ref that starts with '-' would be read by git as an option (for example --output=FILE or --upload-pack), so it is refused before any git call. */
export function assertSafeRef(ref: string, flag: string): string {
  if (ref === "" || ref.startsWith("-")) throw new Error(`${flag} must be a git ref and cannot be empty or start with '-' (got ${JSON.stringify(ref)})`);
  return ref;
}

/** Build `ref` in a detached worktree under `scratch` and return its forge out/ directory. */
function buildRef(root: string, scratch: string, label: string, ref: string): string {
  const wt = join(scratch, label);
  const want = sh(["git", "ls-tree", "HEAD", "lib/"], root);
  if (sh(["git", "ls-tree", ref, "lib/"], root) !== want) throw new Error(`${ref} pins other submodule commits than HEAD: the two builds would not share one lib/`);
  sh(["git", "worktree", "add", "--detach", wt, ref], root);
  for (const s of SUBMODULES) {
    const src = join(root, "lib", s);
    if (!existsSync(join(src, "contracts")) && !existsSync(join(src, "src"))) throw new Error(`submodule ${s} is not checked out in ${root}`);
    rmSync(join(wt, "lib", s), { recursive: true, force: true });
    symlinkSync(src, join(wt, "lib", s));
  }
  sh(["forge", "build", "--skip", "test", "--skip", "script"], wt);
  return join(wt, "out");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const contracts = (arg(argv, "--contracts") ?? COMMENT_ONLY_CONTRACTS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  if (contracts.length === 0) { console.error("no contracts named"); return 2; }
  let baselineOut = arg(argv, "--baseline-out");
  let candidateOut = arg(argv, "--candidate-out");
  const baselineRef = arg(argv, "--baseline") ?? DEFAULT_BASELINE;
  const candidateRef = arg(argv, "--candidate") ?? "HEAD";
  try { assertSafeRef(baselineRef, "--baseline"); assertSafeRef(candidateRef, "--candidate"); } catch (e) { console.error(`error: ${(e as Error).message}`); return 2; }
  const root = resolve(import.meta.dir, "..", "..", "..");
  let scratch: string | undefined;
  try {
    if (!baselineOut || !candidateOut) {
      scratch = mkdtempSync(join(tmpdir(), "comment-only-"));
      baselineOut = buildRef(root, scratch, "baseline", baselineRef);
      candidateOut = buildRef(root, scratch, "candidate", candidateRef);
    }
    const rows = compareBuilds(baselineOut, candidateOut, contracts);
    for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.contract.padEnd(20)} baseline ${r.baseline} candidate ${r.candidate} ${r.detail}`);
    const bad = rows.filter((r) => !r.ok);
    console.log(`compared ${rows.length} contract(s), ${rows.length - bad.length} identical, ${bad.length} differ`);
    return rows.length === 0 || bad.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  } finally {
    if (scratch) {
      for (const l of ["baseline", "candidate"]) if (existsSync(join(scratch, l))) { for (const s of SUBMODULES) { try { unlinkSync(join(scratch, l, "lib", s)); } catch {} }; Bun.spawnSync(["git", "worktree", "remove", "--force", join(scratch, l)], { cwd: root }); }
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
