# UnifiedVaultConformanceBase
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/98e21fa6ee5c881534f0ec43b14cc042ef89ab9c/contracts/test/UnifiedVaultConformance.t.sol)

**Inherits:**
Test

Shared conformance harness: deploys a `Vault`, funds users, and
registers adapters through the full eligibility gate.


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


## Functions
### _deployVault


```solidity
function _deployVault(uint256 exitFeeBps) internal;
```

### _register


```solidity
function _register(address adapter, uint16 capBps, bool isExact) internal;
```

### _deposit


```solidity
function _deposit(address who, uint256 assets) internal returns (uint256 shares);
```

