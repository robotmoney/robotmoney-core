// devops 58 (S11): the plan job's gate. A planted short delay on 8453 fails before any signer exists, so before any approval.
import { describe, expect, test } from "bun:test";
import { EXIT_CODES } from "../src/errors.ts";
import { world } from "./harness.ts";

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
