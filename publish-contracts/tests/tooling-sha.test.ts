// Deploy 3 (2026-10-18): a run at a later commit that changed only tools continues the deployment's run manifest; the fee guard margin is 2x.
import { describe, expect, test } from "bun:test";
import { DEPLOY_INPUTS, isReadOnlyGitAncestry, isReadOnlyGitInputsDiff, toolingShaRun } from "../src/tooling-sha.ts";
import { FEE_GUARD_MULTIPLE, feeGuardNeedWei, spawnTool, type ProcessRunner } from "../src/runner.ts";
import { EXIT_CODES, PublishError } from "../src/errors.ts";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { world } from "./harness.ts";
import { SHA, SHA2, writeCounts } from "./fixtures.ts";

const D = SHA, T = SHA2;
/** A git double: `ancestor` answers merge-base, `changed` is the diff output. Records every call. */
const git = (o: { ancestor: boolean; changed?: string[]; diffCode?: number }) => {
  const calls: string[][] = [];
  const run: ProcessRunner = async (_tool, args) => {
    calls.push(args);
    if (args[2] === "merge-base") return { code: o.ancestor ? 0 : 1, stdout: "", stderr: "" };
    return { code: o.diffCode ?? 0, stdout: (o.changed ?? []).join("\n"), stderr: "" };
  };
  return { run, calls };
};
const at = (run: ProcessRunner, manifest: Record<string, unknown> | undefined, coreSha = T) => toolingShaRun(manifest as never, { coreSha, coreDir: "/core", run, env: {} });

describe("a run at a tooling sha", () => {
  test("a descendant with byte-identical deployed inputs continues the manifest at the original sha", async () => {
    const g = git({ ancestor: true });
    expect(await at(g.run, { coreSha: D })).toEqual({ originalSha: D, toolingSha: T });
    expect(g.calls[0]).toEqual(["-C", "/core", "merge-base", "--is-ancestor", D, T]);
    expect(g.calls[1]).toEqual(["-C", "/core", "diff", "--name-only", D, T, "--", ...DEPLOY_INPUTS]);
  });
  test("a changed deployed input is refused before any signer, naming the path", async () => {
    const g = git({ ancestor: true, changed: ["contracts/RobotMoneyVault.sol"] });
    await expect(at(g.run, { coreSha: D })).rejects.toMatchObject({ kind: "USAGE", message: expect.stringContaining("contracts/RobotMoneyVault.sol") });
  });
  test("a failing diff is refused, never read as no change", async () => {
    await expect(at(git({ ancestor: true, diffCode: 128 }).run, { coreSha: D })).rejects.toBeInstanceOf(PublishError);
  });
  test("mutation: not a descendant, the same sha, no manifest, or a manifest with redeploy rounds leaves the run held to the manifest's sha", async () => {
    expect(await at(git({ ancestor: false }).run, { coreSha: D })).toBeUndefined();
    const same = git({ ancestor: true });
    expect(await at(same.run, { coreSha: T })).toBeUndefined();
    expect(same.calls).toEqual([]);
    expect(await at(git({ ancestor: true }).run, undefined)).toBeUndefined();
    expect(await at(git({ ancestor: true }).run, { coreSha: D, vault_redeploys: [{ vault: "PROTO" }] })).toBeUndefined();
  });
  test("the two git reads are allowed in exactly the forms the check sends, and nothing wider", async () => {
    expect(isReadOnlyGitAncestry(["-C", "/core", "merge-base", "--is-ancestor", D, T])).toBe(true);
    expect(isReadOnlyGitAncestry(["-C", "/core", "merge-base", "--is-ancestor", "HEAD", T])).toBe(false);
    expect(isReadOnlyGitInputsDiff(["-C", "/core", "diff", "--name-only", D, T, "--", ...DEPLOY_INPUTS])).toBe(true);
    expect(isReadOnlyGitInputsDiff(["-C", "/core", "diff", "--name-only", D, T, "--", "contracts"])).toBe(false);
    expect(isReadOnlyGitInputsDiff(["-C", "/core", "diff", "--output=/x", D, T, "--", ...DEPLOY_INPUTS])).toBe(false);
    await expect(spawnTool("git", ["-C", "/core", "checkout", T], { env: {} })).rejects.toMatchObject({ kind: "TOOL" });
  });
});

describe("the fee guard", () => {
  test("a stage needs twice forge's estimate plus the 0.0001 ETH L1 allowance", () => {
    expect(FEE_GUARD_MULTIPLE).toBe(2);
    expect(feeGuardNeedWei(0.001)).toBe(2_000_000_000_000_000n + 100_000_000_000_000n);
    // Deploy 3's recorder stage: 3x needed 7050571261587317 wei, so the estimate was 0.002316857087195772 ETH; 2x needs about 0.00473 ETH
    expect(feeGuardNeedWei(0.002316857087195772) < 6_772_876_466_961_172n).toBe(true);
  });
});

describe("through the CLI: a rehearsal resumed at a tooling sha", () => {
  const REH = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "20261018" };
  const atSha2 = (w: ReturnType<typeof world>) => { writeFileSync(join(w.coreDir, ".git", "HEAD"), SHA2 + "\n"); writeCounts(w.countsDir, SHA2); };
  const manifestOf = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
  test("the Safe at SHA, libs resumed at SHA2 with identical deployed inputs: the run continues and keeps the original sha", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    expect(await w.run(["--stage", "safe"])).toBe(0);
    atSha2(w); w.cfg.gitAncestor = true;
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2])).toBe(0);
    expect(manifestOf(w).coreSha).toBe(SHA);
    expect(manifestOf(w).stages.libs.status).toBe("done");
    expect(w.logs().some((l) => l.event === "run.tooling_sha" && l.original_sha === SHA && l.tooling_sha === SHA2)).toBe(true);
  });
  test("the isomorphism report: kept when the deployment has one, written under the original sha when it has none", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    expect(await w.run(["--stage", "safe"])).toBe(0);
    const iso = join(w.evidence, `isomorphism-${JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8")).chainId}.json`);
    const original = readFileSync(iso, "utf8");
    atSha2(w); w.cfg.gitAncestor = true;
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2])).toBe(0);
    expect(readFileSync(iso, "utf8")).toBe(original);
    rmSync(iso);
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2])).toBe(0);
    expect(JSON.parse(readFileSync(iso, "utf8")).coreSha).toBe(SHA);
    expect(w.logs().some((l) => l.event === "run.isomorphism_written" && l.original_sha === SHA && l.tooling_sha === SHA2)).toBe(true);
   }, 30_000);
  test("mutation: a changed contract at SHA2 is refused before anything is sent", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    expect(await w.run(["--stage", "safe"])).toBe(0);
    atSha2(w); w.cfg.gitAncestor = true; w.cfg.gitInputsChanged = ["contracts/RobotMoneyVault.sol"];
    const before = w.state().calls.filter((c: any) => c.tool === "forge" && c.args.includes("--broadcast")).length;
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2])).toBe(EXIT_CODES.USAGE);
    expect(w.state().calls.filter((c: any) => c.tool === "forge" && c.args.includes("--broadcast")).length).toBe(before);
  });
  test("mutation: SHA2 not a descendant is refused by the resume as before (RESUME)", async () => {
    const w = world({ startNonce: 118, sheet: REH });
    expect(await w.run(["--stage", "safe"])).toBe(0);
    atSha2(w); w.cfg.gitAncestor = false;
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2])).toBe(EXIT_CODES.RESUME);
  });
});

describe("the release gate of a rehearsal at a tooling sha (owner decision 2026-10-19)", () => {
  const REH8453 = { DEPLOYMENT_KIND: "rehearsal", TIMELOCK_MIN_DELAY: "900", GOVERN_NEW_DELAY: "1800", SAFE_SALT_NONCE: "20261019" };
  // the tag, the green CI and the frozen counts exist at SHA only, the sha the deployment started at
  const gateAtShaOnly = { releaseTag: async (_d: string, sha: string) => (sha === SHA ? "release/1.0.0-rehearsal" : null), checkShaGreen: async (i: { sha: string }) => (i.sha === SHA ? { code: 0, output: "GREEN" } : { code: 1, output: "NOT GREEN" }) };
  const atSha2 = (w: ReturnType<typeof world>) => writeFileSync(join(w.coreDir, ".git", "HEAD"), SHA2 + "\n");
  test("the resume at SHA2 (byte-identical deployed inputs) is gated at SHA: it passes with no tag, CI or counts of its own", async () => {
    const w = world({ chainId: 8453, startNonce: 118, sheet: REH8453 });
    expect(await w.run(["--stage", "safe"], gateAtShaOnly as never)).toBe(0);
    atSha2(w); w.cfg.gitAncestor = true;
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2], gateAtShaOnly as never)).toBe(0);
    expect(w.logs().some((l) => l.event === "plan.release_gate_original_sha" && l.gate_sha === SHA && l.core_sha === SHA2)).toBe(true);
  });
  test("mutation: a changed deployed input at SHA2 is refused before the gate, nothing sent", async () => {
    const w = world({ chainId: 8453, startNonce: 118, sheet: REH8453 });
    expect(await w.run(["--stage", "safe"], gateAtShaOnly as never)).toBe(0);
    atSha2(w); w.cfg.gitAncestor = true; w.cfg.gitInputsChanged = ["contracts/RobotMoneyVault.sol"];
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2], gateAtShaOnly as never)).toBe(EXIT_CODES.USAGE);
  });
  test("mutation: SHA2 without the tooling relation is gated at its own sha and refused", async () => {
    const w = world({ chainId: 8453, startNonce: 118, sheet: REH8453 });
    expect(await w.run(["--stage", "safe"], gateAtShaOnly as never)).toBe(0);
    atSha2(w); w.cfg.gitAncestor = false;
    expect(await w.run(["--stage", "libs", "--resume", "--core-sha", SHA2], gateAtShaOnly as never)).not.toBe(0);
    expect(w.logs().some((l) => l.event === "plan.release_gate_original_sha")).toBe(false);
  });
});
