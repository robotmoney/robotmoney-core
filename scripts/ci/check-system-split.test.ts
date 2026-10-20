// Self-test of scripts/ci/check-system-split.ts (SYS-1, ACL-9): the real tree is clean against its baseline, and each planted mutation
// in a clean temp tree fails the gate with a nonzero exit. Run: bun test scripts/ci/check-system-split.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..");
const gate = join(repo, "scripts/ci/check-system-split.ts");
const temps: string[] = [];

function run(root?: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", gate, ...(root ? ["--root", root] : [])], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

const CLEAN: Record<string, string> = {
  "contracts/PortfolioRouter.sol": "contract PortfolioRouter { function setDefaultWeights() external {} }\n",
  "contracts/gateway/ConsensusRecommendationReceipt.sol": 'import {X} from "../lib/X.sol";\ncontract ConsensusRecommendationReceipt { }\n',
  "contracts/gateway/RobotMoneyGateway.sol":
    "contract RobotMoneyGateway {\n  function revealAuthorization(address agent) external { _register(agent); }\n  function _validatePolicy(address caller, address shareReceiver) internal pure { if (shareReceiver != caller) revert(); }\n}\n",
  "contracts/gateway/AccessRoles.sol": "abstract contract AccessRoles { }\n",
};

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sys-split-"));
  temps.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}
const mutate = (rel: string, body: string) => run(tree({ ...CLEAN, [rel]: body }));

afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("system split static guard", () => {
  test("the real tree passes against its baseline and scans contract files", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OK, \d+ contract files scanned/);
    expect(Number(/(\d+) contract files scanned/.exec(r.out)![1])).toBeGreaterThan(20);
  });
  test("every baseline entry names an issue and a reason", () => {
    const b = JSON.parse(readFileSync(join(repo, "scripts/ci/system-split-baseline.json"), "utf8")) as { known: { issue: number; reason: string; rule: string }[] };
    expect(b.known.length).toBeGreaterThan(0);
    for (const k of b.known) { expect(k.issue).toBeGreaterThan(0); expect(k.reason.length).toBeGreaterThan(10); expect(k.rule).toMatch(/^(SYS-1|ACL-9):/); }
  });
  test("a clean temp tree passes", () => expect(run(tree(CLEAN)).code).toBe(0));
  test("an empty tree fails: nothing scanned", () => expect(run(tree({ "README.md": "x" })).code).toBe(1));
  test("SYS-1: a gateway import in a vaults-system contract fails", () => {
    const r = mutate("contracts/PortfolioRouter.sol", 'import {RobotMoneyGateway} from "./gateway/RobotMoneyGateway.sol";\ncontract PortfolioRouter {}\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain("SYS-1:import");
  });
  test("SYS-1: a gateway constructor or initializer argument fails", () => {
    const r = mutate("contracts/PortfolioRouter.sol", "contract PortfolioRouter { address public gw; function initialize(address gateway_) external { gw = gateway_; } }\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("SYS-1:name");
  });
  test("SYS-1: a writes-only-from-the-gateway modifier fails", () => {
    const r = mutate("contracts/gateway/ConsensusRecommendationReceipt.sol", "contract R { modifier onlyGateway() { _; } }\n");
    expect(r.code).toBe(1);
  });
  test("SYS-1: a gateway name in a comment alone does not fail", () => {
    const r = mutate("contracts/PortfolioRouter.sol", "// the RobotMoneyGateway is a client of this router\ncontract PortfolioRouter {}\n");
    expect(r.code).toBe(0);
  });
  test("ACL-9: an authorizeAgent in the gateway artifact fails", () => {
    const r = mutate("contracts/gateway/RobotMoneyGateway.sol", "contract G { function authorizeAgent(address a) external {} }\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("ACL-9:authorizeAgent");
  });
  test("ACL-9: transferAgentOwnership fails", () => {
    const r = mutate("contracts/gateway/RobotMoneyGateway.sol", "contract G { function transferAgentOwnership(address a, address b) external {} }\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("ACL-9:transferAgentOwnership");
  });
  test("ACL-9: a role-gated agent registration shortcut in an upgrade artifact fails", () => {
    const r = mutate("contracts/gateway/AccessRoles.sol", "abstract contract A { function adminRegisterAgent(address a) external onlyRole(ADMIN_ROLE) { _grantRole(AGENT_ROLE, a); } }\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("ACL-9:role-registers-agent");
  });
  test("ACL-9: an ADMIN_ROLE share receiver exception fails", () => {
    const r = mutate("contracts/gateway/RobotMoneyGateway.sol", "contract G { function _validatePolicy(address c, address shareReceiver) internal view { if (!hasRole(ADMIN_ROLE, c) && shareReceiver != c) revert(); } }\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("ACL-9:share-receiver-exception");
  });
});
