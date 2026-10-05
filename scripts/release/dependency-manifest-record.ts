#!/usr/bin/env bun
/**
 * Record the third-party dependency manifest at a release deploy (core 1497).
 *
 * Usage:
 *   bun scripts/release/dependency-manifest-record.ts --chain-id 8453 --release v1.2.3
 *        [--repo-root DIR] [--rpc-url URL] [--twin] [--out FILE]
 *
 * Default output: deployments/dependency-manifests/<chainId>/<release>.json, committed
 * with the release deployment record. Addresses come from the deploy config files
 * (see dependency-manifest-lib.ts). No secret is read or written.
 * Exit: 0 written; 1 a read failed or the chain id did not match; 2 bad usage.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_DIR, argOpt, buildManifest, chainIdMatches, collectThirdPartyAddresses, makeReader } from "./dependency-manifest-lib.ts";

const args = process.argv.slice(2);
const chainId = Number(argOpt(args, "--chain-id"));
const release = argOpt(args, "--release");
if (!Number.isInteger(chainId) || !release) {
  console.error("usage: dependency-manifest-record.ts --chain-id N --release TAG [--repo-root DIR] [--rpc-url URL] [--twin] [--out FILE]");
  process.exit(2);
}
const root = argOpt(args, "--repo-root") ?? process.cwd();
const reader = makeReader(args);

const live = await reader.chainId();
if (!chainIdMatches(live, chainId, args)) {
  console.error(`chain id mismatch: --chain-id ${chainId}, endpoint reports ${live}`);
  process.exit(1);
}
const { deps, warnings } = collectThirdPartyAddresses(root, chainId);
for (const w of warnings) console.error(`warning: ${w}`);
if (deps.length === 0) {
  console.error(`no third-party addresses found for chain ${chainId}`);
  process.exit(1);
}
const manifest = await buildManifest(reader, deps, chainId, release);
const missing = manifest.entries.filter((e) => e.codeHash === null);
for (const e of missing) console.error(`warning: no code at ${e.address} (${e.label}) at block ${manifest.blockNumber}`);

const out = argOpt(args, "--out") ?? join(root, MANIFEST_DIR, String(chainId), `${release}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${out}: ${manifest.entries.length} dependencies, block ${manifest.blockNumber}, ${missing.length} without code`);
