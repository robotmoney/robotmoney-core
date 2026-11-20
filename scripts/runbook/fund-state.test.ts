// scripts/runbook/fund-state.test.ts: the pre-state reads of v0.9.0-onevault-upgrade P0.94 and the counters P2.84 compares.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./fund-state.ts";
import type { Cast } from "./cast-io.ts";

const TL = "0x0000000000000000000000000000000000000071", SAFE = "0x00000000000000000000000000000000000000Sa";
const fake = (answers: Record<string, string>): Cast => (args) => {
  const k = args.join(" ");
  if (args[0] === "keccak") return `k(${args[1]})`;
  if (k in answers) return answers[k]!;
  throw new Error(`unexpected cast ${k}`);
};

test("proxies: each runs its manifest implementation, unfrozen, upgraded by the timelock", () => {
  const ok = { "implementation 0xP": "0xIMPL", "call 0xP upgradesFrozen()(bool)": "false", "call 0xP upgradeTimelock()(address)": TL.toUpperCase().replace("0X", "0x") };
  expect(() => main(fake(ok), "proxies", ["--timelock", TL, "--proxy", "0xP:0ximpl"])).not.toThrow();
  expect(() => main(fake(ok), "proxies", ["--timelock", TL, "--proxy", "0xP:0xother"])).toThrow("not the manifest's");
  expect(() => main(fake({ ...ok, "call 0xP upgradesFrozen()(bool)": "true" }), "proxies", ["--timelock", TL, "--proxy", "0xP:0ximpl"])).toThrow("frozen");
  expect(() => main(fake(ok), "proxies", ["--timelock", TL, "--proxy", "0xP"])).toThrow("PROXY:IMPL");
});

test("timelock: the delay, the Safe as proposer, canceller and only executor", () => {
  const role = (r: string, who: string, v: boolean) => ({ [`call ${TL} hasRole(bytes32,address)(bool) k(${r}) ${who}`]: String(v) });
  const ok = {
    [`call ${TL} getMinDelay()(uint256)`]: "900", [`call ${SAFE} getOwners()(address[])`]: "[0x1, 0x2]", [`call ${SAFE} getThreshold()(uint256)`]: "2",
    ...role("PROPOSER_ROLE", SAFE, true), ...role("CANCELLER_ROLE", SAFE, true), ...role("EXECUTOR_ROLE", SAFE, true), ...role("EXECUTOR_ROLE", "0x0000000000000000000000000000000000000000", false),
  };
  expect(() => main(fake(ok), "timelock", ["--timelock", TL, "--safe", SAFE, "--delay", "900"])).not.toThrow();
  expect(() => main(fake(ok), "timelock", ["--timelock", TL, "--safe", SAFE, "--delay", "86400"])).toThrow("delay is 900");
  expect(() => main(fake({ ...ok, ...role("EXECUTOR_ROLE", "0x0000000000000000000000000000000000000000", true) }), "timelock", ["--timelock", TL, "--safe", SAFE, "--delay", "900"])).toThrow("executor is open");
});

test("counters: written as supply-seedshares-plan-requests, then compared", () => {
  const ok = { "call 0xF totalSupply()(uint256)": "3995775955902177929119940 [3.995e24]", "call 0xF balanceOf(address)(uint256) 0xF": "1000000000000000000000000 [1e24]", "call 0xF currentPlanId()(uint256)": "1", "call 0xQ requestCount()(uint256)": "6", "call 0xF planStatus()(uint8)": "0" };
  const out = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fund-state-")), "upg-fund-before");
  main(fake(ok), "counters", ["--fund", "0xF", "--queue", "0xQ", "--out", out]);
  expect(readFileSync(out, "utf8")).toBe("3995775955902177929119940-1000000000000000000000000-1-6\n");
  expect(() => main(fake(ok), "counters", ["--fund", "0xF", "--queue", "0xQ", "--same", "3995775955902177929119940-1000000000000000000000000-1-6"])).not.toThrow();
  expect(() => main(fake({ ...ok, "call 0xQ requestCount()(uint256)": "7" }), "counters", ["--fund", "0xF", "--queue", "0xQ", "--same", "3995775955902177929119940-1000000000000000000000000-1-6"])).toThrow("was");
  expect(() => main(fake(ok), "counters", ["--fund", "0xF", "--queue", "0xQ"])).toThrow("--out FILE or --same");
});
