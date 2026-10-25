// Review-security-001 (issue 1927): runbook 4.15 names the LIVE v0.5.0 checkout as --core-dir, so the release gate proves that sha. The rc checkout given as --upgrade-build is gated on its
// own on 8453, before any signer: a clean HEAD with an annotated rc tag of the sheet's kind on releases-A.B.x, the canonical remote tag, and green CI. Stub tools, no chain.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes } from "viem";
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
  // the rc build: the gateway artifact, compiled from contracts/RobotMoneyGateway.sol, whose bytes its solc metadata hashes (review-security-003)
  const SRC = "contracts/gateway/RobotMoneyGateway.sol";
  mkdirSync(join(rc, "contracts", "gateway"), { recursive: true });
  writeFileSync(join(rc, SRC), "// rc source\n");
  mkdirSync(join(rc, "out", "RobotMoneyGateway.sol"), { recursive: true });
  // review-security-004: the settings the tree's foundry config yields, as solc metadata records them
  const SETTINGS = { optimizer: { enabled: true, runs: 100 }, evmVersion: "cancun", metadata: { bytecodeHash: "ipfs" }, remappings: [`${rc}/lib/oz/:x/=lib/oz/x/`, "lib/oz/:x/=lib/oz/x/", "forge-std/=lib/forge-std/src/"] };
  const CONFIG = { solc: "0.8.24", optimizer: true, optimizer_runs: 100, evm_version: "cancun", via_ir: false, bytecode_hash: "ipfs", remappings: ["forge-std/=lib/forge-std/src/", "lib/oz/:x/=lib/oz/x/"] };
  const writeArtifact = (hash: string, settings: object = SETTINGS) => writeFileSync(join(rc, "out", "RobotMoneyGateway.sol", "RobotMoneyGateway.json"), JSON.stringify({ metadata: { compiler: { version: "0.8.24+commit.e11b9ed9" }, settings, sources: { [SRC]: { keccak256: hash } } }, deployedBytecode: { object: "0x00", linkReferences: {} } }));
  writeArtifact(keccak256(toBytes("// rc source\n")));
  const calls: string[] = [];
  const seams = (o: { tag?: string | null; branch?: boolean; green?: boolean; tracked?: string[] } = {}) => ({
    trackedFiles: async (_dir: string, paths: string[]) => new Set(o.tracked ?? paths),
    forgeConfig: async () => CONFIG,
    releaseTag: async (dir: string) => (dir === rc ? (o.tag === undefined ? RC : o.tag) : "release/1.0.0"),
    rcOnReleaseBranch: async (dir: string, sha: string, branch: string) => { calls.push(`branch:${branch}:${sha}`); return o.branch ?? true; },
    checkShaGreen: async (i: { sha: string }) => { calls.push(`green:${i.sha}`); return o.green === false && i.sha === SHA2 ? { code: 1, output: "RED" } : { code: 0, output: "GREEN" }; },
    deployImplementation: (async () => { calls.push("deploy"); return { reused: false, entry: { proxy_name: "gateway", implementation: IMPL, code_hash: "0x01", deploy_tx: "0x02" }, next: "govern" }; }) as never,
    govern: { api: { connectSafe: async () => { calls.push("safe"); throw new Error("the Safe was read"); } } } as never,
  });
  const failed = () => w.logs().filter((l) => l.event === "run.failed").map((l) => l.kind);
  return { w, rc, calls, seams, failed, writeArtifact, SRC, SETTINGS };
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
        // review-security-003: a clean, tagged checkout whose gitignored out/ is a stale build (another source) or names a source git does not track
        ["a stale out/", (x) => { x.writeArtifact(keccak256(toBytes("// an earlier rc\n"))); return x.seams(); }, "USAGE"],
        ["an untracked source", (x) => x.seams({ tracked: [] }), "USAGE"],
        // review-security-004: the sources match, the compiler settings are not the tree's config
        ["another optimizer.runs", (x) => { x.writeArtifact(keccak256(toBytes("// rc source\n")), { ...x.SETTINGS, optimizer: { enabled: true, runs: 200 } }); return x.seams(); }, "USAGE"],
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

test("review-security-003: the refusal of a stale out/ names the source and both hashes, before any tag, branch or CI read", async () => {
  const x = rcWorld();
  x.writeArtifact(keccak256(toBytes("// an earlier rc\n")));
  expect(await x.w.run([DEPLOY_IMPL_VERB, "--proxy", "gateway", "--upgrade-build", x.rc], x.seams())).toBe(EXIT_CODES.USAGE);
  const failed = x.w.logs().find((l) => l.event === "run.failed")!;
  expect(failed.message).toContain("was not built from its tree");
  expect(failed.message).toContain(x.SRC);
  // the core sha's own gate ran (green at the v0.5.0 sha); nothing of the rc's tag, branch or CI was read, and nothing was deployed
  expect(x.calls.filter((c) => c.includes(SHA2) || c === "deploy")).toEqual([]);
});

test("review-security-003: buildProvenanceProblems follows the libraries an artifact links, and passes a build of the tree", async () => {
  const { buildProvenanceProblems } = await import("../src/release-gate.ts");
  const { tmp } = await import("./fixtures.ts");
  const dir = tmp("pc-prov-");
  const put = (rel: string, text: string) => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), text); };
  put("contracts/A.sol", "a"); put("contracts/L.sol", "l");
  const art = (name: string, src: string, hash: string, links: string[] = []) => put(`out/${name}.sol/${name}.json`, JSON.stringify({ metadata: { sources: { [src]: { keccak256: hash } } }, deployedBytecode: { linkReferences: links.length ? { "contracts/L.sol": Object.fromEntries(links.map((l) => [l, [{ start: 1, length: 20 }]])) } : {} } }));
  const all = async (_d: string, p: string[]) => new Set(p);
  art("A", "contracts/A.sol", keccak256(toBytes("a")), ["L"]);
  art("L", "contracts/L.sol", keccak256(toBytes("l")));
  expect(await buildProvenanceProblems(dir, ["A"], all)).toEqual([]);
  art("L", "contracts/L.sol", keccak256(toBytes("stale")));
  expect((await buildProvenanceProblems(dir, ["A"], all)).join()).toContain("contracts/L.sol: the L artifact was built from bytes");
  put("out/A.sol/A.json", JSON.stringify({ deployedBytecode: {} }));
  expect((await buildProvenanceProblems(dir, ["A"], all)).join()).toContain("carries no solc metadata sources");
});

test("review-security-004: buildSettingsProblems compares the compiler version, optimizer, evmVersion, viaIR, bytecodeHash and remappings with the tree's config", async () => {
  const { buildSettingsProblems } = await import("../src/release-gate.ts");
  const dir = "/w/rc";
  const meta = { compiler: { version: "0.8.24+commit.e11b9ed9" }, settings: { optimizer: { enabled: true, runs: 100 }, evmVersion: "cancun", metadata: { bytecodeHash: "ipfs" }, remappings: ["/w/rc/lib/a/:b/=lib/a/b/", "lib/a/:b/=lib/a/b/", "c/=lib/c/"] } };
  const cfg = { solc: "0.8.24", optimizer: true, optimizer_runs: 100, evm_version: "cancun", via_ir: false, bytecode_hash: "ipfs", remappings: ["c/=lib/c/", "lib/a/:b/=lib/a/b/"] };
  expect(buildSettingsProblems("G", meta, cfg, dir)).toEqual([]);
  const bad = (over: object, m: object = meta) => buildSettingsProblems("G", m, { ...cfg, ...over }, dir).join("; ");
  expect(bad({ optimizer_runs: 200 })).toContain("optimizer");
  expect(bad({ solc: "0.8.25" })).toContain("solc 0.8.24");
  expect(bad({ solc: null })).toContain("pins no solc");
  expect(bad({ evm_version: "shanghai" })).toContain("evmVersion");
  expect(bad({ via_ir: true })).toContain("viaIR");
  expect(bad({ bytecode_hash: "none" })).toContain("bytecodeHash");
  expect(bad({ remappings: ["c/=lib/c/"] })).toContain("only in the artifact: lib/a/:b/=lib/a/b/");
  expect(bad({}, { ...meta, settings: { ...meta.settings, remappings: ["/elsewhere/lib/a/:b/=lib/a/b/", "c/=lib/c/"] } })).toContain("remappings");
});
