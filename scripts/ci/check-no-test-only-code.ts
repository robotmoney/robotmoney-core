#!/usr/bin/env bun
// Canonical: core issue 1499, core S10 (issue 1489).
//
// CI gate: the build contains no test-only code. Production contracts are the tested contracts.
// Usage: bun scripts/ci/check-no-test-only-code.ts [--root DIR] [--list-allowlist]
//   --root DIR          scan DIR instead of the repo (the self-test plants files in a temp copy)
//   --list-allowlist    print the block.chainid allowlist and exit 0
// Exit 0 when every check passes and at least one file was scanned. Exit 1 and print each hit
// otherwise. A run that scans zero files is a failure.
//
// Checks
//   A. contracts/script holds no Demo* contract or file, no stub, mock, fake or rehearsal
//      contract, no mock Safe, no Slot0 stub, no MOCK_ALL, no vm.etch and no DEFAULT_*_CAP.
//   B. Every block.chainid in contracts/script matches the allowlist below.
//   C. The deleted paths do not exist.
//   D. No forge test defines a mock Safe or a constant-threshold Safe stub.
//   F. No forge test pranks the Safe (`vm.prank(safe`, `vm.startPrank(safe`). A pranked Safe skips
//      the two-signature quorum, so the test proves nothing about governance. Governed calls go
//      through helpers/SafeGovernance.sol. PRANK_SAFE_DEBT lists files not yet migrated (core
//      issue 1644): a hit there is a warning, and each migration PR deletes its entry.
//   E. No file outside the history directories names a deleted contract or script.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------------------------
// block.chainid allowlist. A use is allowed only when its file name and its line both match one
// rule. Principle 5 of core issue 1499: guards only, never different logic per chain.
// ---------------------------------------------------------------------------------------------
export interface ChainIdRule {
  file: RegExp;
  line: RegExp;
  reason: string;
}
export const CHAINID_ALLOWLIST: ChainIdRule[] = [
  {
    file: /\.s\.sol$|BasketVaultDeployBase\.sol$/,
    line: /vm\.serializeUint\(\s*\w+\s*,\s*"chain_id"\s*,\s*block\.chainid\s*\)/,
    reason: "output file content: the manifest records the chain id it was written on",
  },
  {
    file: /BasketVaultDeployBase\.sol$/,
    line: /vm\.toString\(block\.chainid\)/,
    reason: "output file name: the manifest path embeds the chain id",
  },
  {
    file: /(^|\/)ExpectedChainGuard\.sol$/,
    line: /block\.chainid/,
    reason: "ExpectedChainGuard: the one guard that pins a run to the expected chain id",
  },
  {
    file: /(^|\/)DeployTimelock\.s\.sol$/,
    line: /block\.chainid\s*==\s*BASE_MAINNET_CHAIN_ID/,
    reason: "floor guard: the timelock delay and Safe floors are keyed to chain id 8453",
  },
];

// ---------------------------------------------------------------------------------------------
// Check A: forbidden shapes in contracts/script.
// ---------------------------------------------------------------------------------------------
const SCRIPT_FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "Demo* contract", re: /\b(?:abstract\s+)?(?:contract|interface|library)\s+Demo\w*/ },
  { name: "Demo* reference", re: /\bDeployDemo\w*|\bDemo[A-Z]\w*/ },
  {
    name: "stub, mock, fake or rehearsal contract",
    re: /\b(?:abstract\s+)?(?:contract|interface|library)\s+\w*(?:Stub|Mock|Fake|Rehearsal)\w*/,
  },
  { name: "mock Safe", re: /\b\w*(?:Mock|Stub|Fake|Rehearsal)\w*Safe\w*|\bSafe\w*(?:Mock|Stub|Fake)\w*/ },
  { name: "Slot0 stub", re: /Slot0Stub/ },
  { name: "MOCK_ALL", re: /\bMOCK_ALL\b/ },
  { name: "vm.etch in a deploy script", re: /\bvm\.etch\s*\(/ },
  { name: "CREATE2 factory install", re: /Arachnid/i },
  { name: "default cap constant (caps come from the sheet)", re: /\bDEFAULT_(?:TVL|PER_DEPOSIT)_CAP\b/ },
  { name: "default vault name (the name comes from the sheet)", re: /\bDEFAULT_VAULT_NAME\b/ },
];

// ---------------------------------------------------------------------------------------------
// Check C: deleted paths (relative to the repo root).
// ---------------------------------------------------------------------------------------------
export const DELETED_PATHS = [
  "contracts/Vault.sol",
  "contracts/vaults/RwaVault.sol",
  "contracts/adapters/ChronicleOracleAdapter.sol",
  "contracts/adapters/DeSpxaAssetPositionAdapter.sol",
  "contracts/adapters/UniswapV4AssetPositionAdapter.sol",
  "contracts/adapters/UniswapV4SwapAdapter.sol",
  "contracts/adapters/AerodromeAssetPositionAdapter.sol",
  "contracts/adapters/UniswapV3AssetPositionAdapter.sol",
  "contracts/interfaces/IPositionAdapter.sol",
  "contracts/UniswapV3PoolSlot0Stub.sol",
  "contracts/gateway/MockVault.sol",
  "contracts/script/DeployVaultThemes.s.sol",
  "contracts/script/DeployDemoExtraVaults.s.sol",
  "contracts/script/DeployDemoUniswapV3Stubs.s.sol",
  "contracts/RmToken.sol",
  "contracts/script/DeployRmToken.s.sol",
  "contracts/script/DeployRehearsalSafe.s.sol",
  "scripts/stage/deploy-core-stack.sh",
  ".github/workflows/deploy-contracts.yml",
];

// ---------------------------------------------------------------------------------------------
// Check D: forge tests.
// ---------------------------------------------------------------------------------------------
const TEST_FORBIDDEN: { name: string; re: RegExp }[] = [
  {
    name: "mock Safe contract in a forge test",
    re: /\b(?:abstract\s+)?contract\s+\w*(?:Mock|Stub|Fake|Rehearsal)\w*Safe\w*|\bcontract\s+\w*Safe\w*(?:Mock|Stub|Fake)\w*/,
  },
  { name: "MockHighThresholdSafe", re: /MockHighThresholdSafe|MockLowThresholdSafe|RehearsalSafe/ },
  {
    name: "constant-threshold Safe stub",
    re: /function\s+getThreshold\s*\(\s*\)[^{;]*\{\s*return\s+\d+\s*;/,
  },
];

// ---------------------------------------------------------------------------------------------
// Check F: no pranked Safe in a forge test (issue 1644).
// ---------------------------------------------------------------------------------------------
export const PRANK_SAFE_RE = /\bvm\.(?:start)?[Pp]rank\(\s*safe\w*/;
// Transitional debt, shrinking: files still to move onto helpers/SafeGovernance.sol.
export const PRANK_SAFE_DEBT = [
  "contracts/test/DeployTimelock.t.sol",
  "contracts/test/WeightSetterRotation.t.sol",
  "contracts/test/PortfolioRouter.t.sol",
];

// ---------------------------------------------------------------------------------------------
// Check E: names that must not appear anywhere outside history.
// ---------------------------------------------------------------------------------------------
const DELETED_NAMES: RegExp[] = [
  /(?<![A-Za-z])Vault\.sol\b/,
  /\bRwaVault\b/,
  /\bChronicleOracleAdapter\b/,
  /\bDeSpxaAssetPositionAdapter\b/,
  /\bUniswapV4(?:Asset\w*|Swap)Adapter\b/,
  /\bIPositionAdapter\b/,
  /\b(?:Aerodrome|UniswapV3)AssetPositionAdapter\b/,
  /\bDeployVaultThemes\b/,
  /\bDeployDemo\w+/,
  /\bUniswapV3PoolSlot0Stub\b/,
  /\bDeployRmToken\b/,
  /deploy-core-stack\.sh/,
  /deploy-contracts\.yml/,
  /\bMockHighThresholdSafe\b/,
  /\bRehearsalSafe\b/,
];
// Directories whose content is history and may name deleted things.
const HISTORY_DIRS = [
  "docs/history",
  "docs/code-review",
  "docs/adr",
  "docs/future",
  "contracts/doc", // generated mirror, refreshed by forge doc
];
// Files that must name the deleted things on purpose.
const NAME_CHECK_EXEMPT = [
  "scripts/ci/check-no-test-only-code.ts",
  "scripts/ci/check-no-test-only-code.test.ts",
  // The audit-ledger gate and its test, and the doc-checks workflow comment, name the deleted
  // contracts on purpose: the ledger gate bans them in source headers and its test plants them.
  "scripts/check-audit-ledger.sh",
  "scripts/check-audit-ledger.test.sh",
  ".github/workflows/suite-13-doc-checks.yml",
  "scripts/stage/check-deleted-stage-scripts.ts", // the second gate: it lists the deleted stage paths to keep them gone
  "scripts/stage/tests/check-deleted-stage-scripts.test.ts",
  "docs/audits.md", // the finding register keeps findings that named deleted contracts as history
  "contracts/test/DeployBasketVaultRwa.t.sol", // asserts the deleted paths are absent
  "docs/technical/base-tokenized-stocks-research.md", // phase-two research, not shipped code
  // Design records of the rejected unified-vault architecture (ADR-0010 Rejected) and the retired
  // v1 vault. They describe what was considered or retired and are kept as history, not as a
  // description of shipped code.
  "docs/operations/retired-v1-vault-maintenance.md",
  "docs/technical/unified-vault-spec.md",
  "docs/technical/unified-vault-seam-map.json",
  "docs/technical/fixtures/unified-vault-seam-map.missing-entry.json",
  "docs/technical/unified-vault-open-questions-resolution.md",
  "docs/technical/real-four-vault-demo-seams.md",
  "docs/technical/demo-seeding-seams.md",
  "docs/technical/testcode-removal-seams.md",
  "docs/technical/asset-flow-semantics.md",
  "docs/technical/asset-valuation.md",
  "docs/technical/asset-valuation-hybrid.md",
  "docs/technical/smart-contract-invariants.md",
  "docs/technical/security-model.md",
];
// Transitional debt. Each prefix is owned by another lane of core issue 1499 and
// is deleted or rewritten there. A hit under a prefix is printed as a WARNING and does not fail
// the gate. Remove the prefix when its lane lands, so the gate then fails on any regression.
//   testing/smoke-test: S9 stage driver replaces the Rust demo harness (the Arachnid CREATE2
//     install and the demo deploy calls go with it).
//   .github/scripts/tests/fixtures: recorded transcripts of old sessions.
export const TRANSITIONAL_PREFIXES = ["testing/smoke-test/", ".github/scripts/tests/fixtures/"];
const isTransitional = (r: string): boolean => TRANSITIONAL_PREFIXES.some((p) => r.startsWith(p));
const SKIP_DIRS = new Set(["node_modules", "out", "cache", ".git", "lib", "target", "broadcast"]);
const TEXT_EXT = /\.(sol|ts|tsx|js|mjs|json|yml|yaml|sh|md|toml|rs|py|mdx|txt)$|(^|\/)Makefile[^/]*$/;

const args = process.argv.slice(2);
if (args.includes("--list-allowlist")) {
  for (const r of CHAINID_ALLOWLIST) console.log(`${r.file}  ${r.line}  -- ${r.reason}`);
  process.exit(0);
}
const rootArg = args.indexOf("--root");
const repo = resolve(rootArg >= 0 ? args[rootArg + 1]! : join(import.meta.dir, "..", ".."));

const hits: string[] = [];
const warnings: string[] = [];
let scanned = 0;
let scriptFiles = 0;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
const rel = (p: string): string => relative(repo, p).split("\\").join("/");

// A and B
for (const f of walk(join(repo, "contracts/script")).filter((p) => p.endsWith(".sol"))) {
  scanned++;
  scriptFiles++;
  const r = rel(f);
  const base = r.split("/").pop()!;
  if (/^(?:Deploy)?Demo/.test(base)) hits.push(`${r}: Demo* file name`);
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const rule of SCRIPT_FORBIDDEN) {
        if (rule.re.test(line)) hits.push(`${r}:${i + 1}: ${rule.name}: ${line.trim()}`);
      }
      if (line.includes("block.chainid")) {
        const ok = CHAINID_ALLOWLIST.some((a) => a.file.test(r) && a.line.test(line));
        if (!ok) hits.push(`${r}:${i + 1}: block.chainid outside the allowlist: ${line.trim()}`);
      }
    });
}

// C
for (const p of DELETED_PATHS) {
  scanned++;
  if (existsSync(join(repo, p))) (isTransitional(p) ? warnings : hits).push(`${p}: deleted path exists`);
}

// D
for (const f of walk(join(repo, "contracts/test")).filter((p) => p.endsWith(".sol"))) {
  if (rel(f).startsWith("contracts/test/vendor/")) continue;
  scanned++;
  const text = readFileSync(f, "utf8");
  for (const rule of TEST_FORBIDDEN) {
    const flags = rule.re.flags.includes("g") ? rule.re.flags : rule.re.flags + "g";
    for (const m of text.matchAll(new RegExp(rule.re.source, flags))) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push(`${rel(f)}:${line}: ${rule.name}`);
    }
  }
}

// F
for (const f of walk(join(repo, "contracts/test")).filter((p) => p.endsWith(".sol"))) {
  const r = rel(f);
  if (r.startsWith("contracts/test/vendor/")) continue;
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!PRANK_SAFE_RE.test(line)) return;
      const msg = `${r}:${i + 1}: pranked Safe in a forge test (use helpers/SafeGovernance.sol): ${line.trim()}`;
      (PRANK_SAFE_DEBT.includes(r) ? warnings : hits).push(msg);
    });
}

// E
for (const f of walk(repo)) {
  const r = rel(f);
  if (!TEXT_EXT.test(r)) continue;
  if (HISTORY_DIRS.some((d) => r === d || r.startsWith(d + "/"))) continue;
  if (NAME_CHECK_EXEMPT.includes(r)) continue;
  if (r.startsWith("contracts/test/vendor/")) continue;
  scanned++;
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const re of DELETED_NAMES) {
        if (re.test(line)) {
          const msg = `${r}:${i + 1}: names deleted code (${re.source}): ${line.trim().slice(0, 100)}`;
          (isTransitional(r) ? warnings : hits).push(msg);
        }
      }
    });
}

if (warnings.length > 0) {
  const byFile = new Map<string, number>();
  for (const w of warnings) byFile.set(w.split(":")[0]!, (byFile.get(w.split(":")[0]!) ?? 0) + 1);
  console.warn(`transitional debt (${warnings.length} matches in ${byFile.size} files, owned by other lanes):`);
  for (const [f, n] of byFile) console.warn(`  warn ${f} (${n})`);
}
if (scanned === 0 || scriptFiles === 0) {
  console.error("check-no-test-only-code: FAIL: no contracts/script files scanned (zero checks ran)");
  process.exit(1);
}
if (hits.length > 0) {
  console.error("check-no-test-only-code: FAIL\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`ok: no test-only code (${scanned} files and paths checked, 0 matches)`);
