#!/usr/bin/env bun
// Canonical: issue 1926, docs/operations/contract-release-runbooks.md (libs stage and freeze-counts). Job contract-build-reproducibility (suite-01-02-forge-tests.yml).
//
// Proves the contract build does not depend on where the repository is checked out. Two checkouts of the same commit at different absolute paths are
// built the way the deploy stages compile: the libs-stage libraries (stage table `libraries`, TickMath) alone, then every other source with
// `--libraries <path>:<name>:<address>` set to the libs' CREATE2 addresses derived from that build (as libs-build.ts does). For every library (`libraries`,
// `create2Libraries`) and every upgradeable implementation (stage table `proxies`) the creation code and the runtime code must be byte-identical: the
// CREATE2 address of a library is a hash of its creation code, which ends in the solc metadata hash. And no artifact's solc metadata may hold an
// absolute path (forge records a context remapping with an absolute path, which is what made the bytes path-dependent before issue 1926).
//
// Usage: bun publish-contracts/src/ci/check-build-reproducible.ts --core-a DIR --core-b DIR     (builds both with the pinned forge)
//        bun publish-contracts/src/ci/check-build-reproducible.ts --a-out DIR --b-out DIR [--table FILE]   (two build roots already built, each with link/ and impl/)
// Exit 0: at least one artifact compared, all identical, no absolute path. Exit 1: a difference, a missing artifact, an absolute path or nothing compared.
// Exit 2: tooling or input error (a forge other than the pinned version, a failing build, a bad argument).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { assertPinnedForge } from "../forge-version.ts";
import { buildCreate2Libraries } from "../libs-adopt.ts";
import { parseStageTable, type StageTable } from "../stage-table.ts";

/** The two output directories of one build root: the libs-stage build and everything else compiled with the libs linked. */
export const LINK_DIR = "link";
export const IMPL_DIR = "impl";

export interface Target { name: string; kind: "library" | "create2-library" | "implementation"; dir: typeof LINK_DIR | typeof IMPL_DIR }
export interface Row { target: Target; ok: boolean; detail: string }
export interface AbsolutePath { artifact: string; where: string; value: string }
export interface Report { rows: Row[]; absolute: AbsolutePath[] }

/** Every artifact the deploy stages put on chain by CREATE2 or as a proxy implementation, from the stage table. */
export function targetsOf(t: StageTable): Target[] {
  const out: Target[] = [];
  const seen = new Set<string>();
  const add = (x: Target): void => { if (!seen.has(x.name)) { seen.add(x.name); out.push(x); } };
  for (const l of t.libraries) add({ name: l.artifact, kind: "library", dir: LINK_DIR });
  for (const l of t.create2Libraries ?? []) add({ name: l.artifact, kind: "create2-library", dir: IMPL_DIR });
  for (const s of t.stages) for (const p of s.proxies ?? []) add({ name: p.contract, kind: "implementation", dir: IMPL_DIR });
  return out;
}

/** The forge artifact JSON of `name` under `outDir` (<out>/<Name>.sol/<Name>.json, else the first <out>/<any>/<Name>.json), or undefined. */
export function readArtifact(outDir: string, name: string): any | undefined {
  let p = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) {
    const hit = existsSync(outDir) ? readdirSync(outDir).find((d) => existsSync(join(outDir, d, `${name}.json`))) : undefined;
    if (!hit) return undefined;
    p = join(outDir, hit, `${name}.json`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

const metadataOf = (art: any): any => {
  if (art?.metadata && typeof art.metadata === "object") return art.metadata;
  if (typeof art?.rawMetadata === "string") { try { return JSON.parse(art.rawMetadata); } catch { return undefined; } }
  return undefined;
};

/**
 * Absolute paths in one artifact's solc metadata: a remapping whose context or prefix or target is absolute, a source unit name, a compilation target
 * or a library key that is absolute, and any of `roots` (the checkout directories) appearing anywhere in the raw metadata.
 */
export function absolutePathsIn(art: any, label: string, roots: string[] = []): AbsolutePath[] {
  const out: AbsolutePath[] = [];
  const m = metadataOf(art);
  if (!m) return out;
  for (const r of (m.settings?.remappings ?? []) as string[]) {
    const [lhs, target = ""] = String(r).split("=");
    const [context, prefix] = lhs!.includes(":") ? lhs!.split(":") : ["", lhs!];
    if ([context, prefix, target].some((p) => p !== undefined && p !== "" && isAbsolute(p))) out.push({ artifact: label, where: "settings.remappings", value: r });
  }
  for (const k of Object.keys(m.sources ?? {})) if (isAbsolute(k)) out.push({ artifact: label, where: "sources", value: k });
  for (const k of Object.keys(m.settings?.compilationTarget ?? {})) if (isAbsolute(k)) out.push({ artifact: label, where: "settings.compilationTarget", value: k });
  for (const k of Object.keys(m.settings?.libraries ?? {})) if (isAbsolute(k.split(":")[0]!)) out.push({ artifact: label, where: "settings.libraries", value: k });
  const raw = JSON.stringify(m);
  for (const root of roots) if (root && raw.includes(root)) out.push({ artifact: label, where: "metadata", value: root });
  return out;
}

/** Every artifact JSON under a forge out/ directory (<out>/<File>.sol/<Name>.json). build-info and cache files are not artifacts. */
export function listArtifacts(outDir: string): string[] {
  if (!existsSync(outDir)) return [];
  const files: string[] = [];
  for (const d of readdirSync(outDir)) {
    const dir = join(outDir, d);
    if (d === "build-info" || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".json")) files.push(join(dir, f));
  }
  return files.sort();
}

/** Compares two build roots (each with link/ and impl/) for `targets`, and scans every artifact of both for absolute paths. */
export function compareRoots(a: string, b: string, targets: Target[], roots: string[] = []): Report {
  const rows: Row[] = targets.map((target) => {
    const x = readArtifact(join(a, target.dir), target.name), y = readArtifact(join(b, target.dir), target.name);
    if (!x || !y) return { target, ok: false, detail: `no artifact in ${!x ? "build A" : "build B"} (${target.dir}/)` };
    const cx = String(x.bytecode?.object ?? ""), cy = String(y.bytecode?.object ?? "");
    const rx = String(x.deployedBytecode?.object ?? ""), ry = String(y.deployedBytecode?.object ?? "");
    if (!/^0x[0-9a-fA-F_$]+$/.test(cx) || !/^0x[0-9a-fA-F_$]+$/.test(rx)) return { target, ok: false, detail: "the artifact has no creation or runtime code" };
    if (cx !== cy) return { target, ok: false, detail: `CREATION CODE DIFFERS (${firstDiff(cx, cy)})` };
    if (rx !== ry) return { target, ok: false, detail: `RUNTIME CODE DIFFERS (${firstDiff(rx, ry)})` };
    return { target, ok: true, detail: `identical (${(cx.length - 2) / 2} creation bytes)` };
  });
  const absolute: AbsolutePath[] = [];
  for (const [side, root] of [["A", a], ["B", b]] as const) for (const dir of [LINK_DIR, IMPL_DIR]) for (const f of listArtifacts(join(root, dir))) {
    let art: any;
    try { art = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    absolute.push(...absolutePathsIn(art, `${side}:${f.slice(root.length + 1)}`, roots));
  }
  return { rows, absolute };
}

const firstDiff = (x: string, y: string): string => {
  if (x.length !== y.length) return `${(x.length - 2) / 2} vs ${(y.length - 2) / 2} bytes`;
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return `first difference at byte ${Math.floor((i - 2) / 2)} of ${(x.length - 2) / 2}`;
};

/** One summary line; the CI job greps it for a non-zero compared count, 0 differ and 0 absolute paths. */
export const summaryLine = (r: Report): string => `compared ${r.rows.length} artifact(s), ${r.rows.filter((x) => x.ok).length} identical, ${r.rows.filter((x) => !x.ok).length} differ, ${r.absolute.length} absolute path(s) in metadata`;
export const exitCodeOf = (r: Report): number => (r.rows.length === 0 || r.rows.some((x) => !x.ok) || r.absolute.length > 0 ? 1 : 0);

/** Builds one checkout into `root` (link/ and impl/), the way the deploy stages compile. */
export function buildCheckout(core: string, root: string, t: StageTable, forge = process.env.FORGE ?? "forge"): void {
  const build = (args: string[], out: string): void => {
    const r = Bun.spawnSync([forge, "build", ...args, "--out", join(root, out), "--cache-path", join(root, `${out}-cache`)], { cwd: core, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`forge build in ${core} exited ${r.exitCode}: ${r.stderr.toString().trim().split("\n").slice(-5).join(" | ")}`);
  };
  const linked = t.libraries.map((l) => ({ name: l.name, artifact: l.artifact, path: l.path }));
  build(linked.map((l) => l.path), LINK_DIR);
  const addr = [...buildCreate2Libraries(linked, join(root, LINK_DIR)).values()];
  build(["--skip", "test", "--skip", "script", ...addr.flatMap((a) => ["--libraries", `${linked.find((l) => l.artifact === a.artifact)!.path}:${a.artifact}:${a.address}`])], IMPL_DIR);
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const coreA = arg(argv, "--core-a"), coreB = arg(argv, "--core-b");
  let outA = arg(argv, "--a-out"), outB = arg(argv, "--b-out");
  if (!!coreA !== !!coreB || !!outA !== !!outB || (!coreA && !outA) || (coreA && outA)) { console.error("usage: --core-a DIR --core-b DIR, or --a-out DIR --b-out DIR [--table FILE]"); return 2; }
  let scratch: string | undefined;
  try {
    const tablePath = arg(argv, "--table") ?? join(coreA ? resolve(coreA) : resolve(import.meta.dir, "..", "..", ".."), "scripts", "deploy", "stage-table.json");
    const table = parseStageTable(JSON.parse(readFileSync(tablePath, "utf8")), tablePath);
    const roots: string[] = [];
    if (coreA && coreB) {
      const a = resolve(coreA), b = resolve(coreB);
      if (a === b) { console.error("--core-a and --core-b are the same directory: the check needs two checkouts at different absolute paths"); return 2; }
      const forge = process.env.FORGE ?? "forge";
      console.log(`forge ${assertPinnedForge(forge)}`);
      scratch = mkdtempSync(join(tmpdir(), "build-reproducible-"));
      outA = join(scratch, "a"); outB = join(scratch, "b");
      buildCheckout(a, outA, table, forge);
      buildCheckout(b, outB, table, forge);
      roots.push(a, b);
      console.log(`built ${a} and ${b}`);
    }
    const report = compareRoots(resolve(outA!), resolve(outB!), targetsOf(table), roots);
    for (const r of report.rows) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.target.kind.padEnd(15)} ${r.target.name.padEnd(32)} ${r.detail}`);
    for (const p of report.absolute.slice(0, 20)) console.log(`FAIL absolute path in ${p.artifact} ${p.where}: ${p.value}`);
    if (report.absolute.length > 20) console.log(`... and ${report.absolute.length - 20} more absolute path(s)`);
    console.log(summaryLine(report));
    return exitCodeOf(report);
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
