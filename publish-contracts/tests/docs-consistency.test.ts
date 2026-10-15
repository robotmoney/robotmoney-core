import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { VAULT_NAME } from "../src/sheet.ts";
import { loadStageTable } from "../src/stage-table.ts";

const ROOT = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
function markdown(path: string): string[] {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (["docs/archive", "docs/code-review", "docs/audits.md"].includes(child)) return [];
    return entry.isDirectory() ? markdown(child) : entry.name.endsWith(".md") ? [child] : [];
  });
}
const files = [...markdown("docs"), ...markdown("plugins")];
const inv4 = read("docs/prd.md").split("**INV-4")[1].split("**INV-5")[0];

test("INV-4 names the weight setter and the Safe", () => {
  for (const name of ["WEIGHT_SETTER_ROLE", "TimelockController", "Safe"]) expect(inv4).toContain(name);
});

test("committee vote-submit is described as a signed tilt", () => {
  const mentions = files.filter((file) => read(file).includes("vote-submit"));
  expect(mentions.length).toBeGreaterThan(0);
  for (const file of mentions) {
    expect(read(file), file).toMatch(/signed\s+(?:allocation\s+)?tilt/);
    expect(read(file), file).not.toMatch(/vote-submit[^\n]*(?:casts?|submits?) a governance vote/i);
  }
});

test("no supersession trails", () => {
  for (const passage of [inv4, read("docs/technical/governance-decisions.md")]) {
    expect(passage).not.toMatch(/\b(?:superseded|amended|previously)\b/i);
  }
});

// Core issue 1790 (PR 1818) landed: the gateway binds the vote's agent to the caller, so the docs state that check, not the gap.
test("signals are advisory and the signal endpoint binds the member to the caller", () => {
  for (const file of ["docs/technical/governance-decisions.md", "docs/technical/consensus-receipt-submitter-runbook.md"]) {
    const text = read(file);
    expect(text).toContain("signals are advisory only");
    expect(text).toContain("reverts `CommitteeAgentNotCaller` unless the vote's `agent` is `msg.sender`");
    expect(text).not.toContain("does not authenticate the member");
    expect(text).toContain("caller bound and ADMIN released");
    expect(text).toContain("receipts are the only rebalance input");
  }
});

// Issue 1705 (QA plan v1 E9 d): the docs state the four-vault rule the stage table holds, and the stale sentences the issue lists (Scope D1 to D6) stay gone.
describe("four-vault rule (issue 1705)", () => {
  const table = loadStageTable(ROOT);
  /** Prose with line breaks, `//` comment markers and repeated spaces collapsed, so a sentence wrapped over lines still matches. */
  const flat = (text: string): string => text.replace(/\n[ \t]*\/{2,3}[ \t]?/g, " ").replace(/\s+/g, " ");
  const WORDS = ["zero", "one", "two", "three", "four", "five", "six"];
  const and = (xs: string[]): string => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  /** The initial-state rule as the table states it: which vaults deploy paused and which stage 13 opens through the Safe and the timelock. */
  function initialStateRule(): string {
    const names = table.vaults.map((v) => VAULT_NAME[v.key]);
    const paused = table.vaults.filter((v) => v.deployPaused).map((v) => VAULT_NAME[v.key]);
    const opened = table.vaults.filter((v) => v.unpauseInStage13).map((v) => VAULT_NAME[v.key]);
    if (paused.length === names.length && opened.length === names.length) {
      return `All ${WORDS[names.length]} vaults (${names.join(", ")}) deploy paused, and the Safe unpauses each one through the timelock in stage 13.`;
    }
    const open = names.filter((n) => !paused.includes(n));
    return `${and(paused)} deploy paused and ${and(open)} deploy open; the Safe unpauses ${and(opened)} through the timelock in stage 13.`;
  }
  const RULE_DOCS = ["docs/prd.md", "docs/operations/contract-release-runbooks.md", "docs/technical/security-model.md", "docs/technical/smart-contracts.md"];

  test("four-vault rule: prd.md, contract-release-runbooks.md, security-model.md and smart-contracts.md state the initial-state rule from the stage table and cite the table", () => {
    const rule = initialStateRule();
    expect(rule).toBe("All four vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA) deploy paused, and the Safe unpauses each one through the timelock in stage 13.");
    for (const doc of RULE_DOCS) {
      const text = flat(read(doc));
      expect([doc, text.includes(rule.slice(0, -1))]).toEqual([doc, true]);
      expect([doc, text.includes("scripts/deploy/stage-table.json")]).toEqual([doc, true]);
    }
  });

  // The exact stale sentences of issue 1705 Scope D1 to D6, by the file that carried them.
  const STALE: [string, string[]][] = [
    ["docs/prd.md", ["All four vaults open deposits on day 2", "not yet implemented: core #1520", "RouterGovernance votes"]],
    ["docs/operations/contract-release-runbooks.md", ["Only the baskets deploy paused", "rmUSDC still deploys open"]],
    ["docs/technical/security-model.md", ["not yet implemented: core #1520", "still lists the older 13-row set", "Stage 13 holds only the basket vault deposit unpause operations"]],
    ["docs/technical/smart-contracts.md", ["no slippage limit"]],
    ["contracts/script/DeployVault.s.sol", ["before the vault is opened"]],
    ...["DeployProtocolAssetVault.s.sol", "DeployAgentTokenVault.s.sol", "DeployRwaBasketVault.s.sol", "BasketVaultDeployBase.sol"].map((f): [string, string[]] => [
      `contracts/script/${f}`, ["The only operation after the handover is the basket unpause", "The only mainnet operation after the handover is the vault unpause"],
    ]),
    ["publish-contracts/README.md", ["exactly one class of operation", "owner decision, 2026-10-05, issue 1520"]],
    ["publish-contracts/src/govern.ts", ["ONE CLASS OF OPERATION AFTER THE HANDOVER", "owner decision, 2026-10-05, issue 1520"]],
    ["docs/technical/governance-isomorphism.md", ["Exactly one class of operation runs after the timelock handover"]],
  ];
  for (const [file, sentences] of STALE) {
    test(`four-vault rule: ${file} carries none of the stale sentences`, () => {
      const text = flat(read(file)).toLowerCase();
      for (const s of sentences) expect([file, s, text.includes(s.toLowerCase())]).toEqual([file, s, false]);
    });
  }

  test("four-vault rule: the deleted stale basket eligibility script is gone and nothing names it", () => {
    const name = ["Activate", "BasketVaultEligibility"].join("");
    expect(existsSync(join(ROOT, "contracts", "script", `${name}.s.sol`))).toBe(false);
    const skip = new Set(["docs/archive", "docs/code-review", "docs/audits.md", "node_modules", "out", "cache", "lib", "broadcast", "target"]);
    const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const p = `${dir}/${e.name}`;
      if (skip.has(p) || skip.has(e.name)) return [];
      return e.isDirectory() ? walk(p) : /\.(md|mdx|sol|ts|tsx|json|ya?ml|sh|py|toml)$/.test(e.name) ? [p] : [];
    });
    const files = ["docs", "contracts/script", "contracts/test", "contracts/doc/src", "scripts", ".github", "publish-contracts/src", "publish-contracts/tests", "plugins"].flatMap(walk);
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => read(f).includes(name))).toEqual([]);
    expect(read("contracts/doc/vocs.sidebar.ts")).not.toContain(name);
  });
});

// Issue 1811 (QA plan v1 P4, ADR-0014 stage 4): a freeze removes recovery by upgrade, so the release checklist (runbook §4.1, the code-readiness gate) must
// require an external security review and the nightly Twin lifecycle rehearsal before a final mainnet release. A rewrite that drops either fails here.
describe("final mainnet release checklist (issue 1811)", () => {
  const runbook = read("docs/operations/contract-release-runbooks.md");
  const gate = runbook.split("### 4.1. Code-readiness gate")[1]!.split("### 4.2.")[0]!;
  test("the code-readiness gate requires an external security review of the exact release SHA before a final mainnet release, and never waives it", () => {
    expect(gate).toContain("Final mainnet release only");
    expect(gate).toMatch(/\*\*external security review\*\* of the\s+exact release SHA/);
    expect(gate).toContain("docs/audits.md");
    expect(gate).toMatch(/An internal review, the QA plan's security workstream or a\s+green CI run does not count/);
    expect(gate).toContain("never waived");
  });
  test("the gate requires the nightly Twin upgrade rehearsal at the release SHA, and that job exists in the nightly", () => {
    expect(gate).toContain("twin-upgrade-rehearsal");
    expect(gate).toContain("upgrade-rehearsal-<sha>");
    const wf = read(".github/workflows/suite-29-nightly-twin-fork.yml");
    expect(wf).toMatch(/^ {2}twin-upgrade-rehearsal:$/m);
    expect(wf).toContain("bun publish-contracts/src/ci/twin-upgrade-rehearsal.ts");
  });
  test("the governed-proxy section documents the Twin lifecycle rehearsal, its refusals and its evidence check", () => {
    const s412 = runbook.split("### 4.12.")[1]!.split("\n## 5.")[0]!;
    for (const p of ["twin-upgrade-rehearsal", "--proxy-lifecycle", "UpgradesAreFrozen()", "post-freeze-upgrade-registry", "`GOVERN` (exit 14)", "It does not prove mainnet governance works"]) {
      expect([p, s412.includes(p)]).toEqual([p, true]);
    }
  });
});

// Issue 1809 test plan: the release runbook's governed-proxy section and the stage table must agree on the authority stage, the proxies and the release modes.
describe("governed-proxy runbook matches the stage table (issue 1809)", () => {
  const table = loadStageTable(ROOT);
  const s412 = read("docs/operations/contract-release-runbooks.md").split("### 4.12.")[1]!.split("\n## 5.")[0]!;
  const flat = s412.replace(/\s+/g, " ");
  const proxies = table.proxies ?? [];

  test("the section names exactly the stage table's proxies, and counts them right", () => {
    const listed = /The stage table's `proxies` block names them: (.+?)\. /.exec(flat)?.[1] ?? "";
    const names = [...listed.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(names.sort()).toEqual(proxies.map((p) => p.name).sort());
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
    expect(flat).toContain(`The ${words[proxies.length]} stateful core contracts run behind their own \`ERC1967Proxy\``);
  });

  test("the authority stage the section describes is the table's: before the first proxy stage, and the handover reuses it", () => {
    expect(flat).toContain("The `authority` stage deploys the timelock before the first proxy");
    const order = table.stages.map((s) => s.name);
    const firstProxy = Math.min(...proxies.map((p) => order.indexOf(p.stage)));
    expect(order.indexOf("authority")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("authority")).toBeLessThan(firstProxy);
    for (const p of proxies) {
      const st = table.stages.find((s) => s.name === p.stage)!;
      expect([p.stage, st.requiredEnv.includes("UPGRADE_AUTHORITY"), st.requiredEnv.includes("UPGRADE_MODE")]).toEqual([p.stage, true, true]);
    }
    expect(table.stages.find((s) => s.name === "timelock")!.requiredEnv).toContain("TIMELOCK_ADDRESS");
    expect(flat).toContain("the handover stage reuses it");
  });

  test("the release modes the section names are exactly the sheet's UPGRADE_MODE values, with no default", async () => {
    const { UPGRADE_MODES } = await import("../src/sheet.ts");
    const modes = /The sheet's `UPGRADE_MODE` is required: `([^`]+)` \([^)]*\) or `([^`]+)`/.exec(flat);
    expect(modes?.slice(1).sort()).toEqual([...UPGRADE_MODES].sort());
    expect(flat).toContain("There is no default");
  });

  test("the refusals and exit codes the section names are the tool's", async () => {
    const { EXIT_CODES } = await import("../src/errors.ts");
    expect(flat).toContain(`stops the run with \`VERIFY\` (exit ${EXIT_CODES.VERIFY})`);
    expect(flat).toContain(`\`GOVERN\` (exit ${EXIT_CODES.GOVERN})`);
    for (const p of ["An undeclared mode", "a non-empty ERC-1967 admin or beacon slot", "another implementation or another authority", "upgrade-proxy", "freeze-proxy", "`FreezeTargetMismatch`"]) {
      expect([p, flat.includes(p)]).toEqual([p, true]);
    }
  });
});
