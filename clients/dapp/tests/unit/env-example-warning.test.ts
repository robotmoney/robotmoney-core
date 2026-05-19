/**
 * Documentation check (issue #431).
 *
 * Acceptance criterion: `.env.example` includes the production warning
 * for the bundled faucet key. This test fails if anyone removes the
 * warning block, so the CI freshness check is automatic.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe(".env.example faucet-key warning", () => {
  // vitest runs with cwd = clients/dapp (where vitest.config.ts lives).
  const envExample = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");

  it("contains a PUBLIC SECRET warning block", () => {
    expect(envExample).toMatch(/PUBLIC SECRET WARNING/);
  });

  it("warns operators that the key is inlined into the static bundle", () => {
    expect(envExample.toLowerCase()).toMatch(/inlined into the/);
    expect(envExample.toLowerCase()).toMatch(/bundle/);
  });

  it("explicitly tells operators never to fund the key on a real-money chain", () => {
    expect(envExample.toLowerCase()).toMatch(/never fund/);
  });

  it("documents the build-time guard rejecting mainnet builds with the key set", () => {
    expect(envExample).toMatch(/issue #431/i);
    expect(envExample).toMatch(/buildEnvValidation/);
  });
});
