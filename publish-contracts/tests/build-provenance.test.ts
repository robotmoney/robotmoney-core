// Security round 2 (review: SECURITY_PROVENANCE_BYPASS, SECURITY_TRUST_ROOT): the 8453 build proof of an upgrade or a freeze binds the forge out/ the code is compared
// with, not only the checkout's HEAD. The out/ is git-ignored, so a clean checkout at a real release tag could hold artifacts of any other source. Each case runs real
// git on a temporary checkout (tests/source-checkout.ts): committed sources, an ignored out/ whose artifacts carry forge's compiler metadata.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactSourceProblems, gitTreeReader, proveBuild } from "../src/build-provenance.ts";
import { PublishError } from "../src/errors.ts";
import { assertReleaseGate } from "../src/release-gate.ts";
import { CANONICAL_CORE_REMOTE, assertCanonicalOrigin, verifyCanonicalRemoteTag, type GitRunner } from "../src/release-tag.ts";
import { tmp } from "./fixtures.ts";
import { commitAll, gitIn, sourceCheckout, sourceHash, writeFiles, writeSourceArtifact } from "./source-checkout.ts";

const VAULT = "RobotMoneyVault";
const VAULT_SOL = "contracts/RobotMoneyVault.sol";
const LIB = "VaultAdapterOps";
const LIB_SOL = "contracts/lib/VaultAdapterOps.sol";
const SOURCES: Record<string, string> = {
  [VAULT_SOL]: "// SPDX-License-Identifier: MIT\ncontract RobotMoneyVault { uint256 reviewed; }\n",
  [LIB_SOL]: "// SPDX-License-Identifier: MIT\nlibrary VaultAdapterOps {}\n",
};
const TAG = "release/v1";
const OTHER_SHA = "a".repeat(40);

/** A clean checkout with an annotated release/v1 at HEAD; its ignored out/ holds the vault (linking the library) and the library, compiled from `vault`/`lib`. */
function release(o: { vault?: Record<string, string>; lib?: Record<string, string> } = {}) {
  const c = sourceCheckout(SOURCES);
  gitIn(c.root, "tag", "-a", TAG, "-m", "release", c.sha);
  writeSourceArtifact(c.out, VAULT, { code: "0x60806040", target: VAULT_SOL, sources: o.vault ?? SOURCES, links: { [LIB]: LIB_SOL } });
  writeSourceArtifact(c.out, LIB, { code: "0x73000000", target: LIB_SOL, sources: o.lib ?? { [LIB_SOL]: SOURCES[LIB_SOL]! } });
  return c;
}
const prove = (c: { out: string }, o: Partial<Parameters<typeof proveBuild>[0]> = {}) =>
  proveBuild({ dir: c.out, chainId: 8453, coreDir: tmp("pc-deploy-"), coreSha: OTHER_SHA, gate: async () => TAG, row: "upgrade-proxy", artifacts: [VAULT], ...o });
const kindOf = async (p: Promise<unknown>): Promise<string> => { try { await p; } catch (e) { return (e as PublishError).kind ?? "other"; } return "none"; };

describe("security round 2: on 8453 the compared artifacts are the build of the sources committed at the build's sha", () => {
  test("a clean checkout at a real release tag whose ignored out/RobotMoneyVault.sol/RobotMoneyVault.json was compiled from other sources is refused with GOVERN", async () => {
    const c = release({ vault: { ...SOURCES, [VAULT_SOL]: "// SPDX-License-Identifier: MIT\ncontract RobotMoneyVault { uint256 unreviewed; }\n" } });
    expect(gitIn(c.root, "status", "--porcelain", "--untracked-files=all")).toBe(""); // out/ is ignored: git sees a clean tree
    let gated = false;
    await expect(prove(c, { gate: async () => { gated = true; return TAG; } })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining(`compiled from a ${VAULT_SOL} that differs from the one committed at ${c.sha}`) });
    expect(gated).toBe(true); // the gate passed: the tag and the HEAD were never the problem
  });

  test("mutation: the same checkout whose out/ was built from the committed sources passes, naming every artifact it proved", async () => {
    const c = release();
    expect(await prove(c)).toMatchObject({ proof: "release-gate", tag: TAG, sha: c.sha, checkout: c.root, sourcesProven: [VAULT, LIB] });
  });

  test("every linked library is followed: a stale library artifact next to a reviewed vault is refused", async () => {
    const c = release({ lib: { [LIB_SOL]: "library VaultAdapterOps { function drain() external {} }\n" } });
    const e = await prove(c).catch((x: PublishError) => x);
    expect(e).toMatchObject({ kind: "GOVERN" });
    expect((e as PublishError).message).toContain(`${LIB} was compiled from a ${LIB_SOL} that differs`);
    expect((e as PublishError).message).toContain("the out/ mixes builds");
  });

  test("an artifact with no compiler metadata, one whose compilation target is another contract, or one that compiled a file the tree does not hold is refused", async () => {
    const none = release();
    writeSourceArtifact(none.out, VAULT, { code: "0x60806040", target: VAULT_SOL, sources: SOURCES, noMetadata: true });
    await expect(prove(none)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("carries no compiler metadata") });
    const other = release();
    // another contract's artifact placed under the vault's name (its own sources are committed, so only the target gives it away)
    writeSourceArtifact(other.out, VAULT, { code: "0x60806040", target: LIB_SOL, targetName: LIB, sources: SOURCES });
    await expect(prove(other)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining(`compilation target is {"${LIB_SOL}":"${LIB}"}, not the contract ${VAULT}`) });
    const extra = release({ vault: { ...SOURCES, "contracts/Unreviewed.sol": "contract Unreviewed {}\n" } });
    await expect(prove(extra)).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("contracts/Unreviewed.sol, which is no file of the tree") });
    expect(artifactSourceProblems({ dir: extra.out, checkout: extra.root, sha: extra.sha, artifacts: ["Missing"] }).join()).toContain("no readable build artifact");
  });

  test("the build must be the checkout's own out/: an ignored directory deeper in the checkout is refused, on the deployment-checkout path too", async () => {
    const c = release();
    const deeper = join(c.root, "build", "out");
    mkdirSync(deeper, { recursive: true });
    cpSync(c.out, deeper, { recursive: true });
    expect(gitIn(c.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    for (const coreDir of [tmp("pc-deploy-"), c.root]) {
      // coreDir = the checkout at its sha: the path that used to accept any directory under the deployment checkout with no gate at all
      await expect(prove({ out: deeper }, { coreDir, coreSha: c.sha })).rejects.toMatchObject({ kind: "GOVERN", message: expect.stringContaining("is not the forge out/ of its checkout") });
    }
  });

  test("the deployment checkout's own out/ is held to the deployment sha's sources too; mutation: a reviewed out/ passes as deploy-checkout without a gate", async () => {
    const stale = release({ vault: { ...SOURCES, [VAULT_SOL]: "contract RobotMoneyVault { uint256 featureBranch; }\n" } });
    let gated = false;
    await expect(prove(stale, { coreDir: stale.root, coreSha: stale.sha, gate: async () => { gated = true; return TAG; } })).rejects.toMatchObject({ kind: "GOVERN" });
    const good = release();
    expect(await prove(good, { coreDir: good.root, coreSha: good.sha, gate: async () => { gated = true; return TAG; } })).toMatchObject({ proof: "deploy-checkout", sha: good.sha, sourcesProven: [VAULT, LIB] });
    expect(gated).toBe(false);
  });

  test("off 8453 nothing is refused: a Twin rehearsal compares with its own checkout", async () => {
    const c = release({ vault: { ...SOURCES, [VAULT_SOL]: "contract RobotMoneyVault {}\n" } });
    expect(await prove(c, { chainId: 918453 })).toMatchObject({ proof: "checkout-sha", sha: c.sha });
    expect(await prove({ out: join(c.root, "build", "out") }, { chainId: 918453 })).toMatchObject({ proof: "checkout-sha" });
  });

  test("sources are read from the commit, never from the working tree, and a submodule's from the commit its gitlink pins", () => {
    const c = sourceCheckout(SOURCES);
    // an embedded repository added as a gitlink, as lib/openzeppelin-contracts is
    const dep = join(c.root, "lib", "dep");
    mkdirSync(dep, { recursive: true });
    gitIn(dep, "init", "-q");
    gitIn(dep, "config", "commit.gpgsign", "false");
    writeFiles(dep, { "contracts/Dep.sol": "contract Dep { uint256 pinned; }\n" });
    commitAll(dep, "dep");
    gitIn(c.root, "add", "lib/dep");
    const sha = commitAll(c.root, "pin dep");
    // both working trees move on after the commit; nothing of it is committed
    writeFileSync(join(dep, "contracts", "Dep.sol"), "contract Dep { uint256 edited; }\n");
    writeFileSync(join(c.root, VAULT_SOL), "contract RobotMoneyVault { uint256 edited; }\n");
    const got = gitTreeReader(c.root, sha, ["lib/dep/contracts/Dep.sol", VAULT_SOL, "contracts/none.sol", "../outside.sol", "/etc/hosts"]);
    expect(got.get("lib/dep/contracts/Dep.sol")?.toString()).toBe("contract Dep { uint256 pinned; }\n");
    expect(got.get(VAULT_SOL)?.toString()).toBe(SOURCES[VAULT_SOL]);
    for (const p of ["contracts/none.sol", "../outside.sol", "/etc/hosts"]) expect([p, got.get(p)]).toEqual([p, undefined]);
    // an artifact hashed from the edited working copy of the submodule source is refused
    writeSourceArtifact(join(c.root, "out"), "Dep", { code: "0x6080", target: "lib/dep/contracts/Dep.sol", sources: { "lib/dep/contracts/Dep.sol": "contract Dep { uint256 edited; }\n" } });
    expect(artifactSourceProblems({ dir: join(c.root, "out"), checkout: c.root, sha, artifacts: ["Dep"] }).join()).toContain("differs from the one committed");
    writeSourceArtifact(join(c.root, "out"), "Dep", { code: "0x6080", target: "lib/dep/contracts/Dep.sol", sources: { "lib/dep/contracts/Dep.sol": "contract Dep { uint256 pinned; }\n" } });
    expect(artifactSourceProblems({ dir: join(c.root, "out"), checkout: c.root, sha, artifacts: ["Dep"] })).toEqual([]);
    expect(sourceHash("x")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

/** A clean release checkout whose origin is a local bare repository holding the same annotated tag (a fork or a mirror, never robotmoney/robotmoney-core). */
function forkRelease(): ReturnType<typeof release> & { remote: string } {
  const c = release();
  const remote = tmp("pc-fork-");
  gitIn(remote, "init", "-q", "--bare");
  gitIn(c.root, "remote", "add", "origin", remote);
  gitIn(c.root, "push", "-q", "origin", `refs/tags/${TAG}`);
  return { ...c, remote };
}

describe("security round 2: the release gate of a build checkout trusts nothing the checkout supplies", () => {
  test("a checkout whose origin is not the canonical repository is refused with RELEASE_TAG_REMOTE_MISMATCH, before CI is asked, though the remote holds the same tag", async () => {
    const c = forkRelease();
    let asked = false;
    const gate = (i: { checkout: string; sha: string }) => assertReleaseGate({ sha: i.sha, coreDir: i.checkout, ciDir: tmp("pc-deploy-"), countsDir: "", env: { GITHUB_TOKEN: "t" }, kind: "production", requireCounts: false, checkShaGreen: async () => { asked = true; return { code: 0, output: "" }; } });
    await expect(prove(c, { gate })).rejects.toMatchObject({ kind: "RELEASE_TAG_REMOTE_MISMATCH", message: expect.stringContaining("not robotmoney/robotmoney-core") });
    expect(asked).toBe(false);
  });

  test("a url.<base>.insteadOf in the checkout's config that rewrites the canonical URL to another repository is refused", async () => {
    const c = forkRelease();
    gitIn(c.root, "remote", "set-url", "origin", "git@github.com:robotmoney/robotmoney-core.git");
    gitIn(c.root, "config", `url.${c.remote}.insteadOf`, "git@github.com:robotmoney/robotmoney-core.git");
    expect(await kindOf(verifyCanonicalRemoteTag(c.root, TAG))).toBe("RELEASE_TAG_REMOTE_MISMATCH");
  });

  test("the origin forms of the canonical repository pass, every other repository is refused, and the tag is read only after the origin passed", async () => {
    for (const url of ["git@github.com:robotmoney/robotmoney-core.git", "git@github.com:robotmoney/robotmoney-core", "https://github.com/robotmoney/robotmoney-core", "https://github.com/robotmoney/robotmoney-core.git", "ssh://git@github.com/robotmoney/robotmoney-core.git", "https://x-access-token:T0KEN@github.com/robotmoney/robotmoney-core"]) {
      expect([url, CANONICAL_CORE_REMOTE.test(url)]).toEqual([url, true]);
    }
    for (const url of ["git@github.com:attacker/robotmoney-core.git", "https://github.com/robotmoney/robotmoney-core-fork", "https://evil.example/robotmoney/robotmoney-core", "https://github.com@evil.example/robotmoney/robotmoney-core", "/srv/mirror.git", "origin"]) {
      const calls: string[][] = [];
      const git: GitRunner = async (args) => { calls.push(args); return { code: 0, stdout: `${url}\n`, stderr: "" }; };
      expect([url, await kindOf(verifyCanonicalRemoteTag("/x", TAG, git))]).toEqual([url, "RELEASE_TAG_REMOTE_MISMATCH"]);
      expect(calls.map((a) => a.slice(2, 4).join(" "))).toEqual(["ls-remote --get-url"]); // never ls-remote --tags
    }
    const ok: GitRunner = async () => ({ code: 0, stdout: "git@github.com:robotmoney/robotmoney-core.git\n", stderr: "" });
    expect(await assertCanonicalOrigin("/x", ok)).toBe("git@github.com:robotmoney/robotmoney-core.git");
    // a token in a refused URL never reaches the message
    const fork: GitRunner = async () => ({ code: 0, stdout: "https://x-access-token:S3CRET@github.com/attacker/robotmoney-core\n", stderr: "" });
    const e = await assertCanonicalOrigin("/x", fork).catch((x: PublishError) => x);
    expect(e).toMatchObject({ kind: "RELEASE_TAG_REMOTE_MISMATCH" });
    expect(JSON.stringify([(e as PublishError).message, (e as PublishError).details])).not.toContain("S3CRET");
  });

  test("the gate runs the deployment checkout's check-sha-green, never the build checkout's own (which exits 0 on anything)", async () => {
    const c = sourceCheckout({ ...SOURCES, "scripts/ci/check-sha-green.ts": "console.log('BUILD CHECKOUT SCRIPT'); process.exit(0);\n" });
    gitIn(c.root, "tag", "-a", TAG, "-m", "release", c.sha);
    const deploy = tmp("pc-deploy-");
    writeFiles(deploy, { "scripts/ci/check-sha-green.ts": "console.log('DEPLOYMENT CHECKOUT SCRIPT', process.argv.slice(2).join(' ')); process.exit(1);\n" });
    const env = { GITHUB_TOKEN: "t", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const gate = (ciDir?: string) => assertReleaseGate({ sha: c.sha, coreDir: c.root, ...(ciDir ? { ciDir } : {}), countsDir: "", env, kind: "production", requireCounts: false, remoteTag: async () => {} });
    const e = await gate(deploy).catch((x: PublishError) => x);
    expect(e).toMatchObject({ kind: "CI_NOT_GREEN" });
    expect((e as PublishError).message).toContain(`DEPLOYMENT CHECKOUT SCRIPT ${c.sha} --repo robotmoney/robotmoney-core`);
    // mutation: with no ciDir the checkout under test supplies the script, and its own exits 0
    expect(await gate()).toBe(TAG);
  });

  test("the seam receives the deployment checkout as the directory to run check-sha-green in", async () => {
    const c = release();
    const deploy = tmp("pc-deploy-");
    let ranIn: string | undefined;
    await expect(assertReleaseGate({ sha: c.sha, coreDir: c.root, ciDir: deploy, countsDir: "", env: { GITHUB_TOKEN: "t" }, kind: "production", requireCounts: false, remoteTag: async () => {}, checkShaGreen: async (i) => { ranIn = i.coreDir; return { code: 1, output: "missing: forge-unit-tests" }; } }))
      .rejects.toMatchObject({ kind: "CI_NOT_GREEN" });
    expect(ranIn).toBe(deploy);
  });
});
