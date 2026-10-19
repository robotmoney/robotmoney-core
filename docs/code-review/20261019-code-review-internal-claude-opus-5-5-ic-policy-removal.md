# IC policy removal review: code that still carries the on-chain committee (2026-10-19)

## Scope and pinned commits

- **Repository:** `robotmoney/robotmoney-core`.
- **Commits checked:** release v0.5.0 at core `57fbe618` (tag
  `release/v0.5.0-rehearsal`, branch `releases-0.5.x`) and `dev` at
  `e362df0c`. Every finding below holds at both.
- **Reviewed at:** 2026-10-19.
- **Design under test:** the owner decision of 2026-10-19 that
  `InvestmentCommitteePolicy` is deleted. There is no voting and no on-chain
  committee tilt. The vaults system's rebalancing input is the consensus
  recommendation receipt only. A submitter holding `RECEIPT_SUBMITTER_ROLE` on
  `ConsensusRecommendationReceipt`, granted by `ADMIN_ROLE` through the
  timelock, records a receipt directly. The gateway never touches committee
  or receipts (`docs/architecture.md` §1, §4.9).
- **Storage decision:** the gateway keeps its retired `icPolicy` and
  `consensusReceipt` slots. The receipt keeps its retired `gateway` and
  `icPolicy` slots. An empty `IInvestmentCommitteePolicy` interface stays only
  to type the gateway slot. The proxy storage layout gate
  (`scripts/ci/check-core-storage-layout.sh`) allows no removal.
- **Method:** read the contracts, deploy scripts, publish-contracts, clients,
  indexer, plugins and CI. Compile and test runs were not part of this review.
- **Relation to the system split review:** this design supersedes findings 1
  to 5 of `20261019-code-review-internal-claude-opus-5-5-system-split.md`.
  With the IC policy gone, the caller-binding risk of that review's finding 3
  has no contract left to apply to.

## Headline verdict

The code still ships the on-chain committee end to end. The IC policy is
deployed, the receipt contract authorizes submitters through it, the gateway
routes committee and receipt writes, and the tooling, clients, indexer, dapp
and plugins all build on it. None of it feeds router weights. Removing it is a
code change across about 270 files. The rehearsal deploy runbook follows the
tooling, and its validator must change before the runbook can drop a step.

## Findings

### 1. `InvestmentCommitteePolicy` still exists and is deployed

- **Severity:** Medium.
- `contracts/gateway/InvestmentCommitteePolicy.sol` and its full interface
  ship. Its tilt storage (`submitVote`, `VoteSubmitted`) is read by nothing in
  the weight path.
- **Fix:** delete the contract. Reduce `IInvestmentCommitteePolicy` to an
  empty retired interface. Delete its storage layout snapshot.

### 2. The receipt contract authorizes submitters through the IC policy

- **Severity:** Medium.
- `ConsensusRecommendationReceipt.recordReceipt` checks
  `COMMITTEE_AGENT_ROLE` on the IC policy. The receipt has no role of its own.
- **Fix:** add `RECEIPT_SUBMITTER_ROLE`, administered by `ADMIN_ROLE`. The
  submitter is `msg.sender`.

### 3. The receipt contract is gateway-only

- **Severity:** Medium.
- `recordReceipt` is `onlyGateway`. The initializer takes the gateway and the
  IC policy.
- **Fix:** drop `onlyGateway` and both initializer arguments. Keep the two
  storage slots as retired.

### 4. The gateway still routes committee and receipt writes

- **Severity:** Low.
- `RobotMoneyGateway` carries `setICPolicy`, `committeeRegister`,
  `committeeVoteSubmit`, `setConsensusReceipt` and `consensusRecordReceipt`.
  The deploy grants the gateway `ADMIN_ROLE` on the IC policy.
- **Fix:** delete the five entrypoints, their events and errors, and their
  `IGateway` entries. Keep the two storage slots as retired.

### 5. The deploy stage pairs the IC policy with the receipt

- **Severity:** Low.
- The `ic-policy` stage (`DeployInvestmentCommitteePolicy.s.sol`, manifest
  `ic-policy.json`) deploys both contracts and wires both to the gateway.
- **Fix:** a `receipt` stage that deploys the receipt alone, manifest
  `receipt.json`.

### 6. The timelock handover requires the IC policy

- **Severity:** Low.
- `DeployTimelock` requires `IC_POLICY_ADDRESS` and hands the IC policy's
  roles to the timelock.
- **Fix:** drop the input and the IC handover. Keep `CONSENSUS_RECEIPT_ADDRESS`.

### 7. The govern rows route the submitter through the gateway

- **Severity:** Low.
- `register-committee` authorizes the submitter Safe on the gateway, sets a
  gateway policy and calls `committeeRegister`. `record-receipt` sends
  `consensusRecordReceipt` to the gateway.
- **Fix:** a `register-submitter` row that schedules one
  `grantRole(RECEIPT_SUBMITTER_ROLE, submitter)` on the receipt.
  `record-receipt` calls `recordReceipt` on the receipt directly.

### 8. rmpc still has committee writes

- **Severity:** Low.
- `rmpc committee vote-submit` and `check-agent` exist, with an
  `ic_policy_address` config field and IC errors. `rmpc receipt submit` sends
  to the gateway.
- **Fix:** delete the committee command. `receipt submit` records on the
  receipt contract after checking `RECEIPT_SUBMITTER_ROLE`. Keep
  `committee-identity`, the off-chain Ed25519 receipt signer.

### 9. The indexer and explorer API serve committee and regime data

- **Severity:** Low.
- The indexer decodes IC events and fills the committee and regime tables.
  The explorer API serves `/v1/committee/*` and `/v1/regime/feed`.
- **Fix:** remove the decoding, the input and the endpoints. Add one new
  migration that drops the tables. Never edit an existing migration.

### 10. The dapp ships committee and regime-feed components

- **Severity:** Info.
- `CommitteePanel`, `CommitteeAccountLayer`, `VoteSubmitPreview`,
  `RegimeFeedPanel` and `committeeApi.ts` remain.
- **Fix:** delete them and their tests.

### 11. The swarm plugin forms and submits tilts

- **Severity:** Info.
- `plugins/robotmoney-swarm` and its CI suite drive tilt submission.
- **Fix:** delete the plugin and its suite. Keep the `robotmoney-committee`
  URL stub, reworded.
- **Risk:** robotmoney-frontend still ships the swarm skill URL, and
  `scripts/check-skill-url-reachability.sh` monitors it. Deleting the plugin
  breaks that URL. Tell the frontend team before the plugin is deleted.

### 12. Tests and checks still cover the IC policy

- **Severity:** Info.
- Five Foundry test files exist only for the IC policy. The committee vote
  schema check, the explorer committee job and the CI test-count floors count
  committee tests.
- **Fix:** delete or rework the tests. Remove the schema check. Reset the
  floors to the new real counts.

### 13. The rehearsal deploy runbook still runs the committee steps

- **Severity:** Low.
- `docs/runbooks/contract-qa/template.yaml` still describes the old flow:
  - P1.02 publishes the `gateway` and `ic-policy` stages in the vaults run.
  - P2.01 verifies both systems.
  - P3.04 and P3.05 run `govern --row register-committee`, which authorizes
    the submitter Safe on the gateway, sets a gateway policy and calls
    `committeeRegister`.
  - P5.02 records the receipt through the gateway.
- These steps match today's tooling. They stay until the tooling changes,
  because the runbook's commands must exist (finding 14).
- **Fix, in the PR that lands findings 5 to 7:**
  - P1.02 publishes the `receipt` stage and no gateway.
  - P2.01 and P4.01 verify only vaults-system contracts.
  - P3.04 and P3.05 become `register-submitter-schedule` and
    `register-submitter-execute`: one timelock
    `grantRole(RECEIPT_SUBMITTER_ROLE, submitter Safe)` on the receipt, read
    back after the delay.
  - P5.02 calls `recordReceipt` on the receipt directly.

### 14. The runbook validator cannot retire a template step

- **Severity:** Low.
- `scripts/runbook/validate-contract-qa.ts`, run by suite 13, requires each
  `releases/<release>.yaml` to hold every template step unchanged and in
  order. A release may only add steps (`docs/runbooks/contract-qa/README.md`).
  Any edit to a template step therefore invalidates `releases/v0.4.0.yaml`
  and `releases/v0.5.0.yaml`, which are records that must not change.
- **Effect:** finding 13 cannot be fixed without changing the validator.
  Checked 2026-10-19: editing the five steps produced 16 validator errors.
- **Fix:** let each release file pin the template version it ran with, for
  example the core commit of the template. The validator then checks a
  release against its pinned template, and the template can evolve.
