// Source scan (issue 1738): amounts and deposit-status labels have ONE implementation each.
//
//   1. Amount formatting and parsing live in lib/format.ts only. A component that scales a raw bigint with
//      Number(raw) / 10 ** d, a viem formatUnits / parseUnits, toFixed, toLocaleString or a hand-written
//      10n ** d shows 1 USDC as 10000000000000 or a 24-decimal share count as 999,949,002,651,862,103.
//   2. The words Active, Paused, Retired and "Deposits paused" as a vault status are produced by
//      lib/vaultDepositState.ts only (resolveDepositState + depositStateLabel). A literal "Active" anywhere else
//      is a status that bypasses the resolver (the router preview said Active for a paused vault).
//
// Static check, runs in the vitest node project. Comments are stripped before matching.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

const FORMAT_MODULE = "lib/format.ts";
const RESOLVER_MODULE = "lib/vaultDepositState.ts";
/** Generated ABI: names such as "DepositsPaused" are Solidity identifiers, not labels. */
const GENERATED = "lib/abi.generated.ts";

/**
 * Files that may do their own number scaling, each for a reason that is NOT a token amount:
 *   - lib/uniswapV3.ts: pool price ratios (sqrtPriceX96 math), not a balance or an amount.
 *   - components/TestnetBanner.tsx: Date.toLocaleString.
 *   - components/GovernancePanel.tsx: voting power, an admin-assigned integer weight, not a token amount.
 */
const SCALING_ALLOWED = new Set([
  FORMAT_MODULE,
  GENERATED,
  "lib/uniswapV3.ts",
  "components/TestnetBanner.tsx",
  "components/GovernancePanel.tsx",
]);

/**
 * Files that show a GATEWAY pause flag (gateway.depositsPaused(), read live, UNKNOWN until read), which is a
 * different object from a vault's deposit status. They never say "Active".
 */
const GATEWAY_FLAG_ALLOWED = new Set([
  "components/PauseFlow.tsx",
  "components/DebugPage.tsx",
  "components/DebugPanel.tsx",
]);

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Ad-hoc scaling or formatting of a raw amount. Exported for the self-test. */
export function scalingViolations(rawText: string): string[] {
  const text = stripComments(rawText);
  const checks: Array<[string, RegExp]> = [
    [
      "viem formatUnits/parseUnits/formatEther/parseEther",
      /\b(formatUnits|parseUnits|formatEther|parseEther)\b/,
    ],
    ["float division by a power of ten (/ 1e6, / 10 ** d)", /\/\s*(1e\d+|10\s*\*\*)/],
    ["BigInt power-of-ten scale (10n ** d)", /\b10n\s*\*\*/],
    ["Number(raw) of a bigint amount divided", /\bNumber\([^()]*\)\s*\//],
    ["division by 1_000_000", /\/\s*1_?000_?000\b/],
    ["toFixed", /\.toFixed\s*\(/],
    ["toLocaleString", /\.toLocaleString\s*\(/],
    ["Intl.NumberFormat", /\bIntl\.NumberFormat\b/],
    ["raw base-unit label", /\(base units\)/],
  ];
  return checks.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/** A vault-status word as a string literal or JSX text. Exported for the self-test. */
export function statusLabelViolations(rawText: string): string[] {
  const text = stripComments(rawText);
  const re =
    /(["'`>])\s*(Active|ACTIVE|Paused|PAUSED|Retired|RETIRED|Deposits paused|Deposits closed)\b/g;
  return [...text.matchAll(re)].map((m) => `${m[1]}${m[2]}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

describe("one amount formatter, one status resolver", () => {
  const files = walk(SRC).map((p) => [relative(SRC, p), readFileSync(p, "utf8")] as const);

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("no module outside lib/format.ts scales or formats a raw amount itself", () => {
    const offenders = files
      .filter(([f]) => !SCALING_ALLOWED.has(f))
      .flatMap(([f, s]) => scalingViolations(s).map((v) => `${f}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it("no hardcoded vault status label exists outside the deposit-state resolver", () => {
    const offenders = files
      .filter(([f]) => f !== RESOLVER_MODULE && f !== GENERATED && !GATEWAY_FLAG_ALLOWED.has(f))
      .flatMap(([f, s]) => statusLabelViolations(s).map((v) => `${f}: ${v}`));
    expect(offenders).toEqual([]);
  });

  it("the gateway-flag allowlist never says Active", () => {
    for (const f of GATEWAY_FLAG_ALLOWED) {
      const src = files.find(([n]) => n === f)?.[1] ?? "";
      expect(src, f).not.toMatch(/["'`>]\s*Active\b/);
    }
  });
});

describe("the scans catch what they are meant to catch (self-test)", () => {
  it("flags ad-hoc amount formatting", () => {
    expect(scalingViolations("const x = Number(raw) / 10 ** 6;")).not.toEqual([]);
    expect(scalingViolations("const x = Number(raw) / 1e6;")).not.toEqual([]);
    expect(scalingViolations("import { formatUnits } from 'viem';")).not.toEqual([]);
    expect(scalingViolations("const s = 10n ** BigInt(d);")).not.toEqual([]);
    expect(scalingViolations("v.toFixed(2)")).not.toEqual([]);
    expect(scalingViolations("n.toLocaleString('en-US')")).not.toEqual([]);
    expect(scalingViolations("`${x} (base units)`")).not.toEqual([]);
  });

  it("ignores comments and the shared formatter calls", () => {
    expect(scalingViolations("// Number(raw) / 10 ** 6\nformatUsdc(raw)")).toEqual([]);
    expect(scalingViolations("/* formatUnits */ const a = formatShares(raw);")).toEqual([]);
  });

  it("flags a hardcoded status label", () => {
    expect(statusLabelViolations('{leg.unavailable ? "x" : "Active"}')).not.toEqual([]);
    expect(statusLabelViolations("<td>Paused</td>")).not.toEqual([]);
    expect(statusLabelViolations("const s = 'Retired';")).not.toEqual([]);
  });

  it("ignores identifiers and comments", () => {
    expect(statusLabelViolations("const a = VaultStatus.Active; // Active")).toEqual([]);
    expect(statusLabelViolations('name: "NoActiveAdapters"')).toEqual([]);
  });
});
