# System split review: code that couples the vaults system to the gateway (2026-10-19)

## Scope and pinned commits

- **Repository:** `robotmoney/robotmoney-monorepo`.
- **Commits checked:** release v0.5.0 at core `57fbe618` (tag
  `release/v0.5.0-rehearsal`, the Deploy 3 SHA, rc.9, on branch
  `releases-0.5.x`) and `dev` at `e362df0c`. Every finding below holds at
  both.
- **Reviewed at:** 2026-10-19.
- **Design under test:** the owner decision of 2026-10-19 that the vaults
  system and the rmpc gateway system are separate systems
  (`docs/architecture.md` §1, `docs/prd.md` §"Product Systems"). The
  dependency rule says the gateway depends on the vaults system and never
  the reverse. Invariants `SYS-1` and `SYS-2` in
  `docs/technical/smart-contract-invariants.md` §0 state it.
- **Method:** read the contracts, deploy scripts, publish-contracts stage
  table, indexer and test harness. Compile and test runs were not part of
  this review.
- **Out of scope:** the gateway's own agent-permission logic, which this
  review does not change.

## Headline verdict

The code does not meet the dependency rule. The committee and receipt
contracts accept writes only from the gateway. Committee members and the
receipt submitter must hold gateway roles. The deploy, the indexer and the
test stacks treat the two systems as one. A receipt cannot reach router
weights without a deployed gateway.

One finding is a trap for the fix itself. The check that binds a committee
vote to its caller lives only in the gateway. Removing `onlyGateway` from
the IC policy without moving that check first would let any registered
member file votes under another member's address.

Until the code changes, operators run the gateway-routed procedures in
`docs/technical/consensus-receipt-submitter-runbook.md`,
`docs/technical/router-governance-handoff-runbook.md` and
`docs/operations/contract-release-runbooks.md` §4.3.

## Findings

### 1. The receipt contract accepts writes only from the gateway

- **Severity:** Medium. **Violates:** `SYS-1`.
- `ConsensusRecommendationReceipt.recordReceipt` is `onlyGateway`. The
  gateway address is set once at initialization with no setter.
- **Effect:** no receipt can be recorded with no gateway deployed. A new
  gateway forces a new receipt contract.
- **Fix:** `recordReceipt` takes the submitter as `msg.sender`. It checks
  `COMMITTEE_AGENT_ROLE` on the IC policy. The gateway argument goes away.

### 2. The IC policy takes the gateway and accepts votes only from it

- **Severity:** Medium. **Violates:** `SYS-1`.
- `InvestmentCommitteePolicy` stores the gateway at initialization.
  `submitVote` is `onlyGateway`.
- **Effect:** no committee vote can be cast with no gateway deployed.
- **Fix:** drop the gateway field and the modifier. Land finding 3 first.

### 3. Only the gateway binds a committee vote to its caller

- **Severity:** Medium. **Violates:** `SYS-2` once finding 2 is fixed.
- `RobotMoneyGateway.committeeVoteSubmit` reverts `CommitteeAgentNotCaller`
  unless `p.agent == msg.sender` (issue 1790). `submitVote` checks only
  that `p.agent` holds `COMMITTEE_AGENT_ROLE`. It trusts `p.agent` as
  given.
- **Effect today:** none, because `onlyGateway` forces every vote through
  the gateway check.
- **Effect after a naive fix:** any registered member can file votes under
  another member's address. That is the impersonation bug issue 1790
  closed.
- **Fix:** `submitVote` reverts unless `p.agent == msg.sender`. Add a
  failing test before removing `onlyGateway`.

### 4. Committee writes route through gateway entrypoints

- **Severity:** Low. **Violates:** `SYS-1`.
- `RobotMoneyGateway` carries `setICPolicy`, `setConsensusReceipt`,
  `committeeRegister`, `committeeVoteSubmit` and `consensusRecordReceipt`.
  The IC policy deploy grants the gateway `ADMIN_ROLE` on the IC policy so
  `committeeRegister` can call `registerAgent`. The timelock handover
  leaves that grant in place.
- **Fix:** remove the five entrypoints. The Safe registers agents on the
  IC policy through the timelock. Revoke the gateway's IC policy role.

### 5. Committee members and the submitter need gateway roles

- **Severity:** Low. **Violates:** `SYS-1`.
- `committeeVoteSubmit` and `consensusRecordReceipt` require `AGENT_ROLE`
  on the gateway. The `register-committee` govern row therefore authorizes
  the submitter Safe on the gateway and sets a minimal gateway policy for
  it.
- **Fix:** follows from findings 1, 2 and 4. The govern row then grants
  only `COMMITTEE_AGENT_ROLE`.

### 6. The committee contracts live under `contracts/gateway/`

- **Severity:** Info. **Violates:** `SYS-1` static guard.
- `InvestmentCommitteePolicy.sol`, `ConsensusRecommendationReceipt.sol` and
  their interfaces sit in `contracts/gateway/`. `RouterGovernance` imports
  `contracts/gateway/interfaces/IConsensusRecommendationReceipt.sol`.
- **Fix:** move them out of `contracts/gateway/`. Proxy storage is
  unaffected by a file move.

### 7. One deploy run, one handover and one verify cover both systems

- **Severity:** Low. **Violates:** the separate-deploy rule.
- The publish-contracts stage table deploys the gateway at stage 5. Stage 7
  binds the IC policy and receipt to it. Stage 11 (`DeployTimelock`) hands
  both systems to one timelock, gateway agents included. One verify checks
  both.
- **Fix:** a vaults-system stage table with no gateway stage. A separate
  gateway run that reads the vaults-system manifests. Gateway governance is
  an open decision (`docs/architecture.md` §10).

### 8. The explorer indexer requires a gateway address

- **Severity:** Low.
- `services/explorer-indexer` refuses to start without `INDEXER_GATEWAY`
  unless `--migrate-only`. It cannot index a vaults-only deployment.
- **Fix:** make the gateway address optional. Keep gateway tables empty
  when it is absent.

### 9. The test stacks run both systems together

- **Severity:** Low.
- The smoke-test fixture requires a gateway address. The stage-host stack
  and the Twin rehearsal (suite 28) deploy both systems in one run.
- **Fix:** a vaults-only rehearsal that records a receipt, applies it and
  sets default weights with no gateway deployed. A separate gateway
  rehearsal.

### 10. `SYS-1` and `SYS-2` have no registry entry or test

- **Severity:** Info.
- Neither ID has an `InvariantRegistry` entry. Both are written without
  the heading form so `CoverageMap.t.sol` does not fail.
- **Fix:** add each registry entry with a red test in the PR that fixes it.

## Open decision raised by this review

**Committee write pins.** Today `rmpc committee vote-submit` and
`rmpc receipt submit` sign to the gateway, so they check the gateway
implementation pin. Once they call the committee contracts directly, no
pin covers those proxies in the signing path. Recorded in
`docs/architecture.md` §10.
