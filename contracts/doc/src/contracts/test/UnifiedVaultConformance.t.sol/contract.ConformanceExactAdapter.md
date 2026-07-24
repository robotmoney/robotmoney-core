# ConformanceExactAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/98e21fa6ee5c881534f0ec43b14cc042ef89ab9c/contracts/test/UnifiedVaultConformance.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Exact `IPositionAdapter` conformance fixture: a 1:1 USDC holder.
`deploy` marks at par, `withdraw` clamps at balance and delivers 1:1,
`totalAssets` is the held USDC, `isExact() == true`. Uniquely named to
avoid forge-doc re-link collisions with the sibling test fixtures.


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

