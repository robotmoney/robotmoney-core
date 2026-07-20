# PositionConformanceBase
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/1a62dd56cbffd67a73d39db63c0ae20c0a7cc71f/contracts/test/AdapterPositionConformance.t.sol)

**Inherits:**
Test


## Constants
### ONE_USDC

```solidity
uint256 internal constant ONE_USDC = 1e6
```


### AMT

```solidity
uint256 internal constant AMT = 100 * ONE_USDC
```


## State Variables
### usdc

```solidity
TestERC20 internal usdc
```


### adapter

```solidity
IPositionAdapter internal adapter
```


### vault

```solidity
address internal vault = makeAddr("vault")
```


### stranger

```solidity
address internal stranger = makeAddr("stranger")
```


## Functions
### _setUpAdapter

Deploy the concrete adapter + its mock venue. Sets `adapter`.


```solidity
function _setUpAdapter() internal virtual;
```

### _shareToken

The adapter's protected venue receipt/share token (for the sweep
protected-token assertion). address(0) if none applies.


```solidity
function _shareToken() internal view virtual returns (address);
```

### setUp


```solidity
function setUp() public;
```

### _fundAndDeploy

Simulate the vault's `safeTransfer` choreography then vault-deploy.


```solidity
function _fundAndDeploy(uint256 amount) internal;
```

### test_identityViews_returnConstructorBound


```solidity
function test_identityViews_returnConstructorBound() public view;
```

### test_isExact_true


```solidity
function test_isExact_true() public view;
```

### test_deploy_returnsUsdcInAndIncreasesTotalAssets


```solidity
function test_deploy_returnsUsdcInAndIncreasesTotalAssets() public;
```

### test_deploy_revertsBelowFloor


```solidity
function test_deploy_revertsBelowFloor() public;
```

### test_deploy_revertsForNonVault


```solidity
function test_deploy_revertsForNonVault() public;
```

### test_withdraw_deliversAtLeastMinOutToVault


```solidity
function test_withdraw_deliversAtLeastMinOutToVault() public;
```

### test_withdraw_clampsOverAskAtBalance


```solidity
function test_withdraw_clampsOverAskAtBalance() public;
```

### test_withdraw_revertsBelowFloor


```solidity
function test_withdraw_revertsBelowFloor() public;
```

### test_withdraw_revertsForNonVault


```solidity
function test_withdraw_revertsForNonVault() public;
```

### test_harvestRewards_permissionlessNoop


```solidity
function test_harvestRewards_permissionlessNoop() public;
```

### test_sweepForeignToken_quarantinesForeignRevertsOnProtected


```solidity
function test_sweepForeignToken_quarantinesForeignRevertsOnProtected() public;
```

