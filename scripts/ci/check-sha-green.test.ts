// Unit tests for scripts/ci/check-sha-green.ts with recorded check-run fixtures. No network.
// Run: bun test scripts/ci/check-sha-green.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CheckRun, evaluate, fetchAllCheckRuns, parseConfig, render } from "./check-sha-green";

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
  test("rejects an unknown class and a deploy-paths entry with no paths", () => {
    expect(() => parseConfig({ version: 1, required: [{ name: "a", class: "x" }], optional: [] })).toThrow();
    expect(() => parseConfig({ version: 1, required: [{ name: "a", class: "required-on-deploy-paths" }], optional: [] })).toThrow();
  });
});

describe("fetchAllCheckRuns pagination", () => {
  test("reads every page by following the Link header", async () => {
    const pages: Record<string, { runs: CheckRun[]; next?: string }> = {
      "https://api.test/repos/o/r/commits/abc1234/check-runs?per_page=100": {
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
    expect(b).not.toMatch(/^\s+if:/m);
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
