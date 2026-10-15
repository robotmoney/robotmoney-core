// devops 58 (S11): the plan job's gate. A planted short delay on 8453 fails before any signer exists, so before any approval.
// QA plan v1 E4 (issue 1816, review T7): the same release gate on every broadcasting 8453 run, and the committed-and-clean proof for a plain baseline too (bottom of the file).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseGated } from "../src/cli.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "../src/chains.ts";
import { spawnTool } from "../src/runner.ts";
import { CORE_REPO, checkShaGreenArgv } from "../src/release-gate.ts";
import { COUNTS, tmp, writeCounts } from "./fixtures.ts";
import { world, type World } from "./harness.ts";

async function plan(w: ReturnType<typeof world>, over: Record<string, unknown> = {}): Promise<{ code: number; signerMade: boolean; forgeCalls: number }> {
  const real = console.log;
  console.log = () => {};
  let signerMade = false;
  try {
    const code = await w.run(["--stage", "plan", "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; throw new Error("the plan job must not build a signer"); }, ...over });
    return { code, signerMade, forgeCalls: w.state().calls.filter((c: { tool: string }) => c.tool === "forge").length };
  } finally { console.log = real; }
}

describe("plan gate", () => {
  test("a planted short delay on 8453 fails in the plan job, with no signer and no forge call", async () => {
    const r = await plan(world({ chainId: 8453, sheet: { TIMELOCK_MIN_DELAY: "60" } }));
    expect(r.code).toBe(EXIT_CODES.FLOOR);
    expect(r.signerMade).toBe(false);
    expect(r.forgeCalls).toBe(0);
  });
  test("a short GOVERN_NEW_DELAY on 8453 fails in the plan job", async () => {
    expect((await plan(world({ chainId: 8453, sheet: { GOVERN_NEW_DELAY: "3600" } }))).code).toBe(EXIT_CODES.FLOOR);
  });
  test("a sheet CHAIN_ID that differs from the RPC fails in the plan job", async () => {
    expect((await plan(world({ chainId: 8453, sheet: { CHAIN_ID: "918453", EXPECTED_CHAIN_ID: "918453" } }))).code).toBe(EXIT_CODES.CHAIN);
  });
  test("a missing frozen counts file for the core SHA fails in the plan job", async () => {
    expect((await plan(world({ chainId: 8453, writeFrozen: false }))).code).toBe(EXIT_CODES.COUNTS_MISSING);
  });
  test("a valid sheet on 8453 passes the plan job", async () => {
    const r = await plan(world({ chainId: 8453 }));
    expect(r.code).toBe(0);
    expect(r.signerMade).toBe(false);
  });
  test("a short delay is accepted on the Twin chain (the floors are keyed to the chain id)", async () => {
    expect((await plan(world({ chainId: 918453, sheet: { TIMELOCK_MIN_DELAY: "60" } }))).code).toBe(0);
  });

  // core 1524: the contracts-freeze gate. Each refusal happens before any signer exists.
  test("8453 refuses a DEPLOY_SHA with no release tag: RELEASE_SHA_UNTAGGED, no signer", async () => {
    const r = await plan(world({ chainId: 8453 }), { releaseTag: async () => null });
    expect(r.code).toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
    expect(r.signerMade).toBe(false);
  });
  test("gate order: with no tag, no counts file and CI red at once, the refusal is RELEASE_SHA_UNTAGGED and neither the counts nor check-sha-green is consulted", async () => {
    let greenRan = false;
    const r = await plan(world({ chainId: 8453, writeFrozen: false }), { releaseTag: async () => null, env: { GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, checkShaGreen: async () => { greenRan = true; return { code: 1, output: "RED" }; } });
    expect(r.code).toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
    expect(r.signerMade).toBe(false);
    expect(greenRan).toBe(false);
  });
  test("gate order: a tagged SHA with no counts file and CI red is COUNTS_MISSING, before check-sha-green runs", async () => {
    let greenRan = false;
    const r = await plan(world({ chainId: 8453, writeFrozen: false }), { checkShaGreen: async () => { greenRan = true; return { code: 1, output: "RED" }; } });
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(greenRan).toBe(false);
  });
  test("8453 refuses when the release tag does not match the remote: RELEASE_TAG_REMOTE_MISMATCH, no signer, before counts and check-sha-green", async () => {
    let greenRan = false;
    const r = await plan(world({ chainId: MAINNET_CHAIN_ID, writeFrozen: false }), { remoteTag: async () => { throw new PublishError("RELEASE_TAG_REMOTE_MISMATCH", "moved"); }, checkShaGreen: async () => { greenRan = true; return { code: 0, output: "GREEN" }; } });
    expect(r.code).toBe(EXIT_CODES.RELEASE_TAG_REMOTE_MISMATCH);
    expect(r.signerMade).toBe(false);
    expect(greenRan).toBe(false);
  });
  test("the Twin chain never checks the remote tag", async () => {
    let remoteRan = false;
    await plan(world({ chainId: TWIN_CHAIN_ID }), { remoteTag: async () => { remoteRan = true; throw new PublishError("RELEASE_TAG_REMOTE_MISMATCH", "x"); } });
    expect(remoteRan).toBe(false);
  });
  test("8453 refuses a tagged SHA with no frozen counts file: COUNTS_MISSING, no signer", async () => {
    const r = await plan(world({ chainId: 8453, writeFrozen: false }));
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(r.signerMade).toBe(false);
  });
  test("8453 refuses when check-sha-green exits non-zero: CI_NOT_GREEN, and the failing check names are in the error output", async () => {
    const w = world({ chainId: 8453 });
    const errs: string[] = [];
    const realErr = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
    let r: Awaited<ReturnType<typeof plan>>;
    try {
      r = await plan(w, { checkShaGreen: async () => ({ code: 1, output: "check-sha-green: NOT GREEN\nFAIL  forge-test (failure)\nFAIL  bun-tests (missing)" }) });
    } finally { console.error = realErr; }
    expect(r.code).toBe(EXIT_CODES.CI_NOT_GREEN);
    expect(r.signerMade).toBe(false);
    const out = errs.join("\n") + w.lines.join("\n");
    expect(out).toContain("forge-test");
    expect(out).toContain("bun-tests");
  });
  test("8453 passes when the tag, the counts file and a green check-sha-green all hold, and check-sha-green gets the DEPLOY_SHA and the token", async () => {
    let got: { sha: string; token?: string } | undefined;
    const r = await plan(world({ chainId: 8453 }), { checkShaGreen: async (i: { sha: string; env: Record<string, string> }) => { got = { sha: i.sha, token: i.env.GITHUB_TOKEN }; return { code: 0, output: "GREEN" }; } });
    expect(r.code).toBe(0);
    expect(r.signerMade).toBe(false);
    expect(got?.sha).toBe("a".repeat(40));
    expect(got?.token).toBe("test-token");
  });
  // Security round 1: inside a caller repo's workflow (the devops repo's) GITHUB_REPOSITORY names that caller. check-sha-green must still ask about the core repository.
  test("check-sha-green is asked about robotmoney/robotmoney-core, never the caller's GITHUB_REPOSITORY", async () => {
    let got: { repo: string; env: Record<string, string> } | undefined;
    const r = await plan(world({ chainId: 8453 }), {
      env: { GITHUB_REPOSITORY: "robotmoney/release-caller" },
      checkShaGreen: async (i: { repo: string; env: Record<string, string> }) => { got = { repo: i.repo, env: i.env }; return { code: 0, output: "GREEN" }; },
    });
    expect(r.code).toBe(0);
    expect(got?.repo).toBe(CORE_REPO);
    expect(CORE_REPO).toBe("robotmoney/robotmoney-core");
    expect(got?.env.GITHUB_REPOSITORY).toBeUndefined();
    // the spawned argv names the repository explicitly, so check-sha-green's own GITHUB_REPOSITORY fallback is never reached
    const argv = checkShaGreenArgv("a".repeat(40), got!.repo);
    expect(argv.slice(-2)).toEqual(["--repo", "robotmoney/robotmoney-core"]);
    expect(argv).toContain("a".repeat(40));
  });
  test("8453 with no GITHUB_TOKEN is a refusal, not a skipped CI-green check", async () => {
    let ran = false;
    const r = await plan(world({ chainId: 8453 }), { env: { GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, checkShaGreen: async () => { ran = true; return { code: 0, output: "GREEN" }; } });
    expect(r.code).toBe(EXIT_CODES.CI_NOT_GREEN);
    expect(r.signerMade).toBe(false);
    expect(ran).toBe(false);
  });
  test("the Twin chain 918453 plans at an untagged SHA with no counts file and no token (rehearsals are not blocked)", async () => {
    let tagRead = false;
    let greenRan = false;
    const r = await plan(world({ chainId: 918453, writeFrozen: false }), { env: { GITHUB_TOKEN: undefined }, releaseTag: async () => { tagRead = true; return null; }, checkShaGreen: async () => { greenRan = true; return { code: 1, output: "" }; } });
    expect(r.code).not.toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
    expect(r.code).not.toBe(EXIT_CODES.CI_NOT_GREEN);
    expect(tagRead).toBe(false);
    expect(greenRan).toBe(false);
  });
});

// QA plan v1 E4 (issue 1816, review T7): the gate ran on `--stage plan` only, so a publish, prove-control or govern on 8453 at an untagged sha reached forge whenever the
// plan job was skipped. Now every run that can broadcast passes the same gate before any signer exists and before forge runs (cli.ts releaseGated).
const OWNERS = Array.from({ length: 3 }, (_, i) => ["--owner-signer", `keystore:/k/OWNER_${i}`]).flat();
/** Every way to name a broadcasting 8453 run: the verbs, the default stage set, deploy, all, one deployer stage, safe, prove-control, govern in a list, govern rows. */
const BROADCASTING: string[][] = [
  ["publish", ...OWNERS], [...OWNERS], ["--stage", "deploy", ...OWNERS], ["--stage", "all", ...OWNERS], ["--stage", "libs"], ["--stage", "safe"], ["--stage", "prove-control", ...OWNERS],
  ["--stage", "verify,govern"], ["govern"], ["govern", "--row", "unpause-USDC"], ["govern", "--row", "release-receipt", "--receipt-id", `0x${"ab".repeat(32)}`],
];
const forgeCalls = (w: World): number => w.state().calls.filter((c: { tool: string }) => c.tool === "forge").length;
const lastFailure = (w: World): string => String(w.logs().filter((l) => l.event === "run.failed").pop()?.message ?? "");

async function broadcast(w: World, args: string[], over: Record<string, unknown> = {}): Promise<{ code: number; signerMade: boolean; ownerSignerMade: boolean }> {
  const real = console.log;
  console.log = () => {};
  let signerMade = false, ownerSignerMade = false;
  try {
    const code = await w.run([...args, "--environment", "base-mainnet"], {
      makeSigner: () => { signerMade = true; throw new Error("no signer may exist before the release gate"); },
      ownerSigner: async () => { ownerSignerMade = true; throw new Error("no owner signer may exist before the release gate"); }, ...over,
    });
    return { code, signerMade, ownerSignerMade };
  } finally { console.log = real; }
}

describe("the release gate on every broadcasting 8453 run (QA plan v1 E4, issue 1816)", () => {
  test("8453 refuses a broadcasting stage at an untagged SHA before forge: RELEASE_SHA_UNTAGGED, no signer, no owner signer, no Safe call", async () => {
    for (const args of BROADCASTING) {
      const w = world({ chainId: MAINNET_CHAIN_ID });
      let greenRan = false;
      const r = await broadcast(w, args, { releaseTag: async () => null, checkShaGreen: async () => { greenRan = true; return { code: 0, output: "GREEN" }; } });
      const what = args.filter((a) => !a.startsWith("keystore:") && a !== "--owner-signer").join(" ") || "(default stages)";
      expect(r.code, what).toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
      expect(r.signerMade, what).toBe(false);
      expect(r.ownerSignerMade, what).toBe(false);
      expect(forgeCalls(w), what).toBe(0);
      expect(w.safeCalls, what).toEqual([]);
      expect(greenRan, what).toBe(false); // the tag is the first step: nothing after it ran
      expect(lastFailure(w), what).toContain("is not a release SHA");
    }
  });
  test("mutation: the same runs at a tagged SHA pass the gate (run.release_gate logged) and only then build a signer", async () => {
    for (const args of BROADCASTING) {
      const w = world({ chainId: MAINNET_CHAIN_ID });
      let greenSha: string | undefined;
      const r = await broadcast(w, args, { checkShaGreen: async (i: { sha: string }) => { greenSha = i.sha; return { code: 0, output: "GREEN" }; } });
      const what = args.filter((a) => !a.startsWith("keystore:") && a !== "--owner-signer").join(" ") || "(default stages)";
      expect(r.code, what).not.toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
      expect(w.logs().some((l) => l.event === "run.release_gate" && l.ok === true && l.tag === "release/1.0.0"), what).toBe(true);
      expect(greenSha, what).toBe("a".repeat(40));
      expect(r.signerMade, what).toBe(true); // the refusal above came from the gate, not from a step the run never reaches
    }
  });
  test("each later gate step refuses a broadcasting run too: remote tag, tag kind, counts, CI (the order of the plan gate)", async () => {
    const run = async (over: Record<string, unknown>, o: { writeFrozen?: boolean; sheet?: Record<string, string> } = {}) => {
      const w = world({ chainId: MAINNET_CHAIN_ID, ...o });
      const r = await broadcast(w, ["publish", ...OWNERS], over);
      expect(r.signerMade).toBe(false);
      expect(forgeCalls(w)).toBe(0);
      return r.code;
    };
    expect(await run({ remoteTag: async () => { throw new PublishError("RELEASE_TAG_REMOTE_MISMATCH", "moved"); } })).toBe(EXIT_CODES.RELEASE_TAG_REMOTE_MISMATCH);
    expect(await run({ releaseTag: async () => "release/1.0.0-rehearsal" })).toBe(EXIT_CODES.RELEASE_TAG_KIND);
    expect(await run({}, { writeFrozen: false })).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(await run({ frozenDirCommitted: async () => { throw new PublishError("COUNTS_MISSING", "the counts dir is not clean"); } })).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(await run({ checkShaGreen: async () => ({ code: 1, output: "FAIL  forge-test (failure)" }) })).toBe(EXIT_CODES.CI_NOT_GREEN);
    expect(await run({ env: { GITHUB_TOKEN: undefined, GH_TOKEN: undefined } })).toBe(EXIT_CODES.CI_NOT_GREEN);
  });
  test("exempt: verify alone, pause-all, a dry run, and the Twin chain never read the tag", async () => {
    const cases: [number, string[]][] = [[MAINNET_CHAIN_ID, ["verify"]], [MAINNET_CHAIN_ID, ["--stage", "verify"]], [MAINNET_CHAIN_ID, ["pause-all"]], [MAINNET_CHAIN_ID, ["--stage", "libs", "--dry-run"]], [TWIN_CHAIN_ID, ["--stage", "libs"]], [TWIN_CHAIN_ID, ["govern"]]];
    for (const [chainId, args] of cases) {
      const w = world({ chainId });
      let tagRead = false;
      const r = await broadcast(w, args, { releaseTag: async () => { tagRead = true; return null; } }); // they stop later (no run manifest, the throwing signer): never at the tag
      expect(tagRead, `${chainId} ${args.join(" ")}`).toBe(false);
      expect(r.code, `${chainId} ${args.join(" ")}`).not.toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
    }
  });
  test("releaseGated: the plan and every run that can broadcast on 8453; not verify alone, pause-all, record-receipt, a dry run of the stages, --measure or the Twin chain", () => {
    const g = (o: Partial<Parameters<typeof releaseGated>[0]>) => releaseGated({ chainId: MAINNET_CHAIN_ID, dryRun: false, measure: false, ...o });
    for (const verb of ["publish", "govern", "redeploy-vault"] as const) expect(g({ verb }), verb).toBe(true);
    for (const stage of [undefined, "plan", "deploy", "all", "libs", "safe", "prove-control", "timelock", "govern", "verify,govern"]) expect(g({ stage }), String(stage)).toBe(true);
    for (const verb of ["verify", "pause-all", "record-receipt"] as const) expect(g({ verb }), verb).toBe(false);
    expect(g({ stage: "verify" })).toBe(false);
    expect(g({ verb: "publish", dryRun: true })).toBe(false);
    expect(g({ stage: "libs", dryRun: true })).toBe(false);
    expect(g({ stage: "plan", dryRun: true })).toBe(true); // the plan was gated with or without --dry-run before E4 too
    expect(g({ verb: "redeploy-vault", dryRun: true })).toBe(true); // so was the redeploy-vault verb (issue 1796)
    expect(g({ verb: "publish", measure: true })).toBe(false);
    for (const verb of ["publish", "govern", "redeploy-vault"] as const) expect(g({ verb, chainId: TWIN_CHAIN_ID }), verb).toBe(false);
    expect(g({ stage: "plan", chainId: TWIN_CHAIN_ID })).toBe(false);
  });
});

// QA plan v1 E4 (release-gate.ts): before, only a RECONSTRUCTED baseline was proven committed and clean in its counts checkout (issue 1740). A plain measured <sha>.json
// passed on its shape alone: hand-edited, never committed or beside untracked files. Real git repositories here, the release layout of the runbook: the code from a clean
// checkout at the release sha X, the counts from a clone at Y, a descendant of X whose data-only commit adds X.json.
const FROZEN = join("deployments", "frozen-counts");
const cleanEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...cleanEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
/** The CLI's one git spawn (the dirty-tree check of the core checkout) runs the real git; forge and cast stay the stubs. */
const realGit = (tool: string, args: string[], opts: { env?: Record<string, string> }) => spawnTool(tool as never, args, tool === "git" ? { ...opts, env: cleanEnv } : (opts as never));

interface PlainLayout { w: World; x: string; counts: string; file: string }
function plainLayout(commit = true): PlainLayout {
  const w = world({ chainId: MAINNET_CHAIN_ID, writeFrozen: false });
  rmSync(join(w.coreDir, ".git"), { recursive: true, force: true });
  git(w.coreDir, "init", "-q"); git(w.coreDir, "config", "commit.gpgsign", "false");
  writeCounts(join(w.coreDir, FROZEN), "9".repeat(40), COUNTS); // an earlier release's plain file, committed at X like the repo's own
  git(w.coreDir, "add", "-A"); git(w.coreDir, "commit", "-q", "-m", "release sha X");
  const x = git(w.coreDir, "rev-parse", "HEAD");
  const dev = join(tmp("pc-e4-dev-"), "dev");
  execFileSync("git", ["clone", "-q", w.coreDir, dev], { stdio: "pipe", env: cleanEnv });
  git(dev, "config", "commit.gpgsign", "false");
  const file = writeCounts(join(dev, FROZEN), x, COUNTS); // a plain measured file: no reconstructed block, no anchor
  if (commit) { git(dev, "add", `${FROZEN}/${x}.json`); git(dev, "commit", "-q", "-m", "data-only: frozen counts of X"); }
  return { w, x, counts: join(dev, FROZEN), file };
}
/** One gated run against the layout with the CLI's REAL committed-dir proof (the harness default passes it). */
const gatedRun = (l: PlainLayout, args: string[], over: Record<string, unknown> = {}) =>
  broadcast(l.w, [...args, "--core-sha", l.x, "--counts-dir", l.counts], { run: realGit as never, frozenDirCommitted: undefined, ...over });
const GATED: string[][] = [["--stage", "plan"], ["publish", ...OWNERS], ["--stage", "libs"], ["govern"]];

describe("the frozen counts file is committed and clean for a plain baseline too (QA plan v1 E4)", () => {
  test("hand-edited frozen counts refused: a committed plain X.json changed in the working tree stops the plan and every broadcasting run with COUNTS_MISSING, before any signer or forge", async () => {
    const l = plainLayout();
    const j = JSON.parse(readFileSync(l.file, "utf8"));
    j.counts.vault += 1; // still a well-formed counts file: only the committed-bytes proof can see the edit
    writeFileSync(l.file, JSON.stringify(j, null, 2));
    for (const args of GATED) {
      const r = await gatedRun(l, args);
      const what = args[0] === "--stage" ? args.join(" ") : args[0]!;
      expect(r.code, what).toBe(EXIT_CODES.COUNTS_MISSING);
      expect(lastFailure(l.w), what).toContain("differs from the committed bytes");
      expect(r.signerMade, what).toBe(false);
      expect(forgeCalls(l.w), what).toBe(0);
    }
  });
  test("an uncommitted plain X.json in the counts checkout is refused the same way", async () => {
    const l = plainLayout(false);
    for (const args of GATED) {
      const r = await gatedRun(l, args);
      expect(r.code, args.join(" ")).toBe(EXIT_CODES.COUNTS_MISSING);
      expect(lastFailure(l.w), args.join(" ")).toContain("is not tracked at HEAD");
      expect(r.signerMade, args.join(" ")).toBe(false);
    }
  });
  test("an untracked stray file beside a committed plain X.json is refused (the dir must be clean)", async () => {
    const l = plainLayout();
    writeFileSync(join(l.counts, "notes.txt"), "x");
    const r = await gatedRun(l, ["publish", ...OWNERS]);
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(lastFailure(l.w)).toContain("is not clean");
  });
  test("mutation: the committed, clean plain X.json passes: the plan exits 0 and a broadcasting run passes the gate before it builds a signer", async () => {
    const l = plainLayout();
    expect((await gatedRun(l, ["--stage", "plan"])).code).toBe(0);
    expect(l.w.logs().some((e) => e.event === "plan.release_gate" && e.ok === true)).toBe(true);
    const r = await gatedRun(l, ["--stage", "libs"]);
    expect(r.code).not.toBe(EXIT_CODES.COUNTS_MISSING);
    expect(l.w.logs().some((e) => e.event === "run.release_gate" && e.ok === true && e.counts === "committed")).toBe(true);
    expect(r.signerMade).toBe(true);
  });
  test("the release gate given no committed-dir proof refuses a plain baseline (the seam is required, never skipped)", async () => {
    const { assertReleaseGate } = await import("../src/release-gate.ts");
    const dir = tmp("pc-e4-plain-");
    writeCounts(dir, "a".repeat(40), COUNTS);
    const gate = (frozenDirCommitted?: (d: string) => Promise<void>) => assertReleaseGate({ sha: "a".repeat(40), coreDir: "/x", countsDir: dir, env: { GITHUB_TOKEN: "t" }, kind: "production", releaseTag: async () => "release/1.0.0", remoteTag: async () => {}, checkShaGreen: async () => ({ code: 0, output: "" }), frozenDirCommitted });
    await expect(gate()).rejects.toMatchObject({ kind: "COUNTS_MISSING", message: expect.stringContaining("committed, clean one") });
    const seen: string[] = [];
    expect(await gate(async (d) => { seen.push(d); })).toBe("release/1.0.0");
    expect(seen).toEqual([dir]);
  });
});
