# UnifiedVaultBase
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3d0125a0ee72af9f51ed36ec0b328a085a948116/contracts/test/UnifiedVault.t.sol)

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

### _registerExact


```solidity
function _registerExact(uint16 capBps) internal returns (ExactHoldAdapter a);
```

### _registerInexact


```solidity
function _registerInexact(uint16 capBps, uint256 haircutBps)
    internal
    returns (InexactSellAdapter a);
```

### _register


```solidity
function _register(address adapter, uint16 capBps, bool isExact) internal;
```

### _deposit


```solidity
function _deposit(address who, uint256 assets) internal returns (uint256 shares);
```

