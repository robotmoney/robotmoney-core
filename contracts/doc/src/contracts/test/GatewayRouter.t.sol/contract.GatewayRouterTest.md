# GatewayRouterTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/565d7a4ab968179b6f0a1db9f9fe724a77abadce/contracts/test/GatewayRouter.t.sol)

**Inherits:**
Test

**Title:**
GatewayRouterTest

Tests for gateway.depositTo routing through the PortfolioRouter.
Covers: AC1 (router deposit), AC2 (policy restriction), AC3 (invalid
destination), AC4 (AgentDepositRouted event), AC5 (single-vault path
unaffected).


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### MAX_PER_PAYMENT

```solidity
uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC
```


### MAX_PER_WINDOW

```solidity
uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
MockVault internal vault
```


### registry

```solidity
VaultRegistry internal registry
```


### vaultA

```solidity
RouterMockVault internal vaultA
```


### vaultB

```solidity
RouterMockVault internal vaultB
```


### router

```solidity
PortfolioRouter internal router
```


### gateway

```solidity
RobotMoneyGateway internal gateway
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### pauser

```solidity
address internal pauser = makeAddr("pauser")
```


### agent

```solidity
address internal agent = makeAddr("agent")
```


### otherAgent

```solidity
address internal otherAgent = makeAddr("otherAgent")
```


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _policyWithRouter


```solidity
function _policyWithRouter() internal view returns (IGateway.AgentPolicy memory);
```

### _policyWithVaultOnly


```solidity
function _policyWithVaultOnly() internal view returns (IGateway.AgentPolicy memory);
```

### _policyOpenDestinations


```solidity
function _policyOpenDestinations() internal view returns (IGateway.AgentPolicy memory);
```

### _authorize


```solidity
function _authorize(address who, IGateway.AgentPolicy memory p) internal;
```

### _fundAndApprove


```solidity
function _fundAndApprove(address who, uint256 amt) internal;
```

### test_gatewayRouter_constructor_wiresRouter

Verify router is wired into the gateway.


```solidity
function test_gatewayRouter_constructor_wiresRouter() public view;
```

### test_gatewayRouter_constructor_noRouter_returnsZero

A gateway deployed without a router address returns zero.


```solidity
function test_gatewayRouter_constructor_noRouter_returnsZero() public;
```

### test_depositTo_router_happyPath_proportionalReceipts

AC1: Agent with router-allowed policy calls depositTo(router) and
receives proportional vault receipts split across vaultA and vaultB.


```solidity
function test_depositTo_router_happyPath_proportionalReceipts() public;
```

### test_depositTo_router_slippageReverts

AC1: slippage protection: when minSharesPerLeg is set and the vault
returns fewer shares than the minimum, the whole call reverts.


```solidity
function test_depositTo_router_slippageReverts() public;
```

### test_depositTo_router_revertsWhenNotInAllowedDestinations

AC2: Agent whose allowedDestinations contains only the vault cannot
call depositTo with destination=router.


```solidity
function test_depositTo_router_revertsWhenNotInAllowedDestinations() public;
```

### test_depositTo_openDestinations_allowsVaultAndRouter

AC2: An agent with an open allowedDestinations list (empty array) can
route to either the pinned vault or the router.


```solidity
function test_depositTo_openDestinations_allowsVaultAndRouter() public;
```

### test_GW2_depositTo_paymentIdBindsDestination

GW-2 / NC-9 (FLIPPED GREEN by #970): a single paymentId/idempotency
key never authorizes two MATERIALLY DIFFERENT execution intents. The
depositTo paymentId now folds the routing `destination` and the
per-leg `minSharesPerLeg` vector into its preimage, so two depositTo
calls sharing the same (orderId, amount, idempotencyKey) but routing
to a DIFFERENT destination produce DIFFERENT paymentIds — neither is
silently swallowed as a replay of the other. Deep proof referenced by
FvInvariants.t.sol::test_GW2_*.


```solidity
function test_GW2_depositTo_paymentIdBindsDestination() public;
```

### test_GW2_depositTo_paymentIdBindsMinSharesPerLeg

GW-2 / NC-9: the per-leg slippage vector `minSharesPerLeg` is also
bound into the paymentId, so two router deposits sharing the same
(orderId, amount, idem) but carrying a DIFFERENT per-leg floor are
distinct intents and never collide.


```solidity
function test_GW2_depositTo_paymentIdBindsMinSharesPerLeg() public;
```

### test_depositTo_revertsOnArbitraryDestination

AC3: Destination that is neither a registered vault nor the router
reverts with InvalidDestination.


```solidity
function test_depositTo_revertsOnArbitraryDestination() public;
```

### test_depositTo_revertsWhenRouterNotConfigured

AC3: When router is address(0) (no router configured), attempting to
call depositTo with any destination that is not the pinned vault reverts.


```solidity
function test_depositTo_revertsWhenRouterNotConfigured() public;
```

### _findRoutedEvent

Helper: search recorded logs for AgentDepositRouted and return the log
index if found, or type(uint256).max if not found.


```solidity
function _findRoutedEvent(Vm.Log[] memory logs) internal view returns (uint256);
```

### test_depositTo_router_emitsAgentDepositRoutedEvent

AC4: AgentDepositRouted event includes router address and per-leg share
amounts when routing through the router.


```solidity
function test_depositTo_router_emitsAgentDepositRoutedEvent() public;
```

### _assertRoutedEventData

Decode and assert non-indexed fields of an AgentDepositRouted log.


```solidity
function _assertRoutedEventData(bytes memory data, uint256 expectedAmount) internal view;
```

### test_deposit_singleVault_unaffectedByRouter

AC5: The original `deposit()` call to the pinned vault still works
correctly when a router is configured.


```solidity
function test_deposit_singleVault_unaffectedByRouter() public;
```

### test_depositTo_vaultDestination_routesToPinnedVault

AC5: depositTo with destination=vault routes correctly to the pinned
vault and emits AgentDeposit (not AgentDepositRouted).


```solidity
function test_depositTo_vaultDestination_routesToPinnedVault() public;
```

### test_depositTo_revertsOnZeroAmount

depositTo enforces zero-amount check.


```solidity
function test_depositTo_revertsOnZeroAmount() public;
```

### test_depositTo_revertsOnDeadlineTooFar

depositTo enforces deadline too far.


```solidity
function test_depositTo_revertsOnDeadlineTooFar() public;
```

### test_depositTo_revertsOnExpiredPolicy

depositTo enforces expired policy.


```solidity
function test_depositTo_revertsOnExpiredPolicy() public;
```

### test_depositTo_revertsWhenPaused

depositTo enforces the paused check.


```solidity
function test_depositTo_revertsWhenPaused() public;
```

### test_depositTo_revertsOnPerPaymentCapExceeded

depositTo enforces per-payment cap.


```solidity
function test_depositTo_revertsOnPerPaymentCapExceeded() public;
```

### test_depositTo_revertsOnExpiredDeadline

depositTo enforces deadline bounds.


```solidity
function test_depositTo_revertsOnExpiredDeadline() public;
```

### test_depositTo_revertsOnReplay

depositTo enforces idempotency.


```solidity
function test_depositTo_revertsOnReplay() public;
```

### test_depositTo_revertsOnWindowCapExceeded

depositTo enforces window cap.


```solidity
function test_depositTo_revertsOnWindowCapExceeded() public;
```

### test_depositTo_revertsForUnauthorizedCaller

depositTo requires AGENT_ROLE.


```solidity
function test_depositTo_revertsForUnauthorizedCaller() public;
```

### test_depositTo_routerPath_revertsOnUsdcCustodyInvariant

`depositTo` router path: post-call USDC custody invariant — a router
that under-pulls USDC leaves the gateway holding leftover stablecoin.


```solidity
function test_depositTo_routerPath_revertsOnUsdcCustodyInvariant() public;
```

### test_depositTo_revertsOnFeeOnTransferToken

`depositTo` detects fee-on-transfer tokens just like `deposit`.


```solidity
function test_depositTo_revertsOnFeeOnTransferToken() public;
```

### test_depositTo_vaultPath_ignoresPreexistingDonatedShares

Preexisting donated shares do not brick the vault deposit path.


```solidity
function test_depositTo_vaultPath_ignoresPreexistingDonatedShares() public;
```

### test_depositTo_vaultPath_revertsOnPostCallShareCustody

`depositTo` vault path: post-call share custody invariant —
a vault that leaks shares back to the gateway trips the invariant.


```solidity
function test_depositTo_vaultPath_revertsOnPostCallShareCustody() public;
```

### test_depositTo_vaultPath_revertsOnPostCallUsdcCustody

`depositTo` vault path: post-call USDC custody invariant — a vault that
under-pulls USDC leaves the gateway holding leftover stablecoin.


```solidity
function test_depositTo_vaultPath_revertsOnPostCallUsdcCustody() public;
```

### test_depositTo_windowCap_enforcesSnapshotValue

AC1 / Test-plan structural check: depositTo() must not re-read
agents[msg.sender].maxPerWindow from storage at the window-cap call
site. Post-fix the window cap is enforced using args.maxPerWindow
(captured from the in-memory snapshot p inside the scoped block).
We verify this behaviourally: use vm.store to set maxPerWindow in
storage to a lower value BEFORE the depositTo call (so the snapshot
p also captures this value). The window-cap check must enforce the
snapshot value. We then confirm the revert is WindowCapExceeded (not
some other error), proving the check uses the snapshot field, not a
constant or an unrelated storage slot.


```solidity
function test_depositTo_windowCap_enforcesSnapshotValue() public;
```

### test_depositTo_windowCap_usesSnapshotNotSecondStorageRead

AC2 / Test-plan storage-slot manipulation: use vm.store to write a
higher maxPerWindow into the agents mapping slot after the policy is
set, then call depositTo and verify the window cap reflects the
updated storage value (which is also what the in-memory snapshot
captures at call time). A further deposit that would exceed even
the new cap must still revert with WindowCapExceeded, proving the
snapshot is enforced end-to-end.
Storage layout (forge inspect RobotMoneyGateway storageLayout):
slot 3  → agents mapping (slot 2 is commitments, added by #507)
AgentPolicy struct offsets from the mapping element base:
+0 → active (bool) + validUntil (uint64, packed)
+1 → maxPerPayment (uint256)
+2 → maxPerWindow  (uint256)   ← target slot


```solidity
function test_depositTo_windowCap_usesSnapshotNotSecondStorageRead() public;
```

### test_depositTo_gasReduction_singleSnapshotSLOAD

AC3 / Test-plan gas snapshot: depositTo gas cost must be lower than
it would be with an extra cold SLOAD (2100 gas). We compare the gas
consumed by depositTo against deposit (the reference implementation
that uses a single snapshot). The two functions share the same policy
read pattern post-fix, so their gas delta on the policy-read path is
zero. A fixed upper-bound on total gas is also asserted to catch
regressions.
Note: both functions have different stack work (depositTo builds
DepositArgs), so the absolute gas figures differ. The key invariant
is that depositTo no longer performs a second SLOAD for maxPerWindow.


```solidity
function test_depositTo_gasReduction_singleSnapshotSLOAD() public;
```

### test_depositTo_and_deposit_enforceIdenticalWindowCap

AC4 / deposit() and depositTo() must use identical policy-read
patterns. Verify that both functions enforce the window cap at the
same threshold when given equivalent policies.


```solidity
function test_depositTo_and_deposit_enforceIdenticalWindowCap() public;
```

### _policyWithRouterWithdrawal

Helper: policy with withdrawal enabled from router vaults.


```solidity
function _policyWithRouterWithdrawal() internal returns (IGateway.AgentPolicy memory);
```

### _routerDepositAndGetShares

Deposit via router and return the shares minted per leg.


```solidity
function _routerDepositAndGetShares(address who, uint256 amount)
    internal
    returns (uint256 sharesA, uint256 sharesB);
```

### _routerVaults

The two-leg router vault set [vaultA, vaultB] (60/40), now passed
explicitly to withdrawFromRouter and committed to the paymentId
intent hash (issue #967).


```solidity
function _routerVaults() internal view returns (address[] memory vaults);
```

### test_withdrawFromRouter_happyPath

router: happy path — deposit via router, withdraw via router, USDC lands at assetRecipient.


```solidity
function test_withdrawFromRouter_happyPath() public;
```

### test_withdrawFromRouter_realFloor_revertsBelowMinimum

GW-5 / F-11: a router redemption carrying a real, non-trivial
`minAssetsPerLeg` reverts when realized assets fall below the floor.
The gateway forwards the caller-supplied floor verbatim to the
router (it no longer hardcodes an all-zero vector), so the router's
per-leg `SlippageExceeded` guard bites.


```solidity
function test_withdrawFromRouter_realFloor_revertsBelowMinimum() public;
```

### test_withdrawFromRouter_realFloor_passesWhenMet

GW-5 / F-11: a satisfiable real floor passes through and the
redemption settles normally (the floor is meaningful, not a no-op).


```solidity
function test_withdrawFromRouter_realFloor_passesWhenMet() public;
```

### test_withdrawFromRouter_revertsOnMinAssetsLengthMismatch

GW-5 / F-11: the per-leg floor vector must be parallel to the share
vector — a length mismatch reverts before any state effect.


```solidity
function test_withdrawFromRouter_revertsOnMinAssetsLengthMismatch() public;
```

### test_withdrawFromRouter_floorIsBoundIntoPaymentId

GW-5 / F-11: the floor vector is bound into `paymentId`, so two
otherwise-identical orders that differ only in their floor produce
distinct ids — a replay cannot re-run an order under a weaker floor.


```solidity
function test_withdrawFromRouter_floorIsBoundIntoPaymentId() public;
```

### test_withdrawFromRouter_paymentIdUsesOpWithdrawRouterPrefix

router: the withdrawFromRouter paymentId preimage carries the
OP_WITHDRAW_ROUTER (= 4) op-kind prefix so router-withdrawal ids are
namespaced away from the three sibling op kinds (audit 2026-06-09, L-12).


```solidity
function test_withdrawFromRouter_paymentIdUsesOpWithdrawRouterPrefix() public;
```

### test_withdrawFromRouter_allowedSourceVaults_rejectsUnlisted

router: allowedSourceVaults enforced — vault not in list reverts.


```solidity
function test_withdrawFromRouter_allowedSourceVaults_rejectsUnlisted() public;
```

### test_withdrawFromRouter_revertsOnPerPaymentCapExceeded

router: per-payment cap enforced (totalShares > maxWithdrawPerPayment).


```solidity
function test_withdrawFromRouter_revertsOnPerPaymentCapExceeded() public;
```

### test_withdrawFromRouter_revertsOnWindowCapExceeded

router: window cap enforced — second call in same window reverts.


```solidity
function test_withdrawFromRouter_revertsOnWindowCapExceeded() public;
```

### test_withdrawFromRouter_revertsOnReplay

router: idempotency enforced — same orderId+idempotencyKey reverts on replay.


```solidity
function test_withdrawFromRouter_revertsOnReplay() public;
```

### test_withdrawFromRouter_revertsWhenWithdrawalDisabled

router: withdrawal disabled when maxWithdrawPerPayment == 0.


```solidity
function test_withdrawFromRouter_revertsWhenWithdrawalDisabled() public;
```

### test_withdrawFromRouter_revertsWhenRouterNotConfigured

router: reverts when router not configured.


```solidity
function test_withdrawFromRouter_revertsWhenRouterNotConfigured() public;
```

### test_withdrawFromRouter_revertsOnLegLengthMismatch

router: reverts when sharesPerLeg length mismatches router leg count.


```solidity
function test_withdrawFromRouter_revertsOnLegLengthMismatch() public;
```

### test_withdrawFromRouter_revertsOnEmptyVaults

router: reverts when the explicit `vaults[]` array is empty. A
router withdrawal must name at least one source vault (issue #967,
F-03). Empty `vaults[]`/`sharesPerLeg`/`minAssetsPerLeg` clears the
parallel-length guard (0 == 0) and trips the empty-vault-set check.


```solidity
function test_withdrawFromRouter_revertsOnEmptyVaults() public;
```

### test_withdrawFromRouter_revertsWhenPaused

router: paused gateway reverts.


```solidity
function test_withdrawFromRouter_revertsWhenPaused() public;
```

### test_withdrawFromRouter_revertsOnZeroTotalShares

router: zero totalShares reverts.


```solidity
function test_withdrawFromRouter_revertsOnZeroTotalShares() public;
```

### test_withdrawFromRouter_emitsAgentWithdrawalRoutedEvent

router: AgentWithdrawalRouted event is emitted with correct indexed topics.


```solidity
function test_withdrawFromRouter_emitsAgentWithdrawalRoutedEvent() public;
```

### test_withdrawFromRouter_revertsOnExpiredDeadline

DeadlineExpired: deadline is in the past → revert.


```solidity
function test_withdrawFromRouter_revertsOnExpiredDeadline() public;
```

### test_withdrawFromRouter_revertsOnDeadlineTooFar

DeadlineTooFar: deadline is beyond MAX_DEADLINE_SKEW → revert.


```solidity
function test_withdrawFromRouter_revertsOnDeadlineTooFar() public;
```

### test_withdrawFromRouter_revertsOnExpiredPolicy

AgentPolicyExpired: policy validUntil is in the past → revert.


```solidity
function test_withdrawFromRouter_revertsOnExpiredPolicy() public;
```

### test_withdrawFromRouter_allowedSourceVaults_skipsZeroShareLegs

allowedSourceVaults zero-shares continue: a zero-shares leg for a
vault not in the allowlist must be silently skipped (not revert).
This exercises the `if (sharesPerLeg[i] == 0) continue;` branch at
the top of the allowedSourceVaults validation loop.


```solidity
function test_withdrawFromRouter_allowedSourceVaults_skipsZeroShareLegs() public;
```

### test_withdrawFromRouter_zeroShareLeg_skippedInPullAndClearLoops

Zero-shares continue in share-pull and approval-clear loops: a
successful withdrawal with one zero leg exercises both
`if (sharesPerLeg[i] == 0) continue;` branches in
_executeRouterWithdraw (lines 1056 and 1068).


```solidity
function test_withdrawFromRouter_zeroShareLeg_skippedInPullAndClearLoops() public;
```

### test_withdrawFromRouter_revertsOnShareCustodyInvariant

ShareCustodyInvariantViolated: router vault leaks one share back to
the gateway during redeemFor → post-call custody check fires.


```solidity
function test_withdrawFromRouter_revertsOnShareCustodyInvariant() public;
```

### _buildLeakyGateway

Build a gateway whose only vault is LeakyRedeemRouterVault.


```solidity
function _buildLeakyGateway()
    internal
    returns (
        RobotMoneyGateway leakyGateway,
        LeakyRedeemRouterVault leakyVault,
        PortfolioRouter leakyRouter
    );
```

### _doLeakyWithdraw

Authorize an agent, deposit via leakyRouter, then attempt the
withdraw that trips ShareCustodyInvariantViolated.


```solidity
function _doLeakyWithdraw(
    RobotMoneyGateway leakyGateway,
    LeakyRedeemRouterVault leakyVault,
    PortfolioRouter leakyRouter
) internal;
```

### test_withdrawFromRouter_emptyAllowedSourceVaults_rejectsNonPinned

AZ-GW-3: router withdrawal with empty allowedSourceVaults and a
non-pinned source vault reverts with InvalidSourceVault.


```solidity
function test_withdrawFromRouter_emptyAllowedSourceVaults_rejectsNonPinned() public;
```

### test_withdrawFromRouter_emptyAllowedSourceVaults_acceptsPinnedVault

AZ-GW-3: router withdrawal with empty allowedSourceVaults and the
pinnedVault as sole source succeeds (pinned-only semantics allow it).
Uses a fresh gateway whose immutable vaultContract equals vaultA so
the pinned vault is also router-eligible, allowing the full call to
complete without reverting.


```solidity
function test_withdrawFromRouter_emptyAllowedSourceVaults_acceptsPinnedVault() public;
```

### test_withdrawFromRouter_emptyAllowedSourceVaults_skipsZeroShareLeg

AZ-GW-3: zero-share leg in the empty-allowedSourceVaults path is
skipped without checking against pinnedVault, allowing a mixed-leg
call where only the pinned-vault leg carries non-zero shares.


```solidity
function test_withdrawFromRouter_emptyAllowedSourceVaults_skipsZeroShareLeg() public;
```

### test_withdrawFromRouter_nonEmptyAllowedSourceVaults_unchangedBehavior

AZ-GW-3 regression: non-empty allowedSourceVaults path is unchanged —
a vault in the allowlist succeeds, one not in the list reverts.


```solidity
function test_withdrawFromRouter_nonEmptyAllowedSourceVaults_unchangedBehavior() public;
```

### _assertWithdrawalRoutedLog

Extract AgentWithdrawalRouted log and assert indexed topics.
Separated to avoid stack-too-deep in the parent test function.


```solidity
function _assertWithdrawalRoutedLog(
    Vm.Log[] memory logs,
    bytes32 orderId,
    address expectedAgent
) internal view;
```

