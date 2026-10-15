// Security round 2 (review: SECURITY_PROVENANCE_BYPASS): a REAL git checkout for the build-provenance tests. Its sources are committed, its forge out/ is git-ignored
// (as the repository's .gitignore ignores out/), and each artifact carries compiler metadata the way forge writes it: `rawMetadata` (a JSON string) and `metadata`
// (an object), each with the compilation target and a keccak256 per source. A test makes an artifact stale by hashing other bytes than the committed ones.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import { tmp } from "./fixtures.ts";

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
/** git in `dir`, its output trimmed. */
export const gitIn = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env }).toString().trim();
/** keccak256 of a source text, as solc records it in the metadata. */
export const sourceHash = (text: string): Hex => keccak256(toBytes(text));

/** Writes files under `root` (relative path to text). */
export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** A new git checkout with `files` committed and out/ ignored. Returns its root and HEAD. */
export function sourceCheckout(files: Record<string, string>, prefix = "pc-src-"): { root: string; out: string; sha: string } {
  const root = tmp(prefix);
  gitIn(root, "init", "-q");
  gitIn(root, "config", "commit.gpgsign", "false");
  gitIn(root, "config", "tag.gpgsign", "false");
  writeFiles(root, { ".gitignore": "out/\ncache/\n", ...files });
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "-m", "release");
  return { root, out: join(root, "out"), sha: gitIn(root, "rev-parse", "HEAD") };
}

/** Commits every change in `root` and returns the new HEAD. */
export function commitAll(root: string, msg = "change"): string {
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "-m", msg);
  return gitIn(root, "rev-parse", "HEAD");
}

export interface ArtifactSpec {
  /** The runtime code (deployedBytecode.object). */
  code: Hex;
  /** The source that defines the contract (the compilation target's path). */
  target: string;
  /** Every source of the compilation (path to the text solc read; its keccak256 goes into the metadata). Must include `target`. */
  sources: Record<string, string>;
  /** Libraries the code links: library name to the path that defines it (one 20-byte reference at byte 1 each). */
  links?: Record<string, string>;
  /** The contract named in the compilation target. Default: the artifact's name. */
  targetName?: string;
  /** Leave the metadata out entirely. */
  noMetadata?: boolean;
}

/** forge's two metadata fields of an artifact compiled from `sources` with `target` (path) defining `name`: `rawMetadata` (a JSON string) and `metadata`. */
export function sourceMetadata(name: string, target: string, sources: Record<string, string>): { rawMetadata: string; metadata: object } {
  const metadata = {
    compiler: { version: "0.8.24+commit.e11b9ed9" }, language: "Solidity",
    settings: { compilationTarget: { [target]: name } },
    sources: Object.fromEntries(Object.entries(sources).map(([p, text]) => [p, { keccak256: sourceHash(text), license: "MIT" }])),
    version: 1,
  };
  return { rawMetadata: JSON.stringify(metadata), metadata };
}

/** Writes `<out>/<name>.sol/<name>.json` the way forge does, with metadata built from `spec`. */
export function writeSourceArtifact(out: string, name: string, spec: ArtifactSpec): string {
  const linkReferences: Record<string, Record<string, { start: number; length: number }[]>> = {};
  for (const [lib, path] of Object.entries(spec.links ?? {})) (linkReferences[path] ??= {})[lib] = [{ start: 1, length: 20 }];
  const dir = join(out, `${name}.sol`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({
    deployedBytecode: { object: spec.code, immutableReferences: {}, linkReferences },
    ...(spec.noMetadata ? {} : sourceMetadata(spec.targetName ?? name, spec.target, spec.sources)),
  }));
  return out;
}
