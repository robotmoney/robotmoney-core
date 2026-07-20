# EmergencyRevertingAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3dcd5dd028ae8ed6525d5aefde4cddc6dea610c0/contracts/test/EmergencyModel.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Exact `IPositionAdapter` whose `withdraw` ALWAYS reverts (a stuck/frozen
venue). `deploy`/`totalAssets` behave normally so it registers eligible
and receives routing, but any drain attempt reverts — the skip-and-continue
fixture. TEST FIXTURE — unique name.


## Constants
### USDC

```solidity
address public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


### SINK

```solidity
address internal constant SINK = address(0xdEaD)
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_) ;
```

### onlyVault


```solidity
modifier onlyVault() ;
```

### deploy


```solidity
function deploy(uint256 usdcIn, uint256 minValueOut)
    external
    onlyVault
    returns (uint256 valueAdded);
```

### withdraw


```solidity
function withdraw(uint256, uint256) external view onlyVault returns (uint256);
```

### totalAssets


```solidity
function totalAssets() external view returns (uint256);
```

### isExact


```solidity
function isExact() external pure returns (bool);
```

### harvestRewards


```solidity
function harvestRewards() external;
```

### sweepForeignToken


```solidity
function sweepForeignToken(address token) external;
```

## Errors
### DrainFrozen

```solidity
error DrainFrozen();
```

