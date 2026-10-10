// Issue 1727: counts.json of a rehearsal run on a deployer that is not fresh. The nonce is the start plus the sum plus the prove-control transaction; production has no start.
import { describe, expect, test } from "bun:test";
import { PROOF_TX_NONCES } from "../src/counts.ts";
import { buildCountsJson, checkCountsJson } from "../src/ci/rehearsal-counts.ts";
import { DEPLOYER_STAGES } from "../src/stages.ts";
import { COUNTS, SHA, tmp, writeCounts } from "./fixtures.ts";

const keys = () => DEPLOYER_STAGES.map((s) => s.countKey!);
const sum = Object.values(COUNTS).reduce((a, b) => a + b, 0);

describe("counts.json with a start nonce", () => {
  test("start 118: the nonce 118 + sum + proof passes; the production nonce, one more and one less fail", () => {
    const j = { deploySha: SHA, chainId: 918453, counts: COUNTS, deployerStartNonce: 118, deployerNonce: 118 + sum + PROOF_TX_NONCES };
    expect(checkCountsJson(j, keys())).toEqual([]);
    for (const n of [sum + PROOF_TX_NONCES, j.deployerNonce + 1, j.deployerNonce - 1]) expect(checkCountsJson({ ...j, deployerNonce: n }, keys()).join()).toContain("start nonce 118");
  });
  test("no start is a fresh deployer: unchanged", () => {
    expect(checkCountsJson({ deploySha: SHA, chainId: 918453, counts: COUNTS, deployerNonce: sum + PROOF_TX_NONCES }, keys())).toEqual([]);
    expect(checkCountsJson({ deploySha: SHA, chainId: 918453, counts: COUNTS, deployerNonce: sum + PROOF_TX_NONCES + 118 }, keys())).not.toEqual([]);
  });
  test("a bad start is named", () => {
    expect(checkCountsJson({ deploySha: SHA, chainId: 918453, counts: COUNTS, deployerStartNonce: -1, deployerNonce: sum + PROOF_TX_NONCES - 1 }, keys()).join()).toContain("deployerStartNonce");
  });
  test("build records the start only when there is one", () => {
    const dir = tmp("pc-counts-"); writeCounts(dir);
    expect(buildCountsJson(dir, SHA, 9, {}, 3).deployerStartNonce).toBe(3);
    expect("deployerStartNonce" in buildCountsJson(dir, SHA, 9)).toBe(false);
    expect("deployerStartNonce" in buildCountsJson(dir, SHA, 9, {}, 0)).toBe(false);
  });
});
