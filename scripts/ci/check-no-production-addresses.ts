#!/usr/bin/env bun
// Canonical: core issue 1490 (clean room rule, owner decision 2026-10-05, core 1498).
//
// CI gate: no test or harness file hard-codes a Robot Money production address. Every chain, fork
// or devnet test deploys its OWN vault through our deploy scripts and reads addresses from the
// manifests. The live production v1 vault, its three adapters and the old admin Safe are real
// Base state on the Twin chain, so a test that names one would read production state.
//
// Usage: bun scripts/ci/check-no-production-addresses.ts [--root DIR] [--list]
//   --root DIR   scan DIR instead of the repo (the self-test plants files in a temp copy)
//   --list       print the production address list and exit 0
// Exit 0 when no scanned file names a listed address and at least one file was scanned. Exit 1 and
// print each hit (file:line) otherwise. A run that scans zero files is a failure.
//
// Scanned: contracts/test, testing, clients, services, scripts, config, .github.
// Not scanned: docs (documentation of the retired v1 deployment may name it), node_modules, target,
// lib, .git, this gate and its self-test (they must name the list), and the recorded session
// fixture directory .github/scripts/tests/fixtures (verbatim transcripts, never executed).
// Third-party addresses (USDC, venues, DEX, pools) live in scripts/deploy/third-party-addresses.json
// and are allowed everywhere.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Robot Money production addresses (Base mainnet, v1). Lower case, no 0x. */
export const PRODUCTION_ADDRESSES: { name: string; address: string }[] = [
  { name: "RobotMoneyVault v1", address: "4f835c9f54bcf17daf9040f60cb72951ccbb49dd" },
  { name: "MorphoAdapter v1", address: "a6ed7b03bc82d7c6d4ac4feb971a06550a7817e9" },
  { name: "AaveV3Adapter v1", address: "218695bdab0fe4f8d0a8ee590bc6f35820fc0bea" },
  { name: "CompoundV3Adapter v1", address: "8247da22a59fce074c102431048d0ce7294c2652" },
  { name: "old admin Safe", address: "88ba7364cc6ce5054981d571b33f8fb3e91475a0" },
];

export const SCAN_ROOTS = ["contracts/test", "testing", "clients", "services", "scripts", "config", ".github"];
const SKIP_DIRS = new Set(["node_modules", "target", "lib", ".git", "out", "cache", "dist", "broadcast"]);
const SKIP_PATHS = [
  "scripts/ci/check-no-production-addresses.ts",
  "scripts/ci/check-no-production-addresses.test.ts",
  ".github/scripts/tests/fixtures/",
];
const MAX_BYTES = 2_000_000;

export interface Hit {
  file: string;
  line: number;
  name: string;
}

/** Scan one text body. Matches the address with or without 0x and in any case. */
export function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i]!.toLowerCase();
    for (const p of PRODUCTION_ADDRESSES) {
      if (low.includes(p.address)) hits.push({ file, line: i + 1, name: p.name });
    }
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.isFile()) out.push(join(dir, e.name));
  }
  return out;
}

export function scan(repo: string): { files: number; hits: Hit[] } {
  let files = 0;
  const hits: Hit[] = [];
  for (const r of SCAN_ROOTS) {
    const base = join(repo, r);
    if (!existsSync(base)) continue;
    for (const f of walk(base)) {
      const rel = relative(repo, f);
      if (SKIP_PATHS.some((s) => rel === s || rel.startsWith(s))) continue;
      if (statSync(f).size > MAX_BYTES) continue;
      const buf = readFileSync(f);
      if (buf.includes(0)) continue; // binary
      files++;
      hits.push(...scanText(rel, buf.toString("utf8")));
    }
  }
  return { files, hits };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    for (const p of PRODUCTION_ADDRESSES) console.log(`0x${p.address}  ${p.name}`);
    process.exit(0);
  }
  const i = args.indexOf("--root");
  const repo = resolve(i >= 0 ? args[i + 1]! : join(import.meta.dir, "..", ".."));
  const { files, hits } = scan(repo);
  if (files === 0) {
    console.error("check-no-production-addresses: scanned zero files, refusing to pass");
    process.exit(1);
  }
  for (const h of hits) console.error(`${h.file}:${h.line}: hard-codes the ${h.name} production address`);
  console.log(`${files} files checked, ${hits.length} matches`);
  if (hits.length) {
    console.error("Deploy your own vault through the deploy scripts and read its address from the manifest (core 1498).");
    process.exit(1);
  }
}
