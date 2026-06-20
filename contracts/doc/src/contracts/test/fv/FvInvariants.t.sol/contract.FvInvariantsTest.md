# FvInvariantsTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9980411a0c386dea831d9088f37c8a87ba5f15b8/contracts/test/fv/FvInvariants.t.sol)

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

### _assertHolds

Assert an invariant the spec marked 🔴 has been remediated: the
registry now records it HOLDS with no outstanding remediation issue.
Used by the per-ID tests whose remediation has landed so the named
test runs (no longer skipped) and pins the flip green.


```solidity
function _assertHolds(string memory id) internal pure;
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

SUP-5 (FLIPPED GREEN by #966) — redeem never reverts on a stale feed
when the underlying is idle USDC. Fix: `RwaVault.totalAssets`
short-circuits `_checkOracleFreshness` when no priced RWA is held.
Behavioural proof: RwaVault.t.sol::test_staleFeed_idleUsdcRedeemSurvives;
deep harness: StaleOracleRedemption.t.sol::test_SUP5_*.


```solidity
function test_SUP5_expectedFail_idleUsdcRedeemSurvivesStaleFeed() public pure;
```

### test_ADP2_expectedFail_onlyEligibleAdapterPricesNav

ADP-2 (FLIPPED GREEN by #966) — only a codehash-allowlisted adapter
may be onboarded. Fix: `BasketVault.addAsset` reverts
`AdapterCodeHashNotAllowed` for any non-zero adapter whose codehash
ADMIN_ROLE has not approved (NC-2). Behavioural proof:
BasketVault.t.sol venue-selector addAsset tests (codehash-gated).


```solidity
function test_ADP2_expectedFail_onlyEligibleAdapterPricesNav() public pure;
```

### test_ACL3_expectedFail_vaultsAndGatewayHaveAdminFloor

ACL-3 (FLIPPED GREEN by #966) — ADMIN_ROLE on a fund-holding contract
never reaches zero. Fix: BasketVault (→ RwaVault) and the Gateway (via
AccessRoles) now inherit `AdminFloorAccessControl`; the gateway also
floors `DEFAULT_ADMIN_ROLE` (F-06).


```solidity
function test_ACL3_expectedFail_vaultsAndGatewayHaveAdminFloor() public pure;
```

### test_ACL5_expectedFail_emergencyOverrideIsHigherTier

ACL-5 (FLIPPED GREEN by #966) — the stale-override setter sits at a
higher tier than the unwind executor. Fix:
`RwaVault.setEmergencyUnwindStaleOverride` is ADMIN_ROLE while
`emergencyUnwind` stays EMERGENCY_ROLE (F-08). Behavioural proof:
RwaVault.t.sol::test_emergencyUnwindStaleOverride_requiresAdminNotEmergency.


```solidity
function test_ACL5_expectedFail_emergencyOverrideIsHigherTier() public pure;
```

### test_ORA3_expectedFail_twapPoolEqualsExecutionPool

ORA-3 (FLIPPED GREEN by #966) — the TWAP pricing pool equals the
execution pool; addAsset reverts on mismatch. Fix:
`BasketVault.addAsset` asserts the registered pool's fee/tickSpacing
equals `swapFee_` (F-09). Deep harness:
DeployAssertions.t.sol::test_ORA3_addAssetRevertsOnPoolMismatch.


```solidity
function test_ORA3_expectedFail_twapPoolEqualsExecutionPool() public pure;
```

### test_ORA7_expectedFail_slippageFloorIsIndependentBackstop

ORA-7 (FLIPPED GREEN by #966) — realized loss under TWAP manipulation
is bounded by an independent backstop (the configured
`maxSlippageBps`/pool-fee floor and the codehash-pinned, pool-equality-
enforced adapter), not the co-manipulable NAV TWAP alone. Deep
harness: TwapManipulation.t.sol::test_ORA7_independentFloorBoundsLossUnderManipulation.


```solidity
function test_ORA7_expectedFail_slippageFloorIsIndependentBackstop() public pure;
```

### test_LIFE3_expectedFail_pauseNeverFreezesWithdrawals

LIFE-3 (FLIPPED GREEN by #966) — vault pause disables deposits only,
never withdrawals (basket family). Fix: `BasketVault._withdraw` is no
longer `whenNotPaused`; pause is a deposits-only freeze (NC-3).
Behavioural proof: BasketVault.t.sol pause tests (withdrawals stay open).


```solidity
function test_LIFE3_expectedFail_pauseNeverFreezesWithdrawals() public pure;
```

### test_LIFE4_expectedFail_withdrawalBlockIsAlwaysReversible

LIFE-4 (FLIPPED GREEN by #966) — depositor funds are never permanently
frozen. Fix: withdrawals are never paused (LIFE-3) and the last-admin
floor (AdminFloorAccessControl) keeps a still-available authority, so
no reachable state freezes withdrawals forever (F-06 + NC-3).


```solidity
function test_LIFE4_expectedFail_withdrawalBlockIsAlwaysReversible() public pure;
```

### test_LIFE5_expectedFail_reweightKeepsPositionRedeemable

LIFE-5 (FLIPPED GREEN by #967, F-02/F-03) — a reweight/removal
never makes an existing holder's position unredeemable through the
router. Proof: deposit into vaultA, then reweight the router 100%
onto vaultB and Retire vaultA. The holder still redeems the vaultA
position through `redeemFor` by naming it explicitly — the redeem
path no longer iterates the live weight vector, and a Retired leg
(only Paused is blocked) is still redeemable.


```solidity
function test_LIFE5_expectedFail_reweightKeepsPositionRedeemable() public;
```

### test_RTR2_expectedFail_redeemTargetsActualPositions

RTR-2 (FLIPPED GREEN by #967, F-03) — a multi-leg redemption
targets the holder's actual positions, not the current weight
vector. Proof: a holder with positions in vaultA AND vaultB
redeems both by naming them explicitly, even after the router has
been reweighted onto a third vault that the holder never held.


```solidity
function test_RTR2_expectedFail_redeemTargetsActualPositions() public;
```

### test_RTR3_expectedFail_legsAreIdentityBound

RTR-3 (FLIPPED GREEN by #967, NC-5) — `sharesPerLeg[i]` is
identity-bound to the vault the caller named (`vaults[i]`), never
to whichever vault occupies index i after a reweight. Proof: the
holder names vaultA; even after the weight vector is reordered so
index 0 points at vaultB, the redeem hits exactly vaultA — vaultB
is untouched.


```solidity
function test_RTR3_expectedFail_legsAreIdentityBound() public;
```

### test_LIFE1_retireSyncsRegistryAndVaultFlag

LIFE-1 (F-04) — a retired/paused vault never accepts new deposits
on any path, with registry status and the vault flag always in
sync. Proves the `setVaultStatus` back-door is closed: it now drives
the vault's `retired` deposit-halt flag, and the atomic
`retire()`/`reactivate()` paths still sync both.


```solidity
function test_LIFE1_retireSyncsRegistryAndVaultFlag() public;
```

### test_RTR4_weightsRequireActiveStatus

RTR-4 (F-05) — a weight vector is never executable unless every
weighted vault is router-eligible AND Active. setWeights and
setDefaultWeights revert when any weighted vault is Paused/Retired.


```solidity
function test_RTR4_weightsRequireActiveStatus() public;
```

### test_RTR5_previewMatchesExecute

RTR-5 (F-13/NC-4) — previewDeposit and the executed deposit never
disagree on which legs are available. A single non-Active leg is
skipped (not reverted), exactly as preview reports; the surviving
leg absorbs the renormalised amount — one paused vault never bricks
the whole router deposit (NC-4).


```solidity
function test_RTR5_previewMatchesExecute() public;
```

### test_GOV4_proposalCannotSelfDosRouter

GOV-4 (F-05/RTR-4) — a governance proposal that would render router
deposits non-executable can never be executed. propose() rejects a
weight vector containing a Paused/Retired vault up front, so a
self-DoS proposal never enters the voting pipeline.


```solidity
function test_GOV4_proposalCannotSelfDosRouter() public;
```

### _deployRouterStack

Deploy a registry + router + one eligible, Active, registry-linked
vault. This test contract is the ADMIN_ROLE on both registry and
router and the registry is the vault's link, so `setVaultStatus` can
drive the vault's retire/unretire legs.


```solidity
function _deployRouterStack()
    internal
    returns (
        VaultRegistry registry,
        PortfolioRouter router,
        FvUSDC usdc,
        FvRetirableVault vault
    );
```

### _addEligibleVault

Register a fresh registry-linked vault, mark it Active + eligible.


```solidity
function _addEligibleVault(VaultRegistry registry, PortfolioRouter, FvUSDC usdc)
    internal
    returns (FvRetirableVault vault);
```

### _setSingleWeight

Set the router's voted weight vector to a single vault at 100%.


```solidity
function _setSingleWeight(PortfolioRouter router, address vault) internal;
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

LIFE-6 (FLIPPED GREEN by #970) — reabsorbRemovedAsset never
reverts-and-strands a reappeared balance: on a degraded pool whose
TWAP `observe()` reverts, it falls back to a permissionless sweep to
the governed quarantine address rather than stranding the balance,
and addAsset re-adding a token reuses its inactive entry instead of
duplicating. Deep proofs: BasketVault.t.sol::test_LIFE6_* /
test_NC8_addAsset_*.


```solidity
function test_LIFE6_expectedFail_reabsorbSurvivesDegradedPool() public pure;
```

### test_GW2_expectedFail_idempotencyKeyBindsFullIntent

GW-2 (FLIPPED GREEN by #970) — a single paymentId/idempotency key
never authorizes two materially different execution intents: the
depositTo paymentId binds `destination` and `minSharesPerLeg`, so
two calls sharing (orderId, amount, idempotencyKey) but routing to a
different destination (or carrying a different per-leg floor) yield
different paymentIds. Deep proofs: GatewayRouter.t.sol::test_GW2_*.


```solidity
function test_GW2_expectedFail_idempotencyKeyBindsFullIntent() public pure;
```

### test_ACL7_expectedFail_agentRegistrationCannotBlockRoleGrant

ACL-7 (FLIPPED GREEN by #970) — registering an agent never blocks a
future intended ADMIN/PAUSER address from being granted its role:
the DeployTimelock handover asserts each intended admin/pauser
address is AGENT-free before granting, turning the role-separation
grant-DoS into an explicit deploy-time precondition. Deep proof:
DeployAssertions.t.sol::test_ACL7_agentRegistrationCannotBlockRoleGrant.


```solidity
function test_ACL7_expectedFail_agentRegistrationCannotBlockRoleGrant() public pure;
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

