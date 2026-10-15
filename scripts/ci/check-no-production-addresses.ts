#!/usr/bin/env bun
// Canonical: core issue 1490 (clean room rule, owner decision 2026-10-05, core 1498).
//
// CI gate: no test or harness file hard-codes a Robot Money production address. Every chain, fork
// or devnet test deploys its OWN vault through our deploy scripts and reads addresses from the
// manifests. The live production v1 vault, its three adapters and the old admin Safe are real
// Base state on the Twin chain, so a test that names one would read production state. So is every
// contract of Deploy 2 (devops run 2 on Base 8453, QA plan v1 E10): a test that must read Deploy 2
// state reads its address from the committed manifests in deployments/8453/deploy-2 (the recorder
// keeper fork test does). The self-test requires the Deploy 2 entries below to equal the Robot
// Money contracts those manifests record. Deploy 2's keys (deployer, pauser, emergency, Safe
// owners) are not contracts and are not listed. Nor is TickMath: it is a CREATE2 library at the
// same address on every chain, the Twin chain included.
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

/** Prefix of every Deploy 2 entry's name. The self-test selects the Deploy 2 entries by it. */
export const DEPLOY_2 = "Deploy 2";

/** Robot Money production addresses on Base mainnet: v1, then Deploy 2. Lower case, no 0x. */
export const PRODUCTION_ADDRESSES: { name: string; address: string }[] = [
  { name: "RobotMoneyVault v1", address: "4f835c9f54bcf17daf9040f60cb72951ccbb49dd" },
  { name: "MorphoAdapter v1", address: "a6ed7b03bc82d7c6d4ac4feb971a06550a7817e9" },
  { name: "AaveV3Adapter v1", address: "218695bdab0fe4f8d0a8ee590bc6f35820fc0bea" },
  { name: "CompoundV3Adapter v1", address: "8247da22a59fce074c102431048d0ce7294c2652" },
  { name: "old admin Safe", address: "88ba7364cc6ce5054981d571b33f8fb3e91475a0" },
  // Deploy 2 (deployments/8453/deploy-2). The file and key each address is read from are named.
  { name: `${DEPLOY_2} Safe (safe.json safe)`, address: "dfdea0e1adf55a9a938bd34ead7920175b47cb4b" },
  { name: `${DEPLOY_2} timelock (timelock.json addresses.timelock)`, address: "d65165af0fb4062ed0da5d119d4b56b92b15356b" },
  { name: `${DEPLOY_2} PortfolioRouter (router.json router)`, address: "b3a8e66d9e2980b54ac0e70e0e236486d1dcb356" },
  { name: `${DEPLOY_2} VaultRegistry (registry.json registry)`, address: "686ebefda732dffa988253ecf9c012946b8066a3" },
  { name: `${DEPLOY_2} RobotMoneyGateway (gateway.json gateway)`, address: "8e866418ba2c9120753b8f9b2c5f7c33246575be" },
  { name: `${DEPLOY_2} RouterGovernance (governance.json governance)`, address: "59b593ab06bb5587534efe255f6c614858b32754" },
  { name: `${DEPLOY_2} InvestmentCommitteePolicy (ic-policy.json policy)`, address: "820a3874a8b44d7e1d4c67b3bf5619cfae06907e" },
  { name: `${DEPLOY_2} ConsensusRecommendationReceipt (ic-policy.json consensus_receipt)`, address: "efee1c9881d1291460f72da7000ba53e42eb36e2" },
  { name: `${DEPLOY_2} rmUSDC vault (vault.json vault)`, address: "28bf6e6edad526191e8652ee631b56ead4ce7435" },
  { name: `${DEPLOY_2} rmUSDC AaveV3Adapter (vault.json aave_adapter)`, address: "271f3b322de3f9e6d1de09450ec2cc106d2a158f" },
  { name: `${DEPLOY_2} rmUSDC CompoundV3Adapter (vault.json compound_adapter)`, address: "82e5d09770fb95d4371fc513f3024c40cb861fe0" },
  { name: `${DEPLOY_2} rmUSDC Moonwell adapter (vault.json moonwell_flagship_adapter)`, address: "ac2a54505229639bdab9b7708f0e7202f4feea1d" },
  { name: `${DEPLOY_2} rmPROTO vault (protocol-asset-vault.json vault)`, address: "28c5ca4df0107679bfcc9b0ad4c2f3f209b8f797" },
  { name: `${DEPLOY_2} rmAGENT vault (agent-token-vault.json vault)`, address: "22bd48c56c34a2c1c1bac77bd7c4e636a6f10d57" },
  { name: `${DEPLOY_2} rmAGENT UniswapV4SwapAdapter (agent-token-vault.json adapter_v4)`, address: "c1e35f6281be5b58f0a0e7ed012d444d4cf72030" },
  { name: `${DEPLOY_2} rmAGENT UniswapV4PriceRecorder (recorder.json recorder)`, address: "0adc14e6521af213f9dce5585d530f237831e934" },
  { name: `${DEPLOY_2} rmRWA vault (rwa-basket-vault.json vault)`, address: "37be372bd32f9e63a94c7db3ab415996658bcd50" },
  { name: `${DEPLOY_2} rmRWA adapter (rwa-basket-vault.json adapter)`, address: "b0e2495649eca2c83c9c3227ba3f1d8bd0aeb61a" },
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
    console.error("A test that must read Deploy 2 state reads the address from deployments/8453/deploy-2 (QA plan v1 E10).");
    process.exit(1);
  }
}
