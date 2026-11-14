import { describe, expect, test } from "bun:test";
import { PublishError } from "../src/errors.ts";
import { CI_GATE_WAIVER_ENV, assertReleaseGate, ciGateWaiver } from "../src/release-gate.ts";
import { SHA } from "./fixtures.ts";

// D4-14 (owner, 2026-11-14): a rehearsal may waive the green-CI check by naming the owner decision; every other gate check still runs, and a
// production sheet refuses the waiver.
const kindOf = (f: () => unknown): string | undefined => {
  try { f(); return undefined; } catch (e) { return e instanceof PublishError ? e.kind : "other"; }
};

describe("the D4-14 CI gate waiver", () => {
  test("no waiver: the CI check runs and a red CI refuses", async () => {
    let called = 0;
    const p = assertReleaseGate({ sha: SHA, coreDir: "/x", countsDir: "/none", env: { GITHUB_TOKEN: "t" }, kind: "rehearsal", requireCounts: false,
      releaseTags: async () => ["release/v0.8.0-rc.1-rehearsal"], remoteTag: async () => {}, checkShaGreen: async () => { called++; return { code: 1, output: "NOT GREEN" }; } });
    await expect(p).rejects.toMatchObject({ kind: "CI_NOT_GREEN" });
    expect(called).toBe(1);
  });

  test("a rehearsal with the waiver skips only the CI check: no token needed, check-sha-green never runs, the tag is returned", async () => {
    let called = 0;
    const tag = await assertReleaseGate({ sha: SHA, coreDir: "/x", countsDir: "/none", env: { [CI_GATE_WAIVER_ENV]: "D4-14" }, kind: "rehearsal", requireCounts: false,
      releaseTags: async () => ["release/v0.8.0-rc.1-rehearsal"], remoteTag: async () => {}, checkShaGreen: async () => { called++; return { code: 1, output: "" }; } });
    expect(tag).toBe("release/v0.8.0-rc.1-rehearsal");
    expect(called).toBe(0);
  });

  test("the waiver does not skip the tag checks: an untagged sha or a remote mismatch still refuses", async () => {
    const env = { [CI_GATE_WAIVER_ENV]: "D4-14" };
    await expect(assertReleaseGate({ sha: SHA, coreDir: "/x", countsDir: "/none", env, kind: "rehearsal", requireCounts: false, releaseTags: async () => [], remoteTag: async () => {} }))
      .rejects.toMatchObject({ kind: "RELEASE_SHA_UNTAGGED" });
    await expect(assertReleaseGate({ sha: SHA, coreDir: "/x", countsDir: "/none", env, kind: "rehearsal", requireCounts: false, releaseTags: async () => ["release/v0.8.0-rc.1-rehearsal"],
      remoteTag: async () => { throw new PublishError("RELEASE_TAG_REMOTE_MISMATCH", "moved"); } })).rejects.toMatchObject({ kind: "RELEASE_TAG_REMOTE_MISMATCH" });
  });

  test("a production sheet refuses the waiver, and a value that is not a decision id is a usage error", () => {
    expect(kindOf(() => ciGateWaiver({ [CI_GATE_WAIVER_ENV]: "D4-14" }, "production", SHA))).toBe("FLOOR");
    expect(kindOf(() => ciGateWaiver({ [CI_GATE_WAIVER_ENV]: "yes" }, "rehearsal", SHA))).toBe("USAGE");
    expect(ciGateWaiver({}, "production", SHA)).toBeUndefined();
    expect(ciGateWaiver({ [CI_GATE_WAIVER_ENV]: " " }, "rehearsal", SHA)).toBeUndefined();
  });
});
