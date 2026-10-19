# rmpc scope review: code that still gives rmpc and the gateway deprecated jobs (2026-10-19)

## Scope and pinned commits

- **Repository:** `robotmoney/robotmoney-core`.
- **Commits checked:** release v0.5.0 at core `57fbe618` (tag
  `release/v0.5.0-rehearsal`, branch `releases-0.5.x`) and `dev` at
  `e362df0c`.
- **Reviewed at:** 2026-10-19.
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

## Open questions for the owner

- **`authorizeAgent`.** An `ADMIN_ROLE` holder can authorize an agent
  directly, without the depositor's commit and reveal. The rule does not say
  whether this stays.
- **One vault or any allowed vault.** The docs keep the depositor's allowed
  vault list, so an agent may deposit into any vault the depositor allows.
  The rule says "a vault".
