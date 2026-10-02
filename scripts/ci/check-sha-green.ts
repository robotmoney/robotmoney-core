// CI gate for a deploy: exits 0 only when every required check-run of a commit concluded success.
// Usage: bun scripts/ci/check-sha-green.ts <sha> [--repo owner/name] [--config path] [--api-url url]
// Reads scripts/ci/required-checks.json. Token: GITHUB_TOKEN, GH_TOKEN, or `gh auth token`.
// Exit codes: 0 green, 1 not green (failing, missing or pending required checks), 2 usage or API error.
// Rules:
//   - A required name is missing when no check-run carries it, pending when any run of it is not completed.
//   - Every run of a required name must conclude success. A failure next to a success is a failure.
//   - Optional entries are listed when they are not green and never change the exit code.
// Canonical: docs/development/ci-suites.md (check-sha-green), core 1502.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface CheckSpec {
  name?: string;
  prefix?: string;
  source?: string;
}

export interface RequiredChecks {
  version: number;
  required: CheckSpec[];
  optional: CheckSpec[];
}

export interface Verdict {
  ok: boolean;
  failing: string[];
  missing: string[];
  pending: string[];
  optionalNotGreen: string[];
  passing: string[];
}

const label = (s: CheckSpec): string => (s.name !== undefined ? s.name : `${s.prefix}*`);

function matches(spec: CheckSpec, run: CheckRun): boolean {
  if (spec.name !== undefined) return run.name === spec.name;
  if (spec.prefix !== undefined) return run.name.startsWith(spec.prefix);
  return false;
}

/** Validates the config shape. Throws on a malformed file. */
export function parseConfig(raw: unknown): RequiredChecks {
  const c = raw as RequiredChecks;
  if (!c || c.version !== 1 || !Array.isArray(c.required) || !Array.isArray(c.optional)) {
    throw new Error("required-checks.json must be { version: 1, required: [...], optional: [...] }");
  }
  for (const s of [...c.required, ...c.optional]) {
    if ((s.name === undefined) === (s.prefix === undefined)) {
      throw new Error(`each entry needs exactly one of name or prefix: ${JSON.stringify(s)}`);
    }
  }
  if (c.required.length === 0) throw new Error("required list is empty");
  return c;
}

type State = "success" | "failing" | "pending" | "missing";

function stateOf(spec: CheckSpec, runs: CheckRun[]): { state: State; detail: string } {
  const hit = runs.filter((r) => matches(spec, r));
  if (hit.length === 0) return { state: "missing", detail: "no check-run" };
  const bad = hit.filter((r) => r.status === "completed" && r.conclusion !== "success");
  if (bad.length > 0) {
    return { state: "failing", detail: bad.map((r) => `${r.name}=${r.conclusion}`).join(", ") };
  }
  const open = hit.filter((r) => r.status !== "completed");
  if (open.length > 0) return { state: "pending", detail: open.map((r) => `${r.name}=${r.status}`).join(", ") };
  return { state: "success", detail: "success" };
}

/** Pure verdict over a full list of check-runs. */
export function evaluate(runs: CheckRun[], config: RequiredChecks): Verdict {
  const v: Verdict = { ok: true, failing: [], missing: [], pending: [], optionalNotGreen: [], passing: [] };
  for (const spec of config.required) {
    const { state, detail } = stateOf(spec, runs);
    if (state === "success") v.passing.push(label(spec));
    else if (state === "failing") v.failing.push(`${label(spec)} (${detail})`);
    else if (state === "pending") v.pending.push(`${label(spec)} (${detail})`);
    else v.missing.push(label(spec));
  }
  for (const spec of config.optional) {
    const { state, detail } = stateOf(spec, runs);
    if (state !== "success" && state !== "missing") v.optionalNotGreen.push(`${label(spec)} (${detail})`);
  }
  v.ok = v.failing.length === 0 && v.missing.length === 0 && v.pending.length === 0;
  return v;
}

export function render(sha: string, v: Verdict): string {
  const lines: string[] = [];
  lines.push(`check-sha-green ${sha}: ${v.ok ? "GREEN" : "NOT GREEN"} (${v.passing.length} required checks passed)`);
  for (const f of v.failing) lines.push(`  FAILING  ${f}`);
  for (const m of v.missing) lines.push(`  MISSING  ${m}`);
  for (const p of v.pending) lines.push(`  PENDING  ${p}`);
  for (const o of v.optionalNotGreen) lines.push(`  optional (does not gate) ${o}`);
  return lines.join("\n");
}

type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/** Reads every page of the check-runs listing, following rel="next" Link headers. */
export async function fetchAllCheckRuns(
  apiUrl: string,
  repo: string,
  sha: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<CheckRun[]> {
  let url: string | null = `${apiUrl}/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
  const runs: CheckRun[] = [];
  let pages = 0;
  while (url) {
    if (++pages > 100) throw new Error("more than 100 pages of check-runs, refusing to continue");
    const res: Response = await fetcher(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}`);
    const body = (await res.json()) as { check_runs?: CheckRun[] };
    if (!Array.isArray(body.check_runs)) throw new Error(`no check_runs array in response for ${url}`);
    for (const r of body.check_runs) runs.push({ name: r.name, status: r.status, conclusion: r.conclusion });
    const link = res.headers.get("link") ?? "";
    const next = link.split(",").find((p) => /rel="next"/.test(p));
    const m = next?.match(/<([^>]+)>/);
    url = m ? m[1] : null;
  }
  return runs;
}

function resolveToken(): string {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  const p = Bun.spawnSync(["gh", "auth", "token"]);
  const t = p.stdout.toString().trim();
  if (p.exitCode !== 0 || !t) throw new Error("no token: set GITHUB_TOKEN or GH_TOKEN, or run gh auth login");
  return t;
}

function resolveRepo(arg: string | undefined): string {
  if (arg) return arg;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return "robotmoney/robotmoney-core";
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const [, val] = args.splice(i, 2);
    return val;
  };
  const repo = resolveRepo(take("--repo"));
  const configPath = take("--config") ?? join(resolve(import.meta.dir), "required-checks.json");
  const apiUrl = take("--api-url") ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
  const sha = args[0];
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    console.error("usage: bun scripts/ci/check-sha-green.ts <sha> [--repo owner/name] [--config path]");
    return 2;
  }
  try {
    const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
    const runs = await fetchAllCheckRuns(apiUrl, repo, sha, resolveToken());
    const v = evaluate(runs, config);
    console.log(render(sha, v));
    return v.ok ? 0 : 1;
  } catch (e) {
    console.error(`check-sha-green: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
