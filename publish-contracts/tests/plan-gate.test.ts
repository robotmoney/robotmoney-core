// devops 58 (S11): the plan job's gate. A planted short delay on 8453 fails before any signer exists, so before any approval.
// Issue 1816 (QA plan v1 E4 matrix): the same release gate on every broadcasting 8453 run; a plain counts file must be committed and clean (COUNTS_UNTRACKED).
import { describe, expect, test } from "bun:test";
import { releaseGated } from "../src/cli.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "../src/chains.ts";
import { CORE_REPO, checkShaGreenArgv, assertCountsTracked } from "../src/release-gate.ts";
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

// QA plan v1 E4 (issue 1816, review T7): the matrix of broadcasting runs below (dev's block after it covers the dirt kinds). The gate ran on `--stage plan` only, so a publish, prove-control or govern on 8453 at an untagged sha reached forge whenever the
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
      expect(w.logs().some((l) => l.event === "plan.release_gate" && l.ok === true && l.tag === "release/1.0.0"), what).toBe(true);
      expect(greenSha, what).toBe("a".repeat(40));
      expect(r.signerMade, what).toBe(true); // the refusal above came from the gate, not from a step the run never reaches
    }
  });
  test("each later gate step refuses a broadcasting run too: remote tag, tag kind, counts, CI (the order of the plan gate)", async () => {
    const run = async (over: Record<string, unknown>, o: { writeFrozen?: boolean; sheet?: Record<string, string>; gitCountsDirty?: string[] } = {}) => {
      const { gitCountsDirty, ...worldOpts } = o;
      const w = world({ chainId: MAINNET_CHAIN_ID, ...worldOpts });
      if (gitCountsDirty) w.cfg.gitCountsDirty = gitCountsDirty;
      const r = await broadcast(w, ["publish", ...OWNERS], over);
      expect(r.signerMade).toBe(false);
      expect(forgeCalls(w)).toBe(0);
      return r.code;
    };
    expect(await run({ remoteTag: async () => { throw new PublishError("RELEASE_TAG_REMOTE_MISMATCH", "moved"); } })).toBe(EXIT_CODES.RELEASE_TAG_REMOTE_MISMATCH);
    expect(await run({ releaseTag: async () => "release/1.0.0-rehearsal" })).toBe(EXIT_CODES.RELEASE_TAG_KIND);
    expect(await run({}, { writeFrozen: false })).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(await run({}, { gitCountsDirty: ["?? x.json"] })).toBe(EXIT_CODES.COUNTS_UNTRACKED);
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


// Issue 1816: every non-dry run that broadcasts on 8453 passes the release gate before any signer exists, not only --stage plan. pause-all and a verify-only run are never gated.
describe("release gate on every broadcasting run on 8453", () => {
  const quiet = async (f: () => Promise<number>): Promise<number> => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
  const noSigner = () => { throw new Error("the gate must refuse before a signer is built"); };
  const runs: Array<[string, string[]]> = [["publish", ["publish", ...OWNERS]], ["govern", ["govern"]], ["stage prove-control", ["--stage", "prove-control", ...OWNERS]], ["stage deploy", ["--stage", "deploy", ...OWNERS]], ["stage all", ["--stage", "all", ...OWNERS]], ["default run", [...OWNERS]]];

  for (const [name, args] of runs) {
    test(`${name}: an untagged SHA is RELEASE_SHA_UNTAGGED, with no signer`, async () => {
      let signerMade = false;
      const w = world({ chainId: MAINNET_CHAIN_ID });
      expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { releaseTag: async () => null, makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
      expect(signerMade).toBe(false);
    });
    test(`${name}: red CI is CI_NOT_GREEN, with no signer`, async () => {
      let signerMade = false;
      const w = world({ chainId: MAINNET_CHAIN_ID });
      expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { checkShaGreen: async () => ({ code: 1, output: "RED" }), makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.CI_NOT_GREEN);
      expect(signerMade).toBe(false);
    });
    test(`${name}: a missing counts file is COUNTS_MISSING, with no signer`, async () => {
      let signerMade = false;
      const w = world({ chainId: MAINNET_CHAIN_ID, writeFrozen: false });
      expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.COUNTS_MISSING);
      expect(signerMade).toBe(false);
    });
    test(`${name}: an untracked counts file is COUNTS_UNTRACKED, with no signer`, async () => {
      let signerMade = false;
      const w = world({ chainId: MAINNET_CHAIN_ID });
      w.cfg.gitCountsDirty = ["?? x.json"];
      expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.COUNTS_UNTRACKED);
      expect(signerMade).toBe(false);
    });
  }

  test("pause-all on 8453 with an untagged SHA and red CI: neither check is read", async () => {
    let tagRead = false, greenRan = false;
    const w = world({ chainId: MAINNET_CHAIN_ID });
    const code = await quiet(() => w.run(["pause-all", "--environment", "base-mainnet"], { releaseTag: async () => { tagRead = true; return null; }, checkShaGreen: async () => { greenRan = true; return { code: 1, output: "RED" }; } }));
    expect(code).toBe(EXIT_CODES.RESUME); // it got as far as reading the run manifest, which this world has none of
    expect(tagRead).toBe(false);
    expect(greenRan).toBe(false);
  });

  test("a verify-only run on 8453 broadcasts nothing, so it is not gated", async () => {
    let tagRead = false;
    const w = world({ chainId: MAINNET_CHAIN_ID });
    const code = await quiet(() => w.run(["verify", "--environment", "base-mainnet"], { releaseTag: async () => { tagRead = true; return null; } }));
    expect(code).not.toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
    expect(tagRead).toBe(false);
  });

  test("a dry run on 8453 broadcasts nothing, so it is not gated", async () => {
    let tagRead = false;
    const w = world({ chainId: MAINNET_CHAIN_ID });
    const code = await quiet(() => w.run(["publish", "--dry-run", "--environment", "base-mainnet"], { releaseTag: async () => { tagRead = true; return null; } }));
    expect(code).not.toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
    expect(tagRead).toBe(false);
  });

  test("publish on the Twin chain at an untagged SHA is not gated", async () => {
    let tagRead = false;
    const w = world({ chainId: TWIN_CHAIN_ID });
    await quiet(() => w.run(["publish"], { releaseTag: async () => { tagRead = true; return null; } }));
    expect(tagRead).toBe(false);
  });

  test("publish on 8453 passes the gate and logs it with its stage", async () => {
    const w = world({ chainId: MAINNET_CHAIN_ID });
    await quiet(() => w.run(["publish", ...OWNERS, "--environment", "base-mainnet"]));
    const gate = w.logs().find((l: { event?: string }) => l.event === "plan.release_gate");
    expect(gate?.ok).toBe(true);
    expect(gate?.stage).toBe("publish");
  });

  describe("the frozen counts file must be committed and clean in its git work tree", () => {
    const dirt: Array<[string, string[]]> = [["untracked", ["?? x.json"]], ["modified", [" M x.json"]], ["staged new", ["A  x.json"]], ["ignored", ["!! x.json"]]];
    for (const [kind, lines] of dirt) {
      test(`${kind}: refused on 8453 with COUNTS_UNTRACKED, for the plan and for publish, before a signer`, async () => {
        for (const args of [["--stage", "plan"], ["publish", ...OWNERS]]) {
          let signerMade = false;
          const w = world({ chainId: MAINNET_CHAIN_ID });
          w.cfg.gitCountsDirty = lines;
          expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.COUNTS_UNTRACKED);
          expect(signerMade).toBe(false);
        }
      });
    }
    test("the check asks git for the one counts file, with --ignored", async () => {
      const w = world({ chainId: MAINNET_CHAIN_ID });
      expect(await quiet(() => w.run(["--stage", "plan", "--environment", "base-mainnet"]))).toBe(0);
      const call = w.state().calls.find((c: { tool: string; args: string[] }) => c.tool === "git" && c.args.includes("--"));
      expect(call?.args).toEqual(["-C", w.countsDir, "status", "--porcelain", "--untracked-files=all", "--ignored", "--", `${w.countsDir}/${"a".repeat(40)}.json`]);
    });
    test("a git failure on the counts file is refused, never read as clean", async () => {
      const failing = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
      await expect(assertCountsTracked(failing, "/x", "a".repeat(40))).rejects.toMatchObject({ kind: "COUNTS_UNTRACKED" });
      await expect(assertCountsTracked(async () => ({ code: 0, stdout: "", stderr: "" }), "/x", "a".repeat(40))).resolves.toBeUndefined();
    });
    test("against a real git work tree: untracked is refused, committed is accepted, then modified is refused", async () => {
      const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { spawnSync } = await import("node:child_process");
      const { spawnTool } = await import("../src/runner.ts");
      const { gitEnv } = await import("../src/git-env.ts");
      const repo = mkdtempSync(join(tmpdir(), "counts-tracked-"));
      const dir = join(repo, "deployments", "frozen-counts");
      mkdirSync(dir, { recursive: true });
      const git = (...a: string[]) => { const r = spawnSync("git", ["-C", repo, ...a], { env: gitEnv() }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`); };
      git("init", "-q");
      const sha = "b".repeat(40);
      writeFileSync(join(dir, `${sha}.json`), "{}\n");
      const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
      await expect(assertCountsTracked(spawnTool, dir, sha, env)).rejects.toMatchObject({ kind: "COUNTS_UNTRACKED" });
      git("add", "--", join(dir, `${sha}.json`));
      await expect(assertCountsTracked(spawnTool, dir, sha, env)).rejects.toMatchObject({ kind: "COUNTS_UNTRACKED" }); // staged, not committed
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "counts");
      await expect(assertCountsTracked(spawnTool, dir, sha, env)).resolves.toBeUndefined();
      writeFileSync(join(dir, `${sha}.json`), "{\"x\":1}\n");
      await expect(assertCountsTracked(spawnTool, dir, sha, env)).rejects.toMatchObject({ kind: "COUNTS_UNTRACKED" });
    });
    test("the same dirty file is accepted on the Twin chain", async () => {
      const w = world({ chainId: TWIN_CHAIN_ID });
      w.cfg.gitCountsDirty = ["?? x.json"];
      expect(await quiet(() => w.run(["--stage", "plan"]))).toBe(0);
    });
    test("COUNTS_UNTRACKED has its own exit code", () => {
      expect(EXIT_CODES.COUNTS_UNTRACKED).toBe(31);
    });
  });
});
