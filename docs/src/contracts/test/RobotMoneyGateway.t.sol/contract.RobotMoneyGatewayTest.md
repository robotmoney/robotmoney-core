# RobotMoneyGatewayTest
[Git Source](https://github.com/lucky-tensor/robotmoney-skills/blob/b462a72b60a914ceeff6cdf3ad7148bfb0361abb/contracts/test/RobotMoneyGateway.t.sol)

**Inherits:**
Test


## State Variables
### usdc

```solidity
MockUSDC internal usdc
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

### _fundAndApprove


```solidity
function _fundAndApprove(address who, uint256 amt) internal;
```

### test_constructor_wiresImmutablesAndRoles


```solidity
function test_constructor_wiresImmutablesAndRoles() public view;
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

### test_authorizeAgent_nonAdminReverts


```solidity
function test_authorizeAgent_nonAdminReverts() public;
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

### test_authorizeAgent_replaceExistingPolicy_keepsAgentRole


```solidity
function test_authorizeAgent_replaceExistingPolicy_keepsAgentRole() public;
```

### test_revokeAgent_clearsPolicyAndRole


```solidity
function test_revokeAgent_clearsPolicyAndRole() public;
```

### test_revokeAgent_nonAdminReverts


```solidity
function test_revokeAgent_nonAdminReverts() public;
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

### test_deposit_revertsOnPreCallShareCustodyInvariant


```solidity
function test_deposit_revertsOnPreCallShareCustodyInvariant() public;
```

### test_deposit_revertsOnPostCallShareCustodyInvariant


```solidity
function test_deposit_revertsOnPostCallShareCustodyInvariant() public;
```

### test_deposit_revertsOnPostCallUsdcCustodyInvariant


```solidity
function test_deposit_revertsOnPostCallUsdcCustodyInvariant() public;
```

