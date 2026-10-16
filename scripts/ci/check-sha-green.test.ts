// Unit tests for scripts/ci/check-sha-green.ts with recorded check-run fixtures. No network.
// Run: bun test scripts/ci/check-sha-green.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CheckRun, evaluate, fetchAllCheckRuns, label, parseConfig, render } from "./check-sha-green";
import { compareGate, deriveGateJobs, loadWorkflows } from "./deploy-gate-jobs";

const repo = resolve(import.meta.dir, "..", "..");
const cfg = parseConfig({
  version: 1,
  required: [{ name: "dapp-lint-build" }, { name: "bun-audit" }, { name: "forge-unit-tests" }],
  optional: [{ name: "config-check-live-base" }, { prefix: "fork-integration-" }],
});
const run = (name: string, conclusion: string | null = "success", status = "completed"): CheckRun => ({
  name,
  status,
  conclusion,
});
const green = (): CheckRun[] => [run("dapp-lint-build"), run("bun-audit"), run("forge-unit-tests")];

describe("evaluate", () => {
  test("all green passes", () => {
    const v = evaluate(green(), cfg);
    expect(v.ok).toBe(true);
    expect(render("abc1234", v)).toContain("GREEN");
  });
  test("one failing required check fails and is named", () => {
    const v = evaluate([run("dapp-lint-build", "failure"), run("bun-audit"), run("forge-unit-tests")], cfg);
    expect(v.ok).toBe(false);
    expect(v.failing[0]).toContain("dapp-lint-build");
    expect(render("abc1234", v)).toContain("FAILING  dapp-lint-build");
  });
  test("a missing required check fails and is named", () => {
    const v = evaluate([run("bun-audit"), run("forge-unit-tests")], cfg);
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(["dapp-lint-build"]);
    expect(render("abc1234", v)).toContain("MISSING  dapp-lint-build");
  });
  test("a pending required check fails and is named", () => {
    const v = evaluate([run("dapp-lint-build", null, "in_progress"), run("bun-audit"), run("forge-unit-tests")], cfg);
    expect(v.ok).toBe(false);
    expect(v.pending[0]).toContain("dapp-lint-build");
    expect(render("abc1234", v)).toContain("PENDING  dapp-lint-build");
  });
  test("a queued required check is pending", () => {
    const v = evaluate([...green().slice(1), run("dapp-lint-build", null, "queued")], cfg);
    expect(v.pending.length).toBe(1);
  });
  test("mixed: one failure and one success on the same required name fails", () => {
    const v = evaluate([...green(), run("bun-audit", "failure")], cfg);
    expect(v.ok).toBe(false);
    expect(v.failing[0]).toContain("bun-audit");
  });
  test("skipped, cancelled and neutral are not success", () => {
    for (const c of ["skipped", "cancelled", "neutral", "timed_out", "action_required"]) {
      expect(evaluate([...green().slice(1), run("dapp-lint-build", c)], cfg).ok).toBe(false);
    }
  });
  test("failing, missing and pending are all reported together", () => {
    const v = evaluate([run("bun-audit", "failure"), run("forge-unit-tests", null, "queued")], cfg);
    expect(v.failing.length + v.missing.length + v.pending.length).toBe(3);
  });
  test("a failing optional check does not change the result and is listed as optional", () => {
    const v = evaluate([...green(), run("config-check-live-base", "failure"), run("fork-integration-a", "failure")], cfg);
    expect(v.ok).toBe(true);
    const out = render("abc1234", v);
    expect(out).toContain("optional (does not gate) config-check-live-base");
    expect(out).toContain("optional (does not gate) fork-integration-*");
  });
  test("an unrelated failing check is ignored", () => {
    expect(evaluate([...green(), run("something-else", "failure")], cfg).ok).toBe(true);
  });
  test("an empty run list is not green", () => {
    expect(evaluate([], cfg).ok).toBe(false);
  });
});

describe("parseConfig", () => {
  test("rejects an entry with both name and prefix", () => {
    expect(() => parseConfig({ version: 1, required: [{ name: "a", prefix: "b" }], optional: [] })).toThrow();
  });
  test("rejects an empty required list", () => {
    expect(() => parseConfig({ version: 1, required: [], optional: [] })).toThrow();
  });
  test("the shipped required-checks.json parses and names the three repaired jobs", () => {
    const c = parseConfig(JSON.parse(readFileSync(resolve(repo, "scripts/ci/required-checks.json"), "utf8")));
    const names = c.required.map((s) => s.name);
    expect(names).toContain("dapp-lint-build");
    expect(names).toContain("bun-audit");
    expect(names).toContain("deleted-stage-gate");
  });
  test("the twin publish job is required-on-deploy-paths with the suite 14 path filter", () => {
    const c = parseConfig(JSON.parse(readFileSync(resolve(repo, "scripts/ci/required-checks.json"), "utf8")));
    const twin = c.required.find((s) => s.name === "smoke-test-twin-publish");
    expect(twin?.class).toBe("required-on-deploy-paths");
    const wf = readFileSync(resolve(repo, ".github/workflows/suite-14-smoke-test.yml"), "utf8");
    for (const path of twin?.paths ?? []) expect(wf.includes(path.replace(/\./g, "\\."))).toBe(true);
  });
  test("every required-on-deploy-paths entry lists exactly the suite 14 changes filter", () => {
    const c = parseConfig(JSON.parse(readFileSync(resolve(repo, "scripts/ci/required-checks.json"), "utf8")));
    const wf = readFileSync(resolve(repo, ".github/workflows/suite-14-smoke-test.yml"), "utf8");
    // The changes job: `grep -Eq '^(contracts/script/|...|\.github/workflows/suite-14-smoke-test\.yml)'`.
    const m = wf.match(/grep -Eq '\^\(([^)]*)\)'/);
    expect(m).not.toBeNull();
    const filter = m![1].split("|").map((p) => p.replace(/\\\./g, ".")).sort();
    const gated = c.required.filter((s) => s.class === "required-on-deploy-paths");
    expect(gated.map((s) => s.name).sort()).toEqual(["smoke-test-twin-pause-all", "smoke-test-twin-publish"]);
    for (const s of gated) expect([...(s.paths ?? [])].sort()).toEqual(filter);
  });
  test("rejects an exempt list that is not a list, and an exempt entry with both name and prefix", () => {
    expect(() => parseConfig({ version: 1, required: [{ name: "a" }], optional: [], exempt: {} })).toThrow();
    expect(() =>
      parseConfig({ version: 1, required: [{ name: "a" }], optional: [], exempt: [{ name: "b", prefix: "c" }] }),
    ).toThrow();
  });
  test("the Twin upgrade lifecycle job is required and the comment names the re-run recovery", () => {
    const raw = JSON.parse(readFileSync(resolve(repo, "scripts/ci/required-checks.json"), "utf8"));
    const c = parseConfig(raw);
    expect(c.required.map((s) => s.name)).toContain("core-stages-twin-upgrade-lifecycle");
    expect(c.optional.map((s) => s.name)).not.toContain("core-stages-twin-upgrade-lifecycle");
    expect(raw.comment).toContain("core-stages-twin-upgrade-lifecycle");
    expect(raw.comment).toContain("re-run");
  });
  test("rejects an unknown class and a deploy-paths entry with no paths", () => {
    expect(() => parseConfig({ version: 1, required: [{ name: "a", class: "x" }], optional: [] })).toThrow();
    expect(() => parseConfig({ version: 1, required: [{ name: "a", class: "required-on-deploy-paths" }], optional: [] })).toThrow();
  });
});

describe("fetchAllCheckRuns pagination", () => {
  test("reads every page by following the Link header", async () => {
    const pages: Record<string, { runs: CheckRun[]; next?: string }> = {
      "https://api.test/repos/o/r/commits/abc1234/check-runs?filter=latest&per_page=100": {
        runs: [run("dapp-lint-build")],
        next: "https://api.test/page2",
      },
      "https://api.test/page2": { runs: [run("bun-audit")], next: "https://api.test/page3" },
      "https://api.test/page3": { runs: [run("forge-unit-tests")] },
    };
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      const p = pages[url];
      if (!p) return new Response("nope", { status: 404 });
      const headers = new Headers();
      if (p.next) headers.set("link", `<${p.next}>; rel="next", <https://api.test/last>; rel="last"`);
      return new Response(JSON.stringify({ total_count: 3, check_runs: p.runs }), { headers });
    };
    const runs = await fetchAllCheckRuns("https://api.test", "o/r", "abc1234", "t", fetcher);
    expect(seen.length).toBe(3);
    expect(runs.map((r) => r.name)).toEqual(["dapp-lint-build", "bun-audit", "forge-unit-tests"]);
    expect(evaluate(runs, cfg).ok).toBe(true);
  });
  test("a required check only on page two is still found", async () => {
    const fetcher = async (url: string) => {
      const first = url.includes("per_page=100");
      const headers = new Headers();
      if (first) headers.set("link", '<https://api.test/p2>; rel="next"');
      const check_runs = first ? [run("bun-audit"), run("forge-unit-tests")] : [run("dapp-lint-build", "failure")];
      return new Response(JSON.stringify({ check_runs }), { headers });
    };
    const runs = await fetchAllCheckRuns("https://api.test", "o/r", "abc1234", "t", fetcher);
    const v = evaluate(runs, cfg);
    expect(v.failing[0]).toContain("dapp-lint-build");
  });
  test("the first request asks for filter=latest so a successful re-run supersedes the failed attempt", async () => {
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ check_runs: green() }));
    };
    await fetchAllCheckRuns("https://api.test", "o/r", "abc1234", "t", fetcher);
    expect(seen.length).toBe(1);
    expect(new URL(seen[0]).searchParams.get("filter")).toBe("latest");
  });
  test("an HTTP error throws", async () => {
    const fetcher = async () => new Response("no", { status: 403 });
    await expect(fetchAllCheckRuns("https://api.test", "o/r", "abc1234", "t", fetcher)).rejects.toThrow("403");
  });
});

describe("the three repaired jobs stay enforced", () => {
  const wf = (f: string) => readFileSync(resolve(repo, ".github/workflows", f), "utf8");
  // Returns the text block of a job, from its key line to the next job key.
  const jobBlock = (text: string, jobKey: string): string => {
    const m = text.match(new RegExp(`^  ${jobKey}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, "m"));
    if (!m) throw new Error(`job ${jobKey} not found`);
    return m[0];
  };
  test("dapp-lint-build has no skip condition and no continue-on-error", () => {
    const b = jobBlock(wf("suite-09-dapp-quality.yml"), "lint-build");
    expect(b).toContain("name: dapp-lint-build");
    // Job level only (4 spaces): the failure-only Playwright artifact upload step (QA plan v1 U5) legitimately has `if: failure()`.
    expect(b).not.toMatch(/^ {4}if:/m);
    expect(b).not.toMatch(/continue-on-error/);
  });
  test("bun-audit has no skip condition and no continue-on-error", () => {
    const b = jobBlock(wf("suite-18-security-gates.yml"), "bun-audit");
    expect(b).toContain("name: bun-audit");
    expect(b).not.toMatch(/^\s+if:/m);
    expect(b).not.toMatch(/continue-on-error|\|\| true/);
  });
  test("fusion-ceremony-selftest is retired with its script, and the surviving gate keeps it absent", () => {
    // The ceremony shell and its selftest were deleted by S9 (core 1488). deleted-stage-gate guards that.
    expect(existsSync(resolve(repo, "scripts/stage/tests/fusion-ceremony-selftest.sh"))).toBe(false);
    const b = jobBlock(wf("suite-28-core-stack-selftest.yml"), "deleted-stage-gate");
    expect(b).toContain("check-deleted-stage-scripts.ts");
    expect(b).not.toMatch(/continue-on-error/);
  });
});

// QA plan v1 T4: the deploy-gate list is derived from the workflow tree, so a job that runs on every
// push can no longer go red on a deploy sha without check-sha-green seeing it.
describe("the deploy-gate list equals the jobs the workflow tree runs on every push", () => {
  const shipped = () => parseConfig(JSON.parse(readFileSync(resolve(repo, "scripts/ci/required-checks.json"), "utf8")));

  test("required list equals the push-dev unconditional job set", () => {
    const c = shipped();
    const workflows = loadWorkflows(repo);
    const derived = deriveGateJobs(workflows);
    const exceptions = new Set([...c.optional, ...(c.exempt ?? [])].map(label));
    const expected = derived.map((d) => d.label).filter((l) => !exceptions.has(l)).sort();
    expect(c.required.map(label).sort()).toEqual(expected);
    // Every gap by name: a missing job, a stale entry, a wrong source or class, an exception without a reason.
    expect(compareGate(c, derived, workflows)).toEqual([]);
    // The jobs the QA review found outside the list (T10) are gated now.
    const required = new Set(c.required.map(label));
    for (const l of [
      "dapp-e2e",
      "watchdog-unit",
      "smoke-test-guards",
      "rmpc-unit-releases",
      "forge-invariant-fuzz-tests",
      "explorer-indexer-fast",
      "explorer-indexer-devnet",
      "rmpc-e2e-*",
      "core-stages-twin-chain",
    ]) {
      expect(required.has(l)).toBe(true);
    }
  });

  test("every optional and exempt entry says why it does not gate", () => {
    const c = shipped();
    for (const s of [...c.optional, ...(c.exempt ?? [])]) expect((s.reason ?? "").length).toBeGreaterThan(20);
  });

  // Fixture workflows: one push to dev, a job per case.
  const wf = (on: unknown, jobs: Record<string, unknown>) => ({ on, jobs });
  const push = { push: { branches: ["dev"] }, pull_request: null };

  test("a draft or pull_request skip still runs on a push; a schedule-only condition does not", () => {
    const d = deriveGateJobs({
      "a.yml": wf(push, {
        plain: { name: "plain" },
        draft: { name: "draft", if: "${{ github.event_name != 'pull_request' || github.event.pull_request.draft == false }}" },
        notpr: { name: "notpr", if: "github.event_name != 'pull_request'" },
        nightly: { name: "nightly", if: "${{ github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' }}" },
      }),
    });
    expect(d.map((j) => j.label)).toEqual(["draft", "notpr", "plain"]);
  });

  test("a push path filter takes the workflow out; a docs-only paths-ignore does not", () => {
    const d = deriveGateJobs({
      "docs-ignore.yml": wf({ push: { branches: ["dev"], "paths-ignore": ["**.md", "**.txt"] } }, { kept: {} }),
      "paths.yml": wf({ push: { branches: ["dev"], paths: ["contracts/**"] } }, { filtered: {} }),
      "code-ignore.yml": wf({ push: { branches: ["dev"], "paths-ignore": ["clients/**"] } }, { ignored: {} }),
    });
    expect(d.map((j) => j.label)).toEqual(["kept"]);
  });

  test("a releases-* push counts; a tags-only push, another branch and a schedule-only workflow do not", () => {
    const d = deriveGateJobs({
      "rel.yml": wf({ push: { branches: ["releases-*"], tags: ["v*.*.*"] } }, { rel: {} }),
      "tags.yml": wf({ push: { tags: ["v*.*.*"] } }, { tagged: {} }),
      "main.yml": wf({ push: { branches: ["main"] } }, { mainonly: {} }),
      "nightly.yml": wf({ schedule: [{ cron: "0 2 * * *" }], workflow_dispatch: null }, { cron: {} }),
      "both.yml": wf({ push: { branches: ["dev", "releases-*"] } }, { both: {} }),
    });
    expect(d.map((j) => [j.label, j.sources])).toEqual([
      ["both", ["both.yml"]],
      ["rel", ["rel.yml"]],
    ]);
  });

  test("a job that needs a skipped job is skipped; a job behind the deploy-path flag is required-on-deploy-paths", () => {
    const d = deriveGateJobs({
      "a.yml": wf(push, {
        nightly: { if: "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" },
        after: { needs: "nightly" },
        changes: { name: "changes" },
        publish: { name: "publish", needs: ["changes"], if: "${{ needs.changes.outputs.deploy == 'true' }}" },
        report: { name: "report", needs: "publish" },
      }),
    });
    expect(d.map((j) => [j.label, j.deployPaths])).toEqual([
      ["changes", false],
      ["publish", true],
      ["report", true],
    ]);
  });

  test("a matrix job is a prefix: the text before its expression, or `name (` for a plain name", () => {
    const d = deriveGateJobs({
      "a.yml": wf(push, {
        e2e: { name: "rmpc-e2e-${{ matrix.binary }}", strategy: { matrix: { binary: ["smoke", "withdraw"] } } },
        fees: { name: "erc4626-precondition", strategy: { matrix: { exit_fee_bps: [0, 30] } } },
      }),
    });
    expect(d.map((j) => [j.label, j.prefix])).toEqual([
      ["erc4626-precondition (*", "erc4626-precondition ("],
      ["rmpc-e2e-*", "rmpc-e2e-"],
    ]);
  });

  test("the same job name in several workflows is one entry with every source", () => {
    const d = deriveGateJobs({
      "a.yml": wf(push, { pin: { name: "twin-pin" } }),
      "b.yml": wf(push, { pin: { name: "twin-pin" } }),
    });
    expect(d).toHaveLength(1);
    expect(d[0].sources).toEqual(["a.yml", "b.yml"]);
  });

  test("an unknown condition is refused, not guessed", () => {
    expect(() => deriveGateJobs({ "a.yml": wf(push, { odd: { if: "github.ref == 'refs/heads/dev'" } }) })).toThrow(
      /unknown condition/,
    );
  });

  test("compareGate names a missing job, a stale entry, a wrong class, a wrong source and a bare exception", () => {
    const workflows = {
      "a.yml": wf(push, {
        unit: { name: "unit" },
        e2e: { name: "e2e" },
        changes: { name: "changes" },
        publish: { name: "publish", needs: "changes", if: "needs.changes.outputs.deploy == 'true'" },
        flaky: { name: "flaky", "continue-on-error": true },
      }),
    };
    const derived = deriveGateJobs(workflows);
    const problems = compareGate(
      {
        version: 1,
        required: [
          { name: "unit", source: "b.yml" },
          { name: "publish", source: "a.yml" },
          { name: "flaky", source: "a.yml" },
          { name: "gone", source: "a.yml" },
        ],
        optional: [{ name: "changes" }],
        exempt: [],
      },
      derived,
      workflows,
    );
    const text = problems.join("\n");
    expect(text).toContain("e2e runs on every push to dev or releases-*");
    expect(text).toContain("required gone does not run on every push");
    expect(text).toContain("required unit names source b.yml");
    expect(text).toContain("required publish is gated on the suite 14 deploy-path flag");
    expect(text).toContain("required flaky has continue-on-error");
    expect(text).toContain("optional changes has no reason");
    expect(problems).toHaveLength(6);
  });

  test("compareGate names a prefix that swallows another job and an optional entry no workflow has", () => {
    const workflows = {
      "a.yml": wf(push, {
        e2e: { name: "smoke-test-${{ matrix.k }}", strategy: { matrix: { k: ["a"] } } },
        guards: { name: "smoke-test-guards" },
      }),
    };
    const derived = deriveGateJobs(workflows);
    const problems = compareGate(
      {
        version: 1,
        required: [
          { prefix: "smoke-test-", source: "a.yml" },
          { name: "smoke-test-guards", source: "a.yml" },
        ],
        optional: [{ name: "retired-job", reason: "a job that was deleted from the tree long ago" }],
      },
      derived,
      workflows,
    );
    expect(problems).toEqual([
      "optional retired-job is no job in .github/workflows: drop the entry",
      "prefix smoke-test- also matches the job smoke-test-guards",
    ]);
  });
});
