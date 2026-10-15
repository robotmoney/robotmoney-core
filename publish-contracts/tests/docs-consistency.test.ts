import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

// Issue 1698: RouterGovernance has no voting. Outside the history (docs/archive, docs/code-review, docs/audits.md) no doc and no contract source names the
// deleted voting surface: the functions, events and sheet names that would describe a vote path. The contract source covered is every production .sol file
// (contracts/, scripts included, forge tests and the generated contract docs excluded).
function solidity(path: string): string[] {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    if (["contracts/test", "contracts/doc"].includes(child)) return [];
    return entry.isDirectory() ? solidity(child) : entry.name.endsWith(".sol") ? [child] : [];
  });
}
const VOTING_VOCABULARY = /\b(?:setVotingPower|votingPower|totalVotingPower|quorumThreshold|setQuorumThreshold|votingPeriod|setVotingPeriod|executionDelay|setExecutionDelay|activeProposal|proposalState|cadenceParams|proposalVoteSnapshot|hasVoted|ProposalCreated|VoteCast|ProposalExecuted|ProposalCancelled|VOTER_ADDRESSES|VOTER_POWER|QUORUM_THRESHOLD|VOTING_PERIOD|EXECUTION_DELAY)\b|RouterGovernance\.(?:propose|vote|execute)\b/;
// Third-party protocols' own governance events (Compound, Aave) are monitored upstream, not ours.
const THIRD_PARTY = /(?:Compound|Aave)[^\n]*ProposalCreated/;

test("no voting vocabulary outside history", () => {
  const sources = [...files, ...solidity("contracts")];
  expect(sources.filter((f) => f.endsWith(".sol")).length).toBeGreaterThan(10);
  const hits: string[] = [];
  for (const file of sources) {
    read(file).split("\n").forEach((line, i) => {
      if (VOTING_VOCABULARY.test(line) && !THIRD_PARTY.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
    });
  }
  expect(hits).toEqual([]);
});

// Issue 1705: one table holds the per-vault deploy and governance rule (scripts/deploy/stage-table.json vaults[]). The stale sentences of Scope D1 to D6, each in
// the file it was found in, must not come back, and the four canonical docs state the initial-state rule the table holds.
describe("four-vault rule", () => {
  const flat = (path: string) => read(path).replace(/\s+/g, " ");
  const STALE: [string, string][] = [
    // D1 prd.md: a stale implementation note and the deleted voting path
    ["docs/prd.md", "not yet implemented: core #1520"],
    ["docs/prd.md", "RouterGovernance votes"],
    // D2 contract-release-runbooks.md: rmUSDC was said to deploy open
    ["docs/operations/contract-release-runbooks.md", "Only the baskets deploy paused (`docs/prd.md`)"],
    ["docs/operations/contract-release-runbooks.md", "rmUSDC still deploys open"],
    ["docs/operations/contract-release-runbooks.md", "not yet implemented: core #1520"],
    // D3 security-model.md
    ["docs/technical/security-model.md", "not yet implemented: core #1520; `publish-contracts/src/govern.ts` still lists the older 13-row set"],
    ["docs/technical/security-model.md", "Stage 13 holds only the basket vault deposit unpause operations"],
    // D4 smart-contracts.md: emergencyUnwind floors each leg at the TWAP value less slippage
    ["docs/technical/smart-contracts.md", "lossy, fast path (no slippage limit)"],
    // D5 the vault scripts
    ["contracts/script/DeployVault.s.sol", "before the vault is opened"],
    ["contracts/script/BasketVaultDeployBase.sol", "The only mainnet operation after the handover is the vault unpause"],
    ["contracts/script/DeployProtocolAssetVault.s.sol", "The only operation after the handover is the basket unpause"],
    ["contracts/script/DeployAgentTokenVault.s.sol", "The only operation after the handover is the basket unpause"],
    ["contracts/script/DeployRwaBasketVault.s.sol", "The only operation after the handover is the basket unpause"],
    // D6 the owner-decision attribution of "one class of operation"
    ["publish-contracts/README.md", "exactly one class of operation remains"],
    ["publish-contracts/src/govern.ts", "ONE CLASS OF OPERATION AFTER THE HANDOVER (owner decision, 2026-10-05, issue 1520)"],
    ["docs/technical/governance-isomorphism.md", "Exactly one class of operation runs after the timelock handover"],
  ];
  for (const [file, sentence] of STALE) {
    test(`${file} no longer says: ${sentence}`, () => {
      expect(flat(file)).not.toContain(sentence.replace(/\s+/g, " "));
    });
  }

  test("prd.md, contract-release-runbooks.md, security-model.md and smart-contracts.md state the table's initial-state rule and cite the table", () => {
    const table = JSON.parse(read("scripts/deploy/stage-table.json")) as { vaults: { key: string; deployPaused: boolean; unpauseInStage13: boolean }[] };
    // the docs' sentence is the table's rule: written for the case every vault deploys paused and stage 13 opens every vault
    expect(table.vaults.map((v) => [v.key, v.deployPaused, v.unpauseInStage13])).toEqual(table.vaults.map((v) => [v.key, true, true]));
    const rule = "all four vaults deploy paused, and stage 13 unpauses all four through the Safe and the timelock";
    for (const doc of ["docs/prd.md", "docs/operations/contract-release-runbooks.md", "docs/technical/security-model.md", "docs/technical/smart-contracts.md"]) {
      const text = flat(doc);
      expect([doc, text.includes(rule)]).toEqual([doc, true]);
      expect([doc, text.includes("`scripts/deploy/stage-table.json` `vaults[].deployPaused` and `unpauseInStage13`")]).toEqual([doc, true]);
    }
  });

  test("the deleted ActivateBasketVaultEligibility script is gone and nothing refers to it", () => {
    const self = "publish-contracts/tests/docs-consistency.test.ts";
    const walk = (dir: string, ext: RegExp): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const child = `${dir}/${e.name}`;
      if (["node_modules", "docs/archive", "docs/code-review", "contracts/doc"].some((x) => child.endsWith(x))) return [];
      return e.isDirectory() ? walk(child, ext) : ext.test(e.name) ? [child] : [];
    });
    expect(existsSync(join(ROOT, "contracts/script/ActivateBasketVaultEligibility.s.sol"))).toBe(false);
    const files = [...walk("docs", /\.md$/), ...walk("contracts", /\.sol$/), ...walk("scripts", /\.(ts|json|sh|md)$/), ...walk("publish-contracts/src", /\.ts$/), ...walk("publish-contracts/tests", /\.ts$/), ...walk(".github/workflows", /\.ya?ml$/)];
    const hits = files.filter((f) => f !== self && read(f).includes("ActivateBasketVaultEligibility"));
    expect(hits).toEqual([]);
  });
});
