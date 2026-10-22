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

// Owner decision 2026-10-19: there is no on-chain committee tilt. A doc that still names vote-submit either describes today's
// binary as a signed tilt or marks the command deprecated; it never calls it a governance vote.
test("committee vote-submit is described as a signed tilt or marked deprecated", () => {
  const mentions = files.filter((file) => read(file).includes("vote-submit"));
  expect(mentions.length).toBeGreaterThan(0);
  for (const file of mentions) {
    expect(read(file), file).toMatch(/signed\s+(?:allocation\s+)?tilt|deprecated/i);
    expect(read(file), file).not.toMatch(/vote-submit[^\n]*(?:casts?|submits?) a governance vote/i);
  }
});

test("no supersession trails", () => {
  for (const passage of [inv4, read("docs/technical/governance-decisions.md")]) {
    expect(passage).not.toMatch(/\b(?:superseded|amended|previously)\b/i);
  }
});

// Owner decisions 2026-10-19/20: there is no on-chain committee signal. The receipt is the only rebalancing signal the Safe may
// cite; the vector the Safe schedules through applyReceipt is the input. Both docs state that, not the old signal-endpoint check.
test("the receipt is the only rebalancing signal and the Safe's scheduled vector is the input", () => {
  for (const file of ["docs/technical/governance-decisions.md", "docs/technical/consensus-receipt-submitter-runbook.md"]) {
    const text = read(file);
    expect(text).toContain("The Investment Committee's only on-chain output is the consensus receipt.");
    expect(text).toContain("the only rebalancing signal the Safe may cite");
    expect(text).toContain("The vector the Safe schedules through `applyReceipt` is the input");
    expect(text).not.toContain("does not authenticate the member");
    expect(text).not.toContain("caller bound and ADMIN released");
    expect(text).not.toContain("receipts are the only rebalance input");
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
    const rule = "all three vaults deploy paused, and stage 13 unpauses all three through the Safe and the timelock";
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

// Issue 1833: review follow-ups to the per-vault rule table (PR 1830).
describe("VAULT_NAME and the same-core-sha rule in the deploy README (issue 1833)", () => {
  const readme = () => read("scripts/deploy/README.md").replace(/\s+/g, " ");
  test("the deploy README does not say the registry stage requires VAULT_NAME, and tells operators to delete it", () => {
    expect(readme()).not.toMatch(/registry stage requires `VAULT_NAME`/);
    expect(readme()).not.toMatch(/- `registry`: `VAULT_NAME`/);
    expect(readme()).toContain("Delete `VAULT_NAME` from the sheet before the next deploy run");
  });
  test("the deploy README states the CLI runs from the same core sha as DEPLOY_SHA", () => {
    expect(readme()).toContain("The CLI must run from the same core sha as `DEPLOY_SHA`");
  });
  test("the core-parity test title names the current VAULT_NAME rule", () => {
    const parity = read("publish-contracts/tests/core-parity.test.ts");
    expect(parity).not.toContain("VAULT_NAME is read by the registry script only");
    expect(parity).toContain("no stage script reads VAULT_NAME");
  });
});

// Issue 1851: the verify RPC requirement (receipts, no archive node) and the DEPLOY_SHA checkout of the emergency pause-all are in the operator docs.
describe("the verify RPC requirement and the pause-all DEPLOY_SHA checkout are documented (issue 1851)", () => {
  const flat = (p: string) => read(p).replace(/\s+/g, " ");
  test("publish-contracts/README.md names the verify RPC requirement, the no-archive reading and the RPC_REFUSED no-pause rule", () => {
    const r = flat("publish-contracts/README.md");
    expect(r).toContain("The verify RPC must serve `eth_getTransactionReceipt` for every deploy transaction of the run, and `eth_getLogs` from `firstBlock` to the head.");
    expect(r).toContain("The verifier never reads state at a past block");
    expect(r).toContain("verify exits `RPC_REFUSED` (30) and pauses nothing");
    expect(r).toContain("--run-manifest <publish-run.json>");
    expect(r).toContain("**An adopted timelock (issue 1835) is accepted.**");
    expect(r).toContain("**Exit 30 means the deployment is NOT verified**");
  });
  test("both exit-code lists of publish-contracts/README.md describe 30 for prove-control and verify and list 31 (issue 1864)", () => {
    const r = flat("publish-contracts/README.md");
    const want = "rpc refused 30 (prove-control adoption, or verify with only RPC-refused reads, nothing paused), counts untracked 31";
    expect(r.split(want).length - 1).toBe(2);
    // each list runs from "usage 2" to its last entry: the wording closes both of them
    for (const list of r.split("usage 2, sheet 3").slice(1)) expect(list.slice(0, list.indexOf(want) + want.length + 1)).toEndWith(`owner signer not hardware 29, ${want}.`);
  });
  test("manual-admin-actions.md and runbook 4.6 tell the operator to run pause-all from the DEPLOY_SHA checkout", () => {
    expect(flat("docs/operations/manual-admin-actions.md")).toContain("Run the CLI from a checkout of `DEPLOY_SHA` (the same checkout `--core-dir` names).");
    const runbook = read("docs/operations/contract-release-runbooks.md");
    const s46 = runbook.slice(runbook.indexOf("### 4.6. Rollback"), runbook.indexOf("### 4.7")).replace(/\s+/g, " ");
    expect(s46).toContain("Run the CLI from a checkout of `DEPLOY_SHA`.");
    expect(s46).toContain("exits 30 (`RPC_REFUSED`) and pauses nothing");
  });
  test("the deploy README names the pause-all exception to the same-core-sha refusal", () => {
    expect(flat("scripts/deploy/README.md")).toContain("The emergency `pause-all` is the one exception");
  });
});

// Owner decision 2026-10-22: contract releases follow the frontend model (release branch, QA branch, squash, rc tag, production from the rc).
describe("the release branch model is stated, and the old rule is gone", () => {
  const policy = read("docs/operations/contract-release-runbooks.md").replace(/\s+/g, " ");
  test("the policy names the branches, the squash, the rc tag and production from the rc", () => {
    for (const s of [
      "`releases-A.B.x`", "Feature PRs never target a release branch", "`qa/A.B.x-<YYYY-MM-DD>`", "A pushed QA branch is never rewritten",
      "**squash-merged** onto `releases-A.B.x`", "The squash commit's tree must equal the tree QA passed", "`release/vA.B.C-rc.N`", "`release/vA.B.C-rc.N-rehearsal`",
      "Production runs only from an rc tag", "`vA.B.C` and the final `vA.B.C-rc.N` point at the same commit", "`rm-core-stage-1`", "never on the operator machine",
      "An agent never broadcasts a transaction to Base mainnet", "Adopting `releases-0.5.x` as the v0.5 line", "`git cherry-pick -x`",
    ]) expect(policy, s).toContain(s);
  });
  test("the old no-release-branch rule is stated nowhere in the docs", () => {
    for (const s of ["do not need a dedicated long-lived branch", "no long-lived release branch to keep in sync", "no release branch to backport from"]) {
      expect(policy, s).not.toContain(s);
      for (const f of ["docs/runbooks/contract-qa/README.md", "docs/development/ci-suites.md", "publish-contracts/README.md", "docs/technical/contract-upgradeability-plan.md", "docs/operations/manual-admin-actions.md"]) expect(read(f).replace(/\s+/g, " "), `${f}: ${s}`).not.toContain(s);
    }
  });
  test("the contract QA README, the template header and the CI doc name the same branches", () => {
    expect(read("docs/runbooks/contract-qa/README.md")).toContain("`qa/A.B.x-<YYYY-MM-DD>`");
    expect(read("docs/runbooks/contract-qa/template.yaml")).toContain("qa/A.B.x-<YYYY-MM-DD>");
    expect(read("docs/development/ci-suites.md")).toContain("### Release and QA branches");
  });
});
