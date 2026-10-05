#!/usr/bin/env bun
// Rehearsal sheet: a template sheet (default: the committed example, which is Twin chain data) with the lines of a fragment
// (`bun src/rehearsal/cli.ts keys` output: roles, voters and Safe owners from throwaway keystores) replacing the same names.
// The result goes through the real sheet parser before it is written, so a bad merge fails here and not in a stage.
// bun src/ci/merge-sheet.ts --template FILE --fragment FILE --out FILE
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseSheet } from "../sheet.ts";

export function mergeSheet(template: string, fragment: string): string {
  const over = new Map<string, string>();
  for (const l of fragment.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) over.set(m[1]!, m[2]!);
  }
  if (over.size === 0) throw new Error("the fragment has no NAME=value lines");
  const done = new Set<string>();
  const out = template.split("\n").map((l) => {
    const m = /^([A-Z0-9_]+)=/.exec(l);
    if (m && over.has(m[1]!)) { done.add(m[1]!); return `${m[1]}=${over.get(m[1]!)}`; }
    return l;
  });
  for (const [k, v] of over) if (!done.has(k)) out.push(`${k}=${v}`);
  const text = out.join("\n");
  parseSheet(text);
  return text;
}

if (import.meta.main) {
  const { values: v } = parseArgs({ args: process.argv.slice(2), strict: true, options: { template: { type: "string" }, fragment: { type: "string" }, out: { type: "string" } } });
  if (!v.template || !v.fragment || !v.out) { console.error("usage: merge-sheet --template FILE --fragment FILE --out FILE"); process.exit(2); }
  try { writeFileSync(v.out, mergeSheet(readFileSync(v.template, "utf8"), readFileSync(v.fragment, "utf8"))); }
  catch (e) { console.error(`merge-sheet: ${(e as Error).message}`); process.exit(3); }
}
