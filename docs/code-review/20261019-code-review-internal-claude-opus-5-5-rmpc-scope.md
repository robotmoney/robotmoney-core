# rmpc scope review: code that still gives rmpc and the gateway deprecated jobs (2026-10-19)

## Scope and pinned commits

- **Repository:** `robotmoney/robotmoney-core`.
- **Commits checked:** release v0.5.0 at core `57fbe618` (tag
  `release/v0.5.0-rehearsal`, branch `releases-0.5.x`) and `dev` at
  `e362df0c`.
- **Reviewed at:** 2026-10-19. Finding 10 added 2026-10-20.
- **Design under test:** the owner rule of 2026-10-19. `rmpc` is an agentic
  cryptographic signer for end users. Its uses are off-chain: signing,
  keystores, the `committee-identity` Ed25519 signer, config export, offline
  `receipt verify`, and reads that send no transaction. Its one on-chain write
  is an agent deposit into a vault through `RobotMoneyGateway`, under the
  depositor's policy. The gateway exists for that deposit. Everything else is
  deprecated (`docs/architecture.md` §1, §5.1, §5.2).
- **Method:** read the gateway, rmpc, the dapp, the indexer, the plugins, the
  fusion scripts and CI. Compile and test runs were not part of this review.
- **Related:** `20261019-code-review-internal-claude-opus-5-5-ic-policy-removal.md`
  covers the committee writes (`rmpc committee`, the IC policy) and is not
  repeated here.

## Headline verdict

The code gives rmpc and the gateway four on-chain jobs beyond a vault deposit:
router deposits, single-vault withdrawals, router withdrawals and receipt
recording. Each one has contract code, client commands, tests, CI, plugin
text and dapp or indexer surfaces. None is needed for the vault deposit.

## Findings

### 1. The gateway still carries agent withdrawals

- **Severity:** Medium.
- `RobotMoneyGateway.withdraw` and `RobotMoneyGateway.withdrawFromRouter`
  ship, with withdraw windows, withdraw caps and asset recipient fields in
  the agent policy (`contracts/gateway/RobotMoneyGateway.sol`,
  `contracts/gateway/interfaces/IGateway.sol`).
- **Effect:** an agent can still redeem a depositor's shares, a power the
  design no longer grants.
- **Fix:** remove both functions and the withdraw-only policy fields. Keep
  any storage slot the proxy layout gate requires, as retired.

### 2. The gateway still deposits into the Portfolio Router

- **Severity:** Low.
- `RobotMoneyGateway.depositTo` has a router branch, and the gateway holds the
  router as an immutable.
- **Fix:** an agent deposit targets an allowed vault only. Drop the router
  branch and the router binding.

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
- `rmpc receipt submit` sends a receipt record transaction. The fusion
  receipt worker (`scripts/fusion/submit-receipt-worker.sh`) records through
  it.
- **Fix:** keep `rmpc receipt verify`, which is offline. Delete `receipt
  submit`. Receipts are recorded only by the submitter Safe with
  publish-contracts `record-receipt`. Move the fusion worker to that path.

### 6. The dapp still offers agent withdrawals and router paths

- **Severity:** Low.
- `clients/dapp/src/lib/configExport.ts` exports withdraw permissions for an
  agent. `DepositWithdrawTab.tsx` and the preview helpers
  (`preview.ts`, `routerPreview.ts`, `productReasonCode.ts`) carry agent and
  router paths.
- **Fix:** an agent policy export carries deposit permissions only. Human
  wallet deposits, withdrawals and redeems stay as they are.

### 7. The indexer still decodes agent withdrawals

- **Severity:** Info.
- `services/explorer-indexer/src/{abi,indexer,schema}.rs` decode gateway
  withdrawal events.
- **Fix:** stop decoding them. Any table change goes in a new migration.

### 8. The plugins still teach withdrawals and receipt submission

- **Severity:** Low.
- `plugins/robotmoney-user` and `plugins/robotmoney-cli` skills and
  references describe `withdraw`, `withdraw-router`, router deposits and
  `receipt submit`.
- **Fix:** describe the vault deposit and the off-chain uses only.

### 9. Tests, invariants and CI still cover the deprecated paths

- **Severity:** Info.
- Gateway withdrawal and router tests (`GatewayRouter.t.sol`,
  `RobotMoneyGateway.t.sol`, `RedeemGasGuards.t.sol`, `CoreStagesFork.t.sol`
  and others) and `test_GW5_agentRedeemCarriesRealFloor` in
  `fv/FvInvariants.t.sol` remain. `InvariantRegistry` still lists GW-5, which
  the docs retire. Suite 07 runs `cli_withdraw` and `cli_withdraw_router`.
- **Fix:** delete or rework the tests. Give GW-5 a tombstone status in the
  registry. Drop the suite 07 steps.

### 10. An admin can register an agent without its consent

- **Severity:** Medium.
- **Design:** commit and reveal is the only way to register an agent. No role
  can register one without the agent's consent (owner decision 2026-10-20,
  `docs/architecture.md` §6).
- **Code:** `RobotMoneyGateway.authorizeAgent` lets an `ADMIN_ROLE` holder
  register any address in one transaction. It skips the agent consent check
  (issue 1791). It may name any share receiver. The admin becomes the agent's
  owner. Separately, the constructor makes `ADMIN_ROLE` the admin of
  `AGENT_ROLE`, so an admin can also call `grantRole(AGENT_ROLE, x)` directly.
- **Risk:** a compromised or mistaken admin can create agents that deposit
  under a policy the admin wrote. End users never need either path.
- **Where it lives:**
  - Contracts: `RobotMoneyGateway.sol`, `IGateway.sol`, `AccessRoles.sol`
    comments, `DeployTimelock.s.sol` comments.
  - Tests: `RobotMoneyGateway.t.sol`, `GatewayAgentPolicyAuthorization.t.sol`,
    `ConfusedDeputyGuards.t.sol`, `DeployAssertions.t.sol`,
    `helpers/CoreStages.sol` and about ten more that use it for setup.
  - Dapp: the Rotation tab `authorizeAgent` button (`RotationTab.tsx`,
    `useRotationState.ts`, `rotation.ts`), the `authorizeAgent` preview
    (`preview.ts`, `credentialWorkflow.ts`), `onboardingSeed.ts`, the ABIs.
  - Clients: the selector check in `rust-payment-client/src/gateway/mod.rs`,
    the decode-only entry in `publish-contracts/src/committee-register.ts`,
    `explorer-api/src/model.rs`.
  - Invariants text in `docs/technical/smart-contract-invariants.md` (the
    validator writer list) and the generated contract docs.
- **Fix:**
  - Delete `authorizeAgent` from the gateway and `IGateway`.
  - Stop `ADMIN_ROLE` from granting `AGENT_ROLE`. Only `revealAuthorization`
    grants it. One way is a `grantRole` override that refuses `AGENT_ROLE`.
    `revokeAgent` by the owner still revokes it.
  - Move test setup to commit and reveal. Delete the dapp button and preview.
  - This adds no storage, so the layout gate is unaffected.

## Open questions for the owner

- **The admin share receiver exception.** The policy validator lets a caller
  holding `ADMIN_ROLE` name any share receiver. Without `authorizeAgent`, an
  admin can still reach it through its own commit and reveal. A non-admin must
  name itself. The design does not yet say whether the exception stays.
- **Resolved 2026-10-20: vault scope.** An agent may deposit into any vault
  the depositor's policy allows. The docs already say this.
