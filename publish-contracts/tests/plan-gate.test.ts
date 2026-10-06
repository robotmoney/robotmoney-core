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
});
