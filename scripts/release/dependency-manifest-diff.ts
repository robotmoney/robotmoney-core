#!/usr/bin/env bun
/**
 * Report every change to deployed third-party contracts since the latest release
 * manifest (core 1497, nightly job (c)).
 *
 * Usage:
 *   bun scripts/release/dependency-manifest-diff.ts --chain-id 8453
 *        [--manifest FILE] [--repo-root DIR] [--rpc-url URL | --state-file F]
 *        [--locate] [--json-out FILE]
 *
 * Without --manifest it reads the latest one under deployments/dependency-manifests/<chain>/.
 * --locate bisects for the block where each change landed (needs archive state; a
 * failure leaves the block unknown, it never fails the run).
 * Exit: 0 no change; 1 at least one change; 2 bad usage or no manifest.
 */
import { writeFileSync } from "node:fs";
import { argOpt, diffManifest, formatReport, latestManifestPath, loadManifest, makeReader } from "./dependency-manifest-lib.ts";

const args = process.argv.slice(2);
const root = argOpt(args, "--repo-root") ?? process.cwd();
let path = argOpt(args, "--manifest");
if (!path) {
  const chainId = Number(argOpt(args, "--chain-id"));
  if (!Number.isInteger(chainId)) {
    console.error("usage: dependency-manifest-diff.ts (--chain-id N | --manifest FILE) [--repo-root DIR] [--rpc-url URL | --state-file F] [--locate] [--json-out FILE]");
    process.exit(2);
  }
  path = latestManifestPath(root, chainId) ?? undefined;
  if (!path) {
    console.error(`no release dependency manifest for chain ${chainId} under deployments/dependency-manifests/`);
    process.exit(2);
  }
}
const manifest = loadManifest(path);
const reader = makeReader(args);
const live = await reader.chainId();
if (live !== null && live !== manifest.chainId) {
  console.error(`chain id mismatch: manifest ${manifest.chainId}, endpoint reports ${live}`);
  process.exit(2);
}
const { liveBlock, changes } = await diffManifest(manifest, reader, args.includes("--locate"));
console.log(formatReport(manifest, liveBlock, changes));
const jsonOut = argOpt(args, "--json-out");
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ manifest: path, chainId: manifest.chainId, release: manifest.release, manifestBlock: manifest.blockNumber, liveBlock, changes }, null, 2) + "\n");
process.exit(changes.length === 0 ? 0 : 1);
