// devops 58 (S11): the plan job's gate. A planted short delay on 8453 fails before any signer exists, so before any approval.
import { describe, expect, test } from "bun:test";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { MAINNET_CHAIN_ID, TWIN_CHAIN_ID } from "../src/chains.ts";
import { world } from "./harness.ts";
import { assertCountsTracked } from "../src/release-gate.ts";

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

// core 1668: every run that broadcasts on 8453 passes the release gate before any signer exists. pause-all never does.
describe("release gate on every broadcasting run on 8453", () => {
  const quiet = async (f: () => Promise<number>): Promise<number> => { const l = console.log; console.log = () => {}; try { return await f(); } finally { console.log = l; } };
  const noSigner = () => { throw new Error("the gate must refuse before a signer is built"); };
  const runs: Array<[string, string[]]> = [["publish", ["publish"]], ["govern", ["govern"]], ["stage prove-control", ["--stage", "prove-control"]], ["stage deploy", ["--stage", "deploy"]]];

  for (const [name, args] of runs) {
    test(`${name}: an untagged SHA is RELEASE_SHA_UNTAGGED, with no signer`, async () => {
      let signerMade = false;
      const w = world({ chainId: 8453 });
      expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { releaseTag: async () => null, makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.RELEASE_SHA_UNTAGGED);
      expect(signerMade).toBe(false);
    });
    test(`${name}: red CI is CI_NOT_GREEN, with no signer`, async () => {
      let signerMade = false;
      const w = world({ chainId: 8453 });
      expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { checkShaGreen: async () => ({ code: 1, output: "RED" }), makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.CI_NOT_GREEN);
      expect(signerMade).toBe(false);
    });
    test(`${name}: a missing counts file is COUNTS_MISSING, with no signer`, async () => {
      let signerMade = false;
      const w = world({ chainId: 8453, writeFrozen: false });
      expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.COUNTS_MISSING);
      expect(signerMade).toBe(false);
    });
  }

  test("pause-all runs on 8453 with an untagged SHA and red CI: neither check is read", async () => {
    let tagRead = false, greenRan = false;
    const w = world({ chainId: 8453 });
    const code = await quiet(() => w.run(["pause-all", "--environment", "base-mainnet"], { releaseTag: async () => { tagRead = true; return null; }, checkShaGreen: async () => { greenRan = true; return { code: 1, output: "RED" }; } }));
    expect(code).toBe(EXIT_CODES.RESUME); // it got as far as reading the run manifest, which this world has none of
    expect(tagRead).toBe(false);
    expect(greenRan).toBe(false);
  });

  test("a dry run on 8453 broadcasts nothing, so it is not gated", async () => {
    let tagRead = false;
    const w = world({ chainId: 8453 });
    await quiet(() => w.run(["publish", "--dry-run", "--environment", "base-mainnet"], { releaseTag: async () => { tagRead = true; return null; } }));
    expect(tagRead).toBe(false);
  });

  describe("the frozen counts file must be committed and clean in its git work tree", () => {
    const dirt: Array<[string, string[]]> = [["untracked", ["?? deployments/frozen-counts/x.json"]], ["modified", [" M deployments/frozen-counts/x.json"]], ["ignored", ["!! deployments/frozen-counts/x.json"]]];
    for (const [kind, lines] of dirt) {
      test(`${kind}: refused on 8453 with COUNTS_UNTRACKED, for the plan and for publish, before a signer`, async () => {
        for (const args of [["--stage", "plan"], ["publish"]]) {
          let signerMade = false;
          const w = world({ chainId: 8453 });
          w.cfg.gitCountsDirty = lines;
          expect(await quiet(() => w.run([...args, "--environment", "base-mainnet"], { makeSigner: () => { signerMade = true; return noSigner(); } }))).toBe(EXIT_CODES.COUNTS_UNTRACKED);
          expect(signerMade).toBe(false);
        }
      });
    }
    test("a git failure on the counts file is refused, never read as clean", async () => {
      const failing = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
      await expect(assertCountsTracked(failing, "/x", "a".repeat(40))).rejects.toMatchObject({ kind: "COUNTS_UNTRACKED" });
      await expect(assertCountsTracked(async () => ({ code: 0, stdout: "", stderr: "" }), "/x", "a".repeat(40))).resolves.toBeUndefined();
    });
    test("the same dirty file is accepted on 918453", async () => {
      const w = world({ chainId: 918453 });
      w.cfg.gitCountsDirty = ["?? deployments/frozen-counts/x.json"];
      expect(await quiet(() => w.run(["--stage", "plan"]))).toBe(0);
    });
    test("a committed clean file passes the gate", async () => {
      const w = world({ chainId: 8453 });
      expect(await quiet(() => w.run(["--stage", "plan", "--environment", "base-mainnet"]))).toBe(0);
    });
  });
});
