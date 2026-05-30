# GatewayRollingDepositWindowTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/1e53296ac7c3def2e7f1ed72fa72a5873c593969/contracts/test/RobotMoneyGateway.t.sol)

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
uint256 internal constant MAX_PER_WINDOW = 1_000 * ONE_USDC
```


### MAX_WITHDRAW_PER_PAYMENT

```solidity
uint256 internal constant MAX_WITHDRAW_PER_PAYMENT = 500 * ONE_USDC
```


### MAX_WITHDRAW_PER_WINDOW

```solidity
uint256 internal constant MAX_WITHDRAW_PER_WINDOW = 500 * ONE_USDC
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

### _fundAndApprove


```solidity
function _fundAndApprove(uint256 amt) internal;
```

### _deposit


```solidity
function _deposit(bytes32 orderId, uint256 amount, bytes32 idem) internal;
```

### _mintSharesAndApprove


```solidity
function _mintSharesAndApprove(uint256 shares) internal;
```

### test_deposit_rollingWindow_blocksBoundaryBurst


```solidity
function test_deposit_rollingWindow_blocksBoundaryBurst() public;
```

### test_deposit_rollingWindow_fullCapAfterFullWindow


```solidity
function test_deposit_rollingWindow_fullCapAfterFullWindow() public;
```

### test_deposit_and_withdraw_windowsAreIndependent


```solidity
function test_deposit_and_withdraw_windowsAreIndependent() public;
```

### test_effectiveDepositWindowGross_returnsMidWindowGross


```solidity
function test_effectiveDepositWindowGross_returnsMidWindowGross() public;
```

### test_effectiveDepositWindowGross_zeroForUntouchedAgent


```solidity
function test_effectiveDepositWindowGross_zeroForUntouchedAgent() public view;
```

### testFuzz_deposit_rollingWindow_neverExceedsCapInAnyInterval


```solidity
function testFuzz_deposit_rollingWindow_neverExceedsCapInAnyInterval(
    uint8 numDeposits,
    uint64[8] memory timeOffsets,
    uint32[8] memory rawAmounts
) public;
```

