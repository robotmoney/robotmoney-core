# FvInvariantsTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/bbd073193d1d67c94858c60d78b8e0c2e1bef608/contracts/test/fv/FvInvariants.t.sol)

**Inherits:**
Test


## Functions
### _skipRed

Helper: skip with a uniform "<reason> - remediation #<issue>" message,
pulling the issue number straight from the registry so the name, the
skip reason, and the coverage map can never drift.


```solidity
function _skipRed(string memory id, string memory reason) internal;
```

### test_holdingInvariants_areAllNonRed

AC2: every invariant the spec marks holding/proven has a passing
FV test. The deep proofs live in the dedicated suites; this
aggregate asserts each HOLDS ID is registered non-RED, so the set
of "green" invariants is exactly the spec's non-🔴 set. (RED IDs
are covered by their named expected-fail tests below.)


```solidity
function test_holdingInvariants_areAllNonRed() public pure;
```

### test_ACL1_eoaHoldsNoRoleAfterHandover

ACL-1 — no EOA holds any privileged role after handover.
REMEDIATED by #965 (F-01): the DeployTimelock handover now also
hands the Gateway DEFAULT_ADMIN_ROLE to the Timelock and moves
every vault EMERGENCY_ROLE to an independent hot key, so the
deployer EOA retains nothing. Registry flipped RED→HOLDS; the deep
proofs live in DeployAssertions.t.sol::test_ACL1_* and
DeployTimelock.t.sol::test_ACL1_*.


```solidity
function test_ACL1_eoaHoldsNoRoleAfterHandover() public pure;
```

### test_SUP5_expectedFail_idleUsdcRedeemSurvivesStaleFeed

SUP-5 — redeem never reverts on stale feed when underlying is idle
USDC. Deep harness: StaleOracleRedemption.t.sol::test_SUP5_*.


```solidity
function test_SUP5_expectedFail_idleUsdcRedeemSurvivesStaleFeed() public;
```

### test_ADP2_expectedFail_onlyEligibleAdapterPricesNav

ADP-2 — only an eligible (allowlisted + codehash-pinned) adapter
contributes to NAV / receives funds (BasketVault.addAsset vets it).


```solidity
function test_ADP2_expectedFail_onlyEligibleAdapterPricesNav() public;
```

### test_ACL3_expectedFail_vaultsAndGatewayHaveAdminFloor

ACL-3 — ADMIN_ROLE on a fund-holding contract never reaches zero.


```solidity
function test_ACL3_expectedFail_vaultsAndGatewayHaveAdminFloor() public;
```

### test_ACL5_expectedFail_emergencyOverrideIsHigherTier

ACL-5 — an emergency action can only de-risk; the stale-override
setter sits at a higher tier than the unwind it enables.


```solidity
function test_ACL5_expectedFail_emergencyOverrideIsHigherTier() public;
```

### test_ORA3_expectedFail_twapPoolEqualsExecutionPool

ORA-3 — the TWAP pricing pool equals the execution pool;
addAsset reverts on mismatch. Deep harness:
DeployAssertions.t.sol::test_ORA3_*.


```solidity
function test_ORA3_expectedFail_twapPoolEqualsExecutionPool() public;
```

### test_ORA7_expectedFail_slippageFloorIsIndependentBackstop

ORA-7 — the slippage floor is an independent backstop, not the same
TWAP that prices the trade. Deep harness:
TwapManipulation.t.sol::test_ORA7_*.


```solidity
function test_ORA7_expectedFail_slippageFloorIsIndependentBackstop() public;
```

### test_LIFE3_expectedFail_pauseNeverFreezesWithdrawals

LIFE-3 — vault shutdown/pause disables deposits only, never blocks
withdrawals (basket family).


```solidity
function test_LIFE3_expectedFail_pauseNeverFreezesWithdrawals() public;
```

### test_LIFE4_expectedFail_withdrawalBlockIsAlwaysReversible

LIFE-4 — depositor funds are never permanently frozen; a blocking
state is always reversible by a still-available authority.


```solidity
function test_LIFE4_expectedFail_withdrawalBlockIsAlwaysReversible() public;
```

### test_LIFE5_expectedFail_reweightKeepsPositionRedeemable

LIFE-5 — a reweight/removal never makes an existing holder's
position unredeemable through the protocol (router path).


```solidity
function test_LIFE5_expectedFail_reweightKeepsPositionRedeemable() public;
```

### test_RTR2_expectedFail_redeemTargetsActualPositions

RTR-2 — a multi-leg redemption targets the holder's actual
positions, not the current weight vector.


```solidity
function test_RTR2_expectedFail_redeemTargetsActualPositions() public;
```

### test_RTR3_expectedFail_legsAreIdentityBound

RTR-3 — sharesPerLeg[i] is identity-bound to the intended vault,
never to whichever vault occupies index i after a reweight.


```solidity
function test_RTR3_expectedFail_legsAreIdentityBound() public;
```

### test_LIFE1_expectedFail_retireSyncsRegistryAndVaultFlag

LIFE-1 — a retired vault never accepts new deposits on any path,
with registry status and vault flag always in sync.


```solidity
function test_LIFE1_expectedFail_retireSyncsRegistryAndVaultFlag() public;
```

### test_RTR4_expectedFail_weightsRequireActiveStatus

RTR-4 — a weight vector is never executable unless every weighted
vault is router-eligible AND Active and bps sum to MAX_BPS.


```solidity
function test_RTR4_expectedFail_weightsRequireActiveStatus() public;
```

### test_RTR5_expectedFail_previewMatchesExecute

RTR-5 — previewDeposit and the executed deposit never disagree on
which legs are available.


```solidity
function test_RTR5_expectedFail_previewMatchesExecute() public;
```

### test_GOV4_expectedFail_proposalCannotSelfDosRouter

GOV-4 — a governance action that would render router deposits
non-executable can never be executed.


```solidity
function test_GOV4_expectedFail_proposalCannotSelfDosRouter() public;
```

### test_SUP3_expectedFail_roundTripNeverProfits

SUP-3 — a deposit-then-redeem round trip never returns more than
was put in: previewRedeem(previewDeposit(x)) <= x.


```solidity
function test_SUP3_expectedFail_roundTripNeverProfits() public;
```

### test_GW5_expectedFail_agentRedeemCarriesRealFloor

GW-5 — every agent redemption carries a real, caller-meaningful
per-leg slippage floor.


```solidity
function test_GW5_expectedFail_agentRedeemCarriesRealFloor() public;
```

### test_LIFE6_expectedFail_reabsorbSurvivesDegradedPool

LIFE-6 — reabsorbRemovedAsset never reverts-and-strands a
reappeared balance (survives a degraded pool).


```solidity
function test_LIFE6_expectedFail_reabsorbSurvivesDegradedPool() public;
```

### test_GW2_expectedFail_idempotencyKeyBindsFullIntent

GW-2 — a single paymentId/idempotency key never authorizes two
materially different execution intents.


```solidity
function test_GW2_expectedFail_idempotencyKeyBindsFullIntent() public;
```

### test_ACL7_expectedFail_agentRegistrationCannotBlockRoleGrant

ACL-7 — registering an agent never blocks a future intended
ADMIN/PAUSER address from being granted its role.


```solidity
function test_ACL7_expectedFail_agentRegistrationCannotBlockRoleGrant() public;
```

### test_RTR6_expectedFail_capBoundsCumulativeExposure

RTR-6 — a configured cap bounds cumulative exposure, not just a
single transaction.


```solidity
function test_RTR6_expectedFail_capBoundsCumulativeExposure() public;
```

### test_FEE2_expectedFail_feeChargedOnRealizedProceeds

FEE-2 — a fee is always charged on realized proceeds, never on a
share-implied gross that socializes loss to remaining holders.


```solidity
function test_FEE2_expectedFail_feeChargedOnRealizedProceeds() public;
```

