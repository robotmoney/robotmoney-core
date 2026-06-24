# RobotMoneyGatewayTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/f6c8b468bb5448ecb94913113b3bd7ba124894db/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
Test


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


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


### adminRole

```solidity
bytes32 internal adminRole
```


### pauserRole

```solidity
bytes32 internal pauserRole
```


### agentRole

```solidity
bytes32 internal agentRole
```


### depositor
Default owner used by `_authorize` when none is specified.
Now uses `admin` since `authorizeAgent` requires
DEFAULT_ADMIN_ROLE (issue #753).


```solidity
address internal depositor = makeAddr("depositor")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### _defaultPolicy


```solidity
function _defaultPolicy() internal view returns (IGateway.AgentPolicy memory);
```

### _authorize


```solidity
function _authorize(address who, IGateway.AgentPolicy memory p) internal;
```

### _authorizeAs


```solidity
function _authorizeAs(address owner, address who, IGateway.AgentPolicy memory p) internal;
```

### _fundAndApprove


```solidity
function _fundAndApprove(address who, uint256 amt) internal;
```

### test_constructor_wiresImmutablesAndRoles


```solidity
function test_constructor_wiresImmutablesAndRoles() public view;
```

### test_lastAdminFloor_revokeAdminRevertsForSoleHolder

ACL-3 / F-06: revoking the sole ADMIN_ROLE holder reverts
(last-admin floor) — gateway governance can never be bricked.


```solidity
function test_lastAdminFloor_revokeAdminRevertsForSoleHolder() public;
```

### test_lastAdminFloor_revokeDefaultAdminRevertsForSoleHolder

ACL-3 / F-06: the floor also covers DEFAULT_ADMIN_ROLE, which the
gateway uses as a privileged tier (it gates authorizeAgent).


```solidity
function test_lastAdminFloor_revokeDefaultAdminRevertsForSoleHolder() public;
```

### test_lastAdminFloor_renounceDefaultAdminRevertsForSoleHolder

ACL-3 / F-06: renouncing the sole DEFAULT_ADMIN_ROLE holder reverts.


```solidity
function test_lastAdminFloor_renounceDefaultAdminRevertsForSoleHolder() public;
```

### test_lastAdminFloor_revokeDefaultAdminSucceedsWithTwoHolders

ACL-3 / F-06: with a second DEFAULT_ADMIN granted, the original may
be revoked — the floor only blocks dropping the final holder.


```solidity
function test_lastAdminFloor_revokeDefaultAdminSucceedsWithTwoHolders() public;
```

### test_constructor_revertsOnZeroAddresses


```solidity
function test_constructor_revertsOnZeroAddresses() public;
```

### test_constructor_revertsOnAssetMismatch


```solidity
function test_constructor_revertsOnAssetMismatch() public;
```

### test_authorizeAgent_grantsRoleAndStoresPolicy


```solidity
function test_authorizeAgent_grantsRoleAndStoresPolicy() public;
```

### test_authorizeAgent_permissionless

AC: a non-`ADMIN_ROLE` EOA calling `authorizeAgent` must revert
(issue #753 — commit/reveal is the only permissionless first-time
authorization path; #965/F-01 moved the admin gate from
DEFAULT_ADMIN_ROLE to ADMIN_ROLE so the Timelock keeps onboarding
authority after the deploy handover revokes the deployer's
DEFAULT_ADMIN_ROLE).


```solidity
function test_authorizeAgent_permissionless() public;
```

### test_authorizeAgent_no_longer_requires_admin_role

AC: commit/reveal is the permissionless alternative to the
admin-only `authorizeAgent` (issue #753).


```solidity
function test_authorizeAgent_no_longer_requires_admin_role() public;
```

### test_authorizeAgent_frontRunProtection

Front-run regression: an attacker observing a victim's
`revealAuthorization` cannot pre-empt it via the direct
`authorizeAgent` because that function requires `ADMIN_ROLE`
(issue #753; admin gate moved DEFAULT_ADMIN_ROLE → ADMIN_ROLE in
#965/F-01).


```solidity
function test_authorizeAgent_frontRunProtection() public;
```

### test_authorizeAgent_revertsOnRoleSeparation_grantingAgentToAdmin


```solidity
function test_authorizeAgent_revertsOnRoleSeparation_grantingAgentToAdmin() public;
```

### test_authorizeAgent_revertsOnRoleSeparation_grantingAgentToPauser


```solidity
function test_authorizeAgent_revertsOnRoleSeparation_grantingAgentToPauser() public;
```

### test_authorizeAgent_revertsOnZeroShareReceiver


```solidity
function test_authorizeAgent_revertsOnZeroShareReceiver() public;
```

### test_authorizeAgent_revertsOnInactivePolicy


```solidity
function test_authorizeAgent_revertsOnInactivePolicy() public;
```

### test_authorizeAgent_revertsOnZeroCaps


```solidity
function test_authorizeAgent_revertsOnZeroCaps() public;
```

### test_authorizeAgent_revertsWhenPaymentCapExceedsWindowCap


```solidity
function test_authorizeAgent_revertsWhenPaymentCapExceedsWindowCap() public;
```

### test_authorizeAgent_revertsWhenAlreadyOwned

Re-authorizing an already-owned agent is rejected; the owner
must `setPolicy` (or `revokeAgent` first).


```solidity
function test_authorizeAgent_revertsWhenAlreadyOwned() public;
```

### test_setPolicy_updatesPolicyKeepsRoleAndOwner


```solidity
function test_setPolicy_updatesPolicyKeepsRoleAndOwner() public;
```

### test_setPolicy_requires_recorded_owner

AC: only the recorded owner can update policy for an agent
they authorized (issue #269).


```solidity
function test_setPolicy_requires_recorded_owner() public;
```

### test_setPolicy_revertsOnZeroAgent


```solidity
function test_setPolicy_revertsOnZeroAgent() public;
```

### test_setPolicy_revertsBeforeAuthorize


```solidity
function test_setPolicy_revertsBeforeAuthorize() public;
```

### test_setPolicy_validatesPolicyShape


```solidity
function test_setPolicy_validatesPolicyShape() public;
```

### test_revokeAgent_clearsPolicyAndRoleAndOwner


```solidity
function test_revokeAgent_clearsPolicyAndRoleAndOwner() public;
```

### test_revokeAgent_requires_recorded_owner

AC: only the recorded owner can revoke; a third-party caller
reverts with NotAgentOwner (issue #269).


```solidity
function test_revokeAgent_requires_recorded_owner() public;
```

### test_revokeAgent_then_authorizeAgent_by_different_owner

After revoke, the agent address is releasable: a fresh depositor
can claim it via commit/reveal (issue #753).


```solidity
function test_revokeAgent_then_authorizeAgent_by_different_owner() public;
```

### test_pause_byPauser_unpause_byAdmin


```solidity
function test_pause_byPauser_unpause_byAdmin() public;
```

### test_pause_nonPauserReverts


```solidity
function test_pause_nonPauserReverts() public;
```

### test_unpause_nonAdminReverts


```solidity
function test_unpause_nonAdminReverts() public;
```

### test_pause_revertsIfAlreadyPaused


```solidity
function test_pause_revertsIfAlreadyPaused() public;
```

### test_unpause_revertsIfNotPaused


```solidity
function test_unpause_revertsIfNotPaused() public;
```

### test_deposit_happyPath_movesUsdcMintsSharesEmitsEvent


```solidity
function test_deposit_happyPath_movesUsdcMintsSharesEmitsEvent() public;
```

### test_deposit_revertsWhenPaused


```solidity
function test_deposit_revertsWhenPaused() public;
```

### test_deposit_revertsForUnauthorizedCaller


```solidity
function test_deposit_revertsForUnauthorizedCaller() public;
```

### test_deposit_revertsAfterRevokeAgent


```solidity
function test_deposit_revertsAfterRevokeAgent() public;
```

### test_deposit_revertsOnZeroAmount


```solidity
function test_deposit_revertsOnZeroAmount() public;
```

### test_deposit_revertsOnPerPaymentCapExceeded


```solidity
function test_deposit_revertsOnPerPaymentCapExceeded() public;
```

### test_deposit_revertsOnExpiredDeadline


```solidity
function test_deposit_revertsOnExpiredDeadline() public;
```

### test_deposit_revertsOnDeadlineTooFar


```solidity
function test_deposit_revertsOnDeadlineTooFar() public;
```

### test_deposit_revertsOnExpiredPolicy


```solidity
function test_deposit_revertsOnExpiredPolicy() public;
```

### test_deposit_revertsOnWindowCapExceeded_andRollsOver


```solidity
function test_deposit_revertsOnWindowCapExceeded_andRollsOver() public;
```

### test_deposit_revertsOnReplay_sameOrderAndIdempotencyKey


```solidity
function test_deposit_revertsOnReplay_sameOrderAndIdempotencyKey() public;
```

### test_deposit_perAgentWindowsAreIndependent


```solidity
function test_deposit_perAgentWindowsAreIndependent() public;
```

### test_deposit_revertsOnFeeOnTransferToken


```solidity
function test_deposit_revertsOnFeeOnTransferToken() public;
```

### test_deposit_still_gated_on_agent_role

AC: `deposit()` still reverts for non-AGENT_ROLE callers. The
depositor-owned authorize redesign must not weaken the deposit
surface in any way (issue #269).


```solidity
function test_deposit_still_gated_on_agent_role() public;
```

### test_role_separation_invariants_hold

AC: `_grantRole` and `_assertRoleSeparation` continue to reject
overlap on the roles that survive (issue #269).


```solidity
function test_role_separation_invariants_hold() public;
```

### test_authorizeAgent_revertsOnZeroAgent


```solidity
function test_authorizeAgent_revertsOnZeroAgent() public;
```

### test_authorizeAgent_revertsOnExpiredValidUntil


```solidity
function test_authorizeAgent_revertsOnExpiredValidUntil() public;
```

### test_revokeAgent_revertsOnZeroAgent


```solidity
function test_revokeAgent_revertsOnZeroAgent() public;
```

### test_deposit_ignoresPreexistingDonatedShares


```solidity
function test_deposit_ignoresPreexistingDonatedShares() public;
```

### test_deposit_revertsOnPostCallShareCustodyInvariant


```solidity
function test_deposit_revertsOnPostCallShareCustodyInvariant() public;
```

### test_deposit_revertsOnPostCallUsdcCustodyInvariant


```solidity
function test_deposit_revertsOnPostCallUsdcCustodyInvariant() public;
```

### test_deposit_revertsOnReentrancyAttempt


```solidity
function test_deposit_revertsOnReentrancyAttempt() public;
```

### testFuzz_paymentId_opKindDiscriminates

For any (orderId, amount, shares, idempotencyKey) with amount == shares,
the three paymentId namespaces are pairwise distinct:
depositPaymentId != depositToPaymentId
depositPaymentId != withdrawPaymentId
depositToPaymentId != withdrawPaymentId


```solidity
function testFuzz_paymentId_opKindDiscriminates(
    bytes32 orderId,
    uint256 amount,
    bytes32 idempotencyKey
) public view;
```

