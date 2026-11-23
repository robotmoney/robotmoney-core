# 07 — Supporting Matrices

This chapter holds the five supporting tables chapter 05 asked for (its section 3.2, and the rows of its section 2.2 about the lending adapters and the reentrancy matrix).
Every row was read from the code of this branch on 2026-11-23. Nothing here was executed: no `forge` run backs a row.

- **Branch:** `adhoc/20261122-233507-safety-review-090`
- **Citations:** rows name functions, not lines, for `contracts/lib/FlowMatchLib.sol`, `contracts/Rebalancer.sol`, `contracts/lib/FundFlowsLib.sol` and `contracts/lib/FundDelistLib.sol`, because those four files are still changing on this branch. `contracts/lib/FlowSettleLib.sol`, `contracts/lib/FlowCheckLib.sol` and `contracts/lib/FlowStorage.sol` were also edited while this chapter was written, so their rows name functions too. A row may be behind the code by the time it is read.

## Open problems

These came out of building the tables. Each is a reading of the code. None was reproduced in a test. The fix author should confirm each one with a test before acting on it.

### OP-1 (from section 1). The settle walk scanned a list of epochs that never shrinks (fixed on this branch)

**Status:** fixed after this chapter was first written. `applyParams` no longer resets `oldestEpoch`. The epoch steps of `_walkSide` and the loop of `_rememberOldest` are bounded by `MAX_LOOK_PER_CALL` a call, `_walkStart` bisects, and anyone may call `withdrawExpired`, so an expired deposit cannot hold `oldestEpoch` back. The text below describes the code before the fix. No test reproduces the old behaviour at scale.

- `FlowState.activeEpochs` gets one entry for every epoch in which a request is created (`FlowMatchLib.registerCreated`). No code removes an entry.
- The settle walk starts at index `oldestEpoch` and steps over every later entry: `FlowSettleLib._walkStart`, the epoch-skip branch of `FlowSettleLib._walkSide`, and `FlowSettleLib._rememberOldest`. The epoch-skip branch spends neither the look budget nor the dead-id skip count.
- `oldestEpoch` moves forward only past an epoch with no open request (`_rememberOldest` stops at `epochOpen[e] != 0`). A request closes when it is filled, cancelled, refunded as a sub-minimum remainder, returned after a notice, released in a wind-down, or withdrawn after expiry. The withdrawal after expiry, `withdrawExpired`, is owner-only (`FlowClaimLib._owned`). So one expired deposit that its owner never withdraws keeps `oldestEpoch` on its epoch. A dust redemption request left open does the same: redemption requests do not expire.
- `FlowSettleLib.applyParams` sets `oldestEpoch = 0` on every `setFlowParams`. The next settle that walks a side then scans the whole list, because `_rememberOldest` runs after the walks.
- Cost per scanned epoch and side is a few cold storage reads (`activeEpochs[idx]`, `sideIds[k][e].length`, `sideOpen[k][e]`). The scan grows by up to four epochs a day at the 6 hour epoch. This is an estimate from storage-read costs, not a measurement.
- Who can grow it: any user, by opening one request per epoch. Who can pin it: any user, with one request at the minimum size that they leave open. The escrow stays theirs, so the pin costs gas only.
- Not checked: how many scanned epochs fit under the per-transaction gas cap next to the rest of `settle`.

### OP-2 (from section 1). `FlowEpochs.newestEndedBy` can loop down to epoch 0 after an `epochLength` change

- `FlowCheckLib._timeWindowOpen` calls `FlowEpochs.newestEndedBy(s, block.timestamp - settleWindow, 0)` on every `checkSettle` and `settle`.
- While `t < epochAnchorTime` the function loops from `epochAnchorIndex - 2` down to `floor` (0) and stops at the first epoch with a stored end at or before `t`. `FlowSettleLib._rebaseEpochs` stores an end only for an epoch that holds an open request.
- `epochAnchorTime` is 0 until the first `epochLength` change, so the loop never runs before one. After a change, `epochAnchorTime` is the end of the epoch in progress, so the loop runs until that epoch ends plus `settleWindow`.
- If no ended epoch holds an open request at that time, the loop reads every epoch index down to 0. Epoch indexes are absolute: `timestamp / epochLength` before the first change, about 81,000 at 6 hour epochs.
- Effect, if the reading holds: `checkSettle` and `settle` run out of gas during that window, when there is also nothing to settle. It ends by itself when the window ends. Only the timelock can trigger it (`setFlowParams` with a new `epochLength`).

### OP-3 (from section 2). A claimant the token refuses cannot be paid by `settleClaim`, and a lending claim then blocks steps out of that venue

- `FundPositionLib.settleLendingClaim` pays the claim owner with `safeTransfer(owner, netUsdc)`. `FundFlowsLib._settleClaim` pays a delisting claim the same way. Neither takes another recipient.
- If USDC refuses the owner (a blacklist), `settleClaim(index, owner)` reverts every time. For a lending claim the owner can still call `claimPosition(index, to)` with another address. A delisting claim has no such path.
- While a lending claim is open, a step that sells that lending asset reverts `LendingHasClaims` (`contracts/lib/FundStepLib.sol:128-129`). So a refused owner who does not call `claimPosition` keeps the Rebalancer from moving money out of that venue. The whole-fund unwind and `drain` do not go through that check.
- `FundExclusionLedger.claim` has the same shape, with harm to the claimant only. See section 2.

### OP-4 (from section 4). The lending adapters cannot collect reward tokens, and anyone can send them to the quarantine address

- `harvestRewards()` is an empty function on all three lending adapters. No adapter function claims a reward token or forwards one to the fund.
- If a venue credits a reward token to the adapter address, the fund never receives it. Anyone can then call `sweepForeignToken(rewardToken)`, which sends the adapter's whole balance of it to the fixed quarantine address.
- Not checked: whether Aave, Compound or the Moonwell vault pay reward tokens to this adapter on Base today. The NatSpec on each `harvestRewards` says the venue has none. If one starts paying, the holders lose that income. No caller can take it for themselves.

### OP-5 (from section 5). Three step 3f invariants are asserted on counters nothing writes

- `invariant_RB23_to_RB36_step3f` asserts `ghostRb23 == 0`, `ghostRb28 == 0` and `ghostRb36 == 0`.
- Those counters are incremented only inside `_violation`, for codes 23, 28 and 36. No call to `_violation` in `contracts/test/prototype/Invariants.t.sol` passes 23, 28 or 36. The three assertions cannot fail.
- RB-23, RB-28 and RB-36 each have a scenario test in `FlowQueue.t.sol` (section 5). They have no fuzzed check.

---

## 1. Loop-bound matrix

Scope: every `for` and `while` loop in `contracts/FlowQueue.sol` and `contracts/lib/Flow*.sol`, state-changing and view. `contracts/FlowQueue.sol` has no loop: every loop is in a library.

Constants used below: `MAX_FUND_ASSETS = 12` (`contracts/FundTypes.sol`), `MAX_OWNER_OPEN_REQUESTS = 16`, `ENROLL_BUDGET = 32`, `ENROLL_VISIT_MAX = 256`, `NOTICE_BUDGET = 16`, `MAX_ROLL = 64` (`contracts/FlowTypes.sol`), `MAX_LOOK_PER_CALL = 256` (`contracts/lib/FlowSettleLib.sol`), `MAX_EXIT_FEE_BPS = 100` (`contracts/lib/FundStorage.sol`).

"Assets" means the fund's asset list, at most `MAX_FUND_ASSETS` entries. Only the timelock adds an asset (`addAsset`).

### `contracts/lib/FlowCheckLib.sol`

| Function | What it iterates | Bound | Who can grow it |
|---|---|---|---|
| `_breakerValues` (two loops) | Asset prices of the settle context | Constant: assets, also capped at 256 | Timelock |
| `_cycledVenues` | Exclusion records opened since the last recorded settlement, one external view call each | Not a constant. One record per lending asset excluded since the last settlement | Timelock: a record opens when it revokes a lending adapter's code hash (`RobotMoneyFund.setAdapterCodeHashAllowed`, `FundAdminLib.syncExclusions`) |
| `excludedMask` | Assets | Constant: assets, also capped at 256 | Timelock |
| `market` (four loops) | Assets | Constant: assets | Timelock |
| `_lendRates` | Assets | Constant: assets | Timelock |
| `checkVenuesLiquidity` | Assets | Constant: assets | Timelock |
| `_hasActiveBasket` | Assets | Constant: assets | Timelock |
| `_requireFundedPoolsFixedFee` | Assets | Constant: assets | Timelock |

### `contracts/lib/FlowClaimLib.sol`

| Function | What it iterates | Bound | Who can grow it |
|---|---|---|---|
| `deliver` | The receiver's claims, from `claimCursor[receiver]`. Stops when the asked amount is covered | Unbounded: the receiver's claims not yet fully consumed. The cursor moves only over a consumed prefix | Each fill of a request the receiver owns adds one claim. A third party can add claims by opening deposit requests that name the receiver, each at `minRequestUsdc` or more, at most 16 open a side |
| `redeemClaims` | The owner's claims, from `claimCursor[owner]`. Owner-only | Unbounded: as `deliver` | As `deliver` |
| `epochRequests` (view) | Every request id of one epoch, both sides | Unbounded: requests made in that epoch | Any user |
| `claimable` (view) | The claims of one request | Unbounded: one claim per settlement or match that filled the request | Any counterparty flow that fills the request |
| `maxClaims` (view) | The owner's claims, from the cursor | Unbounded: as `deliver` | As `deliver` |

### `contracts/lib/FlowMatchLib.sol`

| Function | What it iterates | Bound | Who can grow it |
|---|---|---|---|
| `hasPendingForRound` (two loops) | Active epochs from `enrollCursor`; deposit ids of each epoch from `enrollPos` | Constant for the ids: after `ENROLL_VISIT_MAX` (256) ids the answer is "work". The epoch loop ends at the first epoch with an open redemption or a live deposit, and at the round's epoch | Any user (requests) |
| `enrollEpochs` (two loops) | Active epochs from `enrollCursor`; positions of each epoch from `enrollPos` | Constants: `ENROLL_BUDGET` (32) enrollments, `ENROLL_VISIT_MAX` (256) visits and `ENROLL_GAS_MAX` (4,000,000 gas, after the first enrollment) a call. The place is kept in `enrollCursor` and `enrollPos` | Any user (requests) |
| `_liveDepBucket` | `activeDepBuckets` | Parameter: one bucket per distinct `expiryEpoch` with an enrolled deposit. `expiryEpoch` is the request epoch plus `maxRoll` (`FlowClaimLib._newRequest`), `maxRoll <= MAX_ROLL`, and expired buckets are evicted at the start of each round. So at most `maxRoll + 1` live buckets | Any depositor: one bucket per epoch |
| `_matchHold` | `activeDepBuckets` | As `_liveDepBucket` | Any depositor |
| `evictExpiredDepBuckets` | `activeDepBuckets` | As `_liveDepBucket` | Any depositor |
| `_advanceDepositMatchIndex` | `activeDepBuckets`, only when a match fills the whole deposit pool | As `_liveDepBucket` | Any depositor |
| `_mergeOwnerDepCohort` | One owner's deposit cohorts | Parameter: one cohort per (cycle, `expiryEpoch`). `syncOwnerDeposits` drops a cohort whose bucket is evicted or whose cycle ended, and every enrollment syncs first. So at most `maxRoll + 1` | The owner, or a third party whose deposit request names the owner |
| `_consumeActiveDeposit` | One owner's deposit cohorts | As `_mergeOwnerDepCohort` | As above |
| `_advanceRedeemMatchIndex` | Fee tiers of the live redemption cycle | Constant: one tier per distinct `exitFeeBps` among enrolled requests, at most 101 values (`MAX_EXIT_FEE_BPS = 100`) | Timelock: a new tier appears only after it changes the exit fee |
| `syncOwnerDeposits`, request loop | The owner's open deposit requests | Constant: `MAX_OWNER_OPEN_REQUESTS` (16), enforced in `registerCreated` | The owner, or a third party naming the owner |
| `syncOwnerDeposits`, match loop (inside the request loop) | Deposit match records from the request's `nextMatchId` to the end of its bucket | Not a constant. One record per booked deposit match since the request's last sync. It ends when the bucket is evicted, at most `maxRoll` epochs after the request. Each record can write one claim | Any user whose redemption is matched against the deposit pool |
| `syncOwnerDeposits`, two compaction loops | The owner's open deposit requests; the owner's cohorts | Constant 16; `maxRoll + 1` | As above |
| `syncOwnerRedeems`, request loop and compaction loop | The owner's open redemption requests. One accumulator read per request, no inner loop | Constant: 16 | The owner, or a third party naming the owner |
| `_closeDepositReq`, `_closeRedeemReq` | The owner's open requests of one side | Constant: 16 | As above |
| `finalizeEndedNotices`, outer loop | Pending notice rounds. A round that has not ended costs one check and is skipped | Not a constant, small in practice: a notice targets the round then open or forming (`FlowClaimLib.giveRedemptionNotice`) | Any redeemer whose request is past `maxRoll` |
| `finalizeEndedNotices`, inner loop | Noticed requests of an ended round | Constant per call: `NOTICE_BUDGET` (16) returns. Each return syncs its owner (16 requests at most) | Any redeemer past `maxRoll` |
| `releaseWindDown` (two loops) | The owner's open requests, both sides | Constant: 16 each | The owner, or a third party naming the owner |
| `queuedSharesOfAt` (view), cohort loop | One account's deposit cohorts | Parameter: `maxRoll + 1` | As `_mergeOwnerDepCohort` |
| `queuedSharesOfAt` (view), match loop | Deposit match records from the cohort's start to the snapshot index | Not a constant: one record per booked match in that span. `FundExclusionLedger._checkpoint` calls this view on a share transfer, mint or burn for an account that has a missing checkpoint | Any user whose redemption is matched |
| `previewUnsyncedDepDeliverable` (view, two loops) | As `syncOwnerDeposits` | As `syncOwnerDeposits` | As above |
| `previewUnsyncedRedClaimable` (view) | The owner's open redemption requests | Constant: 16 | As above |

### `contracts/lib/FlowMigrateLib.sol`

| Function | What it iterates | Bound | Who can grow it |
|---|---|---|---|
| `migrateV090` (three loops) | Every request, every settlement and every claim the queue ever recorded | Unbounded: the whole history, in one transaction. It runs once, from the timelock. ADR-0020 records this limit | Any user before the upgrade (history) |
| `_migrateRequest` | Five storage slots of one request | Constant: 5 | Nobody |

### `contracts/lib/FlowSettleLib.sol`

| Function | What it iterates | Bound | Who can grow it |
|---|---|---|---|
| `_basketCallRoom` | Asset prices | Constant: assets | Timelock |
| `_walkStart` | `activeEpochs`, between `oldestEpoch` and the end, to find the walk cursor's epoch | Logarithmic: a bisection of the ascending list | Any user |
| `_walkSide`, epoch steps | `activeEpochs`, from the start index to the round's last epoch | Constant: an epoch with nothing open on that side, and a dead id, each count against `MAX_LOOK_PER_CALL` (256) a side a call. The cursor keeps the place | Any user |
| `_walkSide`, request steps | Request ids of each epoch | Parameter and constant: live requests spend the look budget, the smaller of the caller's `maxRequests` and `MAX_LOOK_PER_CALL` (256) per call, both sides together. A closed, not enrolled or wound-down id is passed without budget, at most `MAX_LOOK_PER_CALL` of them a side a call (this skip was added to the function while this chapter was written) | Any user. Ids of closed and expired requests stay listed. An expired deposit that is still open spends one budget unit each time it is passed |
| `_rememberOldest` | `activeEpochs`, from `oldestEpoch` to the first epoch with an open request | Constant: at most `MAX_LOOK_PER_CALL` (256) steps a settlement | Any user |
| `_recordReferences` | Asset prices | Constant: assets | Timelock |
| `_rebaseEpochs` | `activeEpochs`, from `oldestEpoch` to the end. Runs only when `setFlowParams` changes `epochLength` | Unbounded: see OP-1 | Any user. Triggered by the timelock |
| `redeemSide`, fills loop; `_recordRedeems` | Fills of one net redemption call | Constant: at most 256 (the walk budget) | Any redeemer |
| `redeemSide`, price loop | Asset prices | Constant: assets | Timelock |
| `depositSide`, fills loop; `_recordDeposits` | Fills of one net deposit call | Constant: at most 256 | Any depositor |
| `depositSide`, two price loops | Asset prices | Constant: assets | Timelock |

### `contracts/lib/FlowStorage.sol`

| Function | What it iterates | Bound | Who can grow it |
|---|---|---|---|
| `FlowEpochs.newestEndedBy` | Epoch indexes, downward from `epochAnchorIndex - 2` to `floor`. Runs only while `t < epochAnchorTime` | Unbounded in that window: see OP-2. Outside it the function has no loop | Time. Triggered by the timelock (`epochLength` change) |

---

## 2. Transfer-sink matrix

Scope: every transfer of a token out of the fund, the queue and the exclusion ledger. Found by searching `safeTransfer`, `tryPay`, `_tryTransfer` and `transfer(` in `contracts/RobotMoneyFund.sol`, `contracts/FlowQueue.sol`, `contracts/FundExclusionLedger.sol` and `contracts/lib/*.sol`.

Left out, with the reason:

- `contracts/RobotMoneyFund.sol` and `contracts/FlowQueue.sol` hold no transfer themselves. Every transfer is in a library they call.
- `BasketAssetConfigGuard._payLeg`, `BasketSwaps.reabsorb` and the two transfers in `RobotMoneyVaultOps` belong to the legacy vault code paths. The fund uses `RobotMoneyVaultOps` only for the exclusions storage.
- Transfers into the fund or the queue (`safeTransferFrom` in `FundFlowsLib.seed`, `FundFlowsLib.mintInKind`, `FlowClaimLib.requestRedeem`, `FlowClaimLib._pullUsdc`) are not sinks.
- A swap pays the fund itself: the adapter is approved, pulls the input, and the output comes back to the fund (`FundFlowsLib._swap`).

"Refused" below means the token rejects the recipient, for example a USDC blacklist. "Pause" means the queue pause (`pauseQueue`) unless the row says otherwise. A queue pause blocks new requests (`FlowClaimLib._open`) and settlement (the pre-trade check in `FlowCheckLib` returns `SettleCheck.Paused`). No claim, cancel or withdrawal path checks it.

### Out of the fund (`RobotMoneyFund`, through its libraries)

| Path | Recipient | Token | If the recipient is refused | What a pause does |
|---|---|---|---|---|
| `FundFlowsLib.mintInKind`, refund of unspent USDC | The caller, which is the bound FlowQueue (`FLOW_ROLE`) | USDC | Reverts the whole call. The recipient is a protocol contract. If USDC refuses the queue, every queue path stops | Reached only inside `settle`, so a queue pause stops it. A deposit pause stops net deposits |
| `FundFlowsLib._sellForFlow`, payout | The caller, the FlowQueue | USDC | Reverts the whole call. As above | Reached only inside `settle` |
| `FundFlowsLib._payLeg` from `payInKind` (the `redeemInKind` USDC leg), fee part | `feeRecipient` | USDC | Tolerated: `_payFee` emits `FeeNotPaid` and the fee stays with the holders | None. `redeemInKind` is open only after `shutdown` |
| `FundFlowsLib._payLeg` from `payInKind`, holder part | `receiver`, chosen by the caller | USDC | Reverts the whole `redeemInKind`. The holder can call again with another receiver | None |
| `FundFlowsLib._inKindBasket`, holder part | `receiver` | Each basket token | Tolerated: `_tryTransfer` fails, and the amount is deferred to the claimant (`_deferSplit`). The claimant pulls it later with `claimDeferred` | None |
| `FundFlowsLib._inKindBasket`, fee part | `feeRecipient` | Each basket token | Tolerated: deferred to `feeRecipient` (`_defer`) | None |
| `FundFlowsLib._claimDeferred` | `to`, chosen by the account that is owed | USDC (lending) or the basket token | Reverts that claim only. The account can call again with another `to` | None |
| `FundPositionLib.claimPosition` | `to`, chosen by the claim's owner | USDC | Reverts that claim only. The owner can call again with another `to` | None |
| `FundPositionLib.settleLendingClaim` (from `settleClaim`), fee part | `feeRecipient` | USDC | Tolerated: `FeeTransfer.tryPay` fails and `FeeNotPaid` is emitted | None |
| `FundPositionLib.settleLendingClaim`, owner part | The claim's `owner`. Anyone can call `settleClaim(index, owner)`; no other recipient can be named | USDC | Reverts every `settleClaim` for that owner. The owner can still use `claimPosition(index, to)`. Until the claim is gone, a step that sells that lending asset reverts (OP-3) | None |
| `FundFlowsLib._settleClaim`, delisting claim, fee part | `feeRecipient` | USDC, and the delisted token after shutdown | Tolerated: `_payFee` | None |
| `FundFlowsLib._settleClaim`, delisting claim, owner part | The claim's `owner`. No other recipient can be named | USDC, and the delisted token after shutdown | Reverts every `settleClaim` for that owner. There is no redirect for a delisting claim. Only that owner is harmed: the claim stays booked | None |
| `FundPositionLib.supply` | The lending adapter of the asset | USDC | Reverts the step or the purchase | A rebalance pause stops steps. A queue pause stops `mintInKind` |
| `FundPositionLib.drain` | The fund's own `FundExclusionLedger` | USDC | Reverts the drain. The recipient is a protocol contract | None |
| `FundFlowsLib._sweepForeign` | The fixed quarantine address (`ForeignTokenQuarantine.QUARANTINE`) | Any token that is not USDC, the share token, an asset token or an adapter address | Reverts that sweep only | None |

### Out of the queue (`FlowQueue`, through its libraries)

| Path | Recipient | Token | If the recipient is refused | What a pause does |
|---|---|---|---|---|
| `FlowClaimLib.withdrawExpired` | The request's owner. Anyone may call it | USDC | Reverts. The escrow stays in the queue. Only that owner is harmed, and the open request keeps its epoch open | None |
| `FlowClaimLib.withdrawCredit` | `msg.sender` | USDC and fund shares | Reverts the whole call, the share part included. Only that account is harmed | None |
| `FlowClaimLib.deliver` (`FlowQueue.deposit`, `FlowQueue.mint`) | `receiver`, whose own claims are delivered. Anyone can trigger it | Fund shares | Not applicable: the fund share has no blacklist | None. A frozen settlement holds its claims until the freeze ends |
| `FlowClaimLib.redeemClaims` (`FlowQueue.redeem`) | `receiver`, chosen by the owner. Owner-only call | USDC | Reverts that call. The owner can call again with another receiver | None |
| `FlowClaimLib.sweep` | The fund | USDC and fund shares (dust and gifts above what the queue owes) | Reverts the sweep. The recipient is a protocol contract | None |
| `FlowSettleLib._recordRedeems`, exit fee of a net redemption | `feeRecipient` | USDC | Tolerated: `FeeTransfer.tryPay` fails, the fee joins the queue's dust, `FeeNotPaid` is emitted | Reached only inside `settle` |
| `FlowMatchLib._advanceRedeemMatchIndex`, exit fee of a match | `feeRecipient` | USDC | Tolerated: as above | Reached only inside `settle` |
| `FlowSettleLib.depositSide`, USDC to the fund | The fund, which pulls it through an allowance in `mintInKind` | USDC | Reverts the deposit side only. The side call is isolated (`FlowSettleLib._runSide`) | Reached only inside `settle` |

A cancel pays nothing out. It books a credit (`usdcCredit` or `shareCredit`), which the owner takes with `withdrawCredit`.

### Out of the exclusion ledger (`FundExclusionLedger`)

| Path | Recipient | Token | If the recipient is refused | What a pause does |
|---|---|---|---|---|
| `claim(id, holder)` (`contracts/FundExclusionLedger.sol:187-195`), also through `claimAll(holder)` | `holder` only. Anyone can call it for any holder | USDC | Reverts. See below | None |
| `returnSurplus` | The fund (`VAULT`) | USDC above `heldUsdc` | Reverts. The recipient is a protocol contract | None |
| `sweepForeignToken` | The fund's quarantine address | Any token that is not USDC or the fund share | Reverts that sweep only | None |

**`FundExclusionLedger.claim` today.** The function takes `(id, holder)` and pays `holder`. It has no recipient parameter and no redirect. It updates `claimed`, `claimedUsdc` and `heldUsdc` before the transfer, and the whole call reverts if the transfer fails, so no book changes.

If USDC refuses the claimant:

- Only that claimant is harmed. Their share of every recovery stays in the ledger and cannot be paid to any other address.
- `claimAll(holder)` reverts too, because it calls `claim` for each record.
- Other holders are not affected. Each claim is computed from the holder's own snapshot balance.
- The amount is not swept away. `returnSurplus` sends only the balance above `heldUsdc`, and the unpaid claim stays inside `heldUsdc`.
- A holder that is a contract which cannot receive or move USDC is in the same position.

The MISSED-04 text in chapter 05 asks for a recipient redirect here. The code does not have one.

---

## 3. Reentrancy matrix additions: inherited mutators

Chapter 03's matrix lists the mutators each contract declares. This section lists the external mutators each contract inherits, and `KeeperAccount`'s own mutators, which chapter 05 found missing.

Sources of the inherited functions:

- ERC-20: `transfer`, `approve`, `transferFrom` in `lib/openzeppelin-contracts-upgradeable/contracts/token/ERC20/ERC20Upgradeable.sol:131`, `:155`, `:177`.
- AccessControl: `grantRole`, `revokeRole`, `renounceRole` in `lib/openzeppelin-contracts-upgradeable/contracts/access/AccessControlUpgradeable.sol:143`, `:158`, `:178`.
- UUPS: `upgradeToAndCall` and `freezeUpgrades` in `contracts/lib/GovernedUUPS.sol:224-236`. Each forwards by `delegatecall` to the linked `GovernedUpgrade` library, where `_authorize` requires `msg.sender == upgradeTimelock` and `upgradesFrozen == false` (`contracts/lib/GovernedUUPS.sol:154-158`).

None of these carries `nonReentrant`.

| Contract | Inherited mutator | Guard or access control | External call inside |
|---|---|---|---|
| `RobotMoneyFund` | `transfer`, `transferFrom` | None on the caller beyond balance and allowance. `_update` reverts `SeedSharesLocked` for a transfer from the fund itself (`contracts/RobotMoneyFund.sol:267-272`) | Yes, once the first exclusion record has opened (`x.snapshots`, set in `FundAdminLib.syncExclusions` and never cleared): `_update` calls `FundExclusionLedger.checkpoint(from, to)` before the balances change. The ledger then reads `FlowQueue.queuedSharesOfAt`, a view. Both are protocol contracts |
| `RobotMoneyFund` | `approve` | None | No |
| `RobotMoneyFund` | ERC-4626 `deposit`, `mint`, `redeem`, `withdraw` | Overridden as `view` or `pure` functions that revert (`contracts/RobotMoneyFund.sol:160-171`, `:247`). They are not mutators | No |
| `RobotMoneyFund` | `grantRole`, `revokeRole` | `onlyRole(getRoleAdmin(role))`. `ADMIN_ROLE` is floored by `AdminFloorAccessControlCounter._revokeRole` (`contracts/lib/AdminFloorAccessControlCounter.sol:73-80`). The role admins are in chapter 01's matrix | No |
| `RobotMoneyFund` | `renounceRole` | The caller must be the account. Same floor on `ADMIN_ROLE` | No |
| `RobotMoneyFund` | `upgradeToAndCall` | Upgrade timelock only, never once frozen | Yes: a `staticcall` to `proxiableUUID` on the new implementation, then a `delegatecall` into it when `data` is not empty |
| `RobotMoneyFund` | `freezeUpgrades` | Upgrade timelock only, never once frozen. The live implementation and its code hash must match the arguments | No |
| `FlowQueue` | `grantRole`, `revokeRole`, `renounceRole` | As the fund. `ADMIN_ROLE` is floored by `AdminFloorAccessControl._revokeRole` (`contracts/lib/AdminFloorAccessControl.sol:50-55`) | No |
| `FlowQueue` | `upgradeToAndCall`, `freezeUpgrades` | As the fund | As the fund |
| `Rebalancer` | `grantRole`, `revokeRole`, `renounceRole` | As `FlowQueue` | No |
| `Rebalancer` | `upgradeToAndCall`, `freezeUpgrades` | As the fund | As the fund |
| `RebalanceGovernance` | `grantRole`, `revokeRole`, `renounceRole` | As `FlowQueue`. This branch also floors `TARGET_SETTER_ROLE` in the contract's own `_revokeRole` (`contracts/RebalanceGovernance.sol:129-134`) | No |
| `RebalanceGovernance` | `upgradeToAndCall`, `freezeUpgrades` | As the fund | As the fund |
| `ConsensusRecommendationReceipt` | `grantRole`, `revokeRole`, `renounceRole` | As `FlowQueue`. The contract's own `_revokeRole` also floors `DEFAULT_ADMIN_ROLE` (`contracts/ConsensusRecommendationReceipt.sol:145`) | No |
| `ConsensusRecommendationReceipt` | `upgradeToAndCall`, `freezeUpgrades` | As the fund | As the fund |
| `UniswapV3ExactOutSwapAdapterUpgradeable` | `upgradeToAndCall`, `freezeUpgrades` | As the fund. The contract has no AccessControl and no ERC-20 surface | As the fund |
| `FundExclusionLedger` | None. The contract inherits nothing | Not applicable | Not applicable |
| `KeeperAccount` | `addBotKey`, `removeBotKey`, `addOwner`, `removeOwner` (its own mutators, `contracts/KeeperAccount.sol:77-98`) | `onlyOwner`: any one owner. `removeOwner` refuses the last owner | No. Storage writes and an event only |
| `KeeperAccount` | `execute(target, data)` (`contracts/KeeperAccount.sol:104-111`) | The caller must be a bot key or an owner. `target` must not be the account itself (`SelfCall`) | Yes: one `call` to `target` with `data`, no value. The contract has no reentrancy guard and holds no token. The target's own guard applies (`FlowQueue.settle`, `Rebalancer.step`, `Rebalancer.stepDelisted` are `nonReentrant`) |

What this adds to chapter 03's conclusion:

- The one inherited mutator with an outside call on a user path is the share transfer. Its call goes to the fund's own ledger, and the ledger's only call out is a view on the queue.
- `upgradeToAndCall` runs code of the new implementation. Its guard is the timelock, not a reentrancy lock.
- `KeeperAccount.execute` forwards an arbitrary call as the keeper. It is safe against reentry only because every keeper entry point it is meant to call is `nonReentrant`.

---

## 4. Lending adapters: permissionless functions

The fund's three lending assets use `AaveV3RateAdapter`, `CompoundV3RateAdapter` and `MorphoRateAdapter` (`contracts/script/DeployFund.s.sol`, deployed with the fund as `VAULT`). Each inherits every function of `AaveV3Adapter`, `CompoundV3Adapter` or `MorphoAdapter` unchanged and adds two views, `ratePerUnit` and `availableLiquidity`. The rate adapters add no mutator.

Every other mutator is `onlyVault`: `deploy` (both overloads), `withdraw` (both overloads), and `MorphoAdapter.setMaxExposure`. The two functions below have no access control on any of the three.

### `sweepForeignToken(address token)`

| | `AaveV3Adapter` | `CompoundV3Adapter` | `MorphoAdapter` |
|---|---|---|---|
| Location | `contracts/adapters/AaveV3Adapter.sol:192-197` | `contracts/adapters/CompoundV3Adapter.sol:204-209` | `contracts/adapters/MorphoAdapter.sol:210-215` |
| Who can call | Anyone | Anyone | Anyone |
| Tokens it refuses (`TokenIsProtected`) | `USDC`, `A_TOKEN` | `USDC`, `COMET` (the Comet contract is the position token) | `USDC`, `MORPHO_VAULT` (the vault share) |
| Tokens it moves | The adapter's whole balance of any other token | Same | Same |
| Where they go | `ForeignTokenQuarantine.QUARANTINE`, the constant `0x…deaD11` (`contracts/lib/ForeignTokenQuarantine.sol:49`, `:75-81`). The caller cannot choose the destination | Same | Same |

### `harvestRewards()`

| | `AaveV3Adapter` | `CompoundV3Adapter` | `MorphoAdapter` |
|---|---|---|---|
| Location | `contracts/adapters/AaveV3Adapter.sol:203` | `contracts/adapters/CompoundV3Adapter.sol:215` | `contracts/adapters/MorphoAdapter.sol:221` |
| Who can call | Anyone | Anyone | Anyone |
| What it does | Nothing. The body is empty | Nothing | Nothing |

### Can a caller take fund value, or grief?

Checked for each adapter:

1. **The position.** The fund's value in the adapter is the venue's position token, and USDC in the moment of a deploy or withdraw. Both are refused by the sweep. A caller cannot move either.
2. **The destination.** The sweep sends to one fixed address. No caller receives anything.
3. **A hostile token.** The sweep calls `balanceOf` and `transfer` on a token address the caller supplies. That token can call back, but every other state-changing function of the adapter is `onlyVault`, and the sweep writes no adapter storage. A callback into the fund or the queue arrives as an ordinary outside caller.
4. **Rewards.** A reward token is not protected, and nothing collects it. This is OP-4.
5. **The quarantine address.** The address is a constant. This repository holds no code or key for it, so nothing here shows that a swept token can be recovered.
6. **The fund's own sweep.** `FundFlowsLib._sweepForeign` refuses every asset token and every adapter address, so the fund cannot be made to throw away a position token through its own sweep.

Conclusions:

- **`AaveV3Adapter` / `AaveV3RateAdapter`:** a caller cannot take fund value and cannot block or change any fund operation through these two functions. The one loss possible is a reward token that reaches the adapter (OP-4).
- **`CompoundV3Adapter` / `CompoundV3RateAdapter`:** the same conclusion. Not checked here: whether Comet's rewards contract lets a third party claim rewards to the adapter address. If it does, that third party can send those rewards to quarantine in two calls. They still cannot receive them.
- **`MorphoAdapter` / `MorphoRateAdapter`:** the same conclusion, with the same open point for any reward distributor of the Moonwell vault.

Chapter 02's lending summary (AGY-13) said every mutating operation is `onlyVault`. That is true except for these two functions.

---

## 5. Invariant coverage map

The invariant suite is `contracts/test/prototype/Invariants.t.sol`. Its header names its source: section 7 of `docs/technical/one-vault-rebalancer-proposal.md` (RB-1 to RB-37, with the step 3f wording where it differs). `docs/technical/smart-contract-invariants.md` is the multi-vault ledger. It holds no RB entry, so the map below uses the proposal's list, and adds the rows chapter 05 named (INV-1, INV-2, Check 10, cycle-factor conservation, delisting claim scaling).

The suite never delists an asset: `delistAsset` and `stepDelisted` do not appear in the file. So no invariant below is fuzzed across a delisting sale.

"Scenario test" means a single-path test outside the invariant suite. It is listed so a gap in the fuzzed suite is not read as no test at all.

| Invariant | `invariant_*` function that checks it | Status |
|---|---|---|
| RB-1: only a timelock call sets a target or opens a plan | `invariant_mustNotRevert` (`ghostRb1Violations`) | Covered |
| RB-2: `step()` takes no amounts, assets, floors or recipients | None | **No invariant test.** The property is the function's signature |
| RB-3 and INV-1: no asset leaves to a recipient that is not a holder or a venue | `invariant_noLeak` | Covered |
| RB-4: step cost and plan budget | `invariant_stepBounds` | Covered |
| RB-5: no step on a failed ORA-4 check or inside the interval | `invariant_stepBounds` | Covered |
| RB-6: rebalancing state never blocks a redemption request or its settlement | `invariant_mustNotRevert` (`ghostRequestRedeemReverts`, `ghostInKindReverts`) | Covered |
| RB-7: never past `pathTarget(now)` | `invariant_stepBounds` (`ghostRb7PastPath`) | Covered |
| RB-8 and INV-4: the receipt contract is signalling-only | `invariant_receiptInert` | Covered |
| RB-9: target vector names each active asset once and sums to 10,000 | `invariant_targetVector` | Covered |
| RB-10: nothing leaves the queue before the window ends | `invariant_RB10_RB11_queueExits` | Covered |
| RB-11: deposit shares leave after the hold, to the owner | `invariant_RB10_RB11_queueExits` | Covered |
| RB-12: a blocked round trades nothing | `invariant_RB12_RB15_blockedAndExits` | Covered |
| RB-13 and Check 10: no flow lowers an amount per share | `invariant_RB13_RB16_settlements` (`ghostRb13`) | Covered |
| RB-14: no fill outside its limit | None | Retired in step 3f (the function's NatSpec says so). The suite's header still lists it. Scenario test: `test_RB14_aRequestOutsideTheBoundIsSkippedAndStaysPending` |
| RB-15: a failed pre-trade check changes no state | `invariant_RB12_RB15_blockedAndExits` | Covered |
| RB-16: nothing settles past a failed check or over a cap | `invariant_RB13_RB16_settlements` | Covered |
| RB-17: admission (feed, pool history, lending rate, pool share) | `invariant_RB17_admission` | **Partial.** It checks the feed, its maximum age and the lending rate. Pool history and the pool-share rule are not checked here (the NatSpec points to `FundExtras.t.sol`) |
| RB-18: a freeze is bounded and frozen shares go to their depositor | `invariant_RB18_freezeBounded` | Covered |
| RB-19: a step changes only its two assets and idle USDC; a delisting step trades one asset | None | **No invariant test.** Scenario tests: the `test_RB19_*` tests in `Step3e.t.sol`. The delisting half is not fuzzed at all |
| RB-20: `settle` takes no price and no selection | `invariant_RB20_inputsOnlyLimitWork` | Covered |
| RB-21: a lending claim is a share of the position | `invariant_RB21_positionClaims` | Covered |
| RB-22: the ledger counts queued shares for their owner | `invariant_RB22_ledgerCountsQueuedShares` | Covered |
| RB-23: same matched fraction and price for every request of a side | `invariant_RB23_to_RB36_step3f` asserts `ghostRb23` | **No effective test.** Nothing writes `ghostRb23` (OP-5). Scenario test: `test_RB23_sameRoundRequestsMatchProportionallyAtSamePrice` |
| RB-24: a match changes no fund asset and not the supply | `invariant_RB23_to_RB36_step3f` (`ghostRb24`) | Covered, by one check: a match must carry a share price |
| RB-25: unfilled exits only where no price is forming | `invariant_RB23_to_RB36_step3f` (`ghostRb25`) | Covered |
| RB-26: `redeemInKind` pays only in wind-down | `invariant_RB23_to_RB36_step3f` (`ghostRb26`) | Covered |
| RB-27: only the Safe through the timelock starts or ends a wind-down | `invariant_RB23_to_RB36_step3f` (`ghostRb27`) | Covered |
| RB-28: no deposit settles and no match happens while deposits are stopped | `invariant_RB23_to_RB36_step3f` asserts `ghostRb28` | **No effective test.** Nothing writes `ghostRb28` (OP-5). Scenario test: `test_RB28_depositStopsBlockMatchAndNetDepositAndAllowCancel` |
| RB-29: every fill counts against its side's flow cap | None by name. The cap check after each settlement is booked under RB-16 | **No named invariant test.** Scenario test: `test_RB29_matchedFillsConsumePeriodCaps` |
| RB-30: `settle` reverts if a step traded a basket pool inside the window | `invariant_RB23_to_RB36_step3f` (`ghostRb30`) | Covered |
| RB-31: fee, hold and expiry are fixed at the request; `maxRoll × epochLength` at most the timelock delay | `invariant_RB23_to_RB36_step3f` | **Partial.** Only the `maxRoll × epochLength` bound is asserted. Scenario test: `test_RB31_paramChangesDoNotAffectLockedRequestAndRedemptionDoesNotExpire` |
| RB-32: every emergency pause ends by itself | `invariant_RB23_to_RB36_step3f` (`ghostRb32`, and the `maxPause` bound) | Covered |
| RB-33: no basket asset without a fixed pool fee under the leg band | None | **No invariant test** |
| RB-34: the fund books what an adapter actually paid; claim holders' part is never counted as the fund's | None | **No invariant test.** `invariant_RB21_positionClaims` checks the lending split only |
| RB-35: no step withdraws from a lending venue with claims outstanding | `invariant_RB23_to_RB36_step3f` (`ghostRb35`) | Covered |
| RB-36: the match conserves | `invariant_RB23_to_RB36_step3f` asserts `ghostRb36`; `invariant_conservation` | **Partial.** Nothing writes `ghostRb36` (OP-5). `invariant_conservation` checks the queue's books against its balances and the flows booked. Scenario test: `test_RB36_asymmetricDoubleCapVsCapMatchesConserveSharesAndUsdcToTheUnit` |
| RB-37: basket targets together at most `maxBasketBps` | None. The function's NatSpec says "RB-23 to RB-37" but it has no RB-37 assertion | **No invariant test** |
| INV-2: no stranded assets | None | **No invariant test** |
| Cycle-factor conservation (the deposit and redemption match indexes) | `invariant_conservation` | **Partial.** It bounds live requests and materialized claims by the books (`<=`), and requires the queue's balances to equal its books. It does not recompute a cycle factor |
| Delisting claim scaling | None. The suite never delists | **No invariant test.** Scenario tests: `test_MISSED02_longSalePaysEveryClaimerItsShare` and the other tests of `contracts/test/DelistClaimScaling.t.sol` |
| Solvency and allowance hygiene (no RB number) | `invariant_solvencyAndHygiene` | Covered: NAV above 0 while supply is above 0, the rebalancer and governance hold nothing, no standing allowance |

Summary of the gaps: no invariant test for RB-2, RB-19, RB-29, RB-33, RB-34, RB-37 and INV-2; no effective test for RB-23 and RB-28; partial for RB-17, RB-31, RB-36 and cycle-factor conservation; and nothing in the suite runs a delisting sale.
