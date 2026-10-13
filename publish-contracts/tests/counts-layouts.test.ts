// Issue 1740: the release layouts of a RECONSTRUCTED baseline on 8453, walked through the real CLI pre-signer flow (`main`, stage plan and a deploy stage) with REAL git repositories.
//
// A reconstructed baseline is named by the DEPLOY sha X (deployments/frozen-counts/X.json). It can never be inside the checkout at X: the file holds X, and X is the hash of a tree that
// would hold the file (L3). The release flow therefore tags X, merges the file as a data-only commit AFTER the tag, and the operator runs the code from a clean checkout at X while the
// counts come from a clean checkout of a descendant commit Y (L2). Layout L1 (the file untracked inside the checkout at X) is a dirty tree and is refused.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, type Address, type Hex } from "viem";
import { sumCounts } from "../src/counts.ts";
import type { CountsJsonLike } from "../src/counts-reconstruct.ts";
import { verifyReconstructionOnChain } from "../src/counts-reconstruct.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { buildCreate2Libraries, predictedLibraryAddress } from "../src/libs-adopt.ts";
import { gitAnchorCommitted, gitFrozenDirCommitted } from "../src/release-gate.ts";
import { dirtyTreeLines } from "../src/isomorphism.ts";
import { fileHashOf } from "../src/counts.ts";
import { STUB_DIR } from "./harness.ts";
import { spawnTool } from "../src/runner.ts";
import { getStageTable } from "../src/stages.ts";
import { freezeFromAdoptedRun } from "../scripts/freeze-counts.ts";
import { REPO, tmp } from "./fixtures.ts";
import { world, type World } from "./harness.ts";

const PREV = "9a768bb9cc66d4485470a99a068ba7477604501a";
const REF_PATH = join(REPO, "deployments", "frozen-counts", `${PREV}.json`);
const REF = JSON.parse(readFileSync(REF_PATH, "utf8")).counts as Record<string, number>;
const OUT = join(import.meta.dir, "fixtures", "build-out");
const table = getStageTable();
const tickArt = JSON.parse(readFileSync(join(OUT, "TickMath.sol", "TickMath.json"), "utf8"));
const TICK = predictedLibraryAddress(tickArt.bytecode.object);
const TICK_RUNTIME = `0x73${TICK.slice(2).toLowerCase()}${tickArt.deployedBytecode.object.slice(44)}` as Hex;
const THREE = [...buildCreate2Libraries(table.create2Libraries!, OUT).values()];
const getCode = async (a: Address): Promise<string> => ({ [TICK.toLowerCase()]: TICK_RUNTIME, ...Object.fromEntries(THREE.map((b) => [b.address.toLowerCase(), b.runtime])) } as Record<string, string>)[a.toLowerCase()] ?? "0x";
const adoptedRun = (sha: string): CountsJsonLike => {
  const counts = { ...REF, libs: 0, proto: REF.proto! - 3 };
  return {
    deploySha: sha, chainId: 918453, counts, deployerNonce: sumCounts(counts) + 1, pinBlock: 52_500_000, rehearsal: { conclusion: "success" },
    adopted: {
      libs: { deployerTxs: 0, factory: "0x4e59b44847b379578588920cA78FbF26c0B4956C", libraries: [{ name: "tick_math", artifact: "TickMath", address: TICK, codeHash: keccak256(TICK_RUNTIME) }] },
      proto: { deployerTxs: REF.proto! - 3, libraries: THREE.map((b) => ({ name: b.name, artifact: b.artifact, address: b.address, codeHash: b.runtimeHash })) },
    } as never,
  };
};

const FROZEN = join("deployments", "frozen-counts");
const cleanEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
/** git for the setup and for the CLI's one allowed spawn (the stubs dir is not on this PATH, so the real git status runs). */
const git = (dir: string, ...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe", env: { ...cleanEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
const realGit = (tool: string, args: string[], opts: { env?: Record<string, string> }) => spawnTool(tool as never, args, tool === "git" ? { ...opts, env: cleanEnv } : (opts as never));

interface Layout { w: World; x: string; core: string }
/** A world whose core checkout is a REAL git repository: the anchor of the first release is committed, and HEAD is the release sha X. */
function coreAtX(): Layout {
  const w = world({ chainId: 8453, writeFrozen: false });
  const core = w.coreDir;
  rmSync(join(core, ".git"), { recursive: true, force: true });
  git(core, "init", "-q"); git(core, "config", "commit.gpgsign", "false");
  mkdirSync(join(core, FROZEN), { recursive: true });
  copyFileSync(REF_PATH, join(core, FROZEN, `${PREV}.json`));
  git(core, "add", "-A"); git(core, "commit", "-q", "-m", "release sha X");
  return { w, x: git(core, "rev-parse", "HEAD"), core };
}
/** The freeze-counts verb, as the operator runs it, writing X.json into `countsDir`. */
async function freeze(x: string, countsDir: string): Promise<void> {
  const dir = tmp("pc-cj-");
  const cj = join(dir, "counts.json");
  writeFileSync(cj, JSON.stringify(adoptedRun(x)));
  await freezeFromAdoptedRun({ countsJsonPath: cj, sha: x, countsDir, table, getCode, build: () => ({ linkOut: OUT, c2Out: OUT, linked: [], create2: [] }) as never, at: "2026-10-10T00:00:00Z" });
}
/** A clone of the core repo with the data-only commit Y (X.json) on top: the dev checkout the counts come from. */
async function devAtY(l: Layout, commit = true): Promise<string> {
  const dev = join(tmp("pc-dev-"), "dev");
  execFileSync("git", ["clone", "-q", l.core, dev], { stdio: "pipe", env: cleanEnv });
  git(dev, "config", "commit.gpgsign", "false");
  await freeze(l.x, join(dev, FROZEN));
  if (commit) { git(dev, "add", `${FROZEN}/${l.x}.json`); git(dev, "commit", "-q", "-m", "data-only: frozen counts of X"); }
  return dev;
}

/** The pre-signer flow of the 8453 plan or a deploy stage: real `main`, real git status and real git proofs; the chain re-verification is the real one against the fixture build. */
async function runIt(l: Layout, countsDir: string, stage: "plan" | "libs" = "plan", more: string[] = []): Promise<{ code: number; err: string; signerMade: boolean }> {
  let signerMade = false;
  const real = console.log; console.log = () => {};
  try {
    const code = await l.w.run(["--stage", stage, "--environment", "base-mainnet", "--core-sha", l.x, "--counts-dir", countsDir, ...more], {
      run: realGit as never, makeSigner: () => { signerMade = true; throw new Error("no signer"); },
      verifyReconstructed: async (f: any) => { await verifyReconstructionOnChain(f.measured.reconstructed, { table, out: { linkOut: OUT, c2Out: OUT } as never, getCode }); },
    });
    const errLine = l.w.logs().reverse().find((e) => e.level === "error");
    return { code, err: String(errLine?.message ?? errLine?.error ?? JSON.stringify(errLine ?? "")), signerMade };
  } finally { console.log = real; }
}
const msg = async (f: () => unknown): Promise<string> => { try { await f(); } catch (e) { return (e as Error).message; } return ""; };

describe("L1: the counts dir inside the checkout at X, X.json untracked", () => {
  test("the tree is dirty: the plan and a deploy stage are refused before any signer (USAGE)", async () => {
    for (const stage of ["plan", "libs"] as const) {
      const l = coreAtX();
      await freeze(l.x, join(l.core, FROZEN));
      const r = await runIt(l, join(l.core, FROZEN), stage);
      expect(r.code).toBe(EXIT_CODES.USAGE);
      expect(r.err).toContain("uncommitted changes");
      expect(r.err).toContain(`?? deployments/frozen-counts/${l.x}.json`);
      expect(r.signerMade).toBe(false);
    }
  });
});

describe("L2: the code from a clean checkout at X, the counts from a clean dev checkout at Y (a descendant that tracks X.json)", () => {
  test("the plan and a deploy stage pass the pre-signer flow", async () => {
    for (const stage of ["plan", "libs"] as const) {
      const l = coreAtX();
      const dev = await devAtY(l);
      const r = await runIt(l, join(dev, FROZEN), stage);
      expect(r.err).not.toContain("COUNTS");
      if (stage === "plan") expect(r.code).toBe(0);
      else expect(r.code).not.toBe(EXIT_CODES.COUNTS_MISSING); // the stub forge may stop a deploy later; the counts proofs passed
    }
  });
  test("the core checkout at X stays clean and untouched by the run", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    await runIt(l, join(dev, FROZEN));
    expect(git(l.core, "status", "--porcelain", "--untracked-files=all").split("\n").filter((s) => s && !s.startsWith("?? deployments/8453/"))).toEqual([]);
    expect(git(l.core, "rev-parse", "HEAD")).toBe(l.x);
  });
  test("the dev checkout may also be Y == a later descendant of Y", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    writeFileSync(join(dev, "README.later"), "x"); git(dev, "add", "README.later"); git(dev, "commit", "-q", "-m", "later");
    expect((await runIt(l, join(dev, FROZEN))).code).toBe(0);
  });
  test("a linked git worktree of the core repo at Y works too", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    const wt = join(tmp("pc-wt-"), "wt");
    git(dev, "worktree", "add", "-q", "--detach", wt, "HEAD");
    expect((await runIt(l, join(wt, FROZEN))).code).toBe(0);
  });
});

describe("L2 refusals: the counts checkout must be the same repository, a descendant of X, clean, and track every frozen file with the same bytes", () => {
  const fails = async (l: Layout, dir: string, text: string, stage: "plan" | "libs" = "plan") => {
    const r = await runIt(l, dir, stage);
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(r.err).toContain(text);
    expect(r.signerMade).toBe(false);
  };
  test("X.json present but not committed in the dev checkout", async () => {
    const l = coreAtX();
    const dev = await devAtY(l, false);
    await fails(l, join(dev, FROZEN), "not tracked at HEAD");
  });
  test("X.json committed but edited after the commit", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    appendFileSync(join(dev, FROZEN, `${l.x}.json`), "\n");
    await fails(l, join(dev, FROZEN), "differs from the committed");
  });
  test("the anchor file edited after the commit in the dev checkout", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    appendFileSync(join(dev, FROZEN, `${PREV}.json`), "\n");
    await fails(l, join(dev, FROZEN), "restore the committed bytes"); // the loader's own anchor hash check fires first
  });
  test("a tracked frozen file deleted from the dir", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    rmSync(join(dev, FROZEN, `${PREV}.json`));
    await fails(l, join(dev, FROZEN), "restore the anchor file");
  });
  test("an untracked extra frozen file in the dir", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    writeFileSync(join(dev, FROZEN, `${"1".repeat(40)}.json`), JSON.stringify({ deploySha: "1".repeat(40), measured: { chainId: 918453, at: "x" }, counts: REF }));
    await fails(l, join(dev, FROZEN), "not tracked at HEAD");
  });
  test("an untracked non-frozen file in the dir (the dir must be clean)", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    writeFileSync(join(dev, FROZEN, "notes.txt"), "x");
    await fails(l, join(dev, FROZEN), "is not clean");
  });
  test("a dev checkout BEHIND X (HEAD does not contain X) is refused", async () => {
    const l = coreAtX();
    writeFileSync(join(l.core, "later.txt"), "x"); git(l.core, "add", "later.txt"); git(l.core, "commit", "-q", "-m", "after");
    const l2 = { ...l, x: git(l.core, "rev-parse", "HEAD") }; // the core checkout is at X2; the dev checkout sits on X1, one commit behind
    const dev = join(tmp("pc-dev-"), "dev");
    execFileSync("git", ["clone", "-q", l.core, dev], { stdio: "pipe", env: cleanEnv });
    git(dev, "checkout", "-q", "--detach", "HEAD~1");
    await freeze(l2.x, join(dev, FROZEN));
    git(dev, "add", "-A"); git(dev, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "data");
    await fails(l2, join(dev, FROZEN), "is not a descendant of");
  });
  test("an UNRELATED repository that tracks identical files is refused (not the same history)", async () => {
    const l = coreAtX();
    const other = join(tmp("pc-other-"), "o");
    mkdirSync(join(other, FROZEN), { recursive: true });
    git(other, "init", "-q"); git(other, "config", "commit.gpgsign", "false");
    copyFileSync(REF_PATH, join(other, FROZEN, `${PREV}.json`));
    await freeze(l.x, join(other, FROZEN));
    git(other, "add", "-A"); git(other, "commit", "-q", "-m", "forged");
    await fails(l, join(other, FROZEN), "is not a descendant of");
  });
  test("a counts dir that is no git work tree at all is refused", async () => {
    const l = coreAtX();
    const dir = join(tmp("pc-plain-"), "frozen");
    copyFileSync(REF_PATH, (mkdirSync(dir, { recursive: true }), join(dir, `${PREV}.json`)));
    await freeze(l.x, dir);
    await fails(l, dir, "not inside a git work tree");
  });
  test("git that cannot run is a refusal that says so", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    expect(await msg(() => gitFrozenDirCommitted(l.core, join(dev, FROZEN), "/nonexistent/git"))).toContain("git could not run");
  });
  test("a shallow dev checkout that lacks X is refused", async () => {
    const l = coreAtX();
    const shallow = join(tmp("pc-sh-"), "s"); // taken before the core checkout moved to the release sha: it never saw it
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${l.core}`, shallow], { stdio: "pipe", env: cleanEnv });
    git(shallow, "config", "commit.gpgsign", "false");
    writeFileSync(join(l.core, "later.txt"), "x"); git(l.core, "add", "later.txt"); git(l.core, "commit", "-q", "-m", "release sha X2");
    const l2 = { ...l, x: git(l.core, "rev-parse", "HEAD") };
    await freeze(l2.x, join(shallow, FROZEN));
    git(shallow, "add", "-A"); git(shallow, "commit", "-q", "-m", "data");
    await fails(l2, join(shallow, FROZEN), "is not a descendant of");
  });
});

describe("L3: the file cannot be committed in X's own tree", () => {
  test("committing X.json makes a different commit: X's own tree never holds X.json", async () => {
    const l = coreAtX();
    await freeze(l.x, join(l.core, FROZEN));
    git(l.core, "add", "-A"); git(l.core, "commit", "-q", "-m", "try to commit X.json");
    expect(git(l.core, "rev-parse", "HEAD")).not.toBe(l.x);
    expect(await msg(() => git(l.core, "cat-file", "-e", `${l.x}:${FROZEN}/${l.x}.json`))).not.toBe("");
    // and a core checkout at that new HEAD is not the release sha: the file names X, the run needs HEAD == X
    const r = await runIt({ ...l, x: l.x }, join(l.core, FROZEN));
    expect(r.code).toBe(EXIT_CODES.USAGE);
    expect(r.err).toContain("not the DEPLOY_SHA");
  });
});

describe("the git children are hermetic (issue 1740 review)", () => {
  const withEnv = async <T>(vars: Record<string, string>, f: () => Promise<T>): Promise<T> => {
    const old: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) { old[k] = process.env[k]; process.env[k] = vars[k]; }
    try { return await f(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  /** A repo that would PASS every check for X (the descendant dev checkout of a good layout): the place a hostile GIT_DIR would redirect git to. */
  test("a hostile GIT_DIR, GIT_WORK_TREE, GIT_OBJECT_DIRECTORY and GIT_INDEX_FILE in the process env cannot redirect the checks: a bad counts dir is still refused, a good one still passes", async () => {
    const l = coreAtX();
    const good = await devAtY(l);
    const bad = await devAtY(l, false); // X.json present but not committed
    const hostile = { GIT_DIR: join(good, ".git"), GIT_WORK_TREE: good, GIT_OBJECT_DIRECTORY: join(good, ".git", "objects"), GIT_INDEX_FILE: join(good, ".git", "index"), GIT_CEILING_DIRECTORIES: "/" };
    // a plain copy of the good dir, in no repository: a git redirected by GIT_DIR/GIT_WORK_TREE would read the good repo and accept it
    const plain = tmp("pc-plainwt-");
    mkdirSync(join(plain, FROZEN), { recursive: true });
    for (const n of [`${PREV}.json`, `${l.x}.json`]) copyFileSync(join(good, FROZEN, n), join(plain, FROZEN, n));
    const redirect = { ...hostile, GIT_WORK_TREE: plain };
    await withEnv(redirect, async () => {
      expect(await msg(() => gitFrozenDirCommitted(l.core, join(plain, FROZEN)))).toContain("not inside a git work tree");
      expect(await msg(() => gitAnchorCommitted(join(plain, FROZEN, `${l.x}.json`), fileHashOf(readFileSync(join(plain, FROZEN, `${l.x}.json`)))))).toContain("not committed at HEAD");
    });
    await withEnv(hostile, async () => {
      expect(await msg(() => gitFrozenDirCommitted(l.core, join(bad, FROZEN)))).toContain("not tracked at HEAD");
      expect(await msg(() => gitFrozenDirCommitted(l.core, join(good, FROZEN)))).toBe("");
      expect(await msg(() => gitAnchorCommitted(join(bad, FROZEN, `${l.x}.json`), fileHashOf(readFileSync(join(bad, FROZEN, `${l.x}.json`)))))).toContain("not committed at HEAD");
      // the dirty-tree check of the core checkout is hermetic too: it reports the dirt of the repo it was pointed at
      writeFileSync(join(l.core, "stray.txt"), "x");
      expect((await dirtyTreeLines(spawnTool, l.core, 8453, { PATH: process.env.PATH!, ...hostile })).join("|")).toContain("stray.txt");
    });
  });
  test("a refs/replace ref cannot fake ancestry: an unrelated repo whose HEAD is grafted onto X is refused", async () => {
    const l = coreAtX();
    const other = join(tmp("pc-rep-"), "o");
    mkdirSync(join(other, FROZEN), { recursive: true });
    git(other, "init", "-q"); git(other, "config", "commit.gpgsign", "false");
    copyFileSync(REF_PATH, join(other, FROZEN, `${PREV}.json`));
    git(other, "add", "-A"); git(other, "commit", "-q", "-m", "unrelated root");
    await freeze(l.x, join(other, FROZEN));
    git(other, "add", "-A"); git(other, "commit", "-q", "-m", "forged data");
    git(other, "fetch", "-q", l.core, l.x); // X's objects are now in the repo, but not in its history
    git(other, "replace", "--graft", "HEAD", l.x); // HEAD now "has" X as its parent
    // the replacement really does fake it for a plain git
    expect(execFileSync("git", ["-C", other, "merge-base", "--is-ancestor", l.x, "HEAD"], { stdio: "pipe", env: cleanEnv }).toString()).toBe("");
    const r = await runIt(l, join(other, FROZEN));
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(r.err).toContain("is not a descendant of");
  });
  test("an ignored file in the counts dir is refused", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    writeFileSync(join(dev, ".gitignore"), "*.tmp\n"); git(dev, "add", ".gitignore"); git(dev, "commit", "-q", "-m", "ignore");
    expect((await runIt(l, join(dev, FROZEN))).code).toBe(0);
    writeFileSync(join(dev, FROZEN, "hidden.tmp"), "x");
    const r = await runIt(l, join(dev, FROZEN));
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(r.err).toContain("!! deployments/frozen-counts/hidden.tmp");
  });
  test("git refusing a foreign-owned checkout is said plainly", async () => {
    const l = coreAtX();
    const fake = join(tmp("pc-fakegit-"), "git");
    writeFileSync(fake, "#!/bin/sh\ncase \"$*\" in *rev-parse\\ HEAD*) git \"$@\" ;; *) echo \"fatal: detected dubious ownership in repository at 'x'\" >&2; exit 128 ;; esac\n", { mode: 0o755 });
    const dev = await devAtY(l);
    const m = await msg(() => gitFrozenDirCommitted(l.core, join(dev, FROZEN), fake));
    expect(m).toContain("dubious ownership");
    expect(m).toContain("owned by the operator");
  });
});

describe("--counts-require-origin-dev (issue 1740 review)", () => {
  test("off by default; on, HEAD must be reachable from the counts repo's local origin/dev", async () => {
    const l = coreAtX();
    const dev = await devAtY(l);
    expect((await runIt(l, join(dev, FROZEN))).code).toBe(0); // default: not asked
    let r = await runIt(l, join(dev, FROZEN), "plan", ["--counts-require-origin-dev"]);
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING); // no refs/remotes/origin/dev at all
    expect(r.err).toContain("not reachable from its origin/dev");
    git(dev, "update-ref", "refs/remotes/origin/dev", "HEAD");
    expect((await runIt(l, join(dev, FROZEN), "plan", ["--counts-require-origin-dev"])).code).toBe(0);
    // a local descendant Y' that adds a forged file after the fetch is not on origin/dev
    writeFileSync(join(dev, "forged.txt"), "x"); git(dev, "add", "forged.txt"); git(dev, "commit", "-q", "-m", "local only");
    r = await runIt(l, join(dev, FROZEN), "plan", ["--counts-require-origin-dev"]);
    expect(r.code).toBe(EXIT_CODES.COUNTS_MISSING);
    expect(r.err).toContain("not reachable from its origin/dev");
    expect((await runIt(l, join(dev, FROZEN))).code).toBe(0);
  });
});

describe("the default counts dir cannot satisfy the layout and the error says what to pass (issue 1740 review)", () => {
  test("no --counts-dir: the refusal names --counts-dir and a clean dev checkout at Y >= X", async () => {
    const l = coreAtX();
    const cwdCounts = join(l.w.dir, FROZEN); // the default: deployments/frozen-counts under the working directory
    mkdirSync(cwdCounts, { recursive: true });
    copyFileSync(REF_PATH, join(cwdCounts, `${PREV}.json`));
    await freeze(l.x, cwdCounts);
    const env = { PATH: `${STUB_DIR}:${process.env.PATH}`, HOME: process.env.HOME, STUB_STATE: l.w.statePath, STUB_CONFIG: l.w.cfgPath, GITHUB_TOKEN: "t" };
    const args = ["--chain", "8453", "--rpc", "http://rpc.test:8545", "--sheet", l.w.sheetPath, "--signer", "keystore:/dev/shm/stub/DEPLOYER", "--environment", "base-mainnet", "--core-sha", l.x, "--core-dir", l.core, "--evidence", l.w.evidence, "--stage", "plan"];
    const { main } = await import("../src/cli.ts");
    const code = await main(args, l.w.deps({ env, run: realGit as never, verifyReconstructed: async () => {} }));
    expect(code).toBe(EXIT_CODES.COUNTS_MISSING);
    const e = l.w.logs().reverse().find((x) => x.level === "error");
    expect(JSON.stringify(e)).toContain("pass --counts-dir <a clean checkout of dev at Y >= the release sha");
  });
});
