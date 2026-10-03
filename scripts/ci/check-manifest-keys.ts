#!/usr/bin/env bun
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S3 (issue 1485), core 1493.
//
// CI gate: no reader of the deploy manifest may name a key or a script that core S3 retired.
//   - `morpho_adapter` is now `moonwell_flagship_adapter` (the third venue is named for its address).
//   - The single `Deploy.s.sol` is gone. The stages are DeployLibs, DeployVault, DeployVaultRegistry,
//     DeployPortfolioRouter and DeployGateway.
// Exit 0 when no file under the scanned roots names a retired item. Exit 1 and print each hit otherwise.
// `scan` takes the roots so a test can plant a retired key and watch the gate fail.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const RETIRED = ["morpho_adapter", "MORPHO_GAUNTLET_USDC_PRIME", "script/Deploy.s.sol", "Deploy.s.sol:Deploy"];
const ROOTS = ["contracts", "scripts", "testing", "clients", ".github", "deployments"];
const SKIP_DIRS = new Set(["node_modules", "out", "cache", ".git", "lib", "target", "fixtures", "doc", "dist"]);
const SELF = new Set([resolve(import.meta.path), resolve(import.meta.dir, "check-manifest-keys.test.ts")]);

export function scanCounted(roots: string[], base: string): { hits: string[]; scanned: number } {
  const hits: string[] = [];
  let scanned = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else if (!SELF.has(resolve(path)) && st.size < 2_000_000) {
        scanned++;
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, i) => {
            for (const old of RETIRED) if (line.includes(old)) hits.push(`${relative(base, path)}:${i + 1}: ${old}`);
          });
      }
    }
  };
  for (const r of roots) walk(join(base, r));
  return { hits, scanned };
}

export function scan(roots: string[], base: string): string[] {
  return scanCounted(roots, base).hits;
}

if (import.meta.main) {
  const repo = resolve(import.meta.dir, "..", "..");
  const { hits, scanned } = scanCounted(ROOTS, repo);
  if (scanned === 0) {
    console.error("check-manifest-keys: FAIL: no files scanned (zero checks ran)");
    process.exit(1);
  }
  if (hits.length > 0) {
    console.error("Retired manifest keys or scripts are still read:\n" + hits.join("\n"));
    process.exit(1);
  }
  console.log(`ok: none of ${RETIRED.join(", ")} appears under ${ROOTS.join(", ")}`);
}
