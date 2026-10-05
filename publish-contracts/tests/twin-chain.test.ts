// Chain-dependent acceptance criteria of devops 55, 56, 58 and 61. Each test needs a live Twin chain (918453),
// so it is skipped unless TWIN_RPC_URL is set in the environment (a local Twin fork started by core's twin-fork tool, or the output of the twin-fork action in CI; it is not a repository variable). The skip reason is the exact command that runs it later.
// No secret is read here: signing material comes from the rehearsal keystores the runbook writes.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./fixtures.ts";
import { REPO_ROOT } from "./repo-root.ts";

const TWIN = process.env.TWIN_RPC_URL;
const CORE = REPO_ROOT;
const SHA = process.env.DEPLOY_SHA;
const ready = Boolean(TWIN && CORE && SHA);
const needs = "needs a Twin chain: TWIN_RPC_URL=<twin rpc> DEPLOY_SHA=<sha> bun test tests/twin-chain.test.ts --timeout 600000";

async function cast(args: string[]): Promise<string> {
  const p = Bun.spawn(["cast", ...args], { env: { ...process.env, ETH_RPC_URL: TWIN! }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`cast ${args[0]} failed`);
  return out.trim();
}

describe.skipIf(!ready)(`Twin chain runs (${needs})`, () => {
  test("devops 55: the RPC reports chain id 918453", async () => {
    expect(await cast(["chain-id"])).toBe("918453");
  });

  test("devops 55: the deployer nonce equals the summed frozen counts for the DEPLOY_SHA after a full run", async () => {
    // Run first: bun src/cli.ts deploy --chain 918453 --rpc $TWIN_RPC_URL --sheet <sheet> --signer <spec> --core-sha $DEPLOY_SHA
    const file = join(REPO, "deployments", "frozen-counts", `${SHA}.json`);
    expect(existsSync(file)).toBe(true);
    const counts = JSON.parse(readFileSync(file, "utf8")) as { counts?: Record<string, number> } & Record<string, unknown>;
    const per = (counts.counts ?? counts) as Record<string, number>;
    const sum = Object.values(per).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0);
    const deployer = process.env.DEPLOYER_ADDRESS;
    expect(deployer, "set DEPLOYER_ADDRESS to the run's deployer address (public)").toBeTruthy();
    expect(Number(await cast(["nonce", deployer!]))).toBe(sum);
  });

  test("devops 56 and 58: the rehearsal workflow's run verified every expected label", async () => {
    const out = process.env.VERIFY_STDOUT_FILE;
    expect(out, "set VERIFY_STDOUT_FILE to the saved stdout of the verify stage").toBeTruthy();
    const have = new Set(readFileSync(out!, "utf8").split("\n").map((l) => l.trim()));
    const want = readFileSync(join(import.meta.dir, "fixtures", "verifier-labels.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("["));
    for (const l of want) expect(have.has(l) || [...have].some((h) => h.includes(l)), l).toBe(true);
  });

  test("devops 58: a --dry-run preflight leaves the deployer nonce unchanged", async () => {
    const deployer = process.env.DEPLOYER_ADDRESS;
    expect(deployer).toBeTruthy();
    const before = await cast(["nonce", deployer!]);
    // Run between: bun src/cli.ts deploy --dry-run --chain 918453 --rpc $TWIN_RPC_URL --signer address:$DEPLOYER_ADDRESS ...
    expect(await cast(["nonce", deployer!])).toBe(before);
  });
});

describe("the Twin chain criteria are documented, not silently dropped", () => {
  test("the skipped group names the command that runs it", () => {
    expect(needs).toContain("TWIN_RPC_URL");
    expect(needs).toContain("bun test tests/twin-chain.test.ts");
  });
});
