// Chain-dependent acceptance criteria of devops 57 (Safe tool) and devops 60 (mainnet run). Each live test needs a real chain, so it is
// skipped with a reason that is the exact command to run later. The always-run group proves the criteria are named, wired and refused on
// 8453 where they must be, so a skipped test cannot silently drop a criterion.
// Nothing here is a stand-in: no mock Safe, no scripted chain. No secret is read.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./fixtures.ts";
import { REPO_ROOT } from "./repo-root.ts";

const E2E = join(import.meta.dir, "..", "src", "safe", "e2e.test.ts");
const e2eText = readFileSync(E2E, "utf8");

const SAFE_CMD = "SAFE_TEST_RPC=<twin rpc> SAFE_TEST_DEPLOYER=<keystore> SAFE_TEST_OWNERS=<k1,k2,k3> SAFE_TEST_PASSFILE=<0600 file> bun test src/safe/e2e.test.ts --timeout 120000";
const safeReady = Boolean(process.env.SAFE_TEST_RPC && process.env.SAFE_TEST_DEPLOYER && process.env.SAFE_TEST_OWNERS && process.env.SAFE_TEST_PASSFILE);

describe("devops 57: the real SafeL2 1.4.1 criteria are all present in the skipped e2e file", () => {
  const criteria: [string, RegExp][] = [
    ["propose, sign by threshold owners, execute, nonce increment", /propose, sign by threshold owners, execute: on-chain effect and nonce increment/],
    ["prefixed eth_sign from a keystore accepted by execTransaction", /prefixed eth_sign signature from a keystore is accepted by execTransaction/],
    ["signature bundle import executes the transaction", /signature bundle import executes the transaction/],
    ["below-threshold GS020 and non-owner GS026", /below-threshold fails with GS020 and a non-owner signature fails with GS026/],
  ];
  for (const [name, re] of criteria) test(`e2e file has a test for: ${name}`, () => expect(e2eText).toMatch(re));

  test("the e2e file asserts the nonce increment, the on-chain effect, v 31/32 for eth_sign, and both GS codes", () => {
    expect(e2eText).toContain("toBe(before + 1)");
    expect(e2eText).toContain("isModuleEnabled");
    expect(e2eText).toContain('["1f", "20"]');
    expect(e2eText).toContain('"GS020"');
    expect(e2eText).toContain('"GS026"');
  });

  test("the e2e file refuses Base mainnet and names the command that runs it", () => {
    expect(e2eText).toContain("CHAIN_ID !== 8453");
    expect(e2eText).toContain("SAFE_TEST_RPC");
    expect(SAFE_CMD).toContain("bun test src/safe/e2e.test.ts");
  });

});

describe.skipIf(!safeReady)("devops 57: live Safe criteria (reason: needs a Twin chain Safe 1.4.1 and encrypted keystores)", () => {
  test(`run: ${SAFE_CMD}`, () => {
    // The assertions live in src/safe/e2e.test.ts, which this env also enables. Here only the 8453 refusal is checked.
    expect(Number(process.env.SAFE_TEST_CHAIN_ID ?? 918453)).not.toBe(8453);
  });
});

// devops 60: criteria that read chain 8453 itself. They need the recorded mainnet run, which exists only after the owner runs it.
const INPUTS = join(REPO, "deployments", "8453", "verify-inputs.json");
const MAIN_RPC = process.env.MAINNET_RPC_URL;
const CORE = REPO_ROOT;
const mainReady = existsSync(INPUTS) && Boolean(MAIN_RPC);
const VERIFY_CMD = "MAINNET_RPC_URL=<base rpc> bun test tests/chain-dependent-s8-s13.test.ts";

describe("devops 60: the verifier CLI fails on any red check", () => {
  test("the CLI exits 1 on a failure", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "verify", "cli.ts"), "utf8");
    expect(cli).toContain("process.exit(report.ok ? 0 : 1)");
  });
});

describe.skipIf(!mainReady)(`devops 60: verifier exits 0 against chain 8453 (reason: no recorded mainnet run; needs deployments/8453/verify-inputs.json, and MAINNET_RPC_URL; run: ${VERIFY_CMD})`, () => {
  test("the one verifier is VERIFIED against 8453 with the recorded manifests", () => {
    const j = JSON.parse(readFileSync(INPUTS, "utf8"));
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "verify", "cli.ts"), "--rpc", MAIN_RPC!, "--manifests", join(REPO, "deployments", "8453"), "--core-dir", CORE!,
      "--sheet-json", join(REPO, j.sheet_json), "--artifacts", j.artifacts, "--frozen", join(REPO, j.frozen), "--deploy-sha", j.deploy_sha, "--from-block", String(j.from_block)], { stdout: "pipe", stderr: "pipe" });
    expect(p.stdout.toString()).toContain("RESULT: VERIFIED");
    expect(p.exitCode).toBe(0);
  }, 600_000);
});

// Issue 1520, stage 12: the verifier asserts every deploy-time value against the sheet. The deployer set these before the handover and govern never
// touches them, so a difference here is a deploy that did not land the sheet. The world is the in-memory chain of tests/verify/world.ts.
describe("issue 1520: the stage 12 verifier fails when any deploy-time value differs from the sheet", () => {
  const { buildWorld, failed, GOV, ROUTER, VAULTS, addr } = require("./verify/world.ts") as typeof import("./verify/world.ts");
  const { verifyDeployment } = require("../src/verify/index.ts") as typeof import("../src/verify/index.ts");
  const cases: [string, string, (w: ReturnType<typeof buildWorld>) => void][] = [
    ["voting power", "governance: votingPower of every voter equals sheet", (w) => w.chain.set(GOV, "votingPower", 1n)],
    ["quorum", "governance: quorumThreshold equals sheet", (w) => w.chain.set(GOV, "quorumThreshold", 3n)],
    ["voting period", "governance: votingPeriod equals sheet", (w) => w.chain.set(GOV, "votingPeriod", 7200n)],
    ["execution delay", "governance: executionDelay equals sheet", (w) => w.chain.set(GOV, "executionDelay", 7200n)],
    ["tvl cap", "vault[rmPROTO]: tvlCap equals sheet", (w) => w.chain.set(VAULTS.rmPROTO.address, "tvlCap", 1n)],
    ["per-deposit cap", "vault[rmAGENT]: perDepositCap equals sheet", (w) => w.chain.set(VAULTS.rmAGENT.address, "perDepositCap", 1n)],
    ["exit fee", "vault[rmRWA]: exitFeeBps equals sheet", (w) => w.chain.set(VAULTS.rmRWA.address, "exitFeeBps", 9999n)],
    ["fee recipient", "vault[rmUSDC]: feeRecipient equals sheet", (w) => w.chain.set(VAULTS.rmUSDC.address, "feeRecipient", addr(0xbad))],
    ["router eligibility", "vault[rmPROTO]: router eligibility equals sheet", (w) => { w.sheet.vaults.rmPROTO.routerEligible = false; }],
    ["router eligibility of a basket the sheet leaves ineligible", "vault[rmAGENT]: router eligibility equals sheet", (w) => { w.sheet.vaults.rmAGENT.routerEligible = false; }],
    ["router default weights", "router: default weights equal sheet", (w) => w.chain.set(ROUTER, "getDefaultWeights", [Object.values(VAULTS).map((v) => v.address), [1n, 2n, 3n, 9994n]])],
  ];
  test("the healthy world passes all of them", async () => {
    expect(failed(await verifyDeployment(buildWorld().opts))).toEqual([]);
  });
  for (const [what, label, plant] of cases) {
    test(`a ${what} that differs from the sheet fails ${label}`, async () => {
      const w = buildWorld();
      plant(w);
      expect(failed(await verifyDeployment(w.opts))).toContain(label);
    });
  }
});
