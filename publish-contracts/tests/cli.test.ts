// Review-security-001 (issue 1927): runbook 4.15 names the LIVE v0.5.0 checkout as --core-dir, so the release gate proves that sha. The rc checkout given as --upgrade-build is gated on its
// own on 8453, before any signer: a clean HEAD with an annotated rc tag of the sheet's kind on releases-A.B.x, the canonical remote tag, and green CI. Stub tools, no chain.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOY_IMPL_VERB } from "../src/deploy-implementation.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { SHA2 } from "./fixtures.ts";
import { world } from "./harness.ts";

const IMPL = "0x0000000000000000000000000000000000009200";
const RC = "release/v0.6.0-rc.2";

/** An 8453 world and an rc checkout beside its core checkout, at SHA2. */
function rcWorld() {
  const w = world({ chainId: 8453 });
  const rc = join(w.dir, "rc");
  mkdirSync(join(rc, ".git"), { recursive: true });
  writeFileSync(join(rc, ".git", "HEAD"), SHA2 + "\n");
  const calls: string[] = [];
  const seams = (o: { tag?: string | null; branch?: boolean; green?: boolean } = {}) => ({
    releaseTag: async (dir: string) => (dir === rc ? (o.tag === undefined ? RC : o.tag) : "release/1.0.0"),
    rcOnReleaseBranch: async (dir: string, sha: string, branch: string) => { calls.push(`branch:${branch}:${sha}`); return o.branch ?? true; },
    checkShaGreen: async (i: { sha: string }) => { calls.push(`green:${i.sha}`); return o.green === false && i.sha === SHA2 ? { code: 1, output: "RED" } : { code: 0, output: "GREEN" }; },
    deployImplementation: (async () => { calls.push("deploy"); return { reused: false, entry: { proxy_name: "gateway", implementation: IMPL, code_hash: "0x01", deploy_tx: "0x02" }, next: "govern" }; }) as never,
    govern: { api: { connectSafe: async () => { calls.push("safe"); throw new Error("the Safe was read"); } } } as never,
  });
  const failed = () => w.logs().filter((l) => l.event === "run.failed").map((l) => l.kind);
  return { w, rc, calls, seams, failed };
}

describe("review-security-001: the --upgrade-build rc checkout is gated on 8453 (issue 1927)", () => {
  const deploy = (rc: string) => [DEPLOY_IMPL_VERB, "--proxy", "gateway", "--upgrade-build", rc];
  const upgrade = (rc: string) => ["govern", "--row", "upgrade-proxy", "--proxy", "gateway", "--implementation", IMPL, "--upgrade-build", rc];

  for (const [name, argv] of [["deploy-implementation", deploy], ["govern --row upgrade-proxy", upgrade]] as const) {
    test(`${name}: an untagged, a dirty, an off-branch and a red rc checkout are each refused before any signer, nothing sent`, async () => {
      const cases: [string, (x: ReturnType<typeof rcWorld>) => object, string][] = [
        ["untagged", (x) => x.seams({ tag: null }), "RELEASE_SHA_UNTAGGED"],
        ["a non-rc release tag", (x) => x.seams({ tag: "release/0.6.0" }), "RELEASE_SHA_UNTAGGED"],
        ["a rehearsal rc on a production sheet", (x) => x.seams({ tag: "release/v0.6.0-rc.2-rehearsal" }), "RELEASE_SHA_UNTAGGED"],
        ["dirty", (x) => { (x.w.cfg as any).gitDirtyFor = { [x.rc]: [" M contracts/RobotMoneyGateway.sol"] }; return x.seams(); }, "USAGE"],
        ["off the release branch", (x) => x.seams({ branch: false }), "USAGE"],
        ["red CI", (x) => x.seams({ green: false }), "CI_NOT_GREEN"],
      ];
      for (const [what, arm, kind] of cases) {
        const x = rcWorld();
        const code = await x.w.run(argv(x.rc), arm(x));
        expect(code, what).toBe(EXIT_CODES[kind as keyof typeof EXIT_CODES]);
        expect(x.failed(), what).toEqual([kind]);
        expect(x.calls.filter((c) => c === "deploy" || c === "safe"), what).toEqual([]);
        expect(x.w.logs().some((l) => l.event === "stage.start"), what).toBe(false);
      }
    });
  }

  test("a clean rc checkout with its rc tag on releases-0.6.x and green CI passes the gate, and the verb runs", async () => {
    const x = rcWorld();
    const code = await x.w.run(deploy(x.rc), x.seams());
    expect(code).toBe(0);
    expect(x.calls).toContain(`branch:releases-0.6.x:${SHA2}`);
    expect(x.calls).toContain(`green:${SHA2}`);
    expect(x.calls.at(-1)).toBe("deploy");
    expect(x.w.logs().find((l) => l.event === "upgrade_build.release_gate")).toMatchObject({ sha: SHA2, tag: RC });
  });

  test("the Twin chain and an --upgrade-build that is the --core-dir checkout are not gated again", async () => {
    const twin = rcWorld();
    const t = world();
    const calls: string[] = [];
    expect(await t.run(deploy(twin.rc), { deployImplementation: (async () => { calls.push("deploy"); return { reused: false, entry: { proxy_name: "gateway", implementation: IMPL, code_hash: "0x01", deploy_tx: "0x02" }, next: "" }; }) as never })).toBe(0);
    expect(calls).toEqual(["deploy"]);
    const same = rcWorld();
    expect(await same.w.run(deploy(same.w.coreDir), same.seams({ tag: null }))).toBe(0);
    expect(same.calls.filter((c) => c.startsWith("branch"))).toEqual([]);
  });
});
