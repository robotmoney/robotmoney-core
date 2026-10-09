#!/usr/bin/env bun
// No-secret scan of a rehearsal's evidence: every file in the folder (the sheet fragment, the keys-fragment output, the merged
// sheet, logs) through the evidence secret scan, the passphrase value searched for literally, and the recorded spawn arguments
// (spawn-args.txt, one argv element per line) checked for secret flags and key-shaped values.
// bun src/ci/scan-rehearsal-secrets.ts --evidence DIR --password-file FILE
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { scanEvidenceFolder } from "../evidence-check.ts";
import { argvSecretProblems } from "../rehearsal/args.ts";

function files(d: string): string[] {
  return readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? files(join(d, n)) : [join(d, n)]));
}

export function scanRehearsal(evidenceDir: string, secrets: string[] = []): string[] {
  const out = scanEvidenceFolder(evidenceDir);
  if (!existsSync(evidenceDir)) return out;
  for (const f of files(evidenceDir)) {
    const text = readFileSync(f, "utf8");
    for (const s of secrets) if (s.length >= 8 && text.includes(s)) out.push(`${f}: contains a secret value`);
    if (f.endsWith("spawn-args.txt")) out.push(...argvSecretProblems(text.split("\n").filter(Boolean), secrets).map((p) => `${f}: ${p}`));
  }
  return out;
}

if (import.meta.main) {
  const { values: v } = parseArgs({ args: process.argv.slice(2), strict: true, options: { evidence: { type: "string" }, "password-file": { type: "string" } } });
  if (!v.evidence) { console.error("usage: scan-rehearsal-secrets --evidence DIR [--password-file FILE]"); process.exit(2); }
  const pw = v["password-file"] && existsSync(v["password-file"]) ? readFileSync(v["password-file"], "utf8").trim() : "";
  const hits = scanRehearsal(v.evidence, pw ? [pw] : []);
  if (hits.length) { for (const h of hits) console.error(`secret scan: ${h}`); process.exit(1); }
  console.log("secret scan: clean");
}
