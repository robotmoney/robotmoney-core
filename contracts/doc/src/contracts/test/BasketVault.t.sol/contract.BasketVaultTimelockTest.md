# BasketVaultTimelockTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/7d568c59b4026ccbeb96c8683b875a28e63a7d18/contracts/test/BasketVault.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### MIN_DELAY

```solidity
uint256 internal constant MIN_DELAY = 2 days
```


### ADMIN_ROLE

```solidity
bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE")
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### swapRouter

```solidity
MockSwapRouter internal swapRouter
```


### vault

```solidity
BasketVaultHarness internal vault
```


### timelock

```solidity
TimelockController internal timelock
```


### admin

```solidity
address internal admin = makeAddr("bvTimelockAdmin")
```


### emergencyResponder

```solidity
address internal emergencyResponder = makeAddr("bvTimelockEmergency")
```


### safe

```solidity
address internal safe
```


### hotKey

```solidity
address internal hotKey = makeAddr("hotKey")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_AC7_basket_setFeeRecipient_directCallReverts

AC7: direct setFeeRecipient from a hot key reverts.


```solidity
function test_AC7_basket_setFeeRecipient_directCallReverts() public;
```

### test_AC7_basket_setExitFeeBps_directCallReverts

AC7: direct setExitFeeBps from a hot key reverts.


```solidity
function test_AC7_basket_setExitFeeBps_directCallReverts() public;
```

### test_AC7_basket_setFeeRecipient_succeedsViaTimelock

AC7: setFeeRecipient succeeds ONLY via TimelockController.


```solidity
function test_AC7_basket_setFeeRecipient_succeedsViaTimelock() public;
```

### test_AC7_basket_setExitFeeBps_succeedsViaTimelock

AC7: setExitFeeBps succeeds ONLY via TimelockController.


```solidity
function test_AC7_basket_setExitFeeBps_succeedsViaTimelock() public;
```

