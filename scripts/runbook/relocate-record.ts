#!/usr/bin/env bun
// scripts/runbook/relocate-record.ts: point every prior proxy upgrade of a COPIED run manifest at a clean local checkout of the build it was made from, so the verifier
// and deploy-implementation can read those builds on this host (releases/v0.10.0-onevault-upgrade.yaml P0.91; v0.9.0's P0.91 used relocate-deploy4-v080.ts, now a wrapper).
//   bun scripts/runbook/relocate-record.ts MANIFEST [--core-sha SHA] --entry NAME@IMPL=SHA ... --checkout SHA=DIR ...
// Each --entry pins one proxy_upgrades entry, in record order: its proxy_name, its to_implementation and the commit its build was made from. Each --checkout maps a
// build SHA to a local checkout. The record must hold exactly the pinned entries, each with a schedule and an execute tx; a recorded build_sha must equal the pin.
// Every entry keeps its first path as original_build, and gains build (the checkout) and build_sha. Every checkout must be a clean checkout at its SHA.
// Refused with nothing written (exit 1): another system or core sha, an entry count, name or implementation other than the pins, an entry SHA with no --checkout,
// a checkout at another commit or with changes. Exit 2 on a usage error. The live record is never written: the runbook passes the copy in the evidence dir.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { UsageError, runMain } from "./cast-io.ts";

export interface Pin { proxy: string; implementation: string; sha: string }
/** The problem with a checkout of `sha` at `dir`, or undefined when it is a clean checkout of that commit. */
export type CheckoutProblem = (dir: string, sha: string) => string | undefined;

export const gitCheckoutProblem: CheckoutProblem = (dir, sha) => {
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  let head: string, status: string;
  try { head = git("rev-parse", "HEAD"); status = git("status", "--porcelain"); } catch (e) { return `${dir} is not a git checkout: ${(e as Error).message.split("\n")[0]}`; }
  if (head !== sha) return `${dir} is at ${head}, not ${sha}`;
  if (status) return `${dir} has changes: ${status.split("\n")[0]}`;
  return undefined;
};

/** Relocates `m` in place and returns it, or throws naming the first problem. Checks everything before writing anything. */
export function relocateRecord(m: any, o: { coreSha?: string; pins: Pin[]; checkouts: Record<string, string>; checkoutProblem: CheckoutProblem }): any {
  if (m?.system !== "fund") throw new Error(`the record's system is ${m?.system}, not fund`);
  if (o.coreSha && m.coreSha !== o.coreSha) throw new Error(`the record's coreSha is ${m.coreSha}, not ${o.coreSha}`);
  const list = m.proxy_upgrades;
  if (!Array.isArray(list) || list.length !== o.pins.length) throw new Error(`the record has ${Array.isArray(list) ? list.length : "no"} proxy_upgrades entries, not the ${o.pins.length} pinned`);
  list.forEach((e: any, i: number) => {
    const p = o.pins[i]!;
    const at = `proxy_upgrades[${i}] (${e?.proxy_name})`;
    if (e?.proxy_name !== p.proxy) throw new Error(`${at} is not the pinned ${p.proxy}`);
    if (String(e.to_implementation).toLowerCase() !== p.implementation.toLowerCase()) throw new Error(`${at} upgraded to ${e.to_implementation}, not the pinned ${p.implementation}`);
    if (!e.schedule_tx || !e.execute_tx || typeof e.build !== "string" || !e.build) throw new Error(`${at} lacks its schedule_tx, execute_tx or build`);
    if (e.build_sha && e.build_sha !== p.sha) throw new Error(`${at} records build_sha ${e.build_sha}, not the pinned ${p.sha}`);
    if (!o.checkouts[p.sha]) throw new Error(`${at}: no --checkout maps its build SHA ${p.sha}`);
  });
  for (const [sha, dir] of Object.entries(o.checkouts)) {
    const bad = o.checkoutProblem(dir, sha);
    if (bad) throw new Error(`the checkout of ${sha} is not clean at that commit: ${bad}`);
  }
  list.forEach((e: any, i: number) => {
    const sha = o.pins[i]!.sha;
    e.original_build ??= e.build;
    e.build = o.checkouts[sha];
    e.build_sha = sha;
  });
  return m;
}

/** PURE. The CLI's arguments. */
export function parseArgs(argv: string[]): { file: string; coreSha?: string; pins: Pin[]; checkouts: Record<string, string> } {
  const [file, ...rest] = argv;
  if (!file || file.startsWith("--")) throw new UsageError("missing MANIFEST");
  const pins: Pin[] = [];
  const checkouts: Record<string, string> = {};
  let coreSha: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!, v = rest[i + 1];
    if (v === undefined) throw new UsageError(`${k} needs a value`);
    if (k === "--core-sha") coreSha = v;
    else if (k === "--entry") {
      const m = /^([^@]+)@(0x[0-9a-fA-F]{40})=([0-9a-f]{40})$/.exec(v);
      if (!m) throw new UsageError(`--entry ${v} is not NAME@IMPL=SHA`);
      pins.push({ proxy: m[1]!, implementation: m[2]!, sha: m[3]! });
    } else if (k === "--checkout") {
      const m = /^([0-9a-f]{40})=(.+)$/.exec(v);
      if (!m) throw new UsageError(`--checkout ${v} is not SHA=DIR`);
      checkouts[m[1]!] = resolve(m[2]!);
    } else throw new UsageError(`unknown option ${k}`);
  }
  if (!pins.length || !Object.keys(checkouts).length) throw new UsageError("needs at least one --entry and one --checkout");
  return { file, coreSha, pins, checkouts };
}

if (import.meta.main) {
  await runMain("usage: relocate-record.ts MANIFEST [--core-sha SHA] --entry NAME@IMPL=SHA ... --checkout SHA=DIR ...", () => {
    const a = parseArgs(process.argv.slice(2));
    const m = relocateRecord(JSON.parse(readFileSync(a.file, "utf8")), { ...a, checkoutProblem: gitCheckoutProblem });
    writeFileSync(a.file, JSON.stringify(m, null, 2) + "\n");
    for (const e of m.proxy_upgrades) console.log(`${e.proxy_name} ${e.to_implementation}: ${e.original_build} -> ${e.build} (${e.build_sha})`);
  });
}
