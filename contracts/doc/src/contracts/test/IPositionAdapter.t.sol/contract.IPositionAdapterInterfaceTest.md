# IPositionAdapterInterfaceTest
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/93e714f46f12a94cb2f63f7a8dab827ff15fac4f/contracts/test/IPositionAdapter.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1_000_000
```


### FROZEN_INTERFACE_ID
The frozen ERC-165 interfaceId of the eight-member IPositionAdapter
surface (#1116). Recompute and update only via a coordinated
surface change; a silent drift fails `test_interfaceId_*`.


```solidity
bytes4 internal constant FROZEN_INTERFACE_ID = 0xa301918b
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### adapter

```solidity
MockPositionAdapter internal adapter
```


### vault

```solidity
address internal vault = makeAddr("vault")
```


### attacker

```solidity
address internal attacker = makeAddr("attacker")
```


## Functions
### setUp


```solidity
function setUp() public;
```

### test_identityViews_returnConstructorBound


```solidity
function test_identityViews_returnConstructorBound() public view;
```

### test_constructor_revertsOnZeroIdentity


```solidity
function test_constructor_revertsOnZeroIdentity() public;
```

### test_deploy_exactReturnsUsdcIn


```solidity
function test_deploy_exactReturnsUsdcIn() public;
```

### test_deploy_revertsBelowFloor


```solidity
function test_deploy_revertsBelowFloor() public;
```

### test_deploy_revertsForNonVault


```solidity
function test_deploy_revertsForNonVault() public;
```

### test_withdraw_clampsAtBalanceAndDelivers


```solidity
function test_withdraw_clampsAtBalanceAndDelivers() public;
```

### test_withdraw_revertsBelowFloor


```solidity
function test_withdraw_revertsBelowFloor() public;
```

### test_withdraw_revertsForNonVault


```solidity
function test_withdraw_revertsForNonVault() public;
```

### test_isExact_true


```solidity
function test_isExact_true() public view;
```

### test_harvestRewards_neverReverts


```solidity
function test_harvestRewards_neverReverts() public;
```

### test_sweepForeignToken_quarantinesForeignRevertsOnUsdc


```solidity
function test_sweepForeignToken_quarantinesForeignRevertsOnUsdc() public;
```

### test_subset_unchangedMembersShareSelectors

Members carried verbatim from v1 keep identical selectors.


```solidity
function test_subset_unchangedMembersShareSelectors() public pure;
```

### test_subset_extendedMembersHaveNewSelectors

`deploy`/`withdraw` are strictly extended (min-out params + a
realized-value return), so their selectors MUST differ from v1.


```solidity
function test_subset_extendedMembersHaveNewSelectors() public pure;
```

### test_superset_addsIsExactUsdcVault

The three members IPositionAdapter adds on top of v1. Referencing
their selectors is a compile-time proof they exist on the surface;
the runtime asserts they are non-empty and mutually distinct.


```solidity
function test_superset_addsIsExactUsdcVault() public pure;
```

### test_interfaceId_isStableAndDistinct

interfaceId is the XOR of all eight member selectors and MUST be
stable. The hardcoded literal freezes the surface: any signature
add/remove/rename changes the XOR and fails this loudly. It also
MUST differ from the v1 interfaceId (the two are distinct types).


```solidity
function test_interfaceId_isStableAndDistinct() public pure;
```

### test_errorSet_selectorsFrozen

The frozen normative error selectors (#1116). Hardcoded so a rename
of a shared error breaks the freeze loudly.


```solidity
function test_errorSet_selectorsFrozen() public pure;
```

