# CustodyInvariantTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/9f4d89b73f3bc3e6fe6c5dd86696328d5a028502/contracts/test/CustodyInvariant.t.sol)

**Inherits:**
StdInvariant, Test


## State Variables
### vault

```solidity
RobotMoneyVault internal vault
```


### usdc

```solidity
InvUSDC internal usdc
```


### foreign

```solidity
InvForeignToken internal foreign
```


### adapter

```solidity
NoYieldTestAdapter internal adapter
```


### handler

```solidity
CustodyHandler internal handler
```


### admin

```solidity
address internal admin = makeAddr("invAdmin")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### invariant_holdersNeverExceedTotalAssets

INV-2: the sum of every holder's redeemable assets never exceeds
totalAssets — accounting never over-promises and every share is
backed by redeemable value.


```solidity
function invariant_holdersNeverExceedTotalAssets() public view;
```

### invariant_quarantineHoldsNoUsdc

INV-1: the protocol asset (USDC) is never moved to quarantine by
the foreign-token sweep.


```solidity
function invariant_quarantineHoldsNoUsdc() public view;
```

### invariant_sharePriceNeverDropsBelowFloor

INV-2: the share price (assets per 1e6 shares) never falls below
the 1:1 floor it starts at — donations and yield only raise it;
rounding favours holders. (No exit fee in this harness.)


```solidity
function invariant_sharePriceNeverDropsBelowFloor() public view;
```

