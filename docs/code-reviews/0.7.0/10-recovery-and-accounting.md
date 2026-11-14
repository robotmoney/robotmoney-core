# Recovery and queued-share accounting

Third-pass static trace at source `176770892`. This chapter records candidate attacks and the guards encountered, without claiming executed recovery scenarios.

## Queued shares retain snapshot ownership

The fund's `ledgerBalanceOf` excludes the queue address and attributes wallet plus queued shares to each user (`RobotMoneyFund.sol:371-375`). A redemption request checkpoints its recipient before increasing queued ownership, then transfers the sender's shares (`FlowClaimLib.sol:79-84`); the fund transfer hook checkpoints the sender before its wallet balance falls (`RobotMoneyFund.sol:277-281`). This also covers different sender and recipient addresses. Cancellation converts escrow to credit without changing the owner's queued total (`FlowClaimLib.sol:106-113`). Delivery checkpoints before decreasing queued shares and returning them to the wallet (`FlowClaimLib.sol:196-215`). These paired transitions prevent a queue transfer alone from erasing or duplicating the snapshot claim.

Settlement burns queue shares before recording individual redeem fills, but the owner's queued balance remains available until its checkpoint at `FlowSettleLib.sol:581-582`. The earlier exclusion's supply is fixed in the ledger; the later burn does not rewrite it. `FundExclusionLedger.sol:301-315` selects the first checkpoint at or after the snapshot and otherwise reads the unchanged attributed balance. No misattribution was established in this trace.

## Position claims versus recovery

A drain reserves deferred amounts and the claim holders' rounded-up position share before withdrawing the fund holders' portion (`FundPositionLib.sol:95-122`). Restore credits that withdrawal to the exclusion record before finalizing it (`FundAdminLib.sol:292-297`). Position claim withdrawal clears units before interacting, requires the actual USDC delta to meet its amount, and reverts atomically on shortfall (`FundPositionLib.sol:286-310`). Asset admission rejects reuse of an inactive adapter while position claims remain (`FundAdminLib.sol:130-134`). These controls address duplicate claim backing, recovery paid to later holders, and partial claim consumption.

## Short restoration withdrawal: candidate bounded by adapter guarantees

`drain` treats a nonreverting withdrawal as success and `_restore` finalizes on that success; it does not independently prove all holders' value was drained. A hypothetical admitted adapter returning a successful short fill could leave value behind when the old exclusion is closed. This is a candidate for adversarial adapter testing, not a confirmed supported-path finding: the reviewed Aave adapter rejects actual amounts below the finite request (`contracts/adapters/AaveV3Adapter.sol:143-148`), and the Compound adapter does likewise (`contracts/adapters/CompoundV3Adapter.sol:136-155`). Their rate-adapter wrappers inherit these paths. The short-paying mechanical mock does not by itself demonstrate that an intended deployed adapter can reach this state.

No EVM recovery, repeated total-loss recapitalization, malicious adapter, or cross-exclusion sequence was executed. Those remain explicit limits rather than implied safety proofs.
