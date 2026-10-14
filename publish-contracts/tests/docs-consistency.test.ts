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

test("signals remain advisory until member authentication lands", () => {
  for (const file of ["docs/technical/governance-decisions.md", "docs/technical/consensus-receipt-submitter-runbook.md"]) {
    const text = read(file);
    expect(text).toContain("signals are advisory only");
    expect(text).toContain("does not authenticate the member until core issue 1790 lands");
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
