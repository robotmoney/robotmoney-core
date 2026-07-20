# EmergencyModelBase
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3dcd5dd028ae8ed6525d5aefde4cddc6dea610c0/contracts/test/EmergencyModel.t.sol)

**Inherits:**
Test

Shared harness: deploys a `Vault`, funds users, and registers adapters
through the full eligibility gate (allowlist + codehash + identity).


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1_000_000
```


### MAX_BPS

```solidity
uint256 internal constant MAX_BPS = 10_000
```


### MAX_SLIPPAGE_BPS

```solidity
uint256 internal constant MAX_SLIPPAGE_BPS = 200
```


### MAX_NAV_GROWTH_RATE_BPS

```solidity
uint256 internal constant MAX_NAV_GROWTH_RATE_BPS = 1e30
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### vault

```solidity
Vault internal vault
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


### emergency

```solidity
address internal emergency = makeAddr("emergency")
```


### feeRecipient

```solidity
address internal feeRecipient = makeAddr("feeRecipient")
```


### alice

```solidity
address internal alice = makeAddr("alice")
```


### bob

```solidity
address internal bob = makeAddr("bob")
```


### outsider

```solidity
address internal outsider = makeAddr("outsider")
```


## Functions
### _deployVault


```solidity
function _deployVault() internal;
```

### _registerExact


```solidity
function _registerExact(uint16 capBps) internal returns (EmergencyExactAdapter a);
```

### _registerReverting


```solidity
function _registerReverting(uint16 capBps) internal returns (EmergencyRevertingAdapter a);
```

### _register


```solidity
function _register(address adapter, uint16 capBps, bool isExact) internal;
```

### _deposit


```solidity
function _deposit(address who, uint256 assets) internal returns (uint256 shares);
```

