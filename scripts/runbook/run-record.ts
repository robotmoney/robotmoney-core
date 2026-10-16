#!/usr/bin/env bun
// scripts/runbook/run-record.ts: writes the run records the contract QA runbook (docs/runbooks/contract-qa/) checks, so no step waits on a hand-made file.
//   bun scripts/runbook/run-record.ts go --kind publish|freeze --run-dir D --sha S --target T --sheet F
//       writes D/go/<kind>.json: the sha, the target and the sheet hash the run proceeds with. A freeze go is refused off the Twin chain:
//       on 8453 the freeze is an owner decision, never a runbook default.
//   bun scripts/runbook/run-record.ts report --run-dir D --evidence-dir E --sha S --target T --chain-id C --sheet F --tag TAG
//       writes D/rollout-report.md from the run itself: the sha, the network, the sheet hash, the tag, the journal of every step and the
//       evidence files with their sha256. A pause report (rollout-report-<chain>.json, written by pause-all) is listed as an issue.
//   bun scripts/runbook/run-record.ts signoff --run-dir D --sha S --target T --sheet F
//       writes D/go/signoff.json when the report exists, lists no issue and matches the publish go. Exit 1 otherwise.
// A record that exists is kept when it matches and refused when it differs. Exit 1 is a refusal, exit 2 a usage error. No secret is read or written.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VERBS = ["go", "report", "signoff"] as const;
export const FLAGS = ["kind", "run-dir", "evidence-dir", "sha", "target", "chain-id", "sheet", "tag"] as const;
const TARGETS = ["twin", "rehearsal", "production"];

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function flags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const k = args[i]!.startsWith("--") ? args[i]!.slice(2) : undefined;
    if (!k || !(FLAGS as readonly string[]).includes(k)) throw new Error(`unknown argument '${args[i]}'`);
    const v = args[++i];
    if (v === undefined || v === "") throw new Error(`--${k} needs a value`);
    out[k] = v;
  }
  return out;
}
const need = (f: Record<string, string>, k: string): string => { if (!f[k]) throw new Error(`--${k} is required`); return f[k]!; };

class Refusal extends Error {}

/** The fields every record carries: what the run proceeds with. */
function basis(f: Record<string, string>) {
  const target = need(f, "target");
  if (!TARGETS.includes(target)) throw new Error(`--target is ${TARGETS.join("|")}`);
  const sha = need(f, "sha");
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("--sha is a hex commit sha");
  const sheet = need(f, "sheet");
  if (!existsSync(sheet)) throw new Refusal(`the sheet ${sheet} does not exist`);
  return { coreSha: sha, target, sheetSha256: sha256(sheet) };
}

/** Writes JSON once. A second write with the same basis keeps the first record; a different basis is refused. */
function writeOnce(file: string, record: Record<string, unknown>, same: (old: Record<string, unknown>) => boolean): void {
  if (existsSync(file)) {
    if (same(JSON.parse(readFileSync(file, "utf8")))) return;
    throw new Refusal(`${file} exists for another sha, target or sheet: start a new run directory`);
  }
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}
const sameBasis = (b: Record<string, unknown>) => (old: Record<string, unknown>) => old.coreSha === b.coreSha && old.target === b.target && old.sheetSha256 === b.sheetSha256;

/** PURE. The issues a run shows in its evidence folder listing. */
export function issuesOf(evidenceFiles: string[]): string[] {
  return evidenceFiles.filter((f) => /^rollout-report-[0-9]+\.json$/.test(f)).map((f) => `${f}: a failed verify paused all four vaults (pause-all)`);
}

/** PURE. The rollout report text. */
export function reportText(r: { coreSha: string; target: string; chainId: string; sheetSha256: string; tag: string; journal: { id: string; lines: number; last: string }[]; evidence: { file: string; sha256: string }[]; issues: string[] }): string {
  const out = [
    `# Rollout report`, ``,
    `Written by scripts/runbook/run-record.ts from the run directory. Nothing in it is typed by hand.`, ``,
    `| Field | Value |`, `| --- | --- |`,
    `| Core sha | ${r.coreSha} |`, `| Target | ${r.target} |`, `| Chain id | ${r.chainId} |`, `| Sheet sha256 | ${r.sheetSha256} |`, `| Release tag | ${r.tag} |`, ``,
    `## Issues`, ``, ...(r.issues.length ? r.issues.map((i) => `- ${i}`) : ["None."]), ``,
    `## Steps (journal)`, ``, `| Step | Lines | Last line |`, `| --- | --- | --- |`,
    ...r.journal.map((j) => `| ${j.id} | ${j.lines} | ${j.last.replace(/\|/g, "\\|").slice(0, 160)} |`), ``,
    `## Evidence`, ``, `| File | sha256 |`, `| --- | --- |`, ...r.evidence.map((e) => `| ${e.file} | ${e.sha256} |`), ``,
  ];
  return out.join("\n");
}

function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? listFiles(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)]).sort();
}

export function main(argv: string[]): number {
  const [verb, ...rest] = argv;
  try {
    if (!(VERBS as readonly string[]).includes(verb ?? "")) throw new Error(`the verb is ${VERBS.join("|")}`);
    const f = flags(rest);
    const runDir = need(f, "run-dir");
    const b = basis(f);
    if (verb === "go") {
      const kind = need(f, "kind");
      if (kind !== "publish" && kind !== "freeze") throw new Error("--kind is publish|freeze");
      if (kind === "freeze" && b.target !== "twin") throw new Refusal("a freeze go is recorded by the runbook only on the Twin chain: on 8453 it is an owner decision");
      writeOnce(join(runDir, "go", `${kind}.json`), { kind, ...b, recordedAt: new Date().toISOString(), by: "scripts/runbook/run-record.ts" }, sameBasis(b));
      return 0;
    }
    if (verb === "report") {
      const evidenceDir = need(f, "evidence-dir");
      const journalDir = join(runDir, "journal");
      const journal = listFiles(journalDir).filter((x) => x.endsWith(".out")).map((x) => {
        const lines = readFileSync(join(journalDir, x), "utf8").split("\n").filter((l) => l.trim() !== "");
        return { id: x.replace(/\.out$/, ""), lines: lines.length, last: lines.at(-1) ?? "" };
      });
      const files = listFiles(evidenceDir);
      const text = reportText({ ...b, chainId: need(f, "chain-id"), tag: need(f, "tag"), journal, evidence: files.map((x) => ({ file: x, sha256: sha256(join(evidenceDir, x)) })), issues: issuesOf(files.map((x) => x.split("/").at(-1)!)) });
      writeFileSync(join(runDir, "rollout-report.md"), text);
      return 0;
    }
    // signoff
    const report = join(runDir, "rollout-report.md");
    if (!existsSync(report)) throw new Refusal(`${report} does not exist: run the report verb first`);
    const text = readFileSync(report, "utf8");
    if (!/## Issues\n\nNone\.\n/.test(text)) throw new Refusal(`${report} lists an issue: no sign-off on a run with an issue`);
    const goFile = join(runDir, "go", "publish.json");
    if (!existsSync(goFile) || !sameBasis(b)(JSON.parse(readFileSync(goFile, "utf8")))) throw new Refusal(`${goFile} is missing or names another sha, target or sheet`);
    writeOnce(join(runDir, "go", "signoff.json"), { kind: "signoff", ...b, rolloutReportSha256: sha256(report), recordedAt: new Date().toISOString(), by: "scripts/runbook/run-record.ts" }, sameBasis(b));
    return 0;
  } catch (e) {
    console.error(`run-record: ${(e as Error).message}`);
    return e instanceof Refusal ? 1 : 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
