# Deploy 4 verification

## DEP-01 — P2: Fund verification does not read back fee recipient or asset configuration

`publish-contracts/src/verify/fund.ts:126-135` checks that the fund has five
assets, compares the first three values from `config()` to the sheet, and checks
seed, max-slippage and NAV guard values. `config()` returns a fourth value,
the fee recipient, but the verifier destructures only `[tvl, per, fee]` at
lines 128-131. It never compares that address with the deployment sheet.

The verifier also does not call `assetConfig(i)` or `assetConfigs()`. The
prototype exposes both views at `contracts/test/prototype/src/RobotMoneyFund.sol:492-498`.
The deployment sheet parses `feeRecipient` and `lendingCapBps` at
`publish-contracts/src/sheet.ts:591-613, 630-633`, but
`publish-contracts/src/verify-fund-stage.ts:12-20` omits them from the
`VerifySheet.fund` passed to the verifier. A repository-wide search of
`publish-contracts/src` found no other fund verification path reading those
asset configurations or the fund fee recipient.

If a Deploy 4 script or handover leaves an unexpected asset order, adapter,
token, pool, feed, feed age or lending `capBps`, the current verifier can pass
as long as the asset count is five and the other checked fields match. A
wrong fee recipient can pass for the same reason. This defeats the post-deploy
check that the fund configuration matches the reviewed sheet; for example, a
larger-than-intended lending cap or fee destination can be accepted as a
verified rehearsal state.

**Remedy:** carry the expected fee recipient and ordered asset configuration
through `VerifySheet`, then read back and compare every asset field and the
fourth `config()` result. Include negative verifier cases for a single-field
mismatch in each category.

The verifier's module comment says it checks the fund run's postconditions and
fund configuration (`publish-contracts/src/verify/fund.ts:1-3`). No other
stage evidence or postcondition checker for these fields was found in the
reviewed publish-contracts sources.

## Second-pass validation and scope correction

The expanded review retained this finding. A synthetic ChainReader invoking the real verifier returned a wrong fee recipient while all 114 checks passed; a wrong TVL cap failed as a negative control. Asset-config omission is statically confirmed, not independently mutated in that probe. See chapters 05 and 07. The scenario requires incorrect or altered deployed state: normal deploy scripts' initialization/assertions reduce that risk. This finding is incomplete postcondition assurance, not evidence that those scripts routinely produce the wrong configuration or that an outsider can change it.
