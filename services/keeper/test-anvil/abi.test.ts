// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1 (Stack: the ABIs come from out/, checked at build
// time). The committed src/abi.generated.json must equal what scripts/gen-abi.ts produces from a fresh forge build.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate, render } from "../scripts/gen-abi.ts";
import { REPO } from "./harness.ts";

test("src/abi.generated.json matches the forge artifacts in out/", () => {
  const p = Bun.spawnSync(["forge", "build", "contracts/FlowQueue.sol", "contracts/Rebalancer.sol", "contracts/KeeperAccount.sol",
    "contracts/RobotMoneyFund.sol"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  expect(p.exitCode).toBe(0);
  const committed = readFileSync(join(import.meta.dir, "../src/abi.generated.json"), "utf8");
  expect(committed).toBe(render(generate(join(REPO, "out"))));
}, 600_000);
