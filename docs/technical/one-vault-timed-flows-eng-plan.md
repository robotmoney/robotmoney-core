# One-vault experiment: engineering plan for timed flows (step 3d)

Status: plan, 2026-11-11. It implements §5.9 of
`docs/technical/one-vault-rebalancer-proposal.md` (step 3d, D10, RB-10 to
RB-12, gate G8). It runs on the prototype under `contracts/test/prototype/`
only. Production contracts and canonical docs do not change. The experiment's
rules still hold: forge tests on the recorded Base fixture, with no RPC in a
test run.

> **Review note, 2026-11-11.** §15 of the proposal reviews this plan. It
> proposes to replace E3, E4, E6, E7, E8 and E10 (proposal §15.4, §15.6). The
> owner has not decided yet. Wait for that decision before work package 4.

## 1. Goal

Make the fund safe against price-manipulation drains like the Makina exploit
(proposal §5.9). Measure the price in liquidity and cost. Concretely:

1. Show, by test, which attacks work against today's synchronous fund.
2. Add timed deposits, timed redemptions, a minimum hold and an anomaly hold.
3. Show, by the same tests, that no attack has a positive net result. Score G8.
4. Measure what timed flows do to G4 cost and to user wait times.

## 2. Design decisions this plan makes

Each decision is a working default. Each can be revisited in the conclusion.

| ID | Decision | Choice | Why |
| --- | --- | --- | --- |
| E1 | Where the queue lives | A new `FlowQueue` contract. It holds pending USDC and escrowed shares. Only it may call the fund's USDC deposit and redeem paths (`FLOW_ROLE`). | The fund has 1,556 bytes left under G1. A queue in the fund would not fit. Custody of the fund's assets stays in the fund. The queue holds only flows that have not settled yet. |
| E2 | Interface | ERC-7540 style: `requestDeposit`, `requestRedeem`, `claimDeposit`, `claimRedeem`, plus `cancel`. The fund's ERC-4626 `deposit`, `mint` and `redeem` revert for any caller except the queue. | It follows a published standard for async vaults, so clients have a reference. |
| E3 | Settlement NAV | Worst case for the flow, taken from the window's checkpoints. Deposits mint at the highest NAV per share. Redemptions pay at the lowest. | A push held for only part of the window gains nothing. |
| E4 | Pricing against realized value | Deposit: mint the smaller of the shares from the worst checkpoint and the shares from the realized NAV delta. Redeem: pay the smaller of realized proceeds and the value at the worst checkpoint. Any surplus stays with holders. | Remaining holders never pay for a flow's slippage or for a manipulated checkpoint. |
| E5 | Netting | At settlement, pending deposit USDC first funds that epoch's redemptions. Only the difference is routed (deficit-first) or sold (pro rata). | Fewer trades. This lowers G4 cost. |
| E6 | Checkpoints | `checkpointNav()` can be called by anyone during the window, at most once per `checkpointSpacing` (default 5 min). Settlement needs at least `minCheckpoints` (default 6). Each checkpoint records NAV per share and runs the ORA-4 check on every basket asset. | Keeper liveness without trust. An attacker cannot flood the window with checkpoints. |
| E7 | Anomaly | Hold if any two consecutive checkpoints differ by more than `navJumpBps`. Hold if any checkpoint fails ORA-4. A held window extends by one window. Holding stops being automatic after `maxHold`, and `EMERGENCY_ROLE` or the Safe then settles or cancels. | This is the owner's "observed for anomalies", made concrete. The bound on liveness is explicit. |
| E8 | Minimum hold | A per-account `lockedShares` and `unlockAt`. Locked shares cannot be transferred, redeemed or requested for redemption. A new deposit claim adds to `lockedShares` and moves `unlockAt` to `claim time + minHold`. | It blocks lock bypass by transfer. It cannot be used to grief another account, because nobody can push locked shares onto someone else. The cost: a new deposit relocks the account's earlier locked shares. |
| E9 | `redeemInKind` | Stays on the fund, instant, for unlocked shares only. | It reads no price, so it has nothing to manipulate. It keeps one synchronous exit (D10). |
| E10 | Who settles | Anyone, after the window ends and the anomaly check passes. | Same liveness model as `step()` (D3). |
| E11 | Minimum request size | `minRequestUsdc` (default 100 USDC) for deposits. Redemptions use the same minimum, valued in shares. | It limits griefing by floods of tiny requests. |

Parameters, all in `FlowParams`, set by `ADMIN_ROLE` within bounds:
`epochLength` (6 h), `settleWindow` (1 h, at least 2 × the longest TWAP
window), `checkpointSpacing` (5 min), `minCheckpoints` (6), `navJumpBps` (200),
`maxHold` (48 h), `minHold` (24 h), `minRequestUsdc` (100 USDC).

## 3. Contract changes

### 3.1 New: `src/FlowQueue.sol`

- State per epoch:
  - `depositTotal` and `redeemShares`;
  - the window bounds;
  - the checkpoints: count, minimum, maximum and last value, plus the anomaly flag;
  - a settled flag and the settled rates.
- State per account per epoch: deposit USDC and redeem shares requested.
- `requestDeposit(assets, receiver)` pulls USDC. `requestRedeem(shares, receiver, owner)`
  escrows unlocked shares. Each request joins the open epoch.
- `checkpointNav()`. `settle(epoch)`. `claimDeposit(epoch, receiver)` and
  `claimRedeem(epoch, receiver)`.
- `cancel(epoch)` works before the epoch closes, or after `maxHold` once the
  Safe has decided to cancel. It returns exactly what was escrowed.
- Events for each action. Indexers and the dapp read these.

### 3.2 Changed: `src/RobotMoneyFund.sol` and libraries

- `FLOW_ROLE`, granted to the queue at wiring. `deposit`, `mint` and `redeem`
  check it.
- `settleFlows(depositUsdc, redeemShares, mintRate, payRate)` is called only by
  the queue. It does the netting (E5), the deficit-first routing, the pro-rata
  sale, the mint and the burn under E4. Its logic goes in `FundFlowsLib`, so
  the fund grows only by the selector.
- The lock (E8): `lockedShares`, `unlockAt`, and a check in `_update`. The
  existing exclusion ledger checkpoint stays.
- `redeemInKind` checks that the shares it burns are unlocked.
- A G1 budget comes first (§6, work package 1). If the fund does not fit,
  move the lock check into `FundFlowsLib`. Then split the admin views. Do not
  move custody.

### 3.3 Unchanged

The Rebalancer, the governance contract, receipts, the plan and the step logic.
Steps keep running during settlement windows. A step moves NAV by at most
`maxStepCostBps` (50 bps), which is under `navJumpBps`.

## 4. Tests

All tests run on the replay fixture. Re-record with
`record-base-fixture.ts --pin 55462550 --sim` only if a test reports a fixture
miss.

### 4.1 `Attacks.t.sol`: the attacker's full profit and loss

Each test plays the attacker, then computes the net result. That is the value
taken from the fund, minus the cost to move prices and the flash-loan fee. The
flash loan is modelled with `deal` and a fee of 5 bps (Aave V3) or 0 (Morpho).
The test runs twice: against the synchronous fund (baseline) and against the
timed fund. G8 passes only if the net result is at most zero in every case,
and remaining holders lose at most 1 bps of NAV.

| ID | Attack | Expected result on today's fund |
| --- | --- | --- |
| A1 | Makina replay. In one transaction, push a basket pool's spot with a large loan, then deposit or redeem. Run once per pool: wETH, cbBTC, deSPXA. | Probably not profitable. NAV reads TWAP, ORA-4 blocks deposits, and a redeem only sells into the attacker's own push. The test must show this, not assume it. |
| A2 | TWAP push. Hold a pushed price for 1 to N blocks against the sim's arbitrage, then redeem or deposit. Run once in US hours and once off hours for deSPXA. | Unknown. This is the main case timed flows defend. |
| A3 | Deflate then deposit. Push NAV down, deposit, release the push, redeem. | Unknown. ORA-4 should block it at the push. |
| A4 | Lending exchange rate. Donate to, or pump the supply of, Aave, Compound or Moonwell, then deposit or redeem. | Unknown. Lending is valued 1:1 through each venue's own rate. |
| A5 | Round trip. Deposit and redeem in one block, then in consecutive blocks. | Possible today. It must be impossible after (RB-11). |

A2 needs the sim's arbitrage model and pool noise. It goes in
`sim/AttackSim.t.sol`, which reuses `SimLib` and the fast harness flags.

### 4.2 `FlowQueue.t.sol`: the mechanism

- **RB-10:** no mint and no payout before the window ends. Settlement uses only
  checkpoints from inside its own window.
- **RB-11:** no redeem, request or transfer of locked shares. A lock-bypass
  test transfers shares and redeems at once, and must revert. A `redeemInKind`
  of locked shares must revert.
- **RB-12:** a NAV jump or an ORA-4 failure holds settlement. After `maxHold`
  only the Safe or `EMERGENCY_ROLE` can settle or cancel. A cancel returns
  exactly what was escrowed.
- **E3 and E4:** deposits mint at the highest checkpoint, and redemptions pay at
  the lowest. The realized-value cap binds when slippage is worse.
- **E5:** an epoch with equal deposits and redemptions makes no trade.
- **E11 and griefing:** a flood of minimum-size requests settles within gas
  limits.
- **Too few checkpoints:** settlement reverts and the window extends.

### 4.3 Existing suites

- **`Invariants.t.sol`:** add handler actions for the queue: request, checkpoint,
  settle, claim, cancel and redeem in kind. Add invariants for RB-10 to RB-12. Add
  a conservation check: queue USDC plus fund NAV equals the deposits and payouts
  booked.
- **`EndToEnd.t.sol` and `Adversarial.t.sol`:** move them to the request and
  claim flow. Existing rows of §5.8 must still pass.
- **`SizeGate.t.sol`:** G1 must still pass with the queue wired in.

### 4.4 Sim: timed flows beside the scored run

Add `PROTO_SIM_FLOWS=timed`. The sim's user flows become requests, and its
keeper also checkpoints and settles. G4 and G5 stay scored on the step 3 run.
The timed run is reported beside them, scored with three new outputs:

- **False holds:** the share of normal epochs the anomaly check held. A rate
  above a few percent means `navJumpBps` is too tight.
- **Wait time:** the time from request to claim, as a median and a 95th
  percentile.
- **Netting saving:** G4 cost with timed flows compared with synchronous flows.

## 5. Work packages, in order

| # | Package | Done when |
| --- | --- | --- |
| 1 | **Size budget.** Stub `FlowQueue`, `FLOW_ROLE`, `settleFlows` and the lock. Measure G1. | Fund under 23,552 bytes with the stubs. The plan for any overflow is written down. |
| 2 | **Baseline attacks.** A1, A3, A4 and A5 in `Attacks.t.sol` against today's fund. | Each records the attacker's net result. A positive result is a finding, not a failure of the package. |
| 3 | **A2 TWAP push** in `sim/AttackSim.t.sol` against today's fund. | Net result per pool, per hold length and per market-hours state. |
| 4 | **`FlowQueue` and fund changes** (§3). | `FlowQueue.t.sol` passes. Existing suites pass on the request and claim flow. |
| 5 | **Attacks against the timed fund.** Rerun A1 to A5. | Every net result is at most zero. Holders lose at most 1 bps. |
| 6 | **Invariants** with the queue actions. | RB-10 to RB-12 hold. The conservation check holds. |
| 7 | **Timed-flow sim.** | False holds, wait time and netting saving are reported for the default and tuned sets. |
| 8 | **Evidence.** Fill the G8 row in §14 of the proposal. Add a "Step 3d" paragraph. Add the sizes to the G1 table. | The doc matches the test output. |

Packages 2 and 3 do not depend on package 4. They can run in parallel with it.

## 6. Risks

- **G1.** The fund may not fit even with the queue outside it. The fallback is
  to move the lock and the settlement into libraries. If custody or share
  accounting would have to leave the fund, G1 fails, and that result goes in
  §14 as found.
- **False holds.** Normal volatility, such as deSPXA at the US open, may trip
  `navJumpBps` often. The sim measures this (package 7). The threshold is set
  from the sim, and the reason is recorded.
- **Product promise.** Timed redemption breaks architecture §4.4. The owner
  accepted this trade-off on 2026-11-11 (D10). The experiment still does not
  edit the architecture. The production path rewrites §4.4 if the design goes
  ahead.
- **Clients.** The dapp, `rmpc` and the indexer need request, claim and
  pending-state views. They are counted for G6, not built (§8 of the
  proposal).
- **A baseline that is already safe.** If A1 to A5 all show no profit against
  today's fund, the mitigation defends only against attacks that are not in
  the list. The report says so plainly. G8 is still scored on the timed fund.

## 7. Out of scope

- Production contracts and canonical docs (`docs/architecture.md`, the PRD).
- Building clients.
- Deploys, Twin and RPC test runs.
- Changes to the Rebalancer or to receipts.
