// Issue 1603: one source of truth for the chain ids and the 172800 s delay floor.
// (1) the TS floor equals the Solidity constant read from DeployTimelock.s.sol, (2) no file under src but chains.ts carries a literal.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID, MAINNET_DELAY_FLOOR } from "../src/chains.ts";

const SRC = join(import.meta.dir, "..", "src");
const SOL = join(import.meta.dir, "..", "..", "contracts", "script");

const solConst = (file: string, name: string): number => {
  const m = new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`).exec(readFileSync(join(SOL, file), "utf8"));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return Number(m[1].replace(/_/g, ""));
};

/** Source with comments, string text and template text removed: only code remains (template `${}` bodies are code). */
export function codeOnly(src: string): string {
  let out = "";
  const stack: number[] = []; // brace depth at each open template `${`
  let depth = 0;
  let i = 0;
  const template = (): void => {
    // inside template text, from just after the opening backtick or the closing brace of a `${}`
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; stack.push(depth); depth++; out += " "; return; }
      i++;
    }
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1; i++; out += '""'; continue; }
    if (c === "`") { i++; template(); continue; }
    if (c === "/" && /[(,=:[!&|?{};]$|^$/.test(out.trimEnd().slice(-1))) {
      // regex literal (a `/` where an operand is expected): skip it, its class may hold quotes and backticks
      i++;
      let cls = false;
      while (i < src.length && (cls || src[i] !== "/")) { if (src[i] === "\\") i++; else if (src[i] === "[") cls = true; else if (src[i] === "]") cls = false; i++; }
      i++;
      out += "/re/";
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (stack.length > 0 && stack[stack.length - 1] === depth) { stack.pop(); i++; out += " "; template(); continue; }
    }
    out += c;
    i++;
  }
  return out;
}
export const LITERAL = /(?<![\w.])(8453|918453|172_?800)n?(?![\w.])/g;

export function offenders(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [f, text] of Object.entries(files)) for (const m of codeOnly(text).matchAll(LITERAL)) out.push(`${f}: ${m[1]}`);
  return out;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : n.endsWith(".ts") ? [p] : [];
  });
}

describe("one source of truth for chain ids and the delay floor (1603)", () => {
  test("the TS floor and chain ids equal the Solidity constants", () => {
    expect(MAINNET_DELAY_FLOOR).toBe(solConst("DeployTimelock.s.sol", "MIN_PRODUCTION_DELAY"));
    expect(MAINNET_CHAIN_ID).toBe(solConst("ExpectedChainGuard.sol", "BASE_MAINNET_CHAIN_ID"));
    expect(TWIN_CHAIN_ID).not.toBe(MAINNET_CHAIN_ID);
  });

  test("no literal 8453, 918453 or 172800 in src outside chains.ts", () => {
    const files: Record<string, string> = {};
    for (const p of tsFiles(SRC)) if (relative(SRC, p) !== "chains.ts") files[relative(SRC, p)] = readFileSync(p, "utf8");
    expect(Object.keys(files).length).toBeGreaterThan(20);
    expect(offenders(files)).toEqual([]);
  });

  test("the detector flags code literals and ignores comments and strings", () => {
    expect(offenders({ a: "const x = 8453;" })).toEqual(["a: 8453"]);
    expect(offenders({ a: "if (id === 918453n) {}" })).toEqual(["a: 918453"]);
    expect(offenders({ a: "const f = 172_800;" })).toEqual(["a: 172_800"]);
    expect(offenders({ a: "const x = `${8453}`;" })).toEqual(["a: 8453"]);
    expect(offenders({ a: '// 8453\nconst s = "chain 8453 deployments/twin-918453";\n/* 172800 */' })).toEqual([]);
  });
});
