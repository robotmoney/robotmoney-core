# BasketVaultHardenedTest
[Git Source](https://github.com/lucky-tensor/robotmoney-monorepo/blob/e7a2933e057a3f91470ea3808b683595abe0b3d0/contracts/test/BasketVault.t.sol)

**Inherits:**
Test


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### router

```solidity
MockSwapRouter internal router
```


### hardened

```solidity
HardenedBasketVault internal hardened
```


### prototype_

```solidity
BasketVaultHarness internal prototype_
```


### admin

```solidity
address internal admin = makeAddr("admin")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_hardenedSubclass_isNotPrototype


```solidity
function test_hardenedSubclass_isNotPrototype() public view;
```

