# ConformanceInexactAdapter
[Git Source](https://github.com/robotmoney/robotmoney-core/blob/98e21fa6ee5c881534f0ec43b14cc042ef89ab9c/contracts/test/UnifiedVaultConformance.t.sol)

**Inherits:**
[IPositionAdapter](/contracts/interfaces/IPositionAdapter.sol/interface.IPositionAdapter.md)

Inexact (basket) `IPositionAdapter` conformance fixture: a slippage-
priced position. It custodies USDC as its mark, but a `withdraw`
realizes only `wanted × (1 − haircutBps)` — the haircut burned to a sink
so the mark drops by the full consumed amount. `deploy` marks at par,
`isExact() == false`, never reverts on under-delivery above the floor.


## Constants
### USDC

```solidity
address public immutable USDC
```


### VAULT

```solidity
address public immutable VAULT
```


### haircutBps

```solidity
uint256 public immutable haircutBps
```


### SINK

```solidity
address internal constant SINK = address(0xdEaD)
```


### BPS

```solidity
uint16 internal constant BPS = 10_000
```


## Functions
### constructor


```solidity
constructor(address usdc_, address vault_, uint256 haircutBps_) ;
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

