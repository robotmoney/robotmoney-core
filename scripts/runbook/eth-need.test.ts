import { expect, test } from "bun:test";
import { DEPLOY_GAS, EXECUTE_GAS, ethNeed, sendsOf } from "./eth-need.ts";
import { feeFlagsOf } from "./run.ts";

test("eth-need counts deploys and Safe executes at the max fee, the reused adapter deploy once", () => {
  const steps = [
    { id: "a", cmds: [["bun", "publish-contracts/src/cli.ts", "deploy-implementation", "--proxy", "fund"]] },
    { id: "b", cmds: [["bun", "scripts/runbook/adapter-swap.ts", "upgrade", "deploy", "--proxy", "0x1"]] },
    { id: "c", cmds: [["bun", "publish-contracts/src/safe/cli.ts", "execute", "--bundle", "x"]] },
    { id: "d", cmds: [["bun", "scripts/runbook/adapter-swap.ts", "upgrade", "deploy", "--proxy", "0x1"], ["bun", "publish-contracts/src/safe/cli.ts", "execute", "--bundle", "y"]] },
    { id: "e", cmds: [["bun", "publish-contracts/src/safe/cli.ts", "propose"]] },
  ];
  expect(sendsOf(steps[3]!)).toEqual(["deploy", "execute"]);
  const n = ethNeed(steps, 7n);
  expect([n.deploys, n.executes]).toEqual([2, 2]);
  expect(n.wei).toBe((2n * DEPLOY_GAS + 2n * EXECUTE_GAS) * 7n);
});

test("{safefee} is the fee flags of the cast list", () => {
  expect(feeFlagsOf(["--keystore", "k", "--password-file", "p", "--priority-gas-price", "1000000", "--gas-price", "20000000"])).toEqual(["--priority-gas-price", "1000000", "--gas-price", "20000000"]);
  expect(feeFlagsOf(["--keystore", "k"])).toEqual([]);
});
