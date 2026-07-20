# EmergencyExactAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/3dcd5dd028ae8ed6525d5aefde4cddc6dea610c0/contracts/test/EmergencyModel.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Exact `IPositionAdapter`: a 1:1 USDC holder. TEST FIXTURE — unique name
(`EmergencyExactAdapter`) to avoid forge-doc re-link collisions with the
other suites' `ExactHoldAdapter` / `MockPositionAdapter`.


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
function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
    external
    onlyVault
    returns (uint256 usdcOut);
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
### TokenProtected

```solidity
error TokenProtected();
```

