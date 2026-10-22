#!/usr/bin/env bun
// Canonical: docs/technical/smart-contract-invariants.md (SYS-1, ACL-9), docs/architecture.md section 1 and section 10; core issue 1892.
//
// Static guard for the two-system split. It reads contract SOURCE (comments stripped), never a build.
//   SYS-1  no vaults-system contract depends on the rmpc gateway: it imports nothing from contracts/gateway/ (except what the baseline lists),
//          names no RobotMoneyGateway, IGateway, GatewayWindows or onlyGateway, and keeps no `gateway` state, argument or modifier.
//   ACL-9  the gateway artifact (RobotMoneyGateway.sol and AccessRoles.sol, re-checked on every gateway upgrade) has no authorizeAgent, no
//          transferAgentOwnership, no role-gated function that registers an agent, and no role exception for the share receiver.
// A violation is refused unless it is listed in scripts/ci/system-split-baseline.json (a known violation with the issue that removes it).
// A baseline entry that no longer matches is reported as stale and does not fail the run, so a sibling that removes the code needs no baseline edit.
// Usage: bun scripts/ci/check-system-split.ts [--root DIR]   (default: repo root; the self-test plants mutations in a temp tree)
// Exit 0: clean. Exit 1: a violation, or no file scanned.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Files of the gateway system. Everything else under contracts/ (not test, script, doc) is the vaults system. */
export const GATEWAY_SYSTEM_FILES = [
  "contracts/gateway/RobotMoneyGateway.sol",
  "contracts/gateway/AccessRoles.sol",
  "contracts/gateway/interfaces/IGateway.sol",
  "contracts/gateway/interfaces/IPortfolioRouter.sol",
  "contracts/lib/GatewayWindows.sol",
];
/** The gateway upgrade artifact: the files ACL-9 is enforced on. */
export const GATEWAY_ARTIFACT_FILES = ["contracts/gateway/RobotMoneyGateway.sol", "contracts/gateway/AccessRoles.sol"];
const SKIP_DIRS = new Set(["test", "script", "doc", "node_modules", "out", "cache", "vendor"]);

export interface Violation { rule: string; file: string; detail: string }
export interface BaselineEntry { rule: string; file: string; issue: number; reason: string }

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every function in the source: name, header (text between the parameter list and the body) and body. */
export function functions(code: string): { name: string; header: string; body: string }[] {
  const out: { name: string; header: string; body: string }[] = [];
  const re = /\bfunction\s+(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < code.length && depth > 0) { const c = code[i++]; if (c === "(") depth++; else if (c === ")") depth--; }
    const hs = i;
    while (i < code.length && code[i] !== "{" && code[i] !== ";") i++;
    const header = code.slice(hs, i);
    let body = "";
    if (code[i] === "{") {
      let d = 1; const bs = ++i;
      while (i < code.length && d > 0) { const c = code[i++]; if (c === "{") d++; else if (c === "}") d--; }
      body = code.slice(bs, i - 1);
    }
    out.push({ name: m[1]!, header, body });
  }
  return out;
}

export function sys1(rel: string, code: string): Violation[] {
  const v: Violation[] = [];
  for (const imp of code.matchAll(/import[^;]*?["']([^"']+)["']/g)) {
    if (/(^|\/)gateway\//.test(imp[1]!) || /GatewayWindows/.test(imp[1]!)) v.push({ rule: "SYS-1:import", file: rel, detail: `imports ${imp[1]}` });
  }
  const ident = /\b(RobotMoneyGateway|IGateway|GatewayWindows|onlyGateway|CallerNotGateway|AccessRoles)\b|\bgateway\w*\b/gi;
  const hit = new Set<string>();
  for (const x of code.matchAll(ident)) hit.add(x[0]);
  if (hit.size > 0) v.push({ rule: "SYS-1:name", file: rel, detail: `names the gateway: ${[...hit].sort().join(", ")}` });
  return v;
}

export function acl9(rel: string, code: string): Violation[] {
  const v: Violation[] = [];
  for (const f of functions(code)) {
    if (f.name === "authorizeAgent") v.push({ rule: "ACL-9:authorizeAgent", file: rel, detail: "defines authorizeAgent" });
    if (f.name === "transferAgentOwnership") v.push({ rule: "ACL-9:transferAgentOwnership", file: rel, detail: "defines transferAgentOwnership" });
    const gated = /\bonlyRole\s*\(/.test(f.header);
    if (gated && /_grantRole\s*\(\s*AGENT_ROLE|\b_authorizeAgent\w*\s*\(|\bagentOwner\s*\[[^\]]*\]\s*=[^=]|\bagents\s*\[[^\]]*\]\s*=[^=]/.test(f.body)) {
      v.push({ rule: "ACL-9:role-registers-agent", file: rel, detail: `${f.name} is role-gated and registers an agent` });
    }
    if (/shareReceiver/.test(f.body) && /hasRole\s*\(\s*ADMIN_ROLE/.test(f.body)) {
      v.push({ rule: "ACL-9:share-receiver-exception", file: rel, detail: `${f.name} lets ADMIN_ROLE name a share receiver` });
    }
  }
  return v;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".sol")) out.push(p);
  }
  return out;
}

export function check(repo: string): { scanned: number; violations: Violation[]; stale: BaselineEntry[]; known: Violation[] } {
  const files = walk(join(repo, "contracts")).map((f) => relative(repo, f).split("\\").join("/"));
  const found: Violation[] = [];
  for (const rel of files) {
    const code = stripComments(readFileSync(join(repo, rel), "utf8"));
    if (!GATEWAY_SYSTEM_FILES.includes(rel)) found.push(...sys1(rel, code));
    if (GATEWAY_ARTIFACT_FILES.includes(rel)) found.push(...acl9(rel, code));
  }
  const bp = join(repo, "scripts/ci/system-split-baseline.json");
  const baseline: BaselineEntry[] = existsSync(bp) ? (JSON.parse(readFileSync(bp, "utf8")) as { known: BaselineEntry[] }).known : [];
  const isKnown = (x: Violation) => baseline.some((b) => b.rule === x.rule && b.file === x.file);
  return {
    scanned: files.length,
    violations: found.filter((x) => !isKnown(x)),
    known: found.filter(isKnown),
    stale: baseline.filter((b) => !found.some((x) => x.rule === b.rule && x.file === b.file)),
  };
}

if (import.meta.main) {
  const ri = process.argv.indexOf("--root");
  const repo = resolve(ri >= 0 ? process.argv[ri + 1]! : join(import.meta.dir, "..", ".."));
  const r = check(repo);
  if (r.scanned === 0) { console.error("check-system-split: FAIL: no contract file scanned (zero checks ran)"); process.exit(1); }
  for (const s of r.stale) console.warn(`check-system-split: stale baseline entry (remove it): ${s.rule} ${s.file} (issue ${s.issue})`);
  for (const k of r.known) console.log(`check-system-split: known violation (baseline): ${k.rule} ${k.file}: ${k.detail}`);
  if (r.violations.length > 0) {
    for (const x of r.violations) console.error(`check-system-split: FAIL ${x.rule} ${x.file}: ${x.detail}`);
    process.exit(1);
  }
  console.log(`check-system-split: OK, ${r.scanned} contract files scanned, ${r.known.length} known violations in the baseline`);
}
