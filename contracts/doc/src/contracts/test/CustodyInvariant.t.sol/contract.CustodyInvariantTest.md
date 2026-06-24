# CustodyInvariantTest
[Git Source](https://github.com/robotmoney/robotmoney-monorepo/blob/7d568c59b4026ccbeb96c8683b875a28e63a7d18/contracts/test/CustodyInvariant.t.sol)

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


### adapter2

```solidity
NoYieldTestAdapter internal adapter2
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

### invariant_routerHoldsZeroUsdc

INV-1/INV-2 (router custody): the vault never strands USDC outside
its accounted custody. `totalAssets()` is exactly the vault's idle
USDC plus the USDC held by active adapters; every USDC the vault or
its active adapters hold is therefore part of NAV (none is lost in
a "router" limbo). Inactive adapters must hold no USDC — a graceful
remove only deactivates an already-drained adapter, so a positive
balance on an inactive adapter would be stranded, unredeemable
custody. handler_rebalance additionally asserts the stronger
post-condition that idle "router" USDC is fully routed out after a
rebalance.


```solidity
function invariant_routerHoldsZeroUsdc() public view;
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

