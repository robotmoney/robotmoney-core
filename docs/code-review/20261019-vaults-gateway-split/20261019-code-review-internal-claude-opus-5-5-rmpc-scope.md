# rmpc scope review: code that still gives rmpc and the gateway deprecated jobs (2026-10-19)

## Scope and pinned commits

- **Repository:** `robotmoney/robotmoney-core`.
- **Commits checked:** release v0.5.0 at core `57fbe618` (tag
  `release/v0.5.0-rehearsal`, branch `releases-0.5.x`) and `dev` at
  `e362df0c`.
- **Reviewed at:** 2026-10-19. Findings 10 to 15 added 2026-10-20. Findings
  1, 2, 5, 6, 9, 10, 11 and 12 corrected 2026-10-20 after an adversarial check
  against the code.
- **Design under test:** the owner rule of 2026-10-19, extended 2026-10-20.
  `rmpc` is an agentic cryptographic signer for end users. Its uses are
  off-chain: signing, keystores, the `committee-identity` Ed25519 signer,
  config export, offline `receipt verify`, and reads that send no
  transaction. Its one on-chain write is an agent deposit into a vault
  through `RobotMoneyGateway`, under the depositor's policy. The gateway
  exists for that deposit. Everything else is deprecated
  (`docs/architecture.md` §1, §5.1, §5.2).
- **Owner decisions of 2026-10-20:**
  - No system admin can revoke a depositor or an agent.
    `revokeRole(AGENT_ROLE, x)` reverts for every caller.
  - An agent may revoke itself. An expired policy frees the address: the
    owner link is cleared, or the address can be registered again.
  - An unused consent commitment expires after `COMMIT_EXPIRY_BLOCKS`.
  - Receipts go on-chain only through the submitter Safe, by the
    publish-contracts `record-receipt` row, on every chain. Base production
    included.
  - The submitter Safe and the governing Safe may share owners. This review
    asserts no separation between them.
- **Method:** read the gateway, rmpc, the dapp, the indexer, the plugins, the
  fusion scripts and CI. Compile and test runs were not part of this review.
- **Correctness follow-up (2026-10-20):** checked canon and code at
  `48923e37`, extending findings 5, 12 and 15, qualifying finding 14 and
  adding findings 16 and 17. The three targeted gateway tests for admin
  authorization, arbitrary admin share receivers and transfer to an admin
  passed. All 18 receipt-submission tests passed; they preserve the old
  behavior rather than prove conformance to the target. Findings 16 and 17
  are source-traced gaps, not newly executed exploit reproductions. This
  review does not establish that all migration or security issues are found.
- **Second correctness follow-up (2026-10-20):** extends findings 12 and 15
  with consent ordering and the dapp's empty destination lists, clarifies
  event preservation in finding 13, and adds registration identity in
  finding 18. These are source-traced at `48923e37`; dapp tests could not run
  because Vitest is not installed. The canonical credential and explorer
  ADRs are amended alongside this review; their superseded text is not an
  alternative implementation target.
- **Related:** `20261019-code-review-internal-claude-opus-5-5-ic-policy-removal.md`
  covers the committee writes (`rmpc committee`, the IC policy) and is not
  repeated here.

## Headline verdict

The code gives rmpc and the gateway four on-chain jobs beyond a vault deposit:
router deposits, single-vault withdrawals, router withdrawals and receipt
recording. Each one has contract code, client commands, tests, CI, plugin
text and dapp or indexer surfaces. None is needed for the vault deposit.
Beyond those four jobs, the gateway gives admins three powers over agents that
the design denies: registering one, revoking one and owning one. It also
denies an agent the exit the design grants it. The governance deploy gives
`RouterGovernance` the receipt's `ADMIN_ROLE`, and the gateway pins one
vault and the router at initialization. The legacy deposit bypasses the
destination policy, and receipt recording can skip payload-byte checks.
Eighteen findings: seven Medium, eight Low, three Info.

## Findings

### 1. The gateway still carries agent withdrawals

- **Severity:** Medium.
- `RobotMoneyGateway.withdraw` and `RobotMoneyGateway.withdrawFromRouter`
  ship, with withdraw windows, withdraw caps and asset recipient fields in
  the agent policy (`contracts/gateway/RobotMoneyGateway.sol`,
  `contracts/gateway/interfaces/IGateway.sol`).
- **Effect:** agent withdrawal remains callable, contrary to the deposit-only
  design. The single-vault path pulls shares from the agent, not an arbitrary
  depositor (`RobotMoneyGateway.sol:1109`). The router path pulls from the
  policy's share receiver and requires its allowance. This is a scope
  violation; it does not demonstrate withdrawal without holder approval.
- **Fix:** remove both functions. The four withdraw fields of the
  `AgentPolicy` struct stay: `assetRecipient`, `maxWithdrawPerPayment`,
  `maxWithdrawPerWindow` and `allowedSourceVaults`
  (`contracts/gateway/interfaces/IGateway.sol:67-70`). The struct is stored
  in proxy storage. The layout gate
  (`scripts/ci/check-core-storage-layout.sh`) rejects a struct member
  removal. Only the validation that reads them and the withdraw code go. The
  ABI tuple keeps the four fields. Callers pass zero values.
- **Still open in `_validatePolicy`:** the validator accepts non-zero
  withdraw fields today (`RobotMoneyGateway.sol:633-639` checks the
  recipient and the window cap when `maxWithdrawPerPayment > 0`). The
  target rejects any non-zero value in the four retired fields (owner
  decision 2026-10-20), so a policy that still asks for a withdrawal cannot
  be stored.

### 2. The gateway still deposits into the Portfolio Router

- **Severity:** Low.
- `RobotMoneyGateway.depositTo` has a router branch. The gateway holds the
  router in proxy storage, set once in `initialize`:
  `IPortfolioRouter public routerContract;`
  (`contracts/gateway/RobotMoneyGateway.sol:213`, written at line 408).
- **Fix:** an agent deposit targets an allowed vault only. Drop the router
  branch. The `routerContract` slot cannot be dropped. It stays as a retired
  slot, kept at its position by the layout gate.

### 3. rmpc still sends withdrawals

- **Severity:** Medium.
- `rmpc withdraw` and `rmpc withdraw-router` build, sign and send gateway
  withdrawals (`clients/rust-payment-client/src/cli.rs`,
  `src/commands/withdraw.rs`, `src/commands/withdraw_router.rs`), with their
  errors (`ErrWithdrawCapExceeded` and others), floors and replay handling.
- **Fix:** delete both commands, their errors and their tests
  (`tests/cli_withdraw.rs`, `tests/cli_withdraw_router.rs`).

### 4. rmpc still deposits into the router

- **Severity:** Low.
- `rmpc deposit` accepts a router destination.
- **Fix:** `deposit` targets a vault only.

### 5. rmpc still records receipts on-chain

- **Severity:** Low.
- `rmpc receipt submit` (`clients/rust-payment-client/src/commands/receipt.rs`)
  sends a receipt record transaction. The fusion receipt worker
  (`scripts/fusion/submit-receipt-worker.sh`) records through it.
- The publish-contracts `record-receipt` verb refuses Base production
  (`publish-contracts/src/cli.ts:617`):
  `record-receipt is refused on this chain in production: production records receipts with 'rmpc receipt submit' and an HSM or KMS signer.`
  The usage text at line 62 says the same. That is the reverse of the owner
  decision. The decision names the submitter Safe through `record-receipt`
  as the only path, on every chain.
- **Fix:** keep `rmpc receipt verify`, which is offline. Delete `receipt
  submit`. Lift both production refusals: `cli.ts:617` and the independent
  guard in `publish-contracts/src/record-receipt.ts:165-166`. Changing only
  the CLI still leaves the implementation refusing Base production.
  Require Safe mode on every chain: the CLI requires `--submitter` only
  on Base (`cli.ts:619`), and `recordReceipt` still accepts a dedicated EOA
  elsewhere (`record-receipt.ts:170,188-195`). Reject a missing submitter
  Safe before loading any signer, at both entrypoints. Reword the usage
  text and update tests that currently require the old behavior.
  The fusion worker hands its payload to the Safe flow instead of calling
  rmpc. Payload verification is a separate gap (finding 17).

### 6. The dapp still carries agent withdraw and router paths

- **Severity:** Low.
- `clients/dapp/src/lib/configExport.ts` names withdraw only in TOML comment
  strings (lines 51, 52, 74, 158, for example
  `# Software keystore: rmpc deposit, withdraw and withdraw-router sign with it on every`).
  It exports no withdraw field.
- `clients/dapp/src/lib/preview.ts` carries the agent paths: the
  `AgentPolicy` type with its withdraw recipient (line 64), the
  `authorizeAgent` preview (line 75) and the router destination note
  (line 62).
- `DepositWithdrawTab.tsx`, `routerPreview.ts` and `productReasonCode.ts`
  are human-wallet surfaces. They stay.
- **Fix:** drop the withdraw and router comment lines from the TOML export.
  Update agent-policy preview descriptions to show deposit-only authority
  and retire the `authorizeAgent` preview with finding 10. Keep the policy
  ABI tuple's retired fields with zero values (finding 1). Human wallet deposits,
  withdrawals and redeems remain supported; their shared gateway
  verification dependency must be removed (system split finding 11).

### 7. The indexer still decodes agent withdrawals

- **Severity:** Info.
- `services/explorer-indexer/src/{abi,indexer,schema}.rs` decode gateway
  withdrawal events.
- **Fix:** stop decoding them. Any table change goes in a new migration.

### 8. The plugins still teach withdrawals and receipt submission

- **Severity:** Low.
- `plugins/robotmoney-user` and `plugins/robotmoney-cli` skills and
  references describe `withdraw`, `withdraw-router`, router deposits and
  `receipt submit` (`plugins/robotmoney-user/skills/robotmoney-user/SKILL.md`,
  `references/write.md`, `references/safety.md`,
  `plugins/robotmoney-cli/skills/robotmoney-cli/SKILL.md`,
  `references/commands.md`).
- **Fix:** describe the vault deposit and the off-chain uses only.

### 9. Tests, invariants and CI still cover the deprecated paths

- **Severity:** Info.
- Gateway withdrawal and router tests (`GatewayRouter.t.sol`,
  `RobotMoneyGateway.t.sol`, `RedeemGasGuards.t.sol`, `CoreStagesFork.t.sol`
  and others) and `test_GW5_agentRedeemCarriesRealFloor` in
  `contracts/test/fv/FvInvariants.t.sol:710` remain. `InvariantRegistry`
  still lists GW-5 (`contracts/test/fv/InvariantRegistry.sol:112`), which
  the docs retire. Suite 07 runs `cli_withdraw` and `cli_withdraw_router`
  (`.github/workflows/suite-07-rmpc-integration.yml:356-357`).
- **Fix:** delete or rework the tests. Give GW-5 a tombstone status in the
  registry. The registry `Status` enum has only `HOLDS` and `RED`
  (`InvariantRegistry.sol:36-38`). `CoverageMap.t.sol` counts every
  `> **\`ID\`` heading in the spec against the registry entries. A third
  status needs that test updated in the same PR. Drop the suite 07 steps.

### 10. An admin can register, grant or revoke an agent without its consent

- **Severity:** Medium.
- **Design:** commit and reveal is the only way to register an agent. No role
  can register one without the agent's consent. No system admin can revoke a
  depositor or an agent (owner decisions 2026-10-20, `docs/architecture.md`
  §6).
- **Code:**
  - `RobotMoneyGateway.authorizeAgent` lets an `ADMIN_ROLE` holder register
    any address in one transaction
    (`contracts/gateway/RobotMoneyGateway.sol:551`). It skips the agent
    consent check (issue 1791). It may name any share receiver. The admin
    becomes the agent's owner.
  - `initialize` writes `_setRoleAdmin(AGENT_ROLE, ADMIN_ROLE);`
    (`RobotMoneyGateway.sol:418`). The role admin lives in proxy storage. An
    admin can therefore call `grantRole(AGENT_ROLE, x)` directly.
  - The same role admin lets an admin call `revokeRole(AGENT_ROLE, x)`. The
    `_revokeRole` override (`RobotMoneyGateway.sol:363-375`) only floors the
    `ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` counts. It does not refuse
    `AGENT_ROLE`. An admin can strip any agent.
  - `renounceRole(AGENT_ROLE, agent)` is a third path. OpenZeppelin's
    `renounceRole` lets the holder drop the role itself. It calls the
    internal `_revokeRole` only, so `agents[agent]` and `agentOwner[agent]`
    stay set while the role is gone: a half-revoked agent the owner link
    still claims.
  - Removing the `_setRoleAdmin(AGENT_ROLE, ADMIN_ROLE)` line is no fix. A
    role whose admin is never set falls back to `DEFAULT_ADMIN_ROLE`, whose
    holder can then grant it. Only an override closes the path.
- **Risk:** a compromised or mistaken admin can create agents that deposit
  under a policy the admin wrote. The same admin can cut off any depositor's
  agent. End users never need any of the three paths.
- **Where it lives:**
  - Contracts: `RobotMoneyGateway.sol`, `IGateway.sol`, `AccessRoles.sol`
    comments, `DeployTimelock.s.sol` comments.
  - Tests: `RobotMoneyGateway.t.sol`, `GatewayAgentPolicyAuthorization.t.sol`,
    `ConfusedDeputyGuards.t.sol`, `contracts/test/fv/DeployAssertions.t.sol`,
    `helpers/CoreStages.sol` and about ten more that use `authorizeAgent` for
    setup.
  - Dapp: the Rotation tab `authorizeAgent` button (`RotationTab.tsx`,
    `useRotationState.ts`, `rotation.ts`), the `authorizeAgent` preview
    (`preview.ts`, `credentialWorkflow.ts`), `onboardingSeed.ts`, the ABIs.
  - Clients: the selector check in `rust-payment-client/src/gateway/mod.rs`,
    the decode-only entry in `publish-contracts/src/committee-register.ts:39`,
    `explorer-api/src/model.rs`.
  - Invariants text in `docs/technical/smart-contract-invariants.md` (the
    validator writer list) and the generated contract docs.
- **Fix:**
  - Delete `authorizeAgent` from the gateway and `IGateway`.
  - Override `grantRole`, `revokeRole` and `renounceRole` to revert for
    `AGENT_ROLE`, for every caller (owner decision 2026-10-20: the role is
    ungrantable and unrevokable by any role). All three are `public virtual`
    in OpenZeppelin `AccessControlUpgradeable`. Do not override `_grantRole`
    or `_revokeRole` for this: `revealAuthorization` grants through the
    internal `_grantRole`, and `revokeAgent` revokes through the internal
    `_revokeRole`. An internal override would break both. The role admin is
    proxy storage written by `initialize`, so a live proxy keeps it. The
    override is what makes it harmless.
  - `revokeAgent` stays the only revoke path. Finding 12 widens its callers.
  - Move test setup to commit and reveal. Delete the dapp button and preview.
  - This adds no storage, so the layout gate is unaffected.

### 11. An admin may name any share receiver and can be handed agents

- **Severity:** Medium.
- **Design:** the share receiver is always the agent's owner, for every
  caller. An agent's owner never changes. No protocol role owns an agent
  (owner decision 2026-10-20, `docs/architecture.md` §6, invariant `ACL-9`).
- **Code:**
  - `_validatePolicy` skips the share receiver check when the caller holds
    `ADMIN_ROLE` (`RobotMoneyGateway.sol`, `ShareReceiverNotAuthorized`). An
    admin can reach it through its own commit and reveal, even without
    `authorizeAgent`.
  - `transferAgentOwnership` (`RobotMoneyGateway.sol:589`) moves an agent to
    any `ADMIN_ROLE` holder (`NewAgentOwnerNotAdmin` otherwise). It keeps
    the stored policy and its share receiver.
  - `DeployTimelock` reads `AGENT_ADDRESSES`
    (`contracts/script/DeployTimelock.s.sol:245`) and transfers each listed
    agent to the timelock. The manifest records
    `roles.gateway_agents_listed_count`,
    `roles.deployer_owns_a_listed_gateway_agent` and `timelock_owned_agents`.
  - `publish-contracts/src/committee-register.ts` is a live caller. Its
    register batch does `commitAuthorization`, then `revealAuthorization`,
    then `transferAgentOwnership(submitter, timelock)` (lines 102 to 104).
    The timelock owns the submitter agent from then on.
- **Risk:** a timelock-owned agent's policy can be rewritten by a timelock
  proposal to send its future deposits' shares to any address. Neither path
  has a use once the deploy authorizes no agent.
- **Where it lives:**
  - Contracts: `RobotMoneyGateway.sol` (`_validatePolicy`,
    `transferAgentOwnership`, `AgentOwnershipTransferred`), `IGateway.sol`,
    `DeployTimelock.s.sol` (`AGENT_ADDRESSES` and the agent handover).
  - Tests: `GatewayAgentPolicyAuthorization.t.sol`
    (`test_transferAgentOwnership_*`, the admin share receiver cases),
    `DeployTimelock.t.sol::DeployTimelockAgentHandoverTest`,
    `SafeIntegration.t.sol::test_handover_noDeployerOwnedAgentRemains`.
  - Tooling: the publish-contracts timelock stage (`AGENT_ADDRESSES`, a
    literal `none` in `publish-contracts/src/core-wiring.ts:80`), the
    committee register batch (`committee-register.ts:104`), the agent
    derivation (`publish-contracts/src/ops/derive-agents.ts`, which scans
    `AgentAuthorized` and `AgentOwnershipTransferred` logs), and the four
    verifier checks in `AGENT_LABELS`
    (`publish-contracts/src/verify/index.ts:869-874`):
    `agents: no agent authorized at handover`,
    `agents: manifest lists zero agents`,
    `agents: no address holds AGENT_ROLE after handover`,
    `agents: manifest says deployer owns no listed agent`.
  - Indexer and API: `AgentOwnershipTransferred` decoding and the owner
    column (`services/explorer-indexer`, `clients/explorer-api`).
  - `InvariantRegistry` still lists ACL-4 and ACL-8
    (`contracts/test/fv/InvariantRegistry.sol:83,89`), which the docs retire.
- **Fix:**
  - Require `shareReceiver == msg.sender` in `_validatePolicy` for every
    caller.
  - Delete `transferAgentOwnership`, its event and `NewAgentOwnerNotAdmin`.
    The committee register batch loses its hand-over step. That batch is
    deleted with the IC policy (IC-1019 finding 7).
  - Drop `AGENT_ADDRESSES` and the agent handover from `DeployTimelock` and
    the timelock stage. Keep the first and third `AGENT_LABELS` checks,
    which read the chain. The second and fourth read manifest fields that
    `core-wiring.ts:120` and `verify/index.ts:891,899` require. Dropping the
    fields breaks verify of `deployments/8453/deploy-2/timelock.json`. Keep
    those two checks reading the old manifests as optional, or version the
    manifest.
  - Give ACL-4 and ACL-8 tombstone status in the registry. The registry
    `Status` enum has only `HOLDS` and `RED`
    (`contracts/test/fv/InvariantRegistry.sol:36-38`). `CoverageMap.t.sol`
    counts `> **\`ID\`` headings against registry entries. A third status
    needs the CoverageMap test updated in the same PR. Add ACL-9 with a red
    test.
  - This adds no storage, so the layout gate is unaffected.

### 12. No self-revoke and no graceful expiry

- **Severity:** Medium.
- **Design:** an agent may revoke itself. An expired policy frees the
  address. An unused consent commitment expires after
  `COMMIT_EXPIRY_BLOCKS` (owner decisions 2026-10-20).
- **Code:**
  - `revokeAgent` is owner-only (`contracts/gateway/RobotMoneyGateway.sol:603-606`):
    `if (owner != msg.sender) revert NotAgentOwner();`
    The agent itself cannot call it.
  - A policy past `validUntil` only blocks deposits (`AgentPolicyExpired`,
    `RobotMoneyGateway.sol:696`). `agentOwner[agent]` stays set. A new
    registration of the same address reverts in `_authorizeAgentInternal`
    (`RobotMoneyGateway.sol:559`):
    `if (agentOwner[agent] != address(0)) revert AgentAlreadyOwned();`
    The agent is stuck with its old owner until that owner revokes it.
  - The step-7 consent check in `revealAuthorization`
    (`RobotMoneyGateway.sol:537-547`) reads
    `commitments[ck].committer != agent`. It has no expiry check. The step-4
    expiry at line 526 covers the owner's commitment only. A consent an
    agent made long ago still passes. The consent is consumed on reveal
    (`delete commitments[ck];`, line 546), so it does not survive a reveal
    or a later revoke.
  - The dapp sends the owner's commitment before requesting agent consent:
    `AuthorizeTab.tsx:137-155` advances to reveal, where lines 192-205 show
    `AgentConsentNotice`. `OnboardingWizard.tsx:552-584` has the same order.
    The headless setup also sends the owner commit before the agent consent
    (`.github/workflows/suite-11b-opencode-headless.yml:402-411`). Canon
    requires agent consent first, then owner commit, then reveal. This is a
    workflow mismatch; the current on-chain consent requirement is not
    thereby bypassed.
  - `revokeAgent` deletes `agents[agent]` and `agentOwner[agent]` only
    (`RobotMoneyGateway.sol:608-609`). It does not reset
    `_depositWindow[agent]` (line 309). An address registered again inside
    the window inherits the old agent's spent deposit budget.
  - Expiry frees nothing on reveal. `_authorizeAgentInternal` reads only
    `agentOwner[agent] != address(0)` (line 559), never `validUntil`, so a
    reveal for an address whose policy has lapsed still reverts
    `AgentAlreadyOwned`.
  - `setPolicy` (`RobotMoneyGateway.sol:576-581`) checks the owner and
    validates the replacement policy, but never checks the existing
    policy's expiry. After expiry the old owner can reactivate the agent
    without fresh agent consent. Architecture §5.2 and invariant ACL-9
    require the old owner's `setPolicy` after expiry to revert.
- **Risk:** an agent cannot leave a depositor it no longer trusts. A key
  owner cannot re-register an address after the old policy lapses. A stale
  consent lets the owner bind the agent to a policy the agent agreed to
  under conditions that have changed.
- **Fix:**
  - `revokeAgent` accepts `msg.sender == agent` as well as the owner.
  - `_authorizeAgentInternal` treats an owner link whose policy has expired
    (`agents[agent].validUntil < block.timestamp`) as free: the reveal
    clears the old link and the old windows, emits `AgentRevoked(old)`,
    then stores the new policy. `setPolicy` first rejects an expired
    existing registration, before validating the replacement. The accepted
    renewal race does not authorize renewal after expiry; an owner may
    extend a still-live policy before another registration becomes possible.
  - `revokeAgent` also deletes `_depositWindow[agent]`, so a re-registered
    address starts with a fresh budget.
  - The step-7 check rejects a consent whose `blockNumber` is older than
    `COMMIT_EXPIRY_BLOCKS`, with the same rule as step 4.
  - Build and freeze the exact agent, owner, salt and policy before asking
    the agent to commit consent. For distinct agent and owner keys, confirm
    that consent on-chain before enabling the owner's commit; reveal only
    while both commitments are live. Editing the bound inputs requires a
    fresh consent. Apply the sequence to Authorize, onboarding, rotation
    and headless setup. A self-registration consents by calling and needs
    no separate agent consent transaction.
  - The consent is an on-chain `commitAuthorization` commitment over
    `keccak256(abi.encode(owner, keccak256(revealCalldata)))`; the reveal has
    three arguments. The credential ADR's former EIP-712 `AgentConsent`,
    nonce and `rmpc agent-consent` instructions were stale and are replaced
    by the 2026-10-20 amendment. Do not reintroduce that signature flow.
  - These add no storage. The layout gate is unaffected. Add red tests for
    each rule in `GatewayAgentPolicyAuthorization.t.sol`.

### 13. Surfaces the findings above do not list

- **Severity:** Info.
- Each of these is a file the fix PRs must touch. None changes the verdict.
  - `publish-contracts/src/ops/derive-agents.ts:5-21` and
    `publish-contracts/src/ops/cli.ts:20-21` derive the deployer's agents
    from `AgentAuthorized` and `AgentOwnershipTransferred` logs. Retire the
    deployer-agent derivation with findings 10 and 11. Preserve
    `AgentAuthorized`: reveal and policy updates still emit it, and the
    handover verifier still checks its absence before handover. Only
    `AgentOwnershipTransferred` is removed from the target gateway ABI;
    historical replay of older deployments must retain its interpretation.
  - `publish-contracts/src/core-wiring.ts:120` and
    `publish-contracts/src/verify/index.ts:891,899` require the manifest
    fields `gateway_agents_listed_count` and
    `deployer_owns_a_listed_gateway_agent`. Dropping them breaks verify of
    `deployments/8453/deploy-2/timelock.json` (finding 11).
  - `publish-contracts/src/core-wiring.ts:80` wires `AGENT_ADDRESSES` as the
    literal `none`. `publish-contracts/src/sheet.ts:91` refuses it as a
    typed sheet value.
  - `.github/workflows/suite-07-rmpc-integration.yml:356-357` runs `cli_withdraw` and
    `cli_withdraw_router`. Line 411 holds the executed floor
    `{ binary: withdraw, min_executed: 4 }`. Both go with finding 3.
  - `.github/workflows/suite-05-fork-integration.yml:128` asserts
    `deposit_router_default_gas_clears_gateway_floor` passed. It goes with
    finding 2.
  - `clients/dapp/src/lib/commitReveal.ts:75` documents its tuple as
    `the same address normalisation authorizeAgent uses`. The comment goes
    with finding 10. The tuple stays, because the struct keeps its fields
    (finding 1).

### 14. `RouterGovernance` holds the receipt's `ADMIN_ROLE`

- **Severity:** Low.
- **Design:** the timelock holds the receipt contract's `ADMIN_ROLE` and
  alone grants or revokes `RECEIPT_SUBMITTER_ROLE`. `RouterGovernance`
  needs only to release the receipt it applies (owner decision 2026-10-20).
- **Code:**
  - `DeployRouterGovernance.s.sol` grants the deployed `RouterGovernance`
    the receipt register's `ADMIN_ROLE`
    (`contracts/script/DeployRouterGovernance.s.sol:26` in the header,
    `RECEIPT_ADMIN_ROLE` at line 50).
  - `releaseReceipt` currently requires `ADMIN_ROLE`
    (`contracts/gateway/ConsensusRecommendationReceipt.sol:182`).
  - Today's receipt has no `RECEIPT_SUBMITTER_ROLE`; its membership check
    is on the IC policy. Today's `RouterGovernance` has no arbitrary-call
    or submitter-grant entrypoint. Holding a role is not itself evidence
    of a reachable grant call.
- **Risk:** the deployed role assignment conflicts with the target boundary.
  Once IC removal adds a submitter role administered by `ADMIN_ROLE`,
  retaining the governance contract's admin grant would give that address
  broader authority than release alone. This is a migration hazard, not
  a demonstrated ability of today's governance code to register submitters.
- **Fix:** add a narrow release role on `ConsensusRecommendationReceipt`
  (for example `RECEIPT_RELEASER_ROLE`, admin `ADMIN_ROLE`), gate
  `releaseReceipt` on it, grant it to `RouterGovernance` in the governance
  stage, and grant `ADMIN_ROLE` to the timelock only. The rotation batch
  moves the release role, not `ADMIN_ROLE`. Update the verifier labels
  `receipt: ADMIN_ROLE held by governance (applyReceipt releases)` and the
  `release-receipt` refusal in `publish-contracts/src/cli.ts`, which keys on
  `RouterGovernance` holding `ADMIN_ROLE`.

### 15. The gateway pins one vault and the router at `initialize`

- **Severity:** Low.
- **Design:** the gateway is a general tool. It pins no vault list. The
  depositor's policy names the allowed destination contracts
  (`allowedDestinations`, non-empty), and the owner picks them offline. The
  router is never a destination (owner decision 2026-10-20).
- **Code:**
  - `initialize` stores one `vaultContract` and one `routerContract`
    (`contracts/gateway/RobotMoneyGateway.sol:388-409`).
  - `_validateDestination` (lines 909-927) accepts only those two
    addresses. An empty `allowedDestinations` means any pinned
    destination, the router included.
- **Risk:** every gateway serves exactly one vault, so a second vault needs
  a second gateway. An empty policy list silently opens the router leg.
- **Fix:** drop the vault and router pins from `initialize` (the slots stay
  retired for the layout gate, as finding 2 says). `_validatePolicy`
  requires a non-empty `allowedDestinations`. `_validateDestination`
  checks membership in that policy list only. Do not add an on-chain
  registry-membership check: architecture §5.2 explicitly assigns contract
  selection to the owner offline. Remove the router execution branch;
  owner setup and client checks must select ERC-4626 vault destinations.
  The verifier label `gateway: router() equals the deployed router` goes
  with the pin. Close the legacy entrypoint bypass in finding 16 too.
- **Client dependency:** deposit preflight still reads `gateway.vault()`,
  compares it to `config.vault_address`, and reads pause and implementation
  state for that configured vault
  (`clients/rust-payment-client/src/policy/mod.rs:296-319`). Retiring the
  gateway's fixed vault pin without updating this preflight breaks rmpc.
  Resolve the requested destination from the owner's setup and check the
  actual destination reached, including its live state and implementation,
  before signing. Update the config/export and preflight tests together.
- **Dapp dependency:** `AuthorizeTab.tsx:75`, `OnboardingWizard.tsx:248`
  and `useRotationState.ts:146` construct `allowedDestinations: []`. Adding
  the non-empty validator alone makes those policies invalid. Collect the
  owner's explicit vault destinations in each surviving authorization and
  rotation flow, bind them into the consent's exact reveal calldata before
  either key commits, and preserve them in policy updates and config export.
  Do not silently substitute every registry vault or the router. Test a
  selected destination through authorization, export and deposit, plus an
  unselected destination's refusal.

### 16. The legacy deposit entrypoint bypasses allowed destinations

- **Severity:** Medium.
- **Design:** every agent deposit must target a destination in the owner's
  non-empty `allowedDestinations` (architecture §5.2).
- **Code:** `deposit` (`contracts/gateway/RobotMoneyGateway.sol:664-763`)
  calls `vaultContract.deposit` at line 743 without checking the policy's
  destination list. `depositTo` checks `_validateDestination` at line 807.
- **Effect:** a policy may allow only the router today, excluding the pinned
  vault, yet the same agent can call `deposit` into that vault. Amount,
  expiry, pause and receiver checks still apply; destination restriction
  does not. Deleting the router branch alone does not close this path.
- **Fix:** remove the fixed-vault entrypoint or make every deposit entrypoint
  use the same explicit destination and policy-membership validation.
  Remove client calls to the retired selector. Add a regression showing
  that a destination absent from the policy is refused through every
  surviving deposit entrypoint, even when caps and other checks pass.

### 17. Receipt recording can skip the required payload-byte checks

- **Severity:** Medium.
- **Design:** architecture §7.5 requires publish-contracts `record-receipt`
  to recompute the digest and receipt id from payload bytes and refuse a
  mismatch before any signer exists. `rmpc receipt verify` separately
  validates the receipt and its embedded analyst signatures (§5.1).
- **Code:** the CLI reads bytes only if optional `--payload` is present
  (`publish-contracts/src/cli.ts:620-622`). `assertRecordInputs` accepts
  syntactically valid ids, digests and a URI without any payload, and runs
  byte comparisons only inside `if (i.payload !== undefined)`
  (`publish-contracts/src/record-receipt.ts:139-149`).
- **Effect:** an operator can record an id or digest unrelated to the
  intended payload. Safe signatures authorize that transaction, but do not
  establish that the required payload checks ran. Calling `receipt verify`
  separately does not bind its output to the later invocation. The review
  has not demonstrated analyst-signature verification in publish-contracts;
  canon assigns that check to rmpc's preceding verification step.
- **Fix:** require payload bytes on the recording path and fail closed when
  the supported payload cannot yield a receipt id. Always recompute and
  compare both values before constructing a signer. Preserve the preceding
  signature-verification step for those same bytes. Add refusals for a
  missing payload, unsupported payload, mismatched id and mismatched digest,
  with no signer constructed and no transaction sent.

### 18. The explorer collapses separate registrations of the same agent address

- **Severity:** Low.
- **Design:** ownership is immutable within one registration, but an address
  can be registered again after revoke or expiry. Architecture §5.2 and
  invariant ACL-9 require indexers to key agents on (address, registration).
- **Code:** `agent_policies` preserves event rows, but the account-policy
  query selects `DISTINCT ON (chain_id, agent)` across all registrations and
  only then filters by owner (`clients/explorer-api/src/routes.rs:1591-1615`).
  There is no registration boundary in that projection. The former explorer
  ADR §3.4 prescribed the same address-only view and watched ownership
  transfers; its 2026-10-20 amendment replaces that target.
- **Effect:** after owner A revokes and owner B registers the same address,
  A's registration disappears from A's policy results. Registering the same
  address again under A also collapses its distinct lifecycles. Event rows
  are retained; this is a projection/history gap, not demonstrated loss of
  the underlying logs or a signing vulnerability.
- **Fix:** derive a reproducible registration identity from the event that
  starts each registration and carry it through policy updates, revocation
  and associated deposits. An `AgentAuthorized` emitted by `setPolicy` must
  update the existing registration, not start another. Keep event-log
  idempotency keys and preserve historical deployments' transfer events.
  Add any schema change in a new migration, then update account/history
  projections and the documented API shape together. Separate a current
  active-agent view from registration history so a later owner never erases
  the previous owner's historical registration.
- **Verification:** cover A → revoke → B, A → expiry → B, A → revoke → A,
  and a policy update within one registration, including same-block events
  ordered by log index and deterministic replay after a reorg.

## Open questions for the owner

- **Resolved 2026-10-20: the admin share receiver exception.** It is
  removed (finding 11).
- **Resolved 2026-10-20: vault scope.** An agent may deposit into any vault
  the depositor's policy allows. The docs already say this.
- **Resolved 2026-10-20: admin revoke, self-revoke, expiry, consent expiry,
  receipt path.** Findings 5, 10 and 12 record the decisions.
