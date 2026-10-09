#!/usr/bin/env bun
/**
 * Exit 0 only when every third-party address in a dependency manifest appears in
 * the deploy config files (core 1497). Prevents a second hand-maintained list.
 *
 * Usage: bun scripts/release/check-dependency-manifest-addresses.ts --manifest FILE [--repo-root DIR]
 * Exit: 0 all present; 1 an address is missing from the config; 2 bad usage.
 */
import { argOpt, collectThirdPartyAddresses, loadManifest } from "./dependency-manifest-lib.ts";

const args = process.argv.slice(2);
const path = argOpt(args, "--manifest");
if (!path) {
  console.error("usage: check-dependency-manifest-addresses.ts --manifest FILE [--repo-root DIR]");
  process.exit(2);
}
const m = loadManifest(path);
const { deps } = collectThirdPartyAddresses(argOpt(args, "--repo-root") ?? process.cwd(), m.chainId);
const known = new Set(deps.map((d) => d.address));
const stray = m.entries.filter((e) => !known.has(e.address.toLowerCase()));
for (const e of stray) console.error(`not in deploy config: ${e.address} (${e.label})`);
if (stray.length) process.exit(1);
console.log(`ok: all ${m.entries.length} manifest addresses appear in the deploy config files`);
