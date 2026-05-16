# GatewayWithdrawTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1421cc6201de54f6b9e3c222f9419f45c65b6f43/contracts/test/RobotMoneyGateway.t.sol)

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


### MAX_WITHDRAW_PER_PAYMENT

```solidity
uint256 internal constant MAX_WITHDRAW_PER_PAYMENT = 500 * ONE_USDC
```


### MAX_WITHDRAW_PER_WINDOW

```solidity
uint256 internal constant MAX_WITHDRAW_PER_WINDOW = 2_500 * ONE_USDC
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


### depositor

```solidity
address internal depositor = makeAddr("depositor")
```


### shareReceiver

```solidity
address internal shareReceiver = makeAddr("shareReceiver")
```


### assetRecipient

```solidity
address internal assetRecipient = makeAddr("assetRecipient")
```


### agentRole

```solidity
bytes32 internal agentRole
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
function _authorize(IGateway.AgentPolicy memory p) internal;
```

### _mintSharesAndApprove

Mint USDC to the depositor, deposit through gateway to give agent
`shares` vault shares, approve gateway to spend them.


```solidity
function _mintSharesAndApprove(uint256 shares) internal;
```

### test_withdraw_happyPath_burnsSharesSendsUsdcToRecipient


```solidity
function test_withdraw_happyPath_burnsSharesSendsUsdcToRecipient() public;
```

### test_withdraw_redirectBlocked_assetsAlwaysGoToAssetRecipient


```solidity
function test_withdraw_redirectBlocked_assetsAlwaysGoToAssetRecipient() public;
```

### test_withdraw_revertsWhenWithdrawalNotEnabled


```solidity
function test_withdraw_revertsWhenWithdrawalNotEnabled() public;
```

### test_withdraw_revertsWhenSharesExceedPerPaymentCap


```solidity
function test_withdraw_revertsWhenSharesExceedPerPaymentCap() public;
```

### test_withdraw_revertsWhenWindowCapExceeded


```solidity
function test_withdraw_revertsWhenWindowCapExceeded() public;
```

### test_withdraw_revertsWhenSourceVaultNotPinnedVault


```solidity
function test_withdraw_revertsWhenSourceVaultNotPinnedVault() public;
```

### test_withdraw_revertsWhenSourceVaultNotInAllowedList


```solidity
function test_withdraw_revertsWhenSourceVaultNotInAllowedList() public;
```

### test_withdraw_revertsWhenPaused


```solidity
function test_withdraw_revertsWhenPaused() public;
```

### test_withdraw_revertsWhenInsufficientShareAllowance


```solidity
function test_withdraw_revertsWhenInsufficientShareAllowance() public;
```

### test_withdraw_revertsOnZeroShares


```solidity
function test_withdraw_revertsOnZeroShares() public;
```

### test_withdraw_revertsOnExpiredDeadline


```solidity
function test_withdraw_revertsOnExpiredDeadline() public;
```

### test_withdraw_revertsOnDeadlineTooFar


```solidity
function test_withdraw_revertsOnDeadlineTooFar() public;
```

### test_authorizeAgent_revertsWhenWithdrawEnabledButNoAssetRecipient


```solidity
function test_authorizeAgent_revertsWhenWithdrawEnabledButNoAssetRecipient() public;
```

### test_withdraw_revertsOnReplay


```solidity
function test_withdraw_revertsOnReplay() public;
```

### test_withdraw_revertsWhenPolicyExpired


```solidity
function test_withdraw_revertsWhenPolicyExpired() public;
```

### test_withdraw_succeedsWhenSourceVaultInAllowedList


```solidity
function test_withdraw_succeedsWhenSourceVaultInAllowedList() public;
```

### test_authorizeAgent_revertsWhenWithdrawWindowCapIsZero


```solidity
function test_authorizeAgent_revertsWhenWithdrawWindowCapIsZero() public;
```

### test_authorizeAgent_revertsWhenPaymentCapExceedsWithdrawWindowCap


```solidity
function test_authorizeAgent_revertsWhenPaymentCapExceedsWithdrawWindowCap() public;
```

### test_withdraw_revertsOnUnexpectedAssetsReceived


```solidity
function test_withdraw_revertsOnUnexpectedAssetsReceived() public;
```

### test_withdraw_revertsOnShareCustodyInvariantViolated


```solidity
function test_withdraw_revertsOnShareCustodyInvariantViolated() public;
```

