// Source guard for issues 1767 and 1773 (QA plan U5): share-count formatting never takes a hardcoded rm*
// unit literal. Every share count prints the vault's own symbol() (useVaultShareSymbols), or the neutral
// "shares". Scans src/components and src/lib, so the signing previews (vaultPreview.ts, routerPreview.ts)
// are covered too, and a call split over several lines or with nested parentheses is still read whole.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

const files = walk(SRC)
  .filter((p) => !p.endsWith("abi.generated.ts"))
  .map((p) => [relative(SRC, p), readFileSync(p, "utf8")] as const);

/** The share formatters, under any local alias the preview modules give them. */
const FORMATTERS = ["formatShares", "formatSharesString", "_formatShares"];
const RM_LITERAL = /["'`]rm[A-Za-z]+["'`]/;

/** The argument text of every call to `name` in `src`, read to the matching close parenthesis. */
export function callArguments(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/\$/g, "\\$")}\\s*\\(`, "g");
  for (const m of src.matchAll(re)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      i += 1;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Every formatter call in `src` whose arguments carry a quoted rm* unit. */
export function hardcodedUnitCalls(src: string): string[] {
  return FORMATTERS.flatMap((name) =>
    callArguments(src, name)
      .filter((args) => RM_LITERAL.test(args))
      .map((args) => `${name}(${args.replace(/\s+/g, " ").trim()})`),
  );
}

describe("no hardcoded share-unit literal in share-count formatting", () => {
  it("scans a non-empty source set, including the preview modules", () => {
    expect(files.length).toBeGreaterThan(50);
    const names = files.map(([f]) => f);
    for (const f of ["lib/vaultPreview.ts", "lib/routerPreview.ts", "lib/format.ts"]) {
      expect(names).toContain(f);
    }
  });

  for (const [f, src] of files) {
    it(`${f} passes no quoted rm* symbol to a share formatter`, () => {
      expect(hardcodedUnitCalls(src)).toEqual([]);
    });
  }

  it("the signing previews name no rm* unit at all outside comments", () => {
    for (const f of ["lib/vaultPreview.ts", "lib/routerPreview.ts"]) {
      const code = files
        .find(([name]) => name === f)![1]
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(code, f).not.toMatch(/\brm(USDC|PROTO|AGENT|RWA)\b/);
    }
  });

  it("the scanner itself catches the shapes it exists for", () => {
    const bad = [
      `formatShares(x, "rmUSDC")`,
      `formatSharesString(raw, 'rmPROTO')`,
      "formatShares(x, `rmAGENT`)",
      `_formatShares(raw, "rmUSDC")`,
      `formatShares(\n  typeof b === "bigint" ? f(b) : 0n,\n  "rmUSDC",\n)`,
    ];
    for (const src of bad) expect(hardcodedUnitCalls(src), src).not.toEqual([]);
    const good = [
      `formatShares(x, symbolOf(vault))`,
      `formatShares(x)`,
      `formatSharesString(raw, symbol)`,
      `myformatShares(x, "rmUSDC")`,
      `formatShares(f(x), unit) + " rmUSDC is a word in prose"`,
    ];
    for (const src of good) expect(hardcodedUnitCalls(src), src).toEqual([]);
  });
});
