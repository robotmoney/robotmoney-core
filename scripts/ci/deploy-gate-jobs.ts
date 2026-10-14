// Derives the deploy-gate job set of scripts/ci/required-checks.json from .github/workflows (QA plan v1 T4).
//
// A deploy sha is a `dev` commit, and the release flow pushes a `releases-*` branch at it
// (releases-v0.4.0-base carried both push runs). So the set is every job that runs on EVERY push
// to `dev` or to a `releases-*` branch:
//   - its workflow has a push trigger whose branch filter matches the ref, and no path filter on
//     that push other than a docs-only paths-ignore (`**.md`, `**.txt`; a docs-only sha does not
//     run those suites, so it is never green, and it is not a release sha);
//   - its `if:` is true on a push. KNOWN_CONDITIONS classifies each condition the tree uses (a
//     draft or pull_request skip is true on a push). An unknown condition is an error, so a person
//     classifies a new one instead of this script guessing;
//   - every job it needs is in the set too.
// A matrix job reports one check-run per leg, so it is derived as a prefix: the name before its
// first `${{`, or `name (` when the name has no expression (GitHub appends the leg values in
// parentheses). A job gated on suite 14's deploy-path flag is class required-on-deploy-paths.
//
// required-checks.json must list every derived job: under `required`, or under `optional` or
// `exempt` with a `reason`. compareGate names every gap; check-sha-green.test.ts holds it at zero.
// Usage: bun scripts/ci/deploy-gate-jobs.ts [repo-root]   (prints the derived set and every gap)
// Canonical: docs/development/ci-suites.md (check-sha-green).
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CheckSpec, label, parseConfig, type RequiredChecks } from "./check-sha-green";

/** The refs a deploy sha is pushed to. `releases-vA.B.C` stands for any `releases-*` branch. */
export const REFS = ["dev", "releases-vA.B.C"];

/** paths-ignore globs that only skip a docs-only push. Any other path filter takes the workflow out. */
export const DOCS_ONLY_IGNORE = new Set(["**.md", "**.txt"]);

/** Job conditions the tree uses, by what they do on a push. Add a row when a workflow adds one. */
export const KNOWN_CONDITIONS: Record<string, "push" | "never" | "deploy-paths"> = {
  "github.event_name != 'pull_request' || github.event.pull_request.draft == false": "push",
  "github.event_name != 'pull_request'": "push",
  "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'": "never",
  // suite 14's `changes` job sets deploy=true on every event but pull_request.
  "needs.changes.outputs.deploy == 'true'": "deploy-paths",
};

export interface GateJob {
  /** check-sha-green's label: the name, or `prefix*` for a matrix job. */
  label: string;
  name?: string;
  prefix?: string;
  /** Workflow files that run it (twin-pin runs in several). */
  sources: string[];
  /** Gated on suite 14's deploy-path flag: class required-on-deploy-paths. */
  deployPaths: boolean;
  /** Job-level continue-on-error: its check-run cannot gate anything. */
  continueOnError: boolean;
}

export type Workflows = Record<string, any>;

/** Strips a `${{ }}` wrapper and collapses whitespace. */
export function normalizeCondition(raw: unknown): string {
  let s = String(raw).trim();
  const m = s.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (m) s = m[1];
  return s.replace(/\s+/g, " ").trim();
}

/** GitHub branch filter glob: `**` matches anything, `*` anything but `/`. Other glob syntax is refused. */
export function branchMatches(pattern: string, ref: string): boolean {
  if (/[?+[\]]/.test(pattern)) throw new Error(`unsupported branch pattern ${pattern}: extend branchMatches`);
  const re = pattern
    .split("**")
    .map((part) => part.split("*").map((lit) => lit.replace(/[.^$|(){}\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${re}$`).test(ref);
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

// Patterns apply in order: a later `!pattern` takes a ref back out.
function filterMatches(patterns: unknown, ref: string): boolean {
  let hit = false;
  for (const p of list(patterns)) {
    const s = String(p);
    if (s.startsWith("!")) {
      if (branchMatches(s.slice(1), ref)) hit = false;
    } else if (branchMatches(s, ref)) hit = true;
  }
  return hit;
}

/** True when every push to `ref` runs this workflow (no path filter but a docs-only paths-ignore). */
export function pushRuns(wf: any, ref: string): boolean {
  const on = wf?.on ?? wf?.["true"];
  if (on === "push") return true;
  if (Array.isArray(on)) return on.includes("push");
  if (!on || typeof on !== "object" || !("push" in on)) return false;
  const push = on.push ?? {};
  if (push.branches !== undefined) {
    if (!filterMatches(push.branches, ref)) return false;
  } else if (push["branches-ignore"] !== undefined) {
    if (filterMatches(push["branches-ignore"], ref)) return false;
  } else if (push.tags !== undefined || push["tags-ignore"] !== undefined) {
    return false; // a tags-only push filter never runs for a branch
  }
  if (push.paths !== undefined) return false;
  const ignore = push["paths-ignore"];
  if (!list(ignore).every((g) => DOCS_ONLY_IGNORE.has(String(g)))) return false;
  return true;
}

function needsOf(job: any): string[] {
  if (job?.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)];
}

type Status = "push" | "never" | "deploy-paths";

/** What a job does on a push, given its `if:` and the jobs it needs. Throws on an unknown condition. */
function jobStatus(file: string, jobs: Record<string, any>, key: string, seen: string[] = []): Status {
  if (seen.includes(key)) throw new Error(`${file}: needs cycle through ${key}`);
  const job = jobs[key];
  if (!job) throw new Error(`${file}: a job needs ${key}, which does not exist`);
  let status: Status = "push";
  if (job.if !== undefined) {
    const cond = normalizeCondition(job.if);
    const known = KNOWN_CONDITIONS[cond];
    if (!known) {
      throw new Error(`${file} job ${key}: unknown condition "${cond}"; classify it in KNOWN_CONDITIONS`);
    }
    if (known === "never") return "never";
    status = known;
  }
  // A job runs only when every job it needs ran: a skipped need skips it, a deploy-path need gates it.
  for (const n of needsOf(job)) {
    const s = jobStatus(file, jobs, n, [...seen, key]);
    if (s === "never") return "never";
    if (s === "deploy-paths") status = "deploy-paths";
  }
  return status;
}

/** The check-run label of a job: its name (or key), or a prefix for a matrix job. */
export function checkOf(file: string, key: string, job: any): { name?: string; prefix?: string } {
  const name = job?.name === undefined ? key : String(job.name);
  const matrix = Boolean(job?.strategy?.matrix);
  const at = name.indexOf("${{");
  if (!matrix) {
    if (at >= 0) throw new Error(`${file} job ${key}: name ${name} has an expression but no matrix`);
    return { name };
  }
  if (at < 0) return { prefix: `${name} (` };
  if (at === 0) throw new Error(`${file} job ${key}: matrix name ${name} starts with an expression, no prefix`);
  return { prefix: name.slice(0, at) };
}

/** Every job that runs on every push to one of `refs`, merged by label. */
export function deriveGateJobs(workflows: Workflows, refs: string[] = REFS): GateJob[] {
  const out = new Map<string, GateJob>();
  for (const file of Object.keys(workflows).sort()) {
    const wf = workflows[file];
    if (!refs.some((r) => pushRuns(wf, r))) continue;
    const jobs: Record<string, any> = wf?.jobs ?? {};
    for (const key of Object.keys(jobs)) {
      const job = jobs[key];
      const status = jobStatus(file, jobs, key);
      if (status === "never") continue;
      if (job?.uses !== undefined) throw new Error(`${file} job ${key}: a reusable workflow call on push; classify it by hand`);
      const check = checkOf(file, key, job);
      const l = label(check);
      const prev = out.get(l);
      const coe = job?.["continue-on-error"] !== undefined && job["continue-on-error"] !== false;
      if (prev) {
        if (!prev.sources.includes(file)) prev.sources.push(file);
        prev.deployPaths ||= status === "deploy-paths";
        prev.continueOnError ||= coe;
      } else {
        out.set(l, { label: l, ...check, sources: [file], deployPaths: status === "deploy-paths", continueOnError: coe });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Every check-run label any workflow job can report, whatever its trigger. */
export function allCheckLabels(workflows: Workflows): Set<string> {
  const out = new Set<string>();
  for (const [file, wf] of Object.entries(workflows)) {
    for (const [key, job] of Object.entries<any>(wf?.jobs ?? {})) {
      try {
        out.add(label(checkOf(file, key, job)));
      } catch {
        // A name this mapping cannot read is not a deploy-gate candidate.
      }
    }
  }
  return out;
}

/** Every gap between the list and the derived set. Empty means the list equals the derived set. */
export function compareGate(config: RequiredChecks, derived: GateJob[], workflows: Workflows): string[] {
  const problems: string[] = [];
  const byLabel = new Map(derived.map((d) => [d.label, d]));
  const lists: [string, CheckSpec[]][] = [
    ["required", config.required],
    ["optional", config.optional],
    ["exempt", config.exempt ?? []],
  ];
  const listed = new Map<string, string>();
  for (const [list, specs] of lists) {
    for (const s of specs) {
      const l = label(s);
      const other = listed.get(l);
      if (other) problems.push(`${l} is listed twice (${other} and ${list})`);
      listed.set(l, list);
    }
  }
  for (const d of derived) {
    if (!listed.has(d.label)) {
      problems.push(
        `${d.label} runs on every push to dev or releases-* (${d.sources.join(", ")}) and is in no list: ` +
          `add it to required, or to optional or exempt with a reason`,
      );
    }
  }
  for (const s of config.required) {
    const l = label(s);
    const d = byLabel.get(l);
    if (!d) {
      problems.push(`required ${l} does not run on every push to dev or releases-*: fix its trigger or drop the entry`);
      continue;
    }
    if (!s.source || !d.sources.includes(s.source)) {
      problems.push(`required ${l} names source ${s.source ?? "(none)"}, but it runs in ${d.sources.join(", ")}`);
    }
    if (d.deployPaths !== (s.class === "required-on-deploy-paths")) {
      problems.push(
        d.deployPaths
          ? `required ${l} is gated on the suite 14 deploy-path flag: give it class required-on-deploy-paths`
          : `required ${l} has class ${s.class}, but its job is not gated on the deploy-path flag`,
      );
    }
    if (d.continueOnError) problems.push(`required ${l} has continue-on-error, so its check-run cannot fail`);
  }
  for (const s of config.exempt ?? []) {
    if (!byLabel.has(label(s))) problems.push(`exempt ${label(s)} does not run on every push: drop the entry`);
  }
  const everywhere = allCheckLabels(workflows);
  for (const s of config.optional) {
    if (!everywhere.has(label(s))) problems.push(`optional ${label(s)} is no job in .github/workflows: drop the entry`);
  }
  for (const [list, specs] of lists.slice(1)) {
    for (const s of specs) {
      if (!s.reason || !s.reason.trim()) problems.push(`${list} ${label(s)} has no reason`);
    }
  }
  for (const [, specs] of lists) {
    for (const s of specs) {
      if (s.prefix === undefined) continue;
      for (const d of derived) {
        if (d.name !== undefined && d.name.startsWith(s.prefix)) {
          problems.push(`prefix ${s.prefix} also matches the job ${d.name}`);
        }
      }
    }
  }
  return problems;
}

/** Parses every .github/workflows/*.yml and *.yaml under `root`, by file name. */
export function loadWorkflows(root: string): Workflows {
  const dir = join(root, ".github", "workflows");
  const out: Workflows = {};
  for (const f of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(f)) continue;
    out[f] = (Bun as any).YAML.parse(readFileSync(join(dir, f), "utf8"));
  }
  if (Object.keys(out).length === 0) throw new Error(`no workflow in ${dir}`);
  return out;
}

export function main(argv: string[]): number {
  const root = resolve(argv[0] ?? join(import.meta.dir, "..", ".."));
  try {
    const workflows = loadWorkflows(root);
    const derived = deriveGateJobs(workflows);
    const config = parseConfig(JSON.parse(readFileSync(join(root, "scripts/ci/required-checks.json"), "utf8")));
    for (const d of derived) {
      console.log(`${d.label}\t${d.sources.join(",")}${d.deployPaths ? "\trequired-on-deploy-paths" : ""}`);
    }
    const problems = compareGate(config, derived, workflows);
    for (const p of problems) console.error(`deploy-gate-jobs: ${p}`);
    console.error(`deploy-gate-jobs: ${derived.length} derived jobs, ${problems.length} gaps`);
    return problems.length === 0 ? 0 : 1;
  } catch (e) {
    console.error(`deploy-gate-jobs: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
